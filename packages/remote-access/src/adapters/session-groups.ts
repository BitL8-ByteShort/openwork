import {createHash} from 'node:crypto';
import {BridgeError,PreflightError,record} from '../contract/index.js';

export interface SessionGroup {id:string;label:string}
export interface GroupSnapshot {revision:string;groups:SessionGroup[];assignments:Record<string,string>}
export type GroupCommand =
 | {action:'create';groupId:string;label:string}
 | {action:'rename';groupId:string;label:string}
 | {action:'reorder';groupIds:string[]}
 | {action:'assign';sessionId:string;groupId:string|null}
 | {action:'remove';groupId:string};
type NativeRequest=(route:string,method?:string,body?:unknown,signal?:AbortSignal)=>Promise<unknown>;
const identifier=(value:string)=>{if(!/^[A-Za-z0-9_-]{1,128}$/.test(value))throw new PreflightError('INVALID_REQUEST',400);return encodeURIComponent(value);};
export function groupLabel(value:string){
 const label=value.trim();
 if(!label||Array.from(label).length>100||label.length>120||/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(label))throw new PreflightError('INVALID_REQUEST',400);
 return label;
}
export function normalizeGroups(value:unknown):GroupSnapshot {
 if(!record(value)||!record(value.state)||!Array.isArray(value.state.groups)||!record(value.state.assignments))throw new BridgeError('INVALID_UPSTREAM',502);
 if(value.state.groups.length>100||Object.keys(value.state.assignments).length>10000)throw new BridgeError('SNAPSHOT_TOO_LARGE',413);
 const groups=value.state.groups.map(raw=>{
  if(!record(raw)||typeof raw.id!=='string'||typeof raw.label!=='string')throw new BridgeError('INVALID_UPSTREAM',502);
  try{identifier(raw.id);if(groupLabel(raw.label)!==raw.label)throw Error('Unnormalized label');}catch{throw new BridgeError('INVALID_UPSTREAM',502);}
  return {id:raw.id,label:raw.label};
 });
 const ids=new Set(groups.map(g=>g.id));if(ids.size!==groups.length)throw new BridgeError('INVALID_UPSTREAM',502);
 const entries=Object.entries(value.state.assignments).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([sid,gid])=>{
  if(!/^[A-Za-z0-9_-]{1,200}$/.test(sid)||typeof gid!=='string'||!ids.has(gid))throw new BridgeError('INVALID_UPSTREAM',502);
  return [sid,gid] as const;
 });
 const assignments=Object.fromEntries(entries),revision=createHash('sha256').update(JSON.stringify({groups,assignments})).digest('hex');
 return {revision,groups,assignments};
}
export class NativeSessionGroups {
 constructor(private request:NativeRequest,private ownSession:(wid:string,sid:string,signal:AbortSignal)=>Promise<void>){}
 async read(wid:string,signal:AbortSignal):Promise<GroupSnapshot>{
  signal.throwIfAborted();const result=normalizeGroups(await this.request('/workspace/'+identifier(wid)+'/session-groups','GET',undefined,signal));signal.throwIfAborted();return result;
 }
 async apply(wid:string,command:GroupCommand,revision:string,signal:AbortSignal):Promise<string|null>{
  signal.throwIfAborted();const base='/workspace/'+identifier(wid)+'/session-groups';
  if(!/^[a-f0-9]{64}$/.test(revision))throw new PreflightError('INVALID_REQUEST',400);
  let current:GroupSnapshot;
  try{
   if(command.action==='assign'){
    if(!/^[A-Za-z0-9_-]{1,200}$/.test(command.sessionId))throw new PreflightError('INVALID_REQUEST',400);
    await this.ownSession(wid,command.sessionId,signal);signal.throwIfAborted();
   }
   current=await this.read(wid,signal);
  }catch(error){
   if(error instanceof PreflightError)throw error;
   if(error instanceof BridgeError)throw new PreflightError(error.code,error.status);
   throw new PreflightError(signal.aborted?'FORBIDDEN':'GROUP_PREFLIGHT_UNAVAILABLE',signal.aborted?403:503);
  }
  if(current.revision!==revision)throw new PreflightError('GROUPS_CHANGED',409);
  let route=base,method='PATCH',body:unknown,resource:string|null=null;
  const exists=(id:string)=>{identifier(id);if(!current.groups.some(g=>g.id===id))throw new PreflightError('NOT_FOUND',404);};
  switch(command.action){
   case 'create':{
    identifier(command.groupId);const label=groupLabel(command.label);
    if(current.groups.length>=100)throw new PreflightError('GROUP_LIMIT',409);
    if(current.groups.some(g=>g.id===command.groupId))throw new PreflightError('GROUPS_CHANGED',409);
    method='POST';body={id:command.groupId,label};resource=command.groupId;break;
   }
   case 'rename':exists(command.groupId);route+='/'+identifier(command.groupId);body={label:groupLabel(command.label)};resource=command.groupId;break;
   case 'remove':exists(command.groupId);route+='/'+identifier(command.groupId);method='DELETE';resource=command.groupId;break;
   case 'reorder':{
    if(command.groupIds.length!==current.groups.length||new Set(command.groupIds).size!==command.groupIds.length||command.groupIds.some(id=>!current.groups.some(g=>g.id===id)))throw new PreflightError('INVALID_REQUEST',400);
    route+='/reorder';body={groupIds:command.groupIds};break;
   }
   case 'assign':{
    if(command.groupId!==null)exists(command.groupId);
    route+='/assignments/'+encodeURIComponent(command.sessionId);body={groupId:command.groupId};resource=command.sessionId;break;
   }
  }
  // Native granular updates merge against the native queue's current state.
  // There is no native conditional revision API; same-field edits are last-writer.
  signal.throwIfAborted();await this.request(route,method,body,signal);signal.throwIfAborted();
  const actual=await this.read(wid,signal);
  const accepted=command.action==='create'?actual.groups.some(g=>g.id===command.groupId&&g.label===groupLabel(command.label)):
   command.action==='rename'?actual.groups.some(g=>g.id===command.groupId&&g.label===groupLabel(command.label)):
   command.action==='remove'?!actual.groups.some(g=>g.id===command.groupId):
   command.action==='assign'?(actual.assignments[command.sessionId]??null)===command.groupId:
   JSON.stringify(actual.groups.map(g=>g.id))===JSON.stringify(command.groupIds);
  if(!accepted)throw new BridgeError('GROUP_OUTCOME_UNVERIFIED',409);
  return resource;
 }
}
