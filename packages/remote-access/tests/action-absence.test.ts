import {test,expect} from 'vitest';import {createServer} from 'node:http';import {OpenWorkV2} from '../src/adapters/openwork-v2-01857.js';
test.each([{status:404,code:'session_unavailable',listStatus:200,accepted:true},{status:404,code:'session_not_in_workspace',listStatus:200,accepted:false},{status:404,code:'not_found',listStatus:200,accepted:false},{status:403,code:'forbidden',listStatus:200,accepted:false},{status:404,code:'session_unavailable',listStatus:403,accepted:false}])('deletion requires measured absence and a readable workspace list: %j',async f=>{
 let gone=false,writes=0;const server=createServer((req,res)=>{
  res.setHeader('content-type','application/json');let value:unknown;
  if(req.url==='/health')value={ok:true,version:'0.18.57'};
  else if(req.method==='DELETE'){writes++;gone=true;res.statusCode=204;res.end();return;}
  else if(req.url?.endsWith('/active'))value={data:{}};
  else if(req.url?.includes('/session?')){res.statusCode=gone?f.listStatus:200;value={data:[],cursor:{next:null}};}
  else if(gone){res.statusCode=f.status;value={code:f.code};}
  else value={data:{id:'chat',title:'Synthetic',time:{updated:1},model:null}};
  res.end(JSON.stringify(value));
 });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{const a=server.address();if(!a||typeof a==='string')throw Error('Port');const adapter=new OpenWorkV2(async()=>({origin:`http://127.0.0.1:${a.port}`,token:'synthetic'}),true,undefined,false,false,false,false,false,true);await adapter.health();const signal=new AbortController().signal,preview=await adapter.readSessionActions('owned','chat',signal);const action=adapter.deleteSession('owned','chat',preview.revision,signal);if(f.accepted)expect(await action).toBe('chat');else await expect(action).rejects.toBeDefined();expect(writes).toBe(1);}finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
