import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { BridgeError } from '../contract/index.js';
import { gitRead } from './git-read.js';

export const within = (root: string, path: string) => {
  const r = relative(root, path); return r === '' || (!r.startsWith('../') && r !== '..' && !isAbsolute(r));
};
async function directory(path: string) {
  if (!isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw new BridgeError('INVALID_ROOT', 422);
  const s = await lstat(path);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.()) throw new BridgeError('INVALID_ROOT', 422);
  return realpath(path);
}
export async function verifiedSessionRoots(context: { workspaceDirectory: string; executionDirectory: string }, signal?: AbortSignal) {
  const root = await directory(context.workspaceDirectory), execution = await directory(context.executionDirectory);
  if (!within(root, execution)) {
    const git = async (cwd: string, args: string[]) => {
      const result = await gitRead(cwd, args, signal, 128 * 1024);
      if (result.code !== 0) throw new BridgeError('INVALID_ROOT', 422);
      return result.bytes.toString('utf8');
    };
    const common = async (cwd: string) => realpath(resolve(cwd, (await git(cwd, ['rev-parse', '--git-common-dir'])).trim()));
    if (await common(root) !== await common(execution)) throw new BridgeError('INVALID_ROOT', 422);
    const registered = (await git(root, ['worktree', 'list', '--porcelain', '-z'])).split('\0').filter(v => v.startsWith('worktree ')).map(v => v.slice(9));
    let belongs = false;
    for (const path of registered) if (await realpath(path).catch(() => '') === execution) { belongs = true; break; }
    if (!belongs) throw new BridgeError('INVALID_ROOT', 422);
  }
  signal?.throwIfAborted(); return { root, execution };
}
