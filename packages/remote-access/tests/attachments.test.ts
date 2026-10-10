import { test, expect, vi } from 'vitest';
import { mkdtemp, rm, readFile, readdir, writeFile, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Store } from '../src/storage/store.js';
import { Pairing } from '../src/auth/pairing.js';
import { createServers } from '../src/server.js';
import { OpenWorkV2 } from '../src/adapters/openwork-v2-01857.js';
import type { Session } from '../src/contract/index.js';
import { assertContract, parseSend } from '../src/contract/index.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=', 'base64');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const base = '/v1/workspaces/owned/sessions/chat/attachments';
class FixtureAdapter extends OpenWorkV2 {
  nativeFiles: { id: string; bytes: Buffer }[] = [];
  maxFileBytes = 20 * 1024 * 1024;
  loseReply = false;
  beforeUpload: (() => Promise<void>) | undefined;
  inputMIMEs = ['image/png', 'image/jpeg', 'application/pdf'];
  promptBodies: { text: string; messageId: string; files: { id: string; uri: string; name: string; mime: string; bytes: number; sha256: string }[] }[] = [];
  losePromptReply = false;
  constructor() {
    super(async () => { throw Error('No live runtime in tests'); });
    this.capabilities = { ...this.capabilities, attachments: true, sendText: true };
  }
  override async readSession(wid: string, sid: string): Promise<Session> {
    return { id: sid, workspaceId: wid, title: 'Synthetic chat', updatedAt: new Date(0).toISOString(), status: 'idle', modelLabel: null };
  }
  async readAttachmentLimits() { return { maxFileBytes: this.maxFileBytes, inputMIMEs: this.inputMIMEs }; }
  async uploadAttachment(_wid: string, _sid: string, file: { id: string; path: string; name: string; mime: string; bytes: number }, signal: AbortSignal) {
    await this.beforeUpload?.();
    signal.throwIfAborted();
    this.nativeFiles.push({ id: file.id, bytes: await readFile(file.path) });
    if (this.loseReply) throw Error('Synthetic upload reply lost after write');
    return { uri: 'file:///synthetic-inbox/' + file.id + '.png' };
  }
  async sendAttachments(_wid: string, _sid: string, prompt: { text: string; messageId: string; files: { id: string; uri: string; name: string; mime: string; bytes: number; sha256: string }[] }, signal: AbortSignal) {
    signal.throwIfAborted();
    this.promptBodies.push(prompt);
    if (this.losePromptReply) throw Error('Synthetic admission reply lost');
  }
}
async function fixture(run: (apps: ReturnType<typeof createServers>, adapter: FixtureAdapter, store: Store, headers: { authorization: string }) => Promise<void>) {
  const folder = await mkdtemp(join(tmpdir(), 'attachment-route-'));
  const store = await Store.open(join(folder, 'state'));
  const token = 'synthetic-attachment-device';
  await store.update(s => s.devices.push({ id: 'device', deviceId: 'phone', name: 'Synthetic', tokenHash: sha(Buffer.from(token)), workspaceIds: ['owned'], features: { fileTransfer: true, workspaceAdministration: false, automationManagement: false }, active: true, revoked: false }));
  const adapter = new FixtureAdapter();
  const apps = createServers({ store, pairing: new Pairing(store), adapter, platform: 'linux', architecture: 'x64', origin: 'https://fixture.test' });
  try { await run(apps, adapter, store, { authorization: 'Bearer ' + token }); }
  finally { await apps.remote.close(); await apps.admin.close(); await store.close(); await rm(folder, { recursive: true, force: true }); }
}
const metadata = (bytes = png) => ({ requestId: randomUUID(), name: 'photo.png', mime: 'image/png', bytes: bytes.length, sha256: sha(bytes) });

test('allocation is durable and a duplicate UUID returns the same scoped opaque attachment', () => fixture(async (apps, _adapter, _store, headers) => {
  const payload = metadata();
  const first = await apps.remote.inject({ method: 'POST', url: base, headers, payload });
  expect(first.statusCode).toBe(200);
  const value = first.json().data;
  expect(value.receipt.state).toBe('accepted');
  expect(value.attachment).toMatchObject({ name: 'photo.png', bytes: 68, receivedBytes: 0, state: 'uploading' });
  expect(value.attachment.id).toMatch(/^att_[a-f0-9]{32}$/);
  expect(value.attachment).not.toHaveProperty('path');
  const duplicate = await apps.remote.inject({ method: 'POST', url: base, headers, payload });
  expect(duplicate.json().data.attachment.id).toBe(value.attachment.id);
  const conflict = await apps.remote.inject({ method: 'POST', url: base, headers, payload: { ...payload, name: 'changed.png' } });
  expect(conflict.statusCode).toBe(409);
}));

