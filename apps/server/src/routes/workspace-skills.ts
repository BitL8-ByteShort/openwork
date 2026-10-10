import {z} from 'zod';import {join} from 'node:path';
import {ApiError} from '../errors.js';import {addRoute,type Route,type RequestContext} from './registry.js';
import type {ServerConfig,TokenScope,WorkspaceInfo,ApprovalRequest} from '../types.js';
import {listWorkspaceSkillEntries,readWorkspaceSkillEntry,saveWorkspaceSkillEntry,removeWorkspaceSkillEntry} from '../workspace-skill-entries.js';
const revision=z.string().regex(/^[a-f0-9]{64}$/),id=z.string().regex(/^skill_[a-f0-9]{64}$/);
const save=z.object({name:z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(64),content:z.string().min(1).refine(v=>Buffer.byteLength(v)<=65536),revision:revision.nullable(),catalogRevision:revision}).strict();
interface Options {
 routes:Route[];config:ServerConfig;jsonResponse:(v:unknown,status?:number)=>Response;readJsonBody:(r:Request)=>Promise<unknown>;
 ensureWritable:(c:ServerConfig)=>void;requireClientScope:(c:RequestContext,s:TokenScope)=>void;resolveWorkspace:(c:ServerConfig,id:string)=>Promise<WorkspaceInfo>;
 requireApproval:(c:RequestContext,input:Omit<ApprovalRequest,'id'|'createdAt'|'actor'>)=>Promise<void>;
 changed:(c:RequestContext,w:WorkspaceInfo,name:string,path:string,action:'added'|'updated'|'removed')=>Promise<void>;
}
export function registerWorkspaceSkillRoutes(o:Options){
 const base='/workspace/:id/skill-entries';
 const live=(ctx:RequestContext)=>{if(ctx.request.signal.aborted)throw new ApiError(409,'request_cancelled','Request was cancelled before writing')};
 addRoute(o.routes,'GET',base,'client',async ctx=>{const w=await o.resolveWorkspace(o.config,ctx.params.id);return o.jsonResponse(await listWorkspaceSkillEntries(w.path))});
 addRoute(o.routes,'GET',base+'/:skillId','client',async ctx=>{const w=await o.resolveWorkspace(o.config,ctx.params.id);return o.jsonResponse(await readWorkspaceSkillEntry(w.path,ctx.params.skillId))});
 addRoute(o.routes,'POST',base,'client',async ctx=>{
  o.ensureWritable(o.config);o.requireClientScope(ctx,'collaborator');const w=await o.resolveWorkspace(o.config,ctx.params.id),parsed=save.safeParse(await o.readJsonBody(ctx.request));
  if(!parsed.success)throw new ApiError(400,'invalid_skill_payload','Expected a name, UTF-8 text, revision and catalog revision');
  const b=parsed.data;
  await o.requireApproval(ctx,{workspaceId:w.id,action:'skills.upsert',summary:`Save workspace skill ${b.name}`,paths:[join(w.path,'.opencode','skills',b.name,'SKILL.md')]});live(ctx);
  const result=await saveWorkspaceSkillEntry(w.path,b);await o.changed(ctx,w,result.item.name,join(w.path,'.opencode','skills',result.item.name,'SKILL.md'),result.action);return o.jsonResponse(result);
 });
 addRoute(o.routes,'POST',base+'/:skillId/delete','client',async ctx=>{
  o.ensureWritable(o.config);o.requireClientScope(ctx,'collaborator');const w=await o.resolveWorkspace(o.config,ctx.params.id),parsed=z.object({revision}).strict().safeParse(await o.readJsonBody(ctx.request));
  if(!parsed.success||!id.safeParse(ctx.params.skillId).success)throw new ApiError(400,'invalid_skill_payload','Expected a skill ID and revision');
  const before=await readWorkspaceSkillEntry(w.path,ctx.params.skillId);if(!before.item.editable)throw new ApiError(403,'skill_protected','This skill is managed on your computer');
  await o.requireApproval(ctx,{workspaceId:w.id,action:'skills.delete',summary:`Remove workspace skill ${before.item.name}`,paths:[join(w.path,'.opencode','skills',before.item.name,'SKILL.md')]});live(ctx);
  const result=await removeWorkspaceSkillEntry(w.path,ctx.params.skillId,parsed.data.revision);await o.changed(ctx,w,before.item.name,join(w.path,'.opencode','skills',before.item.name,'SKILL.md'),'removed');return o.jsonResponse(result);
 });
}
