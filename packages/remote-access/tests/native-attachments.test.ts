import { test, expect } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, realpath, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { OpenWorkV2 } from '../src/adapters/openwork-v2-01857.js';
import type { OpenWorkAdapter } from '../src/adapters/types.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=', 'base64');
const id = 'att_' + '1'.repeat(32);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
interface Fixture {
  adapter: OpenWorkAdapter;
  root: string;
  staging: string;
  inboxRequests: number;
  promptBodies: unknown[];
  model: { id: string; providerID: string; variant: string };
  enabled: boolean;
  nativeMax: number;
  loseUploadReply: boolean;
}
async function fixture(run: (f: Fixture) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-files-')));
  const workspace = join(root, 'workspace');
  const staging = join(root, 'staging', id + '.part');
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(join(root, 'staging'), { mode: 0o700 });
  await writeFile(staging, png, { mode: 0o600 });
  const state: Omit<Fixture, 'adapter'> = { root, staging, inboxRequests: 0, promptBodies: [],
    model: { providerID: 'opencode', id: 'muse-spark-1.3-contributor-free', variant: 'high' }, enabled: true, nativeMax: 250000000, loseUploadReply: false };
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer synthetic-native') { res.writeHead(401); res.end('{}'); return; }
    if (req.method === 'GET') {
      const value = req.url === '/health' ? { ok: true, version: '0.18.57' } :
        req.url === '/workspaces' ? { items: [{ id: 'owned', name: 'Synthetic', path: workspace }] } :
        req.url === '/capabilities' ? { toolProviders: { files: { injection: true, outbox: true, inboxPath: '.opencode/openwork/inbox/', outboxPath: '.opencode/openwork/outbox/', maxBytes: state.nativeMax } } } :
        req.url === '/workspace/owned/opencode2/api/model' ? { data: [
          { id: 'muse-spark-1.3-contributor-free', providerID: 'opencode', enabled: state.enabled, capabilities: { input: ['text', 'image', 'pdf'], output: ['text'], tools: true } },
          { id: 'text-only', providerID: 'opencode', enabled: true, capabilities: { input: ['text'], output: ['text'], tools: true } },
        ] } : { data: { id: 'chat', time: { created: 0 }, model: state.model } };
      res.end(JSON.stringify(value)); return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    if (req.url === '/workspace/owned/inbox') {
      state.inboxRequests++;
      const parsed = await new Request('http://fixture.test', { method: 'POST', headers: { 'content-type': req.headers['content-type'] ?? '' }, body: bytes }).formData();
      const file = parsed.get('file'), path = parsed.get('path');
      if (!(file instanceof File) || typeof path !== 'string') { res.writeHead(400); res.end('{}'); return; }
      const destination = join(workspace, '.opencode/openwork/inbox', path);
      await writeFile(destination, Buffer.from(await file.arrayBuffer()));
      if (state.loseUploadReply) { req.socket.destroy(); return; }
      res.end(JSON.stringify({ ok: true, path, bytes: file.size })); return;
    }
    if (req.url?.endsWith('/prompt')) state.promptBodies.push(JSON.parse(bytes.toString()));
    res.end(JSON.stringify({ data: { id: 'msg_' + '2'.repeat(32), sessionID: 'chat' } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Missing fixture port');
    const adapter: OpenWorkAdapter = new OpenWorkV2(async () => ({ origin: 'http://127.0.0.1:' + address.port, token: 'synthetic-native' }));
    await adapter.health();
    adapter.capabilities = { ...adapter.capabilities, attachments: true };
    await run(Object.assign(state, { adapter }));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
}
const selectedFile = (f: Fixture) => ({ id, path: f.staging, name: 'selected.png', mime: 'image/png', bytes: 68, sha256: sha(png) });
const upload = async (f: Fixture, file = selectedFile(f)) => f.adapter.uploadAttachment?.('owned', 'chat', file, new AbortController().signal);

test('native limits combine enabled model inputs and the lower inbox cap', () => fixture(async f => {
  expect(await f.adapter.readAttachmentLimits?.('owned', 'chat')).toMatchObject({ maxFileBytes: 20 * 1024 * 1024, inputMIMEs: ['image/png', 'application/pdf'] });
  f.nativeMax = 42;
  expect(await f.adapter.readAttachmentLimits?.('owned', 'chat')).toMatchObject({ maxFileBytes: 42 });
  f.model.id = 'text-only';
  expect(await f.adapter.readAttachmentLimits?.('owned', 'chat')).toMatchObject({ inputMIMEs: [] });
  f.model.id = 'muse-spark-1.3-contributor-free'; f.enabled = false;
  await expect(f.adapter.readAttachmentLimits?.('owned', 'chat')).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
}));

test('native multipart upload chooses its own inbox filename and verifies uploaded bytes', () => fixture(async f => {
  const result = await f.adapter.uploadAttachment?.('owned', 'chat', selectedFile(f), new AbortController().signal);
  const expected = join(f.root, 'workspace/.opencode/openwork/inbox/remote-access/chat', id + '.png');
  expect(result?.uri).toBe(pathToFileURL(expected).href);
  expect(await readFile(expected)).toEqual(png);
  expect(f.inboxRequests).toBe(1);
}));

test('an inbox symlink escape refuses upload before any native write', () => fixture(async f => {
  const outside = join(f.root, 'outside'); await mkdir(outside, { mode: 0o700 });
  await mkdir(join(f.root, 'workspace/.opencode/openwork'), { recursive: true });
  await symlink(outside, join(f.root, 'workspace/.opencode/openwork/inbox'));
  await expect(upload(f)).rejects.toMatchObject({ code: 'UNSAFE_INBOX' });
  expect(f.inboxRequests).toBe(0);
}));

test('a staging checksum mismatch never uploads and a lost native reply never retries', () => fixture(async f => {
  const bad = { ...selectedFile(f), sha256: '0'.repeat(64) };
  await expect(upload(f, bad)).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' });
  expect(f.inboxRequests).toBe(0);
  f.loseUploadReply = true;
  await expect(upload(f)).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  expect(f.inboxRequests).toBe(1);
}));

test('a native prompt materializes scoped URIs with one message ID and rejects a changed text-only model', () => fixture(async f => {
  const result = await upload(f);
  if (!result) throw Error('Upload did not finish');
  const prompt = { text: 'Inspect', messageId: 'msg_' + '2'.repeat(32), files: [{ id, uri: result.uri, name: 'selected.png', mime: 'image/png', bytes: 68, sha256: sha(png) }] };
  await f.adapter.sendAttachments?.('owned', 'chat', prompt, new AbortController().signal);
  expect(f.promptBodies).toEqual([{ text: 'Inspect', id: 'msg_' + '2'.repeat(32), files: [{ uri: result.uri, name: 'selected.png' }] }]);
  f.model.id = 'text-only';
  const send = async () => f.adapter.sendAttachments?.('owned', 'chat', prompt, new AbortController().signal);
  await expect(send()).rejects.toMatchObject({ code: 'UNSUPPORTED_ATTACHMENT' });
  expect(f.promptBodies).toHaveLength(1);
}));

test('native prompt refuses a forged URI and changed committed bytes before inference', () => fixture(async f => {
  const result = await upload(f);
  if (!result) throw Error('Upload did not finish');
  const file = { id, uri: result.uri, name: 'selected.png', mime: 'image/png', bytes: 68, sha256: sha(png) };
  const send = async (uri = file.uri) => f.adapter.sendAttachments?.('owned', 'chat', { text: 'Inspect', messageId: 'msg_' + '2'.repeat(32), files: [{ ...file, uri }] }, new AbortController().signal);
  await expect(send('https://fixture.test/private')).rejects.toMatchObject({ code: 'INVALID_ATTACHMENT' });
  await writeFile(fileURLToPath(file.uri), Buffer.alloc(68));
  await expect(send()).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' });
  expect(f.promptBodies).toHaveLength(0);
}));
