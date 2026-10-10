import { test, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../src/storage/store.js';
import { Pairing } from '../src/auth/pairing.js';
import { createServers } from '../src/server.js';
import { assertContract } from '../src/contract/index.js';

const none = { fileTransfer: false, workspaceAdministration: false, automationManagement: false };
const all = { fileTransfer: true, workspaceAdministration: true, automationManagement: true };
const capabilities = { readSessions: true, readMessages: true, readStatus: true, events: true,
  createSession: false, sendText: false, stop: false, readApprovals: true, replyApproval: false,
  maxPromptBytes: 32768, protocolVersion: 1 };
async function fixture(run: (apps: any, store: Store, headers: any) => Promise<void>) {
  const parent = await mkdtemp(join(tmpdir(), 'feature-access-'));
  const store = await Store.open(join(parent, 'state'));
  const token = 'synthetic-device-credential';
  await store.update(s => s.devices.push({ id:'device', deviceId:'phone', name:'Synthetic',
    tokenHash:createHash('sha256').update(token).digest('hex'), workspaceIds:['owned'], active:true, revoked:false }));
  const apps = createServers({ store, pairing:new Pairing(store), platform:'linux', architecture:'x64',
    origin:'https://fixture.test', adapter:{ version:'0.18.57', compatibility:'supported', capabilities,
      listWorkspaces:async () => [{id:'owned',name:'Synthetic'}] } as any });
  try { await run(apps,store,{authorization:'Bearer '+token}); }
  finally { await apps.remote.close(); await apps.admin.close(); await store.close(); await rm(parent,{recursive:true,force:true}); }
}
test('oldDeviceDoesNotGainPrivileges', () => fixture(async (apps,store,headers) => {
  const before = store.snapshot.devices[0]!;
  expect((await apps.remote.inject({url:'/v1/device/access',headers})).json().data.features).toEqual(none);
  expect(store.snapshot.devices[0]!.tokenHash).toBe(before.tokenHash);
  expect((store.snapshot.devices[0] as any).features).toBeUndefined();
}));
test('phoneCannotExpandFeatureGrant', () => fixture(async (apps,store,headers) => {
  expect((await apps.remote.inject({method:'POST',url:'/v1/device/access',headers,payload:{features:all}})).statusCode).toBe(404);
  expect((store.snapshot.devices[0] as any).features).toBeUndefined();
}));
test('onlyLocalControlCanChangeGrantsAndWorkspaceUpdatesPreserveThem', () => fixture(async (apps,store) => {
  await apps.controls.access('device',{workspaceIds:['owned'],features:all});
  expect((store.snapshot.devices[0] as any).features).toEqual(all);
  await apps.controls.access('device',{workspaceIds:['owned'],allWorkspaces:false});
  expect((store.snapshot.devices[0] as any).features).toEqual(all);
  await expect(apps.controls.access('device',{workspaceIds:['owned'],features:{...none,fileTransfer:'true'}})).rejects.toMatchObject({code:'INVALID_REQUEST'});
  expect((store.snapshot.devices[0] as any).features).toEqual(all);
}));
test('grantRevocationCancelsTransfer', () => fixture(async (apps) => {
  await apps.controls.access('device',{workspaceIds:['owned'],features:all});
  const pending = apps.featureOperations.begin('device','owned','fileTransfer');
  expect(pending.signal.aborted).toBe(false);
  await apps.controls.access('device',{workspaceIds:['owned'],features:none});
  expect(pending.signal.aborted).toBe(true);
  expect(() => pending.check()).toThrow();
  expect(() => apps.featureOperations.begin('device','owned','fileTransfer')).toThrow();
}));
test('foreignWorkspaceRejectedBeforeNativeAdapter', () => fixture(async (apps) => {
  await apps.controls.access('device',{workspaceIds:['owned'],features:all});
  expect(() => apps.featureOperations.begin('device','foreign','fileTransfer')).toThrow();
}));
test('disposingAnOldLeaseCannotDetachAReplacementTransfer', () => fixture(async (apps) => {
  await apps.controls.access('device',{workspaceIds:['owned'],features:all});
  const old = apps.featureOperations.begin('device','owned','fileTransfer');
  await apps.controls.access('device',{workspaceIds:['owned'],features:none});
  await apps.controls.access('device',{workspaceIds:['owned'],features:all});
  const current = apps.featureOperations.begin('device','owned','fileTransfer');
  old.dispose();
  await apps.controls.access('device',{workspaceIds:['owned'],features:none});
  expect(current.signal.aborted).toBe(true);
}));
test('deviceRevocationInvalidatesScopedOperations', () => fixture(async (apps) => {
  await apps.controls.access('device',{workspaceIds:['owned'],features:all});
  const pending = apps.featureOperations.begin('device','owned','workspaceAdministration');
  await apps.controls.revoke('device');
  expect(pending.signal.aborted).toBe(true);
  expect(() => pending.check()).toThrow();
}));
test('hostShutdownCancelsScopedOperations', () => fixture(async (apps) => {
  await apps.controls.access('device',{workspaceIds:['owned'],features:all});
  const pending = apps.featureOperations.begin('device','owned','fileTransfer');
  await apps.remote.close();
  expect(pending.signal.aborted).toBe(true);
  expect(() => pending.check()).toThrow();
  expect(() => apps.featureOperations.begin('device','owned','fileTransfer')).toThrow();
}));
test('newCapabilityFlagsAreOptionalAndStrictlyBoolean', () => {
  expect(assertContract('Capabilities',capabilities)).toEqual(capabilities);
  expect(assertContract('Capabilities',{...capabilities,questions:true,attachments:false,automationsWrite:false})).toMatchObject({questions:true});
  expect(() => assertContract('Capabilities',{...capabilities,questions:'true'})).toThrow();
});
