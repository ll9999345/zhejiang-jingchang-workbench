import {promises as fs} from 'node:fs';
import path from 'node:path';
import {atomicJson,safeId,userError} from './workspace.mjs';

const names=['input.json','result.json','state.json','error.json'];
const cacheName='list-summary.json';
function validRow(row,id){return row&&row.id===id&&safeId(row.projectId)&&typeof row.name==='string'&&row.name.length<=120&&typeof row.createdAt==='string'&&row.createdAt.length<=100&&typeof row.status==='string'&&row.status.length<=80&&Number.isSafeInteger(row.nodes)&&row.nodes>=0&&row.nodes<=1500&&typeof row.canResume==='boolean'&&(row.error===undefined||typeof row.error==='string'&&row.error.length<=2000);}

// Derived listing data only. Execution/get/resume always read the original
// signed input and durable result; this cache never authorizes an operation.
export function clipboardPasteIndex({read}){
 const memory=new Map();
 const remember=(dir,value)=>{memory.delete(dir);memory.set(dir,value);if(memory.size>4096)memory.delete(memory.keys().next().value);return value.row;};
 async function fingerprints(dir){return Promise.all(names.map(async name=>{try{const s=await fs.lstat(path.join(dir,name),{bigint:true});if(!s.isFile()||s.isSymbolicLink()||s.size>16n*1024n**2n)throw userError('粘贴记录文件无效');return [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].map(String).join(':');}catch(e){if(e.code==='ENOENT')return null;throw e;}}));}
 async function build(dir,id,source){
  const saved=await read(dir,'input.json',true);if(!saved)return null;
  if(saved.input.requestId!==id||!safeId(saved.input.projectId))throw userError('粘贴原记录身份不一致',409);
  const done=await read(dir,'result.json',true),state=await read(dir,'state.json',true),error=done?null:await read(dir,'error.json',true);
  const row={id,projectId:saved.input.projectId,name:saved.input.sourceSnapshot.name,createdAt:saved.createdAt,status:done?'completed':state?.status||'preparing',nodes:done?.nodeIds.length||saved.input.nodeIds.length,canResume:!done,...(error?{error:error.message}:{})};
  if(!validRow(row,id))throw userError('粘贴记录摘要无效');return {version:1,source,row};
 }
 async function row(dir,id){
  const source=await fingerprints(dir);if(!source[0])return null;const key=JSON.stringify(source),known=memory.get(dir);
  if(known&&JSON.stringify(known.source)===key)return remember(dir,known);
  let disk;try{const file=path.join(dir,cacheName),st=await fs.lstat(file);if(st.isFile()&&!st.isSymbolicLink()&&st.size<=32768)disk=JSON.parse(await fs.readFile(file,'utf8'));}catch{/* A damaged derived cache must not hide the authoritative record. */}
  if(disk?.version===1&&JSON.stringify(disk.source)===key&&validRow(disk.row,id))return remember(dir,disk);
  const value=await build(dir,id,source);return value?remember(dir,value):null;
 }
 async function publish(dir,id){
  const source=await fingerprints(dir),value=await build(dir,id,source);if(!value)return;
  if(JSON.stringify(source)!==JSON.stringify(await fingerprints(dir)))return;
  await atomicJson(path.join(dir,cacheName),value);remember(dir,value);
 }
 return {row,publish};
}

export function clipboardPastePage(rows,options){
 if(options===undefined)return rows;
 const integer=(value,fallback)=>value===undefined?fallback:typeof value==='number'&&Number.isSafeInteger(value)?value:typeof value==='string'&&/^(0|[1-9]\d{0,6})$/.test(value)?Number(value):NaN;
 const limit=integer(options.limit,50),offset=integer(options.offset,0);
 if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0||offset>1e6)throw userError('粘贴记录分页范围无效');
 const items=rows.slice(offset,offset+limit);return{items,total:rows.length,offset,limit,nextOffset:offset+items.length<rows.length?offset+items.length:null};
}
