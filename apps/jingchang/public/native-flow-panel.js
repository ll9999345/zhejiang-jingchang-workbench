import {nativeBranchMarkup} from './native-branch-core.js';
const statuses={ready:'已解析',resolved:'已解析',pending:'等待上游',blocked:'存在待处理项',completed:'完成',running:'运行中',queued:'排队中',interrupted:'中断',cancelled:'已停止',failed:'失败'};
const kinds={image:'图片',video:'视频',audio:'音频',text:'文本',file:'文件'};

export function nativeFlowResultMarkup(result,{nodeId,project,esc}){
 const names=new Map(project.nodes.map(node=>[node.id,node.title])),label=id=>names.get(id)||id;
 const pending=ids=>ids?.length?`<p class="native-flow-pending">等待上游：${ids.map(id=>esc(label(id))).join('、')}</p>`:'';
 const issues=values=>values?.length?`<ul class="native-flow-issues">${values.map(value=>`<li>${esc(value)}</li>`).join('')}</ul>`:'';
 const prompts=items=>items?.length?`<ol class="native-flow-prompts">${items.map(value=>`<li><pre>${esc(value)}</pre></li>`).join('')}</ol>`:'<p class="native-flow-empty">没有文字项</p>';
 const media=items=>items?.length?`<ol class="native-flow-media">${items.map(item=>`<li><a href="/media/${encodeURIComponent(item.assetId)}" target="_blank" rel="noopener">${esc(item.name||item.assetId)}</a><span>${esc(kinds[item.kind]||item.kind)} · 来源：${esc(label(item.sourceNodeId))}</span></li>`).join('')}</ol>`:'<p class="native-flow-empty">没有素材项</p>';
 const values=value=>`${pending(value?.pendingNodeIds)}${issues(value?.issues)}<h4>文字 · ${value?.promptItems?.length||0} 项</h4>${prompts(value?.promptItems)}<h4>素材 · ${value?.media?.length||0} 项</h4>${media(value?.media)}`;
 const output=result.nodes?.find(node=>node.nodeId===nodeId),job=result.resultJob;
 const revision=job?`任务快照版本 ${job.projectRevision} · 当前已保存项目版本 ${job.currentProjectRevision}`:`已保存项目版本 ${result.revision}`;
 return `<p class="native-flow-revision">${esc(revision)}</p>${job?`<p class="native-flow-note">任务 ${esc(job.id)} · ${esc(statuses[job.status]||job.status)} · ${esc(job.completedOutputNodes)} 个已完成结果节点${job.loopId?` · 循环第 ${esc(Number(job.roundIndex)+1)} 回合`:''}。下方内容按任务原始快照解析。</p>`:'<p class="native-flow-note">下方内容按已保存的画布解析。</p>'}${nativeBranchMarkup(job?.nativeBranch,esc,label)}<section class="native-flow-section"><h3>有序输入</h3>${values(result.inputs)}${result.inputs?.sources?.length?`<details><summary>按来源查看 · ${result.inputs.sources.length} 项</summary>${result.inputs.sources.map((source,index)=>`<section class="native-flow-source"><h4>${index+1}. ${esc(label(source.sourceNodeId))}${source.itemType?` · ${esc({generated:'生成结果','group-media':'组内素材','group-prompts':'组内提示词'}[source.itemType]||source.itemType)}`:''}</h4>${values(source)}</section>`).join('')}</details>`:''}</section><section class="native-flow-section"><h3>节点输出${output?` · ${esc(statuses[output.status]||output.status||'已解析')}`:''}</h3>${output?values(output):'<p class="native-flow-empty">此快照中没有当前节点。</p>'}</section><p class="native-flow-note">检查只读取文字、素材记录和已完成任务结果。是否能够执行，以画布运行前的检查为准。</p>`;
}

