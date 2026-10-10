import {test,expect} from 'vitest';
import {createServer} from 'node:http';
import {OpenWorkV2} from '../src/adapters/openwork-v2-01857.js';

for(const f of [
 {qualified:false,writes:true,version:'0.18.57',read:false,write:false},
 {qualified:true,writes:false,version:'0.18.57',read:true,write:false},
 {qualified:true,writes:true,version:'unknown',read:false,write:false},
 {qualified:true,writes:true,version:'0.18.57',read:true,write:true},
])test('skills require independent qualification and compatible health '+JSON.stringify(f),async()=>{
 const server=createServer((_q,r)=>{r.setHeader('Content-Type','application/json');r.end(JSON.stringify({ok:true,version:f.version}))});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{const a=server.address();if(!a||typeof a==='string')throw Error('Port');const adapter=new OpenWorkV2(async()=>({origin:`http://127.0.0.1:${a.port}`,token:'synthetic'}),f.writes,undefined,false,false,false,false,false,false,false,false,f.qualified);await adapter.health();expect(adapter.capabilities.skillsRead===true).toBe(f.read);expect(adapter.capabilities.skillsWrite===true).toBe(f.write);expect(adapter.capabilities.skillsSelect===true).toBe(f.write)}finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()))}
});

test('attachment sends also require skill selection qualification before any native request',async()=>{
 let requests=0;
 const adapter=new OpenWorkV2(async()=>{requests++;throw Error('No native request allowed')},true,undefined,false,true);
 adapter.capabilities.skillsRead=true;
 adapter.capabilities.attachments=true;
 adapter.capabilities.skillsSelect=false;
 await expect(adapter.sendAttachments('owned','chat',{text:'Synthetic',messageId:'synthetic-message',files:[],selectedSkillIds:['skill_'+'a'.repeat(64)]},new AbortController().signal)).rejects.toMatchObject({code:'UNSUPPORTED_ACTION'});
 expect(requests).toBe(0);
});
