import { test, expect } from 'vitest';
import { createServer } from 'node:http';
import { OpenWorkV2 } from '../src/adapters/openwork-v2-01857.js';

async function fixture(run: (adapter: OpenWorkV2, requests: string[]) => Promise<void>, value: (url: string) => unknown) {
  const requests: string[] = [];
  const server = createServer((req,res) => {
    requests.push(req.url ?? ''); res.setHeader('content-type','application/json');
    res.end(JSON.stringify(req.url === '/health' ? { ok: true, version: '0.18.57' } : value(req.url ?? '')));
  });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw Error('No fixture port');
    const adapter = new OpenWorkV2(async () => ({ origin:'http://127.0.0.1:'+address.port, token:'synthetic-history' }));
    await adapter.health(); await run(adapter,requests);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); }
}
const message = (fileData: string) => ({ id:'msg_owned',time:{created:0},type:'user',text:'Selected image',
  files:[{ name:'photo.png',mime:'image/png',data:fileData,source:{type:'uri',uri:'file:///private/never-exposed'}}] });

test('large native file bytes are projected out before bounded chat normalization', () => fixture(async adapter => {
  const page=await adapter.readMessages('owned','chat');
  expect(page.data).toHaveLength(1);
  expect(page.data[0]?.blocks).toEqual([{kind:'text',text:'Selected image'},{kind:'unsupported',label:'Attached: photo.png'}]);
  const phone=JSON.stringify(page);
  expect(phone.length).toBeLessThan(1000);expect(phone).not.toContain('/private/');expect(phone).not.toContain('AAAA');
},()=>({data:[message('A'.repeat(28*1024*1024))],cursor:{next:'older'}})));

test('attachment-only messages retain an honest file label', () => fixture(async adapter => {
  const page=await adapter.readMessages('owned','chat');
  expect(page.data[0]?.blocks).toEqual([{kind:'text',text:''},{kind:'unsupported',label:'Attached: photo.png'}]);
},()=>({data:[{...message('YWJj'),text:''}],cursor:{next:null}})));

test('unrelated large JSON values still obey the eight MiB limit', () => fixture(async adapter => {
  await expect(adapter.readMessages('owned','chat')).rejects.toMatchObject({code:'SNAPSHOT_TOO_LARGE'});
},()=>({data:[{...message(''),metadata:{data:'A'.repeat(9*1024*1024)}}],cursor:{next:null}})));

test('a page above the fixed native wire bound falls back to one message and preserves its cursor', () => fixture(async (adapter,requests) => {
  const page=await adapter.readMessages('owned','chat','opaque-old-page');
  expect(page.data).toHaveLength(1); expect(page.cursor).toBe('continue-older');
  const reads=requests.filter(url=>url.includes('/message?'));
  expect(reads).toHaveLength(2);
  expect(new URL(reads[0]!, 'http://fixture.test').searchParams.get('limit')).toBe('50');
  expect(new URL(reads[1]!, 'http://fixture.test').searchParams.get('limit')).toBe('1');
  expect(reads.every(url=>new URL(url,'http://fixture.test').searchParams.get('cursor')==='opaque-old-page')).toBe(true);
},url=>({data:new URL(url,'http://fixture.test').searchParams.get('limit')==='1'?[message('YWJj')]:
  Array.from({length:3},()=>message('A'.repeat(22*1024*1024))),cursor:{next:'continue-older'}})));
