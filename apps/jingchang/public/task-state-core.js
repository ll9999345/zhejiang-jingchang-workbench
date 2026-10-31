import {serviceDisplayText} from './model-service-labels.js';
// Presentation only: these helpers never start, resume or modify a task.
const states={
 stopping:{label:'正在停止',active:true,tone:'warning',detail:'正在停止本机等待；原请求不会重发'},
 stopped:{label:'已停止等待',terminal:true,tone:'warning',detail:'本机已停止等待；不代表上游已取消'},
 uncertain:{label:'结果待核对',terminal:true,tone:'warning',detail:'已提交的原请求结果待核对，不会自动重发'},
 queued:{label:'排队中',active:true,tone:'neutral',detail:'等待开始处理；尚无完成进度'},
 preparing:{label:'准备中',active:true,tone:'neutral',detail:'正在准备任务'},
 pending:{label:'待执行',active:true,tone:'neutral',detail:'等待执行'},
 submitting:{label:'提交中',active:true,tone:'active',detail:'正在提交请求；尚未确认上游结果'},
 running:{label:'进行中',active:true,tone:'active',detail:'正在处理；服务未提供可核实的完成比例'},
 completed:{label:'已完成',terminal:true,tone:'success',detail:'任务已完成'},
 failed:{label:'失败',terminal:true,tone:'danger',detail:'任务失败，请查看任务记录'},
 cancelled:{label:'已停止',terminal:true,tone:'warning',detail:'本机已停止等待；不代表上游已取消'},
 interrupted:{label:'已中断',terminal:true,tone:'warning',detail:'本机执行已中断，请查看原任务'},
 paused:{label:'已暂停',terminal:true,tone:'warning',detail:'任务已暂停'},
 incomplete:{label:'未完整完成',terminal:true,tone:'warning',detail:'仅保留已收到的部分结果'},
 partial:{label:'部分完成',terminal:true,tone:'warning',detail:'部分结果已保留，仍有未完成项'},
 awaiting_input:{label:'等待补充参数',tone:'warning',detail:'等待补充参数并确认；不会自动继续'},
 'awaiting-confirmation':{label:'待确认',tone:'warning',detail:'等待明确确认；尚未开始后续处理'},
 expired:{label:'已过期',terminal:true,tone:'neutral',detail:'原确认或上传会话已过期'}
};
const names={'gemini-cli-chat':'Gemini文字与看图','canvas-run':'画布执行',comfy:'工作流生成','image-api':'图片生成','canvas-llm':'语言模型',studio:'创作任务',runninghub:'云工作流',render:'视频导出','library-crop':'图片批量裁剪','library-copy':'素材收藏','library-backup':'素材库整库备份','library-restore':'素材库整库恢复','folder-import':'文件夹导入','lora-upload':'LoRA 上传',conversation:'对话','conversation-image':'对话生图','conversation-agent':'对话 Agent'};
const string=value=>typeof value==='string'?value.trim():'';
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

function measuredProgress(job,status){
 // A queued task has no generation percentage. Generic progress contains
 // protocol placeholders in this app, so only explicit completed units count.
 if(['queued','preparing','pending','submitting','awaiting-confirmation'].includes(status))return null;
 if(['library-backup','library-restore'].includes(job.kind)&&Number.isSafeInteger(job.completedSteps)&&Number.isSafeInteger(job.totalSteps)&&job.totalSteps>0&&job.completedSteps>=0&&job.completedSteps<=job.totalSteps){
  return {value:job.completedSteps,total:job.totalSteps,unit:'步',ratio:job.completedSteps/job.totalSteps};
 }
 if(job.kind==='canvas-run'&&Array.isArray(job.steps)&&job.steps.length&&job.steps.every(step=>record(step)&&typeof step.status==='string')){
  const value=job.steps.filter(step=>step.status==='completed').length,total=job.steps.length;
  return{value,total,unit:'步',ratio:value/total};
 }
 if(job.kind==='comfy'&&Number.isSafeInteger(job.count)&&job.count>0&&Array.isArray(job.items)){
  const seen=new Set();
  for(const item of job.items){
   if(!record(item)||!Number.isSafeInteger(item.index)||item.index<0||item.index>=job.count||seen.has(item.index)||typeof item.status!=='string')return null;
   seen.add(item.index);
  }
  const value=job.items.filter(item=>item.status==='completed').length,total=job.count;
  return{value,total,unit:'批次',ratio:value/total};
 }
 return null;
}

