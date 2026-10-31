(() => {
  'use strict';
  const APIS = Object.freeze({'0.2.12':'/model-api/hypit', '0.3.1':'/model-api/hypit-v031'});
  const TERMINAL = new Set(['completed','build_completed','failed','cancelled','needs_attention','interrupted','awaiting_authorization','authorization_required','dry_run','plan_required','preflight_failed']);
  const LABELS = {queued:'等待执行',running:'执行中',completed:'已完成',build_completed:'渲染完成',failed:'执行失败',cancelled:'已停止',needs_attention:'需要处理',interrupted:'执行已中断',authorization_required:'需要服务与预算授权',awaiting_authorization:'等待服务授权',plan_required:'请补齐执行计划',preflight_failed:'执行前检查失败'};
  const ACTIONS = {check:'工程检查',plan:'执行计划',build:'渲染成片',inspect:'输出检查',get:'导出成片',studio:'编辑器',studio_start:'编辑器',builds:'成片记录',history:'输出历史'};
  function safeRelative(path) {
    if (typeof path !== 'string' || !path || path.includes('\\') || path.includes('\0') || path.startsWith('/') || path.includes(':') || path.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('.'))) throw new Error('工程文件路径无效');
    return path;
  }
  function mediaUrl(api, project, path) {
    if (!Object.values(APIS).includes(api) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(project)) throw new Error('工程范围无效');
    safeRelative(path);
    if (!path.startsWith('exports/') || !/\.(mp4|mov|m4v|webm|mkv|avi|wav|mp3|m4a)$/i.test(path)) throw new Error('只预览当前工程已导出的媒体');
    return `${api}/projects/${encodeURIComponent(project)}/files/${path.split('/').map(encodeURIComponent).join('/')}`;
  }
  function studioUrl(raw) {
    try { const u = new URL(raw); return u.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(u.hostname) && !u.username && !u.password ? u.href : null; } catch { return null; }
  }
  function planText(plan) {
    const fields = ['requestCount','localRequestCount','providerRequestCount'];
    if (!plan || !fields.every(k => Number.isSafeInteger(plan[k]) && plan[k] >= 0) || plan.localRequestCount + plan.providerRequestCount !== plan.requestCount) return '计划信息不完整，请查看详细回执。';
    return `本机处理 ${plan.localRequestCount} 项 · 外部服务 ${plan.providerRequestCount} 项。${plan.ok === true && plan.preflight?.ok === true ? '执行前检查通过。' : '仍有条件需要处理。'}${plan.providerRequestCount ? '外部调用需单独授权服务与预算。' : ''}`;
  }
  window.ZhejiangHypit = Object.freeze({mediaUrl,studioUrl,planText,safeRelative});
  if (typeof document === 'undefined') return;
  const $ = id => document.getElementById(id);
  const e = (tag,text,attrs={}) => { const item = document.createElement(tag); if(text != null)item.textContent = text; for(const [k,v] of Object.entries(attrs))item.setAttribute(k,v); return item; };
  let epoch=0, api='', version='', project='', catalog=[], busy=false, available=false, timer=0, polling=false, lastJobs='', rows=[];
  let legacyExports=[], migrationPreview=null;
  let speech=null, speechBusy=false, speechTimer=0;
  const seen = new Set();
  const context = () => ({epoch,api,project});
  const current = ctx => ctx.epoch === epoch && ctx.api === api && ctx.project === project;
  function notice(text,error=false) { $('hypitNotice').textContent=text; $('hypitNotice').dataset.error=String(error); }
  function controls() {
    for(const id of ['hypitCheck','hypitPlan','hypitStudio','hypitBuild','hypitBuilds'])$(id).disabled=busy || !available || !project;
    $('hypitCheck').disabled ||= !$('hypitSource').value;
    for(const id of ['hypitPlan','hypitStudio','hypitBuild'])$(id).disabled ||= !$('hypitRun').value;
    $('hypitImport').disabled=busy || !available || !$('hypitExample').value;
    $('hypitRefresh').disabled=busy;
    $('hypitLegacyProject').disabled=busy || version!=='0.3.1';
    $('hypitMigrationInspect').disabled=busy || version!=='0.3.1' || !$('hypitLegacyProject').value;
    $('hypitMigrationCopy').disabled=busy || !migrationPreview?.supported || migrationPreview.project_id!==$('hypitLegacyProject').value;
    $('hypitSpeech').hidden=version!=='0.3.1' || !project;
    $('hypitSpeechStart').disabled=busy || speechBusy || !speech?.can_start;
    $('hypitSpeechStop').disabled=busy || speechBusy || !speech?.can_stop;
    $('hypitSpeechRefresh').disabled=speechBusy || !project;
    $('hypitSpeechStart').textContent=speech?.configured ? '启动语音' : '启用并启动';
  }
  async function request(ctx,path,body) {
    const response=await fetch(ctx.api+path,{credentials:'same-origin',...(body ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)} : {})});
    const data=await response.json(); if(!response.ok)throw new Error(typeof data.detail === 'string' ? data.detail : '操作未完成，请查看本机运行条件'); return data;
  }
  function options(select,items,placeholder) {
    select.replaceChildren(); if(placeholder)select.append(e('option',placeholder,{value:''}));
    for(const item of items)select.append(e('option',item.label || item.value,{value:item.value}));
  }
  function reset() {
    clearTimeout(timer); epoch++; lastJobs=''; rows=[]; seen.clear();legacyExports=[];
    clearTimeout(speechTimer);speech=null;speechBusy=false;
    $('hypitSpeechStatus').textContent='正在读取语音服务状态……';
    const old=$('hypitPreview').querySelector('video,audio'); if(old){old.pause();old.removeAttribute('src');old.load();}
    $('hypitPreview').replaceChildren(e('span','完成渲染后，在这里预览与下载。'));
    $('hypitResults').replaceChildren(); $('hypitPlanSummary').hidden=true;
    $('hypitJobs').replaceChildren(e('p','此工程尚无本次任务。',{class:'hypit-muted'}));
    $('hypitDetails').textContent='执行后显示实际回执。';
  }
  function syncUrl() {
    const url=new URL(location.href); url.searchParams.set('version',version);
    if(project)url.searchParams.set('hypit_project',project);else url.searchParams.delete('hypit_project');
    history.replaceState(null,'',url.pathname+url.search);
  }
  function projectLabel(row) {
    const id=row?.project_id || '';
    if(/^hypit-migrated-/.test(id))return `${row?.migration_status==='failed' ? '未完成迁移' : '迁移副本'} · ${id.slice(-8)}`;
    const match=id.match(/^hypit-demo-semantic-composition-\d{8}-\d{6}-([a-f0-9]{8})$/);
    return match && (!row.label || row.label===id) ? `官方聊天示例 · ${match[1]}` : row?.label || id;
  }
  function showProject(id) {
    reset(); project=id;
    const row=catalog.find(row=>row.project_id===id);
    const files=(row?.source_files || []).filter(path=>{try{return Boolean(safeRelative(path));}catch{return false;}});
    options($('hypitSource'),files.filter(p=>p.endsWith('.svml')).map(value=>({value})));
    options($('hypitRun'),files.filter(p=>p.endsWith('.svrun')).map(value=>({value})));
    $('hypitProjectTitle').textContent=row ? projectLabel(row) : '选择一个工程';
    syncUrl(); controls(); if(project){
      const ctx=context();void poll(ctx);
      if(version==='0.3.1')void refreshSpeech(ctx);
      if(row?.migration_receipt)void request(ctx,`/projects/${encodeURIComponent(project)}/migration`).then(receipt=>{
        if(current(ctx)){legacyExports=receipt.accepted_media || [];renderJobs(ctx,rows,true);}
      }).catch(error=>{if(current(ctx))notice(error.message,true);});
      if(row?.migration_status==='failed')notice('这个迁移副本尚未完成，原工程保持不变，请查看回执后再处理。',true);
    }
  }
  async function loadVersion(preferred='') {
    reset(); version=$('hypitVersion').value; api=APIS[version] || ''; project=''; available=Boolean($('hypitVersion').selectedOptions[0]?.dataset.available==='true');
    migrationPreview=null;$('hypitMigration').hidden=version!=='0.3.1';
    $('hypitMigrationSummary').textContent='先检查差异；只创建新副本，原工程保留。';
    catalog=[]; options($('hypitProject'),[],'选择工程'); options($('hypitSource'),[]); options($('hypitRun'),[]); controls();
    $('hypitEnvironment').textContent=`Hypit ${version}`;
    const ctx=context();
    if(!available || !api){notice('此版本的本机依赖尚未就绪，现有工程继续保留。',true);return;}
    try {
      const [data,examples]=await Promise.all([request(ctx,'/catalog'),request(ctx,'/examples')]);
      if(!current(ctx))return;
      catalog=data.projects || [];
      options($('hypitProject'),catalog.map(row=>({value:row.project_id,label:projectLabel(row)})),'选择工程');
      options($('hypitExample'),(examples.examples || []).filter(row=>row.executable && row.runtime_profile).map(row=>({value:row.id,label:row.id})));
      if([...$('hypitExample').options].some(row=>row.value==='semantic-composition'))$('hypitExample').value='semantic-composition';
      if(version==='0.3.1'){
        const legacy=await request(ctx,'/migration/projects');if(!current(ctx))return;
        options($('hypitLegacyProject'),(legacy.projects || []).map(row=>({value:row.project_id,label:projectLabel(row)})),'选择旧工程');
      }
      notice(`Hypit ${version} 已就绪。选择原生工程，或将官方示例另存为本机工程。`);
      if(preferred && catalog.some(row=>row.project_id===preferred)){$('hypitProject').value=preferred;showProject(preferred);}else{syncUrl();controls();}
    }catch(error){if(current(ctx))notice(error.message,true);}
  }
  async function act(operation,opts={}) {
    const ctx=context(); if(!ctx.project || !ctx.api)return;
    busy=true;controls();
    try{
      const job=await request(ctx,'/action',{action:operation,project_id:ctx.project,options:opts});
      if(!current(ctx))return;
      notice(`${ACTIONS[operation] || operation}已提交；可在制作记录中查看状态。`);
      $('hypitDetails').textContent=JSON.stringify(job,null,2);
      await poll(ctx);
    }catch(error){if(current(ctx))notice(error.message,true);}finally{busy=false;controls();}
  }
  function renderSpeech(ctx,state) {
    if(!current(ctx))return;
    speech=state;
    $('hypitSpeechStatus').textContent=[state.message,state.configuration_note].filter(Boolean).join(' ');
    controls();clearTimeout(speechTimer);
    if(['starting','running','busy','stopping'].includes(state.state) && !document.hidden)
      speechTimer=setTimeout(()=>void refreshSpeech(ctx),state.state==='running'?5000:1500);
  }
  async function refreshSpeech(ctx) {
    if(!current(ctx) || !ctx.project || version!=='0.3.1')return;
    try{renderSpeech(ctx,await request(ctx,`/speech/status?project_id=${encodeURIComponent(ctx.project)}`));}
    catch(error){if(current(ctx)){speech=null;$('hypitSpeechStatus').textContent=error.message;controls();}}
  }
  async function changeSpeech(action) {
    const ctx=context();if(!ctx.project || speechBusy || !speech)return;
    const body={project_id:ctx.project};
    if(action==='start'){body.profile_sha256=speech.profile_sha256;body.configure=!speech.configured;}
    speechBusy=true;controls();
    try{
      const result=await request(ctx,`/speech/${action}`,body);renderSpeech(ctx,result);
      if(current(ctx) && action==='start')$('hypitPlanSummary').hidden=true;
    }catch(error){if(current(ctx)){notice(error.message,true);await refreshSpeech(ctx);}}
    finally{if(current(ctx)){speechBusy=false;controls();}}
  }
  function button(text,fn){const b=e('button',text,{type:'button'});b.addEventListener('click',fn);return b;}
  function renderJobs(ctx,jobs,force=false) {
    if(!current(ctx))return;
    rows=jobs; const key=JSON.stringify(jobs); if(!force && lastJobs===key)return;lastJobs=key;
    const list=$('hypitJobs');list.replaceChildren();
    if(!jobs.length)list.append(e('p','此工程尚无本次任务。',{class:'hypit-muted'}));
    for(const row of jobs.slice(0,25)){
      const box=e('article',null,{class:'hypit-job','data-job':row.job_id});
      const head=e('div',null,{class:'hypit-job-head'});head.append(e('h3',ACTIONS[row.operation] || row.operation),e('span',LABELS[row.status] || row.status,{class:'hypit-badge'}));box.append(head);
      if(row.message)box.append(e('p',row.message));
      const actions=e('div',null,{class:'hypit-job-actions'});
      actions.append(button('查看回执',()=>{$('hypitDetails').textContent=JSON.stringify(row,null,2);$('hypitDetails').parentElement.open=true;}));
      if(!TERMINAL.has(row.status))actions.append(button('停止',async()=>{try{await request(ctx,`/jobs/${encodeURIComponent(row.job_id)}/cancel?project_id=${encodeURIComponent(ctx.project)}`,{});if(current(ctx))await poll(ctx);}catch(err){if(current(ctx))notice(err.message,true);}}));
      const url=studioUrl(row.studio_url);if(url && row.studio_state==='running' && !TERMINAL.has(row.status))actions.append(e('a','打开编辑器 ↗',{href:url,target:'_blank',rel:'noopener noreferrer'}));
      const build=row.parsed?.build;
      if(build?.id && row.status==='build_completed')actions.append(button('读取输出',()=>act('inspect',{build_id:build.id})));
      if(row.operation==='builds' && Array.isArray(row.parsed?.builds))for(const build of row.parsed.builds)if(build.id)actions.append(button(`读取 ${build.title || build.id}`,()=>act('inspect',{build_id:build.id})));
      if(row.operation==='inspect' && row.command_succeeded && build?.id)for(const output of build.outputs || []){
        if(output.kind!=='resource' || !/^(video|audio)\//.test(output.mediaType || ''))continue;
        actions.append(button(`导出 ${output.name}`,()=>act('get',{build_id:build.id,output:output.name,to:`exports/${build.id}-${Date.now()}.${output.mediaType.startsWith('audio/') ? 'm4a' : 'mp4'}`})));
      }
      box.append(actions);list.append(box);
    }
    const latestPlan=jobs.find(row=>row.operation==='plan' && row.parsed);
    if(latestPlan){$('hypitPlanSummary').textContent=planText(latestPlan.parsed);$('hypitPlanSummary').hidden=false;}
    const result=$('hypitResults');result.replaceChildren();
    const outputFiles=[...jobs.flatMap(row=>row.artifacts || []),...legacyExports];
    const rendered=new Set();
    for(const file of outputFiles){
      if(rendered.has(file.path))continue;rendered.add(file.path);
      let url;try{url=mediaUrl(ctx.api,ctx.project,file.path);}catch{continue;}
      const entry=e('div');if(file.reused_without_generation)entry.append(e('span','原版成片 · 未重新生成',{class:'hypit-muted'}));entry.append(e('a',file.path,{href:url,download:''}));
      if(/\.(mp4|m4v|webm|mov)$/i.test(file.path))entry.append(button('预览',()=>{const old=$('hypitPreview').querySelector('video');if(old)old.pause();const video=e('video',null,{src:url,controls:'',playsinline:'',preload:'metadata'});$('hypitPreview').replaceChildren(video);}));
      result.append(entry);
      if(!seen.has(file.path)){seen.add(file.path);notice('媒体已取回当前工程，可以预览或下载。');}
    }
  }
  async function poll(ctx) {
    clearTimeout(timer);if(!ctx.project || !current(ctx))return;
    if(polling){timer=setTimeout(()=>void poll(ctx),500);return;}polling=true;
    try{
      const data=await request(ctx,`/jobs?project_id=${encodeURIComponent(ctx.project)}`);
      if(current(ctx)){renderJobs(ctx,data.jobs || []);if((data.jobs || []).some(row=>!TERMINAL.has(row.status)) && !document.hidden)timer=setTimeout(()=>void poll(ctx),1200);}
    }catch(error){if(current(ctx))notice(error.message,true);}finally{polling=false;}
  }
  async function init(){
    controls();const params=new URLSearchParams(location.search);
    try{
      const response=await fetch('/model-api/hypit/versions',{credentials:'same-origin'});if(!response.ok)throw new Error('无法读取本机 Hypit 版本');const data=await response.json();
      options($('hypitVersion'),(data.versions || []).filter(row=>APIS[row.version]===row.api).map(row=>({value:row.version,label:row.label})));
      for(const option of $('hypitVersion').options)option.dataset.available=String(data.versions.find(row=>row.version===option.value)?.available===true);
      const wanted=params.get('version');$('hypitVersion').value=APIS[wanted] ? wanted : data.default;
      await loadVersion(params.get('hypit_project') || '');
    }catch(error){notice(error.message,true);}
  }
  $('hypitVersion').addEventListener('change',()=>void loadVersion());
  $('hypitProject').addEventListener('change',event=>showProject(event.target.value));
  $('hypitRefresh').addEventListener('click',()=>void loadVersion(project));
  $('hypitSpeechStart').addEventListener('click',()=>void changeSpeech('start'));
  $('hypitSpeechStop').addEventListener('click',()=>void changeSpeech('stop'));
  $('hypitSpeechRefresh').addEventListener('click',()=>void refreshSpeech(context()));
  for(const id of ['hypitExample','hypitSource','hypitRun'])$(id).addEventListener('change',controls);
  $('hypitImport').addEventListener('click',async()=>{
    const ctx=context();busy=true;controls();
    try{const created=await request(ctx,'/local-examples',{example_id:$('hypitExample').value});if(current(ctx))await loadVersion(created.hypit_project_id);}
    catch(error){if(current(ctx))notice(error.message,true);}finally{busy=false;controls();}
  });
  $('hypitLegacyProject').addEventListener('change',()=>{migrationPreview=null;$('hypitMigrationSummary').textContent='请检查所选工程的迁移差异。';controls();});
  $('hypitMigrationInspect').addEventListener('click',async()=>{
    const ctx=context();busy=true;controls();
    try{const result=await request(ctx,'/migration/inspect',{project_id:$('hypitLegacyProject').value});if(current(ctx)){migrationPreview=result;$('hypitMigrationSummary').textContent=result.supported ? `${result.message || '可以另存副本，作者文件仍需检查。'} 保留 ${(result.preserved_exports || []).length} 份原版成片${result.preserved_asset_count ? `、${result.preserved_asset_count} 份素材` : ''}。` : (result.diagnostics || []).join('；');}}
    catch(error){if(current(ctx))notice(error.message,true);}finally{busy=false;controls();}
  });
  $('hypitMigrationCopy').addEventListener('click',async()=>{
    const ctx=context();const preview=migrationPreview;if(!preview?.supported)return;busy=true;controls();notice('正在建立独立迁移副本，原工程保持不变……');
    try{const copied=await request(ctx,'/migration/copy',{project_id:preview.project_id,fingerprint:preview.fingerprint});if(current(ctx)){
      await loadVersion(copied.hypit_project_id);
      if(project===copied.hypit_project_id && version==='0.3.1'){
        await act('check',{source:copied.author_source || $('hypitSource').value});await act('plan',{run:copied.run_source || $('hypitRun').value});
        notice('迁移副本和原版媒体已保留，检查与计划已提交；没有重新生成媒体。');
      }
    }}catch(error){if(current(ctx))notice(error.message,true);}finally{busy=false;controls();}
  });
  $('hypitCheck').addEventListener('click',()=>void act('check',{source:$('hypitSource').value}));
  $('hypitPlan').addEventListener('click',()=>void act('plan',{run:$('hypitRun').value}));
  $('hypitBuild').addEventListener('click',()=>void act('build',{run:$('hypitRun').value,follow:true}));
  $('hypitStudio').addEventListener('click',()=>void act('studio',{run:$('hypitRun').value}));
  $('hypitBuilds').addEventListener('click',()=>void act('builds'));
  document.addEventListener('visibilitychange',()=>{clearTimeout(timer);clearTimeout(speechTimer);if(!document.hidden && project){void poll(context());if(version==='0.3.1')void refreshSpeech(context());}});
  window.addEventListener('pagehide',()=>{clearTimeout(timer);clearTimeout(speechTimer);epoch++;});
  void init();
})();
