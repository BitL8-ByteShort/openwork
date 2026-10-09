import { test, expect } from 'vitest';
import { mkdtemp, realpath, writeFile, mkdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Store } from '../src/storage/store.js';
import { Pairing } from '../src/auth/pairing.js';
import { createServers } from '../src/server.js';
import { OpenWorkV2 } from '../src/adapters/openwork-v2-01857.js';
import { assertContract, type Session } from '../src/contract/index.js';
import type { ChangeContext } from '../src/changes/catalog.js';

class FixtureAdapter extends OpenWorkV2 {
  wait?: (signal: AbortSignal) => Promise<void>;
  constructor(public context: ChangeContext) { super(async () => { throw Error('No live upstream in test'); }); this.capabilities.changes = true; }
  override async readSession(wid: string, sid: string): Promise<Session> { return { id: sid, workspaceId: wid, title: 'Synthetic', modelLabel: null, status: 'idle', updatedAt: new Date(0).toISOString() }; }
  override async readChangeContext(_wid: string, _sid: string, signal: AbortSignal) { await this.wait?.(signal); return this.context; }
}
const execute = promisify(execFile), base = '/v1/workspaces/owned/sessions/chat/changes';
async function fixture(run: (f: { apps: ReturnType<typeof createServers>; store: Store; adapter: FixtureAdapter; root: string; headers: { authorization: string } }) => Promise<void>) {
  const temp = await mkdtemp(join(tmpdir(), 'change-routes-')); await mkdir(join(temp, 'project'));
  const root = await realpath(join(temp, 'project')), store = await Store.open(join(temp, 'state'));
  const git = async (...args: string[]) => execute('/usr/bin/git', args, { cwd: root });
  await git('init', '-q'); await writeFile(join(root, 'report.txt'), 'before\n'); await git('add', '--', 'report.txt');
  await git('-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Baseline');
  await writeFile(join(root, 'report.txt'), 'after\n');
  await store.update(s => s.devices.push({ id: 'device', deviceId: 'phone', name: 'Synthetic', tokenHash: createHash('sha256').update('synthetic').digest('hex'), workspaceIds: ['owned'],
    active: true, revoked: false, features: { fileTransfer: true, workspaceAdministration: false, automationManagement: false } }));
  const adapter = new FixtureAdapter({ workspaceDirectory: root, executionDirectory: root });
  const apps = createServers({ store, pairing: new Pairing(store), adapter, origin: 'https://fixture.test', platform: 'linux', architecture: 'x64' });
  try { await run({ apps, store, adapter, root, headers: { authorization: 'Bearer synthetic' } }); }
  finally { await apps.remote.close(); await apps.admin.close(); await store.close(); await rm(temp, { recursive: true, force: true }); }
}

test('authenticated changes return closed workspace provenance and revision-scoped passive text', () => fixture(async f => {
  const response = await f.apps.remote.inject({ url: base, headers: f.headers }); expect(response.statusCode).toBe(200);
  const list = response.json().data; expect(() => assertContract('ChangeSet', list)).not.toThrow();
  expect(list).toMatchObject({ sessionId: 'chat', provenance: 'workspace', files: [{ pathLabel: 'report.txt', status: 'modified', binary: false }] });
  const diff = await f.apps.remote.inject({ url: base + '/' + list.files[0].id + '/diff?revision=' + list.revision, headers: f.headers });
  expect(diff.statusCode).toBe(200); expect(() => assertContract('FileDiff', diff.json().data)).not.toThrow();
  expect(diff.json().data.text).toContain('+after'); expect(diff.headers['cache-control']).toBe('no-store'); expect(diff.payload).not.toContain(f.root);
}));

test('change routes require capability, native session scope and explicit host file access', () => fixture(async f => {
  expect((await f.apps.remote.inject({ url: base })).statusCode).toBe(401);
  expect((await f.apps.remote.inject({ url: base.replace('/owned/', '/foreign/'), headers: f.headers })).statusCode).toBe(403);
  const list = (await f.apps.remote.inject({ url: base, headers: f.headers })).json().data;
  expect((await f.apps.remote.inject({ url: base.replace('/chat/', '/other/') + '/' + list.files[0].id + '/diff?revision=' + list.revision, headers: f.headers })).statusCode).toBe(404);
  await f.store.update(s => { s.devices[0]!.features = undefined; });
  expect((await f.apps.remote.inject({ url: base, headers: f.headers })).statusCode).toBe(403);
  f.adapter.capabilities.changes = false;
  expect((await f.apps.remote.inject({ url: base, headers: f.headers })).statusCode).toBe(422);
}));

test('path proxies, extra queries, missing revisions and writes are rejected', () => fixture(async f => {
  const list = (await f.apps.remote.inject({ url: base, headers: f.headers })).json().data, diff = base + '/' + list.files[0].id + '/diff';
  for (const q of ['?path=/etc/passwd', '?url=https://fixture.test/a']) expect((await f.apps.remote.inject({ url: base + q, headers: f.headers })).statusCode).toBe(400);
  for (const q of ['', '?revision=bad', '?revision=' + list.revision + '&path=report.txt']) expect((await f.apps.remote.inject({ url: diff + q, headers: f.headers })).statusCode).toBe(400);
  for (const method of ['POST', 'PATCH', 'DELETE'] as const) expect((await f.apps.remote.inject({ method, url: base, headers: f.headers, payload: {} })).statusCode).toBe(404);
  await writeFile(join(f.root, 'report.txt'), 'changed again\n');
  expect((await f.apps.remote.inject({ url: diff + '?revision=' + list.revision, headers: f.headers })).statusCode).toBe(409);
}));

test('file access revoked during a pending native read rejects the late catalog', () => fixture(async f => {
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.adapter.wait = async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); };
  const pending = f.apps.remote.inject({ url: base, headers: f.headers }); await started;
  await f.store.update(s => { s.devices[0]!.features!.fileTransfer = false; }); release();
  expect((await pending).statusCode).toBe(403);
}));

test('unknown contract fields and over-bound results never become phone data', () => {
  const empty = { revision: 'a'.repeat(64), sessionId: 'chat', provenance: 'workspace', files: [], moreOnComputer: false };
  expect(() => assertContract('ChangeSet', empty)).not.toThrow();
  expect(() => assertContract('ChangeSet', { ...empty, root: '/secret' })).toThrow();
  expect(() => assertContract('ChangeSet', { ...empty, provenance: 'session' })).toThrow();
  expect(() => assertContract('FileDiff', { revision: 'a'.repeat(64), changeId: 'chg_' + 'a'.repeat(32), binary: false, text: 'x'.repeat(1048577), omitted: false })).toThrow();
});
