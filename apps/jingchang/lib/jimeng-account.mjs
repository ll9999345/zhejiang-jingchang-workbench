import path from 'node:path';
import {promises as fs,constants} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {resolveLocalCli} from './local-cli-status.mjs';
import {userError,safeId} from './workspace.mjs';
import {guardArchiveSecrets} from './task-history-schema.mjs';
import {runJimengAccountProcess} from './jimeng-account-process.mjs';
import {jimengOperationGuard} from './jimeng-operation-guard.mjs';
const actions=new Set(['login','check','credit','logout']),stamp=()=>new Date().toISOString(),hash=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const messages={challenge:'请由本人打开官方网页、输入授权码并登录；完成后手动检查一次',authorized:'官方CLI已确认授权；没有自动查询积分或发起生成',slow_down:'官方要求放慢检查；最短间隔已增加，仍需你明确再检查一次',pending:'授权尚未完成；请完成官方页面后再次明确检查，不会自动轮询',credit:'已读取本次积分快照；不代表生成权限、实际费用或预算扣费上限',logged_out:'官方CLI已确认退出；工程、素材与原任务保留',unknown:'CLI未返回已识别的账号结构；请手动核对，原操作不会自动重试'};
export function jimengAccountService({data,env=process.env,platform=process.platform,resolveTool=resolveLocalCli,runProcess=runJimengAccountProcess,guard=jimengOperationGuard(),beforeAccountChange=async()=>false,timeoutMs=30000,now=()=>Date.now()}={}){
 let session=null,lastCheck=null,active=null,preparing=false;const operations=new Map(),starting=new Map();
 const base=path.join(path.resolve(data),'jimeng-account-requests');
 async function directory(){await fs.mkdir(base,{recursive:true,mode:0o700});if(await fs.realpath(base)!==base)throw userError('账号记录目录异常；未执行',409);return base;}
 async function read(name){let handle;try{const file=path.join(await directory(),name);handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);const s=await handle.stat();if(!s.isFile()||s.size>16384)throw Error();return JSON.parse(await handle.readFile('utf8'));}catch(e){if(e.code==='ENOENT')return null;throw userError('账号记录缺失或异常；未重新执行',409);}finally{await handle?.close();}}
 async function publish(name,value){guardArchiveSecrets(value);const dir=await directory(),tmp=path.join(dir,name+'.pending-'+randomUUID());const h=await fs.open(tmp,'wx',0o600);try{await h.writeFile(JSON.stringify(value));await h.sync();}finally{await h.close();}await fs.link(tmp,path.join(dir,name));}
 async function program(){const t=await resolveTool('jimeng',{env,platform});if(t.unsupportedWsl||platform==='win32'&&/\.(cmd|bat)$/i.test(t.executable))throw userError('账号操作需要本机原生dreamina；WSL或脚本入口未接入',501);if(!t.executable)throw userError('未找到本机dreamina；不会自动安装或登录',404);const file=await fs.realpath(t.executable),h=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);try{const s=await h.stat();if(!s.isFile()||s.size<1)throw userError('本机程序无效');const digest=createHash('sha256');for await(const bytes of h.createReadStream({autoClose:false}))digest.update(bytes);return{file,descriptor:{name:path.basename(file),pathDigest:hash(file),size:s.size,sha256:digest.digest('hex')}};}finally{await h.close();}}
 function expire(){if(session?.deviceCode&&now()>=session.expiresAt){session.deviceCode='';session.userCode='';session.verificationUri='';session.state='expired';}}
 function publicSession(){expire();if(!session)return null;return{id:session.id,state:session.state,createdAt:session.createdAt,expiresAt:new Date(session.expiresAt).toISOString(),nextCheckAt:new Date(session.nextCheckAt).toISOString(),intervalSeconds:session.intervalSeconds,...(session.state==='waiting'?{userCode:session.userCode,verificationUri:session.verificationUri}:{})};}
 function requireSession(id){expire();if(!safeId(id)||!session||session.id!==id||session.state!=='waiting'||!session.deviceCode)throw userError('原授权会话已失效；不会恢复令牌或自动重新登录',409);return session;}
 async function preview(body){if(!body||!actions.has(body.action)||Object.keys(body).some(k=>!['action','sessionId'].includes(k)))throw userError('请选择固定账号操作');if(body.action==='check'){const s=requireSession(body.sessionId);if(now()<s.nextCheckAt)throw userError('请等待官方要求的最短检查间隔',429);}else if(body.sessionId!==undefined)throw userError('此操作不能携带授权会话');const p=await program(),plan={version:1,service:'local-dreamina-account',action:body.action,program:p.descriptor,...(body.action==='check'?{sessionId:body.sessionId}:{}),requestLimit:1};return{plan,fingerprint:hash(plan),accountChecked:false,credentialStorage:'official-cli',arguments:body.action==='login'?['login','--headless']:body.action==='check'?['login','checklogin','--device_code=[仅服务端会话内存]','--poll=0']:body.action==='credit'?['user_credit']:['logout']};}
 async function status(){return{session:publicSession(),activeOperation:active?{id:active.id,action:active.action,status:active.status}:null,lastCheck:structuredClone(lastCheck),accountChecked:!!lastCheck,loggedIn:lastCheck?.loggedIn??null,source:'memory-only-observation',message:'此读取未启动CLI、查询账户或恢复授权；显示的只是本进程上次观察'};}
 async function get(id){if(!safeId(id))throw userError('账号请求编号无效');const manifest=await read(id+'.json');if(!manifest||manifest.version!==1||manifest.id!==id||!actions.has(manifest.action)||!manifest.plan||hash(manifest.plan)!==manifest.fingerprint)throw userError('没有此账号请求或收据异常',404);try{guardArchiveSecrets(manifest);}catch{throw userError('账号收据结构异常；不返回原始内容',409);}if(Object.keys(manifest).some(k=>!['version','id','action','plan','fingerprint','createdAt','pid','consent'].includes(k))||manifest.plan.version!==1||manifest.plan.service!=='local-dreamina-account'||manifest.plan.action!==manifest.action||manifest.plan.requestLimit!==1||Object.keys(manifest.plan).some(k=>!['version','service','action','program','requestLimit',...(manifest.action==='check'?['sessionId']:[])].includes(k))||!manifest.plan.program||Object.keys(manifest.plan.program).sort().join(',')!=='name,pathDigest,sha256,size'||manifest.consent?.accountNetwork!==true||manifest.consent.officialLoginStateChange!==(manifest.action!=='credit')||Object.keys(manifest.consent).some(k=>!['accountNetwork','officialLoginStateChange'].includes(k)))throw userError('账号收据结构异常',409);const local=operations.get(id),end=await read(id+'.result.json');if(end){try{guardArchiveSecrets(end);}catch{throw userError('账号结果收据异常；不返回原始内容',409);}if(Object.keys(end).some(k=>!['status','outcome','message','finishedAt'].includes(k)))throw userError('账号结果收据异常',409);}const{pid,...visible}=manifest;return{...visible,status:local?.status||end?.status||'interrupted',message:local?.message||(!local&&['challenge','pending','slow_down'].includes(end?.outcome)?'旧请求仅供核对；短时授权材料未恢复，需明确新建授权':end?.message)||'原操作结果待核对；重启后不恢复授权、不自动重发',...(end?{finishedAt:end.finishedAt,outcome:end.outcome}:{}),...(local?.balances?{balances:structuredClone(local.balances)}:{}),session:publicSession(),recovered:!local};}
 function forget(id){if(!safeId(id)||session?.id!==id)throw userError('此授权会话不存在',404);if(active)throw userError('请先停止并等待账号操作结束',409);session.deviceCode='';session.userCode='';session.verificationUri='';session.state='forgotten';return{ok:true,message:'已丢弃镜场内存中的授权材料；未退出官方CLI，也未删除任何文件'};}
 async function start(body){
  if(!body||!actions.has(body.action)||!safeId(body.requestId)||body.consent!==true||body.allowAccountRequest!==true||body.action!=='credit'&&body.allowCredentialChange!==true||body.action==='credit'&&body.allowCredentialChange!==undefined||Object.keys(body).some(k=>!['action','requestId','fingerprint','consent','allowAccountRequest',...(body.action==='credit'?[]:['allowCredentialChange']),...(body.action==='check'?['sessionId']:[])].includes(k)))throw userError('请分别确认此账号操作、联网范围和官方CLI凭据变化');
  const waiting=starting.get(body.requestId);if(waiting){if(!isDeepStrictEqual(waiting.body,body))throw userError('此请求编号已用于另一账号操作',409);return waiting.promise;}
  const promise=startPrepared(structuredClone(body));starting.set(body.requestId,{body:structuredClone(body),promise});try{return await promise;}finally{starting.delete(body.requestId);}
 }
 async function startPrepared(body){
  const old=await read(body.requestId+'.json');if(old){if(old.fingerprint!==body.fingerprint||old.action!==body.action||old.plan.sessionId!==body.sessionId)throw userError('此请求编号已用于另一账号范围，不会重新执行',409);return get(body.requestId);}
  if(active||preparing)throw userError('已有账号操作进行中，请读取原记录',409);
  const release=guard.acquire({account:body.action!=='credit'});preparing=true;let accepted=false;
  try{
   if(body.action!=='credit'&&await beforeAccountChange())throw userError('包含即梦的画布或创作任务仍在运行，请先停止并等待结束',409);
   if(body.action==='login'&&publicSession()?.state==='waiting')throw userError('已有待确认授权；先检查原会话或明确丢弃，再创建新授权',409);
   const p=await preview({action:body.action,...(body.sessionId?{sessionId:body.sessionId}:{})});if(p.fingerprint!==body.fingerprint)throw userError('账号操作或本机程序变化，请重新预览',409);
   const record={version:1,id:body.requestId,action:body.action,plan:p.plan,fingerprint:p.fingerprint,createdAt:stamp(),pid:process.pid,consent:{accountNetwork:true,officialLoginStateChange:body.action!=='credit'}};
   try{await publish(record.id+'.json',record);}catch(e){if(e.code==='EEXIST'){const previous=await read(record.id+'.json');if(previous.fingerprint!==body.fingerprint||previous.action!==body.action)throw userError('此请求编号已用于另一账号范围',409);return get(record.id);}throw e;}
   const op={...record,status:'running',message:'正在执行本次明确确认的账号操作',controller:new AbortController()};active=op;operations.set(op.id,op);accepted=true;void execute(op,release).catch(()=>{});return get(op.id);
  }finally{preparing=false;if(!accepted)release();}
 }
 async function execute(op,release){let result;
  try{
   const p=await program();if(!isDeepStrictEqual(p.descriptor,op.plan.program))throw userError('程序已变化；未自动重新执行',409);const dir=path.join(await directory(),'work',op.id);await fs.mkdir(dir,{recursive:true,mode:0o700});if(await fs.realpath(dir)!==dir||!(await fs.lstat(dir)).isDirectory())throw userError('账号工作目录异常；未执行程序',409);let args;
   if(op.action==='check'){const s=requireSession(op.plan.sessionId);if(now()<s.nextCheckAt)throw userError('原授权检查间隔尚未结束',429);s.nextCheckAt=now()+s.intervalSeconds*1000;args=['login','checklogin','--device_code='+s.deviceCode,'--poll=0'];}
   else args=op.action==='login'?['login','--headless']:op.action==='credit'?['user_credit']:['logout'];
   if(op.controller.signal.aborted)throw userError('本机账号等待已停止',499);
   result=await runProcess(p.file,args,{action:op.action,cwd:dir,env,signal:op.controller.signal,timeoutMs});args=[];
   if(op.action==='login')lastCheck=null;
   if(result.kind==='challenge'){
    if(op.action!=='login')throw userError('账号返回与命令不符');session={id:randomUUID(),state:'waiting',deviceCode:result.deviceCode,userCode:result.userCode,verificationUri:result.verificationUri,createdAt:stamp(),expiresAt:now()+result.expiresIn*1000,intervalSeconds:result.intervalSeconds,nextCheckAt:now()+result.intervalSeconds*1000};const id=session.id;const timer=setTimeout(()=>{if(session?.id===id)expire();},result.expiresIn*1000+10);timer.unref();
   }else if(result.kind==='authorized'){
    if(session){session.deviceCode='';session.userCode='';session.verificationUri='';session.state='authorized';}lastCheck={loggedIn:true,checkedAt:stamp(),action:op.action};
   }else if(result.kind==='credit'){op.balances=structuredClone(result.balances);lastCheck={loggedIn:true,checkedAt:stamp(),action:'credit',balances:structuredClone(result.balances)};}
   else if(result.kind==='logged_out'){if(session){session.deviceCode='';session.userCode='';session.verificationUri='';session.state='logged_out';}lastCheck={loggedIn:false,checkedAt:stamp(),action:'logout'};}
   else if(result.kind==='slow_down'&&op.action==='check'&&session){session.intervalSeconds+=5;session.nextCheckAt=now()+session.intervalSeconds*1000;}
   else if(result.kind==='failed'&&op.action==='check'&&session){session.deviceCode='';session.userCode='';session.verificationUri='';session.state='failed';}
   op.status=['failed','unknown'].includes(result.kind)?'failed':'completed';op.outcome=result.kind;op.message=messages[result.kind]||'官方CLI未确认本次账号状态；未自动重试';
  }catch{if(op.action==='check'&&session?.state==='waiting'&&!op.controller.signal.aborted){session.intervalSeconds*=2;session.nextCheckAt=now()+session.intervalSeconds*1000;}op.status=op.controller.signal.aborted?'cancelled':'interrupted';op.outcome='unknown';op.message=op.controller.signal.aborted?'已停止本机账号等待；官方状态可能已变化，请手动核对，未重试':'账号操作未完整确认；请手动核对官方状态，不会自动重试';}
  finally{
   if(result?.deviceCode)result.deviceCode='';result=null;
   const end={status:op.status,outcome:op.outcome,message:op.message,finishedAt:stamp()};op.status='saving';op.message='正在保存不含授权码和积分的操作收据';try{await publish(op.id+'.result.json',end);op.status=end.status;op.message=end.message;}catch{op.status='interrupted';op.message='账号结果收据未完整保存；原请求不重发，请手动核对';}
   if(active===op)active=null;release();
  }
 }
 async function stop(id){if(!safeId(id))throw userError('账号请求编号无效');const op=operations.get(id);if(op?.status==='running')op.controller.abort();return get(id);}
 return{preview,start,status,get,stop,forget};
}
