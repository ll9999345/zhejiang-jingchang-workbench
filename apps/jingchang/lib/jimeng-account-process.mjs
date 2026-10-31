import {spawn} from 'node:child_process';
import {stripVTControlCharacters} from 'node:util';
import {jimengEnvironment} from './jimeng-cli-process.mjs';
import {userError} from './workspace.mjs';

const allowedHosts=new Set(['jimeng.jianying.com','dreamina.capcut.com']);
function documents(text){
 const clean=stripVTControlCharacters(String(text));let start=-1,depth=0,quoted=false,escaped=false;const out=[];
 for(let i=0;i<clean.length;i++){const c=clean[i];if(start<0){if(c==='{'){start=i;depth=1;}continue;}if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}if(c==='"')quoted=true;else if(c==='{')depth++;else if(c==='}'&&!--depth){try{out.push(JSON.parse(clean.slice(start,i+1)));}catch{}start=-1;}}
 return out;
}
function layers(value,depth=0){if(depth>4||!value||typeof value!=='object'||Array.isArray(value))return[];return[value,...['data','result'].flatMap(k=>layers(value[k],depth+1))];}
export function verificationUri(value){
 if(typeof value!=='string'||value.length>2048)return null;try{const u=new URL(value);if(u.protocol!=='https:'||!allowedHosts.has(u.hostname)||u.port||u.username||u.password||u.hash||[...u.searchParams.keys()].some(k=>/token|secret|password|device|authorization|access|refresh/i.test(k)))return null;return u.href;}catch{return null;}
}
// Only known fields cross the process boundary. Raw output and account tokens
// never become an error message, receipt, HTTP response or diagnostic log.
export function parseJimengAccount(text,action){
 const docs=documents(text);if(docs.length!==1)return{kind:'unknown'};const rows=layers(docs[0]),statuses=rows.flatMap(v=>['status','error','state'].map(k=>v[k])).filter(v=>typeof v==='string').map(v=>v.toLowerCase());
 const failed=rows.some(v=>v.success===false||v.ok===false||v.code!==undefined&&!['0','200'].includes(String(v.code)));
 if(action==='login'){
  const v=rows.find(v=>v.device_code!==undefined||v.verification_uri!==undefined||v.user_code!==undefined);
  if(v){const uri=verificationUri(v.verification_uri);if(!uri||typeof v.device_code!=='string'||!/^[\x21-\x7e]{8,4096}$/.test(v.device_code)||typeof v.user_code!=='string'||!/^[-A-Za-z0-9]{4,32}$/.test(v.user_code)||failed||!Number.isInteger(v.expires_in)||v.expires_in<=0||v.interval!==undefined&&(!Number.isInteger(v.interval)||v.interval<=0||v.interval>86400))return{kind:'unknown'};
   const expires=Math.min(v.expires_in,1800),interval=v.interval===undefined?5:Math.max(5,v.interval);
   return{kind:'challenge',verificationUri:uri,userCode:v.user_code,deviceCode:v.device_code,expiresIn:expires,intervalSeconds:interval};
  }
 }
 const authorized=!failed&&(rows.some(v=>v.logged_in===true||v.authorized===true)||statuses.some(v=>['authorized','authenticated','logged_in','success','succeeded','completed'].includes(v))||rows.some(v=>typeof v.access_token==='string'&&v.access_token.length>0));
 if(['login','check'].includes(action)&&authorized)return{kind:'authorized'};
 if(action==='check'&&statuses.includes('slow_down'))return{kind:'slow_down'};
 if(action==='check'&&statuses.some(v=>['pending','authorization_pending','waiting'].includes(v)))return{kind:'pending'};
 if(statuses.some(v=>['expired_token','expired','access_denied','denied','failed','error'].includes(v))||failed)return{kind:'failed'};
 if(action==='credit'){
  const keys=['total_credit','credit_count'],balances=[];
  for(const key of keys){const values=rows.filter(v=>Object.hasOwn(v,key)).map(v=>v[key]);if(values.some(v=>typeof v!=='number'||!Number.isFinite(v)||v<0||v>1e12)||new Set(values).size>1)return{kind:'unknown'};if(values.length)balances.push({field:key,value:values[0]});}
  if(balances.length)return{kind:'credit',balances};
 }
 if(action==='logout'&&rows.some(v=>v.success===true||v.ok===true||v.code===0||v.code==='0'||v.status==='success'))return{kind:'logged_out'};
 return{kind:'unknown'};
}
export async function runJimengAccountProcess(executable,args,{cwd,env=process.env,signal,timeoutMs=30000,maxBytes=65536,action}={}){
 if(signal?.aborted)throw userError('已停止本机账号等待；请自行核对官方CLI状态',499);
 return new Promise((resolve,reject)=>{
  let child,stdout='',total=0,error,timer,killTimer,finished=false;
  const terminate=e=>{if(error||finished)return;error=e;const kill=s=>{try{if(process.platform!=='win32'&&child?.pid)process.kill(-child.pid,s);else child?.kill(s);}catch{}};kill('SIGTERM');killTimer=setTimeout(()=>kill('SIGKILL'),400);killTimer.unref();};
  const abort=()=>terminate(userError('已停止本机账号等待；未重试，官方状态可能已变化',499));
  try{child=spawn(executable,args,{cwd,env:jimengEnvironment(env),shell:false,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe'],windowsHide:true});}catch{return reject(userError('账号程序未启动；未自动重试',502));}
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();timer=setTimeout(()=>terminate(userError('账号操作超时；请先核对官方状态，不会自动重试',504)),timeoutMs);timer.unref();
  child.stdout.setEncoding('utf8');const count=n=>{total+=n;if(total>maxBytes){terminate(userError('账号输出超过本机界限；原操作未重试',502));return false;}return !error;};
  child.stdout.on('data',chunk=>{if(count(Buffer.byteLength(chunk)))stdout+=chunk;});child.stderr.on('data',chunk=>count(chunk.length));
  child.once('error',()=>{error||=userError('账号程序启动或通信失败；未自动重试',502);});
  child.once('close',code=>{if(finished)return;finished=true;clearTimeout(timer);if(!error)clearTimeout(killTimer);signal?.removeEventListener('abort',abort);const parsed=parseJimengAccount(stdout,action);stdout='';if(error)return reject(error);if(code!==0&&!['pending','slow_down'].includes(parsed.kind))return reject(userError('官方CLI未确认本次账号操作，请手动核对；不会自动重试',502));resolve(parsed);});
 });
}
