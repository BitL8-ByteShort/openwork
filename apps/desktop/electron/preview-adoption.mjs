import { mkdir, readFile, writeFile, rename, readdir, lstat, copyFile, chmod, rm } from 'node:fs/promises';
import path from 'node:path';

const markerName = 'remote-preview-adoption.v1.json';
async function copyPrivateTree(source, target, optional = false) {
  await mkdir(target, { mode: 0o700 });
  let entries;
  try { entries = await readdir(source); }
  catch (error) { if (optional && error.code === 'ENOENT') return; throw error; }
  for (const name of entries) {
    if (['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort', markerName].includes(name)) continue;
    const from = path.join(source, name), to = path.join(target, name), info = await lstat(from);
    if (info.isSymbolicLink()) throw new Error('Profile contains a symbolic link; a reviewed backup is required.');
    if (info.isDirectory()) await copyPrivateTree(from, to);
    else if (info.isFile()) { await copyFile(from, to); await chmod(to, 0o600); }
  }
}

/** Caller must hold Electron's shared-profile singleton before this runs. */
export async function adoptPreviewProfile({ profilePath, bridgePath, backupRoot }) {
  const marker = path.join(profilePath, markerName);
  let existing;
  try {
    existing = JSON.parse(await readFile(marker, 'utf8'));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing) {
    if (existing.profile !== profilePath || existing.bridge !== bridgePath || typeof existing.backup !== 'string') {
      throw new Error('Preview adoption belongs to a different profile; review it before continuing.');
    }
    try {
      if (!(await lstat(existing.backup)).isDirectory()) throw new Error('Not a directory');
    } catch { throw new Error('Preview backup is missing; review adoption before continuing.'); }
    return existing.backup;
  }
  try { await lstat(path.join(profilePath, 'openwork-workspaces.json')); }
  catch { throw new Error('Open the installed OpenWork app first, create your workspace, and quit it before opening Remote Preview.'); }
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const backup = path.join(backupRoot, `${Date.now()}-${process.pid}`);
  await mkdir(backup, { mode: 0o700 });
  try {
    await copyPrivateTree(profilePath, path.join(backup, 'profile'));
    await copyPrivateTree(bridgePath, path.join(backup, 'bridge'), true);
    const temporary = marker + '.tmp';
    await writeFile(temporary, JSON.stringify({ profile: profilePath, bridge: bridgePath, backup, edition: 'OpenWork Remote Preview' }) + '\n', { mode: 0o600 });
    await rename(temporary, marker);
    return backup;
  } catch (error) { await rm(backup, { recursive: true, force: true }); throw error; }
}
