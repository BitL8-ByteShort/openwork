import {test,expect} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {resolveServerConfig} from '../src/config.js';
import {readWorkspaceDefaultModel,writeWorkspaceDefaultModel} from '../src/workspace-default-model.js';
const a={providerID:'synthetic',modelID:'a'},b={providerID:'synthetic',modelID:'b'};
async function fixture(run:(config:Awaited<ReturnType<typeof resolveServerConfig>>)=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'default-cas-')),configPath=join(root,'server.json');
 await writeFile(configPath,JSON.stringify({workspaces:[],token:'synthetic',hostToken:'synthetic'}));
 try{const config=await resolveServerConfig({configPath,workspaces:[root]});await run(config)}finally{await rm(root,{recursive:true,force:true})}
}
test('conditional default rejects an intervening legacy desktop choice without overwriting it',()=>fixture(async config=>{
 const empty=await readWorkspaceDefaultModel(config,'owned');expect(empty.model).toBeNull();expect(empty.revision).toMatch(/^[a-f0-9]{64}$/);expect(empty.conditionalWrite).toBe(true);
 const first=await writeWorkspaceDefaultModel(config,'owned',a,empty.revision);
 await writeWorkspaceDefaultModel(config,'owned',b);
 await expect(writeWorkspaceDefaultModel(config,'owned',a,first.revision)).rejects.toMatchObject({status:409,code:'workspace_default_model_changed'});
 expect((await readWorkspaceDefaultModel(config,'owned')).model).toEqual(b);
}));
test('two writers holding one revision get exactly one successful native compare-and-set',()=>fixture(async config=>{
 const before=await writeWorkspaceDefaultModel(config,'owned',a);
 const writes=await Promise.allSettled([writeWorkspaceDefaultModel(config,'owned',b,before.revision),writeWorkspaceDefaultModel(config,'owned',{...b,variant:'high'},before.revision)]);
 expect(writes.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(writes.filter(x=>x.status==='rejected')).toHaveLength(1);
}));
test('legacy writes retain overwrite/null behavior while revisions remain monotonic across same-millisecond ABA edits',()=>fixture(async config=>{
 const first=await writeWorkspaceDefaultModel(config,'owned',a),stamp=first.updatedAt!;
 // A frozen wall clock must not restore an old revision when the value cycles.
 const old=Date.now;Date.now=()=>stamp;
 try{await writeWorkspaceDefaultModel(config,'owned',b);const back=await writeWorkspaceDefaultModel(config,'owned',a);expect(back.revision).not.toBe(first.revision);expect(back.updatedAt).toBeGreaterThan(stamp);
 await expect(writeWorkspaceDefaultModel(config,'owned',b,first.revision)).rejects.toMatchObject({status:409});
 const cleared=await writeWorkspaceDefaultModel(config,'owned',null);expect(cleared.model).toBeNull();}finally{Date.now=old}
}));

test('an independent SQLite connection cannot be overwritten using an earlier raw row/version',()=>fixture(async config=>{
 const {createWorkspaceKvStore}=await import('../src/workspace-kv-store.js');const {importNodeSqlite,runtimeDbPath}=await import('../src/runtime-db.js');
 await writeWorkspaceDefaultModel(config,'owned',a);
 const store=createWorkspaceKvStore({tableName:'workspace_default_models',valueColumn:'model_json',parse:JSON.parse,serialize:JSON.stringify});
 const captured=await store.getRow(config,'owned');expect(captured).toBeDefined();
 const {DatabaseSync}=await importNodeSqlite(),other=new DatabaseSync(runtimeDbPath(config));
 try{other.prepare('UPDATE workspace_default_models SET model_json = ?, updated_at = updated_at + 1 WHERE workspace_id = ?').run(JSON.stringify(b),'owned');expect(await store.setIfUnchanged(config,'owned',a,Date.now()+100,captured)).toBe(false);expect((await readWorkspaceDefaultModel(config,'owned')).model).toEqual(b)}finally{other.close()}
}));
