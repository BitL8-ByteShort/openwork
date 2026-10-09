import { test, expect } from 'vitest';
import { projectMessageJSON } from '../src/messages/projection.js';

function response(text: string, size = 7) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.subarray(offset, offset + size)); offset = Math.min(bytes.length, offset + size);
  } }));
}
test('split UTF-8 and escaped keys preserve ordinary content while omitting only native file strings', async () => {
  const text = '{"data":[{"text":"Hello 😀 \\"quoted\\"","files":[{"d\\u0061ta":"YWJj\\u0041","name":"photo.png"}],"metadata":{"data":"Keep this"}}],"cursor":{"next":"opaque"}}';
  expect(await projectMessageJSON(response(text,1))).toEqual({data:[{text:'Hello 😀 "quoted"',files:[{data:'',name:'photo.png'}],metadata:{data:'Keep this'}}],cursor:{next:'opaque'}});
});
test('root and unrelated files/data shapes are never treated as binary bypasses', async () => {
  const value = {data:[{other:{files:[{data:'Keep nested'}]}}],files:[{data:'Keep root'}], extra:{data:[{files:[{data:'Keep extra'}]}]}};
  expect(await projectMessageJSON(response(JSON.stringify(value)))).toEqual(value);
});
test('bad escapes and control bytes in omitted strings remain invalid JSON', async () => {
  for (const data of ['A\\q','A\\uXX00','A\nB']) {
    await expect(projectMessageJSON(response('{"data":[{"files":[{"data":"'+data+'"}]}]}'))).rejects.toMatchObject({code:'INVALID_UPSTREAM'});
  }
});
test('truncation, invalid ordinary JSON and excessive nesting fail closed', async () => {
  for (const text of ['{"data":[{"files":[{"data":"unfinished','{"data":true,}', '{"data":nul}', '['.repeat(65)+']'.repeat(65)]) {
    await expect(projectMessageJSON(response(text))).rejects.toMatchObject({code:'INVALID_UPSTREAM'});
  }
});
test('ordinary strings retain the normalized limit and an invalid UTF-8 sequence is rejected', async () => {
  await expect(projectMessageJSON(response('{"data":[{"text":"'+'a'.repeat(8*1024*1024)+'"}]}',65536))).rejects.toMatchObject({code:'SNAPSHOT_TOO_LARGE'});
  await expect(projectMessageJSON(new Response(new Uint8Array([123,34,100,97,116,97,34,58,34,255,34,125])))).rejects.toMatchObject({code:'INVALID_UPSTREAM'});
});
