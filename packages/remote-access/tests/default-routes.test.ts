import {test,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {createServers} from '../src/server.js';import {Store} from '../src/storage/store.js';import {Pairing} from '../src/auth/pairing.js';import {OpenWorkV2} from '../src/adapters/openwork-v2-01857.js';import {BridgeError,PreflightError,assertContract} from '../src/contract/index.js';
import {NativeWorkspaceDefaults} from '../src/adapters/workspace-defaults.js';
class FixtureAdapter extends OpenWorkV2 {
 model={providerID:'synthetic',modelID:'a'};revision='a'.repeat(64);writes=0;lose=false;wait?:()=>Promise<void>;
 constructor(){super(async()=>{throw Error('No live upstream');});this.capabilities.workspaceDefaults=true;}
 private defaults(check=()=>{}){return new NativeWorkspaceDefaults(async()=>{check();return {model:this.model,revision:this.revision,conditionalWrite:true}},async()=>{await this.wait?.();check();return {data:[{providerID:'synthetic',id:'a',enabled:true,variants:[]},{providerID:'synthetic',id:'b',enabled:true,variants:[]}]}},async(_wid,body)=>{check();if(body.revision!==this.revision)throw new PreflightError('STALE_SETTINGS',409);this.writes++;this.model=body.model;this.revision='b'.repeat(64);if(this.lose)throw new BridgeError('UPSTREAM_UNAVAILABLE',503);return {model:this.model,revision:this.revision,conditionalWrite:true}})}
 override async listWorkspaces(){return [{id:'owned',name:'Synthetic'}];}
 async readWorkspaceDefaults(wid:string,signal:AbortSignal,check=()=>{}){return this.defaults(check).read(wid,signal);}
 async setWorkspaceDefaults(wid:string,selection:any,revision:string,signal:AbortSignal,check=()=>{}){return this.defaults(check).set(wid,selection,revision,signal);}
}
const base='/v1/workspaces/owned/default-model',uuid='00000000-0000-4000-8000-000000000001',selection={providerId:'synthetic',modelId:'b',variant:null};
async function fixture(run:(f:{adapter:FixtureAdapter;store:Store;apps:ReturnType<typeof createServers>;headers:{authorization:string}})=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'default-routes-')),store=await Store.open(join(root,'state'));await store.update(s=>s.devices.push({id:'device',deviceId:'phone',name:'Synthetic',tokenHash:createHash('sha256').update('synthetic').digest('hex'),workspaceIds:['owned'],active:true,revoked:false,features:{fileTransfer:false,workspaceAdministration:true,automationManagement:false}}));
 const adapter=new FixtureAdapter(),apps=createServers({store,pairing:new Pairing(store),adapter,origin:'https://fixture.test',platform:'linux',architecture:'x64'});
 try{await run({adapter,store,apps,headers:{authorization:'Bearer synthetic'}});}finally{await apps.remote.close();await apps.admin.close();await store.close();await rm(root,{recursive:true,force:true});}
}
test('defaults require token, capability, project scope and administration grant before reading/writing',()=>fixture(async f=>{
 expect((await f.apps.remote.inject({url:base})).statusCode).toBe(401);expect((await f.apps.remote.inject({url:base.replace('/owned/','/foreign/'),headers:f.headers})).statusCode).toBe(403);
 const result=await f.apps.remote.inject({url:base,headers:f.headers});expect(result.statusCode).toBe(200);assertContract('WorkspaceDefaults',result.json().data);
 await f.store.update(s=>{s.devices[0]!.features!.workspaceAdministration=false});
 for(const method of ['GET','POST'] as const)expect((await f.apps.remote.inject({url:base,method,headers:f.headers,...(method==='POST'?{payload:{requestId:uuid,selection,revision:f.adapter.revision}}:{})})).statusCode).toBe(403);
 expect(f.adapter.writes).toBe(0);f.adapter.capabilities.workspaceDefaults=false;expect((await f.apps.remote.inject({url:base,headers:f.headers})).statusCode).toBe(422);
}));
test('one UUID replays the exact default write without a second PUT and remains grant-gated',()=>fixture(async f=>{
 const input={method:'POST' as const,url:base,headers:f.headers,payload:{requestId:uuid,selection,revision:f.adapter.revision}};
 const first=await f.apps.remote.inject(input),again=await f.apps.remote.inject(input);expect(first.json().data.state).toBe('accepted');expect(first.json().data.resourceId).toBe('owned');expect(again.json()).toEqual(first.json());expect(f.adapter.writes).toBe(1);
 expect((await f.apps.remote.inject({...input,payload:{...input.payload,selection:{...selection,modelId:'a'}}})).statusCode).toBe(409);
 await f.store.update(s=>{s.devices[0]!.features!.workspaceAdministration=false});expect((await f.apps.remote.inject(input)).statusCode).toBe(403);
}));
test('lost response stays unknown and never triggers a second PUT on replay',()=>fixture(async f=>{
 f.adapter.lose=true;const input={method:'POST' as const,url:base,headers:f.headers,payload:{requestId:uuid,selection,revision:f.adapter.revision}};
 const first=await f.apps.remote.inject(input),again=await f.apps.remote.inject(input);expect(first.json().data.state).toBe('outcome_unknown');expect(again.json()).toEqual(first.json());expect(f.adapter.writes).toBe(1);
}));
test('closed fields, stale revision and invalid variants reject without changing any default',()=>fixture(async f=>{
 for(const [n,body,status] of [[1,{selection,revision:'c'.repeat(64)},409],[2,{selection:{...selection,variant:'invalid'},revision:f.adapter.revision},422],[3,{selection,revision:f.adapter.revision,model:{providerID:'foreign'}},400]] as const){expect((await f.apps.remote.inject({method:'POST',url:base,headers:f.headers,payload:{requestId:uuid.slice(0,-1)+n,...body}})).statusCode).toBe(status)}
 expect(f.adapter.writes).toBe(0);
}));
test('a revoked administration grant during catalog preflight prevents dispatch',()=>fixture(async f=>{
 let release!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>{entered=r});f.adapter.wait=async()=>{entered();await new Promise<void>(r=>{release=r})};
 const pending=f.apps.remote.inject({method:'POST',url:base,headers:f.headers,payload:{requestId:uuid,selection,revision:f.adapter.revision}});await started;await f.store.update(s=>{s.devices[0]!.features!.workspaceAdministration=false});release();expect((await pending).statusCode).toBe(403);expect(f.adapter.writes).toBe(0);
}));
