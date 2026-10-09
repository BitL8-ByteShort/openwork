import {test,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {createServers} from '../src/server.js';import {Store} from '../src/storage/store.js';import {Pairing} from '../src/auth/pairing.js';import {OpenWorkV2} from '../src/adapters/openwork-v2-01857.js';import {BridgeError,PreflightError,assertContract} from '../src/contract/index.js';
class Fixture extends OpenWorkV2 {
 gone=false;writes=0;lose=false;wait?:()=>Promise<void>;
 constructor(){super(async()=>{throw Error('No live upstream');});this.capabilities.forkSession=true;this.capabilities.deleteSession=true;}
 override async listWorkspaces(){return [{id:'owned',name:'Synthetic'}];}
 override async readSessionActions(){await this.wait?.();if(this.gone)throw new BridgeError('NOT_FOUND',404);return {revision:'a'.repeat(64),title:'Synthetic',running:false,forkAvailable:true,deleteAvailable:true,deleteReason:null};}
 override async forkSession(){if(this.gone)throw new PreflightError('NOT_FOUND',404);this.writes++;if(this.lose)throw new BridgeError('UPSTREAM_UNAVAILABLE',503);return 'child';}
 override async deleteSession(){if(this.gone)throw new PreflightError('NOT_FOUND',404);this.writes++;this.gone=true;if(this.lose)throw new BridgeError('UPSTREAM_UNAVAILABLE',503);return 'chat';}
}
const base='/v1/workspaces/owned/sessions/chat',uuid='00000000-0000-4000-8000-000000000001',revision='a'.repeat(64);
async function fixture(run:(f:{adapter:Fixture;store:Store;apps:ReturnType<typeof createServers>;headers:{authorization:string}})=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'action-routes-')),store=await Store.open(join(root,'state'));
 await store.update(s=>s.devices.push({id:'device',deviceId:'phone',name:'Synthetic',tokenHash:createHash('sha256').update('synthetic').digest('hex'),workspaceIds:['owned'],active:true,revoked:false,features:{fileTransfer:false,workspaceAdministration:false,automationManagement:false}}));
 const adapter=new Fixture(),apps=createServers({store,pairing:new Pairing(store),adapter,origin:'https://fixture.test',platform:'linux',architecture:'x64'});
 try{await run({adapter,store,apps,headers:{authorization:'Bearer synthetic'}});}finally{await apps.remote.close();await apps.admin.close();await store.close();await rm(root,{recursive:true,force:true});}
}
test('actions require token, approved workspace and qualified capabilities without expanding grants',()=>fixture(async f=>{
 expect((await f.apps.remote.inject({url:base+'/actions'})).statusCode).toBe(401);
 expect((await f.apps.remote.inject({url:base.replace('/owned/','/foreign/')+'/actions',headers:f.headers})).statusCode).toBe(403);
 const r=await f.apps.remote.inject({url:base+'/actions',headers:f.headers});expect(r.statusCode).toBe(200);expect(()=>assertContract('SessionActionPreview',r.json().data)).not.toThrow();
 f.adapter.capabilities.deleteSession=false;expect((await f.apps.remote.inject({url:base+'/actions',headers:f.headers})).statusCode).toBe(422);expect(f.adapter.writes).toBe(0);
}));
test('delete replay succeeds after disappearance but never after access is revoked',()=>fixture(async f=>{
 const input={method:'POST' as const,url:base+'/delete',headers:f.headers,payload:{requestId:uuid,revision}};
 const first=await f.apps.remote.inject(input),second=await f.apps.remote.inject(input);expect(first.json().data).toMatchObject({state:'accepted',resourceId:'chat'});expect(second.json()).toEqual(first.json());expect(f.adapter.writes).toBe(1);
 expect((await f.apps.remote.inject({url:base+'/actions',headers:f.headers})).statusCode).toBe(404);
 await f.store.update(s=>{s.devices[0]!.workspaceIds=[];});expect((await f.apps.remote.inject(input)).statusCode).toBe(403);
}));
test('lost fork or delete returns one durable unknown outcome, never a second native action',()=>fixture(async f=>{
 f.adapter.lose=true;
 for(const kind of ['fork','delete']){
  const input={method:'POST' as const,url:base+'/'+kind,headers:f.headers,payload:{requestId:kind==='fork'?uuid:uuid.slice(0,-1)+'2',revision,...(kind==='fork'?{beforeMessageId:null}:{})}};
  const first=await f.apps.remote.inject(input),second=await f.apps.remote.inject(input);expect(first.json().data.state).toBe('outcome_unknown');expect(second.json()).toEqual(first.json());
 }
 expect(f.adapter.writes).toBe(2);
}));
test('receipts are bound to route, target, body and device',()=>fixture(async f=>{
 const input={method:'POST' as const,url:base+'/fork',headers:f.headers,payload:{requestId:uuid,revision,beforeMessageId:null}};expect((await f.apps.remote.inject(input)).statusCode).toBe(200);
 for(const changed of [{url:base+'/delete',payload:{requestId:uuid,revision}},{url:base.replace('/chat','/other')+'/fork'},{payload:{requestId:uuid,revision,beforeMessageId:'other'}}])expect((await f.apps.remote.inject({...input,...changed})).statusCode).toBe(409);
 await f.store.update(s=>s.devices.push({...s.devices[0]!,id:'second',tokenHash:createHash('sha256').update('second').digest('hex')}));
 expect((await f.apps.remote.inject({...input,headers:{authorization:'Bearer second'}})).statusCode).toBe(200);expect(f.adapter.writes).toBe(2);
}));
test('closed bodies and query fields reject without writes or proxy-like behavior',()=>fixture(async f=>{
 for(const [url,payload] of [[base+'/fork',{requestId:uuid,revision,beforeMessageId:null,url:'http://foreign'}],[base+'/delete',{requestId:uuid,revision,path:'/foreign'}],[base+'/fork?url=foreign',{requestId:uuid,revision,beforeMessageId:null}],[base+'/fork',{requestId:uuid,revision,beforeMessageId:'../foreign'}]] as const)expect((await f.apps.remote.inject({method:'POST',url,headers:f.headers,payload})).statusCode).toBe(400);
 expect(f.adapter.writes).toBe(0);
}));
test('a late preview after project revocation returns no metadata',()=>fixture(async f=>{
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r;});f.adapter.wait=async()=>{entered();await new Promise<void>(r=>{release=r;});};
 const read=f.apps.remote.inject({url:base+'/actions',headers:f.headers});await started;await f.store.update(s=>{s.devices[0]!.workspaceIds=[];});release();expect((await read).statusCode).toBe(403);
}));
