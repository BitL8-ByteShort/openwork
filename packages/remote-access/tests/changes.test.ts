import { test, expect } from 'vitest';
import { mkdtemp, realpath, writeFile, readFile, rm, unlink, symlink, mkdir, rename } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChangeCatalog, type ChangeContext } from '../src/changes/catalog.js';
import { FeatureOperations } from '../src/auth/feature-access.js';
import type { Device } from '../src/storage/store.js';

const execute = promisify(execFile);
async function fixture(run: (f: {
  root: string; context: ChangeContext; catalog: ChangeCatalog; device: Device;
  lease: ReturnType<FeatureOperations['begin']>; git: (...args: string[]) => Promise<string>;
}) => Promise<void>, initialized = true) {
  const temp = await mkdtemp(join(tmpdir(), 'changes-read-only-')), root = await realpath(temp);
  const git = async (...args: string[]) => (await execute('/usr/bin/git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], { cwd: root, encoding: 'utf8' })).stdout;
  if (initialized) {
    await git('init', '-q');
    await writeFile(join(root, 'existing.txt'), 'before\n');
    await writeFile(join(root, 'deleted.txt'), 'remove me\n');
    await writeFile(join(root, 'old-name.txt'), 'rename me\n');
    await git('add', '--', '.');
    await git('-c', 'user.name=Qualification Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Disposable baseline');
  }
  const device: Device = { id: 'device', deviceId: 'phone', name: 'Synthetic', tokenHash: 'synthetic', workspaceIds: ['owned'], active: true, revoked: false,
    features: { fileTransfer: true, workspaceAdministration: false, automationManagement: false } };
  const operations = new FeatureOperations(id => id === device.id ? device : undefined), lease = operations.begin(device.id, 'owned', 'fileTransfer');
  const context = { workspaceDirectory: root, executionDirectory: root }, catalog = new ChangeCatalog(async () => context);
  try { await run({ root, context, catalog, device, lease, git }); }
  finally { lease.dispose(); operations.close(); await rm(temp, { recursive: true, force: true }); }
}

test('workspace provenance includes pre-existing unrelated edits and reads leave files and index unchanged', () => fixture(async f => {
  await writeFile(join(f.root, 'existing.txt'), 'after\n');
  await writeFile(join(f.root, 'unrelated.txt'), 'a human made this change\n');
  const index = await readFile(join(f.root, '.git/index')), before = await f.git('status', '--porcelain=v1', '-z');
  const list = await f.catalog.list('device', 'owned', 'chat', f.lease);
  expect(list.provenance).toBe('workspace'); expect(list.files.map(x => x.pathLabel)).toEqual(['existing.txt', 'unrelated.txt']);
  const ref = list.files.find(x => x.pathLabel === 'existing.txt')!;
  expect(ref).toMatchObject({ status: 'modified', binary: false, added: 1, removed: 1 });
  const diff = await f.catalog.diff('device', 'owned', 'chat', ref.id, list.revision, f.lease);
  expect(diff.text).toContain('-before'); expect(diff.text).toContain('+after'); expect(diff.omitted).toBe(false);
  expect(await f.git('status', '--porcelain=v1', '-z')).toBe(before);
  expect(await readFile(join(f.root, '.git/index'))).toEqual(index);
  expect(await readFile(join(f.root, 'unrelated.txt'), 'utf8')).toBe('a human made this change\n');
}));

test('new, deleted, renamed, binary and leading-dash files have bounded opaque references', () => fixture(async f => {
  await unlink(join(f.root, 'deleted.txt')); await f.git('mv', '--', 'old-name.txt', 'new-name.txt');
  await writeFile(join(f.root, '-option.txt'), 'literal path\n'); await writeFile(join(f.root, 'binary.dat'), Buffer.from([0, 1, 2, 0, 255]));
  const list = await f.catalog.list('device', 'owned', 'chat', f.lease);
  expect(list.files).toHaveLength(4);
  expect(list.files.find(x => x.pathLabel === 'deleted.txt')?.status).toBe('deleted');
  expect(list.files.find(x => x.pathLabel === 'new-name.txt')?.status).toBe('renamed');
  expect(list.files.find(x => x.pathLabel === 'binary.dat')?.binary).toBe(true);
  for (const ref of list.files) expect(ref.id).toMatch(/^chg_[a-f0-9]{32}$/);
  const dash = list.files.find(x => x.pathLabel === '-option.txt')!;
  expect((await f.catalog.diff('device', 'owned', 'chat', dash.id, list.revision, f.lease)).text).toContain('+literal path');
}));

test('foreign device/workspace/chat handles, stale file revisions and changed baselines are rejected', () => fixture(async f => {
  await writeFile(join(f.root, 'existing.txt'), 'changed\n');
  const list = await f.catalog.list('device', 'owned', 'chat', f.lease), ref = list.files[0]!;
  for (const scope of [['other', 'owned', 'chat'], ['device', 'other', 'chat'], ['device', 'owned', 'other']])
    await expect(f.catalog.diff(scope[0]!, scope[1]!, scope[2]!, ref.id, list.revision, f.lease)).rejects.toMatchObject({ status: 404 });
  await writeFile(join(f.root, 'existing.txt'), 'changed again\n');
  await expect(f.catalog.diff('device', 'owned', 'chat', ref.id, list.revision, f.lease)).rejects.toMatchObject({ status: 409 });
  const refreshed = await f.catalog.list('device', 'owned', 'chat', f.lease), fresh = refreshed.files[0]!;
  await f.git('add', '--', 'existing.txt');
  await f.git('-c', 'user.name=Qualification Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Changed baseline');
  await expect(f.catalog.diff('device', 'owned', 'chat', fresh.id, refreshed.revision, f.lease)).rejects.toMatchObject({ status: 409 });
}));

test('non-Git projects are an explicit handoff and revoked access stops before a catalog', () => fixture(async f => {
  expect(await f.catalog.list('device', 'owned', 'chat', f.lease)).toMatchObject({ files: [], unavailableReason: 'non_git', provenance: 'workspace' });
  f.device.features!.fileTransfer = false;
  await expect(f.catalog.list('device', 'owned', 'chat', f.lease)).rejects.toMatchObject({ status: 403 });
}, false));

test('symlink and traversal roots never expose another folder', () => fixture(async f => {
  await symlink(tmpdir(), join(f.root, 'outside'));
  const list = await f.catalog.list('device', 'owned', 'chat', f.lease);
  expect(list.files).toEqual([]); expect(list.moreOnComputer).toBe(true);
  f.context.executionDirectory = tmpdir();
  expect(await f.catalog.list('device', 'owned', 'chat', f.lease)).toMatchObject({ files: [], unavailableReason: 'unsupported' });
}));

test('more than 100 files and oversized text diffs explicitly continue on the computer', () => fixture(async f => {
  for (let i = 0; i < 101; i++) await writeFile(join(f.root, `extra-${String(i).padStart(3, '0')}.txt`), 'new\n');
  const list = await f.catalog.list('device', 'owned', 'chat', f.lease);
  expect(list.files).toHaveLength(100); expect(list.moreOnComputer).toBe(true);
  await writeFile(join(f.root, 'existing.txt'), 'large line\n'.repeat(12_000));
  const refreshed = await f.catalog.list('device', 'owned', 'chat', f.lease), ref = refreshed.files.find(x => x.pathLabel === 'existing.txt')!;
  const diff = await f.catalog.diff('device', 'owned', 'chat', ref.id, refreshed.revision, f.lease);
  expect(diff.omitted).toBe(true); expect(Buffer.byteLength(diff.text)).toBeLessThanOrEqual(1_048_576); expect(diff.text.split('\n').length).toBeLessThanOrEqual(10_000);
}));

test('a registered session worktree is accepted, but a parent repository and unrelated worktree are not', () => fixture(async f => {
  const tree = await mkdtemp(join(tmpdir(), 'changes-owned-worktree-'));
  try {
    await f.git('worktree', 'add', '--detach', tree, 'HEAD');
    await writeFile(join(tree, 'existing.txt'), 'worktree edit\n');
    f.context.executionDirectory = await realpath(tree);
    const list = await f.catalog.list('device', 'owned', 'chat', f.lease);
    expect(list.files.map(x => x.pathLabel)).toEqual(['existing.txt']);
    expect((await f.catalog.diff('device', 'owned', 'chat', list.files[0]!.id, list.revision, f.lease)).text).toContain('+worktree edit');
    f.context.workspaceDirectory = tree; f.context.executionDirectory = tmpdir();
    expect(await f.catalog.list('device', 'owned', 'chat', f.lease)).toMatchObject({ unavailableReason: 'unsupported', files: [] });
  } finally { await f.git('worktree', 'remove', '--force', tree); await rm(tree, { recursive: true, force: true }); }
}));

test('configured external diff and textconv programs never run', () => fixture(async f => {
  const marker = join(f.root, 'must-not-run');
  await f.git('config', 'diff.external', '/usr/bin/touch ' + marker);
  await f.git('config', 'diff.synthetic.textconv', '/usr/bin/touch ' + marker);
  await writeFile(join(f.root, '.gitattributes'), 'existing.txt diff=synthetic\n');
  await writeFile(join(f.root, 'existing.txt'), 'safe edit\n');
  const list = await f.catalog.list('device', 'owned', 'chat', f.lease), ref = list.files.find(x => x.pathLabel === 'existing.txt')!;
  expect((await f.catalog.diff('device', 'owned', 'chat', ref.id, list.revision, f.lease)).text).toContain('+safe edit');
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
}));

test('a root or file replaced with a symlink after listing invalidates the handle', () => fixture(async f => {
  await writeFile(join(f.root, 'existing.txt'), 'safe\n');
  const list = await f.catalog.list('device', 'owned', 'chat', f.lease), ref = list.files[0]!;
  await unlink(join(f.root, 'existing.txt')); await symlink('/etc/passwd', join(f.root, 'existing.txt'));
  await expect(f.catalog.diff('device', 'owned', 'chat', ref.id, list.revision, f.lease)).rejects.toMatchObject({ status: 409 });
  f.context.executionDirectory = tmpdir();
  await expect(f.catalog.diff('device', 'owned', 'chat', ref.id, list.revision, f.lease)).rejects.toMatchObject({ status: 409 });
}));

test('a text diff larger than one MiB reports omission without revealing a host absolute path', () => fixture(async f => {
  await writeFile(join(f.root, 'new.txt'), ('a'.repeat(1000) + '\n').repeat(1800));
  const list = await f.catalog.list('device', 'owned', 'chat', f.lease), ref = list.files[0]!;
  const diff = await f.catalog.diff('device', 'owned', 'chat', ref.id, list.revision, f.lease);
  expect(diff.omitted).toBe(true); expect(Buffer.byteLength(diff.text)).toBeLessThanOrEqual(1_048_576);
  expect(diff.text).toContain('+++ b/new.txt'); expect(diff.text).not.toContain(f.root);
}));

test('changed submodules are explicitly omitted instead of reporting a clean workspace', () => fixture(async f => {
  await f.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', '--', f.root, 'module');
  await f.git('-c', 'user.name=Qualification Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qam', 'Disposable submodule baseline');
  await writeFile(join(f.root, 'module/existing.txt'), 'nested edit\n');
  const list = await f.catalog.list('device', 'owned', 'chat', f.lease);
  expect(list.files).toEqual([]); expect(list.moreOnComputer).toBe(true);
}));

test('a non-UTF8 baseline is treated as binary even when the new file is valid text', () => fixture(async f => {
  await writeFile(join(f.root, 'existing.txt'), Buffer.from([255, 254, 1])); await f.git('add', '--', 'existing.txt');
  await f.git('-c', 'user.name=Qualification Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Disposable invalid text baseline');
  await writeFile(join(f.root, 'existing.txt'), 'valid now\n');
  const list = await f.catalog.list('device', 'owned', 'chat', f.lease), ref = list.files[0]!;
  expect(ref.binary).toBe(true);
  expect(await f.catalog.diff('device', 'owned', 'chat', ref.id, list.revision, f.lease)).toMatchObject({ binary: true, text: '' });
}));

test('moving an ancestor directory invalidates a handle even when file bytes and inode stay the same', () => fixture(async f => {
  await mkdir(join(f.root, 'nested')); await writeFile(join(f.root, 'nested/new.txt'), 'safe\n');
  const list = await f.catalog.list('device', 'owned', 'chat', f.lease), ref = list.files[0]!;
  await rename(join(f.root, 'nested'), join(f.root, 'moved')); await rename(join(f.root, 'moved'), join(f.root, 'nested'));
  await expect(f.catalog.diff('device', 'owned', 'chat', ref.id, list.revision, f.lease)).rejects.toMatchObject({ status: 409 });
}));
