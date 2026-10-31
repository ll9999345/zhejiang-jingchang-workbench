import {taskPresentation,selectTask,taskFingerprint,visibleTaskJobs} from './task-state-core.js';

const eventName='jingchang:task-snapshot';
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
let installed;

export function taskProgressMarkup(job,esc=escape,idPrefix=''){
 const state=taskPresentation(job);if(!state)return'';
 const progress=state.progress,ids=name=>idPrefix?` id="${esc(idPrefix+'-'+name)}"`:'';
 const label=progress?`已完成 ${progress.value} / ${progress.total} ${progress.unit}`:state.active?'等待结果 · 进度不可估算':state.label;
 const meter=progress||state.active?`<div class="task-progress-track"${ids('container')} role="progressbar" aria-label="${esc(label)}"${progress?` aria-valuemin="0" aria-valuemax="${progress.total}" aria-valuenow="${progress.value}"`:' data-indeterminate="true"'}><span${ids('bar')}${progress?` style="width:${Math.max(0,Math.min(1,progress.ratio))*100}%"`:''}></span></div>`:`<div${ids('container')}></div>`;
 return meter+`<small class="task-progress-label"${ids('text')}>${esc(label)}</small>`;
}

// Only the presentation crosses this event boundary, never task inputs,
// credentials, request bodies or provider authorization.
export function publishTaskSnapshot(value){
 if(Array.isArray(value)){value.forEach(publishTaskSnapshot);return;}
 if(!value?.kind||!value?.status)return;
 const state=taskPresentation(value);
 if(state)document.dispatchEvent(new CustomEvent(eventName,{detail:state}));
}

