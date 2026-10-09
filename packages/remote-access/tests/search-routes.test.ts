import type {Session} from '../src/contract/index.js';
import {test,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {createServers} from '../src/server.js';import {Store} from '../src/storage/store.js';import {Pairing} from '../src/auth/pairing.js';import {OpenWorkV2} from '../src/adapters/openwork-v2-01857.js';
class Fixture extends OpenWorkV2 {
 reads=0;wait?:()=>Promise<void>;
 constructor(){super(async()=>{throw Error('No live upstream')});this.capabilities.searchSessions=true;}
 override async listWorkspaces(){return [{id:'owned',name:'Synthetic'}];}
 override async listSessions(wid:string,cursor?:string):Promise<{data:Session[];cursor:string|null}>{this.reads++;await this.wait?.();const start=Number(cursor??0);return {data:Array.from({length:50},(_,n)=>({id:'chat_'+(start+n),workspaceId:wid,title:start+n===575?'Homepage':'Other',updatedAt:'2026-10-09T00:00:00.000Z',modelLabel:null,status:'idle'})),cursor:start+50<600?String(start+50):null};}
}
async function fixture(run:(f:{adapter:Fixture;store:Store;apps:ReturnType<typeof createServers>;headers:{authorization:string}})=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'search-routes-')),store=await Store.open(join(root,'state'));
 await store.update(s=>s.devices.push({id:'device',deviceId:'phone',name:'Synthetic',tokenHash:createHash('sha256').update('synthetic').digest('hex'),workspaceIds:['owned'],active:true,revoked:false,features:{fileTransfer:false,workspaceAdministration:false,automationManagement:false}}));
 const adapter=new Fixture(),apps=createServers({store,pairing:new Pairing(store),adapter,origin:'https://fixture.test',platform:'linux',architecture:'x64'});
 try{await run({adapter,store,apps,headers:{authorization:'Bearer synthetic'}});}finally{await apps.remote.close();await apps.admin.close();await store.close();await rm(root,{recursive:true,force:true});}
}
const base='/v1/workspaces/owned/sessions/search';
test('title search requires approved project/token/capability and no additional grant',()=>fixture(async f=>{
 expect((await f.apps.remote.inject({url:base+'?q=home'})).statusCode).toBe(401);
 expect((await f.apps.remote.inject({url:base.replace('/owned/','/foreign/')+'?q=home',headers:f.headers})).statusCode).toBe(403);
 const first=await f.apps.remote.inject({url:base+'?q=home',headers:f.headers});expect(first.statusCode).toBe(200);expect(first.json().data).toMatchObject({data:[],scanned:500,complete:false});
 const last=await f.apps.remote.inject({url:base+'?q=home&cursor='+first.json().data.cursor,headers:f.headers});expect(last.json().data).toMatchObject({data:[{id:'chat_575'}],scanned:100,complete:true,cursor:null});
 f.adapter.capabilities.searchSessions=false;const count=f.adapter.reads;expect((await f.apps.remote.inject({url:base+'?q=home',headers:f.headers})).statusCode).toBe(422);expect(f.adapter.reads).toBe(count);
}));
test('closed query and opaque cursors never pass arbitrary native URLs, paths or query keys',()=>fixture(async f=>{
 for(const q of ['','q=a&q=b','q=home&url=http://foreign','q=home&cursor=native','q=home&path=/foreign','q='+ 'x'.repeat(201)])expect((await f.apps.remote.inject({url:base+'?'+q,headers:f.headers})).statusCode).toBe(400);
 expect(f.adapter.reads).toBe(0);
}));
test('search continuation is device-bound and project revocation prevents reuse',()=>fixture(async f=>{
 const first=await f.apps.remote.inject({url:base+'?q=home',headers:f.headers}),next=base+'?q=home&cursor='+first.json().data.cursor;
 await f.store.update(s=>s.devices.push({...s.devices[0]!,id:'second',tokenHash:createHash('sha256').update('second').digest('hex')}));
 expect((await f.apps.remote.inject({url:next,headers:{authorization:'Bearer second'}})).statusCode).toBe(409);
 await f.store.update(s=>{s.devices[0]!.workspaceIds=[]});expect((await f.apps.remote.inject({url:next,headers:f.headers})).statusCode).toBe(403);
}));
test('late native search after revocation returns no metadata',()=>fixture(async f=>{
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r});f.adapter.wait=async()=>{entered();await new Promise<void>(r=>{release=r})};
 const read=f.apps.remote.inject({url:base+'?q=home',headers:f.headers});await started;await f.store.update(s=>{s.devices[0]!.workspaceIds=[]});release();expect((await read).statusCode).toBe(403);
}));