test('old grants and foreign sessions cannot allocate or read another attachment', () => fixture(async (apps, _adapter, store, headers) => {
  const allocated = await apps.remote.inject({ method: 'POST', url: base, headers, payload: metadata() });
  expect(allocated.statusCode).toBe(200);
  const id = allocated.json().data.attachment.id;
  expect((await apps.remote.inject({ url: '/v1/workspaces/owned/sessions/other/attachments/' + id, headers })).statusCode).toBe(404);
  expect((await apps.remote.inject({ method: 'POST', url: base.replace('/owned/', '/foreign/'), headers, payload: metadata() })).statusCode).toBe(403);
  await store.update(s => { s.devices[0]!.features = undefined; });
  expect((await apps.remote.inject({ method: 'POST', url: base, headers, payload: metadata() })).statusCode).toBe(403);
}));

test('chunks resume idempotently but a conflicting overlap never replaces saved bytes', () => fixture(async (apps, adapter, _store, headers) => {
  const allocate = await apps.remote.inject({ method: 'POST', url: base, headers, payload: metadata() });
  expect(allocate.statusCode).toBe(200);
  const id = allocate.json().data.attachment.id;
  const chunk = { method: 'PUT' as const, url: base + '/' + id + '/chunks?offset=0', headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: png };
  expect((await apps.remote.inject(chunk)).statusCode).toBe(200);
  expect((await apps.remote.inject(chunk)).json().data.receivedBytes).toBe(68);
  const conflicting = await apps.remote.inject({ ...chunk, payload: Buffer.alloc(png.length) });
  expect(conflicting.statusCode).toBe(409);
  const requestId = randomUUID();
  const commit = { method: 'POST' as const, url: base + '/' + id + '/commit', headers, payload: { requestId, sha256: sha(png) } };
  expect((await apps.remote.inject(commit)).json().data.attachment.state).toBe('ready');
  expect((await apps.remote.inject(commit)).json().data.receipt.state).toBe('accepted');
  expect(adapter.nativeFiles).toHaveLength(1);
  expect(adapter.nativeFiles[0]?.bytes.equals(png)).toBe(true);
}));

test('wrong checksum and mismatched content MIME never reach the native inbox', () => fixture(async (apps, adapter, _store, headers) => {
  for (const payload of [{ ...metadata(), sha256: '0'.repeat(64) }, { ...metadata(), name: 'document.pdf', mime: 'application/pdf' }]) {
    const allocate = await apps.remote.inject({ method: 'POST', url: base, headers, payload });
    expect(allocate.statusCode).toBe(200);
    const id = allocate.json().data.attachment.id;
    expect((await apps.remote.inject({ method: 'PUT', url: base + '/' + id + '/chunks?offset=0', headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: png })).statusCode).toBe(200);
    const commit = await apps.remote.inject({ method: 'POST', url: base + '/' + id + '/commit', headers, payload: { requestId: randomUUID(), sha256: payload.sha256 } });
    expect(commit.statusCode).toBe(422);
  }
  expect(adapter.nativeFiles).toHaveLength(0);
}));

test('filenames cannot select a host path and lengths are bounded before staging', () => fixture(async (apps, _adapter, _store, headers) => {
  for (const name of ['../photo.png', '/photo.png', 'folder\\photo.png', 'photo\u0000.png']) {
    expect((await apps.remote.inject({ method: 'POST', url: base, headers, payload: { ...metadata(), name } })).statusCode).toBe(400);
  }
  expect((await apps.remote.inject({ method: 'POST', url: base, headers, payload: { ...metadata(), bytes: 20 * 1024 * 1024 + 1 } })).statusCode).toBe(413);
}));

test('a native limit smaller than 20 MiB prevents allocation', () => fixture(async (apps, adapter, _store, headers) => {
  adapter.maxFileBytes = 67;
  expect((await apps.remote.inject({ method: 'POST', url: base, headers, payload: metadata() })).statusCode).toBe(413);
}));

