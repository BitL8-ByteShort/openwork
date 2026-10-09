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
    else if (url.pathname.endsWith('/message')) res.end(JSON.stringify({ data: [{ type: 'assistant', text: '[result](.opencode/openwork/outbox/result.pdf)' }], cursor: { next: state.next ? 'more' : null } }));
    else if (url.pathname.endsWith('/ses_chat')) res.end(JSON.stringify({ data: { id: state.sid, location: { directory: '/synthetic/workspace' } } }));
    else { res.writeHead(404); res.end('{}'); }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing fixture port');
  const adapter = new OpenWorkV2(async () => ({ origin: 'http://127.0.0.1:' + address.port, token: 'synthetic-native' }));
  adapter.capabilities.artifacts = true;
  try { await run(adapter, state); } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
}

test('result context reads only the scoped native session and its projected message pages', () => fixture(async (adapter, state) => {
  expect(await adapter.readArtifactContext('owned', 'ses_chat', new AbortController().signal)).toEqual({ workspaceDirectory: '/synthetic/workspace', executionDirectory: '/synthetic/workspace',
    candidates: [{ path: '.opencode/openwork/outbox/result.pdf', source: 'assistant_outbox_link' }], moreOnComputer: false });
  expect(state.requests).toHaveLength(3);
  expect(state.requests.some(path => path.includes('/artifacts') || path.includes('/files/raw'))).toBe(false);
}));

test('foreign native IDs fail before reading messages and unqualified hosts do not resolve files', () => fixture(async (adapter, state) => {
  state.sid = 'ses_foreign';
  await expect(adapter.readArtifactContext('owned', 'ses_chat', new AbortController().signal)).rejects.toMatchObject({ status: 404 });
  expect(state.requests.some(path => path.includes('/message'))).toBe(false);
  adapter.capabilities.artifacts = false; const count = state.requests.length;
  await expect(adapter.readArtifactContext('owned', 'ses_chat', new AbortController().signal)).rejects.toMatchObject({ status: 422 });
  expect(state.requests).toHaveLength(count);
}));

test('repeated or over-bound message paging stops and explicitly indicates more results on the computer', () => fixture(async (adapter, state) => {
  state.next = true;
  const result = await adapter.readArtifactContext('owned', 'ses_chat', new AbortController().signal);
  expect(result.moreOnComputer).toBe(true); expect(state.requests.length).toBeLessThanOrEqual(6);
}));
