import {getNativeMediaPageSession} from './native-media-session.js';
import {nativeMediaFetch as fetch} from './native-media-session.js';
import {transferSize} from './media-transfer-core.js';
import {taskPresentation} from './task-state-core.js';
const esc=(s='')=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(url,payload){
 const response=await fetch(url,{method:payload?'POST':'GET',...(payload?{headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}:{})}),result=await response.json();
 if(!response.ok)throw Error(result.error||'整库操作未完成');return result;
}
export function libraryBackupPanel({projectId,onRestore,focusJobId='',isBlocked=()=>false,onBusy=()=>{}}){
 let root=null,jobs=[],imports=[],busy=false,error='',timer,closed=false,exportRequest=null,uploadRequest=null,file=null,xhr=null,uploadProgress=null,pendingFocus=null,loaded=false;
 const restoreRequests=new Map(),notified=new Set();
 const scope='?projectId='+encodeURIComponent(projectId);
 function updateBusy(){onBusy(!loaded||busy||jobs.some(j=>['queued','running'].includes(j.status)));}
 function counts(p){return `${p.libraries} 个库 · ${p.folders} 个分组 · ${p.items} 个条目 · ${transferSize(p.bytes)}`;}
 function render(){
  if(!root?.isConnected||closed)return;
  const focused=root.contains(document.activeElement)?document.activeElement:null;
  const focusAttribute=focused&&[...focused.attributes].find(a=>a.name==='id'||a.name.startsWith('data-library-'));
  const focusSelector=focusAttribute?`[${focusAttribute.name}="${CSS.escape(focusAttribute.value)}"]`:document.activeElement===document.body?pendingFocus:null;
  const selection=file?`<p class="catalog-note">已选 ${esc(file.name)} · ${transferSize(file.size)}</p>`:'';
  root.innerHTML=`<section class="catalog-backup-panel"><h3>素材库整库备份</h3><p class="catalog-note">包含所有库、空分组、回收条目、图片／视频／音频原件、ComfyUI 模板、完整工程快照和选中画布工作流。只备份已经保存到素材库的内容；当前工程可另用工程备份保存。</p><button data-library-backup="export" ${busy||!loaded?'disabled':''}>创建整库备份</button><h3>接收与恢复</h3><label>整库文件（.jingchang-library）<input id="library-backup-file" type="file" accept=".jingchang-library,application/octet-stream" ${busy||!loaded?'disabled':''}></label>${selection}<div class="catalog-backup-actions"><button data-library-backup="upload" ${busy||!file?'disabled':''}>接收并检查</button>${xhr?'<button data-library-backup="stop-upload">停止接收</button>':''}<button data-library-backup="refresh" ${busy?'disabled':''}>读取原接收与任务记录</button></div><p class="catalog-note">先检查，再明确恢复为新增素材库。原库、当前画布和任务保持；不会运行生成或联网验证账号。平台密钥、任务历史和未入库工程不包含在整库文件中。每份整库包：原件合计最多4GiB，配置最多12MiB。</p>${uploadProgress?`<p role="status">${esc(uploadProgress.message)}</p>${uploadProgress.total?`<progress aria-label="整库文件已发送字节" max="${uploadProgress.total}" value="${uploadProgress.loaded}"></progress>`:'<progress aria-label="正在检查整库文件"></progress>'}`:''}<p class="catalog-backup-error" role="status" aria-live="polite">${esc(error)}</p><div class="catalog-backup-imports">${imports.map(p=>{
   const job=jobs.find(j=>j.kind==='library-restore'&&j.importId===p.id),canRestore=p.status==='checked'&&!job;
   return `<article><strong>${p.status==='checked'?'已检查的整库文件':'未完整接收的文件'}</strong><p>${p.status==='checked'?esc(counts(p)):`已接收 ${transferSize(p.bytesReceived||0)}；请选择原文件重新接收`}</p>${p.status==='checked'?`<p class="catalog-note">${p.canvases} 个完整快照 · ${p.fragments} 个画布工作流 · ${p.workflows} 个模板 · ${p.archivedLibraries} 个回收库</p><details><summary>包含的库</summary><ul>${p.libraryNames.map(l=>`<li>${esc(l.name)}${l.archived?'（已回收）':''} · ${l.folders} 个分组</li>`).join('')}</ul></details>`:`<p class="catalog-note">${esc(p.error||'尚未完成检查')}</p>`}${canRestore?`<button data-library-restore="${esc(p.id)}" ${busy?'disabled':''}>恢复为新增素材库</button>`:job?`<p class="catalog-note">已建立原恢复任务，请在下面读取或继续该记录。</p>`:''}</article>`;
  }).join('')||(loaded?'<p class="catalog-note">暂无已接收文件。</p>':'<p class="catalog-note" role="status">正在读取接收记录…</p>')}</div><h3>整库任务记录</h3><div class="catalog-backup-jobs">${jobs.map(j=>{
   const p=taskPresentation(j),running=['queued','running'].includes(j.status);
   return `<article data-library-job="${esc(j.id)}"><div><strong>${esc(j.name)}</strong> · ${esc(p.label)}</div><p>${esc(j.message)}</p>${p.progress?`<progress aria-label="${esc(j.name)}已完成步骤" value="${p.progress.value}" max="${p.progress.total}"></progress><small>${p.progress.value} / ${p.progress.total} 步</small>`:running?'<progress aria-label="正在核对整库文件"></progress>':''}${j.result?.url?`<p>${esc(counts(j.result))}</p><a href="${esc(j.result.url)}" download="assets.jingchang-library">下载整库备份</a>`:''}<div class="catalog-backup-actions">${running?`<button data-library-cancel="${esc(j.id)}" ${busy?'disabled':''}>停止本机操作</button>`:j.canResume?`<button data-library-resume="${esc(j.id)}" ${busy?'disabled':''}>继续原记录</button>`:''}</div></article>`;
  }).join('')||(loaded?'<p class="catalog-note">暂无整库备份或恢复任务。</p>':'<p class="catalog-note" role="status">正在读取任务记录…</p>')}</div></section>`;
  if(isBlocked())for(const element of root.querySelectorAll('button,input'))if(element.dataset.libraryBackup!=='stop-upload'&&!element.dataset.libraryCancel)element.disabled=true;
  const input=root.querySelector('#library-backup-file');
  if(file&&typeof DataTransfer==='function'){const selection=new DataTransfer();selection.items.add(file);input.files=selection.files;}
  input.addEventListener('change',()=>{file=input.files[0]||null;uploadRequest=null;uploadProgress=null;error='';render();});
  root.onclick=event=>{
   const b=event.target.closest('button');if(!b||!root.contains(b))return;event.stopPropagation();
   if(b.dataset.libraryBackup==='stop-upload'){xhr?.abort();return;}
   const ownCancel=b.dataset.libraryCancel&&jobs.some(j=>j.id===b.dataset.libraryCancel&&['queued','running'].includes(j.status));
   if(busy||isBlocked()&&!ownCancel)return;
   void action(b).catch(e=>{error=e.message;}).finally(()=>{busy=false;updateBusy();render();});
  };
  if(focusSelector)root.querySelector(focusSelector)?.focus({preventScroll:true});
  if(focusJobId){const record=root.querySelector(`[data-library-job="${CSS.escape(focusJobId)}"]`);if(record){record.scrollIntoView({block:'nearest'});focusJobId='';}}
 }
 async function reload(){
  clearTimeout(timer);
  [jobs,imports]=await Promise.all([api('/api/asset-library-backups'+scope),api('/api/asset-library-backups/imports'+scope)]);
  if(closed)return;loaded=true;updateBusy();render();
  for(const j of jobs){if(j.kind==='library-restore'&&j.status==='completed'&&!notified.has(j.id)){notified.add(j.id);await onRestore?.(j.result);}}
  if(root?.isConnected&&jobs.some(j=>['queued','running'].includes(j.status)))timer=setTimeout(()=>reload().catch(e=>{error=e.message;render();}),1000);
 }
 async function revision(){return (await api('/api/asset-catalog')).revision;}
 async function receive(){
  if(!file||!/\.jingchang-library$/i.test(file.name))throw Error('请选择 .jingchang-library 整库备份文件');
  if(file.size>4*1024**3+12*1024**2+64)throw Error('整库文件超过容量限制');
  uploadRequest??=crypto.randomUUID();const query=new URLSearchParams({requestId:uploadRequest,projectId});
  const mediaSession=getNativeMediaPageSession(),uploadHeaders=await mediaSession.prepareUpload({'Content-Type':'application/octet-stream'});
  await new Promise((resolve,reject)=>{
   const transfer=new XMLHttpRequest();xhr=transfer;transfer.open('POST','/api/asset-library-backups/imports?'+query);for(const [name,value]of uploadHeaders)transfer.setRequestHeader(name,value);
   transfer.upload.onprogress=e=>{uploadProgress={loaded:e.loaded,total:e.lengthComputable?e.total:0,message:`已发送 ${transferSize(e.loaded)}${e.lengthComputable?' / '+transferSize(e.total):''}；尚未完成文件检查`};render();};
   transfer.upload.onload=()=>{uploadProgress={loaded:0,total:0,message:'文件已发送，正在核对内容；尚未恢复素材库'};render();};
   const finish=()=>{xhr=null;uploadProgress=null;};
   transfer.onload=()=>{finish();let result;try{result=JSON.parse(transfer.responseText);}catch{reject(Error('未收到完整接收结果；请先读取原接收记录，未自动重传'));return;}try{mediaSession.checkResponse({header:transfer.getResponseHeader('x-jingchang-media-session'),status:transfer.status,body:result});}catch(error){reject(error);return;}if(transfer.status<200||transfer.status>=300){reject(Error(result.error||'整库接收未完成'));return;}uploadProgress=null;resolve(result);};
   transfer.onerror=()=>{finish();reject(Error('接收响应中断；请先读取原接收记录，没有自动重传'));};
   transfer.onabort=()=>{finish();reject(Error('已停止接收，收到的副本保留；原素材库保持'));};
   uploadProgress={loaded:0,total:file.size,message:'正在发送本机整库文件'};render();transfer.send(file);
  });
  await reload();
 }
 async function action(b){
  const attribute=[...b.attributes].find(a=>a.name.startsWith('data-library-'));pendingFocus=attribute?`[${attribute.name}="${CSS.escape(attribute.value)}"]`:null;
  busy=true;error='';updateBusy();render();
  if(b.dataset.libraryBackup==='refresh'){await reload();return;}
  if(b.dataset.libraryBackup==='export'){
   exportRequest??=crypto.randomUUID();await api('/api/asset-library-backups',{requestId:exportRequest,projectId,revision:await revision()});exportRequest=null;await reload();return;
  }
  if(b.dataset.libraryBackup==='upload'){await receive();return;}
  if(b.dataset.libraryRestore){
   const id=b.dataset.libraryRestore;restoreRequests.set(id,restoreRequests.get(id)||crypto.randomUUID());
   await api('/api/asset-library-backups/imports/'+encodeURIComponent(id)+'/restore',{requestId:restoreRequests.get(id),projectId,revision:await revision()});await reload();return;
  }
  if(b.dataset.libraryResume){await api('/api/asset-library-backups/'+encodeURIComponent(b.dataset.libraryResume)+'/resume',{projectId,revision:await revision()});await reload();return;}
  if(b.dataset.libraryCancel){await api('/api/asset-library-backups/'+encodeURIComponent(b.dataset.libraryCancel)+'/cancel',{projectId});await reload();}
 }
 return {mount(element){root=element;closed=false;updateBusy();render();void reload().catch(e=>{error=e.message;render();});},refresh(){render();},dispose(){closed=true;clearTimeout(timer);root=null;}};
}
