import type {FastifyInstance,FastifyRequest} from 'fastify';import {BridgeError,assertContract,record,type SkillSave} from '../contract/index.js';
import type {OpenWorkAdapter} from '../adapters/types.js';import type {Device} from '../storage/store.js';import type {FeatureOperations} from '../auth/feature-access.js';import type {Ledger} from '../mutations/ledger.js';
interface Options {remote:FastifyInstance;adapter:OpenWorkAdapter;operations:FeatureOperations;ledger:Ledger;device:(req:FastifyRequest)=>Device;envelope:(data:unknown)=>unknown}
export function registerSkillRoutes(o:Options){
 const base='/v1/workspaces/:wid/skills';
 const authorize=async(req:FastifyRequest,wid:string,write=false)=>{
  if(o.adapter.capabilities.skillsRead!==true||!o.adapter.readSkills||!o.adapter.readSkill||(write&&(o.adapter.capabilities.skillsWrite!==true||!o.adapter.saveSkill||!o.adapter.deleteSkill)))throw new BridgeError('UNSUPPORTED_ACTION',422);
  const d=o.device(req),operation=o.operations.begin(d.id,wid,write?'workspaceAdministration':undefined),signal=AbortSignal.any([operation.signal,AbortSignal.timeout(120000)]);
  const check=()=>{operation.check();if(signal.aborted)throw new BridgeError('FORBIDDEN',403);if(o.adapter.capabilities.skillsRead!==true||(write&&o.adapter.capabilities.skillsWrite!==true))throw new BridgeError('UNSUPPORTED_ACTION',422)};
  try{if((!record(req.query)||Object.keys(req.query).length)||!/^[A-Za-z0-9_-]{1,200}$/.test(wid))throw new BridgeError('INVALID_REQUEST',400);if(!(await o.adapter.listWorkspaces()).some(w=>w.id===wid))throw new BridgeError('NOT_FOUND',404);check();return {d,operation,signal,check}}catch(e){operation.dispose();throw e}
 };
 o.remote.get<{Params:{wid:string}}>(base,async req=>{const {wid}=req.params,{operation,signal,check}=await authorize(req,wid);try{const value=await o.adapter.readSkills!(wid,signal,check);check();return o.envelope(assertContract('SkillCatalog',value))}catch(e){check();throw e}finally{operation.dispose()}});
 o.remote.get<{Params:{wid:string;id:string}}>(base+'/:id',async req=>{const {wid,id}=req.params,{operation,signal,check}=await authorize(req,wid);try{if(!/^skill_[a-f0-9]{64}$/.test(id))throw new BridgeError('INVALID_REQUEST',400);const value=await o.adapter.readSkill!(wid,id,signal,check);check();return o.envelope(assertContract('SkillDetail',value))}catch(e){check();throw e}finally{operation.dispose()}});
 o.remote.post<{Params:{wid:string};Body:SkillSave&{requestId:string}}>(base+'/save',async req=>{
  const {wid}=req.params,{d,operation,signal,check}=await authorize(req,wid,true);
  try{try{assertContract('SkillSave',req.body)}catch{throw new BridgeError('INVALID_REQUEST',400)}const b=req.body;
   const receipt=await o.ledger.perform(d.id,b.requestId,req.routeOptions.url!,{wid,...b},async()=>{check();const {requestId,...input}=b;return o.adapter.saveSkill!(wid,input,signal,check)});check();return o.envelope(receipt);
  }catch(e){check();throw e}finally{operation.dispose()}
 });
 o.remote.post<{Params:{wid:string};Body:{requestId:string;id:string;revision:string}}>(base+'/delete',async req=>{
  const {wid}=req.params,{d,operation,signal,check}=await authorize(req,wid,true);
  try{try{assertContract('SkillDelete',req.body)}catch{throw new BridgeError('INVALID_REQUEST',400)}const b=req.body;
   const receipt=await o.ledger.perform(d.id,b.requestId,req.routeOptions.url!,{wid,...b},async()=>{check();return o.adapter.deleteSkill!(wid,b.id,b.revision,signal,check)});check();return o.envelope(receipt);
  }catch(e){check();throw e}finally{operation.dispose()}
 });
}
