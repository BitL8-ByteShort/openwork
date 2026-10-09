import type {FastifyInstance,FastifyRequest} from 'fastify';
import {BridgeError,assertContract,type ModelSelection} from '../contract/index.js';
import type {OpenWorkAdapter} from '../adapters/types.js';import type {Device} from '../storage/store.js';import type {FeatureOperations} from '../auth/feature-access.js';import type {Ledger} from '../mutations/ledger.js';
interface Options {remote:FastifyInstance;adapter:OpenWorkAdapter;operations:FeatureOperations;ledger:Ledger;device:(req:FastifyRequest)=>Device;envelope:(data:unknown)=>unknown}
export function registerWorkspaceDefaultsRoutes(o:Options){
 const base='/v1/workspaces/:wid/default-model';
 const authorize=async(req:FastifyRequest,wid:string)=>{
  if(o.adapter.capabilities.workspaceDefaults!==true||!o.adapter.readWorkspaceDefaults||!o.adapter.setWorkspaceDefaults)throw new BridgeError('UNSUPPORTED_ACTION',422);
  const d=o.device(req),operation=o.operations.begin(d.id,wid,'workspaceAdministration');
  const signal=AbortSignal.any([operation.signal,AbortSignal.timeout(120000)]);
  const check=()=>{operation.check();if(signal.aborted)throw new BridgeError('FORBIDDEN',403);if(o.adapter.capabilities.workspaceDefaults!==true)throw new BridgeError('UNSUPPORTED_ACTION',422);};
  try{if(!(await o.adapter.listWorkspaces()).some(w=>w.id===wid))throw new BridgeError('NOT_FOUND',404);check();return {d,operation,signal,check};}catch(e){operation.dispose();throw e;}
 };
 o.remote.get<{Params:{wid:string};Querystring:Record<string,unknown>}>(base,async req=>{
  const {wid}=req.params,{operation,signal,check}=await authorize(req,wid);
  try{if(Object.keys(req.query).length)throw new BridgeError('INVALID_REQUEST',400);const value=await o.adapter.readWorkspaceDefaults!(wid,signal,check);check();return o.envelope(assertContract('WorkspaceDefaults',value));}catch(e){check();throw e;}finally{operation.dispose();}
 });
 o.remote.post<{Params:{wid:string};Querystring:Record<string,unknown>}>(base,async req=>{
  const {wid}=req.params,{d,operation,signal,check}=await authorize(req,wid);
  try{
   if(Object.keys(req.query).length)throw new BridgeError('INVALID_REQUEST',400);
   try{assertContract('WorkspaceDefaultsSave',req.body);}catch{throw new BridgeError('INVALID_REQUEST',400);}
   const b=req.body as {requestId:string;revision:string;selection:ModelSelection};
   const receipt=await o.ledger.perform(d.id,b.requestId,req.routeOptions.url!,{wid,...b},async()=>{check();return o.adapter.setWorkspaceDefaults!(wid,b.selection,b.revision,signal,check);});
   check();return o.envelope(receipt);
  }catch(e){check();throw e;}finally{operation.dispose();}
 });
}