test('four files and exactly 40 MiB fit one draft; its fifth file is refused', () => fixture(async (apps, _adapter, _store, headers) => {
  for (let i = 0; i < 4; i++) {
    expect((await apps.remote.inject({ method: 'POST', url: base, headers, payload: { ...metadata(), bytes: 10 * 1024 * 1024 } })).statusCode).toBe(200);
  }
  expect((await apps.remote.inject({ method: 'POST', url: base, headers, payload: metadata() })).statusCode).toBe(413);
}));

test('exactly 100 MiB of device reservations fits and another draft cannot exceed it', () => fixture(async (apps, _adapter, _store, headers) => {
  for (let i = 0; i < 5; i++) {
    expect((await apps.remote.inject({ method: 'POST', url: base.replace('/chat/', '/chat' + i + '/'), headers, payload: { ...metadata(), bytes: 20 * 1024 * 1024 } })).statusCode).toBe(200);
  }
  expect((await apps.remote.inject({ method: 'POST', url: base, headers, payload: metadata() })).statusCode).toBe(413);
}));

test('one MiB chunks use their own limit and cannot exceed the declared file length', () => fixture(async (apps, adapter, _store, headers) => {
  const allocated = await apps.remote.inject({ method: 'POST', url: base, headers, payload: { ...metadata(), bytes: 1024 * 1024 + 68 } });
  expect(allocated.statusCode).toBe(200);
  const id = allocated.json().data.attachment.id;
  const options = { method: 'PUT' as const, url: base + '/' + id + '/chunks?offset=0', headers: { ...headers, 'content-type': 'application/octet-stream' } };
  expect((await apps.remote.inject({ ...options, payload: Buffer.alloc(1024 * 1024 + 1) })).statusCode).toBe(413);
  expect((await apps.remote.inject({ ...options, payload: Buffer.alloc(1024 * 1024) })).statusCode).toBe(200);
  expect((await apps.remote.inject({ ...options, url: base + '/' + id + '/chunks?offset=1048576', payload: Buffer.alloc(69) })).statusCode).toBe(413);
  const incomplete = await apps.remote.inject({ method: 'POST', url: base + '/' + id + '/commit', headers, payload: { requestId: randomUUID(), sha256: sha(png) } });
  expect(incomplete.statusCode).toBe(422);
  expect(adapter.nativeFiles).toHaveLength(0);
}));

test('another permitted phone cannot read or commit the first phone attachment', () => fixture(async (apps, adapter, store, headers) => {
  const id = await staged(apps, headers);
  await store.update(s => s.devices.push({ id: 'second', deviceId: 'other-phone', name: 'Synthetic second', tokenHash: sha(Buffer.from('second-token')), workspaceIds: ['owned'], features: { fileTransfer: true, workspaceAdministration: false, automationManagement: false }, active: true, revoked: false }));
  const otherHeaders = { authorization: 'Bearer second-token' };
  expect((await apps.remote.inject({ url: base + '/' + id, headers: otherHeaders })).statusCode).toBe(404);
  expect((await apps.remote.inject({ method: 'POST', url: base + '/' + id + '/commit', headers: otherHeaders, payload: { requestId: randomUUID(), sha256: sha(png) } })).statusCode).toBe(404);
  expect(adapter.nativeFiles).toHaveLength(0);
}));

async function staged(apps: ReturnType<typeof createServers>, headers: { authorization: string }, payload = metadata()) {
  const allocated = await apps.remote.inject({ method: 'POST', url: base, headers, payload });
  expect(allocated.statusCode).toBe(200);
  const id: string = allocated.json().data.attachment.id;
  expect((await apps.remote.inject({ method: 'PUT', url: base + '/' + id + '/chunks?offset=0', headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: png })).statusCode).toBe(200);
  return id;
}
async function ready(apps: ReturnType<typeof createServers>, headers: { authorization: string }) {
  const id = await staged(apps, headers);
  expect((await apps.remote.inject({ method: 'POST', url: base + '/' + id + '/commit', headers, payload: { requestId: randomUUID(), sha256: sha(png) } })).json().data.attachment.state).toBe('ready');
  return id;
}
const messages = base.replace('/attachments', '/messages');

