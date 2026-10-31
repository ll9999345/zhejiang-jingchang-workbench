import {randomUUID} from 'node:crypto';
import {promises as fs,constants} from 'node:fs';
import path from 'node:path';
import {safeId,userError} from './workspace.mjs';

const states=new Set(['queued','sending','completed','failed','cancelled','uncertain']);
const terminal=new Set(['completed','failed','cancelled','uncertain']);
const hash=/^[a-f0-9]{64}$/;
const maxBytes=256*1024;
const mutations=new Map();
const stamp=()=>new Date().toISOString();
const fail=()=>userError('图片分类留痕损坏或无法读取；已停止发送，请保留数据并检查本机记录',409);
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}};

// Every string in a receipt comes from a bounded local field, a digest, a fixed
// local message, or the separately normalized/redacted classification result.
// Request bodies, image URLs, credentials and upstream exceptions never enter
// this store. Keeping this namespace separate avoids the generic jobs schema.
export function assetClassificationReceiptStore(data){
 let rootPromise;
 async function directory(){
  if(!rootPromise)rootPromise=(async()=>{
   const root=await fs.realpath(data),dir=path.join(root,'asset-classification-tasks');
   await fs.mkdir(dir,{recursive:true,mode:0o700});
   const st=await fs.lstat(dir);
   if(!st.isDirectory()||st.isSymbolicLink()||await fs.realpath(dir)!==dir)throw fail();
   return dir;
  })();
  return rootPromise;
 }
 async function syncDirectory(dir){
  const handle=await fs.open(dir,'r');
  try{await handle.sync();}catch(error){if(!['EINVAL','ENOTSUP','EBADF'].includes(error.code))throw error;}finally{await handle.close();}
 }
 function validate(value,id){
  const keys=new Set(['version','id','kind','requestId','assetId','projectId','media','platform','model','promptDigest','authorization','consent','bindingDigest','status','createdAt','updatedAt','owner','sendIntentAt','finishedAt','result','error']);
  if(!value||value.version!==1||value.kind!=='asset-classification'||value.id!==id||value.requestId!==id||!safeId(id)||!safeId(value.assetId)||!states.has(value.status)||!hash.test(value.bindingDigest)||!hash.test(value.media?.sha256)||!hash.test(value.promptDigest)||!hash.test(value.platform?.baseUrlDigest)||!value.authorization||!Number.isSafeInteger(value.owner?.pid)||typeof value.owner.instanceId!=='string')throw fail();
  if(Object.keys(value).some(key=>!keys.has(key))||value.owner.pid<1||!safeId(value.owner.instanceId)||typeof value.model!=='string'||value.model.length>200||value.platform.protocol!=='openai-compatible'||!safeId(value.platform.id)||typeof value.platform.origin!=='string'||value.platform.origin.length>2048||value.consent!==true||!Number.isFinite(Date.parse(value.createdAt))||!Number.isFinite(Date.parse(value.updatedAt)))throw fail();
  if(Object.keys(value.media).sort().join(',')!=='sha256,size,type'||!['image/png','image/jpeg','image/webp'].includes(value.media.type)||!Number.isSafeInteger(value.media.size)||value.media.size<1||value.media.size>10*1024*1024)throw fail();
  if(Object.keys(value.platform).sort().join(',')!=='baseUrlDigest,id,origin,protocol')throw fail();
  const auth=value.authorization;
  if(Object.keys(auth).sort().join(',')!=='budget,consent,credentialConsent,credentialSource,currency,model,origin,requestLimit,sendImage'||auth.origin!==value.platform.origin||auth.model!==value.model||auth.sendImage!==true||auth.requestLimit!==1||auth.consent!==true||!['CNY','USD'].includes(auth.currency)||!['manual','miao-local'].includes(auth.credentialSource)||typeof auth.credentialConsent!=='boolean'||!Number.isFinite(auth.budget)||auth.budget<0||auth.budget>1_000_000)throw fail();
  if(value.projectId!==''&&!safeId(value.projectId))throw fail();
  if(value.status==='completed'&&(!value.result||typeof value.result!=='object'))throw fail();
  return value;
 }
 async function readFile(file,id,{missing=false,attempt=0}={}){
  let handle;
  try{
   const st=await fs.lstat(file);if(!st.isFile()||st.isSymbolicLink()||st.size<1||st.size>maxBytes)throw fail();
   handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);const opened=await handle.stat();
   if(opened.dev!==st.dev||opened.ino!==st.ino){await handle.close();handle=null;if(attempt<3)return readFile(file,id,{missing,attempt:attempt+1});throw fail();}
   return validate(JSON.parse(await handle.readFile('utf8')),id);
  }catch(error){if(error.code==='ENOENT'&&missing)return null;if(error.status)throw error;throw fail();}finally{await handle?.close();}
 }
 async function read(id,{missing=false}={}){
  if(!safeId(id))throw userError('图片分类任务编号无效');
  const dir=await directory();
  // A first-writer-wins terminal receipt is an immutable commit marker. This
  // also prevents two Node processes racing cancellation and success from
  // resurrecting work, even when their ordinary atomic JSON writes overlap.
  return await readFile(path.join(dir,id+'.terminal'),id,{missing:true})||readFile(path.join(dir,id+'.json'),id,{missing});
 }
 async function write(value,{create=false}={}){
  validate(value,value.id);const encoded=JSON.stringify(value);if(Buffer.byteLength(encoded)>maxBytes)throw fail();
  const dir=await directory(),file=path.join(dir,value.id+'.json');
  if(!create){const committed=await readFile(path.join(dir,value.id+'.terminal'),value.id,{missing:true});if(committed)return committed;}
  const pending=file+'.pending-'+randomUUID();
  let handle;
  try{
   handle=await fs.open(pending,'wx',0o600);await handle.writeFile(encoded);await handle.sync();await handle.close();handle=null;
   // Publish a new primary only after all bytes are durable. A polling reader
   // must never observe the empty/partial JSON of a just-created request.
   if(create)await fs.link(pending,file);
   if(terminal.has(value.status)){
    // Publish only fully written bytes. link() is an atomic no-overwrite claim,
    // unlike rename(); a killed writer cannot leave an empty terminal marker.
    try{await fs.link(pending,path.join(dir,value.id+'.terminal'));}
    catch(error){if(error.code!=='EEXIST')throw error;return read(value.id);}
   }
   if(!create)await fs.rename(pending,file);
   await syncDirectory(dir);return value;
  }finally{await handle?.close();}
 }
 async function all(){
  const dir=await directory(),files=await fs.readdir(dir),rows=[];
  for(const file of files){const match=/^([a-zA-Z0-9_-]{1,100})\.json$/.exec(file);if(match)rows.push(await read(match[1]));}
  return rows;
 }
 async function update(id,change){
  const key=path.join(await directory(),id),previous=mutations.get(key)||Promise.resolve();
  const next=previous.catch(()=>{}).then(async()=>{const row=await read(id);const changed=await change(row);return changed===false?row:write(row);});
  mutations.set(key,next);try{return await next;}finally{if(mutations.get(key)===next)mutations.delete(key);}
 }
 function visible(value){
  const {owner,bindingDigest,...publicValue}=value;
  return structuredClone(publicValue);
 }
 async function recover({instanceId,active}={}){
  const recovered=[];
  for(const row of await all()){
   if(!['queued','sending'].includes(row.status)||row.owner.instanceId===instanceId||active?.has(row.id)||alive(row.owner.pid))continue;
   const sent=row.status==='sending';
   const next=await update(row.id,current=>{
    if(current.status!==row.status)return false;
    current.status=sent?'uncertain':'cancelled';current.updatedAt=stamp();current.finishedAt=current.updatedAt;
    current.error={code:sent?'classification_interrupted':'classification_not_sent',message:sent?'图片分类发送后服务中断，结果与费用待确认；不会自动重发':'图片分类在发送前中断，未恢复发送；如需继续请重新确认并使用新编号',status:409};
   });recovered.push(visible(next));
  }
  return {recovered};
 }
 return {directory,read,write,update,all,visible,recover};
}
