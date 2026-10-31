import {nativeMediaFetch as fetch} from './native-media-session.js';
import {transferSize} from './media-transfer-core.js';

const esc=(s='')=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={checked:'检查通过',blocked:'需要处理',importing:'正在迁入',interrupted:'已中断',failed:'未完成',completed:'已迁入'};
async function request(url,payload,{signal}={}){
 const response=await fetch(url,{method:payload?'POST':'GET',signal,...(payload?{headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}:{})});
 let result;try{result=await response.json();}catch{throw Error('未收到完整响应，请读取原记录核对');}
 if(!response.ok)throw Error(result.error||'素材库迁入未完成');return result;
}

// Keep request identities until a read confirms their outcome. A lost response must
// never turn a retry into another migration with fresh asset identities.
export function createNativeLibraryImportController({projectId,api=request,onState=()=>{},onImport}){
 let sourceDirectory='',items=[],issues=[],current=null,busy=false,confirmed=false,error='',message='',awaitingRead=false,controller=null,previewRequest=null;
 const imports=new Map(),scope='?projectId='+encodeURIComponent(projectId);
 const snapshot=()=>({sourceDirectory,items,issues,current,busy,confirmed,error,message,awaitingRead});
 const emit=()=>onState(snapshot());
 function accept(record){if(record.projectId!==projectId)throw Error('迁入记录不属于当前工程');current=record;sourceDirectory=record.sourceDirectory;previewRequest=null;confirmed=false;awaitingRead=false;if(record.importRequestId)imports.set(record.id,record.importRequestId);}
 async function run(operation){
  if(busy)return;busy=true;error='';message='';controller=new AbortController();emit();
  try{return await operation(controller.signal);}catch(e){error=e.name==='AbortError'?'已停止本机操作，收到的副本保留。请读取原记录后继续。':e.message;emit();throw e;}finally{busy=false;controller=null;emit();}
 }
 return {
  snapshot,
  setSource(value){if(busy)return;const changed=value.trim()!==sourceDirectory.trim();sourceDirectory=value;if(changed){previewRequest=null;current=null;confirmed=false;awaitingRead=false;error='';message='目录已更改，请重新检查。';}emit();},
  setConfirmed(value){confirmed=!!value;emit();},
  async load(){return run(async signal=>{const result=await api('/api/native-library-imports'+scope,undefined,{signal});items=result.items;issues=result.issues;if(current){const record=items.find(i=>i.id===current.id);if(record)accept(record);}message='已读取本机记录，没有访问源目录或重新迁入。';});},
  async read(id){return run(async signal=>{accept(await api('/api/native-library-imports/'+encodeURIComponent(id)+scope,undefined,{signal}));message=current.message||'已读取原记录，可核对后继续。';});},
  async preview({newVersion=false}={}){
   if(!sourceDirectory.trim())throw Error('请填写原版 Infinite Canvas 项目文件夹的完整路径');
   const previous=items.find(i=>i.sourceDirectory===sourceDirectory.trim()&&i.importRequestId&&i.status!=='completed')||(!newVersion&&items.find(i=>i.sourceDirectory===sourceDirectory.trim()&&i.importRequestId));
   if(previous){await this.read(previous.id);message='此目录已有迁入记录，请核对原记录；没有另建迁入计划。';emit();return current;}
   return run(async signal=>{previewRequest??=crypto.randomUUID();awaitingRead=true;accept(await api('/api/native-library-imports/preview',{requestId:previewRequest,projectId,sourceDirectory:sourceDirectory.trim()},{signal}));items=[current,...items.filter(i=>i.id!==current.id)];message=current.canImport?'检查通过，请核对内容后确认迁入。':'尚未迁入，请先处理下面列出的缺失或不支持项。';});
  },
  async import(){
   if(!current?.canImport||awaitingRead)throw Error('请先读取并通过检查');
   if(!confirmed)throw Error('请先勾选确认迁入独立副本');
   const record=current;
   return run(async signal=>{
    const revision=(await api('/api/asset-catalog',undefined,{signal})).revision;
    const requestId=record.importRequestId||imports.get(record.id)||crypto.randomUUID();imports.set(record.id,requestId);awaitingRead=true;
    const result=await api('/api/native-library-imports/'+encodeURIComponent(record.id)+'/import',{requestId,projectId,revision,confirmLocalImport:true},{signal});
    current={...record,status:'completed',canImport:false,importRequestId:requestId,result};confirmed=false;awaitingRead=false;items=[current,...items.filter(i=>i.id!==current.id)];message='已迁入独立素材库，原文件和当前画布保留。';
    try{await onImport?.(result);}catch{message+='目录显示尚未刷新，请点击素材库的刷新按钮。';}
    return result;
   });
  },
  stop(){controller?.abort();},
 };
}

