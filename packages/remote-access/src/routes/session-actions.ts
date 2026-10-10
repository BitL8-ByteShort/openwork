import type {FastifyInstance,FastifyRequest} from 'fastify';
import {BridgeError,assertContract,record} from '../contract/index.js';
import type {OpenWorkAdapter} from '../adapters/types.js';
import type {Device} from '../storage/store.js';
import type {FeatureOperations} from '../auth/feature-access.js';
import type {Ledger} from '../mutations/ledger.js';
interface Options {remote:FastifyInstance;adapter:OpenWorkAdapter;operations:FeatureOperations;ledger:Ledger;device:(req:FastifyRequest)=>Device;envelope:(data:unknown)=>unknown}
export function registerSessionActionRoutes(o:Options){
 const base='/v1/workspaces/:wid/sessions/:sid';
 const authorize=async(req:FastifyRequest,wid:string,sid:string)=>{
  if(o.adapter.capabilities.forkSession!==true||o.adapter.capabilities.deleteSession!==true||!o.adapter.readSessionActions||!o.adapter.forkSession||!o.adapter.deleteSession)throw new BridgeError('UNSUPPORTED_ACTION',422);
  const d=o.device(req),operation=o.operations.begin(d.id,wid);
  const signal=AbortSignal.any([operation.signal,AbortSignal.timeout(120000)]);
  const check=()=>{operation.check();if(signal.aborted)throw new BridgeError('FORBIDDEN',403);if(o.adapter.capabilities.forkSession!==true||o.adapter.capabilities.deleteSession!==true)throw new BridgeError('UNSUPPORTED_ACTION',422);};
  try{
   if(!/^[A-Za-z0-9_-]{1,200}$/.test(sid)||(!record(req.query)||Object.keys(req.query).length))throw new BridgeError('INVALID_REQUEST',400);
   if(!(await o.adapter.listWorkspaces()).some(w=>w.id===wid))throw new BridgeError('NOT_FOUND',404);
   check();return {d,operation,signal,check};
  }catch(e){operation.dispose();throw e;}
 };
 o.remote.get<{Params:{wid:string;sid:string}}>(base+'/actions',async req=>{
  const {wid,sid}=req.params,{operation,signal,check}=await authorize(req,wid,sid);
  try{const value=await o.adapter.readSessionActions!(wid,sid,signal);check();return o.envelope(assertContract('SessionActionPreview',value));}catch(e){check();throw e;}finally{operation.dispose();}
 });
 for(const kind of ['fork','delete'] as const){
  o.remote.post<{Params:{wid:string;sid:string}}>(base+'/'+kind,async req=>{
   const {wid,sid}=req.params,{d,operation,signal,check}=await authorize(req,wid,sid);
   try{
    try{assertContract(kind==='fork'?'SessionFork':'SessionDelete',req.body);}catch{throw new BridgeError('INVALID_REQUEST',400);}
    const b=req.body;if(!record(b)||typeof b.requestId!=='string'||typeof b.revision!=='string')throw new BridgeError('INVALID_REQUEST',400);
    const revision=b.revision,before=b.beforeMessageId;
    if(kind==='fork'&&before!==null&&typeof before!=='string')throw new BridgeError('INVALID_REQUEST',400);
    // Authorize first, replay before native target reads: a successful delete
    // receipt remains replayable after the target has gone.
    const receipt=await o.ledger.perform(d.id,b.requestId,req.routeOptions.url!,{wid,sid,...b},async()=>{
     check();return kind==='fork'?o.adapter.forkSession!(wid,sid,typeof before==='string'?before:null,revision,signal):o.adapter.deleteSession!(wid,sid,revision,signal);
    });check();return o.envelope(receipt);
   }catch(e){check();throw e;}finally{operation.dispose();}
  });
 }
}
