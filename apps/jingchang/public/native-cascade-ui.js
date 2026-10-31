const names={generate:'生成并传递',copy:'共享结果',relay:'传递到循环'};
function enhancementMarkup(value,esc,actual=false,sourceName=''){
 if(!value)return '';
 const seed=value.seedMode==='workflow'?'沿用工作流种子':value.seed!==undefined?`种子 ${value.seed}`:value.seedMode==='random'?'执行时选择一次随机种子':'固定种子';
 const parameters=value.kind==='upscale'?`单图放大 · ${value.resolution===4096?'4K':'2K'} · 长边上限 ${value.maxResolution}`:`图片增强 · 强度 ${value.strength}`;
 return `<p class="small native-enhancement-receipt" style="overflow-wrap:anywhere">${esc(parameters)} · ${esc(seed)}${actual&&value.sourceAssetId?` · 来源 ${sourceName?esc(sourceName)+'（'+esc(value.sourceAssetId)+'）':esc(value.sourceAssetId)}`:''}</p>${!actual?'<p class="small muted">只处理有序引用里的第一张图片；保留工作流提示文字，不注入动态提示词。</p>':''}`;
}
function batchMarkup(input,esc,actual=false,requests=null){
 const batch=input.promptBatch;if(!batch)return '';
 const random=input.workflowRandom;
 const total=input.providerRequestCount??input.count??batch.values.length;
 return `<details class="native-cascade-batch"><summary>提示词列表 · ${batch.values.length} 条 · ${actual?(requests?`已提交 ${requests.submitted} / ${total} 次请求`:`预定 ${total} 次请求`):`最多 ${total} 次请求`}</summary><p class="small muted">逐条使用已保存文字；列表中的计数和素材标记保持原样。</p><ol class="small">${batch.values.map((value,index)=>`<li style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(value)}${requests?.items?.[index]?.promptId?`<p class="muted">原编号 ${esc(requests.items[index].promptId)}</p>`:''}${random?`<p class="muted">${random.batches[index].values.map(field=>esc(field.name)+' = '+esc(String(field.value))).join(' · ')}</p>`:''}</li>`).join('')}</ol></details>`;
}
function modelscopeMarkup(value,esc,requests=null,actual=false){
 if(!value?.nativeModelscope)return '';
 const statuses={unsubmitted:'未提交',submitting:'等待接受编号',pending:'原任务处理中',completed:'结果已保存',failed:'已停止，需核对原任务'};
 const progress=actual?(requests?`已尝试 ${requests.attempted} / ${value.count} 次 · 已接受 ${requests.submitted} / ${value.count} 次 · 已完成 ${requests.completed} / ${value.count} 份`:`预定 ${value.count} 次独立请求`):`最多 ${value.count} 次独立请求`;
 const loras=value.loras===undefined?'旧收据未单列，请核对原绑定':Object.entries(value.loras).map(([name,weight])=>`${name} × ${weight}`).join('、')||'未使用';
 return `<details class="native-modelscope-receipt"><summary>ModelScope · ${esc(value.size)} · ${esc(progress)}</summary><p class="small muted" style="overflow-wrap:anywhere">模型 ${esc(value.model||'旧收据未单列')} · LoRA ${esc(loras)}</p><p class="small muted">每份对应一次独立请求。停止后只查询已保存的原编号；未收到编号的份数不会补发。</p>${actual?`<p class="small muted">实际使用 ${esc(value.referenceAssetIds.length)} 张参考图；每份使用同一清单。</p>`:''}${requests?.items?.length?`<ol class="small">${requests.items.map(item=>`<li style="overflow-wrap:anywhere">第 ${esc(item.index+1)} 份 · ${esc(statuses[item.status]||item.status)}${item.upstreamId?` · 原编号 ${esc(item.upstreamId)}`:' · 未收到可查询编号'}</li>`).join('')}</ol>`:''}</details>`;
}
export function nativeCascadePlanMarkup(value,esc){
 const {summary,program,steps}=value;
 const rows=steps.map((step,index)=>`<div class="run-step canvas-plan-step"><div><strong>${index+1}. ${esc(step.title)}</strong><p class="small muted">${esc(names[step.cascadeKind])}${program.loop?` · 第${step.roundIndex+1}/${step.roundCount}轮 · 计数 ${step.nativeLoop.index}`:''}${step.count?` · 最多 ${step.count} 次生成请求`:' · 不新增生成请求'}</p>${enhancementMarkup(step.imageEnhance,esc)}${batchMarkup(step,esc)}${modelscopeMarkup(step.studio?.config,esc)}${step.text?`<details><summary>节点提示词草稿</summary><p style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(step.text)}</p></details>`:''}</div></div>`);
 return `<p>按这条链传递素材。发送节点使用自己的生成设置，把结果交给接收节点；同级节点可共享一次生成的结果，之后各自继续。</p><p class="small muted">${summary.operations} 个步骤 · ${summary.generations} 个生成步骤 · 最多 ${summary.requests} 次生成请求 · ${summary.sharedCopies} 次共享</p>${program.loop?`<p class="small muted">${program.loop.count} 轮，${program.scheduling.mode==='parallel'?'并行':'依次'}执行；运行顺序和选中的分支已列在下面。</p>`:''}<p class="small muted">后续步骤使用本次新结果。计数和素材引用在执行时展开，实际输入保存在任务记录中；工作流只有一个素材字段时使用首项，余下引用会明确列出。运行检查不提交任务；停止后保留已完成结果。外部接口逐步骤确认预算，实际账单以上游为准。</p>${rows.slice(0,40).join('')}${rows.length>40?`<details><summary>另外 ${rows.length-40} 个步骤</summary>${rows.slice(40).join('')}</details>`:''}`;
}
export function nativeCascadeRequestMarkup(step,esc){
 if(!step.actualInput)return '';
 const input=step.actualInput;
 const source=input.enhancement&&input.referenceRefs.find(ref=>ref.assetId===input.enhancement.sourceAssetId&&(!input.enhancement.sourceIdentity||ref.identity===input.enhancement.sourceIdentity));
 return `<details class="native-cascade-request"><summary>实际输入 · ${input.referenceRefs.length} 份引用</summary>${enhancementMarkup(input.enhancement,esc,true,source?.name)}${batchMarkup(input,esc,true,step.childRequests)}${modelscopeMarkup(input.modelscope,esc,step.childRequests,true)}${input.displayPrompt||input.prompt?`<p class="small" style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(input.displayPrompt||input.prompt)}</p>`:''}${input.referenceRefs.length?`<ul class="small muted">${input.referenceRefs.map(ref=>`<li>${esc(ref.name||ref.assetId)} · ${esc(ref.kind)} · ${esc(ref.assetId)}</li>`).join('')}</ul>`:''}${input.unusedRefs.length?`<p class="small muted">本工作流未使用的引用：${input.unusedRefs.map(ref=>esc(ref.name||ref.assetId)).join('、')}。原素材继续保留。</p>`:''}</details>`;
}