export function installTaskMotion({getProjectId=()=>null,openTasks}={}){
 if(installed)return installed;
 const root=document.createElement('aside');root.id='task-island';root.dataset.expanded='false';root.dataset.active='false';root.setAttribute('aria-label','任务状态');
 root.innerHTML='<button type="button" class="task-island-toggle" aria-expanded="false" aria-controls="task-island-body"><span class="task-island-status-dot" aria-hidden="true"></span><span class="task-island-label">镜场</span><span class="task-island-summary">本机工作区</span><span class="task-island-chevron" aria-hidden="true">⌄</span></button><div class="task-island-body" id="task-island-body" hidden></div><span class="task-island-announcement" role="status" aria-live="polite"></span>';
 document.body.append(root);
 const toggle=root.querySelector('.task-island-toggle'),body=root.querySelector('.task-island-body'),announce=root.querySelector('.task-island-announcement');
 let jobs=[],focusedId=null,scope=null,scopeKnown=false,stale=false,busy=false,rerun=false,disposed=false,lastFingerprint='',timer,latestState=null;
 const observed=new Map(),eventSnapshots=new Map();let lastReadAt=0;
 const expanded=()=>root.dataset.expanded==='true';
 function expand(value){root.dataset.expanded=String(value);toggle.setAttribute('aria-expanded',String(value));body.hidden=!value;if(value&&!matchMedia('(prefers-reduced-motion: reduce)').matches)body.animate([{opacity:0,translate:'0 -7px'},{opacity:1,translate:'0 2px'},{opacity:1,translate:'0 0'}],{duration:330,easing:'cubic-bezier(.2,.8,.2,1)'});}
 function available(){return visibleTaskJobs(jobs.filter(job=>!scope||job.projectId===scope));}
 function selected(){const top=selectTask(available(),{projectId:scope}),raw=focusedId&&available().find(job=>job.id===focusedId);return top?.active?top:raw?taskPresentation(raw):top;}
 function render(){
  const state=selected()||latestState,key=JSON.stringify([taskFingerprint(state),stale,available().map(job=>[job.id,job.status,job.name]),!!openTasks]);
  if(key===lastFingerprint)return;lastFingerprint=key;
  root.dataset.active=String(!!state?.active);root.dataset.status=state?.status||'idle';root.dataset.tone=stale?'warning':state?.tone||'neutral';
  root.querySelector('.task-island-label').textContent=stale?'状态待确认':state?.label||'镜场';
  root.querySelector('.task-island-summary').textContent=state?.progress?`${state.progress.value}/${state.progress.total} ${state.progress.unit}`:state?.name||'本机工作区';
  const progress=state?.progress,ratio=progress?Math.max(0,Math.min(1,progress.ratio)):null;
  const meter=state?.active||progress?`<div class="task-island-meter" role="progressbar" aria-label="${escape(progress?progress.unit+'完成进度':'等待服务返回结果')}"${progress?` aria-valuemin="0" aria-valuemax="${escape(progress.total)}" aria-valuenow="${escape(progress.value)}"`:' data-indeterminate="true"'}><span class="task-island-fill"${ratio===null?'':` style="width:${ratio*100}%"`}></span></div>`:'';
  body.innerHTML=`<p class="task-island-title">${escape(state?.name||'本机任务')}</p><p class="task-island-detail">${escape(stale?'暂时无法确认最新状态。已保留上一次记录，刷新后重新核对。':state?.detail||'当前没有生成任务。任务开始后，这里会显示实际执行状态。')}</p>${meter}<p class="task-island-meta">${escape(progress?`已完成 ${progress.value} / ${progress.total} ${progress.unit}；不表示模型内部进度。`:state?.active?'服务尚未提供可核实的完成比例。':state?'最近任务 · '+state.label:'项目数据保存在本机。')}</p><div class="task-island-actions"><button type="button" data-island-refresh>刷新状态</button>${openTasks?'<button type="button" data-island-open>任务详情 ↗</button>':''}</div>${available().length>1?`<div class="task-island-list" aria-label="最近任务">${available().slice(0,5).map(job=>{const item=taskPresentation(job);return item?`<button type="button" data-island-job="${escape(job.id)}" aria-pressed="${String(state?.id===job.id)}"><span>${escape(item.name)}</span><small>${escape(item.label)}</small></button>`:'';}).join('')}</div>`:''}`;
  const announcement=state?`${state.name}，${stale?'状态待确认':state.label}${progress?`，完成 ${progress.value} / ${progress.total} ${progress.unit}`:''}`:'当前没有执行任务';
  if(announce.textContent!==announcement)announce.textContent=announcement;position();
 }
 function schedule(){clearTimeout(timer);if(!disposed)timer=setTimeout(refresh,document.hidden?15000:latestState?.active?1800:6000);}
 async function read(url){const response=await fetch(url,{cache:'no-store',headers:{Accept:'application/json'},signal:AbortSignal.timeout(8000)});if(!response.ok)throw Error('任务记录暂不可读');return response.json();}
 async function refresh(){
  if(disposed)return;if(busy){rerun=true;return;}busy=true;lastReadAt=Date.now();
  const current=getProjectId()||null;
  if(!scopeKnown||current!==scope){scope=current;scopeKnown=true;focusedId=null;latestState=null;jobs=[];observed.clear();eventSnapshots.clear();lastFingerprint='';}
  const requestScope=scope;
  try{
   const records=await read('/api/jobs?includeActive=true'+(scope?'&projectId='+encodeURIComponent(scope):''));
   if(disposed||requestScope!==getProjectId()&&!(requestScope===null&&!getProjectId())){rerun=true;return;}
   const byId=new Map(records.map(job=>[job.id,job]));let unconfirmed=false;
   // A running job may fall beyond the server's 200-row list window. Continue
   // checking its own record; absence from the list is never completion.
   for(const [id,old] of observed)if(!byId.has(id)||['folder-import','library-copy'].includes(old.kind)){
    try{byId.set(id,await read('/api/jobs/'+encodeURIComponent(id)));}catch{byId.set(id,old);unconfirmed=true;}
   }
   if(requestScope!==(getProjectId()||null)){rerun=true;return;}
   jobs=[...byId.values()].sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
   observed.clear();for(const job of jobs)if(taskPresentation(job)?.active)observed.set(job.id,job);
   latestState=selected();stale=unconfirmed;render();
  }catch{stale=true;render();}
  finally{busy=false;if(rerun){rerun=false;queueMicrotask(refresh);}else schedule();}
 }
 toggle.addEventListener('click',()=>expand(!expanded()));
 root.addEventListener('click',event=>{const target=event.target.closest('button');if(target?.hasAttribute('data-island-refresh'))refresh();if(target?.hasAttribute('data-island-open'))openTasks?.();if(target?.dataset.islandJob){focusedId=target.dataset.islandJob;latestState=selected();render();}});
 document.addEventListener(eventName,event=>{const state=event.detail;if(!state?.id||scope&&state.projectId!==scope)return;const prior=eventSnapshots.get(state.id);if(prior&&taskFingerprint(prior)===taskFingerprint(state))return;eventSnapshots.set(state.id,state);if(state.active){latestState=state;const focused=jobs.find(job=>job.id===focusedId);if(focused&&taskPresentation(focused)?.terminal)focusedId=null;}if(!document.hidden&&(!prior||prior.status!==state.status)){clearTimeout(timer);timer=setTimeout(refresh,Math.max(0,1000-(Date.now()-lastReadAt)));}});
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();else schedule();});
 document.addEventListener('keydown',event=>{if(event.key==='Escape'&&expanded()&&!document.querySelector('dialog[open]')){expand(false);toggle.focus();}});
 // This root survives canvas redraws. On wide screens it occupies the actual
 // gap between heading and toolbar instead of covering either one.
 function position(){const header=document.querySelector('.app>.topbar'),heading=header?.querySelector('.project-heading'),actions=header?.querySelector('.top-actions');if(innerWidth>1250&&heading&&actions){const left=heading.getBoundingClientRect().right+12,right=actions.getBoundingClientRect().left-12,gap=right-left,required=root.dataset.active==='true'?300:190;root.dataset.anchored=String(gap>=required);if(gap>=required){root.style.left=(left+right)/2+'px';root.style.top=header.getBoundingClientRect().top+13+'px';root.style.removeProperty('right');return;}}root.dataset.anchored='false';root.style.removeProperty('left');root.style.removeProperty('top');root.style.removeProperty('right');if(innerWidth>800){const side=document.querySelector('.app .panel,.studio .right-panel'),rect=side?.getBoundingClientRect();if(rect&&rect.width>0)root.style.right=rect.width+22+'px';const connection=document.querySelector('main>.conversation .connection');if(connection)root.style.top=Math.max(144,connection.getBoundingClientRect().bottom+12)+'px';}}
 window.addEventListener('resize',position);
 new MutationObserver(()=>requestAnimationFrame(position)).observe(document.querySelector('#app')||document.body,{childList:true,subtree:true});
 installControls();render();position();refresh();
 installed={refresh,dispose(){disposed=true;clearTimeout(timer);root.remove();}};return installed;
}