export async function openNativeFlowPanel({project,nodeId,api,modal,esc,dirty=false}){
 const node=project.nodes.find(item=>item.id===nodeId);if(!node)throw Error('当前节点已不存在');
 modal('检查输入 / 输出',`<section class="native-flow-panel"><h3>${esc(node.title)}</h3><p class="native-flow-note">只读检查，不保存画布，不提交生成任务。${dirty?'当前有未保存修改，本次读取最近已保存版本。':''}</p><form class="native-flow-filters"><label>查看来源<select name="jobId"><option value="">当前已保存画布</option></select></label><label class="native-flow-round" hidden>任务回合<select name="round"><option value="">非循环步骤</option></select></label><button type="button" data-native-flow-refresh>刷新检查</button></form><p class="native-flow-jobs" role="status">正在读取任务列表…</p><div class="native-flow-result" aria-live="polite"></div></section>`,'<button data-action="close-modal">关闭</button>');
 const root=document.querySelector('.native-flow-panel'),form=root.querySelector('form'),result=root.querySelector('.native-flow-result'),jobState=root.querySelector('.native-flow-jobs'),refreshButton=root.querySelector('[data-native-flow-refresh]');
 let jobs=[],request=0;const alive=()=>root.isConnected;
 async function refresh(){
  const token=++request,jobId=form.elements.jobId.value,round=form.elements.round.value,query=new URLSearchParams({nodeId});
  if(jobId){query.set('jobId',jobId);if(round){const item=(jobs.find(job=>job.id===jobId)?.steps||[]).find(step=>JSON.stringify([step.loopId,step.roundIndex])===round);if(item){query.set('loopId',item.loopId);query.set('roundIndex',String(item.roundIndex));}}}
  refreshButton.disabled=true;result.innerHTML='<p class="native-flow-note" role="status">正在检查…</p>';
  try{const value=await api('/api/projects/'+encodeURIComponent(project.id)+'/native-flow?'+query);if(alive()&&token===request)result.innerHTML=nativeFlowResultMarkup(value,{nodeId,project,esc});}
  catch(error){if(alive()&&token===request)result.innerHTML=`<p class="native-flow-error" role="alert">${esc(error.message)}</p><button type="button" data-native-flow-retry>重试检查</button>`;}
  finally{if(alive()&&token===request)refreshButton.disabled=false;}
 }
 function updateRounds(){const rounds=new Map();for(const step of jobs.find(job=>job.id===form.elements.jobId.value)?.steps||[])if(step.loopId&&Number.isInteger(step.roundIndex))rounds.set(JSON.stringify([step.loopId,step.roundIndex]),`${step.loopTitle||step.loopId} · 第 ${step.roundIndex+1} 回合`);form.elements.round.innerHTML='<option value="">非循环步骤</option>'+[...rounds].map(([value,label])=>`<option value="${esc(value)}">${esc(label)}</option>`).join('');root.querySelector('.native-flow-round').hidden=!rounds.size;}
 async function loadJobs(){
  jobState.textContent='正在读取任务列表…';
  try{const all=await api('/api/jobs?projectId='+encodeURIComponent(project.id));if(!alive())return;jobs=all.filter(job=>job.kind==='canvas-run'&&job.projectId===project.id);const selected=form.elements.jobId.value;form.elements.jobId.innerHTML='<option value="">当前已保存画布</option>'+jobs.map(job=>`<option value="${esc(job.id)}">${esc(job.name||'画布任务')} · ${esc(statuses[job.status]||job.status)} · ${esc(job.createdAt||job.id)}</option>`).join('');if(jobs.some(job=>job.id===selected))form.elements.jobId.value=selected;jobState.textContent=jobs.length?`可读取 ${jobs.length} 个任务的原始快照，仅纳入已完成步骤。`:'当前项目还没有可读取的画布任务。';updateRounds();}
  catch(error){if(alive())jobState.innerHTML=`任务列表读取失败：${esc(error.message)} <button type="button" data-native-flow-jobs-retry>重试任务列表</button>`;}
 }
 form.addEventListener('submit',event=>event.preventDefault());
 form.addEventListener('change',event=>{if(event.target.name==='jobId')updateRounds();void refresh();});
 root.addEventListener('click',event=>{if(event.target.closest('[data-native-flow-refresh],[data-native-flow-retry]'))void refresh();if(event.target.closest('[data-native-flow-jobs-retry]'))void loadJobs();});
 await Promise.allSettled([loadJobs(),refresh()]);
}
