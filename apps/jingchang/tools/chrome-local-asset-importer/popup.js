import {scanPage} from './scan-page.js';
import {createZipArchive} from './zip-archive.js';

const $=selector=>document.querySelector(selector);
const MAX_BYTES=150*1024*1024;
const BLOB_LIMIT=20*1024*1024;
const MAX_SELECTION=40;
const MAX_ARCHIVE_BYTES=256*1024*1024;
const ALLOWED_TYPES=new Set(['image/png','image/jpeg','image/webp','image/gif','image/avif','video/mp4','video/webm','video/quicktime','video/x-flv']);
let entries=[];
let activeTab=null;
let connected=false;
let classificationModels=[];
let importing=false;
let frameOrigins=[];
let networkPort=null;
let networkTimer=0;
let networkStarting=false;

function serverAddress(value){
  const url=new URL(value.includes('://')?value:'http://'+value);
  if(!['http:','https:'].includes(url.protocol)||!['127.0.0.1','localhost'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('服务地址只能是本机 127.0.0.1 或 localhost');
  return url.origin;
}
function setStatus(message,state=''){$('#connection-status').textContent=message;$('#connection-status').className='status '+state;}
function safeName(value,fallback='网页素材'){
  let name=String(value||'').replace(/[\u0000-\u001f<>:"/\\|?*]/g,'_').replace(/\s+/g,' ').trim().slice(0,180);
  return name||fallback;
}
function fileNameForType(value,type){const ext=({'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif','image/avif':'avif','video/mp4':'mp4','video/webm':'webm','video/quicktime':'mov','video/x-flv':'flv'})[type]||'bin';const name=safeName(value);return /\.[a-z0-9]{2,5}$/i.test(name)?name:`${name}.${ext}`;}
function archiveFolderName(){const name=safeName(activeTab?.title||entries.find(item=>item.pageTitle)?.pageTitle,'网页素材').replace(/[. ]+$/g,'');return name&&name!=='.'&&name!=='..'?name.slice(0,100):'网页素材';}
function uniqueArchiveFilename(value,type,used){
  const original=fileNameForType(value,type);let candidate=original,index=2;
  const dot=original.lastIndexOf('.'),stem=dot>0?original.slice(0,dot):original,extension=dot>0?original.slice(dot):'';
  while(used.has(candidate.toLowerCase()))candidate=`${stem} (${index++})${extension}`;
  used.add(candidate.toLowerCase());return candidate;
}
function extensionName(url){
  try{return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).at(-1)||'');}catch{return '';}
}
function selectable(item){return !item.unsupported&&['image','video'].includes(item.kind);}
function selectedEntries(){return [...document.querySelectorAll('[data-entry-index]:checked')].map(input=>entries[Number(input.dataset.entryIndex)]).filter(Boolean);}
function selectedClassificationModel(){const index=Number($('#classification-model').value);return Number.isInteger(index)?classificationModels[index]||null:null;}
function updateClassificationControls(){
  const toggle=$('#classify-after-import'),model=selectedClassificationModel(),images=selectedEntries().filter(item=>item.kind==='image').length;
  toggle.disabled=!connected||!classificationModels.length||importing;if(!connected||!classificationModels.length)toggle.checked=false;
  for(const selector of ['#classification-model','#classification-key','#classification-budget','#classification-currency','#classification-consent'])$(selector).disabled=importing;
  const active=toggle.checked,settings=$('#classification-settings');settings.hidden=!active;
  $('#classification-model').required=active;
  $('#classification-key').required=active&&!!model&&!model.local;
  $('#classification-budget').required=active&&!!model&&!model.local;
  $('#classification-budget-row').hidden=!!model?.local;
  const budget=Number($('#classification-budget').value),currency=$('#classification-currency').value;
  if(!model)$('#classification-summary').textContent=classificationModels.length?'选择一个已在本机 API 设置中保存的图片理解模型。':'当前没有已保存且支持图片输入的 OpenAI 兼容对话模型。';
  else if(model.local)$('#classification-summary').textContent=`将图片发送至本机服务 ${model.origin}；最多处理所选 ${images} 张图片，每张最多请求一次。`;
  else $('#classification-summary').textContent=`将图片发送至 ${model.origin} 的「${model.modelName}」；最多处理所选 ${images} 张图片，每张最多请求一次。${Number.isFinite(budget)&&budget>0?`预算记录：每张 ${budget} ${currency}，合计最多 ${budget*images} ${currency}。`:''}`;
  $('#classification-consent-copy').textContent=model?`我同意将本批次最多 ${images} 张所选图片发送给 ${model.local?'本机服务':model.origin} 的 ${model.modelName}，每张最多请求一次${model.local?'。' : '，并知悉可能产生费用。'}`:'我同意发送所选图片进行智能分类。';
  $('#import').textContent=active?'导入并分类所选':'导入所选';
}
function updateActions(){const count=selectedEntries().length;updateClassificationControls();$('#import').disabled=!connected||!count||importing;$('#download').disabled=!count||importing;$('#select-all').disabled=!entries.some(selectable)||importing;$('#network-capture').disabled=!activeTab?.id||networkStarting||importing;$('#network-capture').textContent=networkStarting?'等待权限…':networkPort?'停止监听':'监听网络视频（60秒）';}

async function loadPreferences(){
  const stored=await chrome.storage.local.get(['serverUrl','category','scrollFirst','includeCrossFrames']);
  if(stored.serverUrl)$('#server-url').value=stored.serverUrl;
  if(stored.category)$('#category').value=stored.category;
  if(stored.scrollFirst)$('#scroll-first').checked=true;
  if(stored.includeCrossFrames)$('#include-cross-frames').checked=true;
}
async function connect(){
  try{
    const base=serverAddress($('#server-url').value);
    const response=await fetch(base+'/api/health',{cache:'no-store'});
    if(!response.ok)throw new Error('本机服务返回 '+response.status);
    const health=await response.json();if(!health.ok)throw new Error('本机服务未就绪');
    connected=true;$('#scan').disabled=false;$('#capture').disabled=false;
    $('#server-url').value=base;await chrome.storage.local.set({serverUrl:base});
    classificationModels=[];$('#classify-after-import').checked=false;$('#classification-key').value='';
    try{
      const catalog=await fetch(base+'/api/chrome-import/classification-models',{cache:'no-store'});
      if(catalog.ok){const data=await catalog.json();classificationModels=Array.isArray(data.models)?data.models.filter(item=>item&&typeof item.platformId==='string'&&typeof item.modelId==='string'&&typeof item.origin==='string'):[];}
    }catch{}
    $('#classification-model').replaceChildren();
    if(classificationModels.length){for(const [index,item] of classificationModels.entries()){const option=document.createElement('option');option.value=String(index);option.textContent=`${item.platformName} · ${item.modelName}`;$('#classification-model').append(option);}}
    else{const option=document.createElement('option');option.value='';option.textContent='没有可用的图片理解模型';$('#classification-model').append(option);}
    setStatus(`已连接镜场 ${health.version||''}`,'ok');updateActions();
  }catch(error){connected=false;classificationModels=[];$('#classify-after-import').checked=false;$('#classification-key').value='';$('#scan').disabled=true;$('#capture').disabled=true;setStatus(error.message||'连接失败','error');updateActions();}
}
async function scrollToLoad(tabId){
  await chrome.scripting.executeScript({target:{tabId,frameIds:[0]},func:async()=>{
    const original=window.scrollY,step=Math.max(240,Math.floor(innerHeight*.8)),steps=Math.min(12,Math.ceil(document.documentElement.scrollHeight/step));
    for(let i=0;i<steps;i++){window.scrollTo(0,Math.min(document.documentElement.scrollHeight,step*(i+1)));await new Promise(resolve=>setTimeout(resolve,220));}
    window.scrollTo(0,original);await new Promise(resolve=>setTimeout(resolve,120));return steps;
  }});
}
async function scan(){
  try{
    if(networkPort)finishNetworkCapture('重新扫描，网络监听已停止',true);
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});if(!tab?.id)throw new Error('没有可扫描的网页标签');activeTab=tab;
    if($('#include-cross-frames').checked){
      try{
        const [topFrame]=await chrome.scripting.executeScript({target:{tabId:tab.id,frameIds:[0]},func:scanPage});
        const origins=topFrame?.result?.frameOrigins||[];
        if(origins.length&&!await chrome.permissions.request({origins}))setStatus('未授予 iframe 站点权限，继续扫描当前可访问页面','error');
      }catch(error){setStatus(error.message||'未能取得 iframe 站点权限，继续扫描当前可访问页面','error');}
    }
    if($('#scroll-first').checked)await scrollToLoad(tab.id);
    let frames;
    try{frames=await chrome.scripting.executeScript({target:{tabId:tab.id,allFrames:true},func:scanPage});}
    catch{frames=await chrome.scripting.executeScript({target:{tabId:tab.id},func:scanPage});}
    frameOrigins=frames.find(frame=>frame.frameId===0)?.result?.frameOrigins||[];
    const frameResults=frames.filter(frame=>frame.result?.items),seen=new Set();entries=[];
    for(const frame of frameResults)for(const item of frame.result.items){const key=item.kind+'\n'+item.url;if(seen.has(key))continue;seen.add(key);entries.push({...item,frameId:frame.frameId,pageTitle:frame.result.title});}
    entries=entries.slice(0,500);renderItems();
    const images=entries.filter(item=>item.kind==='image').length,videos=entries.filter(item=>item.kind==='video').length;
    $('#result-count').textContent=`${images} 张图片 · ${videos} 个视频 · ${frameResults.length} 个页面框架`;
    if(!entries.length)$('#items').innerHTML='<div class="empty">没有发现可访问的图片或视频。可截取当前可见画面。</div>';
    updateActions();
  }catch(error){setStatus(error.message||'扫描失败','error');}
}
function toWebOrigin(value){
  try{const raw=String(value||'').replace(/\/\*$/,'');const url=new URL(raw);return ['http:','https:'].includes(url.protocol)?url.origin:'';}catch{return '';}
}
function networkCaptureScope(){
  const allowedOrigins=[],initiators=[];
  const add=(value,isInitiator=false)=>{const item=toWebOrigin(value);if(!item)return;if(!allowedOrigins.includes(item)&&allowedOrigins.length<12)allowedOrigins.push(item);if(isInitiator&&allowedOrigins.includes(item)&&!initiators.includes(item))initiators.push(item);};
  add(activeTab?.url,true);
  for(const value of frameOrigins)add(value,true);
  for(const item of entries){add(item.frameUrl,true);add(item.url,false);}
  return{allowedOrigins,initiators};
}
function finishNetworkCapture(message='',notifyWorker=false){
  if(networkTimer)clearTimeout(networkTimer);networkTimer=0;
  const port=networkPort;networkPort=null;networkStarting=false;
  if(port){if(notifyWorker)try{port.postMessage({type:'stop'});}catch{}try{port.disconnect();}catch{}}
  updateActions();if(message)setStatus(message,'ok');
}
function mergeNetworkCandidate(item){
  if(!item||item.source!=='network'||item.kind!=='video'||typeof item.url!=='string'||entries.length>=500)return;
  let url;try{url=new URL(item.url);}catch{return;}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return;
  if(entries.some(entry=>entry.kind==='video'&&entry.url===url.href))return;
  entries.push({...item,url:url.href,frameUrl:item.initiatorOrigin||activeTab?.url||'',frameId:0,pageTitle:activeTab?.title||'当前网页'});
  renderItems();
}
function receiveNetworkMessage(port,message){
  if(port!==networkPort)return;
  if(message?.type==='capture-started')setStatus('正在监听当前标签页；60秒后自动停止','ok');
  else if(message?.type==='candidate'){mergeNetworkCandidate(message.item);setStatus('已发现网络媒体请求；确认后可下载或导入','ok');}
  else if(message?.type==='capture-error')finishNetworkCapture(message.message||'网络监听启动失败');
  else if(message?.type==='capture-stopped')finishNetworkCapture(message.reason==='limit'?'已达到120项上限，网络监听已停止':'网络监听已停止');
}
function startNetworkCapture(){
  if(!activeTab?.id){setStatus('请先扫描当前网页','error');return;}
  const tabId=activeTab.id,scope=networkCaptureScope();
  if(!scope.allowedOrigins.length||!scope.initiators.length){setStatus('当前网页没有可申请权限的 HTTP/HTTPS 来源','error');return;}
  networkStarting=true;updateActions();
  let request;
  try{request=chrome.permissions.request({permissions:['webRequest'],origins:scope.allowedOrigins.map(origin=>origin+'/*')});}
  catch(error){networkStarting=false;updateActions();setStatus(error.message||'无法申请网络监听权限','error');return;}
  Promise.resolve(request).then(granted=>{
    if(!granted){networkStarting=false;updateActions();setStatus('未授予网络监听权限，没有开始采集','error');return;}
    if(activeTab?.id!==tabId){networkStarting=false;updateActions();setStatus('当前标签页已变化，请重新扫描后再监听','error');return;}
    const port=chrome.runtime.connect({name:'network-capture'});networkPort=port;networkStarting=false;
    port.onMessage.addListener(message=>receiveNetworkMessage(port,message));
    port.onDisconnect.addListener(()=>{if(networkPort===port)finishNetworkCapture('网络监听连接已结束');});
    port.postMessage({type:'start',tabId,allowedOrigins:scope.allowedOrigins,initiators:scope.initiators});
    networkTimer=setTimeout(()=>finishNetworkCapture('已到60秒，网络监听自动停止',true),61_000);
    updateActions();setStatus('网络监听已开启；可播放或重新载入网页视频','ok');
  }).catch(error=>{networkStarting=false;updateActions();setStatus(error.message||'网络监听权限申请失败','error');});
}
function renderItems(){
  const list=$('#items');list.replaceChildren();
  if(!entries.length){list.innerHTML='<div class="empty">没有发现图片或视频。</div>';return;}
  entries.forEach((item,index)=>{
    const row=document.createElement('label');row.className='item'+(selectable(item)?'':' unsupported');
    const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.dataset.entryIndex=String(index);checkbox.disabled=!selectable(item);checkbox.checked=selectable(item);checkbox.addEventListener('change',updateActions);
    const preview=document.createElement('span');preview.className='preview';preview.textContent=item.stream?`${item.streamType||'HLS'} 流`:item.kind==='video'?'视频':'图片';
    if(item.kind==='image'&&/^https?:|^data:/.test(item.url)){const image=document.createElement('img');image.src=item.url;image.alt='';image.loading='lazy';image.onerror=()=>{image.remove();preview.textContent='图片';};preview.replaceChildren(image);}
    const copy=document.createElement('span');copy.className='item-copy';const title=document.createElement('strong');title.textContent=safeName(item.name,item.kind==='video'?'网页视频':'网页图片');const detail=document.createElement('span');detail.textContent=item.unsupported?(item.stream?`${item.streamType||'HLS'} 流媒体清单暂不下载`:item.svg?'SVG 不作为媒体导入':'暂不支持的网页视频格式'):`${item.source==='network'?'网络发现':'网页素材'}${item.width&&item.height?` · ${item.width}×${item.height}`:''} · ${new URL(item.url).hostname||'内嵌素材'}`;copy.append(title,detail);row.append(checkbox,preview,copy);list.append(row);
  });
  updateActions();
}
function selectedOrigins(items){return [...new Set(items.map(item=>{try{const url=new URL(item.url);return ['http:','https:'].includes(url.protocol)?url.origin+'/*':null;}catch{return null;}}).filter(Boolean))];}
async function requestOrigins(items){const origins=selectedOrigins(items);if(!origins.length)return true;return chrome.permissions.request({origins});}
function inferMime(name){const ext=name.toLowerCase().split('.').at(-1);return({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',avif:'image/avif',mp4:'video/mp4',webm:'video/webm',mov:'video/quicktime',m4v:'video/mp4',flv:'video/x-flv'})[ext]||'';}
async function readBlobUrl(item){
  if(!activeTab?.id||!Number.isInteger(item.frameId))throw new Error('此 blob 素材已无法从当前标签页读取');
  const [result]=await chrome.scripting.executeScript({target:{tabId:activeTab.id,frameIds:[item.frameId]},world:'MAIN',func:async(url,maxBytes)=>{
    const response=await fetch(url);if(!response.ok)throw new Error('网页素材读取失败');const blob=await response.blob();if(blob.size>maxBytes)throw new Error('blob 素材超过20 MB读取上限');
    const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('无法读取网页素材'));reader.readAsDataURL(blob);});return{dataUrl,type:blob.type,size:blob.size};
  },args:[item.url,BLOB_LIMIT]});
  if(!result?.result?.dataUrl)throw new Error('网页没有返回可读取的 blob 素材');return fetch(result.result.dataUrl).then(response=>response.blob());
}
async function fetchItem(item){
  if(item.url.startsWith('blob:'))return readBlobUrl(item);
  const response=await fetch(item.url,{credentials:'omit',redirect:'follow',cache:'no-store'});if(!response.ok)throw new Error(`读取素材失败（${response.status}）`);
  const declared=Number(response.headers.get('content-length')||0);if(declared>MAX_BYTES)throw new Error('素材超过150 MB上限');const blob=await response.blob();if(blob.size>MAX_BYTES)throw new Error('素材超过150 MB上限');return blob;
}
function actualType(blob,item){const declared=(blob.type||'').split(';')[0].toLowerCase(),inferred=inferMime(extensionName(item.url)||item.name),type=ALLOWED_TYPES.has(declared)?declared:inferred;if(!ALLOWED_TYPES.has(type))throw new Error('格式不受支持或网页返回了登录页/HTML');if(item.kind==='image'&&!type.startsWith('image/'))throw new Error('网页图片链接返回的不是图片');if(item.kind==='video'&&!type.startsWith('video/'))throw new Error('网页视频链接返回的不是视频');return type;}
async function importSelected(){
  const chosen=selectedEntries();if(!chosen.length||!connected||importing)return;
  if(chosen.length>MAX_SELECTION){setStatus(`一次最多处理 ${MAX_SELECTION} 份，请分批选择。`,'error');return;}
  const classify=$('#classify-after-import').checked,classificationModel=classify?selectedClassificationModel():null;
  if(classify){
    if(!chosen.some(item=>item.kind==='image')){setStatus('智能分类需要至少选择一张图片','error');return;}
    if(!classificationModel){setStatus('请选择可用的图片理解模型','error');$('#classification-model').focus();return;}
    if(!$('#classification-consent').checked){setStatus('请先勾选本次图片发送和费用授权','error');$('#classification-consent').focus();return;}
    if(!classificationModel.local){
      const key=$('#classification-key').value,budget=Number($('#classification-budget').value);
      if(!key.trim()||key.length>4096||/[\r\n]/u.test(key)){setStatus('请填写有效的本次 API Key（不能包含换行，最多 4096 个字符）','error');$('#classification-key').focus();return;}
      if(!Number.isFinite(budget)||budget<=0||budget>1_000_000){setStatus('请填写 0 到 1,000,000 之间的单张预算授权','error');$('#classification-budget').focus();return;}
    }
  }
  const base=serverAddress($('#server-url').value),category=safeName($('#category').value,'网页采集').slice(0,80),classificationAuth=classify?{platformId:classificationModel.platformId,model:classificationModel.modelId,apiKey:$('#classification-key').value.trim(),prompt:'',authorization:{origin:classificationModel.origin,model:classificationModel.modelId,sendImage:true,requestLimit:1,budget:classificationModel.local?0:Number($('#classification-budget').value),currency:$('#classification-currency').value,consent:true}}:null;let imported=0,classified=0,classificationSkipped=0,classificationNotSent=0,classificationStopped=false,classificationError='';const failures=[];
  importing=true;updateActions();
  try{if(!await requestOrigins(chosen)){setStatus('未授予所选网页的读取权限','error');if(classificationAuth)classificationAuth.apiKey='';$('#classification-key').value='';$('#classification-consent').checked=false;importing=false;updateActions();return;}}catch(error){setStatus(error.message||'网页权限申请失败','error');if(classificationAuth)classificationAuth.apiKey='';$('#classification-key').value='';$('#classification-consent').checked=false;importing=false;updateActions();return;}
  for(let index=0;index<chosen.length;index++){
    const item=chosen[index];setStatus(`正在导入 ${index+1}/${chosen.length}：${item.name}`,'');
    try{
      const blob=await fetchItem(item),type=actualType(blob,item);if(!blob.size)throw new Error('网页素材为空');
      const name=fileNameForType(item.name||extensionName(item.url)||`网页素材-${index+1}`,type),query=new URLSearchParams({name,category});
      const response=await fetch(base+'/api/chrome-import?'+query,{method:'POST',headers:{'Content-Type':type},body:blob,credentials:'omit'});
      if(!response.ok){const result=await response.json().catch(()=>({}));throw new Error(result.error||`本机保存失败（${response.status}）`);}const saved=await response.json();imported++;
      if(classify&&item.kind==='image'){
        if(classificationStopped){classificationNotSent++;continue;}
        if(!['image/png','image/jpeg','image/webp'].includes(type)||blob.size>10*1024*1024){classificationSkipped++;continue;}
        try{
          const classifyBody={...classificationAuth,requestId:crypto.randomUUID(),consent:true};
          const classifiedResponse=await fetch(base+`/api/assets/${encodeURIComponent(saved.id)}/classify`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(classifyBody),credentials:'omit'});
          if(!classifiedResponse.ok){const result=await classifiedResponse.json().catch(()=>({}));throw new Error(result.error||`分类服务返回 ${classifiedResponse.status}`);}await classifiedResponse.json();classified++;
        }catch(error){classificationStopped=true;const message=String(error.message||'图片分类失败');classificationError=(classificationAuth?.apiKey?message.split(classificationAuth.apiKey).join('[已隐藏密钥]'):message).slice(0,600);}
      }
    }catch(error){failures.push(`${safeName(item.name)}：${error.message||'导入失败'}`);}
  }
  if(classificationAuth)classificationAuth.apiKey='';$('#classification-key').value='';$('#classification-consent').checked=false;importing=false;
  const details=[`已保存 ${imported}/${chosen.length} 份`,classify?`智能分类完成 ${classified} 张${classificationSkipped?`，跳过 ${classificationSkipped} 张（格式或大小不支持）`:''}${classificationNotSent?`，另有 ${classificationNotSent} 张因前序错误未发送`:''}`:'',failures.length?`导入失败 ${failures.length} 份`:'',classificationStopped?`分类已停止：${classificationError}。上游可能已处理本次请求，请先检查服务商任务和账单；没有自动重试。`: ''].filter(Boolean);
  setStatus(details.join('；'),failures.length||classificationStopped?'error':'ok');
  const messages=[...failures.map(message=>`导入失败：${message}`),...(classificationStopped?[`分类已停止：${classificationError}；后续图片未发送`]:[])];if(messages.length)$('#items').insertAdjacentHTML('beforeend',`<div class="empty">${messages.map(message=>escapeHtml(message)).join('<br>')}</div>`);updateActions();
}
function escapeHtml(value){return String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));}
async function startDownload(blob,filename){
  const url=URL.createObjectURL(blob);
  try{await chrome.downloads.download({url,filename,saveAs:false});setTimeout(()=>URL.revokeObjectURL(url),120000);}
  catch(error){URL.revokeObjectURL(url);throw error;}
}
async function downloadSelected(){
  const chosen=selectedEntries();if(!chosen.length)return;if(chosen.length>MAX_SELECTION){setStatus(`一次最多处理 ${MAX_SELECTION} 份，请分批选择。`,'error');return;}
  try{if(!await requestOrigins(chosen)){setStatus('未授予所选网页的读取权限','error');return;}}catch(error){setStatus(error.message||'网页权限申请失败','error');return;}
  $('#download').disabled=true;let count=0;const failures=[];
  try{
    if(chosen.length===1){
      const item=chosen[0],blob=await fetchItem(item),type=actualType(blob,item);if(!blob.size)throw new Error('网页素材为空');
      await startDownload(new Blob([blob],{type}),fileNameForType(item.name,type));count=1;
    }else{
      const folder=archiveFolderName(),used=new Set(),files=[];let totalBytes=0;
      for(const [index,item] of chosen.entries())try{
        setStatus(`正在准备 ZIP ${index+1}/${chosen.length}：${item.name}`,'');
        const blob=await fetchItem(item),type=actualType(blob,item);if(!blob.size)throw new Error('网页素材为空');
        if(totalBytes+blob.size>MAX_ARCHIVE_BYTES)throw new Error('素材总大小超过 ZIP 下载上限 256 MiB');
        totalBytes+=blob.size;files.push({name:`${folder}/${uniqueArchiveFilename(item.name,type,used)}`,blob:new Blob([blob],{type})});
      }catch(error){failures.push(`${safeName(item.name)}：${error.message||'下载失败'}`);}
      if(!files.length)throw new Error(failures[0]||'没有可打包下载的素材');
      const archive=await createZipArchive(files,{maxTotalBytes:MAX_ARCHIVE_BYTES});
      await startDownload(archive,`${folder}.zip`);count=files.length;
    }
    setStatus(`已开始下载 ${count}/${chosen.length} 份${chosen.length>1?'（ZIP）':''}${failures.length?`，失败 ${failures.length} 份`:''}`,failures.length?'error':'ok');
    if(failures.length)$('#items').insertAdjacentHTML('beforeend',`<div class="empty">${failures.map(message=>escapeHtml(message)).join('<br>')}</div>`);
  }catch(error){setStatus(error.message||'下载失败','error');}
  finally{updateActions();}
}
async function captureVisible(){
  try{
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});if(!tab?.id)throw new Error('没有可截取的网页标签');activeTab=tab;
    const dataUrl=await chrome.tabs.captureVisibleTab(tab.windowId,{format:'png'});const blob=await fetch(dataUrl).then(response=>response.blob());
    entries.unshift({url:dataUrl,kind:'image',name:`网页可见画面-${new Date().toISOString().replace(/[:.]/g,'-')}.png`,frameId:0,width:0,height:0,unsupported:false});renderItems();
    const input=$('[data-entry-index]');if(input)input.checked=true;updateActions();setStatus(`已截取当前视口（${Math.round(blob.size/1024)} KB），可勾选后保存`,'ok');
  }catch(error){setStatus(error.message||'截取失败','error');}
}
async function openSidePanel(){try{const [tab]=await chrome.tabs.query({active:true,currentWindow:true});if(tab?.id)await chrome.sidePanel.open({tabId:tab.id});}catch(error){setStatus(error.message||'无法打开侧栏','error');}}

