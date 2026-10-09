import { spawn } from 'node:child_process';
import { BridgeError } from '../contract/index.js';

// No shell, prompts, optional index refresh, inherited Git routing, external
// diff drivers or textconv. Callers supply only fixed operations and verified
// local paths; this helper is never a phone command interface.
export async function gitRead(cwd: string, args: string[], signal?: AbortSignal, maxBytes = 1024 * 1024, allowTruncation = false) {
  signal?.throwIfAborted();
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value;
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' });
  return new Promise<{ bytes: Buffer; truncated: boolean; code: number }>((resolve, reject) => {
    const child = spawn('/usr/bin/git', ['--no-optional-locks', '--no-replace-objects', '--literal-pathspecs', '-c', 'core.fsmonitor=false', ...args],
      { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = []; let size = 0, truncated = false, failed = false, stderr = 0;
    const stop = () => { failed = true; child.kill('SIGKILL'); };
    const timeout = setTimeout(stop, 10000);
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      const available = Math.max(0, maxBytes - size);
      if (available) { const part = chunk.subarray(0, available); chunks.push(part); size += part.length; }
      if (chunk.length > available) { truncated = true; child.kill('SIGKILL'); }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.length; if (stderr > 65536) stop(); });
    child.once('error', () => { failed = true; });
    child.once('close', code => {
      clearTimeout(timeout); signal?.removeEventListener('abort', stop);
      if (failed || signal?.aborted || (truncated && !allowTruncation)) reject(new BridgeError('CHANGES_UNAVAILABLE', 422));
      else resolve({ bytes: Buffer.concat(chunks), truncated, code: code ?? -1 });
    });
  });
}
