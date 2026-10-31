import {serviceDisplayText,platformDisplayName,modelDisplayName} from './model-service-labels.js';
import {isNativePrompt,nativePromptSettings,nativePromptSystemDefault,nativePromptSuggestedReferences} from './native-prompt-core.js';
import {videoSamplingLabel} from './video-sampling.js';
import {referenceFields,installReferenceFields,readReferenceFields} from './reference-fields.js';
import {CANVAS_LLM_REFERENCE_LIMIT,CANVAS_LLM_IMAGE_LIMIT,CANVAS_LLM_AUDIO_LIMIT,CHAT_VIDEO_LIMIT} from './reference-limits.js';
import {CHAT_AUDIO_TYPES} from './chat-audio-types.js';
import {nativeReferenceChoices,nativeReferenceKinds,nativeReferenceMarkup} from './native-flow-ui.js';
import {mountMiaoCredentialChoice,readMiaoCredentialChoice} from './miao-credential-ui.js';

let target,platforms=[];
const visualTypes=['image/png','image/jpeg','image/webp','video/mp4','video/webm','video/quicktime'];
const referenceLabel='图片 / 视频 / 音频参考';

export async function llmBindingAction(action,ctx){
 if(!['bind-llm-node','save-llm-binding','unbind-llm-node'].includes(action))return false;
 const {api,modal,esc,getProject,getSelected,checkpoint,changed,save,toast}=ctx,p=getProject(),n=p.nodes.find(n=>n.id===(action==='save-llm-binding'?target:getSelected()));
 if(!['text','script'].includes(n?.type))throw Error('请选择文本或剧本节点');
 if(action==='unbind-llm-node'){checkpoint();delete n.params.llmBinding;changed();await save();toast('已解除语言模型绑定');return true;}
 if(action==='bind-llm-node'){
  target=n.id;const [state,health]=await Promise.all([api('/api/platforms'),api('/api/health')]);
  platforms=state.platforms.filter(p=>['openai-compatible','gemini'].includes(p.protocol)&&p.models.some(m=>m.category==='chat'));
  if(n.params.llmBinding&&!platforms.some(p=>p.id===n.params.llmBinding.platform.id))platforms.push(n.params.llmBinding.platform);
  const smart=isNativePrompt(n),b=n.params.llmBinding,nativeChoices=nativeReferenceChoices(p,n.id,{consumer:'llm'}),proposed=smart&&!b?nativePromptSuggestedReferences(p,n,nativeChoices):undefined;
  const refs=[...nativeChoices,...p.assets.filter(a=>[...visualTypes,...CHAT_AUDIO_TYPES].includes(a.type)).map(a=>({value:'asset:'+a.id,label:'固定素材：'+a.name}))];
  modal('绑定语言模型',`<p>保存对话平台、模型和输入映射，按连线执行时再填写密钥并确认预算。绑定保存地址与模型快照，平台设置改变后需重新绑定才会使用新配置。</p><form id="llm-binding"><label>执行方式<select name="executor"><option value="api">原API直接回答</option><option value="codex" ${health.capabilities?.codexCanvasLlm?'':'disabled'} ${b?.executor==='codex'?'selected':''}>本机Codex · Responses文字与看图</option><option value="gemini-cli" ${health.capabilities?.geminiCliCanvasLlm?'':'disabled'} ${b?.executor==='gemini-cli'?'selected':''}>本机Gemini · 原生文字与看图</option></select></label><p id="bound-llm-executor" class="small muted"></p><label>平台<select name="platform">${platforms.map(x=>`<option value="${esc(x.id)}" ${b?.platform.id===x.id?'selected':''}>${esc(x.name)}</option>`).join('')}</select></label><p id="bound-llm-origin" class="small muted" style="overflow-wrap:anywhere"></p><label>对话模型<select name="model"></select></label><p id="bound-llm-capabilities" class="small muted"></p><label>文字范围<select name="includeUpstream" ${smart?'disabled':''}><option value="true" ${smart||b?.includeUpstream!==false?'selected':''}>当前节点与所有上游文字</option><option value="false" ${!smart&&b?.includeUpstream===false?'selected':''}>仅当前节点文字</option></select></label><label>视频输入<select name="videoInputMode"><option value="frames" ${b?.videoInputMode!=="native"?"selected":""}>抽样画面（不含声音）</option><option value="native" ${b?.videoInputMode==="native"?"selected":""}>原视频（含文件中的声音，仅 Gemini）</option></select></label><label>系统指令<textarea name="systemPrompt" maxlength="16000" rows="3">${esc(b?.systemPrompt??nativePromptSystemDefault(n))}</textarea></label><div class="row"><label>输出上限<input name="maxTokens" type="number" required min="128" max="8192" value="${b?.maxTokens||4096}"></label><label>回答方式<select name="stream"><option value="true" ${b?.stream!==false?'selected':''}>逐步显示</option><option value="false" ${b?.stream===false?'selected':''}>完整返回</option></select></label></div>${referenceFields({sources:b?.referenceSources??proposed,choices:refs,max:CANVAS_LLM_REFERENCE_LIMIT,label:referenceLabel,esc})}<p class="small muted">以下视频、音频说明适用于原API方式。最多8张图片、3份视频与1份音频。图片PNG/JPEG/WebP≤10MB；视频MP4/WebM/MOV：抽样画面模式≤150MB，在本机从开头每秒抽1帧，最多6张（短片按实际张数，逐秒无画面时使用首帧），只发送时间点和图片，不发送原视频或声音。原视频模式每份≤10MB，需要明确开启原视频理解的 Gemini 模型；确认后随对话请求发送完整视频及其中声音，整个请求≤18MB。音频WAV/MP3/AAC/AIFF/FLAC/OGG/WebM/M4A≤10MB，仅明确开启音频理解的 Gemini 原生对话模型可用；选中的音频原文件随对话请求发送。原生分组与整组结果按运行计划展开，完整数量在运行检查时确认；动态素材生成后再次校验，超出数量、类型或已确认发送范围时停止下游。文字使用当前轮完整回答，回答中断或不完整时保留片段并停止后续执行；不能自动重发。</p></form>`,`<button data-action="api-settings">管理平台</button><button class="primary" data-action="save-llm-binding" ${platforms.length?'':'disabled'}>保存绑定</button>`);
  const form=document.querySelector('#llm-binding');
  const capabilities=()=>{
   const platform=platforms.find(x=>x.id===form.elements.platform.value),model=platform?.models.find(m=>m.id===form.elements.model.value),native=platform?.protocol==='gemini',codex=form.elements.executor.value==='codex',geminiCli=form.elements.executor.value==='gemini-cli',cli=codex||geminiCli;
   document.querySelector('#bound-llm-executor').textContent=geminiCli?'使用已核对的本机Gemini程序，只发送已确认的文字与图片。须选择Gemini原生服务；不复用CLI、Jio、Pro或Flow登录，不发送视频或音频。运行检查列明程序指纹。':codex?'使用已核对的本机Codex程序，只发送本节点已确认的文字与图片。服务须支持Responses；不复用CLI登录，不含生图、视频或音频。运行检查会列明程序版本与指纹。':'保留原平台的文字、图片、视频与音频能力。';
   form.elements.stream.disabled=native||cli;
   if(native||cli)form.elements.stream.value='false';
   form.elements.videoInputMode.closest('label').hidden=cli;form.elements.videoInputMode.closest('label').style.display=cli?'none':'';form.elements.videoInputMode.disabled=cli;if(cli){form.elements.videoInputMode.value='frames';document.querySelector('#bound-llm-capabilities').textContent=(model?.referenceSupport?'PNG/JPEG/WebP图片已启用。':'此模型未启用图片输入。')+'本模式不发送视频或音频。';return;}
   form.elements.videoInputMode.querySelector('[value=native]').disabled=!native||model?.videoSupport!==true;
   document.querySelector('#bound-llm-capabilities').textContent=(native?'Gemini 原生对话使用完整返回。':'')+(model?.referenceSupport?'图片与视频抽样已启用。':'图片与视频抽样未启用。')+(native?(model?.videoSupport?'原视频理解已明确启用。':'原视频理解未启用。'):'原视频理解要求 Gemini 原生对话模型。')+(native?(model?.audioSupport?'音频理解已明确启用。':'音频理解未启用，请先在 API 设置核对模型文档并开启。'):'音频理解要求 Gemini 原生对话模型。');
  };
  const update=()=>{
   const platform=platforms.find(x=>x.id===form.elements.platform.value);
   form.elements.model.innerHTML=(platform?.models||[]).filter(m=>m.category==='chat').map(m=>`<option value="${esc(m.id)}" ${b?.model===m.id?'selected':''}>${esc(modelDisplayName(m))}</option>`).join('');
   document.querySelector('#bound-llm-origin').textContent=platform?.baseUrl||'请先添加对话平台';capabilities();
  };
  installReferenceFields(form,{choices:refs,max:CANVAS_LLM_REFERENCE_LIMIT,label:referenceLabel});
  const chooseExecutor=()=>{const previous=form.elements.platform.value,executor=form.elements.executor.value,allowed=platforms.filter(p=>executor==='codex'?p.protocol==='openai-compatible':executor==='gemini-cli'?p.protocol==='gemini':true);form.elements.platform.innerHTML=allowed.map(x=>`<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');if(allowed.some(p=>p.id===previous))form.elements.platform.value=previous;update();};
  form.elements.executor.onchange=chooseExecutor;form.elements.platform.onchange=update;form.elements.model.onchange=capabilities;chooseExecutor();return true;
 }
 const form=document.querySelector('#llm-binding');if(!form.reportValidity())return true;
 const platform=platforms.find(x=>x.id===form.elements.platform.value),model=platform?.models.find(m=>m.id===form.elements.model.value),maxTokens=Number(form.elements.maxTokens.value),referenceSources=readReferenceFields(form),videoInputMode=form.elements.videoInputMode.value;
 if(!model)throw Error('请选择对话模型');const executor=form.elements.executor.value;if(executor==='gemini-cli'&&(platform.protocol!=='gemini'||videoInputMode==='native'))throw Error('本机Gemini执行需要Gemini原生服务，参考仅选图片');if(executor==='codex'&&(platform.protocol!=='openai-compatible'||videoInputMode==='native'))throw Error('Codex执行需要支持Responses的兼容对话服务，参考仅选图片');
 if(!Number.isInteger(maxTokens)||maxTokens<128||maxTokens>8192)throw Error('输出上限须为128–8192');
 if(new Set(referenceSources.map(r=>JSON.stringify(r))).size!==referenceSources.length)throw Error('参考素材不能重复');
 const sourceKinds=referenceSources.map(r=>nativeReferenceKinds(p,r,{consumer:'llm',nodeId:n.id})),types=sourceKinds.flat();
 if(['codex','gemini-cli'].includes(executor)&&types.some(t=>t!=='image'))throw Error('CLI语言节点当前只支持文字与图片，视频/音频请保留原API方式');
 if(sourceKinds.some(kinds=>!kinds.length)||types.some(t=>!['image','video','audio'].includes(t)))throw Error('参考素材不存在或类型不支持');
 if(types.includes('audio')&&(platform.protocol!=='gemini'||model.audioSupport!==true))throw Error('音频参考要求 Gemini 原生对话模型，并在 API 设置明确开启音频理解');
 if(videoInputMode==='native'&&(platform.protocol!=='gemini'||model.videoSupport!==true))throw Error('原视频参考要求 Gemini 原生对话模型，并在 API 设置明确开启原视频理解');
 if(types.some(t=>t==='image'||t==='video'&&videoInputMode!=='native')&&model.referenceSupport!==true)throw Error('当前模型未开启图片或视频抽样输入能力');
 const choicesByValue=new Map(nativeReferenceChoices(p,n.id,{consumer:'llm'}).map(choice=>[choice.value,choice]));
 const singleTypes=referenceSources.flatMap((r,index)=>r.assetId||choicesByValue.get('node:'+r.sourceNodeId)?.grouped===false?sourceKinds[index]:[]);
 if(singleTypes.filter(t=>t==='image').length>CANVAS_LLM_IMAGE_LIMIT||singleTypes.filter(t=>t==='video').length>CHAT_VIDEO_LIMIT||singleTypes.filter(t=>t==='audio').length>CANVAS_LLM_AUDIO_LIMIT)throw Error('语言模型最多8张图片、3份视频及1份音频；整组素材会在运行检查时展开计数');
 checkpoint();if(isNativePrompt(n))n.params.nativePrompt={...nativePromptSettings(n),llmEnabled:true};n.params.llmBinding={executor,platform:{id:platform.id,name:platform.name,protocol:platform.protocol,baseUrl:platform.baseUrl,models:[structuredClone(model)]},model:model.id,systemPrompt:form.elements.systemPrompt.value,maxTokens,videoInputMode,stream:platform.protocol==='gemini'||['codex','gemini-cli'].includes(executor)?false:form.elements.stream.value==='true',includeUpstream:isNativePrompt(n)||form.elements.includeUpstream.value==='true',referenceSources};
 delete n.params.workflowBinding;delete n.params.studioBinding;delete n.params.cloudBinding;delete n.params.imageBinding;
 changed();await save();document.querySelector('#modal').close();toast('绑定已保存，运行前检查依赖');return true;
}

const isCli=s=>['codex','gemini-cli'].includes(s.llm.executor);
const programOf=s=>s.llm.executor==='gemini-cli'?s.geminiCliProgram:s.codexProgram;
const required=(steps,resume)=>steps.filter(s=>s.kind==='canvas-llm'&&s.status!=='completed'&&(!resume||!s.jobId));
export async function installLlmCredentialChoices(steps,resume=false){
 await Promise.all(required(steps,resume).map(s=>{
  const row=[...document.querySelectorAll('[data-llm-auth]')].find(x=>x.dataset.llmAuth===(s.executionId||s.nodeId));
  return mountMiaoCredentialChoice(row?.querySelector('[name=llm-node-key]'),s.llm.platform,{purpose:'chat'});
 }));
}
const nativeVideoView=(v,esc)=>`<div class="llm-video-preview"><p class="small muted">原视频：${v.duration.toFixed(2)} 秒 · ${(v.size/1024/1024).toFixed(2)}MB · ${v.width} × ${v.height} · ${v.hasAudio?'含音轨，将随视频发送':'没有音轨'}</p><video controls preload="metadata" src="/media/${encodeURIComponent(v.assetId)}" style="display:block;width:100%;max-width:360px;max-height:220px" aria-label="将发送的原视频"></video></div>`;
export function llmAuthorizationMarkup(steps,esc,resume=false){
 return required(steps,resume).map(s=>{
  const videoScope=s.llm.videoInputMode==='native'?'原视频每份≤10MB，发送完整文件及其中声音，整体请求≤18MB':'视频仅发送抽样画面（从开头每秒1帧，最多6张，不含声音；旧记录保留原抽样）';
  const nativeReferences=nativeReferenceMarkup(s,esc);
  const references=nativeReferences?'':(s.referenceDetails||s.llm.referenceSources.map(r=>({name:r.sourceNodeId?'上游媒体节点':'固定素材'}))).map(r=>`<p class="small muted">${esc(({image:'图片',video:'视频',audio:'音频'})[r.kind]||'参考')}：${esc(r.name)} · ${r.dynamic?'本轮上游生成':r.sourceNodeId?'上游已有素材':'固定素材'}${r.kind==='video'&&r.dynamic&&s.llm.videoInputMode==='native'?' · 生成后校验文件；超出10MB时在本机停止':''}</p>`).join('');
  const samples=(s.videoSamples||[]).map(v=>`<p class="small muted">视频 ${v.duration.toFixed(2)} 秒 · ${v.frames.length} 张 · ${videoSamplingLabel(v)} · 只分析画面</p><div style="display:flex;flex-wrap:wrap;gap:8px">${v.frames.map(f=>`<figure style="margin:0"><img src="/media/${f.assetId}" alt="视频抽样" style="width:95px;height:65px;object-fit:contain"><figcaption class="small">约 ${f.time.toFixed(2)} 秒</figcaption></figure>`).join('')}</div>`).join('');
  const audio=(s.audioReferences||[]).map(a=>`<div class="llm-audio-preview"><p class="small muted">音频：${esc(a.name)}${a.dynamic?' · 本轮上游生成后校验并发送原文件':` · ${(a.size/1024/1024).toFixed(2)}MB · 将发送原文件`}</p>${a.assetId?`<audio controls preload="metadata" src="/media/${encodeURIComponent(a.assetId)}" style="display:block;width:100%;max-width:360px"></audio>`:''}</div>`).join('');
  return `<section class="project-card" style="display:block" data-llm-auth="${esc(s.executionId||s.nodeId)}"><strong>${esc(s.title)}${s.loopId?` · 第${s.roundIndex+1}/${s.roundCount}轮`:''}</strong>${isCli(s)?`<p class="small muted" data-codex-program style="overflow-wrap:anywhere">本机${s.llm.executor==='gemini-cli'?'Gemini':'Codex'} ${esc(programOf(s)?.version||'未核对')} · 原CLI登录未使用<br>程序指纹 ${esc(programOf(s)?.sha256||'缺失')}<br>入口指纹 ${esc(programOf(s)?.entrySha256||'缺失')}<br>只转发一次${s.llm.executor==='gemini-cli'?'Gemini原生请求':'Responses'}，不执行模型命令，完整回答才供下游使用。</p>`:''}<p class="small muted">${esc(s.llm.platform.baseUrl)} · ${esc(s.llm.model)}<br>${isCli(s)?`发送系统指令、提示词${s.sendAssets?'和已选择的PNG/JPEG/WebP图片原文件':''}，本步骤最多提交1次${s.llm.executor==='gemini-cli'?'Gemini原生':'Responses'}请求。完整普通回答才供下游使用；未完成时保留原记录，不会重发。`:`发送系统指令与提示词${s.sendAssets?`及已选择的参考素材。图片发送原图；${videoScope}；音频发送选中的原文件`:''}，本步骤最多调用1次。无原任务编号时不会自动重发。`}</p>${nativeReferences}<details><summary>查看提示词和参考素材</summary><p class="small muted">提示词</p><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(s.text)}</pre><p class="small muted">系统指令</p><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(s.llm.systemPrompt||'未设置')}</pre><p class="small muted">输出上限 ${s.llm.maxTokens} · ${s.llm.stream?'逐步显示':'完整返回'}</p>${references}${samples}${(s.nativeVideos||[]).map(v=>nativeVideoView(v,esc)).join('')}${audio}</details><label>本次API Key<input type="password" name="llm-node-key" autocomplete="off"></label>${resume?`<p>原授权预算：${esc(s.authorization?.budget)} ${esc(s.authorization?.currency)}</p>`:'<label>此节点预算<input name="llm-node-budget" type="number" min="0.01" step="0.01"></label><label>币种<select name="llm-node-currency"><option>CNY</option><option>USD</option></select></label>'}<label class="check-label"><input name="llm-node-consent" type="checkbox">确认上述服务、模型、文字${isCli(s)?'及所选图片':`、图片/${s.sendNativeVideo?'原视频及声音':'视频抽样'}/音频`}发送范围和预算</label></section>`;
 }).join('');
}

export function readLlmCredentials(steps,resume=false){
 return required(steps,resume).map(s=>{
  const row=[...document.querySelectorAll('[data-llm-auth]')].find(x=>x.dataset.llmAuth===(s.executionId||s.nodeId));
  if(!row?.querySelector('[name=llm-node-consent]').checked)throw Error('请逐个确认语言模型节点发送范围和预算');
  const credential=readMiaoCredentialChoice(row.querySelector('[name=llm-node-key]'));
  credential.apiKey=credential.apiKey.trim();if(credential.credentialSource==='manual'&&!credential.apiKey)throw Error('请填写本次语言模型节点密钥');
  const authorization=resume?undefined:{...(isCli(s)?{programSha256:programOf(s)?.sha256,programEntrySha256:programOf(s)?.entrySha256,programVersion:programOf(s)?.version}:{}),origin:new URL(s.llm.platform.baseUrl).origin,model:s.llm.model,sendPrompt:true,sendReferences:s.sendAssets,requestLimit:1,...(s.sendNativeVideo?{sendNativeVideo:true}:{}),budget:Number(row.querySelector('[name=llm-node-budget]').value),currency:row.querySelector('[name=llm-node-currency]').value};
  if(authorization&&(!Number.isFinite(authorization.budget)||authorization.budget<=0))throw Error('请填写语言模型节点预算');
  return{nodeId:s.executionId||s.nodeId,...credential,...(authorization?{authorization}:{})};
 });
}
export function clearLlmInputs(){document.querySelectorAll('[name=llm-node-key]').forEach(n=>{
 n.value='';n.disabled=false;const row=n.closest('[data-llm-auth]'),block=row?.querySelector('[data-miao-credential-choice]');
 if(block){block.querySelector('[data-miao-source]').value='manual';const consent=block.querySelector('[data-miao-consent]');consent.checked=false;consent.parentElement.hidden=true;consent.parentElement.style.display='none';}
});}
