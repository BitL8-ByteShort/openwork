import { constants } from 'node:fs';
import { lstat, realpath, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join, basename, extname, dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BridgeError } from '../contract/index.js';
import type { FeatureOperations } from '../auth/feature-access.js';
import type { ArtifactCandidate } from './candidates.js';

export interface ArtifactContext {
  // The adapter obtained these through the native session ownership proxy.
  // A workspace-wide outbox listing alone is insufficient authorization.
  workspaceDirectory: string;
  executionDirectory: string;
  candidates: ArtifactCandidate[];
  moreOnComputer: boolean;
}
export interface ArtifactRef {
  id: string; sessionId: string; name: string; mime: string; bytes: number;
  revision: string; sha256: string; previewKind: 'text' | 'image' | 'pdf' | 'shareOnly';
}
type Lease = ReturnType<FeatureOperations['begin']>;
type Fingerprint = { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; mode: number };
type Entry = { device: string; wid: string; sid: string; path: string; root: string; execution: string; ref: ArtifactRef; fingerprint: Fingerprint; expires: number };
const maxBytes = 20 * 1024 * 1024, maxRange = 1024 * 1024, lifetime = 15 * 60 * 1000;
const exec = promisify(execFile);
const within = (root: string, path: string) => { const r = relative(root, path); return r === '' || (!r.startsWith('..' + '/') && r !== '..' && !isAbsolute(r)); };
const changed = () => new BridgeError('ARTIFACT_CHANGED', 409);
const fingerprint = (s: Fingerprint): Fingerprint => ({ dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, mode: s.mode });
const same = (a: Fingerprint, b: Fingerprint) => JSON.stringify(fingerprint(a)) === JSON.stringify(fingerprint(b));

