import {constants} from 'node:fs';
import {lstat,open,readdir,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';import {join,dirname,basename} from 'node:path';
import {ApiError} from './errors.js';import {validateSkillName} from './validators.js';
const queues=new Map<string,Promise<void>>();
/** All native text-skill writes in this server share this queue. External file editors do not acquire it. */
export async function withSkillWrite<T>(root:string,run:()=>Promise<T>):Promise<T>{
 const key=await realpath(root),previous=queues.get(key)??Promise.resolve();let release!:()=>void;
 const next=new Promise<void>(r=>{release=r}),tail=previous.then(()=>next);queues.set(key,tail);await previous;
 try{return await run()}finally{release();if(queues.get(key)===tail)queues.delete(key)}
}
export const MAX_SKILL_BYTES=64*1024;
const protectedSkill=()=>new ApiError(403,'skill_protected','Only workspace-owned text skills can be changed');
const changed=()=>new ApiError(409,'skill_changed','This skill changed. Refresh before editing');
export async function textSkillPath(root:string,name:string):Promise<{path:string;exists:boolean}>{
 validateSkillName(name);const canonical=await realpath(root);let current=canonical;
 for(const [index,part] of ['.opencode','skills',name,'SKILL.md'].entries()){
  current=join(current,part);let info;
  try{info=await lstat(current)}catch(e){if(e instanceof Error&&'code'in e&&e.code==='ENOENT')return {path:join(canonical,'.opencode','skills',name,'SKILL.md'),exists:false};throw e}
  if(info.isSymbolicLink()||(index<3?!info.isDirectory():!info.isFile()))throw protectedSkill();
  if(index===2&&(await readdir(current)).some(x=>x!=='SKILL.md'))throw protectedSkill();
 }
 const entries=await readdir(join(canonical,'.opencode','skills',name));if(entries.some(x=>x!=='SKILL.md'))throw protectedSkill();
 return {path:current,exists:true};
}
export async function readSkillFile(path:string):Promise<{content:string;revision:string}>{
 path=join(await realpath(dirname(path)),basename(path));
 const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const before=await handle.stat({bigint:true});if(!before.isFile()||before.size>BigInt(MAX_SKILL_BYTES))throw new ApiError(422,'skill_too_large','Skill text exceeds 64 KiB');
  const bytes=Buffer.alloc(Number(before.size)+1),{bytesRead}=await handle.read(bytes,0,bytes.length,0),after=await handle.stat({bigint:true});
  if(bytesRead!==Number(before.size)||before.ino!==after.ino||before.ctimeNs!==after.ctimeNs||before.mtimeNs!==after.mtimeNs||before.size!==after.size)throw changed();
  let content:string;try{content=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,bytesRead))}catch{throw new ApiError(422,'invalid_skill_content','Skill must be UTF-8 text')}
  return {content,revision:createHash('sha256').update(JSON.stringify([path,String(after.dev),String(after.ino),String(after.ctimeNs),String(after.mtimeNs),String(after.size)])).update(bytes.subarray(0,bytesRead)).digest('hex')};
 }finally{await handle.close()}
}
export async function checkSkillRevision(root:string,name:string,expected:string|null):Promise<{path:string;exists:boolean}>{
 if(expected!==null&&!/^[a-f0-9]{64}$/.test(expected))throw new ApiError(400,'invalid_skill_revision','Invalid skill revision');
 const target=await textSkillPath(root,name);
 if(expected===null){if(target.exists)throw changed()}
 else if(!target.exists||(await readSkillFile(target.path)).revision!==expected)throw changed();
 return target;
}
