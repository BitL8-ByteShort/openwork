import { test, expect } from 'vitest';
import { createServer } from 'node:http';
import { OpenWorkV2 } from '../src/adapters/openwork-v2-01857.js';

test.each([
  { name: 'legacy adapter', writes: true, qualified: false, version: '0.18.57', expected: false },
  { name: 'qualified adapter', writes: true, qualified: true, version: '0.18.57', expected: true },
  { name: 'qualified read-only adapter', writes: false, qualified: true, version: '0.18.57', expected: true },
  { name: 'incompatible server', writes: true, qualified: true, version: '9.9.9', expected: false },
])('artifact advertisement requires explicit qualification and compatible health: $name', async ({ writes, qualified, version, expected }) => {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, version }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Missing fixture port');
    const adapter = new OpenWorkV2(async () => ({ origin: `http://127.0.0.1:${address.port}`, token: 'synthetic' }), writes, undefined, false, false, qualified);
    expect(adapter.capabilities.artifacts === true).toBe(false);
    await adapter.health();
    expect(adapter.capabilities.artifacts === true).toBe(expected);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('a later incompatible health check withdraws qualified artifact availability', async () => {
  let version = '0.0.0-dev';
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, version }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Missing fixture port');
    const adapter = new OpenWorkV2(async () => ({ origin: `http://127.0.0.1:${address.port}`, token: 'synthetic' }), true, version, true, true, true);
    await adapter.health();
    expect(adapter.capabilities.artifacts).toBe(true);
    version = '0.0.0-other';
    await adapter.health();
    expect(adapter.capabilities.artifacts).toBe(false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