async function directory(path: string) {
  if (!isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw changed();
  const s = await lstat(path);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.()) throw changed();
  return realpath(path);
}
async function roots(context: ArtifactContext) {
  const root = await directory(context.workspaceDirectory), execution = await directory(context.executionDirectory);
  if (!within(root, execution)) {
    // Read-only Git metadata, fixed arguments and no shell/hooks. Native session
    // ownership plus registered shared-repository membership is required.
    const git = async (cwd: string, args: string[]) => (await exec('/usr/bin/git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args],
      { cwd, timeout: 5000, maxBuffer: 128 * 1024, encoding: 'utf8' })).stdout;
    const common = async (cwd: string) => realpath(resolve(cwd, (await git(cwd, ['rev-parse', '--git-common-dir'])).trim()));
    if (await common(root) !== await common(execution)) throw changed();
    const registered = (await git(root, ['worktree', 'list', '--porcelain', '-z'])).split('\0').filter(v => v.startsWith('worktree ')).map(v => v.slice(9));
    let belongs = false;
    for (const path of registered) { if (await realpath(path).catch(() => '') === execution) { belongs = true; break; } }
    if (!belongs) throw changed();
  }
  return { root, execution };
}
function candidatePath(candidate: string, execution: string): string {
  if (!candidate || Buffer.byteLength(candidate) > 500 || /[\\\x00-\x1f\x7f]/.test(candidate) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(candidate)) throw changed();
  const parts = candidate.startsWith('/') ? candidate.slice(1).split('/') : candidate.split('/');
  if (parts.some(p => !p || p === '.' || p === '..')) throw changed();
  const path = isAbsolute(candidate) ? resolve(candidate) : resolve(execution, candidate);
  if (!within(execution, path) || path === execution) throw changed();
  return path;
}
async function safePath(path: string, execution: string) {
  if (!within(execution, path)) throw changed();
  let current = execution;
  // Reject all descendant symlinks, including those whose current target is
  // inside the root. Revalidate the path against the open descriptor as well.
  for (const segment of ['', ...relative(execution, dirname(path)).split('/').filter(Boolean)]) {
    if (segment) current = join(current, segment);
    const s = await lstat(current);
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || await realpath(current) !== current) throw changed();
  }
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.uid !== process.getuid?.() || s.mode & 0o111 || await realpath(path) !== path) throw changed();
  return s;
}
async function verifiedOpen(path: string, execution: string) {
  const before = await safePath(path, execution);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = await file.stat();
    if (!same(before, actual) || !same(actual, await safePath(path, execution))) throw changed();
    if (actual.size < 1 || actual.size > maxBytes) throw new BridgeError('FILE_TOO_LARGE', 413);
    return { file, fingerprint: fingerprint(actual) };
  } catch (error) { await file.close(); throw error; }
}
async function unchanged(file: FileHandle, path: string, execution: string, expected: Fingerprint, lease: Lease) {
  lease.check();
  if (!same(await file.stat(), expected) || !same(await safePath(path, execution), expected)) throw changed();
}
async function measure(file: FileHandle, path: string, execution: string, expected: Fingerprint, lease: Lease) {
  const hash = createHash('sha256'), head: Buffer[] = [], extension = extname(path).toLowerCase();
  const text = ['.txt', '.md', '.csv', '.json', '.log'].includes(extension), decoder = text ? new TextDecoder('utf-8', { fatal: true }) : null;
  let offset = 0;
  while (offset < expected.size) {
    await unchanged(file, path, execution, expected, lease);
    const buffer = Buffer.alloc(Math.min(65536, expected.size - offset)), read = await file.read(buffer, 0, buffer.length, offset);
    if (!read.bytesRead) throw changed();
    const chunk = buffer.subarray(0, read.bytesRead);
    if (offset < 512) head.push(chunk.subarray(0, Math.min(chunk.length, 512 - offset)));
    if (decoder) {
      if (chunk.includes(0)) throw new BridgeError('UNSUPPORTED_ARTIFACT', 422);
      try { decoder.decode(chunk, { stream: true }); } catch { throw new BridgeError('UNSUPPORTED_ARTIFACT', 422); }
    }
    offset += read.bytesRead; hash.update(chunk);
  }
  try { decoder?.decode(); } catch { throw new BridgeError('UNSUPPORTED_ARTIFACT', 422); }
  await unchanged(file, path, execution, expected, lease);
  const first = Buffer.concat(head), prefix = first.toString('utf8').trimStart();
  let mime: string, previewKind: ArtifactRef['previewKind'];
  if (text && !/^\s*(?:<!doctype\s+html|<html\b|<svg\b|<script\b|<\?xml)/i.test(prefix)) { mime = 'text/plain'; previewKind = 'text'; }
  else if (extension === '.png' && first.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) { mime = 'image/png'; previewKind = 'image'; }
  else if (['.jpg', '.jpeg'].includes(extension) && first[0] === 255 && first[1] === 216 && first[2] === 255) { mime = 'image/jpeg'; previewKind = 'image'; }
  else if (extension === '.pdf' && first.subarray(0, 5).toString('ascii') === '%PDF-') { mime = 'application/pdf'; previewKind = 'pdf'; }
  else if (extension === '.rtf' && prefix.startsWith('{\\rtf')) { mime = 'application/rtf'; previewKind = 'shareOnly'; }
  else throw new BridgeError('UNSUPPORTED_ARTIFACT', 422);
  return { sha256: hash.digest('hex'), mime, previewKind };
}

