import {test,expect} from 'vitest';
import type {Session} from '../src/contract/index.js';
import {SessionSearch} from '../src/search/session-search.js';
const row=(n:number,title='Other',workspaceId='owned'):Session=>({id:'chat_'+n,workspaceId,title,updatedAt:'2026-10-09T00:00:00.000Z',modelLabel:null,status:'idle'});
const signal=()=>new AbortController().signal;
function fixture(count:number,match:(n:number)=>boolean=()=>false){
 const rows=Array.from({length:count},(_,n)=>row(n,match(n)?'Homepage':'Other'));
 let reads=0;
 const search=new SessionSearch(async(wid,cursor)=>{reads++;const start=Number(cursor??0);return {data:rows.slice(start,start+50).map(r=>({...r,workspaceId:wid})),cursor:start+50<rows.length?String(start+50):null};});
 return {search,rows,reads:()=>reads};
}
test('finds matches beyond the first 50 titles and scans no more than 500 per request',async()=>{
 const f=fixture(1055,n=>n===75||n===1001),first=await f.search.read('phone','owned','home',undefined,signal());
 expect(first.data.map(x=>x.id)).toEqual(['chat_75']);expect(first.scanned).toBe(500);expect(first.complete).toBe(false);expect(f.reads()).toBe(10);
 const second=await f.search.read('phone','owned','HOME',first.cursor!,signal());expect(second.scanned).toBe(500);expect(second.complete).toBe(false);
 const last=await f.search.read('phone','owned','home',second.cursor!,signal());expect(last.data.map(x=>x.id)).toEqual(['chat_1001']);expect(last.scanned).toBe(55);expect(last.complete).toBe(true);expect(last.cursor).toBeNull();
});
test('a 50-result boundary preserves the rest of the native page for continuation',async()=>{
 const f=fixture(101,n=>n!==25),a=await f.search.read('phone','owned','home',undefined,signal());expect(a.data).toHaveLength(50);expect(a.scanned).toBe(51);
 const b=await f.search.read('phone','owned','home',a.cursor!,signal());expect(b.data).toHaveLength(50);expect(new Set([...a.data,...b.data].map(x=>x.id)).size).toBe(100);expect(b.complete).toBe(true);
});
test('cursor is bound to device, workspace and normalized query, expires and contains no native cursor/title',async()=>{
 let now=1,pageNumber=0;const f=fixture(600),search=new SessionSearch(async()=>({data:f.rows.slice(0,50),cursor:'native-secret-cursor-'+pageNumber++}),()=>now);
 const page=await search.read('phone','owned','missing',undefined,signal());expect(page.cursor).toMatch(/^[0-9a-f-]{36}$/);expect(page.cursor).not.toContain('native');
 for(const [device,wid,q] of [['other','owned','missing'],['phone','foreign','missing'],['phone','owned','different']])await expect(search.read(device!,wid!,q!,page.cursor!,signal())).rejects.toMatchObject({status:409});
 now+=300001;await expect(search.read('phone','owned','missing',page.cursor!,signal())).rejects.toMatchObject({code:'SEARCH_EXPIRED'});
});
test('renamed titles appear in a fresh search; empty, oversized and unsafe queries/cursors never read',async()=>{
 const f=fixture(2);expect((await f.search.read('phone','owned','home',undefined,signal())).data).toEqual([]);f.rows[1]!.title='Homepage';expect((await f.search.read('phone','owned','home',undefined,signal())).data.map(x=>x.id)).toEqual(['chat_1']);
 const reads=f.reads();for(const q of ['',' '.repeat(2),'x'.repeat(201),'a\u0000b'])await expect(f.search.read('phone','owned',q,undefined,signal())).rejects.toMatchObject({status:400});
 await expect(f.search.read('phone','owned','home','../proxy',signal())).rejects.toMatchObject({status:400});expect(f.reads()).toBe(reads);
});
test('foreign rows and looping native cursors fail closed, and an aborted read performs no request',async()=>{
 const foreign=new SessionSearch(async()=>({data:[row(1,'Homepage','foreign')],cursor:null}));await expect(foreign.read('phone','owned','home',undefined,signal())).rejects.toMatchObject({code:'INVALID_UPSTREAM'});
 const loop=new SessionSearch(async()=>({data:[row(1)],cursor:'same'}));await expect(loop.read('phone','owned','home',undefined,signal())).rejects.toMatchObject({code:'INVALID_UPSTREAM'});
 const f=fixture(10),c=new AbortController();c.abort();await expect(f.search.read('phone','owned','home',undefined,c.signal)).rejects.toBeDefined();expect(f.reads()).toBe(0);
});
test('normalizes Unicode compatibility/case without claiming message-content search',async()=>{
 const search=new SessionSearch(async()=>({data:[row(1,'ＨＯＭＥpage')],cursor:null}));expect((await search.read('phone','owned','home',undefined,signal())).data).toHaveLength(1);
});