function problemList(title,rows){
 if(!rows?.length)return '';
 return `<details open><summary>${esc(title)}（${rows.length}）</summary><ul>${rows.map(i=>`<li>${esc(typeof i==='string'?i:[i.name||i.id,i.reason||i.message].filter(Boolean).join('：'))}</li>`).join('')}</ul></details>`;
}
export function nativeLibraryImportPanel({projectId,onImport,onBusy=()=>{},isBlocked=()=>false}){
 let root=null,open=false,state,shownBusy=false,loaded=false,loading=false;
 const control=createNativeLibraryImportController({projectId,onImport,onState:s=>{state=s;if(s.busy!==shownBusy){shownBusy=s.busy;onBusy(s.busy);}render();}});
 state=control.snapshot();
 function render(){
  if(!root?.isConnected)return;
  const focused=root.contains(document.activeElement)?document.activeElement:null,focusKey=focused?.getAttribute('data-native-library'),selection=focused?.type==='text'?[focused.selectionStart,focused.selectionEnd]:null;
  const p=state.current,c=p?.counts||{},busy=state.busy||isBlocked();
  root.innerHTML=`<details class="catalog-workflow-import" ${open?'open':''}><summary>迁入原版 Infinite Canvas 素材库</summary><section class="catalog-backup-panel"><p class="catalog-note">选择原版项目文件夹（里面有 data 和 assets），先检查，再迁入为新增素材库。保留库名、空分组、素材分类和支持的工作流；不会改动源文件或执行生成。</p><label>原版项目文件夹<input type="text" data-native-library="source" value="${esc(state.sourceDirectory)}" placeholder="/Users/你的用户名/Infinite-Canvas" autocomplete="off" spellcheck="false" maxlength="4096" ${busy?'disabled':''}></label><div class="catalog-backup-actions"><button data-native-library="preview" ${busy||!state.sourceDirectory.trim()?'disabled':''}>检查此目录</button><button data-native-library="load" ${busy?'disabled':''}>读取原迁入记录</button>${busy?'<button data-native-library="stop">停止本机操作</button>':''}</div><p class="catalog-note">仅接受该项目里的本机文件。缺失文件、外部链接和不支持的条目会列出；不会联网补下载。原件合计最多 4GiB，目录清单最多 12MiB。</p>${p?`<article><strong>${esc(labels[p.status]||p.status)}</strong><p class="catalog-note">${esc(p.sourceDirectory)}</p><p>${c.libraries||0} 个库 · ${c.folders||0} 个分组 · ${c.media||0} 份媒体 · ${(c.workflows||0)+(c.fragments||0)} 个工作流 · ${transferSize(p.bytes||0)}</p>${problemList('缺失文件',p.missing)}${problemList('不支持的条目',p.unsupported)}${problemList('检查说明',p.warnings)}${p.canImport&&!state.awaitingRead?`<label class="catalog-native-consent"><input type="checkbox" data-native-library="confirm" ${state.confirmed?'checked':''} ${busy?'disabled':''}><span>确认迁入为独立副本，原素材库保持</span></label><button data-native-library="import" ${busy||!state.confirmed?'disabled':''}>${p.importRequestId?'继续原迁入':'确认迁入素材库'}</button>`:''}${state.awaitingRead?'<p role="status">结果尚待核对，请读取原记录；不会自动重新迁入。</p>':''}<p class="catalog-note">${esc(p.message||'')}</p></article>`:''}${busy?'<progress aria-label="正在检查或复制本机素材"></progress>':''}<p role="status" aria-live="polite">${esc(state.error||state.message)}</p>${state.items.length?`<details><summary>已有迁入记录（${state.items.length}）</summary><div class="catalog-backup-imports">${state.items.map(i=>`<article><strong>${esc(labels[i.status]||i.status)}</strong><p class="catalog-note">${esc(i.sourceDirectory)}</p><button data-native-library="read" data-record-id="${esc(i.id)}" ${busy?'disabled':''}>读取这条记录</button></article>`).join('')}</div></details>`:''}${problemList('未能读取的记录',state.issues)}</section></details>`;
  root.querySelector('details').ontoggle=e=>{open=e.target.open;};
  root.querySelector('[data-native-library=source]').oninput=e=>{control.setSource(e.target.value);root.querySelector('[data-native-library=preview]').disabled=!e.target.value.trim();};
  const check=root.querySelector('[data-native-library=confirm]');if(check)check.onchange=e=>control.setConfirmed(e.target.checked);
  if(isBlocked()){root.querySelector('[role=status]')?.append(' 另一项素材库操作正在处理，请等待或先停止该操作。');if(!state.busy){root.querySelector('[data-native-library=stop]')?.remove();root.querySelector('progress')?.remove();}}
  if(!loaded)root.querySelector('[data-native-library=preview]').disabled=true;
  if(p?.status==='completed'&&!busy){const button=document.createElement('button');button.dataset.nativeLibrary='new-version';button.textContent='检查源库的新版本';root.querySelector('article').append(button);}
  root.onclick=e=>{const b=e.target.closest('button');if(!b||!root.contains(b))return;e.stopPropagation();const action=b.dataset.nativeLibrary;if(action==='stop'){control.stop();return;}if(state.busy||isBlocked()||(!loaded&&action!=='load'))return;open=true;const pending=action==='read'?control.read(b.dataset.recordId):action==='new-version'?control.preview({newVersion:true}):control[action]?.();void Promise.resolve(pending).then(()=>{if(action==='load'){loaded=true;render();}}).catch(error=>{state={...control.snapshot(),error:error.message};render();});};
  if(focusKey){const element=root.querySelector(`[data-native-library="${focusKey}"]`);element?.focus({preventScroll:true});if(selection&&element?.type==='text')element.setSelectionRange(...selection);}
 }
 return {
  mount(element){root=element;state=control.snapshot();render();if(!loaded&&!loading){loading=true;void control.load().then(()=>{loaded=true;}).catch(()=>{}).finally(()=>{loading=false;render();});}},
  refresh(){render();},
  dispose(){control.stop();root=null;},
 };
}
