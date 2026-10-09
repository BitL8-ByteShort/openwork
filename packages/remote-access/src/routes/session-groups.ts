import type {FastifyInstance,FastifyRequest} from 'fastify';
import {BridgeError,assertContract,record} from '../contract/index.js';
import {groupLabel,type GroupCommand} from '../adapters/session-groups.js';
import type {OpenWorkAdapter} from '../adapters/types.js';import type {Device} from '../storage/store.js';import type {FeatureOperations} from '../auth/feature-access.js';import type {Ledger} from '../mutations/ledger.js';
interface Options {remote:FastifyInstance;adapter:OpenWorkAdapter;operations:FeatureOperations;ledger:Ledger;device:(req:FastifyRequest)=>Device;envelope:(data:unknown)=>unknown}
export function registerSessionGroupRoutes(o:Options){
 const base='/v1/workspaces/:wid/session-groups';
 const authorize=async(req:FastifyRequest,wid:string)=>{
  if(o.adapter.capabilities.sessionGroups!==true||!o.adapter.readSessionGroups||!o.adapter.changeSessionGroup)throw new BridgeError('UNSUPPORTED_ACTION',422);
  const d=o.device(req),operation=o.operations.begin(d.id,wid);
  const signal=AbortSignal.any([operation.signal,AbortSignal.timeout(120000)]);
  const check=()=>{operation.check();if(signal.aborted)throw new BridgeError('FORBIDDEN',403);if(o.adapter.capabilities.sessionGroups!==true)throw new BridgeError('UNSUPPORTED_ACTION',422);};
  try{if(!(await o.adapter.listWorkspaces()).some(w=>w.id===wid))throw new BridgeError('NOT_FOUND',404);check();return {d,operation,signal,check};}catch(e){operation.dispose();throw e;}
 };
 o.remote.get<{Params:{wid:string};Querystring:Record<string,unknown>}>(base,async req=>{
  const {wid}=req.params,{operation,signal,check}=await authorize(req,wid);
  try{if(Object.keys(req.query).length)throw new BridgeError('INVALID_REQUEST',400);const value=await o.adapter.readSessionGroups!(wid,signal);check();return o.envelope(assertContract('GroupSnapshot',value));}catch(e){check();throw e;}finally{operation.dispose();}
 });
 for(const [suffix,schema,kind] of [['','GroupCreate','create'],['/reorder','GroupReorder','reorder'],['/:gid/rename','GroupRename','rename'],['/:gid/remove','GroupRemove','remove'],['/assignments/:sid','GroupAssignment','assign']] as const){
  o.remote.post<{Params:{wid:string;gid:string;sid:string};Querystring:Record<string,unknown>}>(base+suffix,async req=>{
   const {wid,gid,sid}=req.params,{d,operation,signal,check}=await authorize(req,wid);
   try{
    if(Object.keys(req.query).length)throw new BridgeError('INVALID_REQUEST',400);
    try{assertContract(schema,req.body);}catch{throw new BridgeError('INVALID_REQUEST',400);}
    const b=req.body;if(!record(b)||typeof b.requestId!=='string'||typeof b.revision!=='string')throw new BridgeError('INVALID_REQUEST',400);
    let command:GroupCommand;
    if(kind==='create'||kind==='rename'){
     if(typeof b.label!=='string')throw new BridgeError('INVALID_REQUEST',400);
     const label=groupLabel(b.label);command=kind==='create'?{action:'create',groupId:'grp_remote_'+b.requestId.replaceAll('-',''),label}:{action:'rename',groupId:gid,label};
    }else if(kind==='remove')command={action:'remove',groupId:gid};
    else if(kind==='assign'){
     if(b.groupId!==null&&typeof b.groupId!=='string')throw new BridgeError('INVALID_REQUEST',400);
     command={action:'assign',sessionId:sid,groupId:b.groupId};
    }else{
     if(!Array.isArray(b.groupIds)||!b.groupIds.every((v:unknown)=>typeof v==='string'))throw new BridgeError('INVALID_REQUEST',400);
     command={action:'reorder',groupIds:b.groupIds};
    }
    const revision=b.revision,receipt=await o.ledger.perform(d.id,b.requestId,req.routeOptions.url!,{wid,gid:gid??null,sid:sid??null,...b},async()=>{
     check();return o.adapter.changeSessionGroup!(wid,command,revision,signal);
    });check();return o.envelope(receipt);
   }catch(e){check();throw e;}finally{operation.dispose();}
  });
 }
}
