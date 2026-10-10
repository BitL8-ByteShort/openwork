import {test,expect} from 'vitest';import {mkdtemp,writeFile,rm,realpath} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {NativeSkills} from '../src/adapters/skills.js';import {record} from '../src/contract/index.js';
const id='skill_'+'a'.repeat(64),revision='b'.repeat(64),signal=()=>new AbortController().signal;
async function fixture(run:(f:{adapter:NativeSkills;setEffect:(v:string)=>void;setStale:()=>void;calls:Array<{route:string;method:string;body:unknown}>})=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'native-skills-'));await writeFile(join(root,'SKILL.md'),'Instructions');const path=await realpath(join(root,'SKILL.md'));let effect='allow',rev=revision;const calls:Array<{route:string;method:string;body:unknown}>=[];
 const adapter=new NativeSkills(async(route,method,body)=>{calls.push({route,method,body});if(route.endsWith('/permission'))return {data:{effect}};
 if(route.endsWith('/api/skill'))return {data:[{id:'native-exact-id',name:'same-name',description:'Workspace',location:path},{id:'another-id',name:'same-name',description:'Managed',location:'/not-a-local-file'}]};
 const item={id,name:'same-name',description:'Workspace',source:'workspace',editable:true,revision:rev,path};
 if(route.endsWith('/skill-entries'))return {conditionalWrite:true,revision:'c'.repeat(64),items:[item]};if(route.endsWith('/'+id))return {item,content:'Instructions'};throw Error('Unexpected route');});
 try{await run({adapter,calls,setEffect:v=>{effect=v},setStale:()=>{rev='d'.repeat(64)}})}finally{await rm(root,{recursive:true,force:true})}
}
test('catalog preserves ambiguous names with exact engine binding and never projects paths or engine bodies',()=>fixture(async f=>{
 const catalog=await f.adapter.list('owned',signal());expect(catalog.items.filter(x=>x.name==='same-name')).toHaveLength(2);expect(catalog.items.find(x=>x.id===id)?.selectable).toBe(true);expect(JSON.stringify(catalog)).not.toContain('location');expect(JSON.stringify(catalog)).not.toContain('SKILL.md');
 const skills=await f.adapter.selected('owned','chat',[id],signal());expect(skills).toEqual([{id:'native-exact-id'}]);const permission=f.calls.find(x=>x.route.endsWith('/permission'))!;expect(permission.route).toBe('/workspace/owned/opencode2/api/session/chat/permission');expect(permission.body).toEqual({action:'skill',resources:['native-exact-id']});
}));
test('ask/deny are a native permission handoff with no approval reply, saved rule or prompt-prose fallback',()=>fixture(async f=>{
 for(const effect of ['ask','deny']){f.setEffect(effect);await expect(f.adapter.selected('owned','chat',[id],signal())).rejects.toMatchObject({code:effect==='ask'?'SKILL_APPROVAL_REQUIRED':'SKILL_DENIED'});}
 expect(f.calls.filter(x=>x.method==='POST').every(x=>x.route.endsWith('/permission')&&record(x.body)&&!('save'in x.body)&&!('reply'in x.body)&&!('text'in x.body))).toBe(true);
}));
test('foreign/missing/path-like skill IDs and stale edits reject before any mutation',()=>fixture(async f=>{
 for(const wrong of ['../skill','skill_'+'f'.repeat(64)])await expect(f.adapter.selected('owned','chat',[wrong],signal())).rejects.toBeDefined();
 const catalog=await f.adapter.list('owned',signal());f.setStale();await expect(f.adapter.save('owned',{name:'same-name',content:'Changed',revision,catalogRevision:catalog.revision},signal())).rejects.toMatchObject({code:'STALE_SETTINGS'});expect(f.calls.filter(x=>x.method!=='GET')).toHaveLength(0);
}));
test('managed instructions are read-only and body stays on the computer',()=>fixture(async f=>{
 const catalog=await f.adapter.list('owned',signal()),managed=catalog.items.find(x=>x.source==='managed')!;expect(await f.adapter.read('owned',managed.id,signal())).toEqual({item:managed,content:null});await expect(f.adapter.delete('owned',managed.id,managed.revision,signal())).rejects.toMatchObject({code:'SKILL_PROTECTED'});expect(f.calls.filter(x=>x.method!=='GET')).toHaveLength(0);
}));