export class ArtifactCatalog {
  private entries = new Map<string, Entry>();
  constructor(private context: (wid: string, sid: string, signal: AbortSignal) => Promise<ArtifactContext>) {}
  private sweep() { for (const [id, entry] of this.entries) if (entry.expires <= Date.now()) this.entries.delete(id); }
  async list(device: string, wid: string, sid: string, lease: Lease) {
    lease.check(); this.sweep();
    const context = await this.context(wid, sid, lease.signal); lease.check();
    let verified: Awaited<ReturnType<typeof roots>>;
    try { verified = await roots(context); } catch { lease.check(); return { items: [], moreOnComputer: true }; }
    const items: ArtifactRef[] = [], paths = new Set<string>(); let moreOnComputer = context.moreOnComputer || context.candidates.length > 100, measured = 0;
    const old = [...this.entries.values()].filter(e => e.device === device && e.wid === wid && e.sid === sid);
    for (const entry of old) this.entries.delete(entry.ref.id);
    for (const candidate of context.candidates.slice(0, 100)) {
      lease.check();
      let file: FileHandle | undefined;
      try {
        const path = candidatePath(candidate.path, verified.execution);
        if (paths.has(path)) continue; paths.add(path);
        const opened = await verifiedOpen(path, verified.execution); file = opened.file;
        measured += opened.fingerprint.size;
        if (measured > 100 * 1024 * 1024 || this.entries.size >= 2000) { moreOnComputer = true; break; }
        const name = basename(path);
        if (Buffer.byteLength(name) > 200 || /[\\\x00-\x1f\x7f]/.test(name)) throw changed();
        const type = await measure(file, path, verified.execution, opened.fingerprint, lease);
        const revision = createHash('sha256').update(JSON.stringify([verified, path, opened.fingerprint, type.sha256])).digest('hex');
        const id = old.find(e => e.path === path && e.ref.revision === revision)?.ref.id ?? 'art_' + randomBytes(16).toString('hex');
        if (items.some(r => r.id === id)) continue;
        const ref = { id, sessionId: sid, name, bytes: opened.fingerprint.size, revision, ...type };
        this.entries.set(id, { device, wid, sid, path, ...verified, ref, fingerprint: opened.fingerprint, expires: Date.now() + lifetime }); items.push(ref);
      } catch { lease.check(); moreOnComputer = true; }
      finally { await file?.close(); }
    }
    lease.check(); return { items, moreOnComputer };
  }
  async open(device: string, wid: string, sid: string, id: string, revision: string, range: string | undefined, lease: Lease) {
    lease.check(); this.sweep();
    const entry = this.entries.get(id);
    if (!entry || entry.device !== device || entry.wid !== wid || entry.sid !== sid) throw new BridgeError('NOT_FOUND', 404);
    if (revision !== entry.ref.revision) throw changed();
    const context = await this.context(wid, sid, lease.signal); lease.check();
    try {
      const verified = await roots(context);
      if (verified.root !== entry.root || verified.execution !== entry.execution || !context.candidates.some(c => {
        try { return candidatePath(c.path, verified.execution) === entry.path; } catch { return false; }
      })) throw changed();
      const check = await verifiedOpen(entry.path, entry.execution);
      try {
        if (!same(check.fingerprint, entry.fingerprint) || (await measure(check.file, entry.path, entry.execution, entry.fingerprint, lease)).sha256 !== entry.ref.sha256) throw changed();
      } finally { await check.file.close(); }
    } catch { lease.check(); throw changed(); }
    let start = 0, end = entry.ref.bytes - 1;
    if (range !== undefined) {
      const match = /^bytes=(0|[1-9][0-9]{0,8})-(0|[1-9][0-9]{0,8})$/.exec(range);
      if (!match) throw new BridgeError('INVALID_RANGE', 416);
      start = Number(match[1]); end = Number(match[2]);
      if (start > end || end >= entry.ref.bytes || end - start + 1 > maxRange) throw new BridgeError('INVALID_RANGE', 416);
    }
    async function* stream() {
      const opened = await verifiedOpen(entry!.path, entry!.execution);
      try {
        if (!same(opened.fingerprint, entry!.fingerprint)) throw changed();
        let offset = start;
        while (offset <= end) {
          await unchanged(opened.file, entry!.path, entry!.execution, entry!.fingerprint, lease);
          const buffer = Buffer.alloc(Math.min(65536, end - offset + 1)), read = await opened.file.read(buffer, 0, buffer.length, offset);
          if (!read.bytesRead) throw changed();
          await unchanged(opened.file, entry!.path, entry!.execution, entry!.fingerprint, lease);
          offset += read.bytesRead; yield buffer.subarray(0, read.bytesRead);
        }
      } finally { await opened.file.close(); }
    }
    return { ref: entry.ref, status: range === undefined ? 200 : 206, start, end, length: end - start + 1, stream: stream() };
  }
}