test('closed attachment DTOs reject private paths and sends accept IDs with optional empty text', () => {
  const value = { id: 'att_' + 'a'.repeat(32), name: 'photo.png', mime: 'image/png', bytes: 68, sha256: sha(png), receivedBytes: 68, state: 'ready' };
  expect(() => assertContract('Attachment', value)).not.toThrow();
  expect(() => assertContract('Attachment', { ...value, path: '/private/hidden' })).toThrow();
  expect(() => assertContract('Attachment', { ...value, bytes: -1 })).toThrow();
  expect(parseSend({ requestId: randomUUID(), text: '', attachmentIds: [value.id] })).toMatchObject({ text: '', attachmentIds: [value.id] });
  expect(() => parseSend({ requestId: randomUUID(), text: '' })).toThrow();
  expect(() => parseSend({ requestId: randomUUID(), text: 'Text', attachmentIds: [value.id], uri: 'file:///hidden' })).toThrow();
});

test('a committed ID binds to one prompt UUID and duplicate sends forward exactly once', () => fixture(async (apps, adapter, _store, headers) => {
  const id = await ready(apps, headers);
  const requestId = randomUUID();
  const options = { method: 'POST' as const, url: messages, headers, payload: { requestId, text: 'Look at this', attachmentIds: [id] } };
  const first = await apps.remote.inject(options);
  expect(first.statusCode).toBe(200);
  expect(first.json().data.state).toBe('accepted');
  expect((await apps.remote.inject(options)).json().data.state).toBe('accepted');
  expect(adapter.promptBodies).toHaveLength(1);
  expect(adapter.promptBodies[0]).toMatchObject({ text: 'Look at this', files: [{ id, uri: 'file:///synthetic-inbox/' + id + '.png', name: 'photo.png', mime: 'image/png', bytes: 68, sha256: sha(png) }] });
  expect(adapter.promptBodies[0]?.messageId).toBe('msg_' + sha(Buffer.from('device\u0000' + requestId)).slice(0,32));
  expect((await apps.remote.inject({ url: base + '/' + id, headers })).json().data.state).toBe('attached');
  expect((await apps.remote.inject({ ...options, payload: { ...options.payload, text: 'Changed' } })).statusCode).toBe(409);
  expect((await apps.remote.inject({ ...options, payload: { ...options.payload, requestId: randomUUID() } })).statusCode).toBe(409);
}));

test('a lost prompt reply retains the IDs and never forwards them again', () => fixture(async (apps, adapter, _store, headers) => {
  const id = await ready(apps, headers);
  adapter.losePromptReply = true;
  const options = { method: 'POST' as const, url: messages, headers, payload: { requestId: randomUUID(), text: '', attachmentIds: [id] } };
  expect((await apps.remote.inject(options)).json().data?.state).toBe('outcome_unknown');
  expect((await apps.remote.inject(options)).json().data?.state).toBe('outcome_unknown');
  expect((await apps.remote.inject({ ...options, payload: { ...options.payload, requestId: randomUUID() } })).statusCode).toBe(409);
  expect(adapter.promptBodies).toHaveLength(1);
}));

test('the phone can inspect effective MIME limits before selecting a file', () => fixture(async (apps, _adapter, _store, headers) => {
  const response = await apps.remote.inject({ url: base + '/limits', headers });
  expect(response.statusCode).toBe(200);
  expect(response.json().data).toEqual({ maxFileBytes: 20971520, inputMIMEs: ['image/png', 'image/jpeg', 'application/pdf'] });
}));

test('an unsupported changed model and revoked file grant prevent prompt inference', () => fixture(async (apps, adapter, store, headers) => {
  const id = await ready(apps, headers);
  const options = { method: 'POST' as const, url: messages, headers, payload: { requestId: randomUUID(), text: 'Inspect', attachmentIds: [id] } };
  adapter.inputMIMEs = [];
  expect((await apps.remote.inject(options)).statusCode).toBe(422);
  adapter.inputMIMEs = ['image/png'];
  await store.update(s => { s.devices[0]!.features!.fileTransfer = false; });
  expect((await apps.remote.inject({ ...options, payload: { ...options.payload, requestId: randomUUID() } })).statusCode).toBe(403);
  expect(adapter.promptBodies).toHaveLength(0);
}));

