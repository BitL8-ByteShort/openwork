import {test,expect} from 'vitest';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {createServers} from '../src/server.js';import {Store} from '../src/storage/store.js';import {Pairing} from '../src/auth/pairing.js';import {OpenWorkV2} from '../src/adapters/openwork-v2-01857.js';import {BridgeError,PreflightError,type SkillSave} from '../src/contract/index.js';
const id='skill_'+'a'.repeat(64),revision='b'.repeat(64),uuid='00000000-0000-4000-8000-000000000001',base='/v1/workspaces/owned/skills';
class Fixture extends OpenWorkV2 {
 reads=0;writes=0;lost=false;denied=false;wait?:()=>Promise<void>;
 item={id,name:'owned-skill',description:'Synthetic',source:'workspace' as const,editable:true,selectable:true,revision};
 constructor(){super(async()=>{throw Error('No real upstream')});this.capabilities.skillsRead=true;this.capabilities.skillsWrite=true}
 override async listWorkspaces(){return [{id:'owned',name:'Synthetic'}]}
 override async readSkills(){this.reads++;return {items:[this.item],revision}}
 override async readSkill(_wid:string,target:string){this.reads++;if(target!==id)throw new PreflightError('NOT_FOUND',404);return {item:this.item,content:'Instructions'}}
 override async saveSkill(_wid:string,_input:SkillSave,_signal:AbortSignal,check=()=>{}){await this.wait?.();check();if(this.denied)throw new PreflightError('SKILL_WRITE_DENIED',422);this.writes++;if(this.lost)throw new BridgeError('OUTCOME_UNKNOWN',502);return {resourceId:id,resourceRevision:revision}}
 override async deleteSkill(){this.writes++;return id}
}
async function fixture(run:(f:{a:Fixture;s:Store;apps:ReturnType<typeof createServers>;headers:{authorization:string}})=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'skill-routes-')),s=await Store.open(join(root,'state'));await s.update(v=>v.devices.push({id:'device',deviceId:'phone',name:'Synthetic',tokenHash:createHash('sha256').update('synthetic').digest('hex'),workspaceIds:['owned'],active:true,revoked:false,features:{fileTransfer:false,workspaceAdministration:false,automationManagement:false}}));const a=new Fixture(),apps=createServers({store:s,pairing:new Pairing(s),adapter:a,origin:'https://fixture.test',platform:'linux',architecture:'x64'});try{await run({a,s,apps,headers:{authorization:'Bearer synthetic'}})}finally{await apps.remote.close();await apps.admin.close();await s.close();await rm(root,{recursive:true,force:true})}}
const payload={requestId:uuid,name:'owned-skill',content:'Instructions',revision,catalogRevision:revision};
test('skill reads require project access; writes independently require the host administration grant',()=>fixture(async f=>{
 expect((await f.apps.remote.inject({url:base})).statusCode).toBe(401);expect((await f.apps.remote.inject({url:base.replace('owned','foreign'),headers:f.headers})).statusCode).toBe(403);
 expect((await f.apps.remote.inject({url:base,headers:f.headers})).statusCode).toBe(200);expect((await f.apps.remote.inject({url:base+'/save',method:'POST',headers:f.headers,payload})).statusCode).toBe(403);expect(f.a.writes).toBe(0);
}));
test('stable skill receipts replay one write and stay grant-gated; lost writes never retry',()=>fixture(async f=>{
 await f.s.update(v=>{v.devices[0]!.features!.workspaceAdministration=true});f.a.lost=true;const input={url:base+'/save',method:'POST' as const,headers:f.headers,payload};const first=await f.apps.remote.inject(input),again=await f.apps.remote.inject(input);expect(first.json().data.state).toBe('outcome_unknown');expect(again.json()).toEqual(first.json());expect(f.a.writes).toBe(1);
 await f.s.update(v=>{v.devices[0]!.features!.workspaceAdministration=false});expect((await f.apps.remote.inject(input)).statusCode).toBe(403);
}));
test('native policy denial is a known rejection and never an installed skill',()=>fixture(async f=>{
 await f.s.update(v=>{v.devices[0]!.features!.workspaceAdministration=true});f.a.denied=true;expect((await f.apps.remote.inject({url:base+'/save',method:'POST',headers:f.headers,payload})).statusCode).toBe(422);expect(f.a.writes).toBe(0);expect(Object.values(f.s.snapshot.ledger)[0]?.receipt.state).toBe('rejected');
}));
test('revocation during native preflight and path-like/extra fields cannot write',()=>fixture(async f=>{
 await f.s.update(v=>{v.devices[0]!.features!.workspaceAdministration=true});
 for(const b of [{...payload,name:'../unsafe'},{...payload,path:'/private'},{...payload,content:''}])expect((await f.apps.remote.inject({url:base+'/save',method:'POST',headers:f.headers,payload:b})).statusCode).toBe(400);
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r});f.a.wait=async()=>{entered();await new Promise<void>(r=>{release=r})};const p=f.apps.remote.inject({url:base+'/save',method:'POST',headers:f.headers,payload});await started;await f.s.update(v=>{v.devices[0]!.features!.workspaceAdministration=false});release();expect((await p).statusCode).toBe(403);expect(f.a.writes).toBe(0);
}));
