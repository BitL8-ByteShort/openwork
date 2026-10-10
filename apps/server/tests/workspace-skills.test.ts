import {test,expect} from 'vitest';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {readSkillFile} from '../src/skill-write-guard.js';
import {upsertSkill,deleteSkill,listSkills} from '../src/skills.js';
async function fixture(run:(root:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'skill-condition-'));try{await run(root)}finally{await rm(root,{recursive:true,force:true})}}
const skill=(description:string)=>({name:'owned-skill',description,content:'Instructions'});
test('a stale phone skill revision cannot overwrite a desktop edit',()=>fixture(async root=>{
 await upsertSkill(root,skill('Desktop choice'));
 const file=join(root,'.opencode/skills/owned-skill/SKILL.md'),before=await readFile(file,'utf8');
 await expect(upsertSkill(root,{...skill('Phone stale choice'),expectedRevision:'a'.repeat(64)})).rejects.toMatchObject({status:409,code:'skill_changed'});
 expect(await readFile(file,'utf8')).toBe(before);
}));
test('conditional create never takes over an existing skill name',()=>fixture(async root=>{
 await upsertSkill(root,skill('Keep existing'));
 await expect(upsertSkill(root,{...skill('Take over'),expectedRevision:null})).rejects.toMatchObject({status:409,code:'skill_changed'});
}));
test('conditional edits cannot follow a SKILL.md symlink outside the workspace',()=>fixture(async root=>{
 const outside=join(root,'outside.md'),dir=join(root,'.opencode/skills/owned-skill');await mkdir(dir,{recursive:true});await writeFile(outside,'Keep this');await symlink(outside,join(dir,'SKILL.md'));
 await expect(upsertSkill(root,{...skill('Overwrite'),expectedRevision:'a'.repeat(64)})).rejects.toMatchObject({code:'skill_protected'});expect(await readFile(outside,'utf8')).toBe('Keep this');
}));
test('conditional deletion preserves extra assets and rejects inherited entries',()=>fixture(async root=>{
 const owned=await upsertSkill(root,skill('Text skill'));await writeFile(join(root,'.opencode/skills/owned-skill','asset.txt'),'Keep asset');
 await expect(deleteSkill(root,'owned-skill',{expectedRevision:'a'.repeat(64)})).rejects.toMatchObject({code:'skill_protected'});expect(await readFile(join(root,'.opencode/skills/owned-skill/asset.txt'),'utf8')).toBe('Keep asset');
 expect(owned.path).toContain('SKILL.md');
}));
test('conditional create cannot add text to an existing asset-only directory',()=>fixture(async root=>{
 const dir=join(root,'.opencode/skills/owned-skill');await mkdir(dir,{recursive:true});await writeFile(join(dir,'asset.txt'),'Keep asset');
 await expect(upsertSkill(root,{...skill('Phone create'),expectedRevision:null})).rejects.toMatchObject({code:'skill_protected'});expect(await readFile(join(dir,'asset.txt'),'utf8')).toBe('Keep asset');
}));

test('conditional save and delete accept only the current revision, and a desktop ABA produces a new revision',()=>fixture(async root=>{
 const initial=await upsertSkill(root,skill('First'));const before=await readSkillFile(initial.path);
 await upsertSkill(root,{...skill('Phone current'),expectedRevision:before.revision});const next=await readSkillFile(initial.path);expect(next.content).toContain('Phone current');
 await upsertSkill(root,skill('First'));const back=await readSkillFile(initial.path);expect(back.revision).not.toBe(before.revision);
 await expect(deleteSkill(root,'owned-skill',{expectedRevision:next.revision})).rejects.toMatchObject({status:409});
 await deleteSkill(root,'owned-skill',{expectedRevision:back.revision});await expect(readFile(initial.path)).rejects.toMatchObject({code:'ENOENT'});
}));
test('two conditional writers on the same revision save exactly one complete text',()=>fixture(async root=>{
 const first=await upsertSkill(root,skill('First'));const {revision}=await readSkillFile(first.path);
 const writes=await Promise.allSettled(['A','B'].map(description=>upsertSkill(root,{...skill(description),expectedRevision:revision})));
 expect(writes.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(writes.filter(x=>x.status==='rejected')).toHaveLength(1);
}));
test('conditional create refuses inherited names and oversized text while legacy text behavior is retained',()=>fixture(async root=>{
 const nested=join(root,'.claude/skills/owned-skill');await mkdir(nested,{recursive:true});await writeFile(join(nested,'SKILL.md'),'---\nname: owned-skill\ndescription: Inherited\n---\nKeep');
 await expect(upsertSkill(root,{...skill('Create'),expectedRevision:null})).rejects.toMatchObject({code:'skill_changed'});
 await expect(upsertSkill(root,{name:'another-skill',description:'Large',content:'x'.repeat(65536),expectedRevision:null})).rejects.toMatchObject({code:'skill_too_large'});
 expect((await listSkills(root,false,false)).map(x=>x.description)).toEqual(['Inherited']);
}));
test('native catalog retains duplicate names, identifies protected sources and binds IDs to workspace',()=>fixture(async root=>{
 const {listWorkspaceSkillEntries,readWorkspaceSkillEntry,removeWorkspaceSkillEntry}=await import('../src/workspace-skill-entries.js');
 await upsertSkill(root,skill('Editable'));
 const inherited=join(root,'.claude/skills/owned-skill');await mkdir(inherited,{recursive:true});await writeFile(join(inherited,'SKILL.md'),'---\nname: owned-skill\ndescription: Read only\n---\nKeep');
 const catalog=await listWorkspaceSkillEntries(root),matching=catalog.items.filter(x=>x.name==='owned-skill');expect(matching).toHaveLength(2);expect(matching.filter(x=>x.editable)).toHaveLength(1);
 const protectedEntry=matching.find(x=>!x.editable)!;await expect(removeWorkspaceSkillEntry(root,protectedEntry.id,protectedEntry.revision)).rejects.toMatchObject({code:'skill_protected'});
 const other=join(root,'other');await mkdir(other);await expect(readWorkspaceSkillEntry(other,matching[0].id)).rejects.toMatchObject({code:'skill_not_found'});
}));
