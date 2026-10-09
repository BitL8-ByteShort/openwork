import type {FastifyInstance,FastifyRequest} from 'fastify';
import {BridgeError,assertContract,record} from '../contract/index.js';
import type {OpenWorkAdapter} from '../adapters/types.js';
import type {FeatureOperations} from '../auth/feature-access.js';
import type {Device} from '../storage/store.js';
import {SessionSearch} from '../search/session-search.js';
interface Options {remote:FastifyInstance;adapter:OpenWorkAdapter;operations:FeatureOperations;device:(req:FastifyRequest)=>Device;envelope:(data:unknown)=>unknown}
export function registerSessionSearchRoutes(o:Options){
 const search=new SessionSearch((wid,cursor,signal)=>o.adapter.listSessions(wid,cursor,signal));
 o.remote.addHook('onClose',async()=>search.close());
 o.remote.get<{Params:{wid:string}}>('/v1/workspaces/:wid/sessions/search',async req=>{
  const wid=req.params.wid,d=o.device(req),operation=o.operations.begin(d.id,wid);
  try{
   if(o.adapter.capabilities.searchSessions!==true)throw new BridgeError('UNSUPPORTED_ACTION',422);
   const q=req.query;
   if(!record(q)||Object.keys(q).some(k=>!['q','cursor'].includes(k))||typeof q.q!=='string'||q.cursor!==undefined&&typeof q.cursor!=='string')throw new BridgeError('INVALID_REQUEST',400);
   if(!(await o.adapter.listWorkspaces()).some(w=>w.id===wid))throw new BridgeError('NOT_FOUND',404);
   const signal=AbortSignal.any([operation.signal,AbortSignal.timeout(120000)]);
   const value=await search.read(d.id,wid,q.q,typeof q.cursor==='string'?q.cursor:undefined,signal,operation.check);
   operation.check();signal.throwIfAborted();
   if(o.adapter.capabilities.searchSessions!==true)throw new BridgeError('UNSUPPORTED_ACTION',422);
   return o.envelope(assertContract('SessionSearchPage',value));
  }catch(e){operation.check();throw e;}finally{operation.dispose();}
 });
}
