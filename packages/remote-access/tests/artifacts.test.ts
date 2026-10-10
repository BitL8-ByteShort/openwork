import { test, expect } from 'vitest';
import { mkdtemp, realpath, mkdir, writeFile, rm, symlink, link, unlink, chmod, appendFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { ArtifactCatalog, type ArtifactContext } from '../src/artifacts/catalog.js';
import { FeatureOperations } from '../src/auth/feature-access.js';
import type { Device } from '../src/storage/store.js';

async function fixture(run: (f: {
  root: string; context: ArtifactContext; catalog: ArtifactCatalog; device: Device;
  operations: FeatureOperations; lease: ReturnType<FeatureOperations['begin']>;
}) => Promise<void>) {
  const temp = await mkdtemp(join(tmpdir(), 'artifact-catalog-')), root = await realpath(temp);
  await writeFile(join(root, 'report.txt'), 'generated result\n');
  const device: Device = { id: 'device', deviceId: 'phone', name: 'Synthetic', tokenHash: 'synthetic', workspaceIds: ['owned'], active: true, revoked: false,
    features: { fileTransfer: true, workspaceAdministration: false, automationManagement: false } };
  const operations = new FeatureOperations(id => id === device.id ? device : undefined);
  const lease = operations.begin(device.id, 'owned', 'fileTransfer');
  const context: ArtifactContext = { workspaceDirectory: root, executionDirectory: root,
    candidates: [{ path: 'report.txt', source: 'completed_write_metadata' }], moreOnComputer: false };
  const catalog = new ArtifactCatalog(async () => context);
  try { await run({ root, context, catalog, device, operations, lease }); }
  finally { lease.dispose(); operations.close(); await rm(temp, { recursive: true, force: true }); }
}
const bytes = async (stream: AsyncIterable<Buffer>) => { const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); };

test('only session-associated regular results receive opaque handles and verified content hashes', () => fixture(async f => {
  await writeFile(join(f.root, 'unrelated.txt'), 'private');
  f.context.candidates.push({ path: join(f.root, 'report.txt'), source: 'completed_tool_manifest' });
  const list = await f.catalog.list('device', 'owned', 'chat', f.lease);
  expect(list.items).toHaveLength(1);
  const ref = list.items[0]!;
  expect(ref).toMatchObject({ sessionId: 'chat', name: 'report.txt', mime: 'text/plain', bytes: 17, previewKind: 'text', sha256: createHash('sha256').update('generated result\n').digest('hex') });
  expect(ref.id).toMatch(/^art_[a-f0-9]{32}$/); expect(ref).not.toHaveProperty('path');
  expect(JSON.stringify(list)).not.toContain(f.root);
  const content = await f.catalog.open('device', 'owned', 'chat', ref.id, ref.revision, undefined, f.lease);
  expect((await bytes(content.stream)).toString()).toBe('generated result\n');
}));

test('handles cannot move between devices, workspaces, chats or arbitrary URL/path requests', () => fixture(async f => {
  const ref = (await f.catalog.list('device', 'owned', 'chat', f.lease)).items[0]!;
  for (const [device, wid, sid, id] of [['other', 'owned', 'chat', ref.id], ['device', 'foreign', 'chat', ref.id], ['device', 'owned', 'other', ref.id], ['device', 'owned', 'chat', '../report.txt'], ['device', 'owned', 'chat', 'https://example.test/file']])
    await expect(f.catalog.open(device!, wid!, sid!, id!, ref.revision, undefined, f.lease)).rejects.toMatchObject({ status: 404 });
}));

test('revoked file access stops each new download and every subsequent read chunk', () => fixture(async f => {
  await writeFile(join(f.root, 'report.txt'), 'x'.repeat(200_000));
  const ref = (await f.catalog.list('device', 'owned', 'chat', f.lease)).items[0]!;
  const content = await f.catalog.open('device', 'owned', 'chat', ref.id, ref.revision, undefined, f.lease);
  const iterator = content.stream[Symbol.asyncIterator]();
  expect((await iterator.next()).value!.length).toBeLessThanOrEqual(65536);
  f.device.features!.fileTransfer = false;
  await expect(iterator.next()).rejects.toMatchObject({ status: 403 });
  await expect(f.catalog.open('device', 'owned', 'chat', ref.id, ref.revision, undefined, f.lease)).rejects.toMatchObject({ status: 403 });
}));

test('external URLs, traversal, symlinks, hardlinks and unsupported active files stay on the computer', () => fixture(async f => {
  await writeFile(join(f.root, 'payload.html'), '<html>active</html>');
  await writeFile(join(f.root, 'payload.svg'), '<svg/>');
  await writeFile(join(f.root, 'payload.zip'), Buffer.from('PK\x03\x04'));
  await writeFile(join(f.root, 'payload.sh'), '#!/bin/sh\n');
  await symlink(join(f.root, 'report.txt'), join(f.root, 'linked.txt'));
  await link(join(f.root, 'report.txt'), join(f.root, 'hardlinked.txt'));
  f.context.candidates = ['../secret.txt', 'https://example.test/file.pdf', 'payload.html', 'payload.svg', 'payload.zip', 'payload.sh', 'linked.txt', 'hardlinked.txt']
    .map(path => ({ path, source: 'completed_write_metadata' }));
  const result = await f.catalog.list('device', 'owned', 'chat', f.lease);
  expect(result.items).toEqual([]); expect(result.moreOnComputer).toBe(true);
}));

