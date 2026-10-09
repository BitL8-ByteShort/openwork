import { constants } from 'node:fs';
import { lstat, realpath, open } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { BridgeError } from '../contract/index.js';
import { gitRead } from '../filesystem/git-read.js';
import { verifiedSessionRoots, within } from '../filesystem/session-roots.js';
import type { FeatureOperations } from '../auth/feature-access.js';

export interface ChangeContext { workspaceDirectory: string; executionDirectory: string }
export interface ChangeRef {
  id: string; pathLabel: string; status: 'added' | 'modified' | 'deleted' | 'renamed' | 'typeChanged';
  binary: boolean; added?: number; removed?: number;
}
export interface ChangeSet {
  revision: string; sessionId: string; provenance: 'workspace'; files: ChangeRef[];
  moreOnComputer: boolean; unavailableReason?: 'non_git' | 'no_baseline' | 'unsupported';
}
export interface FileDiff { revision: string; changeId: string; binary: boolean; text: string; omitted: boolean }
type Lease = ReturnType<FeatureOperations['begin']>;
type Row = { path: string; previous?: string; status: ChangeRef['status']; untracked: boolean };
type Snapshot = { identity: string; binary: boolean; lines: number; bytes: number };
type Measured = { row: Row; snapshot: Snapshot; ref: Omit<ChangeRef, 'id'> };
type Collection = { root: string; execution: string; baseline: string; revision: string; rows: Measured[]; moreOnComputer: boolean };
type Entry = { device: string; wid: string; sid: string; collection: Collection; measured: Measured; expires: number };
const maxFileBytes = 20 * 1024 * 1024, maxText = 1024 * 1024, lifetime = 15 * 60 * 1000;
const changed = () => new BridgeError('CHANGES_CHANGED', 409);
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const empty = (sid: string, reason: ChangeSet['unavailableReason']): ChangeSet => ({ revision: digest(reason ?? ''), sessionId: sid,
  provenance: 'workspace', files: [], moreOnComputer: reason === 'unsupported', unavailableReason: reason });