test('unknown IDs, duplicate IDs and more than four IDs never reach prompt inference', () => fixture(async (apps, adapter, _store, headers) => {
  const id = 'att_' + 'a'.repeat(32);
  const options = { method: 'POST' as const, url: messages, headers };
  expect((await apps.remote.inject({ ...options, payload: { requestId: randomUUID(), text: 'Inspect', attachmentIds: [id] } })).statusCode).toBe(404);
  expect((await apps.remote.inject({ ...options, payload: { requestId: randomUUID(), text: 'Inspect', attachmentIds: [id,id] } })).statusCode).toBe(400);
  expect((await apps.remote.inject({ ...options, payload: { requestId: randomUUID(), text: 'Inspect', attachmentIds: ['a','b','c','d','e'].map(c => 'att_'+c.repeat(32)) } })).statusCode).toBe(400);
  expect(adapter.promptBodies).toHaveLength(0);
}));

test('cancellation deletes only staging, releases a draft slot and repeats without a second effect', () => fixture(async (apps, _adapter, store, headers) => {
  const id = await staged(apps, headers);
  const file = join(store.directory, 'uploads', id + '.part');
  const cancel = { method: 'POST' as const, url: base + '/' + id + '/cancel', headers, payload: { requestId: randomUUID() } };
  const result = await apps.remote.inject(cancel);
  expect(result.statusCode).toBe(200);
  expect(result.json().data.attachment.state).toBe('cancelled');
  await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await apps.remote.inject(cancel)).json().data.receipt.state).toBe('accepted');
  expect((await apps.remote.inject({ method: 'POST', url: base, headers, payload: metadata() })).statusCode).toBe(200);
}));

test('a lost native upload reply is durable and neither UUID replay nor a new commit retries it', () => fixture(async (apps, adapter, _store, headers) => {
  const id = await staged(apps, headers);
  adapter.loseReply = true;
  const commit = { method: 'POST' as const, url: base + '/' + id + '/commit', headers, payload: { requestId: randomUUID(), sha256: sha(png) } };
  const first = await apps.remote.inject(commit);
  expect(first.json().data.receipt.state).toBe('outcome_unknown');
  expect(first.json().data.attachment.state).toBe('outcome_unknown');
  expect((await apps.remote.inject(commit)).json().data.receipt.state).toBe('outcome_unknown');
  expect((await apps.remote.inject({ ...commit, payload: { ...commit.payload, requestId: randomUUID() } })).statusCode).toBe(409);
  expect(adapter.nativeFiles).toHaveLength(1);
}));

test('expired uncommitted bytes are removed after 24 hours without touching a committed native file', () => fixture(async (apps, adapter, store, headers) => {
  const committed = await staged(apps, headers);
  expect((await apps.remote.inject({ method: 'POST', url: base + '/' + committed + '/commit', headers, payload: { requestId: randomUUID(), sha256: sha(png) } })).json().data.attachment.state).toBe('ready');
  const unfinished = await staged(apps, headers);
  const createdAt = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(createdAt + 86400001);
  try {
    expect((await apps.remote.inject({ url: base + '/' + unfinished, headers })).json().data.state).toBe('expired');
    expect((await readdir(join(store.directory, 'uploads')))).toEqual([]);
    expect((await apps.remote.inject({ url: base + '/' + committed, headers })).json().data.state).toBe('ready');
    expect(adapter.nativeFiles[0]?.bytes.equals(png)).toBe(true);
  } finally { vi.restoreAllMocks(); }
}));

test('a swapped staging symlink cannot overwrite or upload its external target', () => fixture(async (apps, adapter, store, headers) => {
  const id = await staged(apps, headers);
  const target = join(store.directory, 'unrelated.txt'), staging = join(store.directory, 'uploads', id + '.part');
  await writeFile(target, 'Keep this file', { mode: 0o600 });
  await unlink(staging); await symlink(target, staging);
  const result = await apps.remote.inject({ method: 'POST', url: base + '/' + id + '/commit', headers, payload: { requestId: randomUUID(), sha256: sha(png) } });
  expect(result.json().data.receipt.state).not.toBe('accepted');
  expect(adapter.nativeFiles).toHaveLength(0);
  expect(await readFile(target, 'utf8')).toBe('Keep this file');
}));

test('revoking a file grant during commit prevents the native write and hides its late reply', () => fixture(async (apps, adapter, store, headers) => {
  const id = await staged(apps, headers);
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(r => { entered = r; });
  const gate = new Promise<void>(r => { release = r; });
  adapter.beforeUpload = async () => { entered(); await gate; };
  const pending = apps.remote.inject({ method: 'POST', url: base + '/' + id + '/commit', headers, payload: { requestId: randomUUID(), sha256: sha(png) } });
  await waiting;
  await store.update(s => { s.devices[0]!.features!.fileTransfer = false; });
  apps.featureOperations.cancelDevice('device');
  release();
  expect((await pending).statusCode).toBe(403);
  expect(adapter.nativeFiles).toHaveLength(0);
}));

