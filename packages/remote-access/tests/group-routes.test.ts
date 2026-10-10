import {test,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {createServers} from '../src/server.js';import {Store} from '../src/storage/store.js';import {Pairing} from '../src/auth/pairing.js';import {OpenWorkV2} from '../src/adapters/openwork-v2-01857.js';import {BridgeError,PreflightError,assertContract} from '../src/contract/index.js';
import {NativeSessionGroups,type GroupCommand} from '../src/adapters/session-groups.js';
class FixtureAdapter extends OpenWorkV2 {
 groups={groups:[{id:'first',label:'First'}],assignments:{} as Record<string,string>};writes=0;lose=false;wait?:()=>Promise<void>;
 native=new NativeSessionGroups(async(_route,method='GET',body)=>{
  if(method==='GET')await this.wait?.();else {this.writes++;if(method==='DELETE')this.groups.groups=[];else if(method==='POST'){const b=body as {id:string;label:string};this.groups.groups.push(b);}if(this.lose)throw new BridgeError('UPSTREAM_UNAVAILABLE',503);}
  return structuredClone({state:this.groups});
 },async(_wid,sid)=>{if(sid!=='chat')throw new PreflightError('NOT_FOUND',404);});
 constructor(){super(async()=>{throw Error('No live upstream');});this.capabilities.sessionGroups=true;}
 override async listWorkspaces(){return [{id:'owned',name:'Synthetic'}];}
 async readSessionGroups(wid:string,signal:AbortSignal){return this.native.read(wid,signal);}
 async changeSessionGroup(wid:string,command:GroupCommand,revision:string,signal:AbortSignal){return this.native.apply(wid,command,revision,signal);}
}
const base='/v1/workspaces/owned/session-groups',uuid='00000000-0000-4000-8000-000000000001';
async function fixture(run:(f:{adapter:FixtureAdapter;store:Store;apps:ReturnType<typeof createServers>;headers:{authorization:string}})=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'group-routes-')),store=await Store.open(join(root,'state'));await store.update(s=>s.devices.push({id:'device',deviceId:'phone',name:'Synthetic',tokenHash:createHash('sha256').update('synthetic').digest('hex'),workspaceIds:['owned'],active:true,revoked:false,features:{fileTransfer:false,workspaceAdministration:true,automationManagement:false}}));
 const adapter=new FixtureAdapter(),apps=createServers({store,pairing:new Pairing(store),adapter,origin:'https://fixture.test',platform:'linux',architecture:'x64'});
 try{await run({adapter,store,apps,headers:{authorization:'Bearer synthetic'}});}finally{await apps.remote.close();await apps.admin.close();await store.close();await rm(root,{recursive:true,force:true});}
}
test('group list is closed and requires token, workspace, capability and current approved project scope',()=>fixture(async f=>{
 expect((await f.apps.remote.inject({url:base})).statusCode).toBe(401);
 expect((await f.apps.remote.inject({url:base.replace('/owned/','/foreign/'),headers:f.headers})).statusCode).toBe(403);
 const result=await f.apps.remote.inject({url:base,headers:f.headers});expect(result.statusCode).toBe(200);expect(()=>assertContract('GroupSnapshot',result.json().data)).not.toThrow();
 await f.store.update(s=>{s.devices[0]!.workspaceIds=[];});expect((await f.apps.remote.inject({url:base,headers:f.headers})).statusCode).toBe(403);f.adapter.capabilities.sessionGroups=false;expect((await f.apps.remote.inject({url:base,headers:f.headers})).statusCode).toBe(422);
}));
test('duplicate remove replays a scoped receipt after the group disappears without a second native write',()=>fixture(async f=>{
 const revision=(await f.apps.remote.inject({url:base,headers:f.headers})).json().data.revision,payload={requestId:uuid,revision};
 const input={method:'POST' as const,url:base+'/first/remove',headers:f.headers,payload};const first=await f.apps.remote.inject(input),second=await f.apps.remote.inject(input);
 expect(first.statusCode).toBe(200);expect(first.json().data.state).toBe('accepted');expect(second.json()).toEqual(first.json());expect(f.adapter.writes).toBe(1);
 await f.store.update(s=>{s.devices[0]!.workspaceIds=[];});expect((await f.apps.remote.inject(input)).statusCode).toBe(403);
}));
test('lost native create outcome remains uncertain and a replay never creates another group',()=>fixture(async f=>{
 const revision=(await f.apps.remote.inject({url:base,headers:f.headers})).json().data.revision;f.adapter.lose=true;
 const input={method:'POST' as const,url:base,headers:f.headers,payload:{requestId:uuid,revision,label:'New group'}};
 const first=await f.apps.remote.inject(input),second=await f.apps.remote.inject(input);expect(first.json().data.state).toBe('outcome_unknown');expect(second.json()).toEqual(first.json());expect(f.adapter.writes).toBe(1);expect(f.adapter.groups.groups).toHaveLength(2);
}));
test('closed mutation fields and foreign assignments reject without group writes',()=>fixture(async f=>{
 const revision=(await f.apps.remote.inject({url:base,headers:f.headers})).json().data.revision;
 for(const [url,payload] of [[base,{requestId:uuid,revision,label:'Name',state:{groups:[]}}],[base+'/reorder',{requestId:'00000000-0000-4000-8000-000000000002',revision,groupIds:['first','first']}],[base+'/assignments/foreign',{requestId:'00000000-0000-4000-8000-000000000003',revision,groupId:'first'}]] as const){const r=await f.apps.remote.inject({method:'POST',url,headers:f.headers,payload});expect([400,404]).toContain(r.statusCode);}
 expect(f.adapter.writes).toBe(0);
}));
test('late group reads after project revocation cannot return metadata',()=>fixture(async f=>{
 let release!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>{entered=r;});f.adapter.wait=async()=>{entered();await new Promise<void>(r=>{release=r;});};
 const pending=f.apps.remote.inject({url:base,headers:f.headers});await started;await f.store.update(s=>{s.devices[0]!.workspaceIds=[];});release();expect((await pending).statusCode).toBe(403);
}));
