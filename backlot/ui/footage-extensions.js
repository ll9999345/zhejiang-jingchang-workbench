/* Optional MPT operations. No task is submitted on load, restore or preflight. */
const labels = {
  topic:'主题', text:'脚本 / 提示词 / 发布文案', language:'语言', paragraphs:'脚本段数', terms_count:'搜索词数量',
  voice_volume:'旁白音量', font_name:'系统字体文件名', stroke_color:'字幕描边颜色', stroke_width:'字幕描边宽度',
  rounded_subtitle_background:'圆角字幕底板', custom_position:'字幕垂直位置（0–100%）',
  system_prompt:'脚本风格要求（可选）', model:'模型 ID（留空使用已配置模型）', voice:'音色 ID', voice_rate:'语速',
  video_path:'本项目视频', audio_path:'本项目旁白', bgm_path:'本项目配乐（可选）', subtitle_path:'本项目 SRT 字幕（可选）',
  reference_audio:'VoxCPM 参考音频（可选）', reference_text:'参考音频文字', duration:'目标时长（秒）',
  aspect_ratio:'画幅', transition:'转场', clip_duration:'每段最大时长（秒）', clip_speed:'播放速度',
  fit:'画面适配', order:'素材顺序', word_level:'逐词字幕', subtitle_animation:'字幕动效',
  subtitle_position:'字幕位置', font_size:'字号', text_color:'文字颜色', background_color:'字幕底色（可留空）',
  bgm_volume:'音乐音量', public_video_url:'公开素材 HTTPS 视频链接', social_platform:'文案用途',
  privacy:'YouTube 可见性', made_for_kids:'声明：面向儿童', listing_version_id:'已确认报价的版本 ID',
};
const groups = {
  connection:['model'],
  script:['topic','text','language','paragraphs','system_prompt','model'],
  terms:['topic','text','terms_count','model'], social:['topic','text','language','social_platform','model'],
  tts:['text','voice','voice_rate','voice_volume','word_level','reference_audio','reference_text'],
  image:['text','duration','aspect_ratio','model'], video:['text','duration','aspect_ratio','model'],
  music:['video_path','text'], analyze:['public_video_url','text','model'],
  transcribe:['audio_path','text','language','word_level'],
  edit:['video_path','audio_path','subtitle_path','bgm_path','bgm_volume','voice_volume','aspect_ratio','order','transition','clip_duration','clip_speed','fit','word_level','subtitle_animation','subtitle_position','custom_position','font_name','font_size','text_color','stroke_color','stroke_width','background_color','rounded_subtitle_background'],
  publish:['video_path','text','privacy','made_for_kids'],
  loomloom_quote:['topic','text','model','aspect_ratio'], loomloom_execute:['topic','text','model','aspect_ratio','listing_version_id'],
};
groups.loomloom_script_quote=['topic','text','language','paragraphs','duration'];
groups.loomloom_script_execute=[...groups.loomloom_script_quote,'listing_version_id'];
groups.publish_status=['remote_request_id'];
groups.rerank=['topic','text','model'];
labels.remote_request_id='发布回执中的 request_id';
const choices = {
  aspect_ratio:[['16:9','横屏 16:9'],['9:16','竖屏 9:16'],['1:1','方形 1:1']],
  transition:[['none','直接切换'],['Shuffle','混合转场'],['FadeIn','淡入'],['FadeOut','淡出'],['SlideIn','滑入'],['SlideOut','滑出'],['ZoomIn','推近'],['ZoomOut','拉远']],
  fit:[['cover','裁切填满'],['contain','完整保留']], order:[['sequential','顺序'],['random','随机']],
  subtitle_animation:[['none','静态'],['pop_spring','弹性出现']], subtitle_position:[['bottom','底部'],['center','居中'],['top','顶部'],['two_thirds_bottom','下三分之一'],['custom','自定义百分比']],
  social_platform:[['tiktok','TikTok'],['youtube_shorts','YouTube Shorts'],['instagram_reels','Instagram Reels'],['facebook_reels','Facebook Reels']],
  privacy:[['private','私密'],['unlisted','不公开列出'],['public','公开']],
};
const defaults = {language:'zh-CN', paragraphs:3, terms_count:5, voice_rate:1, duration:5, clip_duration:5, clip_speed:1,
  font_size:60,text_color:'#FFFFFF',bgm_volume:.15,voice_volume:1,stroke_color:'#000000',stroke_width:1.5,
  custom_position:70,font_name:'PingFang.ttc',rounded_subtitle_background:true};
