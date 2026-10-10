import {BridgeError,PreflightError,record,type ModelSelection,type WorkspaceDefaults} from '../contract/index.js';
import {normalizeModelCatalog} from './controls.js';
type Read=(wid:string,signal:AbortSignal)=>Promise<unknown>;
type NativeModel={providerID:string;modelID:string;variant?:string};
type Write=(wid:string,body:{model:NativeModel;revision:string},signal:AbortSignal)=>Promise<unknown>;
const safe=(wid:string)=>{if(!/^[A-Za-z0-9_-]{1,200}$/.test(wid))throw new BridgeError('INVALID_REQUEST',400);};
const live=(signal:AbortSignal)=>{if(signal.aborted)throw new BridgeError('FORBIDDEN',403);};
function state(value:unknown,afterWrite=false):Pick<WorkspaceDefaults,'current'|'revision'>{
 if(!record(value)||value.conditionalWrite!==true){if(afterWrite)throw new BridgeError('OUTCOME_UNKNOWN',502);throw new PreflightError('UNSUPPORTED_ACTION',422);}
 if(typeof value.revision!=='string'||!/^[a-f0-9]{64}$/.test(value.revision))throw new BridgeError('INVALID_UPSTREAM',502);
 if(value.model===null)return {current:null,revision:value.revision};
 const m=value.model;
 if(!record(m)||typeof m.providerID!=='string'||!m.providerID.length||m.providerID.length>200||typeof m.modelID!=='string'||!m.modelID.length||m.modelID.length>200||(m.variant!==undefined&&(typeof m.variant!=='string'||!m.variant.length||m.variant.length>80)))throw new BridgeError('INVALID_UPSTREAM',502);
 return {current:{providerId:m.providerID,modelId:m.modelID,variant:typeof m.variant==='string'&&m.variant!=='default'?m.variant:null},revision:value.revision};
}
const same=(a:ModelSelection|null,b:ModelSelection)=>a!==null&&a.providerId===b.providerId&&a.modelId===b.modelId&&a.variant===b.variant;
/** Requires the native conditional-write extension. Never falls back to a blind PUT. */
export class NativeWorkspaceDefaults {
 constructor(private nativeRead:Read,private catalog:Read,private nativeWrite:Write){}
 async read(wid:string,signal:AbortSignal):Promise<WorkspaceDefaults>{
  safe(wid);live(signal);const current=state(await this.nativeRead(wid,signal));live(signal);
  const models=normalizeModelCatalog(await this.catalog(wid,signal));live(signal);return {...current,models};
 }
 async set(wid:string,selection:ModelSelection,revision:string,signal:AbortSignal):Promise<string>{
  safe(wid);live(signal);const snapshot=await this.read(wid,signal);
  if(snapshot.revision!==revision)throw new PreflightError('STALE_SETTINGS',409);
  const choice=snapshot.models.find(m=>m.providerId===selection.providerId&&m.modelId===selection.modelId);
  if(!choice||(selection.variant!==null&&!choice.variants.includes(selection.variant)))throw new PreflightError('INVALID_MODEL',422);
  live(signal);
  const written=state(await this.nativeWrite(wid,{revision,model:{providerID:selection.providerId,modelID:selection.modelId,...(selection.variant===null?{}:{variant:selection.variant})}},signal),true);
  live(signal);const actual=state(await this.nativeRead(wid,signal),true);live(signal);
  if(!same(written.current,selection)||!same(actual.current,selection)||written.revision!==actual.revision)throw new BridgeError('OUTCOME_UNKNOWN',502);
  return wid;
 }
}