test('restart resumes saved chunks but turns an interrupted native commit into an uncertain result', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'attachment-restart-'));
  let store = await Store.open(join(folder, 'state'));
  const token = 'synthetic-restart-device', headers = { authorization: 'Bearer ' + token };
  await store.update(s => s.devices.push({ id: 'device', deviceId: 'phone', name: 'Synthetic', tokenHash: sha(Buffer.from(token)), workspaceIds: ['owned'], features: { fileTransfer: true, workspaceAdministration: false, automationManagement: false }, active: true, revoked: false }));
  const adapter = new FixtureAdapter();
  const makeApps = () => createServers({ store, pairing: new Pairing(store), adapter, platform: 'linux', architecture: 'x64', origin: 'https://fixture.test' });
  let apps = makeApps();
  try {
    const id = await staged(apps, headers);
    const uncertain = await staged(apps, headers);
    // Simulate crash after the durable forward marker; do not invent a success receipt.
    await store.update(s => { const upload = s.uploads?.[uncertain]; if (upload) upload.state = 'committing'; });
    await apps.remote.close(); await apps.admin.close(); await store.close();
    store = await Store.open(join(folder, 'state')); apps = makeApps();
    expect((await apps.remote.inject({ url: base + '/' + id, headers })).json().data.receivedBytes).toBe(68);
    expect((await apps.remote.inject({ method: 'POST', url: base + '/' + id + '/commit', headers, payload: { requestId: randomUUID(), sha256: sha(png) } })).json().data.attachment.state).toBe('ready');
    expect((await apps.remote.inject({ url: base + '/' + uncertain, headers })).json().data.state).toBe('outcome_unknown');
    expect((await apps.remote.inject({ method: 'POST', url: base + '/' + uncertain + '/commit', headers, payload: { requestId: randomUUID(), sha256: sha(png) } })).statusCode).toBe(409);
    expect(adapter.nativeFiles).toHaveLength(1);
  } finally { await apps.remote.close(); await apps.admin.close(); await store.close(); await rm(folder, { recursive: true, force: true }); }
});

test('a restart keeps a sending prompt uncertain and preserves its durable UUID claim', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'attachment-prompt-restart-'));
  const root = join(folder, 'state'), id = 'att_' + 'a'.repeat(32), requestId = randomUUID();
  const original = await Store.open(root);
  const baseline = original.snapshot;
  await original.close();
  await writeFile(join(root, 'state.json'), JSON.stringify({ ...baseline, uploads: { [id]: {
    id, deviceId: 'device', workspaceId: 'owned', sessionId: 'chat', name: 'photo.png', mime: 'image/png', bytes: 68, sha256: sha(png),
    receivedBytes: 68, createdAt: Date.now(), chunks: [{ offset: 0, bytes: 68, sha256: sha(png) }],
    state: 'sending', nativeURI: 'file:///synthetic-inbox/file.png', promptRequestId: requestId,
  } } }), { mode: 0o600 });
  let restored: Store | undefined;
  try {
    restored = await Store.open(root);
    expect(restored.snapshot.uploads?.[id]).toMatchObject({ state: 'outcome_unknown', promptRequestId: requestId });
  } finally { await restored?.close(); await rm(folder, { recursive: true, force: true }); }
});

test('an unacknowledged partial chunk is discarded and safely retried at the durable offset', () => fixture(async (apps, adapter, store, headers) => {
  const allocated = await apps.remote.inject({ method: 'POST', url: base, headers, payload: metadata() });
  expect(allocated.statusCode).toBe(200);
  const id: string = allocated.json().data.attachment.id;
  // A crash can leave bytes on disk before the chunk receipt was durably saved.
  await writeFile(join(store.directory, 'uploads', id + '.part'), png.subarray(0, 17));
  expect((await apps.remote.inject({ method: 'PUT', url: base + '/' + id + '/chunks?offset=0',
    headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: png })).statusCode).toBe(200);
  expect((await apps.remote.inject({ method: 'POST', url: base + '/' + id + '/commit', headers,
    payload: { requestId: randomUUID(), sha256: sha(png) } })).json().data.attachment.state).toBe('ready');
  expect(adapter.nativeFiles[0]?.bytes.equals(png)).toBe(true);
}));

