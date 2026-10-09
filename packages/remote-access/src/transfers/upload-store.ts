import { constants } from 'node:fs';
import { open, mkdir, lstat, realpath, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { PreflightError } from '../contract/index.js';
import type { Store } from '../storage/store.js';
import type { OpenWorkAdapter } from '../adapters/types.js';
import type { FeatureOperations } from '../auth/feature-access.js';
import {
  attachmentID, chunkBytes, fileBytes, promptBytes, stagingBytes,
  publicAttachment, uploadLifetime, type UploadMetadata, type UploadRecord,
} from './metadata.js';

type Lease = ReturnType<FeatureOperations['begin']>;
export class UploadStore {
  private queued = new Map<string, Promise<unknown>>();
  private folder: string;
  constructor(private store: Store, private adapter: OpenWorkAdapter) {
    this.folder = join(resolve(store.directory), 'uploads');
  }
  private serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const pending = (this.queued.get(id) ?? Promise.resolve()).then(work);
    const finished = pending.catch(() => {});
    this.queued.set(id, finished);
    void finished.then(() => { if (this.queued.get(id) === finished) this.queued.delete(id); });
    return pending;
  }
  private path(id: string) {
    if (!attachmentID.test(id)) throw new PreflightError('NOT_FOUND', 404);
    return join(this.folder, id + '.part');
  }
  private async directory() {
    const root = resolve(this.store.directory);
    try { await mkdir(this.folder, { mode: 0o700 }); }
    catch (e) { if (!e || typeof e !== 'object' || !('code' in e) || e.code !== 'EEXIST') throw e; }
    // Every operation validates both ancestors, not only the final filename.
    for (const p of [root, this.folder]) {
      const s = await lstat(p);
      if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() ||
          (s.mode & 0o777) !== 0o700 || await realpath(p) !== p)
        throw new PreflightError('UNSAFE_PERMISSIONS');
    }
  }
  private async file(id: string, create = false): Promise<FileHandle> {
    await this.directory();
    const path = this.path(id);
    const f = await open(path, constants.O_RDWR | constants.O_NOFOLLOW |
      (create ? constants.O_CREAT | constants.O_EXCL : 0), 0o600);
    try {
      const s = await f.stat();
      if (!s.isFile() || s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o600 || s.nlink !== 1)
        throw new PreflightError('UNSAFE_PERMISSIONS');
      return f;
    } catch (error) { await f.close(); throw error; }
  }
  private owned(id: string, deviceId: string, wid: string, sid: string): UploadRecord {
    this.path(id);
    const r = this.store.snapshot.uploads?.[id];
    if (!r || r.deviceId !== deviceId || r.workspaceId !== wid || r.sessionId !== sid)
      throw new PreflightError('NOT_FOUND', 404);
    return r;
  }
  read(id: string, deviceId: string, wid: string, sid: string) {
    return publicAttachment(this.owned(id, deviceId, wid, sid));
  }
  private async removeStaging(id: string) {
    await this.directory();
    try { await unlink(this.path(id)); }
    catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error; }
  }
  async sweep() {
    const expired = Object.values(this.store.snapshot.uploads ?? {}).filter(r =>
      (r.state === 'uploading' || r.state === 'outcome_unknown') && Date.now() - r.createdAt >= uploadLifetime);
    for (const r of expired) await this.serial(r.id, async () => {
      const current = this.store.snapshot.uploads?.[r.id];
      if (!current || (current.state !== 'uploading' && current.state !== 'outcome_unknown') ||
          Date.now() - current.createdAt < uploadLifetime) return;
      await this.removeStaging(r.id);
      await this.store.update(s => { const v = s.uploads?.[r.id]; if (v) v.state = 'expired'; });
    });
  }
  async cancel(id: string, deviceId: string, wid: string, sid: string, lease: Lease) {
    return this.serial(id, async () => {
      lease.check();
      this.owned(id, deviceId, wid, sid);
      await this.removeStaging(id);
      lease.check();
      await this.store.update(s => { const r = s.uploads?.[id]; if (r) r.state = 'cancelled'; });
      return id;
    });
  }
  async allocate(deviceId: string, wid: string, sid: string, metadata: UploadMetadata, lease: Lease) {
    const limits = await this.adapter.readAttachmentLimits?.(wid, sid, lease.signal);
    lease.check();
    if (!limits || !Number.isSafeInteger(limits.maxFileBytes) || limits.maxFileBytes < 1)
      throw new PreflightError('UNSUPPORTED_ACTION', 422);
    if (metadata.bytes > Math.min(fileBytes, limits.maxFileBytes)) throw new PreflightError('FILE_TOO_LARGE', 413);
    if (!limits.inputMIMEs.includes(metadata.mime)) throw new PreflightError('UNSUPPORTED_ATTACHMENT', 422);
    const id = 'att_' + randomUUID().replaceAll('-', '');
    const f = await this.file(id, true);
    try { await f.sync(); } finally { await f.close(); }
    try {
      lease.check();
      await this.store.update(s => {
        const records = Object.values(s.uploads ?? {}).filter(r => r.deviceId === deviceId &&
          r.state !== 'cancelled' && r.state !== 'expired');
        const draft = records.filter(r => r.workspaceId === wid && r.sessionId === sid);
        if (draft.length >= 4 || draft.reduce((n, r) => n + r.bytes, 0) + metadata.bytes > promptBytes)
          throw new PreflightError('DRAFT_TOO_LARGE', 413);
        if (records.reduce((n, r) => n + r.bytes, 0) + metadata.bytes > stagingBytes)
          throw new PreflightError('STAGING_FULL', 413);
        s.uploads ??= {};
        s.uploads[id] = { ...metadata, id, deviceId, workspaceId: wid, sessionId: sid,
          createdAt: Date.now(), receivedBytes: 0, chunks: [], state: 'uploading' };
      });
      return id;
    } catch (error) { await unlink(this.path(id)).catch(() => {}); throw error; }
  }
  async chunk(id: string, deviceId: string, wid: string, sid: string, offset: number, bytes: Buffer, lease: Lease) {
    return this.serial(id, async () => {
      lease.check();
      const r = this.owned(id, deviceId, wid, sid);
      if (r.state !== 'uploading') throw new PreflightError('UPLOAD_NOT_WRITABLE', 409);
      if (!Number.isSafeInteger(offset) || offset < 0 || !bytes.length || bytes.length > chunkBytes)
        throw new PreflightError('INVALID_REQUEST', 400);
      const hash = createHash('sha256').update(bytes).digest('hex');
      const previous = r.chunks.find(c => c.offset === offset);
      if (previous) {
        if (previous.bytes !== bytes.length || previous.sha256 !== hash)
          throw new PreflightError('CHUNK_CONFLICT', 409);
        return publicAttachment(r);
      }
      if (offset !== r.receivedBytes) throw new PreflightError('CHUNK_CONFLICT', 409);
      if (offset + bytes.length > r.bytes) throw new PreflightError('FILE_TOO_LARGE', 413);
      if (bytes.length !== Math.min(chunkBytes, r.bytes - offset)) throw new PreflightError('INVALID_CHUNK_LENGTH', 400);
      const f = await this.file(id);
      try {
        if ((await f.stat()).size !== r.receivedBytes) throw new PreflightError('STAGING_CHANGED', 409);
        let written = 0;
        while (written < bytes.length) {
          lease.check();
          const result = await f.write(bytes, written, bytes.length - written, offset + written);
          if (!result.bytesWritten) throw new PreflightError('STAGING_UNAVAILABLE');
          written += result.bytesWritten;
        }
        await f.sync();
        lease.check();
        await this.store.update(s => {
          const current = s.uploads?.[id];
          if (!current || current.state !== 'uploading' || current.receivedBytes !== offset)
            throw new PreflightError('CHUNK_CONFLICT', 409);
          current.chunks.push({ offset, bytes: bytes.length, sha256: hash });
          current.receivedBytes += bytes.length;
        });
        return this.read(id, deviceId, wid, sid);
      } finally { await f.close(); }
    });
  }
  private async verify(r: UploadRecord, lease: Lease) {
    const f = await this.file(r.id);
    try {
      if ((await f.stat()).size !== r.bytes) throw new PreflightError('UPLOAD_INCOMPLETE', 422);
      const hash = createHash('sha256');
      for await (const bytes of f.createReadStream({ start: 0, autoClose: false, highWaterMark: 65536 })) {
        lease.check();
        hash.update(bytes);
      }
      if (hash.digest('hex') !== r.sha256) throw new PreflightError('CHECKSUM_MISMATCH', 422);
      const head = Buffer.alloc(Math.min(16, r.bytes));
      const tail = Buffer.alloc(Math.min(1024, r.bytes));
      await f.read(head, 0, head.length, 0);
      await f.read(tail, 0, tail.length, r.bytes - tail.length);
      const matches = r.mime === 'image/png' ?
        head.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && head.subarray(12, 16).toString() === 'IHDR' &&
          tail.subarray(-12).equals(Buffer.from([0,0,0,0,73,69,78,68,174,66,96,130])) :
        r.mime === 'image/jpeg' ? head[0] === 255 && head[1] === 216 && head[2] === 255 && tail.subarray(-2).equals(Buffer.from([255,217])) :
          /^%PDF-[12]\.[0-9]/.test(head.toString('ascii')) && /%%EOF\s*$/.test(tail.toString('ascii'));
      if (!matches) throw new PreflightError('MIME_MISMATCH', 422);
    } finally { await f.close(); }
  }
  async commit(id: string, deviceId: string, wid: string, sid: string, sha256: string, lease: Lease) {
    return this.serial(id, async () => {
      lease.check();
      const r = this.owned(id, deviceId, wid, sid);
      if (sha256 !== r.sha256) throw new PreflightError('CHECKSUM_MISMATCH', 422);
      if (r.state === 'ready') return id;
      if (r.state !== 'uploading') throw new PreflightError('UPLOAD_OUTCOME_UNCERTAIN', 409);
      if (r.receivedBytes !== r.bytes) throw new PreflightError('UPLOAD_INCOMPLETE', 422);
      await this.verify(r, lease);
      const limits = await this.adapter.readAttachmentLimits?.(wid, sid, lease.signal);
      lease.check();
      const upload = this.adapter.uploadAttachment?.bind(this.adapter);
      if (!upload || !limits || !Number.isSafeInteger(limits.maxFileBytes) || limits.maxFileBytes < r.bytes || !limits.inputMIMEs.includes(r.mime))
        throw new PreflightError('UNSUPPORTED_ATTACHMENT', 422);
      await this.store.update(s => { const current = s.uploads?.[id]; if (current) current.state = 'committing'; });
      try {
        lease.check();
        const result = await upload(wid, sid, { id, path: this.path(id), name: r.name, mime: r.mime, bytes: r.bytes }, lease.signal);
        if (typeof result.uri !== 'string' || !result.uri.startsWith('file:///') || result.uri.length > 8192)
          throw new Error('Invalid native upload receipt');
        await this.store.update(s => { const current = s.uploads?.[id]; if (current) { current.nativeURI = result.uri; current.state = 'ready'; } });
        // Only our staging bytes are ours to remove; the native inbox belongs to the host.
        await unlink(this.path(id)).catch(() => {});
        return id;
      } catch (error) {
        await this.store.update(s => { const current = s.uploads?.[id]; if (current) current.state = error instanceof PreflightError ? 'uploading' : 'outcome_unknown'; });
        throw error;
      }
    });
  }
}