$('#connect').addEventListener('click',connect);
$('#scan').addEventListener('click',scan);
$('#capture').addEventListener('click',captureVisible);
$('#network-capture').addEventListener('click',()=>networkPort?finishNetworkCapture('已停止网络监听',true):startNetworkCapture());
$('#import').addEventListener('click',importSelected);
$('#download').addEventListener('click',downloadSelected);
$('#side-panel').addEventListener('click',openSidePanel);
$('#select-all').addEventListener('click',()=>{const inputs=[...document.querySelectorAll('[data-entry-index]:not(:disabled)')];const select=inputs.some(input=>!input.checked);for(const input of inputs)input.checked=select;updateActions();$('#select-all').textContent=select?'取消全选':'全选';});
$('#server-url').addEventListener('change',()=>{connected=false;classificationModels=[];$('#classify-after-import').checked=false;$('#classification-key').value='';$('#classification-consent').checked=false;activeTab=null;frameOrigins=[];$('#scan').disabled=true;$('#capture').disabled=true;updateActions();});
$('#classify-after-import').addEventListener('change',()=>{if(!$('#classify-after-import').checked)$('#classification-consent').checked=false;updateActions();});
$('#classification-model').addEventListener('change',()=>{$('#classification-consent').checked=false;updateActions();});
$('#classification-budget').addEventListener('input',updateActions);
$('#classification-currency').addEventListener('change',updateActions);
$('#classification-settings').addEventListener('submit',event=>event.preventDefault());
$('#category').addEventListener('change',()=>chrome.storage.local.set({category:$('#category').value}));
$('#scroll-first').addEventListener('change',()=>chrome.storage.local.set({scrollFirst:$('#scroll-first').checked}));
$('#include-cross-frames').addEventListener('change',()=>chrome.storage.local.set({includeCrossFrames:$('#include-cross-frames').checked}));
loadPreferences().then(connect).catch(error=>setStatus(error.message||'初始化失败','error'));
