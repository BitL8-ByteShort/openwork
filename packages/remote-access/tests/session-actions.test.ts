import {test,expect} from 'vitest';
import {NativeSessionActions} from '../src/adapters/session-actions.js';
import {BridgeError} from '../src/contract/index.js';
function fixture(){
 const parent={id:'ses_parent',title:'Parent',model:{providerID:'synthetic',id:'model',variant:'high'},time:{created:1,updated:2},location:{directory:'/synthetic/project'}};
 const sessions=new Map([['ses_parent',structuredClone(parent)]]),calls:{route:string;method:string;body:unknown}[]=[];
 const state={running:false,linked:false,lose:false,denyAbsence:false,wrongModel:false,wrongSource:false,wrongBoundary:false,wrongParent:false};
 const adapter=new NativeSessionActions(async(route,method='GET',body)=>{
  calls.push({route,method,body});
  if(route.endsWith('/active'))return {data:state.running?{ses_parent:{type:'running'}}:{}};
  if(route.includes('/session?'))return {data:state.linked?[{id:'ses_child',parentID:'ses_parent'}]:[],cursor:{next:null}};
  if(route.split('?')[0]!.endsWith('/message'))return {data:[{id:'msg_first'},{id:'msg_last'}],cursor:{next:null}};
  const sid=route.split('/session/')[1]?.split('/')[0]!;
  if(method==='POST'){
   const child={...structuredClone(parent),id:'ses_child',fork:{sessionID:'ses_parent',boundary:(body as {boundary:unknown}).boundary}};if(state.wrongModel)child.model.id='other';sessions.set(child.id,child);
   if(state.wrongSource)child.fork.sessionID='foreign';if(state.wrongBoundary)child.fork.boundary={type:'before',messageID:'foreign'};if(state.wrongParent)(child as typeof child & {parentID?:string}).parentID='foreign';
   if(state.lose)throw new BridgeError('UPSTREAM_UNAVAILABLE',503);return {data:child};
  }
  if(method==='DELETE'){sessions.delete(sid);return null;}
  const s=sessions.get(sid);if(!s)throw new BridgeError('NOT_FOUND',404);return {data:structuredClone(s)};
 },async(_wid,sid)=>{if(state.denyAbsence)throw new BridgeError('FORBIDDEN',403);return !sessions.has(sid)});
 return {adapter,parent,sessions,state,calls,writes:()=>calls.filter(c=>c.method!=='GET')};
}
const signal=()=>new AbortController().signal;
test('native fork uses the installed through/before boundary and validates inherited model and native fork provenance',async()=>{
 for(const before of [null,'msg_last']){const f=fixture(),preview=await f.adapter.read('owned','ses_parent',signal());
  expect(await f.adapter.fork('owned','ses_parent',before,preview.revision,signal())).toBe('ses_child');
  expect(f.writes()[0]?.body).toEqual({boundary:before===null?{type:'through'}:{type:'before',messageID:before}});
  expect(f.sessions.get('ses_parent')).toEqual(f.parent);expect(f.sessions.get('ses_child')?.model).toEqual(f.parent.model);
 }
});
test('a foreign boundary, changed model/title, active chat or linked-chat deletion is rejected before a write',async()=>{
 for(const mode of ['boundary','model','title','active','linked']){const f=fixture(),preview=await f.adapter.read('owned','ses_parent',signal());
  if(mode==='model')f.sessions.get('ses_parent')!.model.id='changed';if(mode==='title')f.sessions.get('ses_parent')!.title='Changed';if(mode==='active')f.state.running=true;if(mode==='linked')f.state.linked=true;
  await expect(mode==='linked'?f.adapter.remove('owned','ses_parent',preview.revision,signal()):f.adapter.fork('owned','ses_parent',mode==='boundary'?'msg_foreign':null,preview.revision,signal())).rejects.toBeDefined();expect(f.writes()).toHaveLength(0);
 }
});
test('deletion confirms scoped absence while preserving unrelated chats and refusing forbidden absence reads',async()=>{
 const f=fixture(),preview=await f.adapter.read('owned','ses_parent',signal());f.sessions.set('unrelated',{...structuredClone(f.parent),id:'unrelated'});
 expect(await f.adapter.remove('owned','ses_parent',preview.revision,signal())).toBe('ses_parent');expect(f.sessions.has('unrelated')).toBe(true);
 const denied=fixture(),p=await denied.adapter.read('owned','ses_parent',signal());denied.state.denyAbsence=true;
 await expect(denied.adapter.remove('owned','ses_parent',p.revision,signal())).rejects.toMatchObject({status:403});
});
test('lost fork response and wrong inherited model remain unconfirmed without another fork',async()=>{
 for(const mode of ['loss','model','source','boundary','parent']){const f=fixture(),preview=await f.adapter.read('owned','ses_parent',signal());f.state.lose=mode==='loss';f.state.wrongModel=mode==='model';f.state.wrongSource=mode==='source';f.state.wrongBoundary=mode==='boundary';f.state.wrongParent=mode==='parent';
  await expect(f.adapter.fork('owned','ses_parent',null,preview.revision,signal())).rejects.toBeDefined();expect(f.writes()).toHaveLength(1);
 }
});
test('action IDs, scopes and cancellation never become arbitrary native routes',async()=>{
 const f=fixture(),c=new AbortController();c.abort();await expect(f.adapter.read('owned','ses_parent',c.signal)).rejects.toBeDefined();
 await expect(f.adapter.read('../foreign','ses_parent',signal())).rejects.toBeDefined();expect(f.calls).toHaveLength(0);
});
test('a newly created untitled chat can be removed before its first message',async()=>{
 for(const title of [undefined,null,'']){const f=fixture(),raw=f.sessions.get('ses_parent')! as unknown as Record<string,unknown>;if(title===undefined)delete raw.title;else raw.title=title;const p=await f.adapter.read('owned','ses_parent',signal());expect(p.title).toBe('Untitled chat');expect(await f.adapter.remove('owned','ses_parent',p.revision,signal())).toBe('ses_parent');expect(f.writes()).toHaveLength(1)}
});
test('a malformed non-text native title cannot authorize deletion',async()=>{
 const f=fixture();(f.sessions.get('ses_parent')! as unknown as Record<string,unknown>).title=13;await expect(f.adapter.read('owned','ses_parent',signal())).rejects.toMatchObject({code:'INVALID_UPSTREAM'});expect(f.writes()).toHaveLength(0);
});
