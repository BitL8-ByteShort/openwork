import {createHash} from 'node:crypto';import {realpath} from 'node:fs/promises';
import {BridgeError,PreflightError,record,assertContract,type SkillSummary,type SkillCatalog,type SkillDetail,type SkillSave,type SkillWriteResult} from '../contract/index.js';
type Request=(route:string,method:string,body:unknown,signal:AbortSignal)=>Promise<unknown>;
const safe=(v:string)=>{if(!/^[A-Za-z0-9_-]{1,200}$/.test(v))throw new PreflightError('INVALID_REQUEST',400);return encodeURIComponent(v)};
const skillID=(v:string)=>{if(!/^skill_[a-f0-9]{64}$/.test(v))throw new PreflightError('INVALID_REQUEST',400);return v};
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
function summary(v:unknown):SkillSummary {
 if(!record(v))throw new BridgeError('INVALID_UPSTREAM',502);
 if(v.editable===true&&v.source!=='workspace')throw new BridgeError('INVALID_UPSTREAM',502);
 const item={id:v.id,name:v.name,description:v.description,source:v.source,editable:v.editable,selectable:false,revision:v.revision};assertContract('SkillSummary',item);
 // Runtime validation above narrows values explicitly; native paths are never projected.
 if(typeof item.id!=='string'||typeof item.name!=='string'||typeof item.description!=='string'||typeof item.editable!=='boolean'||typeof item.revision!=='string'||(item.source!=="workspace"&&item.source!=="inherited"&&item.source!=="global"&&item.source!=="managed"))throw new BridgeError('INVALID_UPSTREAM',502);
 return {id:item.id,name:item.name,description:item.description,source:item.source,editable:item.editable,selectable:false,revision:item.revision};
}
interface Bound {item:SkillSummary;nativeID?:string;nativeFile:boolean}
export class NativeSkills {
 constructor(private request:Request,private check:()=>void=()=>{}){}
 private live(signal:AbortSignal){this.check();if(signal.aborted)throw new BridgeError('FORBIDDEN',403)}
 private async call(route:string,method:string,body:unknown,signal:AbortSignal){this.live(signal);const result=await this.request(route,method,body,signal);this.live(signal);return result}
 private base(wid:string){return '/workspace/'+safe(wid)+'/skill-entries'}
 private async bound(wid:string,signal:AbortSignal){
  const native=await this.call(this.base(wid),'GET',undefined,signal);
  if(!record(native)||native.conditionalWrite!==true||typeof native.revision!=='string'||!/^[a-f0-9]{64}$/.test(native.revision)||!Array.isArray(native.items))throw new PreflightError('UNSUPPORTED_ACTION',422);
  const registry=await this.call('/workspace/'+safe(wid)+'/opencode2/api/skill','GET',undefined,signal);
  if(!record(registry)||!Array.isArray(registry.data)||registry.data.length>2000)throw new BridgeError('INVALID_UPSTREAM',502);
  const engine:Array<{id:string;name:string;description:string;location:string|null}>=[];
  for(const raw of registry.data){if(!record(raw)||typeof raw.id!=='string'||!raw.id||raw.id.length>512||typeof raw.name!=='string'||!raw.name||raw.name.length>200||typeof raw.description!=='string'||raw.description.length>1024)throw new BridgeError('INVALID_UPSTREAM',502);
   const location=typeof raw.location==='string'?await realpath(raw.location).catch(()=>null):null;this.live(signal);engine.push({id:raw.id,name:raw.name,description:raw.description,location});}
  if(new Set(engine.map(x=>x.id)).size!==engine.length)throw new BridgeError('INVALID_UPSTREAM',502);
  const bindings:Bound[]=[],used=new Set<string>();
  for(const raw of native.items){const item=summary(raw);const matches=record(raw)&&typeof raw.path==='string'?engine.filter(x=>x.location===raw.path&&x.name===item.name):[];
   const nativeID=matches.length===1?matches[0]!.id:undefined;if(nativeID)used.add(nativeID);bindings.push({item:{...item,selectable:!!nativeID},nativeID,nativeFile:true});}
  for(const entry of engine)if(!used.has(entry.id)){const id='skill_'+hash([wid,'engine',entry.id]);bindings.push({item:{id,name:entry.name,description:entry.description,source:'managed',editable:false,selectable:true,revision:hash([wid,entry.id,entry.name,entry.description])},nativeID:entry.id,nativeFile:false})}
  const items=bindings.map(x=>x.item).sort((a,b)=>a.id.localeCompare(b.id));
  if(items.length>2000||new Set(items.map(x=>x.id)).size!==items.length)throw new BridgeError('INVALID_UPSTREAM',502);
  const catalog=assertContract('SkillCatalog',{items,revision:hash([native.revision,items])});return {catalog,bindings,nativeRevision:native.revision};
 }
 async list(wid:string,signal:AbortSignal):Promise<SkillCatalog>{return (await this.bound(wid,signal)).catalog}
 async read(wid:string,id:string,signal:AbortSignal):Promise<SkillDetail>{
  skillID(id);const state=await this.bound(wid,signal),entry=state.bindings.find(x=>x.item.id===id);if(!entry)throw new PreflightError('NOT_FOUND',404);
  if(!entry.nativeFile)return {item:entry.item,content:null};
  const native=await this.call(this.base(wid)+'/'+id,'GET',undefined,signal);
  if(!record(native)||!(native.content===null||typeof native.content==='string')||(typeof native.content==='string'&&Buffer.byteLength(native.content)>65536))throw new BridgeError('INVALID_UPSTREAM',502);
  const item=summary(native.item);if(item.id!==id||item.revision!==entry.item.revision)throw new PreflightError('STALE_SETTINGS',409);
  return assertContract('SkillDetail',{item:entry.item,content:native.content});
 }
 async save(wid:string,input:SkillSave,signal:AbortSignal):Promise<SkillWriteResult>{
  if(Buffer.byteLength(input.content)>65536)throw new PreflightError('SKILL_TOO_LARGE',413);
  const before=await this.bound(wid,signal),item=before.catalog.items.find(x=>x.name===input.name&&x.source==='workspace');
  if(input.revision===null){if(input.catalogRevision!==before.catalog.revision||before.catalog.items.some(x=>x.name===input.name))throw new PreflightError('STALE_SETTINGS',409)}
  else if(!item?.editable||item.revision!==input.revision)throw new PreflightError('STALE_SETTINGS',409);
  const response=await this.call(this.base(wid),'POST',{...input,catalogRevision:before.nativeRevision},signal);
  if(!record(response)||!record(response.item)||typeof response.item.id!=='string')throw new BridgeError('OUTCOME_UNKNOWN',502);
  try{const actual=await this.read(wid,response.item.id,signal);if(actual.item.revision!==response.item.revision||actual.content===null||actual.content!==response.content)throw new BridgeError('OUTCOME_UNKNOWN',502);return {resourceId:actual.item.id,resourceRevision:actual.item.revision}}catch{throw new BridgeError('OUTCOME_UNKNOWN',502)}
 }
 async delete(wid:string,id:string,revision:string,signal:AbortSignal):Promise<string>{
  const before=await this.read(wid,skillID(id),signal);if(!before.item.editable)throw new PreflightError('SKILL_PROTECTED',422);if(before.item.revision!==revision)throw new PreflightError('STALE_SETTINGS',409);
  await this.call(this.base(wid)+'/'+id+'/delete','POST',{revision},signal);
  try{const after=await this.list(wid,signal);if(after.items.some(x=>x.id===id))throw new BridgeError('OUTCOME_UNKNOWN',502);return id}catch{throw new BridgeError('OUTCOME_UNKNOWN',502)}
 }
 async selected(wid:string,sid:string,ids:string[],signal:AbortSignal):Promise<Array<{id:string}>>{
  safe(sid);if(!ids.length||ids.length>8||new Set(ids).size!==ids.length)throw new PreflightError('INVALID_REQUEST',400);ids.forEach(skillID);
  const state=await this.bound(wid,signal),skills=ids.map(id=>{const item=state.bindings.find(x=>x.item.id===id);if(!item?.nativeID||!item.item.selectable)throw new PreflightError('SKILL_UNAVAILABLE',422);return {id:item.nativeID}});
  // Catalog membership is not permission. Ask the native engine, with no save rule or approval reply.
  const answer=await this.call('/workspace/'+safe(wid)+'/opencode2/api/session/'+safe(sid)+'/permission','POST',{action:'skill',resources:skills.map(x=>x.id)},signal);
  if(!record(answer)||!record(answer.data))throw new BridgeError('INVALID_UPSTREAM',502);
  if(answer.data.effect!=='allow')throw new PreflightError(answer.data.effect==='ask'?'SKILL_APPROVAL_REQUIRED':'SKILL_DENIED',422);
  return skills;
 }
}
