import {createHash} from 'node:crypto';
import {BridgeError,PreflightError,record} from '../contract/index.js';

export interface SessionActionPreview {
 revision:string;title:string;running:boolean;forkAvailable:boolean;deleteAvailable:boolean;
 deleteReason:'running'|'linkedChats'|null;
}
type NativeRequest=(route:string,method?:string,body?:unknown,signal?:AbortSignal)=>Promise<unknown>;
const id=(value:string)=>{if(!/^[A-Za-z0-9_-]{1,200}$/.test(value))throw new PreflightError('INVALID_REQUEST',400);return encodeURIComponent(value);};
function object(value:unknown){if(!record(value))throw new BridgeError('INVALID_UPSTREAM',502);return value;}
function canonical(value:unknown):string{
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(record(value))return '{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
 return JSON.stringify(value)??'null';
}
export class NativeSessionActions {
 constructor(private request:NativeRequest,private absent:(wid:string,sid:string,signal:AbortSignal)=>Promise<boolean>){}
 private base(wid:string){return '/workspace/'+id(wid)+'/opencode2/api';}
 private async snapshot(wid:string,sid:string,signal:AbortSignal){
  signal.throwIfAborted();const base=this.base(wid),target=base+'/session/'+id(sid);
  const session=object(object(await this.request(target,'GET',undefined,signal)).data);
  if(session.id!==sid)throw new BridgeError('NOT_FOUND',404);
  if((session.title!=null&&(typeof session.title!=='string'||session.title.length>4096))||!record(session.time))throw new BridgeError('INVALID_UPSTREAM',502);
  // New native chats have no title until their first message.
  const title=typeof session.title==='string'&&session.title.length ? session.title:'Untitled chat';
  const active=object(object(await this.request(base+'/session/active','GET',undefined,signal)).data);
  const children=object(await this.request(base+'/session?'+new URLSearchParams({parentID:sid,limit:'1'}),'GET',undefined,signal));
  if(!Array.isArray(children.data)||children.data.length>1||children.data.some(s=>!record(s)||s.parentID!==sid||typeof s.id!=='string'))throw new BridgeError('INVALID_UPSTREAM',502);
  const running=active[sid]!==undefined&&active[sid]!==null,linked=children.data.length>0;
  const revision=createHash('sha256').update(canonical({id:sid,title:session.title??null,time:session.time,model:session.model??null,location:session.location??null,running,children:children.data.map(s=>object(s).id)})).digest('hex');
  signal.throwIfAborted();
  const preview:SessionActionPreview= {revision,title,running,forkAvailable:!running,deleteAvailable:!running&&!linked,deleteReason:running?'running':linked?'linkedChats':null};
  return {session,preview,target,base};
 }
 async read(wid:string,sid:string,signal:AbortSignal):Promise<SessionActionPreview>{return (await this.snapshot(wid,sid,signal)).preview;}
 private async preflight(wid:string,sid:string,revision:string,signal:AbortSignal){
  if(!/^[a-f0-9]{64}$/.test(revision))throw new PreflightError('INVALID_REQUEST',400);
  try{
   const result=await this.snapshot(wid,sid,signal);
   if(result.preview.revision!==revision)throw new PreflightError('CHAT_CHANGED',409);
   if(result.preview.running)throw new PreflightError('CHAT_RUNNING',409);
   return result;
  }catch(error){
   if(error instanceof PreflightError)throw error;
   if(error instanceof BridgeError)throw new PreflightError(error.code,error.status);
   throw new PreflightError(signal.aborted?'FORBIDDEN':'CHAT_PREFLIGHT_UNAVAILABLE',signal.aborted?403:503);
  }
 }
 private async boundary(target:string,messageId:string,signal:AbortSignal){
  id(messageId);let cursor:string|undefined;const seen=new Set<string>();
  // Inspect bounded message metadata; the embedding strips inline file bytes.
  for(let page=0;page<20;page++){
   const query=new URLSearchParams({limit:'50',...(cursor?{cursor}:{})});
   const result=object(await this.request(target+'/message?'+query,'GET',undefined,signal));
   if(!Array.isArray(result.data)||result.data.length>50||result.data.some(m=>!record(m)||typeof m.id!=='string'))throw new BridgeError('INVALID_UPSTREAM',502);
   if(result.data.some(m=>object(m).id===messageId))return;
   const next=record(result.cursor)?result.cursor.next:null;
   if(next===null||next===undefined||next==='')throw new PreflightError('BOUNDARY_NOT_FOUND',404);
   if(typeof next!=='string'||Buffer.byteLength(next)>4096||seen.has(next))throw new BridgeError('INVALID_UPSTREAM',502);
   seen.add(next);cursor=next;signal.throwIfAborted();
  }
  throw new PreflightError('BOUNDARY_LIMIT',422);
 }
 async fork(wid:string,sid:string,beforeMessageId:string|null,revision:string,signal:AbortSignal):Promise<string>{
  let current=await this.preflight(wid,sid,revision,signal);
  if(beforeMessageId!==null){
   try{await this.boundary(current.target,beforeMessageId,signal);}catch(error){
    if(error instanceof PreflightError)throw error;
    if(error instanceof BridgeError)throw new PreflightError(error.code,error.status);
    throw new PreflightError(signal.aborted?'FORBIDDEN':'CHAT_PREFLIGHT_UNAVAILABLE',signal.aborted?403:503);
   }
   current=await this.preflight(wid,sid,revision,signal);
  }
  signal.throwIfAborted();
  const body={boundary:beforeMessageId===null?{type:'through'}:{type:'before',messageID:beforeMessageId}};
  const created=object(object(await this.request(current.target+'/fork','POST',body,signal)).data);
  if(typeof created.id!=='string'||created.id===sid||!/^[A-Za-z0-9_-]{1,200}$/.test(created.id))throw new BridgeError('FORK_OUTCOME_UNVERIFIED',502);
  signal.throwIfAborted();const child=object(object(await this.request(current.base+'/session/'+id(created.id),'GET',undefined,signal)).data);
  if(child.id!==created.id||!record(child.fork)||child.fork.sessionID!==sid||canonical(child.fork.boundary)!==canonical(body.boundary)||child.parentID!=null||canonical(child.model??null)!==canonical(current.session.model??null))throw new BridgeError('FORK_OUTCOME_UNVERIFIED',409);
  signal.throwIfAborted();return created.id;
 }
 async remove(wid:string,sid:string,revision:string,signal:AbortSignal):Promise<string>{
  const current=await this.preflight(wid,sid,revision,signal);
  if(!current.preview.deleteAvailable)throw new PreflightError('LINKED_CHATS',409);
  // Native deletion cascades. Reject known children and disclose that this
  // preflight is not an atomic lock against a simultaneous desktop fork.
  signal.throwIfAborted();await this.request(current.target,'DELETE',undefined,signal);
  signal.throwIfAborted();if(!(await this.absent(wid,sid,signal)))throw new BridgeError('DELETE_OUTCOME_UNVERIFIED',409);
  signal.throwIfAborted();return sid;
 }
}