test('malicious MIME claims cannot turn HTML or executable bytes into an image/text preview', () => fixture(async f => {
  await writeFile(join(f.root, 'report.png'), '<html><script>active</script></html>');
  await writeFile(join(f.root, 'disguised.txt'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0]));
  await chmod(join(f.root, 'report.txt'), 0o700);
  f.context.candidates.push({ path: 'report.png', source: 'completed_tool_manifest' }, { path: 'disguised.txt', source: 'completed_write_metadata' });
  expect((await f.catalog.list('device', 'owned', 'chat', f.lease)).items).toEqual([]);
}));

test('catalogues reject files above 20 MiB and do not follow a replaced parent directory', () => fixture(async f => {
  const folder = join(f.root, 'results'); await mkdir(folder); await writeFile(join(folder, 'large.txt'), 'x'.repeat(20 * 1024 * 1024 + 1));
  f.context.candidates = [{ path: 'results/large.txt', source: 'completed_write_metadata' }];
  expect((await f.catalog.list('device', 'owned', 'chat', f.lease)).items).toEqual([]);
  await rm(folder, { recursive: true }); await symlink(f.root, folder);
  f.context.candidates = [{ path: 'results/report.txt', source: 'completed_write_metadata' }];
  expect((await f.catalog.list('device', 'owned', 'chat', f.lease)).items).toEqual([]);
}));

test('a changed revision, symlink replacement or no-longer-associated output requires a fresh catalog', () => fixture(async f => {
  const ref = (await f.catalog.list('device', 'owned', 'chat', f.lease)).items[0]!;
  await writeFile(join(f.root, 'report.txt'), 'different content');
  await expect(f.catalog.open('device', 'owned', 'chat', ref.id, ref.revision, undefined, f.lease)).rejects.toMatchObject({ status: 409 });
  const changed = (await f.catalog.list('device', 'owned', 'chat', f.lease)).items[0]!;
  expect(changed.revision).not.toBe(ref.revision);
  await unlink(join(f.root, 'report.txt')); await symlink(join(f.root, 'absent.txt'), join(f.root, 'report.txt'));
  await expect(f.catalog.open('device', 'owned', 'chat', changed.id, changed.revision, undefined, f.lease)).rejects.toMatchObject({ status: 409 });
  f.context.candidates = [];
  await expect(f.catalog.open('device', 'owned', 'chat', changed.id, changed.revision, undefined, f.lease)).rejects.toMatchObject({ status: 409 });
}));

test('file growth during a download stops bytes at the last verified chunk', () => fixture(async f => {
  await writeFile(join(f.root, 'report.txt'), 'x'.repeat(200_000));
  const ref = (await f.catalog.list('device', 'owned', 'chat', f.lease)).items[0]!;
  const content = await f.catalog.open('device', 'owned', 'chat', ref.id, ref.revision, undefined, f.lease);
  const iterator = content.stream[Symbol.asyncIterator]();
  const first = await iterator.next(); expect(first.value!.length).toBeLessThanOrEqual(65536);
  await appendFile(join(f.root, 'report.txt'), 'changed');
  await expect(iterator.next()).rejects.toMatchObject({ status: 409 });
}));

test('bounded single ranges require the catalog revision and return exact requested bytes', () => fixture(async f => {
  const ref = (await f.catalog.list('device', 'owned', 'chat', f.lease)).items[0]!;
  const content = await f.catalog.open('device', 'owned', 'chat', ref.id, ref.revision, 'bytes=2-7', f.lease);
  expect(content).toMatchObject({ status: 206, start: 2, end: 7, length: 6 });
  expect((await bytes(content.stream)).toString()).toBe('nerate');
  for (const range of ['bytes=0-', 'bytes=-5', 'bytes=0-1,3-4', 'bytes=17-18', 'bytes=0-1048576'])
    await expect(f.catalog.open('device', 'owned', 'chat', ref.id, ref.revision, range, f.lease)).rejects.toMatchObject({ status: 416 });
  await expect(f.catalog.open('device', 'owned', 'chat', ref.id, 'bad-revision', undefined, f.lease)).rejects.toMatchObject({ status: 409 });
}));

test('a native execution folder outside the workspace needs verified Git worktree membership', () => fixture(async f => {
  f.context.executionDirectory = join(f.root, '..');
  const result = await f.catalog.list('device', 'owned', 'chat', f.lease);
  expect(result.items).toEqual([]); expect(result.moreOnComputer).toBe(true);
}));

test('native-owned registered worktrees resolve results within their own execution root', () => fixture(async f => {
  const external = f.root + '-worktree';
  const git = async (args: string[]) => promisify(execFile)('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: f.root });
  try {
    await git(['init']); await git(['-c', 'user.name=Synthetic', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'Fixture']);
    await git(['worktree', 'add', '--detach', external]); await writeFile(join(external, 'report.txt'), 'worktree result');
    f.context.executionDirectory = external;
    const ref = (await f.catalog.list('device', 'owned', 'chat', f.lease)).items[0]!;
    expect(ref).toMatchObject({ name: 'report.txt', bytes: 15 });
    const result = await f.catalog.open('device', 'owned', 'chat', ref.id, ref.revision, undefined, f.lease);
    expect((await bytes(result.stream)).toString()).toBe('worktree result');
    await git(['worktree', 'remove', '--force', external]);
    await expect(f.catalog.open('device', 'owned', 'chat', ref.id, ref.revision, undefined, f.lease)).rejects.toMatchObject({ status: 409 });
  } finally { await rm(external, { recursive: true, force: true }); }
}));
