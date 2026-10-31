import {spawn} from 'node:child_process';
import {stripVTControlCharacters} from 'node:util';
import {userError} from './workspace.mjs';

// Only operation-local output lives in memory; raw stdout/stderr is never logged.
export function parseJimengOutput(text,{expectedId}={}){
 const clean=stripVTControlCharacters(String(text));const documents=[];
 let start=-1,depth=0,quote=false,escape=false;
 for(let i=0;i<clean.length;i++){const c=clean[i];if(start<0){if(c==='{'){start=i;depth=1;}continue;}if(quote){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')quote=false;continue;}if(c==='"')quote=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0){try{documents.push(JSON.parse(clean.slice(start,i+1)));}catch{}start=-1;}}
 if(!documents.length)return{status:'uncertain',outputs:[],message:'CLI未返回完整任务记录，请保留原编号并在平台核对'};
 const ids=new Set(),statuses=[],outputs=[];let bad=false,failed=false;
 const mediaKeys=new Set(['images','videos','output','outputs','result','results','file','files','path','paths','file_path','filePath','download_url','download_urls','downloadUrl','image_url','image_urls','video_url','video_urls','url','urls']);
 function media(v,depth=0){if(depth>8)return;if(typeof v==='string'){if(v.length<=4096&&v.trim())outputs.push(v.trim());}else if(Array.isArray(v))v.slice(0,40).forEach(x=>media(x,depth+1));else if(v&&typeof v==='object')for(const [k,x]of Object.entries(v))if(mediaKeys.has(k))media(x,depth+1);}
 function visit(v,depth=0){if(depth>8||!v||typeof v!=='object')return;if(Array.isArray(v)){v.slice(0,40).forEach(x=>visit(x,depth+1));return;}for(const k of ['submit_id','submitId','task_id','taskId'])if(v[k]!==undefined){if(typeof v[k]!=='string'||!/^[-\w]{1,128}$/.test(v[k]))bad=true;else ids.add(v[k]);}for(const k of ['gen_status','status'])if(typeof v[k]==='string')statuses.push(v[k].toLowerCase());if(v.success===false||v.ok===false)failed=true;if(v.code!==undefined&&!['0','200'].includes(String(v.code)))failed=true;
 for(const [k,x]of Object.entries(v))if(mediaKeys.has(k))media(x);for(const k of ['data','result'])visit(v[k],depth+1);if(typeof v.result_json==='string'){try{const x=JSON.parse(v.result_json);visit(x,depth+1);media(x);}catch{bad=true;}}else if(v.result_json){visit(v.result_json,depth+1);media(v.result_json);}}
 documents.forEach(d=>visit(d));if(ids.size>1||expectedId&&ids.size&&!ids.has(expectedId)||bad)return{status:'uncertain',outputs:[],message:'CLI任务编号或结果结构不一致，未导入媒体'};
 const upstreamId=[...ids][0];if(failed||statuses.some(x=>['fail','failed','error','rejected','cancelled','canceled'].includes(x)))return{status:'failed',...(upstreamId?{upstreamId}:{}),outputs:[],message:'CLI返回失败；原任务不会自动重提'};
 const values=[...new Set(outputs)];if(values.length>20)return{status:'uncertain',...(upstreamId?{upstreamId}:{}),outputs:[],message:'CLI媒体数量超出范围，未导入'};
 const processing=statuses.some(x=>['queued','queue','pending','processing','querying','running','submitted','generating'].includes(x));
 return{status:values.length&&!processing?'completed':upstreamId||expectedId?'pending':'uncertain',...(upstreamId?{upstreamId}:{}),outputs:processing?[]:values,message:processing?'原任务仍在排队或生成；不会自动查询或重提':values.length?'CLI返回媒体，待本机校验并导入':'已记录原任务；可单独确认后查询'};
}
export function jimengEnvironment(env=process.env){const out={NO_COLOR:'1',FORCE_COLOR:'0',TERM:'dumb'};for(const k of ['PATH','HOME','USERPROFILE','HOMEDRIVE','HOMEPATH','SystemRoot','SYSTEMROOT','WINDIR','PATHEXT','LANG','LC_ALL','TMPDIR','TMP','TEMP'])if(typeof env[k]==='string')out[k]=env[k];return out;}
export async function runJimengProcess(executable,args,{cwd,env=process.env,signal,timeoutMs=60000,maxBytes=1024*1024,onTaskId=async()=>{}}={}){
 if(signal?.aborted)throw userError('本机等待已停止；不代表平台任务取消',499);
 return new Promise((resolve,reject)=>{
  let child,total=0,stdout='',failure,timer,killTimer,finished=false;let writes=Promise.resolve(),seen;
  const kill=()=>{try{if(process.platform!=='win32'&&child?.pid)process.kill(-child.pid,'SIGTERM');else child?.kill('SIGTERM');}catch{}killTimer=setTimeout(()=>{try{if(process.platform!=='win32'&&child?.pid)process.kill(-child.pid,'SIGKILL');else child?.kill('SIGKILL');}catch{}},400);killTimer.unref();};
  const stop=e=>{if(failure||finished)return;failure=e;kill();};const abort=()=>stop(userError('已停止本机等待，请核对原任务；不会重提',499));
  signal?.addEventListener('abort',abort,{once:true});
  try{child=spawn(executable,args,{cwd,env:jimengEnvironment(env),shell:false,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe'],windowsHide:true});}catch{signal?.removeEventListener('abort',abort);reject(userError('CLI进程未启动，未自动重试'));return;}
  timer=setTimeout(()=>stop(userError('CLI等待超时，原结果待核对；不会自动重试',504)),timeoutMs);timer.unref();child.stdout.setEncoding('utf8');
  const count=bytes=>{total+=bytes;if(total>maxBytes){stop(userError('CLI输出超过本机界限，原任务待核对',413));return false;}return true;};
  child.stdout.on('data',chunk=>{if(failure||!count(Buffer.byteLength(chunk)))return;stdout+=chunk;const r=parseJimengOutput(stdout);if(r.upstreamId&&!seen){seen=r.upstreamId;writes=writes.then(()=>onTaskId(seen)).catch(()=>{const error=userError('原任务编号落盘未完成，已停止本机等待');if(finished)failure||=error;else stop(error);});}else if(r.upstreamId&&seen!==r.upstreamId)stop(userError('CLI返回了不同任务编号，已停止本机等待'));});child.stderr.on('data',chunk=>count(chunk.length));
  child.on('error',()=>{failure||=userError('CLI进程启动或通信失败；不会自动重试');});
  child.on('close',async code=>{if(finished)return;finished=true;clearTimeout(timer);if(!failure)clearTimeout(killTimer);signal?.removeEventListener('abort',abort);await writes;const result=parseJimengOutput(stdout);stdout='';if(failure)return reject(failure);if(code!==0&&!result.upstreamId&&result.status!=='completed')return reject(userError('CLI异常退出且没有完整任务编号；请先核对平台记录'));resolve({...result,exitCode:code});});
 });
}
