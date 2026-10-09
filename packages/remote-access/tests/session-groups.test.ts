import {test,expect} from 'vitest';
import {NativeSessionGroups,type GroupCommand} from '../src/adapters/session-groups.js';
import {PreflightError} from '../src/contract/index.js';

function fixture() {
  const state={groups:[{id:'first',label:'First'},{id:'second',label:'Second'}],assignments:{chat:'first'} as Record<string,string>};
  const calls:{route:string;method:string;body:unknown}[]=[];
  let beforeWrite:(()=>void)|undefined;
  const adapter=new NativeSessionGroups(async (route,method='GET',body?:unknown)=>{
    calls.push({route,method,body});
    if(method!=='GET'){beforeWrite?.();beforeWrite=undefined;
      const b=body as Record<string,unknown>;
      if(method==='POST')state.groups.push({id:b.id as string,label:b.label as string});
      else if(route.endsWith('/reorder'))state.groups.sort((a,b)=>((body as {groupIds:string[]}).groupIds.indexOf(a.id)-(body as {groupIds:string[]}).groupIds.indexOf(b.id)));
      else if(route.includes('/assignments/')){if(b.groupId===null)delete state.assignments.chat;else state.assignments.chat=b.groupId as string;}
      else {const id=route.split('/').at(-1)!;if(method==='DELETE'){state.groups=state.groups.filter(g=>g.id!==id);for(const sid of Object.keys(state.assignments))if(state.assignments[sid]===id)delete state.assignments[sid];}
        else state.groups=state.groups.map(g=>g.id===id?{...g,label:b.label as string}:g);}
    }
    return structuredClone({state,updatedAt:17});
  },async (_wid,sid)=>{if(sid!=='chat')throw new PreflightError('NOT_FOUND',404);});
  return {adapter,state,calls,race:(f:()=>void)=>{beforeWrite=f;},writes:()=>calls.filter(c=>c.method!=='GET')};
}
const signal=()=>new AbortController().signal;
async function apply(f:ReturnType<typeof fixture>,command:GroupCommand){const current=await f.adapter.read('owned',signal());return f.adapter.apply('owned',command,current.revision,signal());}

test('removeGroupPreservesChats and missingGroupBecomesUngrouped without a session delete or full-state PUT',async()=>{
 const f=fixture();await apply(f,{action:'remove',groupId:'first'});expect(f.state.groups.map(g=>g.id)).toEqual(['second']);expect(f.state.assignments.chat).toBeUndefined();
 expect(f.writes()).toEqual([{route:'/workspace/owned/session-groups/first',method:'DELETE',body:undefined}]);expect(f.calls.some(c=>c.method==='PUT'||c.route.includes('/api/session'))).toBe(false);
});
test('foreignSessionRejected before assignment and without group writes',async()=>{
 const f=fixture();await expect(apply(f,{action:'assign',sessionId:'foreign',groupId:'first'})).rejects.toMatchObject({status:404});expect(f.writes()).toHaveLength(0);
});
test('duplicateReorderIDsRejected and partial reorder lists are refused',async()=>{
 for(const groupIds of [['first','first'],['first'],['first','foreign']]){const f=fixture();await expect(apply(f,{action:'reorder',groupIds})).rejects.toMatchObject({status:400});expect(f.writes()).toHaveLength(0);}
});
test('staleRenameRefreshes instead of changing the native label',async()=>{
 const f=fixture(),before=await f.adapter.read('owned',signal());f.state.groups[0]!.label='Desktop renamed';await expect(f.adapter.apply('owned',{action:'rename',groupId:'first',label:'Phone renamed'},before.revision,signal())).rejects.toMatchObject({code:'GROUPS_CHANGED',status:409});expect(f.writes()).toHaveLength(0);
});
test('concurrentDesktopAssignmentPreserved by granular rename and reordered groups retain assignments',async()=>{
 const f=fixture();f.race(()=>{f.state.assignments.other='second';});await apply(f,{action:'rename',groupId:'first',label:' Renamed '});expect(f.state.assignments).toEqual({chat:'first',other:'second'});expect(f.state.groups[0]!.label).toBe('Renamed');await apply(f,{action:'reorder',groupIds:['second','first']});expect(f.state.groups.map(g=>g.id)).toEqual(['second','first']);expect(f.state.assignments.other).toBe('second');
});
test('create uses a caller-bound opaque ID and assignment/unassignment read back their own target',async()=>{
 const f=fixture();expect(await apply(f,{action:'create',groupId:'grp_remote_uuid',label:'Third'})).toBe('grp_remote_uuid');await apply(f,{action:'assign',sessionId:'chat',groupId:'grp_remote_uuid'});expect(f.state.assignments.chat).toBe('grp_remote_uuid');await apply(f,{action:'assign',sessionId:'chat',groupId:null});expect(f.state.assignments.chat).toBeUndefined();
});
test('group label scalar/native UTF16 limits prevent native truncation and unsafe labels',async()=>{
 for(const label of ['', ' '.repeat(3),'x'.repeat(101),'😀'.repeat(61),'A\nB','A\u202eB']){const f=fixture();await expect(apply(f,{action:'create',groupId:'third',label})).rejects.toMatchObject({status:400});expect(f.writes()).toHaveLength(0);}
 const f=fixture();await apply(f,{action:'create',groupId:'third',label:'😀'.repeat(60)});expect(f.state.groups.at(-1)!.label).toBe('😀'.repeat(60));
});
test('more than 100 groups or duplicate/unreferenced native assignments fail closed',async()=>{
 for(const mutate of [(f:ReturnType<typeof fixture>)=>{f.state.groups=Array.from({length:101},(_,n)=>({id:'g'+n,label:'Group'}));},(f:ReturnType<typeof fixture>)=>{f.state.groups[1]!.id='first';},(f:ReturnType<typeof fixture>)=>{f.state.assignments.chat='missing';}]){const f=fixture();mutate(f);await expect(f.adapter.read('owned',signal())).rejects.toBeDefined();expect(f.writes()).toHaveLength(0);}
});
test('cancelled operations and unsafe target IDs never dispatch native writes',async()=>{
 const f=fixture(),controller=new AbortController();controller.abort();await expect(f.adapter.read('owned',controller.signal)).rejects.toBeDefined();expect(f.calls).toHaveLength(0);await expect(f.adapter.read('../foreign',signal())).rejects.toBeDefined();expect(f.calls).toHaveLength(0);
});
