import path from 'node:path';
import os from 'node:os';
import {promises as fs,constants,createReadStream} from 'node:fs';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolveLocalCli} from './local-cli-status.mjs';
import {userError} from './workspace.mjs';
import {codexJsonlReply} from './codex-chat-wire.mjs';

const hashFile=async file=>{const hash=createHash('sha256');for await(const b of createReadStream(file,{flags:constants.O_RDONLY|constants.O_NOFOLLOW}))hash.update(b);return hash.digest('hex');};
const knownVersions=new Set(['0.147.0']);
export async function codexChatProgram({env=process.env,platform=process.platform,arch=process.arch}={}){
 const tool=await resolveLocalCli('codex',{env,platform});
 if(!tool.executable)return{public:{available:false,message:'未找到Codex CLI；旧版本与帮助入口保留'}};
 if(platform!=='darwin')return{public:{available:false,message:'本轮文字执行器需要macOS隔离；未执行程序'}};
 const entry=await fs.realpath(tool.executable),root=path.resolve(path.dirname(entry),'..');let pkg;
 try{pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));}catch{}
 if(pkg?.name!=='@openai/codex'||!knownVersions.has(pkg.version))return{public:{available:false,message:'此CLI安装或版本尚未核对；未代运行、升级或替换'}};
 const suffix=arch==='arm64'?'aarch64-apple-darwin':arch==='x64'?'x86_64-apple-darwin':null;
 if(!suffix)return{public:{available:false,message:'此CPU架构尚未核对'}};
 const binary=path.join(root,'node_modules','@openai','codex-darwin-'+arch,'vendor',suffix,'bin','codex');
 if(await fs.realpath(binary)!==binary||!(await fs.lstat(binary)).isFile())throw userError('Codex程序不是预期普通文件');await fs.access(binary,constants.X_OK);
 const binarySha256=await hashFile(binary),entrySha256=await hashFile(entry);
 return{executable:binary,readRoot:path.dirname(binary),public:{available:true,id:'codex',name:'Codex CLI',version:pkg.version,protocol:'codex-plain-v1',sha256:binarySha256,entrySha256,message:'已校验程序文件；未检查账户、未调用模型'}};
}
export function codexChatArguments({model,brokerUrl,cwd,imagePaths=[]}){
 if(typeof model!=='string'||!model.trim()||model.length>200||/[\x00-\x1f]/.test(model))throw userError('CLI型号无效');
 const url=new URL(brokerUrl);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/v1'||url.username||url.password||url.search||url.hash)throw userError('CLI只能连接本次镜场转发端口');
 const args=['exec','--ignore-user-config','--ignore-rules','--ephemeral','--sandbox','read-only','--skip-git-repo-check','--json','--color','never','--model',model,'--cd',cwd];
 const overrides=['model_provider="jingchang"','model_providers.jingchang.name="Jingchang"','model_providers.jingchang.base_url='+JSON.stringify(brokerUrl),'model_providers.jingchang.wire_api="responses"','model_providers.jingchang.env_key="JINGCHANG_CODEX_BROKER"','model_providers.jingchang.requires_openai_auth=false','model_providers.jingchang.request_max_retries=0','model_providers.jingchang.stream_max_retries=0','features.shell_tool=false','features.shell_snapshot=false','features.multi_agent=false','web_search="disabled"','project_doc_max_bytes=0','approval_policy="never"','mcp_servers={}','analytics.enabled=false','feedback.enabled=false','log_dir='+JSON.stringify(path.join(cwd,'logs')),'sqlite_home='+JSON.stringify(path.join(cwd,'state'))];
 for(const v of overrides)args.push('-c',v);
 for(const image of imagePaths){if(!path.isAbsolute(image)||path.dirname(image)!==cwd)throw userError('CLI参考图必须是本次工作目录副本');args.push('--image',image);}
 return[...args,'-'];
}
export async function codexChatInvocation(program,{cwd,port,brokerUrl,token,model,imagePaths=[],env=process.env}={}){
 if(program?.public?.available!==true||!program.executable)throw userError('Codex执行器尚不可用');
 if(!Number.isSafeInteger(port)||port<1||port>65535||typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))throw userError('本机转发范围无效');
 const work=await fs.realpath(cwd),binary=await fs.realpath(program.executable);if(binary!==program.executable)throw userError('CLI程序路径已变化');
 const home=path.join(work,'program-runtime');await fs.mkdir(home,{mode:0o700});
 const aliases=p=>[p,path.join('/System/Volumes/Data',p)],roots=['/Users','/Volumes','/private/var/folders','/var/folders','/private/tmp','/tmp','/private/var/tmp','/var/tmp'];
 const profile=path.join(work,'cli-network-and-files.sb');
 const policy=['(version 1)','(allow default)','(deny network*)',`(allow network-outbound (remote ip "localhost:${port}"))`,'(deny mach-lookup)','(allow mach-lookup (global-name "com.apple.bsd.dirhelper") (global-name "com.apple.system.opendirectoryd.libinfo"))','(deny file-write*)','(deny process-exec)',`(allow process-exec (literal ${JSON.stringify(binary)}))`,...roots.flatMap(aliases).map(p=>'(deny file-read* (subpath '+JSON.stringify(p)+'))'),...aliases(work).map(p=>'(allow file-read* file-write* (subpath '+JSON.stringify(p)+'))'),...aliases(program.readRoot).map(p=>'(allow file-read* (subpath '+JSON.stringify(p)+'))'),'(allow file-read-metadata)'].join('\n')+'\n';
 await fs.writeFile(profile,policy,{flag:'wx',mode:0o600});
 const processEnv={PATH:env.PATH||'/usr/bin:/bin',HOME:env.HOME||os.homedir(),LANG:'en_US.UTF-8',TMPDIR:work,NO_COLOR:'1',TERM:'dumb',JINGCHANG_CODEX_BROKER:token};
 // This child-only variable is used for its documented CLI configuration
 // purpose. The host HOME/CODEX_HOME, CLI config and authentication stay intact.
 processEnv.CODEX_HOME=home;
 return{executable:'/usr/bin/sandbox-exec',args:['-f',profile,binary,...codexChatArguments({model,brokerUrl,cwd:work,imagePaths})],cwd:work,env:processEnv};
}
export async function runCodexChatProcess(call,{prompt,signal,timeoutMs=180000}={}){
 if(signal?.aborted)throw userError('已停止本机CLI等待',499);
 return new Promise((resolve,reject)=>{
  let child,out='',bytes=0,failure,timer,killTimer,finished=false;
  const stop=error=>{if(finished||failure)return;failure=error;const kill=s=>{try{if(child?.pid)process.kill(-child.pid,s);}catch{}};kill('SIGTERM');killTimer=setTimeout(()=>kill('SIGKILL'),500);killTimer.unref();};
  const abort=()=>stop(userError('已停止本机等待；不代表远端任务取消，原请求不会重发',499));
  try{child=spawn(call.executable,call.args,{cwd:call.cwd,env:call.env,shell:false,detached:true,stdio:['pipe','pipe','pipe']});}catch{return reject(userError('CLI未启动；不会自动重试'));}
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  timer=setTimeout(()=>stop(userError('CLI等待超时，原记录保留，不会自动重发',504)),timeoutMs);timer.unref();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',s=>{bytes+=Buffer.byteLength(s);if(bytes>2*1024**2)stop(userError('CLI输出超过2MiB，原记录保留'));else if(!failure)out+=s;});
  child.stderr.on('data',s=>{bytes+=s.length;if(bytes>2*1024**2)stop(userError('CLI输出超限，原记录保留'));});
  child.stdin.on('error',()=>{});child.stdin.end(prompt);
  child.on('error',()=>failure||=userError('CLI启动或通信失败，未重试'));
  child.on('close',code=>{if(finished)return;finished=true;clearTimeout(timer);if(!failure)clearTimeout(killTimer);signal?.removeEventListener('abort',abort);if(failure)return reject(failure);try{const reply=codexJsonlReply(out);out='';resolve({...reply,exitCode:code,complete:reply.complete&&code===0});}catch{reject(userError('CLI没有返回完整普通回答，原记录仍保留'));}});
 });
}
