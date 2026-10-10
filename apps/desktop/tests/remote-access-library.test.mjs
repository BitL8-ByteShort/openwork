import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, existsSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {remoteAccessLibraryPath} from '../electron/remote-access.mjs';
const require=createRequire(import.meta.url);

test('source preview loads current bridge capabilities even with a stale staged bundle',()=>{
  const root=mkdtempSync(join(tmpdir(),'openwork-bridge-selection-'));
  try {
    const staged=join(root,'staged.cjs'),current=join(root,'current.cjs');
    writeFileSync(staged,'module.exports={attachments:false,renameSession:false};');
    writeFileSync(current,'module.exports={attachments:true,renameSession:true};');
    const selected=remoteAccessLibraryPath({isPackaged:false,packagedPath:staged,developmentPath:current,exists:existsSync});
    assert.deepEqual(require(selected),{attachments:true,renameSession:true});
  } finally {rmSync(root,{recursive:true,force:true});}
});
test('packaged application uses only its bundled bridge',()=>{
  const selected=remoteAccessLibraryPath({isPackaged:true,packagedPath:'/packaged/index.cjs',developmentPath:'/development/index.cjs',exists:()=>true});
  assert.equal(selected,'/packaged/index.cjs');
});
test('missing current bridge fails instead of silently loading another execution mode',()=>{
  for(const isPackaged of [true,false]) assert.throws(()=>remoteAccessLibraryPath({isPackaged,packagedPath:'/packaged/index.cjs',developmentPath:'/development/index.cjs',exists:path=>isPackaged?path.includes('development'):path.includes('packaged')}),/REMOTE_ACCESS_BUILD_MISSING/);
});
