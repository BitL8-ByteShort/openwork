import { test, expect } from 'vitest';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Store } from '../src/storage/store.js';
import { Pairing } from '../src/auth/pairing.js';
import { createServers } from '../src/server.js';
import { OpenWorkV2 } from '../src/adapters/openwork-v2-01857.js';
import { assertContract, type Session } from '../src/contract/index.js';
import type { ArtifactContext } from '../src/artifacts/catalog.js';

class FixtureAdapter extends OpenWorkV2 {
  constructor(public context: ArtifactContext) { super(async () => { throw Error('No live upstream in test'); }); this.capabilities.artifacts = true; }
  override async readSession(wid: string, sid: string): Promise<Session> { return { id: sid, workspaceId: wid, title: 'Synthetic', modelLabel: null, status: 'idle', updatedAt: new Date(0).toISOString() }; }
  override async readArtifactContext() { return this.context; }
}
const base = '/v1/workspaces/owned/sessions/chat/artifacts';
async function fixture(run: (f: { apps: ReturnType<typeof createServers>; store: Store; adapter: FixtureAdapter; headers: { authorization: string } }) => Promise<void>) {
  const temp = await mkdtemp(join(tmpdir(), 'artifact-routes-')), root = await realpath(temp), store = await Store.open(join(root, 'state'));
  await writeFile(join(root, 'report.txt'), 'generated result\n');
  await store.update(s => s.devices.push({ id: 'device', deviceId: 'phone', name: 'Synthetic', tokenHash: createHash('sha256').update('synthetic').digest('hex'), workspaceIds: ['owned'],
    active: true, revoked: false, features: { fileTransfer: true, workspaceAdministration: false, automationManagement: false } }));
  const adapter = new FixtureAdapter({ workspaceDirectory: root, executionDirectory: root, candidates: [{ path: 'report.txt', source: 'completed_write_metadata' }], moreOnComputer: false });
  const apps = createServers({ store, pairing: new Pairing(store), adapter, origin: 'https://fixture.test', platform: 'linux', architecture: 'x64' });
  try { await run({ apps, store, adapter, headers: { authorization: 'Bearer synthetic' } }); }
  finally { await apps.remote.close(); await apps.admin.close(); await store.close(); await rm(temp, { recursive: true, force: true }); }
}

test('authenticated file access lists closed result references and downloads only a chosen opaque handle', () => fixture(async f => {
  const list = await f.apps.remote.inject({ url: base, headers: f.headers }); expect(list.statusCode).toBe(200);
  const value = list.json().data; expect(() => assertContract('ArtifactCatalog', value)).not.toThrow();
  const ref = value.items[0];
  const full = await f.apps.remote.inject({ url: base + '/' + ref.id + '/content?revision=' + ref.revision, headers: f.headers });
  expect(full.statusCode).toBe(200); expect(full.payload).toBe('generated result\n');
  expect(full.headers['content-type']).toBe('text/plain'); expect(full.headers['content-length']).toBe('17');
  expect(full.headers['cache-control']).toBe('no-store'); expect(full.headers['x-content-type-options']).toBe('nosniff');
  expect(full.headers['content-disposition']).toContain('attachment');
  const part = await f.apps.remote.inject({ url: base + '/' + ref.id + '/content?revision=' + ref.revision, headers: { ...f.headers, range: 'bytes=2-7' } });
  expect(part.statusCode).toBe(206); expect(part.payload).toBe('nerate'); expect(part.headers['content-range']).toBe('bytes 2-7/17');
}));

test('capability, workspace and file grants fail closed before catalog or content access', () => fixture(async f => {
  expect((await f.apps.remote.inject({ url: base })).statusCode).toBe(401);
  expect((await f.apps.remote.inject({ url: base.replace('/owned/', '/foreign/'), headers: f.headers })).statusCode).toBe(403);
  const ref = (await f.apps.remote.inject({ url: base, headers: f.headers })).json().data.items[0];
  await f.store.update(s => { s.devices[0]!.features = undefined; });
  expect((await f.apps.remote.inject({ url: base, headers: f.headers })).statusCode).toBe(403);
  expect((await f.apps.remote.inject({ url: base + '/' + ref.id + '/content?revision=' + ref.revision, headers: f.headers })).statusCode).toBe(403);
  f.adapter.capabilities.artifacts = false;
  expect((await f.apps.remote.inject({ url: base, headers: f.headers })).statusCode).toBe(422);
}));

test('the content route requires a revision and rejects path/URL query proxies and unqualified ranges', () => fixture(async f => {
  const ref = (await f.apps.remote.inject({ url: base, headers: f.headers })).json().data.items[0];
  const url = base + '/' + ref.id + '/content';
  for (const q of ['', '?path=/secret.txt', '?url=https://example.test/a.pdf', '?revision=' + ref.revision + '&path=report.txt'])
    expect((await f.apps.remote.inject({ url: url + q, headers: f.headers })).statusCode).toBe(400);
  expect((await f.apps.remote.inject({ url: url + '?revision=' + ref.revision, headers: { ...f.headers, range: 'bytes=-5' } })).statusCode).toBe(416);
  expect((await f.apps.remote.inject({ url: base.replace('/chat/', '/other/') + '/' + ref.id + '/content?revision=' + ref.revision, headers: f.headers })).statusCode).toBe(404);
}));