function installControls(){
 const pressed=new Set(),reduced=matchMedia('(prefers-reduced-motion: reduce)');
 function prepareRanges(){for(const range of document.querySelectorAll('input[type="range"]'))updateRange(range);}
 function updateRange(range){const min=Number(range.min||0),max=Number(range.max||100),value=Number(range.value),ratio=max>min?(value-min)/(max-min):0;range.style.setProperty('--range-progress',Math.max(0,Math.min(1,ratio))*100+'%');}
 document.addEventListener('pointerdown',event=>{
  const range=event.target.closest('input[type="range"]');if(range&&!range.disabled){range.classList.add('is-range-dragging');pressed.add(range);updateRange(range);}
  const button=event.target.closest('button');if(button&&!button.disabled&&!button.classList.contains('port')&&!reduced.matches){button.getAnimations().filter(animation=>animation.id==='jade-button-spring').forEach(animation=>animation.cancel());button.classList.add('is-spring-pressed');pressed.add(button);}
 },true);
 function release(){for(const element of pressed){element.classList.remove('is-range-dragging','is-spring-pressed');if(element.matches('input[type="range"]'))updateRange(element);else if(element.isConnected&&!reduced.matches){const animation=element.animate([{scale:'.965'},{scale:'1.035',offset:.38},{scale:'.989',offset:.65},{scale:'1.006',offset:.83},{scale:'1'}],{duration:410,easing:'cubic-bezier(.2,.7,.25,1)'});animation.id='jade-button-spring';}}pressed.clear();}
 document.addEventListener('pointerup',release,true);document.addEventListener('pointercancel',release,true);window.addEventListener('blur',release);
 document.addEventListener('input',event=>{if(event.target.matches('input[type="range"]'))updateRange(event.target);},true);
 document.addEventListener('keydown',event=>{if(['Enter',' '].includes(event.key)&&event.target.matches('button')&&!event.target.disabled&&!reduced.matches){event.target.classList.add('is-spring-pressed');pressed.add(event.target);}});
 document.addEventListener('keyup',event=>{if(['Enter',' '].includes(event.key))release();});
 let pending=false;new MutationObserver(()=>{if(pending)return;pending=true;requestAnimationFrame(()=>{pending=false;prepareRanges();});}).observe(document.body,{subtree:true,childList:true});prepareRanges();
}