const numbers = new Set(Object.keys(defaults).filter(k=>typeof defaults[k]==='number'));
const booleans = new Set(['word_level','made_for_kids','rounded_subtitle_background']);
const files = {video_path:'video', audio_path:'audio', reference_audio:'audio', bgm_path:'audio', subtitle_path:'subtitle'};
const $ = id => document.getElementById(id);
const make = (tag, text, className) => {const e=document.createElement(tag); if(text)e.textContent=text; if(className)e.className=className; return e;};
async function api(path, data) {
  const r=await fetch('/model-api/footage/'+path, data ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)} : {});
  const j=await r.json(); if(!r.ok)throw new Error(typeof j.detail==='string'?j.detail:'请检查字段或当前项目'); return j;
}

function normalizeScriptCandidates(value) {
  const rows=Array.isArray(value)?value:value?.candidates;
  if(!Array.isArray(rows))return [];
  return rows.filter(row=>row&&typeof row.script==='string'&&row.script.trim()).slice(0,10).map(row=>({
    script:row.script.trim(), terms:(Array.isArray(row.video_terms)?row.video_terms:[]).filter(t=>typeof t==='string'&&t.trim()).slice(0,12),
  }));
}

export async function initExtensions({projectId, onAssetsChanged, onTerms, onScriptCandidate}) {
  const host=$('extendedServicesStatus');
  let catalog, context, requestId='', checkedRequest='', active=false;
  try {
    [catalog,context]=await Promise.all([api('extensions/catalog'),api('context/'+encodeURIComponent(projectId))]);
  } catch(e) {host.textContent='扩展目录暂不可用：'+e.message;return;}
  host.replaceChildren();
  const form=make('div',null,'extension-form');
  const operation=make('select',null,'control-input'), provider=make('select',null,'control-input');
  operation.id='mptOperation'; provider.id='mptProvider';
  for(const o of catalog.operations)operation.append(new Option(o.label,o.id));
  const label=(text,node)=>{const l=make('label',text,'field-label');l.append(node);return l;};
  form.append(label('要做什么',operation),label('使用服务',provider));
  const status=make('p',null,'security-note'), fields=make('div',null,'settings-grid'), approvals=make('div',null,'extension-approvals');
  const check=make('button','免费预检','quiet-button'), execute=make('button','预检通过后执行一次','primary-action');
  check.type=execute.type='button'; execute.disabled=true;
  const result=make('div',null,'extension-result'); result.setAttribute('aria-live','polite');
  host.append(form,status,fields,approvals,check,execute,result);
  let controls={};
  function invalidate(){checkedRequest='';requestId='';execute.disabled=true;}
  function updateApprovals(){
    const chosen=catalog.operations.find(o=>o.id===operation.value)?.providers.find(p=>p.id===provider.value);
    const free=chosen?.local||operation.value.endsWith('_quote')||operation.value==='publish_status'||operation.value==='tts'&&provider.value==='edge';
    const upload=['music','publish'].includes(operation.value)||operation.value==='tts'&&provider.value==='voxcpm';
    for(const key of ['budget','confirm_paid','billing_limit_configured']){
      if(controls[key]){controls[key].parentElement.hidden=free;if(free){if(key==='budget')controls[key].value='0';else controls[key].checked=false;}}
    }
    if(controls.confirm_network){controls.confirm_network.parentElement.hidden=Boolean(chosen?.local);if(chosen?.local)controls.confirm_network.checked=false;}
    if(controls.confirm_upload){controls.confirm_upload.parentElement.hidden=!upload;if(!upload)controls.confirm_upload.checked=false;}
    for(const key of ['reference_audio','reference_text'])if(controls[key]){
      controls[key].parentElement.hidden=provider.value!=='voxcpm';
      if(provider.value!=='voxcpm')controls[key].value='';
    }
  }
  function providerChanged(){
    const p=catalog.operations.find(o=>o.id===operation.value).providers.find(p=>p.id===provider.value);
    status.textContent=p.configured?(operation.value==='connection'?'本次只发送固定测试句，检查所选模型的真实响应；不发送项目文案或视频。':p.local?'使用本机工具或已配置的本机服务，不向云服务上传音视频。':'本机配置已具备，连接及服务权限需执行验证。'):'待配置：'+p.missing.join('、')+'。密钥只从服务环境读取，不会保存到项目或导出设置。';
    if(controls.voice){
      controls.voice.value=p.default||'';
      const presets=$('mptVoicePresets');
      presets?.replaceChildren(...(p.voices||[]).map(row=>new Option(row.label,row.id)));
      controls.voice.placeholder=p.voices?.length?'可按名称选择，也可填写自己的音色 ID':'填写已开通账号的音色 ID';
    }
    if(controls.voice_rate){
      controls.voice_rate.disabled=!p.supports_voice_rate;
      controls.voice_rate.title=p.supports_voice_rate?'':'该服务暂不支持指定语速';
      if(!p.supports_voice_rate)controls.voice_rate.value='1';
    }
    if(controls.model){controls.model.parentElement.hidden=!p.supports_model;controls.model.value=p.supports_model?(p.default||''):'';}
    updateApprovals();
    invalidate();
  }
  function drawFields(){
    fields.replaceChildren();approvals.replaceChildren();controls={};
    for(const key of groups[operation.value]||[]){
      let input;
      if(files[key]){
        input=make('select',null,'control-input'); input.append(new Option('请选择 / 不使用',''));
        for(const a of context.assets.filter(a=>a.kind===files[key]))input.append(new Option(a.label||a.path,a.path));
      } else if(choices[key]) {
        input=make('select',null,'control-input');for(const [v,t] of choices[key])input.append(new Option(t,v));
      } else {
        input=make(key==='text'||key==='system_prompt'?'textarea':'input',null,'control-input');
        if(numbers.has(key)){input.type='number';input.step=['voice_rate','voice_volume','clip_speed','bgm_volume','stroke_width'].includes(key)?'.1':'1';}
        else if(booleans.has(key))input.type='checkbox';
        if(booleans.has(key))input.checked=Boolean(defaults[key]);
        else input.value=defaults[key]??(key==='text'&&operation.value!=='transcribe'?context.script:key==='topic'?context.topic:'');
        if(input.tagName==='TEXTAREA')input.rows=4;
      }
      input.id='mpt-'+key;controls[key]=input;fields.append(label(operation.value==='transcribe'&&key==='text'?'参考原稿（可选，用于对照校对）':operation.value==='edit'&&key==='word_level'?'使用已对齐的逐词 SRT（句级字幕需先转录）':labels[key],input));
      input.addEventListener('input',invalidate);input.addEventListener('change',invalidate);
      if(key==='voice'){
        const presets=make('datalist');presets.id='mptVoicePresets';input.setAttribute('list',presets.id);fields.append(presets);
      }
    }
    if(operation.value==='edit'){
      const extra=make('textarea',null,'control-input');extra.rows=3;extra.placeholder='可选：每行一个本项目视频路径；为空则剪辑上方所选视频';
      controls.video_paths=extra;fields.append(label('批量镜头路径（可选）',extra));extra.addEventListener('input',invalidate);
    }
    if(operation.value==='publish'){
      for(const platform of ['tiktok','instagram','youtube','facebook']){
        const i=make('input');i.type='checkbox';controls['platform_'+platform]=i;approvals.append(label(platform,i));i.addEventListener('change',invalidate);
      }
    }
    const local=['edit','transcribe'].includes(operation.value);
    const checks=local?[]:[['confirm_network','确认将本次文本或公开链接发送给所选服务'],
      ['confirm_paid','若为收费服务：同意本次调用，已核对所选账号与服务费用'],
      ['billing_limit_configured','已在服务商设置本次支出限制（工作台不能控制第三方实际账单）']];
    if(!local){const budget=make('input',null,'control-input');budget.type='number';budget.min='0';budget.step='.1';budget.value='0';controls.budget=budget;approvals.append(label('本次预算（服务商结算币种；免费服务填 0）',budget));budget.addEventListener('input',invalidate);}
    if(['music','publish','tts'].includes(operation.value))checks.push(['confirm_upload','如需参考文件：确认只上传本次选定文件给所选服务']);
    if(operation.value==='publish')checks.push(['confirm_publish','确认发布上述视频、文案到我已配置的账号和勾选平台']);
    for(const [k,t] of checks){const i=make('input');i.type='checkbox';controls[k]=i;approvals.append(label(t,i));i.addEventListener('change',invalidate);}
    providerChanged();
    if(operation.value==='music')fields.append(make('p','配乐时长按所选视频的真实时长检测。预检会检查服务时长限制。','security-note'));
  }
  function changed(){
    const op=catalog.operations.find(o=>o.id===operation.value);provider.replaceChildren();
    for(const p of op.providers)provider.append(new Option(p.label+(p.configured?'':' · 待配置'),p.id));
    const ready=op.providers.find(p=>p.configured);if(ready)provider.value=ready.id;
    drawFields();
  }
  operation.addEventListener('change',changed);provider.addEventListener('change',providerChanged);changed();
  function payload(){
    const data={project_id:projectId,operation:operation.value,provider:provider.value};
    for(const [k,i] of Object.entries(controls)){
      if(k.startsWith('platform_'))continue;
      data[k]=i.type==='checkbox'?i.checked:i.type==='number'?Number(i.value):k==='video_paths'?i.value.split('\n').map(x=>x.trim()).filter(Boolean):i.value;
    }
    if(data.operation==='publish')data.platforms=Object.entries(controls).filter(([k,i])=>k.startsWith('platform_')&&i.checked).map(([k])=>k.slice(9));
    return data;
  }
  check.addEventListener('click',async()=>{
    if(active)return;invalidate();result.textContent='正在检查本机配置与本次参数……';
    try{const data=payload(),r=await api('extensions/preflight',data);result.textContent=r.ready?'预检通过。点击执行才会开始。':[...r.errors,...r.approvals].join('\n');
      if(r.ready){checkedRequest=JSON.stringify(data);requestId=crypto.randomUUID();execute.disabled=false;}
    }catch(e){result.textContent=e.message;}
  });
  function showJob(job){
    result.replaceChildren(make('p',job.message||job.status));
    if(job.result?.notice)result.append(make('p',job.result.notice,'security-note'));
    if(['running','queued'].includes(job.status)){
      const cancel=make('button','停止本机任务','quiet-button');cancel.type='button';
      cancel.onclick=async()=>{cancel.disabled=true;try{showJob(await api('extensions/jobs/'+job.job_id+'/cancel?project_id='+encodeURIComponent(projectId),{}));}catch(e){result.append(make('p',e.message));}};
      result.append(cancel);
    }
    const value=job.result?.value;
    if(value!==undefined){const displayed=job.request.operation==='transcribe'&&value&&typeof value==='object'
      ? `识别文字：\n${value.recognized_text||''}\n\n${value.reference_text ? '参考原稿：\n'+value.reference_text+'\n\n'+(value.matches_reference?'与原稿文字一致（忽略标点），仍请检查时间点。':'与原稿存在差异，请校对后使用。'):'未提供原稿，请校对识别文字。'}`
      :typeof value==='string'?value:JSON.stringify(value,null,2);const pre=make('pre',displayed);result.append(pre);
      if(job.request.operation==='script'&&typeof value==='string'){
        const apply=make('button','将脚本填入主流程','quiet-button');apply.type='button';apply.onclick=()=>{$('scriptEditor').value=value;$('scriptEditor').dispatchEvent(new Event('input',{bubbles:true}));$('scriptEditor').scrollIntoView({behavior:'smooth'});};result.append(apply);
      }
    }
    if(['terms','rerank'].includes(job.request.operation)&&Array.isArray(value)){
      const apply=make('button','将关键词分配给当前镜头','quiet-button');apply.type='button';apply.onclick=()=>onTerms?.(value);result.append(apply);
    }
    if(job.status==='completed'&&job.request.operation==='loomloom_script_execute'){
      for(const [index,candidate] of normalizeScriptCandidates(value).entries()){
        const card=make('section',null,'extension-candidate');card.append(make('b',`候选 ${index+1}`),make('p',candidate.script),make('p',candidate.terms.join(' · '),'security-note'));
        const apply=make('button','采用此文案与关键词','quiet-button');apply.type='button';
        apply.onclick=async()=>{apply.disabled=true;try{await onScriptCandidate?.(candidate);}catch(_){card.append(make('p','分镜未更新，请检查脚本后手动更新分镜。'));}finally{apply.disabled=false;}};
        card.append(apply);result.append(card);
      }
    }
    for(const path of job.result?.files||[]){
      const url='/model-api/footage/assets/'+encodeURIComponent(projectId)+'?path='+encodeURIComponent(path);
      const link=make('a',path.split('/').pop());link.href=url+'&download=true';link.download='';result.append(link);
      if(/\.(mp3|m4a|wav)$/i.test(path)){const a=make('audio');a.controls=true;a.src=url;result.append(a);}
      if(/\.(mp4|webm)$/i.test(path)){const v=make('video');v.controls=true;v.preload='metadata';v.src=url;result.append(v);}
      if(/\.(png|jpe?g|webp)$/i.test(path)){const img=make('img');img.src=url;img.alt='生成的图片素材';img.loading='lazy';result.append(img);}
    }
  }
  async function poll(job){
    showJob(job);
    if(['queued','running'].includes(job.status)){active=true;execute.disabled=true;check.disabled=true;setTimeout(async()=>{
      try{await poll(await api('extensions/jobs/'+job.job_id+'?project_id='+encodeURIComponent(projectId)));}
      catch(e){active=false;check.disabled=false;result.textContent='读取进度失败；可刷新查看任务，不会重新提交。';}
    },1800);return;}
    active=false;check.disabled=false;execute.disabled=true;
    if(job.result?.files?.length){context=await api('context/'+encodeURIComponent(projectId));onAssetsChanged?.(context.assets);}
  }
  execute.addEventListener('click',async()=>{
    const data=payload();if(active||JSON.stringify(data)!==checkedRequest){invalidate();return;}
    active=true;execute.disabled=true;check.disabled=true;
    try{await poll(await api('extensions/jobs',{...data,request_id:requestId}));}
    catch(e){active=false;check.disabled=false;result.textContent=e.message;}
  });
  const history=await api('extensions/jobs?project_id='+encodeURIComponent(projectId));
  if(history.jobs.length){const h=make('select',null,'control-input');h.append(new Option('查看扩展任务记录',''));
    for(const j of [...history.jobs].reverse())h.append(new Option(`${j.created_at} · ${j.request.operation} · ${j.status}`,j.job_id));
    host.append(label('历史任务（刷新不会重启任务）',h));h.onchange=async()=>{if(h.value)showJob(await api('extensions/jobs/'+h.value+'?project_id='+encodeURIComponent(projectId)));};
    const running=history.jobs.find(j=>['running','queued'].includes(j.status));if(running)poll(running);
  }
}