const fingerprint = (s: Awaited<ReturnType<typeof lstat>>) => JSON.stringify([s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, s.mode, s.nlink]);
function validPath(path: string) {
  return path.length > 0 && Buffer.byteLength(path) <= 500 && !/[\\\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(path) &&
    path.split('/').every(p => p !== '' && p !== '.' && p !== '..' && p !== '.git') && !path.startsWith('/');
}
function statusRows(bytes: Buffer) {
  const fields = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\0');
  const rows: Row[] = []; let omitted = false;
  for (let i = 0; i < fields.length - 1; i++) {
    const field = fields[i]!;
    if (field.length < 4 || field[2] !== ' ') throw changed();
    const code = field.slice(0, 2), path = field.slice(3);
    const renamed = code.includes('R'), copied = code.includes('C');
    const previous = renamed || copied ? fields[++i] : undefined;
    if (!validPath(path) || ((renamed || copied) && (!previous || !validPath(previous))) || /U/.test(code) || ['AA', 'DD'].includes(code) || copied) {
      omitted = true; continue;
    }
    const status: Row['status'] = renamed ? 'renamed' : code.includes('D') ? 'deleted' : code.includes('T') ? 'typeChanged' : code === '??' || code.includes('A') ? 'added' : 'modified';
    rows.push({ path, ...(previous ? { previous } : {}), status, untracked: code === '??' });
  }
  rows.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { rows, omitted };
}
async function snapshot(root: string, path: string, lease: Lease): Promise<Snapshot> {
  lease.check();
  if (!validPath(path)) throw changed();
  const absolute = resolve(root, path);
  if (!within(root, absolute)) throw changed();
  let current = root;
  const directories: { path: string; identity: string }[] = [];
  const segments = relative(root, absolute).split('/');
  for (const segment of ['', ...segments.slice(0, -1)]) {
    if (segment) current = join(current, segment);
    const s = await lstat(current).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!s) return { identity: 'missing:' + JSON.stringify(directories), binary: false, lines: 0, bytes: 0 };
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || await realpath(current) !== current) throw changed();
    directories.push({ path: current, identity: fingerprint(s) });
  }
  const before = await lstat(absolute).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (!before) return { identity: 'missing:' + JSON.stringify(directories), binary: false, lines: 0, bytes: 0 };
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid?.() || before.size > maxFileBytes || await realpath(absolute) !== absolute) throw changed();
  const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (fingerprint(await file.stat()) !== fingerprint(before)) throw changed();
    const hash = createHash('sha256'), decoder = new TextDecoder('utf-8', { fatal: true });
    let offset = 0, binary = false, lines = 0, last = -1;
    while (offset < before.size) {
      lease.check();
      const bytes = Buffer.alloc(Math.min(65536, before.size - offset)), read = await file.read(bytes, 0, bytes.length, offset);
      if (!read.bytesRead) throw changed();
      const chunk = bytes.subarray(0, read.bytesRead); hash.update(chunk);
      if (chunk.includes(0)) binary = true;
      if (!binary) { try { decoder.decode(chunk, { stream: true }); } catch { binary = true; } }
      for (const byte of chunk) if (byte === 10) lines++;
      last = chunk[chunk.length - 1]!; offset += read.bytesRead;
    }
    if (!binary) { try { decoder.decode(); } catch { binary = true; } }
    const after = await lstat(absolute);
    if (fingerprint(await file.stat()) !== fingerprint(before) || fingerprint(after) !== fingerprint(before) || await realpath(absolute) !== absolute) throw changed();
    for (const directory of directories) if (fingerprint(await lstat(directory.path)) !== directory.identity || await realpath(directory.path) !== directory.path) throw changed();
    lease.check();
    return { identity: JSON.stringify(directories) + ':' + fingerprint(before) + ':' + hash.digest('hex'), binary, lines: lines + (last !== -1 && last !== 10 ? 1 : 0), bytes: before.size };
  } finally { await file.close(); }
}
async function checkedGit(root: string, args: string[], lease: Lease, limit = 1024 * 1024) {
  lease.check(); const result = await gitRead(root, args, lease.signal, limit); lease.check();
  if (result.code !== 0) throw changed(); return result.bytes;
}
function boundedText(bytes: Buffer, alreadyOmitted: boolean) {
  // A killed bounded process may end midway through a UTF-8 code point or line.
  // Drop the incomplete trailing line and never present it as a complete diff.
  let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes), omitted = alreadyOmitted;
  if (omitted) text = text.slice(0, Math.max(0, text.lastIndexOf('\n') + 1));
  const lines = text.split('\n');
  if (lines.length > 10000) { text = lines.slice(0, 9999).join('\n') + '\n'; omitted = true; }
  return { text, omitted };
}
export class ChangeCatalog {
  private entries = new Map<string, Entry>();
  constructor(private context: (wid: string, sid: string, signal: AbortSignal) => Promise<ChangeContext>) {}
  private sweep() { for (const [id, entry] of this.entries) if (entry.expires <= Date.now()) this.entries.delete(id); }
  private async collect(wid: string, sid: string, lease: Lease): Promise<Collection | ChangeSet> {
    lease.check(); const context = await this.context(wid, sid, lease.signal); lease.check();
    let verified: Awaited<ReturnType<typeof verifiedSessionRoots>>;
    try { verified = await verifiedSessionRoots(context, lease.signal); }
    catch { lease.check(); return empty(sid, 'unsupported'); }
    const top = await gitRead(verified.execution, ['rev-parse', '--show-toplevel'], lease.signal, 4096); lease.check();
    if (top.code !== 0) return empty(sid, 'non_git');
    if (await realpath(top.bytes.toString('utf8').trim()).catch(() => '') !== verified.execution) return empty(sid, 'unsupported');
    const head = await gitRead(verified.execution, ['rev-parse', '--verify', 'HEAD^{commit}'], lease.signal, 256); lease.check();
    if (head.code !== 0) return empty(sid, 'no_baseline');
    const baseline = head.bytes.toString('ascii').trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseline)) throw changed();
    const raw = await checkedGit(verified.execution, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none', '--renames'], lease);
    const parsed = statusRows(raw), rows: Measured[] = []; let measuredBytes = 0, moreOnComputer = parsed.omitted || parsed.rows.length > 100;
    for (const row of parsed.rows.slice(0, 100)) {
      try {
        const measured = await snapshot(verified.execution, row.path, lease); measuredBytes += measured.bytes;
        if (measuredBytes > 100 * 1024 * 1024) { moreOnComputer = true; break; }
        if (row.previous) await snapshot(verified.execution, row.previous, lease);
        let binary = measured.binary, added = row.untracked ? measured.lines : 0, removed = 0;
        if (!row.untracked) {
          const paths = row.previous ? [row.previous, row.path] : [row.path];
          const size = await gitRead(verified.execution, ['cat-file', '-s', baseline + ':' + (row.previous ?? row.path)], lease.signal, 256);
          if (size.code === 0) {
            const baselineBytes = Number(size.bytes.toString('ascii').trim());
            if (!Number.isSafeInteger(baselineBytes) || baselineBytes < 0 || baselineBytes > maxFileBytes) { moreOnComputer = true; continue; }
            measuredBytes += baselineBytes;
            if (measuredBytes > 100 * 1024 * 1024) { moreOnComputer = true; break; }
            const original = await checkedGit(verified.execution, ['cat-file', 'blob', baseline + ':' + (row.previous ?? row.path)], lease, maxFileBytes);
            if (original.includes(0)) binary = true;
            try { new TextDecoder('utf-8', { fatal: true }).decode(original); } catch { binary = true; }
          }
          const stats = await checkedGit(verified.execution, ['diff', '--no-ext-diff', '--no-textconv', '--numstat', '-z', baseline, '--', ...paths], lease, 16384);
          const stat = stats.toString('utf8').split('\0')[0]?.split('\t');
          if (!stat || stat.length < 3) throw changed();
          if (stat[0] === '-' || stat[1] === '-') binary = true;
          else { added = Number(stat[0]); removed = Number(stat[1]); if (!Number.isSafeInteger(added) || !Number.isSafeInteger(removed) || added < 0 || removed < 0) throw changed(); }
        }
        const ref = { pathLabel: row.path, status: row.status, binary, ...(!binary ? { added, removed } : {}) };
        rows.push({ row, snapshot: measured, ref });
      } catch { lease.check(); moreOnComputer = true; }
    }
    const checkHead = await checkedGit(verified.execution, ['rev-parse', '--verify', 'HEAD^{commit}'], lease, 256);
    const checkStatus = await checkedGit(verified.execution, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none', '--renames'], lease);
    if (checkHead.toString('ascii').trim() !== baseline || !checkStatus.equals(raw)) throw changed();
    const revision = digest(JSON.stringify([verified, fingerprint(await lstat(verified.root)), fingerprint(await lstat(verified.execution)), baseline, digest(raw), rows.map(r => [r.row, r.snapshot.identity, r.ref]), moreOnComputer]));
    return { ...verified, baseline, revision, rows, moreOnComputer };
  }
  async list(device: string, wid: string, sid: string, lease: Lease): Promise<ChangeSet> {
    lease.check(); this.sweep(); const collection = await this.collect(wid, sid, lease);
    for (const [id, entry] of this.entries) if (entry.device === device && entry.wid === wid && entry.sid === sid) this.entries.delete(id);
    if ('files' in collection) return collection;
    const files: ChangeRef[] = [];
    for (const measured of collection.rows) {
      if (this.entries.size >= 2000) break;
      const id = 'chg_' + randomBytes(16).toString('hex');
      this.entries.set(id, { device, wid, sid, collection, measured, expires: Date.now() + lifetime }); files.push({ id, ...measured.ref });
    }
    lease.check(); return { revision: collection.revision, sessionId: sid, provenance: 'workspace', files,
      moreOnComputer: collection.moreOnComputer || files.length < collection.rows.length };
  }
  async diff(device: string, wid: string, sid: string, id: string, revision: string, lease: Lease): Promise<FileDiff> {
    lease.check(); this.sweep(); const entry = this.entries.get(id);
    if (!entry || entry.device !== device || entry.wid !== wid || entry.sid !== sid) throw new BridgeError('NOT_FOUND', 404);
    if (entry.collection.revision !== revision) throw changed();
    const current = await this.collect(wid, sid, lease);
    if ('files' in current || current.revision !== revision) throw changed();
    if (entry.measured.ref.binary) return { changeId: id, revision, binary: true, text: '', omitted: false };
    const row = entry.measured.row;
    const args = row.untracked
      ? ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-index', '--', '/dev/null', resolve(current.execution, row.path)]
      : ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3', current.baseline, '--', ...(row.previous ? [row.previous, row.path] : [row.path])];
    const result = await gitRead(current.execution, args, lease.signal, maxText, true); lease.check();
    if (!result.truncated && result.code !== 0 && !(row.untracked && result.code === 1)) throw changed();
    const after = await this.collect(wid, sid, lease);
    if ('files' in after || after.revision !== revision) throw changed();
    const bounded = boundedText(result.bytes, result.truncated);
    // Git's no-index headers contain a local absolute path. Headers are
    // presentation metadata only; expose the verified relative label instead.
    if (row.untracked) {
      const lines = bounded.text.split('\n'), hunk = lines.findIndex(line => line.startsWith('@@'));
      bounded.text = hunk < 0 ? '' : ['diff --git a/' + row.path + ' b/' + row.path, 'new file', '--- /dev/null', '+++ b/' + row.path, ...lines.slice(hunk)].join('\n');
    }
    if (Buffer.byteLength(bounded.text) > maxText) { bounded.text = ''; bounded.omitted = true; }
    return { changeId: id, revision, binary: false, ...bounded };
  }
}
