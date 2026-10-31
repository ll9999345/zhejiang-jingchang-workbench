/* Exchange local copies only. The native canvas retains its own execution gates. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let project = new URLSearchParams(location.search).get('project') || '';
  let cutId = new URLSearchParams(location.search).get('cut') || '', cutVersion = Number(new URLSearchParams(location.search).get('version') || 1);
  let inventory = null, engine = null, busy = false, epoch = 0, mode = 'push', selections = [], returnedProject = '';
  const bytes = n => n >= 1e9 ? `${(n/1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n/1e6).toFixed(1)} MB` : `${Math.ceil(n/1e3)} KB`;
  const cutFields = () => cutId ? {cut_id:cutId,cut_version:cutVersion} : {};
  const cutQuery = () => cutId ? '?'+new URLSearchParams(cutFields()) : '';
  async function api(path, body) {
    const response = await fetch('/model-api/canvas' + path, {cache:'no-store', ...(body === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
    let data; try { data = await response.json(); } catch { throw Error('连接中断，请刷新核对原记录。'); }
    if (!response.ok) throw Error(typeof data.detail === 'string' ? data.detail : '资料交换未完成，请重新读取。');
    return data;
  }
  function message(text, error=false) { $('canvasMessage').textContent=text; $('canvasMessage').dataset.error=String(error); }
  function controls() {
    $('canvasProject').disabled=busy; $('canvasRefresh').disabled=busy;
    $('canvasPush').disabled=busy || !project || !inventory || !engine?.ready;
    $('canvasPull').disabled=busy || !inventory?.link || !engine?.ready;
    $('canvasOpen').disabled=busy || !project || !engine?.ready;
    $('canvasStart').disabled=busy; $('canvasStart').hidden=!!engine?.ready;
    $('canvasStandalone').hidden=!engine?.ready;
    const returned=project && returnedProject===project;
    $('canvasReturn').href=project ? '/model?project='+encodeURIComponent(project)+(returned?'&workspace=edit':'') : '/';
    $('canvasReturn').textContent=returned?'去后期制作使用 →':'返回工作台 ↗';
  }
  function showCanvas(link, {reload=false}={}) {
    if (!link) return;
    const url=new URL(link.url);
    const expected = new URL(engine.url);
    if (expected.protocol !== 'http:' || expected.hostname !== '127.0.0.1' || expected.username || expected.password || url.origin !== expected.origin || url.pathname !== '/' || !url.searchParams.get('project')) throw Error('画布入口无法核对。');
    const frame=$('canvasFrame');
    if (reload || frame.getAttribute('src') !== url.href) frame.src=url.href;
    frame.hidden=false; $('canvasWelcome').hidden=true;
  }
  async function withSavedCanvas(work) {
    const frame=$('canvasFrame'), link=inventory?.link;
    if(frame.hidden||!frame.getAttribute('src'))return work();
    if(!link?.canvas_project_id)throw Error('当前画布关联无法核对，请刷新状态后再试。');
    const target=new URL(frame.getAttribute('src'));
    const nativeFrame=target.origin===new URL(engine.url).origin&&target.pathname==='/';
    const mountedFrame=target.origin===location.origin&&target.pathname==='/canvas'&&target.searchParams.get('sourceProject')===project;
    if(!(nativeFrame||mountedFrame)||target.searchParams.get('project')!==link.canvas_project_id)throw Error('当前画布关联已变化，请刷新状态后再试。');
    const wasInert=frame.inert;frame.inert=true;
    try{
      await new Promise((resolve,reject)=>{
        const requestId=crypto.randomUUID(), source=frame.contentWindow;
        const finish=error=>{clearTimeout(timer);window.removeEventListener('message',receive);frame.removeEventListener('load',navigated);error?reject(error):resolve();};
        const receive=event=>{
          const data=event.data;
          if(event.source!==source||event.origin!==target.origin||data?.type!=='jingchang:exchange-ready'||data.requestId!==requestId||data.projectId!==link.canvas_project_id)return;
          finish(data.ok===true?null:Error(typeof data.error==='string'?data.error:'画布尚未保存，未带入资料。'));
        };
        const navigated=()=>finish(Error('画布正在切换，请等待打开后再试。'));
        const timer=setTimeout(()=>finish(Error('尚未收到画布的保存确认。请先在画布中保存，再刷新页面重试。')),15000);
        window.addEventListener('message',receive);frame.addEventListener('load',navigated);
        try { source.postMessage({type:'jingchang:prepare-exchange',requestId,projectId:link.canvas_project_id},target.origin); }
        catch { finish(Error('画布连接尚未就绪，请等待打开后再试。')); }
      });
      return await work();
    }finally{frame.inert=wasInert;}
  }
  async function refresh({reload=false}={}) {
    const ticket=++epoch, id=project;
    const [state, source] = await Promise.all([api('/status'), id ? api('/projects/'+encodeURIComponent(id)+cutQuery()) : Promise.resolve(null)]);
    if(ticket!==epoch || project!==id) return;
    engine=state; inventory=source;
    $('canvasConnection').textContent=state.ready ? `镜场 ${state.version} · 已连接` : state.message;
    $('canvasStandalone').href=state.url;
    $('canvasCutSummary').hidden=!source?.cut;
    $('canvasCutSummary').textContent=source?.cut ? `素材初剪版本 ${source.cut.version}：带入实际选片、裁剪位置、旁白与配乐，建立独立剪辑版本；原分镜画布和原成片保留。` : '';
    $('canvasPush').textContent=source?.cut?'带入这版选片':'带入作品资料';
    controls();
    if(state.ready && source?.link) showCanvas(source.link,{reload});
    else { $('canvasFrame').hidden=true; $('canvasWelcome').hidden=false; }
  }
  async function action(work) {
    if(busy) return;
    busy=true; controls(); $('canvasExchangeSubmit').disabled=true;
    try { await work(); } catch(error) {
      message(error.message,true);
      if($('canvasExchange').open) { $('canvasExchangeError').textContent=error.message; $('canvasExchangeError').hidden=false; }
    } finally { busy=false; controls(); selectionCount(); }
  }
  function selectionCount() {
    const selected=selections.filter(row=>row.input.checked);
    $('canvasSelectionCount').textContent=`${selected.length} 份 · ${bytes(selected.reduce((sum,row)=>sum+(row.item.size||0),0))}`;
    $('canvasSelectAll').checked=selections.length>0 && selected.length===selections.length;
    $('canvasSelectAll').indeterminate=selected.length>0 && selected.length<selections.length;
    const content=mode==='push' && (($('canvasScript').checked&&!$('canvasScript').disabled)||($('canvasScenes').checked&&!$('canvasScenes').disabled));
    $('canvasTimeline').disabled=mode!=='push'||$('canvasScenes').disabled||!$('canvasScenes').checked;
    $('canvasTimelineNote').hidden=$('canvasTimeline').disabled||!$('canvasTimeline').checked;
    $('canvasExchangeSubmit').disabled=busy || (!selected.length && !content) || selected.length>64;
  }
  function renderFiles(items) {
    selections=[]; $('canvasFiles').replaceChildren();
    if(!items.length) { const p=document.createElement('p');p.textContent=mode==='pull'?'画布当前没有可取回的媒体。生成或合成完成后，先在画布中将结果加入当前项目，再刷新这里。':'作品当前没有媒体，可以先带入脚本与分镜。';$('canvasFiles').append(p); }
    for(const item of items) {
      const row=document.createElement('label');row.className='canvas-file';
      const input=document.createElement('input');input.type='checkbox';input.checked=mode==='push'&&!!inventory?.cut;input.setAttribute('aria-label','选择 '+item.name);input.addEventListener('change',selectionCount);
      const info=document.createElement('span');info.className='canvas-file-info';
      const title=document.createElement('b');title.textContent=item.name;
      const detail=document.createElement('small');detail.textContent=mode==='push'?item.path:bytes(item.size||0);
      info.append(title,detail); const type=document.createElement('span');type.className='canvas-file-type';type.textContent=({image:'图片',video:'视频',audio:'音频'})[item.type?.split('/')[0]]||'媒体';
      row.append(input,info,type); $('canvasFiles').append(row);selections.push({item,input});
    }
    selectionCount();
  }
  async function exchange(nextMode) {
    mode=nextMode;
    await refresh();
    if(!project||!engine?.ready) return;
    $('canvasExchangeError').hidden=true;
    $('canvasExchangeTitle').textContent=mode==='push'?(inventory.cut?'带入这版实际选片':'带入作品资料'):'取回画布产物';
    $('canvasExchangeSubmit').textContent=mode==='push'?'带入选中资料':'取回选中素材';
    $('canvasSourceOptions').hidden=mode!=='push';
    $('canvasScript').disabled=!inventory.has_script; $('canvasScript').checked=inventory.has_script;
    $('canvasScenes').disabled=!inventory.scene_count; $('canvasScenes').checked=!!inventory.scene_count;
    $('canvasTimeline').checked=!!inventory.scene_count;
    $('canvasTimelineNote').textContent=inventory.cut?'保留这版的实际素材、入点与出点、旁白时长和配乐。取消勾选的文件不会绑定到镜头。确认后到画布的「剪辑」继续调整。':'按分镜顺序带入时长和旁白；仅匹配你勾选的对应镜头素材。导入后在画布顶部的「分镜」「剪辑」里调整，已有镜头保留原编辑。图片会按时长显示。';
    $('canvasCutWarnings').replaceChildren(...(mode==='push'?inventory.cut?.warnings||[]:[]).map(text=>{const li=document.createElement('li');li.textContent=text;return li;}));
    $('canvasCutWarnings').hidden=mode!=='push'||!inventory.cut;
    $('canvasExchangeNote').textContent=mode==='push'?`「${inventory.title}」：${inventory.scene_count} 个分镜。文字追加为节点，素材按原字节复制；原内容保留。${inventory.media_capped?'当前列出前 500 份媒体。':''}${inventory.media_skipped?`已跳过 ${inventory.media_skipped} 份无法交换的媒体，原文件保留。`:''}`:'只取回你勾选的图片、视频或音频，作为工作台后期制作的素材。';
    const items=mode==='push'?inventory.media:(await api('/projects/'+encodeURIComponent(project)+'/outputs'+cutQuery())).assets;
    renderFiles(items); $('canvasExchange').showModal();
  }
  $('canvasExchangeSubmit').addEventListener('click',()=>action(async()=>{
    const id=project;
    let result;
    if(mode==='push') {
      const body={project_id:id,...cutFields(),source_revision:inventory.source_revision,include_script:$('canvasScript').checked&&!$('canvasScript').disabled,include_scenes:$('canvasScenes').checked&&!$('canvasScenes').disabled,include_timeline:$('canvasTimeline').checked&&!$('canvasTimeline').disabled,files:selections.filter(row=>row.input.checked).map(({item})=>({path:item.path,token:item.token})),confirm:true};
      result=await withSavedCanvas(()=>api('/push',body));
    }
    else result=await api('/pull',{project_id:id,...cutFields(),asset_ids:selections.filter(row=>row.input.checked).map(({item})=>item.id),confirm:true});
    if(id!==project) return;
    $('canvasExchange').close();message(result.message);
    if(mode==='push') showCanvas(result,{reload:result.added_nodes>0||result.added_shots>0});
    else returnedProject=id;
    controls();
    await refresh();
  }));
  $('canvasSelectAll').addEventListener('change',()=>{selections.forEach(row=>{row.input.checked=$('canvasSelectAll').checked;});selectionCount();});
  $('canvasScript').addEventListener('change',selectionCount);$('canvasScenes').addEventListener('change',selectionCount);
  $('canvasTimeline').addEventListener('change',selectionCount);
  $('canvasPush').addEventListener('click',()=>action(()=>exchange('push')));
  $('canvasPull').addEventListener('click',()=>action(()=>exchange('pull')));
  $('canvasOpen').addEventListener('click',()=>action(async()=>{const link=await api('/open',{project_id:project,...cutFields(),confirm:true});showCanvas(link);message(cutId?'画布已打开。点击「带入这版选片」后即可继续剪辑。':'画布已打开。需要已有脚本和素材时，点击「带入作品资料」。');await refresh();}));
  $('canvasStart').addEventListener('click',()=>action(async()=>{message('正在启动已有的本机画布…');await api('/start',{confirm:true});await refresh();message('画布已连接；可以独立使用，也可以带入当前作品。');}));
  $('canvasRefresh').addEventListener('click',()=>action(()=>refresh()));
  $('canvasProject').addEventListener('change',()=>action(async()=>{
    const nextProject=$('canvasProject').value;
    try { await withSavedCanvas(async()=>{
      project=nextProject; inventory=null; returnedProject=''; cutId='';cutVersion=1; ++epoch;
      $('canvasFrame').removeAttribute('src');$('canvasFrame').hidden=true;$('canvasWelcome').hidden=false;
      const url=new URL(location.href);if(project)url.searchParams.set('project',project);else url.searchParams.delete('project');url.searchParams.delete('cut');url.searchParams.delete('version');history.replaceState(null,'',url);
      document.dispatchEvent(new CustomEvent('studio:project',{detail:{id:project}}));
      await refresh();message('可以带入作品资料，也可以打开此作品的空白画布。');
    }); } catch(error) { $('canvasProject').value=project; throw error; }
  }));
  async function boot() {
    try {
      const response=await fetch('/api/projects',{cache:'no-store'});
      if(!response.ok)throw Error('作品列表暂时无法读取。');
      const projects=await response.json();
      for(const item of projects){const option=document.createElement('option');option.value=item.project_id;option.textContent=item.title||item.project_id;$('canvasProject').append(option);}
      $('canvasProject').value=project;
      await refresh();
    } catch(error) { message(error.message,true); controls(); }
  }
  boot();
})();
