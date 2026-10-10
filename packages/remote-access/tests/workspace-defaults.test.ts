import {test,expect} from 'vitest';
import {NativeWorkspaceDefaults} from '../src/adapters/workspace-defaults.js';
const selection={providerId:'synthetic',modelId:'a',variant:null},signal=()=>new AbortController().signal;
function fixture(){
 let current={providerID:'synthetic',modelID:'a'},revision='a'.repeat(64),writes=0;const chats=[{id:'existing',model:'a'}];
 const adapter=new NativeWorkspaceDefaults(async(_wid)=>({model:current,revision,conditionalWrite:true}),async()=>({data:[{providerID:'synthetic',id:'a',name:'A',enabled:true,variants:[]},{providerID:'synthetic',id:'b',name:'B',enabled:true,variants:[{id:'high'}]}]}),async(_wid,body)=>{if(body.revision!==revision)throw Error('Native CAS should reject');writes++;current=body.model;revision='b'.repeat(64);return {model:current,revision,conditionalWrite:true}});
 return {adapter,chats,writes:()=>writes,race:()=>{revision='c'.repeat(64)},newChat:()=>({model:current.modelID}),snapshot:()=>current};
}
test('new chats use changed defaults while existing chat models remain unchanged',async()=>{
 const f=fixture(),before=await f.adapter.read('owned',signal());await f.adapter.set('owned',{...selection,modelId:'b',variant:'high'},before.revision,signal());expect(f.newChat().model).toBe('b');expect(f.chats).toEqual([{id:'existing',model:'a'}]);expect(f.writes()).toBe(1);
});
test('stale defaults and invalid model/variant never dispatch a write',async()=>{
 for(const mode of ['stale','variant','model']){const f=fixture(),before=await f.adapter.read('owned',signal());if(mode==='stale')f.race();await expect(f.adapter.set('owned',{...selection,modelId:mode==='model'?'foreign':'b',variant:mode==='variant'?'invalid':null},before.revision,signal())).rejects.toBeDefined();expect(f.writes()).toBe(0)}
});
test('unextended native API and foreign/unsafe workspace IDs cannot write',async()=>{
 const old=new NativeWorkspaceDefaults(async()=>({model:null,updatedAt:null}),async()=>({data:[]}),async()=>{throw Error('Never write')});await expect(old.read('owned',signal())).rejects.toMatchObject({code:'UNSUPPORTED_ACTION'});
 const f=fixture();await expect(f.adapter.read('../foreign',signal())).rejects.toMatchObject({status:400});const c=new AbortController();c.abort();await expect(f.adapter.read('owned',c.signal)).rejects.toBeDefined();expect(f.writes()).toBe(0);
});
test('a lost write is not retried',async()=>{
 let writes=0;const lost=new NativeWorkspaceDefaults(async()=>({model:{providerID:'synthetic',modelID:'a'},revision:'a'.repeat(64),conditionalWrite:true}),async()=>({data:[{providerID:'synthetic',id:'b',enabled:true,variants:[]}]}),async()=>{writes++;throw Error('Response lost')});await expect(lost.set('owned',{...selection,modelId:'b'},'a'.repeat(64),signal())).rejects.toBeDefined();expect(writes).toBe(1);
});

test('an intervening post-write desktop change is uncertain, not a confirmed phone save',async()=>{
 let revision='a'.repeat(64),writes=0;const adapter=new NativeWorkspaceDefaults(async()=>({model:{providerID:'synthetic',modelID:'a'},revision,conditionalWrite:true}),async()=>({data:[{providerID:'synthetic',id:'b',enabled:true,variants:[]}]}),async(_wid,body)=>{writes++;revision='c'.repeat(64);return {model:body.model,revision:'b'.repeat(64),conditionalWrite:true}});
 await expect(adapter.set('owned',{...selection,modelId:'b'},'a'.repeat(64),signal())).rejects.toMatchObject({code:'OUTCOME_UNKNOWN'});expect(writes).toBe(1);
});