test('cleanup expires staging without any phone request and stops before the store closes', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  try {
    await fixture(async (apps, _adapter, store, headers) => {
      const id = await staged(apps, headers);
      const now = Date.now();
      const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 86400001);
      try {
        await vi.advanceTimersByTimeAsync(60000);
        await vi.waitFor(() => expect(store.snapshot.uploads?.[id]?.state).toBe('expired'), { timeout: 500, interval: 10 });
        await expect(readFile(join(store.directory, 'uploads', id + '.part'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(store.snapshot.uploads?.[id]?.state).toBe('expired');
      } finally { spy.mockRestore(); }
    });
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

test('cancelling an active native upload aborts it promptly and keeps the typed prompt separate', () => fixture(async (apps, adapter, store, headers) => {
  const id = await staged(apps, headers);
  let entered!: () => void;
  const waiting = new Promise<void>(r => { entered = r; });
  adapter.uploadAttachment = async (_wid, _sid, _file, signal) => {
    entered();
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('Synthetic upload cancelled')), { once: true }));
    return { uri: 'file:///synthetic-inbox/' + id + '.png' };
  };
  const pending = apps.remote.inject({ method: 'POST', url: base + '/' + id + '/commit', headers,
    payload: { requestId: randomUUID(), sha256: sha(png) } });
  await waiting;
  const cancellation = apps.remote.inject({ method: 'POST', url: base + '/' + id + '/cancel', headers, payload: { requestId: randomUUID() } });
  const result = await Promise.race([Promise.all([pending, cancellation]), new Promise<'timeout'>(resolve => {
    const timer = setTimeout(() => resolve('timeout'), 250); timer.unref();
  })]);
  if (result === 'timeout') {
    // Tear down the boundary so a failing test leaves no live mutation behind.
    apps.featureOperations.cancelDevice('device'); await pending; await cancellation;
  }
  expect(result).not.toBe('timeout');
  expect(store.snapshot.uploads?.[id]?.state).toBe('cancelled');
  expect(adapter.promptBodies).toHaveLength(0);
}));

test('accepted prompts release draft slots without deleting committed host files', () => fixture(async (apps, adapter, _store, headers) => {
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push(await ready(apps, headers));
  expect((await apps.remote.inject({ method: 'POST', url: messages, headers,
    payload: { requestId: randomUUID(), text: '', attachmentIds: ids } })).json().data.state).toBe('accepted');
  expect((await apps.remote.inject({ method: 'POST', url: base, headers, payload: metadata() })).statusCode).toBe(200);
  expect(adapter.nativeFiles).toHaveLength(4);
  expect(adapter.nativeFiles.every(f => f.bytes.equals(png))).toBe(true);
}));

test('two simultaneous prompt intents cannot claim the same ready attachment', () => fixture(async (apps, adapter, _store, headers) => {
  const id = await ready(apps, headers);
  const send = (requestId: string) => apps.remote.inject({ method: 'POST', url: messages, headers,
    payload: { requestId, text: '', attachmentIds: [id] } });
  const result = await Promise.all([send(randomUUID()), send(randomUUID())]);
  expect(result.map(r => r.statusCode).sort()).toEqual([200, 409]);
  expect(adapter.promptBodies).toHaveLength(1);
}));

test('expired allocation-orphan bytes are cleaned while unrelated files and symlink targets survive', () => fixture(async (apps, _adapter, store, headers) => {
  await staged(apps, headers);
  const root = join(store.directory, 'uploads');
  const orphan = join(root, 'att_' + 'f'.repeat(32) + '.part');
  const unrelated = join(root, 'unrelated.txt'), target = join(store.directory, 'keep.txt');
  await writeFile(orphan, 'Uncommitted orphan', { mode: 0o600 });
  await writeFile(unrelated, 'Keep unrelated', { mode: 0o600 });
  await writeFile(target, 'Keep target', { mode: 0o600 });
  await symlink(target, join(root, 'att_' + 'e'.repeat(32) + '.part'));
  const now = Date.now();
  const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 86400001);
  try {
    expect((await apps.remote.inject({ url: base + '/limits', headers })).statusCode).toBe(200);
    await expect(readFile(orphan)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(unrelated, 'utf8')).toBe('Keep unrelated');
    expect(await readFile(target, 'utf8')).toBe('Keep target');
  } finally { spy.mockRestore(); }
}));