export function taskPresentation(job){
 if(!record(job)||!string(job.id))return null;
 const status=string(job.status)||'unknown',definition=states[status]||{label:'状态未知',tone:'neutral',detail:'暂时无法确认任务状态'},active=definition.active===true;
 // Older Comfy records mark an unacknowledged submission as failed, without
 // setting uncertain. Its submitting item is the durable evidence to retain.
 const uncertain=!active&&status!=='completed'&&(job.uncertain===true||job.kind==='comfy'&&Array.isArray(job.items)&&job.items.some(item=>item?.status==='submitting'&&!item.promptId));
 const progress=measuredProgress(job,status);
 return{
  id:string(job.id),status,label:uncertain?'提交结果待核实':definition.label,
  detail:string(job.message)||(uncertain?'尚未确认原请求结果，请查看原任务；不会自动重新提交':progress?`已完成 ${progress.value} / ${progress.total} ${progress.unit}`:definition.detail),
  name:serviceDisplayText(string(job.name),names[job.kind]||'任务'),active,progress,
  tone:uncertain?'warning':definition.tone,terminal:definition.terminal===true,
  projectId:string(job.projectId)||null
 };
}

function timestamp(job){
 const value=Date.parse(string(job.updatedAt)||string(job.createdAt));
 return Number.isFinite(value)?value:0;
}
function childOf(child,parent){
 if(parent.kind!=='canvas-run'||child.id===parent.id||child.projectId!==parent.projectId)return false;
 if(child.parentId===parent.id||child.parentJobId===parent.id)return true;
 if(!Array.isArray(parent.steps))return false;
 if(parent.steps.some(step=>step?.jobId===child.id))return true;
 // Comfy and image-api omit a parent field. The runner persists a unique
 // request ID before recording step.jobId, covering that small crash window.
 const prefix=parent.id+'-';
 if(typeof child.requestId!=='string'||!child.requestId.startsWith(prefix))return false;
 const index=child.requestId.slice(prefix.length);
 if(!/^(0|[1-9]\d*)$/.test(index))return false;
 const step=parent.steps[Number(index)];
 if(!record(step))return false;
 const kind=['runninghub','image-api','canvas-llm','studio'].includes(step.kind)?step.kind:'comfy';
 return child.kind===kind;
}

export function visibleTaskJobs(jobs){
 if(!Array.isArray(jobs))return[];
 const unique=new Map();
 for(const job of jobs){
  const state=taskPresentation(job);if(!state)continue;
  const prior=unique.get(state.id);
  if(!prior||timestamp(job)>timestamp(prior.job))unique.set(state.id,{job,state});
 }
 const entries=[...unique.values()];
 const visible=entries.filter(entry=>!entries.some(parent=>childOf(entry.job,parent.job)&&(parent.state.active||!entry.state.active)));
 return visible.map(entry=>entry.job).sort((a,b)=>timestamp(b)-timestamp(a)||a.id.localeCompare(b.id));
}

export function selectTask(jobs,{projectId}={}){
 const visible=visibleTaskJobs(jobs).map(job=>({job,state:taskPresentation(job)}));
 const priority=entry=>{
  const current=Boolean(projectId)&&entry.state.projectId===projectId;
  if(entry.state.active)return current?0:1;
  if(!entry.state.terminal)return current?2:3;
  return current?4:5;
 };
 visible.sort((a,b)=>priority(a)-priority(b)||(a.state.active&&b.state.active?Number(b.job.kind==='canvas-run')-Number(a.job.kind==='canvas-run'):0)||timestamp(b.job)-timestamp(a.job)||a.state.id.localeCompare(b.state.id));
 return visible[0]?.state||null;
}

export function taskFingerprint(state){
 if(!state)return'';
 // Exclude job snapshots, credentials, transport progress and elapsed time.
 return JSON.stringify([state.id,state.status,state.label,state.detail,state.name,state.active,state.progress?[state.progress.value,state.progress.total,state.progress.unit,state.progress.ratio]:null,state.tone,state.terminal,state.projectId]);
}
