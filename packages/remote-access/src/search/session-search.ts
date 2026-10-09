import {randomUUID,createHash} from 'node:crypto';
import {BridgeError,assertContract,type Session} from '../contract/index.js';
type Page={data:Session[];cursor:string|null};
type ReadPage=(wid:string,cursor:string|undefined,signal:AbortSignal)=>Promise<Page>;
interface Scan {
 device:string;wid:string;query:string;expires:number;tail:Session[];
 nativeCursor:string|undefined;nativeDone:boolean;seen:Set<string>;
}
export interface SearchPage {data:Session[];cursor:string|null;scanned:number;complete:boolean}
const normalize=(text:string)=>text.normalize('NFKC').toLowerCase();
export class SessionSearch {
 private cursors=new Map<string,Scan>();
 constructor(private list:ReadPage,private now:()=>number=Date.now){}
 close(){this.cursors.clear();}
 async read(device:string,wid:string,text:string,cursor:string|undefined,signal:AbortSignal,authorize:()=>void=()=>{}):Promise<SearchPage>{
  signal.throwIfAborted();authorize();
  const trimmed=text.trim();
  if(!trimmed||[...text].length>200||/[\p{Cc}\p{Cf}]/u.test(text)||Buffer.byteLength(text)>800)throw new BridgeError('INVALID_REQUEST',400);
  const query=normalize(trimmed),now=this.now();
  for(const [key,value] of this.cursors)if(value.expires<=now)this.cursors.delete(key);
  let scan:Scan;
  if(cursor!==undefined){
   if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(cursor))throw new BridgeError('INVALID_REQUEST',400);
   const stored=this.cursors.get(cursor);
   if(!stored||stored.device!==device||stored.wid!==wid||stored.query!==query)throw new BridgeError('SEARCH_EXPIRED',409);
   scan={...stored,tail:[...stored.tail],seen:new Set(stored.seen)};
  }else scan={device,wid,query,expires:now+300000,tail:[],nativeCursor:undefined,nativeDone:false,seen:new Set()};
  const matches:Session[]=[];let scanned=0,pages=0;
  while(scanned<500&&matches.length<50){
   signal.throwIfAborted();authorize();
   if(!scan.tail.length){
    if(scan.nativeDone||pages>=10)break;
    if(scan.seen.size>=1024)throw new BridgeError('SEARCH_LIMIT',422);
    const page=await this.list(wid,scan.nativeCursor,signal);pages++;
    signal.throwIfAborted();authorize();
    assertContract('SessionList',page.data);
    if(page.data.some(s=>s.workspaceId!==wid)||page.cursor!==null&&(typeof page.cursor!=='string'||!page.cursor||Buffer.byteLength(page.cursor)>4096))throw new BridgeError('INVALID_UPSTREAM',502);
    const cursorHash=page.cursor===null?null:createHash('sha256').update(page.cursor).digest('hex');
    if(cursorHash&&scan.seen.has(cursorHash))throw new BridgeError('INVALID_UPSTREAM',502);
    scan.tail=[...page.data];scan.nativeCursor=page.cursor??undefined;scan.nativeDone=page.cursor===null;
    if(cursorHash)scan.seen.add(cursorHash);
    if(!scan.tail.length)continue;
   }
   const row=scan.tail.shift();if(!row)break;scanned++;
   if(normalize(row.title).includes(query))matches.push(row);
  }
  signal.throwIfAborted();authorize();const complete=scan.nativeDone&&!scan.tail.length;
  let next:string|null=null;
  if(!complete){
   // Transient bounded metadata, never transcripts or a persistent search index.
   let count=[...this.cursors.values()].filter(v=>v.device===device).length;
   for(const [key,value] of this.cursors)if(value.device===device&&count>=4){this.cursors.delete(key);count--;}
   while(this.cursors.size>=256){const first=this.cursors.keys().next().value;if(first===undefined)break;this.cursors.delete(first);}
   next=randomUUID();this.cursors.set(next,scan);
  }
  return {data:matches,cursor:next,scanned,complete};
 }
}
