import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, stat, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('preview keeps the official edition as the default protocol handler', async () => {
  const { shouldRegisterDesktopProtocol } = await import('./preview-adoption.mjs');
  const official = { isPackaged: true, metadata: {}, disabled: false, blankSlate: false, platform: 'darwin', appImage: false };
  assert.equal(shouldRegisterDesktopProtocol(official), true);
  assert.equal(shouldRegisterDesktopProtocol({ ...official, metadata: { openworkProductName: 'OpenWork Remote Preview' } }), false);
  assert.equal(shouldRegisterDesktopProtocol({ ...official, isPackaged: false }), false);
  assert.equal(shouldRegisterDesktopProtocol({ ...official, disabled: true }), false);
  assert.equal(shouldRegisterDesktopProtocol({ ...official, platform: 'linux', appImage: true }), false);
});

test('packaged preview adoption backs up privately before recording the existing profile', async () => {
  assert.ok(existsSync(new URL('./preview-adoption.mjs', import.meta.url)), 'Packaged profile adoption is not implemented');
  const { adoptPreviewProfile } = await import('./preview-adoption.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'preview-adoption-'));
  const options = { profilePath: path.join(root, 'profile'), bridgePath: path.join(root, 'bridge'), backupRoot: path.join(root, 'backups') };
  try {
    await mkdir(options.profilePath); await mkdir(options.bridgePath);
    await writeFile(path.join(options.profilePath, 'openwork-workspaces.json'), '{"synthetic":true}');
    await writeFile(path.join(options.bridgePath, 'state.json'), '{"hostId":"synthetic"}');
    const backup = await adoptPreviewProfile(options);
    assert.equal(await readFile(path.join(backup, 'profile/openwork-workspaces.json'), 'utf8'), '{"synthetic":true}');
    assert.equal((await stat(backup)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(backup, 'bridge/state.json'))).mode & 0o777, 0o600);
    assert.equal(await adoptPreviewProfile(options), backup);
    await rm(backup, { recursive: true });
    await assert.rejects(adoptPreviewProfile(options), /backup.*missing/i);
    // Restore a backup before exercising the separate unsafe-link failure.
    await mkdir(backup);
    await symlink(path.join(root, 'outside'), path.join(options.profilePath, 'unsafe'));
    await rm(path.join(options.profilePath, 'remote-preview-adoption.v1.json'));
    await assert.rejects(adoptPreviewProfile(options), /symbolic link/i);
    assert.equal(existsSync(path.join(options.profilePath, 'remote-preview-adoption.v1.json')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('packaged preview refuses a missing stable profile rather than opening empty', async () => {
  assert.ok(existsSync(new URL('./preview-adoption.mjs', import.meta.url)), 'Packaged profile adoption is not implemented');
  const { adoptPreviewProfile } = await import('./preview-adoption.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'preview-adoption-'));
  try { await assert.rejects(adoptPreviewProfile({ profilePath: path.join(root, 'absent'), bridgePath: path.join(root, 'bridge'), backupRoot: path.join(root, 'backups') }), /OpenWork.*first/i); }
  finally { await rm(root, { recursive: true, force: true }); }
});
