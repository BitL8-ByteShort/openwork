import { test, expect } from 'vitest';
import { createServer } from 'node:http';
import { OpenWorkV2 } from '../src/adapters/openwork-v2-01857.js';

async function fixture(run: (adapter: OpenWorkV2, state: { sid: string; requests: string[]; next: boolean }) => Promise<void>) {
  const state = { sid: 'ses_chat', requests: [] as string[], next: false };
  const server = createServer((req, res) => {
    state.requests.push(req.url ?? ''); res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer synthetic-native') { res.writeHead(401); res.end('{}'); return; }
    const url = new URL(req.url!, 'http://fixture.test');
    if (url.pathname === '/workspaces') res.end(JSON.stringify({ items: [{ id: 'owned', path: '/synthetic/workspace', name: 'Synthetic' }] }));
    else if (url.pathname.endsWith('/ses_chat')) res.end(JSON.stringify({ data: { id: state.sid, location: { directory: '/synthetic/workspace' } } }));
    else { res.writeHead(404); res.end('{}'); }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing fixture port');
  const adapter = new OpenWorkV2(async () => ({ origin: 'http://127.0.0.1:' + address.port, token: 'synthetic-native' }));
  adapter.capabilities.changes = true;
  try { await run(adapter, state); } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
}

test('change context verifies registry and native session ownership without reading transcripts or arbitrary file routes', () => fixture(async (adapter, state) => {
  expect(await adapter.readChangeContext('owned', 'ses_chat', new AbortController().signal)).toEqual({ workspaceDirectory: '/synthetic/workspace', executionDirectory: '/synthetic/workspace' });
  expect(state.requests).toEqual(['/workspaces', '/workspace/owned/opencode2/api/session/ses_chat']);
}));

test('unqualified, foreign and cancelled change-context reads fail closed', () => fixture(async (adapter, state) => {
  adapter.capabilities.changes = false;
  await expect(adapter.readChangeContext('owned', 'ses_chat', new AbortController().signal)).rejects.toMatchObject({ status: 422 });
  expect(state.requests).toHaveLength(0); adapter.capabilities.changes = true;
  await expect(adapter.readChangeContext('foreign', 'ses_chat', new AbortController().signal)).rejects.toMatchObject({ status: 404 });
  state.sid = 'foreign';
  await expect(adapter.readChangeContext('owned', 'ses_chat', new AbortController().signal)).rejects.toMatchObject({ status: 404 });
  const controller = new AbortController(); controller.abort();
  await expect(adapter.readChangeContext('owned', 'ses_chat', controller.signal)).rejects.toThrow();
  expect(state.requests.some(p => p.includes('/message') || p.includes('/files'))).toBe(false);
}));
