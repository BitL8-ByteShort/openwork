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

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=', 'base64');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const base = '/v1/workspaces/owned/sessions/chat/attachments';
class FixtureAdapter extends OpenWorkV2 {
  nativeFiles: { id: string; bytes: Buffer }[] = [];
  maxFileBytes = 20 * 1024 * 1024;
  loseReply = false;
  beforeUpload: (() => Promise<void>) | undefined;
  constructor() {
    super(async () => { throw Error('No live runtime in tests'); });
    this.capabilities = { ...this.capabilities, attachments: true };
  }
  override async readSession(wid: string, sid: string): Promise<Session> {
    return { id: sid, workspaceId: wid, title: 'Synthetic chat', updatedAt: new Date(0).toISOString(), status: 'idle', modelLabel: null };
  }
  async readAttachmentLimits() { return { maxFileBytes: this.maxFileBytes, inputMIMEs: ['image/png', 'image/jpeg', 'application/pdf'] }; }
  async uploadAttachment(_wid: string, _sid: string, file: { id: string; path: string; name: string; mime: string; bytes: number }, signal: AbortSignal) {
    await this.beforeUpload?.();
    signal.throwIfAborted();
    this.nativeFiles.push({ id: file.id, bytes: await readFile(file.path) });
    if (this.loseReply) throw Error('Synthetic upload reply lost after write');
    return { uri: 'file:///synthetic-inbox/' + file.id + '.png' };
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
