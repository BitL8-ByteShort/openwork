import { constants } from 'node:fs';
import { open, lstat, realpath, mkdir, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, dirname, basename, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { BridgeError, PreflightError, record } from '../contract/index.js';
import { attachmentID, digest, fileBytes, promptBytes } from '../transfers/metadata.js';
import type { StagedAttachment, AttachmentPrompt } from './types.js';

type Request = (route: string, method?: string, body?: unknown, signal?: AbortSignal) => Promise<unknown>;
function object(value: unknown) {
  if (!record(value)) throw new PreflightError('INVALID_UPSTREAM', 502);
  return value;
}
function check(signal?: AbortSignal) {
  if (signal?.aborted) throw new PreflightError('FORBIDDEN', 403);
}
function safeID(value: string) {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new PreflightError('INVALID_REQUEST', 400);
  return encodeURIComponent(value);
}
export class InboxMultipart {
  readonly stream: ReadableStream<Uint8Array>;
  readonly contentType: string;
  readonly length: number;
  constructor(file: FileHandle, bytes: number, path: string, filename: string, mime: string, signal: AbortSignal) {
    const boundary = 'remote-' + randomUUID();
    this.contentType = 'multipart/form-data; boundary=' + boundary;
    const head = Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="path"\r\n\r\n' + path +
      '\r\n--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' + filename +
      '"\r\nContent-Type: ' + mime + '\r\n\r\n');
    const tail = Buffer.from('\r\n--' + boundary + '--\r\n');
    this.length = head.length + bytes + tail.length;
    async function* contents() {
      yield head;
      let offset = 0;
      while (offset < bytes) {
        signal.throwIfAborted();
        const buffer = Buffer.alloc(Math.min(65536, bytes - offset));
        const read = await file.read(buffer, 0, buffer.length, offset);
        if (!read.bytesRead) throw new BridgeError('STAGING_CHANGED', 409);
        offset += read.bytesRead;
        yield buffer.subarray(0, read.bytesRead);
      }
      yield tail;
    }
    const iterator = contents();
    this.stream = new ReadableStream({
      async pull(controller) {
        try { const next = await iterator.next(); if (next.done) controller.close(); else controller.enqueue(next.value); }
        catch (error) { controller.error(error); }
      },
      async cancel() { await iterator.return(undefined); },
    });
  }
}
export class NativeAttachments {
  constructor(private request: Request) {}
  private async preflight<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      if (error instanceof BridgeError) throw new PreflightError(error.code, error.status, error.retryable);
      throw new PreflightError('ATTACHMENT_UNAVAILABLE');
    }
  }
  private base(wid: string) { return '/workspace/' + safeID(wid) + '/opencode2/api'; }
  private async files(signal?: AbortSignal) {
    const capabilities = object(await this.request('/capabilities', 'GET', undefined, signal));
    const files = object(object(capabilities.toolProviders).files);
    if (files.injection !== true || files.inboxPath !== '.opencode/openwork/inbox/' ||
        typeof files.maxBytes !== 'number' || !Number.isSafeInteger(files.maxBytes) || files.maxBytes < 1)
      throw new PreflightError('UNSUPPORTED_ATTACHMENT', 422);
    return { maxFileBytes: Math.min(fileBytes, files.maxBytes) };
  }
  async limits(wid: string, sid: string, signal?: AbortSignal) {
    check(signal);
    const session = object(object(await this.request(this.base(wid) + '/session/' + safeID(sid), 'GET', undefined, signal)).data);
    if (session.id !== sid) throw new PreflightError('NOT_FOUND', 404);
    const selection = object(session.model);
    if (typeof selection.id !== 'string' || typeof selection.providerID !== 'string') throw new PreflightError('MODEL_REQUIRED', 422);
    const catalog = object(await this.request(this.base(wid) + '/model', 'GET', undefined, signal));
    if (!Array.isArray(catalog.data)) throw new PreflightError('INVALID_UPSTREAM', 502);
    const model = catalog.data.find((v: unknown) => record(v) && v.id === selection.id && v.providerID === selection.providerID);
    if (!record(model) || model.enabled !== true) throw new PreflightError('MODEL_UNAVAILABLE', 422);
    const input = object(model.capabilities).input;
    if (!Array.isArray(input) || !input.every((v: unknown) => typeof v === 'string')) throw new PreflightError('INVALID_UPSTREAM', 502);
    const result = await this.files(signal);
    check(signal);
    return { ...result, inputMIMEs: [
      ...(input.includes('image') ? ['image/png'] : []),
      ...(input.includes('pdf') ? ['application/pdf'] : []),
    ] };
  }
  private async workspace(wid: string, signal?: AbortSignal) {
    const registry = object(await this.request('/workspaces', 'GET', undefined, signal));
    if (!Array.isArray(registry.items)) throw new PreflightError('INVALID_UPSTREAM', 502);
    const workspace = registry.items.find((w: unknown) => record(w) && w.id === wid);
    if (!record(workspace) || typeof workspace.path !== 'string' || !isAbsolute(workspace.path)) throw new PreflightError('NOT_FOUND', 404);
    const stat = await lstat(workspace.path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw new PreflightError('UNSAFE_INBOX', 409);
    return realpath(workspace.path);
  }
  private async folder(root: string, segments: string[], create = false) {
    let current = root;
    for (const segment of ['', ...segments]) {
      if (segment) current = join(current, segment);
      if (create && segment) {
        try { await mkdir(current, { mode: 0o700 }); }
        catch (e) { if (!e || typeof e !== 'object' || !('code' in e) || e.code !== 'EEXIST') throw e; }
      }
      const s = await lstat(current);
      if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || await realpath(current) !== current)
        throw new PreflightError('UNSAFE_INBOX', 409);
    }
    return current;
  }
  private async hash(file: FileHandle, bytes: number, signal?: AbortSignal) {
    const hash = createHash('sha256');
    let offset = 0;
    while (offset < bytes) {
      check(signal);
      const buffer = Buffer.alloc(Math.min(65536, bytes - offset));
      const result = await file.read(buffer, 0, buffer.length, offset);
      if (!result.bytesRead) throw new PreflightError('CHECKSUM_MISMATCH', 422);
      offset += result.bytesRead; hash.update(buffer.subarray(0, result.bytesRead));
    }
    if ((await file.stat()).size !== bytes) throw new PreflightError('STAGING_CHANGED', 409);
    return hash.digest('hex');
  }
  async upload(wid: string, sid: string, input: StagedAttachment, signal: AbortSignal) {
    if (!attachmentID.test(input.id) || !digest.test(input.sha256) || !Number.isSafeInteger(input.bytes) || input.bytes < 1 || input.bytes > fileBytes ||
        basename(input.path) !== input.id + '.part' || !isAbsolute(input.path)) throw new PreflightError('INVALID_REQUEST', 400);
    const limits = await this.preflight(() => this.limits(wid, sid, signal));
    if (input.bytes > limits.maxFileBytes) throw new PreflightError('FILE_TOO_LARGE', 413);
    if (!limits.inputMIMEs.includes(input.mime)) throw new PreflightError('UNSUPPORTED_ATTACHMENT', 422);
    const parent = await lstat(dirname(input.path));
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o777) !== 0o700 ||
        await realpath(dirname(input.path)) !== resolve(dirname(input.path))) throw new PreflightError('UNSAFE_PERMISSIONS');
    const source = await open(input.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let dispatched = false;
    let reservation: { path: string; ino: number; dev: number } | undefined;
    try {
      const stat = await source.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size !== input.bytes)
        throw new PreflightError('UNSAFE_PERMISSIONS');
      if (await this.hash(source, input.bytes, signal) !== input.sha256) throw new PreflightError('CHECKSUM_MISMATCH', 422);
      const root = await this.workspace(wid, signal);
      const segments = ['.opencode', 'openwork', 'inbox', 'remote-access', safeID(sid)];
      const directory = await this.folder(root, segments, true);
      const filename = input.id + (input.mime === 'image/png' ? '.png' : '.pdf');
      const destination = join(directory, filename);
      // Reserve a generated filename. A second native attempt cannot overwrite it.
      const reserved = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { const stat = await reserved.stat(); reservation = { path: destination, ino: stat.ino, dev: stat.dev }; }
      finally { await reserved.close(); }
      check(signal);
      await this.folder(root, segments);
      const relative = 'remote-access/' + safeID(sid) + '/' + filename;
      dispatched = true;
      const receipt = await this.request('/workspace/' + safeID(wid) + '/inbox', 'POST',
        new InboxMultipart(source, input.bytes, relative, filename, input.mime, signal), signal);
      if (!record(receipt) || receipt.ok !== true || receipt.path !== relative || receipt.bytes !== input.bytes) throw new BridgeError('INVALID_UPSTREAM', 502);
      check(signal);
      if (await this.workspace(wid, signal) !== root) throw new BridgeError('INBOX_CHANGED', 409);
      await this.folder(root, segments);
      const file = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const actual = await file.stat();
        if (!actual.isFile() || actual.uid !== process.getuid?.() || actual.nlink !== 1 || actual.size !== input.bytes ||
            await this.hash(file, input.bytes, signal) !== input.sha256) throw new BridgeError('INVALID_UPSTREAM', 502);
        await file.chmod(0o600);
      } finally { await file.close(); }
      return { uri: pathToFileURL(destination).href };
    } catch (error) {
      if (dispatched && error instanceof PreflightError) throw new BridgeError(error.code, error.status, error.retryable);
      if (!dispatched) {
        if (reservation) {
          const stat = await lstat(reservation.path).catch(() => undefined);
          if (stat?.isFile() && stat.ino === reservation.ino && stat.dev === reservation.dev && stat.size === 0)
            await unlink(reservation.path).catch(() => {});
        }
        if (error instanceof BridgeError) throw new PreflightError(error.code, error.status, error.retryable);
        throw new PreflightError('ATTACHMENT_UNAVAILABLE');
      }
      throw error;
    } finally { await source.close(); }
  }
  async send(wid: string, sid: string, prompt: AttachmentPrompt, signal: AbortSignal, skills?:Array<{id:string}>) {
    const files = await this.preflight(async () => {
      if (!/^msg_[a-f0-9]{32}$/.test(prompt.messageId) || !prompt.files.length || prompt.files.length > 4 ||
          new Set(prompt.files.map(f => f.id)).size !== prompt.files.length || Buffer.byteLength(prompt.text) > 32768 ||
          prompt.files.reduce((n, f) => n + f.bytes, 0) > promptBytes) throw new PreflightError('INVALID_REQUEST', 400);
      const limits = await this.limits(wid, sid, signal);
      const root = await this.workspace(wid, signal);
      const segments = ['.opencode', 'openwork', 'inbox', 'remote-access', safeID(sid)];
      const directory = await this.folder(root, segments);
      for (const input of prompt.files) {
        if (!attachmentID.test(input.id) || !digest.test(input.sha256) || !Number.isSafeInteger(input.bytes) || input.bytes < 1 ||
            input.bytes > limits.maxFileBytes || !limits.inputMIMEs.includes(input.mime))
          throw new PreflightError('UNSUPPORTED_ATTACHMENT', 422);
        const destination = join(directory, input.id + (input.mime === 'image/png' ? '.png' : '.pdf'));
        if (input.uri !== pathToFileURL(destination).href) throw new PreflightError('INVALID_ATTACHMENT', 400);
        const file = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size !== input.bytes)
            throw new PreflightError('UNSAFE_INBOX', 409);
          if (await this.hash(file, input.bytes, signal) !== input.sha256) throw new PreflightError('CHECKSUM_MISMATCH', 422);
        } finally { await file.close(); }
      }
      if (await this.workspace(wid, signal) !== root) throw new PreflightError('INBOX_CHANGED', 409);
      await this.folder(root, segments);
      check(signal);
      return prompt.files.map(f => ({ uri: f.uri, name: f.name }));
    });
    // After this point a malformed/lost receipt is uncertain, never a safe preflight retry.
    const reply = await this.request(this.base(wid) + '/session/' + safeID(sid) + '/prompt', 'POST',
      { text: prompt.text, id: prompt.messageId, files, ...(skills?.length?{skills}:{}) }, signal);
    if (!record(reply) || !record(reply.data) || reply.data.id !== prompt.messageId || reply.data.sessionID !== sid)
      throw new BridgeError('INVALID_UPSTREAM', 502);
  }
}
