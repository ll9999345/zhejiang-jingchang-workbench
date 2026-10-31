import {normalizeCameraAngle,cameraAngleDefaults,cameraAngleLimits,cameraInstruction} from './camera-angle-core.js';
import {drawCameraPreview} from './camera-angle-preview.js';
import {effectiveInputs} from './workflow-fields.js';
import {comfyMediaField} from './comfy-media.js';
const $=s=>document.querySelector(s),clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
const sourceValue=r=>r?.sourceNodeId?'node:'+r.sourceNodeId:r?.assetId?'asset:'+r.assetId:'';
const fieldKey=f=>JSON.stringify([f.nodeId,f.name]);
export async function cameraAngleAction(button,ctx){
 if(!button.dataset.cameraAngle&&!button.dataset.angleNode)return false;
 await ctx.save();await ctx.refresh();
 const {api,esc,modal}=ctx,p=ctx.project(),original=p.nodes.find(n=>n.id===button.dataset.angleNode),editing=!!original?.params?.cameraAngle;
 const bound=editing?original:null,initial=normalizeCameraAngle(bound?.params.cameraAngle),binding=bound?.params.workflowBinding,studio=bound?.params.studioBinding;
 if(editing&&!binding&&studio?.config.protocol!=='modelscope')throw Error('此机位节点已切换其他生成方式，请在绑定设置中编辑，或从素材新建机位节点');
 const parents=new Set();function walk(id){for(const e of p.edges.filter(e=>e.target===id))if(!parents.has(e.source)){parents.add(e.source);walk(e.source);}}if(bound)walk(bound.id);
 const dynamic=p.nodes.filter(n=>parents.has(n.id)&&n.type==='image');
 let assets=ctx.assets().filter(a=>['image/png','image/jpeg','image/webp'].includes(a.type)&&a.size<=10*1024*1024);
 let workflows=await api('/api/workflows'),template=null,fields=[],image=null,request=0,disposed=false,busy=false;
 const mode=binding?'comfy':'modelscope',ref=sourceValue(binding?.imageSources?.[0]||studio?.referenceSources?.[0])||('asset:'+(button.dataset.cameraAngle||original?.assetId||assets[0]?.id||''));
 const sourceOptions=()=>'<option value="">选择参考图片</option>'+dynamic.map(n=>`<option value="node:${n.id}">上游图片：${esc(n.title)}</option>`).join('')+assets.map(a=>`<option value="asset:${a.id}">${esc(a.name)}</option>`).join('');
 const workflowOptions=()=>'<option value="">选择图像编辑工作流</option>'+workflows.map(w=>`<option value="${w.id}">${esc(w.name)}</option>`).join('');
 modal(editing?'调整图片机位':'图片角度 / 导演机位',`<form id="camera-angle-form"><label>参考图片<select name="source" required>${sourceOptions()}</select></label><label>或从本机导入<input name="file" type="file" accept="image/png,image/jpeg,image/webp"></label><div class="camera-angle-preview"><canvas id="camera-angle-preview" width="760" height="380" tabindex="0" aria-label="机位示意预览，拖动或按方向键转动"></canvas></div><p class="small muted">机位示意使用参考图平面，无法预览被遮挡的表面；最终视角由所选模型生成。拖动或方向键转动，滚轮调整距离。</p><div class="camera-angle-controls">${[['rotation','水平角'],['pitch','俯仰角'],['distance','距离']].map(([key,label])=>`<label>${label}<div class="row"><input type="range" data-angle-slider="${key}" min="${cameraAngleLimits[key][0]}" max="${cameraAngleLimits[key][1]}" step="${key==='distance'?.1:1}" value="${initial[key]}" aria-label="${label}滑杆"><input type="number" name="${key}" min="${cameraAngleLimits[key][0]}" max="${cameraAngleLimits[key][1]}" step="any" required value="${initial[key]}" aria-label="${label}"><button type="button" data-angle-reset="${key}" aria-label="重置${label}">↺</button></div></label>`).join('')}</div><div class="row camera-angle-presets">${[['front','正面'],['left','左侧45°'],['right','右侧45°'],['above','俯视'],['below','仰视'],['close','特写'],['wide','远景']].map(([k,l])=>`<button type="button" data-angle-preset="${k}">${l}</button>`).join('')}</div><label>补充提示词<textarea name="prompt" maxlength="4000" placeholder="补充主体、光线和需要保留的细节…">${esc(bound?.text||'')}</textarea></label><details><summary>本节点实际生成提示词</summary><pre id="camera-angle-prompt" class="camera-angle-prompt"></pre></details><label>生成方式<select name="mode"><option value="modelscope">ModelScope 图片编辑</option><option value="comfy">ComfyUI 图像编辑工作流</option></select></label><fieldset id="angle-cloud"><label>API 地址<input name="baseUrl" type="url" required value="${esc(studio?.config.baseUrl||'https://api-inference.modelscope.cn/v1')}"></label><label>图片编辑模型<input name="model" required maxlength="200" value="${esc(studio?.config.model||'Qwen/Qwen-Image-Edit-2509')}"></label><label>LoRA 权重（可选）<textarea name="loras" rows="2" placeholder='{"作者/模型":1}'>${esc(JSON.stringify(studio?.config.loras||{}))}</textarea></label><p class="small muted">可使用平台支持的多角度 LoRA。模型权限与效果以实际服务为准；密钥和预算在运行前填写。</p></fieldset><fieldset id="angle-local"><label>本地工作流<select name="workflow" required>${workflowOptions()}</select></label><label>导入 ComfyUI API JSON<input name="workflowFile" type="file" accept=".json,application/json"></label><div id="angle-workflow-fields"></div><p class="small muted">选择已在 ComfyUI 配好模型的图像编辑工作流。机位指令填入提示词字段，参考图填入图片字段；其他参数沿用模板或已保存的节点绑定。</p></fieldset><p id="camera-angle-status" class="small" role="status"></p></form>`,`<button data-action="close-modal">取消</button>${editing?'<button id="angle-disable">移除机位指令</button>':''}<button id="angle-save">保存机位节点</button><button id="angle-run" class="primary">保存并检查运行</button>`);
 const form=$('#camera-angle-form'),el=name=>form.elements[name],canvas=$('#camera-angle-preview'),dialog=$('#modal'),abort=new AbortController();
 const active=()=>!disposed&&form.isConnected&&dialog.open;
 const dispose=()=>{disposed=true;abort.abort();};dialog.addEventListener('close',dispose,{once:true});
 const status=text=>{if(active())$('#camera-angle-status').textContent=text;};
 const options=()=>normalizeCameraAngle(Object.fromEntries(Object.keys(cameraAngleLimits).map(k=>[k,el(k).value===''?NaN:Number(el(k).value)])));
 function render(){if(!active())return;try{const a=options();for(const key of Object.keys(cameraAngleLimits))form.querySelector(`[data-angle-slider="${key}"]`).value=a[key];const width=Math.max(240,Math.round(canvas.clientWidth));if(canvas.width!==width){canvas.width=width;canvas.height=Math.round(width/2);}drawCameraPreview(canvas,image,a);$('#camera-angle-prompt').textContent=[el('prompt').value.trim(),cameraInstruction(a)].filter(Boolean).join('\n\n');status('设置仅在保存后进入项目。');}catch(e){status(e.message);}}
 function setAngles(value){for(const [k,v] of Object.entries(value))el(k).value=v;render();}
 function loadSource(){image=null;const version=++request,v=el('source').value,assetId=v.startsWith('node:')?p.nodes.find(n=>n.id===v.slice(5))?.assetId:v.slice(6);render();if(!assetId){status(v.startsWith('node:')?'运行时使用上游生成的图片。':'请选择或导入参考图');return;}const img=new Image();img.onload=()=>{if(active()&&version===request){image=img;render();}};img.onerror=()=>{if(active()&&version===request)status('参考图暂时无法显示，请检查素材');};img.src='/media/'+encodeURIComponent(assetId);}
 async function chooseWorkflow(){
  template=null;fields=[];const id=el('workflow').value;$('#angle-workflow-fields').innerHTML='';if(!id)return;
  const loaded=await api('/api/workflows/'+id);if(!active()||el('workflow').value!==id)return;template=loaded;
  for(const node of template.inspection.nodes)for(const f of effectiveInputs(template,node))fields.push({...f,nodeId:node.id,classType:node.class_type});
  const text=fields.filter(f=>f.type==='string'&&!f.config?.options&&!comfyMediaField(f.classType,f.name,f.config)),images=fields.filter(f=>f.type==='string'&&comfyMediaField(f.classType,f.name,f.config)?.kinds.includes('image'));
  const choices=items=>items.map(f=>`<option value="${esc(fieldKey(f))}">#${esc(f.nodeId)} ${esc(f.config?.label||f.name)}</option>`).join('');
  $('#angle-workflow-fields').innerHTML=`<label>机位提示词填入<select name="promptField" required><option value="">选择文字字段</option>${choices(text)}</select></label><label>参考图填入<select name="imageField" required><option value="">选择图片字段</option>${choices(images)}</select></label>`;
  const same=binding?.workflowId===id;el('promptField').value=same&&binding.promptField?fieldKey(binding.promptField):(text.length===1?fieldKey(text[0]):'');el('imageField').value=same&&binding.imageSources?.[0]?fieldKey(binding.imageSources[0]):(images.length===1?fieldKey(images[0]):'');
  if(!text.length||!images.length)status('此工作流缺少可用的文字或图片输入，请导入图像编辑工作流。');
 }
 function modeChanged(){const local=el('mode').value==='comfy';$('#angle-cloud').hidden=local;$('#angle-cloud').disabled=local;$('#angle-local').hidden=!local;$('#angle-local').disabled=!local;}
 form.oninput=e=>{if(e.target.dataset.angleSlider)el(e.target.dataset.angleSlider).value=e.target.value;if(Object.keys(cameraAngleLimits).includes(e.target.name)||e.target.dataset.angleSlider||e.target.name==='prompt')render();};
 el('source').onchange=loadSource;el('mode').onchange=modeChanged;el('workflow').onchange=()=>chooseWorkflow().catch(e=>status(e.message));
 el('file').onchange=async()=>{try{const file=el('file').files[0];if(!file)return;if(file.size>10*1024*1024||!['image/png','image/jpeg','image/webp'].includes(file.type))throw Error('请选择不超过10MB的PNG、JPEG或WebP');const asset=await api('/api/assets?name='+encodeURIComponent(file.name),{method:'POST',headers:{'Content-Type':file.type},body:await file.arrayBuffer()});await ctx.refresh();if(!active())return;assets=[asset,...assets.filter(a=>a.id!==asset.id)];el('source').innerHTML=sourceOptions();el('source').value='asset:'+asset.id;loadSource();}catch(e){status(e.message);}};
 el('workflowFile').onchange=async()=>{try{const file=el('workflowFile').files[0];if(!file)return;if(file.size>2_000_000)throw Error('工作流文件超过2MB');const workflow=JSON.parse(await file.text()),saved=await api('/api/workflows',{method:'POST',body:JSON.stringify({name:file.name.replace(/\.json$/i,''),workflow})});workflows=[saved,...workflows];if(!active())return;el('workflow').innerHTML=workflowOptions();el('workflow').value=saved.id;await chooseWorkflow();}catch(e){status(e.message);}};
 form.querySelectorAll('[data-angle-reset]').forEach(b=>b.onclick=()=>setAngles({[b.dataset.angleReset]:cameraAngleDefaults[b.dataset.angleReset]}));
 const presets={front:{...cameraAngleDefaults},left:{rotation:-45,pitch:0},right:{rotation:45,pitch:0},above:{rotation:0,pitch:60},below:{rotation:0,pitch:-30},close:{distance:2},wide:{distance:7}};
 form.querySelectorAll('[data-angle-preset]').forEach(b=>b.onclick=()=>setAngles(presets[b.dataset.anglePreset]));
 let drag=null;canvas.onpointerdown=e=>{if(e.button!==0||busy)return;try{drag={id:e.pointerId,x:e.clientX,y:e.clientY,...options()};canvas.focus();canvas.setPointerCapture(e.pointerId);e.preventDefault();}catch{}};
 canvas.onpointermove=e=>{if(!drag||e.pointerId!==drag.id)return;setAngles({rotation:Math.round(clamp(drag.rotation+(e.clientX-drag.x)*.4,-90,90)),pitch:Math.round(clamp(drag.pitch-(e.clientY-drag.y)*.4,-90,90))});};const end=()=>{drag=null;};canvas.onpointerup=end;canvas.onpointercancel=end;window.addEventListener('blur',end,{signal:abort.signal});
 canvas.onkeydown=e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)||busy)return;e.preventDefault();e.stopPropagation();try{const a=options(),step=e.shiftKey?15:5;setAngles({rotation:clamp(a.rotation+(e.key==='ArrowRight'?step:e.key==='ArrowLeft'?-step:0),-90,90),pitch:clamp(a.pitch+(e.key==='ArrowUp'?step:e.key==='ArrowDown'?-step:0),-90,90)});}catch{}};
 canvas.addEventListener('wheel',e=>{e.preventDefault();if(busy)return;try{setAngles({distance:Math.round(clamp(options().distance+(e.deltaY>0?.2:-.2),.1,8)*10)/10});}catch{}},{passive:false});
 async function commit(run){
  if(busy||!form.reportValidity())return;busy=true;$('#angle-save').disabled=$('#angle-run').disabled=true;
  try{
   if(ctx.project()!==p)throw Error('项目已切换，请重新打开机位设置');
   const cameraAngle=options(),value=el('source').value,source=value.startsWith('node:')?{sourceNodeId:value.slice(5)}:{assetId:value.slice(6)},asset=source.assetId?assets.find(a=>a.id===source.assetId):null;
   if(source.assetId&&!asset)throw Error('参考图片不存在');const params={...(bound?.params||{}),cameraAngle};for(const k of ['workflowBinding','studioBinding','cloudBinding','imageBinding','llmBinding'])delete params[k];
   if(el('mode').value==='comfy'){
    if(!template||template.id!==el('workflow').value||!el('promptField')?.value||!el('imageField')?.value)throw Error('请选择工作流的文字与图片输入');
    const field=v=>{const [nodeId,name]=JSON.parse(v);return {nodeId,name};},promptField=field(el('promptField').value),imageField=field(el('imageField').value),excluded=new Set([fieldKey(promptField),fieldKey(imageField)]);
    const old=binding?.workflowId===template.id?binding:{};
    if(old.promptBatch&&excluded.has(fieldKey(old.promptBatch)))throw Error('该字段已使用提示词列表，请先在工作流绑定中移除列表');
    params.workflowBinding={...old,workflowId:template.id,overrides:(old.overrides||[]).filter(f=>!excluded.has(fieldKey(f))),imageSources:[{...imageField,...source},...(old.imageSources||[]).filter(f=>!excluded.has(fieldKey(f)))],promptField,count:old.count||1,incrementSeeds:old.incrementSeeds===true};
   }else{
    const baseUrl=el('baseUrl').value.trim(),u=new URL(baseUrl);if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.hash||u.search)throw Error('API地址须为不含登录信息的完整HTTP/HTTPS地址');let loras;try{loras=JSON.parse(el('loras').value||'{}');}catch{throw Error('LoRA权重请填写JSON对象');}
    if(!loras||typeof loras!=='object'||Array.isArray(loras)||Object.entries(loras).some(([k,v])=>!/^[-\w.]+\/[-\w.]+$/.test(k)||!Number.isFinite(v)||v<=0||v>1)||Object.keys(loras).length>6||(Object.keys(loras).length&&Math.abs(Object.values(loras).reduce((a,b)=>a+b,0)-1)>1e-6))throw Error('LoRA最多6项，名称为作者/模型，正数权重合计须为1');
    params.studioBinding={mode:'image',includeUpstream:studio?.includeUpstream!==false,config:{...studio?.config,protocol:'modelscope',baseUrl,model:el('model').value.trim(),loras,imageAsync:true,count:1,quality:'auto',transparent:false},referenceSources:[source,...(studio?.referenceSources||[]).slice(1).filter(r=>sourceValue(r)!==sourceValue(source))]};
   }
   await ctx.commit({nodeId:bound?.id,sourceNodeId:!bound?original?.id:null,asset,params,text:el('prompt').value.trim()});dispose();if(run){try{await ctx.run();}catch(e){dialog.close();throw e;}}else dialog.close();
  }catch(e){ctx.notify(e.message);}finally{busy=false;if(active())$('#angle-save').disabled=$('#angle-run').disabled=false;}
 }
 $('#angle-save').onclick=()=>commit(false);$('#angle-run').onclick=()=>commit(true);
 if(editing)$('#angle-disable').onclick=async()=>{if(busy)return;try{await ctx.remove(bound.id);dispose();dialog.close();}catch(e){ctx.notify(e.message);}};
 const resize=new ResizeObserver(render);resize.observe(canvas.parentElement);abort.signal.addEventListener('abort',()=>resize.disconnect(),{once:true});
 el('source').value=ref;el('mode').value=mode;el('workflow').value=binding?.workflowId||workflows[0]?.id||'';modeChanged();loadSource();await chooseWorkflow();return true;
}
