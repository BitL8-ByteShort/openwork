import {createHash} from 'node:crypto';import {realpath,lstat} from 'node:fs/promises';import {join} from 'node:path';
import {listSkills,upsertSkill,deleteSkill} from './skills.js';
import {readSkillFile,textSkillPath} from './skill-write-guard.js';import {ApiError} from './errors.js';
export interface WorkspaceSkillEntry {id:string;name:string;description:string;source:'workspace'|'inherited'|'global'|'managed';editable:boolean;revision:string}
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
async function entries(root:string):Promise<Array<{item:WorkspaceSkillEntry;path:string}>>{
 const canonical=await realpath(root),all=await listSkills(root,false,false,true);
 if(all.length>500)throw new ApiError(422,'skill_catalog_too_large','Skill catalog exceeds the supported limit');
 const result:Array<{item:WorkspaceSkillEntry;path:string}>=[];
 for(const entry of all){
  const info=await lstat(entry.path).catch(()=>null);if(!info?.isFile()||info.isSymbolicLink())continue;
  const path=await realpath(entry.path),owned=path===join(canonical,'.opencode','skills',entry.name,'SKILL.md');
  let editable=false,revision:string;
  try{revision=(await readSkillFile(path)).revision}catch{revision=hash([path,String(info.ino),info.ctimeMs,info.size])}
  if(owned){try{await textSkillPath(root,entry.name);await readSkillFile(path);editable=true}catch{}}
  const source=editable?'workspace':entry.scope==='global'?'global':owned?'managed':'inherited';
  result.push({path,item:{id:'skill_'+hash([canonical,path]),name:entry.name,description:entry.description.slice(0,1024),source,editable,revision}});
 }
 return result.sort((a,b)=>a.item.id.localeCompare(b.item.id));
}
export async function listWorkspaceSkillEntries(root:string){const all=await entries(root),items=all.map(x=>({...x.item,path:x.path}));return {conditionalWrite:true,revision:hash([await realpath(root),items]),items}}
export async function readWorkspaceSkillEntry(root:string,id:string){
 if(!/^skill_[a-f0-9]{64}$/.test(id))throw new ApiError(400,'invalid_skill_id','Invalid skill ID');
 const entry=(await entries(root)).find(x=>x.item.id===id);if(!entry)throw new ApiError(404,'skill_not_found','Skill is no longer available');
 let content:string|null=null;try{content=(await readSkillFile(entry.path)).content}catch{}
 return {item:entry.item,content};
}
export async function saveWorkspaceSkillEntry(root:string,input:{name:string;content:string;revision:string|null;catalogRevision:string}){
 const catalog=await listWorkspaceSkillEntries(root);if(input.revision===null&&catalog.revision!==input.catalogRevision)throw new ApiError(409,'skill_changed','Skill catalog changed. Refresh before adding');
 const result=await upsertSkill(root,{name:input.name,content:input.content,expectedRevision:input.revision});
 const id='skill_'+hash([await realpath(root),await realpath(result.path)]);
 return {...await readWorkspaceSkillEntry(root,id),action:result.action};
}
export async function removeWorkspaceSkillEntry(root:string,id:string,revision:string){
 const {item}=await readWorkspaceSkillEntry(root,id);if(!item.editable)throw new ApiError(403,'skill_protected','This skill is managed on your computer');
 await deleteSkill(root,item.name,{expectedRevision:revision});return {id};
}
