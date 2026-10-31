import {nativeMediaFetch as fetch} from './native-media-session.js';
import {openPublicMedia} from './public-media.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const endpoint='https://ark.cn-beijing.volcengineapi.com';
const labels={Created:'素材组已建立',Active:'可用',Processing:'处理中',Failed:'失败',submitting:'提交中',uncertain:'结果待确认'};
async function api(url,body){const res=await fetch(url,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const r=await res.json();if(!res.ok)throw Error(r.error||'本机素材库请求失败');return r;}
export async function openArkAssets({projectId,assets=[],onUse}){
 if(document.querySelector('#ark-assets-dialog'))return;
 if(!document.querySelector('#ark-assets-css')){const link=document.createElement('link');link.id='ark-assets-css';link.rel='stylesheet';link.href='/ark-assets.css';document.head.append(link);}
 const d=document.createElement('dialog');d.id='ark-assets-dialog';d.className='ark-assets-dialog';
 d.innerHTML=`<header><div><strong>火山素材库</strong><small>素材组、入库状态与平台引用</small></div><button data-ark="close" aria-label="关闭火山素材库">×</button></header><div class="ark-body"><p class="ark-note">入库只接受公网地址。不会自动公开本机服务，不会自动上传本机文件。没有公网地址时，可主动选择临时托管后再入库。平台会读取地址中的完整文件和声音。</p><details><summary>使用前须知</summary><p>首次创建素材组前，须由你在火山控制台完成素材库授权函。当前接入 AIGC 虚拟素材组；真人活体认证需在平台完成。查询和生成的密钥须属于同一个火山项目。视频生成仍需单独确认预算。</p><a href="https://docs.volcengine.com/docs/ark/create-asset-api?lang=zh" target="_blank" rel="noreferrer">官方素材入库说明 ↗</a></details><section class="ark-connection"><label>素材库服务地址<input id="ark-endpoint" value="${endpoint}" type="url"></label><label>火山项目名称<input id="ark-cloud-project" value="default" maxlength="64"></label><label>本次 Access Key ID<input id="ark-ak" type="password" autocomplete="off" spellcheck="false"></label><label>本次 Secret Access Key<input id="ark-sk" type="password" autocomplete="off" spellcheck="false"></label><p class="ark-note">凭据仅用于本次操作，完成后清空；不保存到本机、浏览器或备份。</p></section><section><h3>平台查询</h3><div class="ark-grid"><label>查询范围<select id="ark-query-kind"><option value="ListAssetGroups">素材组</option><option value="ListAssets">素材</option></select></label><label>名称搜索<input id="ark-search" maxlength="64"></label><label>页码<input id="ark-page" type="number" min="1" max="1000" value="1"></label></div><label class="ark-check"><input id="ark-query-consent" type="checkbox"><span>同意向上述地址发送本次签名请求，查询上述火山项目；不入库或生成素材。</span></label><button data-ark="browse">查询这一页</button><div id="ark-remote"></div></section><section><h3>入库准备</h3><div class="ark-grid"><label>操作<select id="ark-create-kind"><option value="ark-material">添加素材</option><option value="ark-group">创建 AIGC 素材组</option></select></label><label>名称<input id="ark-name" maxlength="64"></label><label>素材类型<select id="ark-type"><option value="Image">图片</option><option value="Video">视频 MP4/MOV</option><option value="Audio">音频 MP3/WAV</option></select></label></div><label>素材组 ID<input id="ark-group-id" placeholder="group-…"></label><button data-ark="hosting">从本机文件取得公网链接</button><p id="ark-hosting-source" class="ark-note"></p><label>公网素材地址<input id="ark-source-url" type="url" placeholder="https://…（不含查询参数或凭据）"></label><label>关联本机素材（可选，仅检查与记录）<select id="ark-local-asset"><option value="">不关联本机文件</option>${assets.filter(a=>/^(image\/(png|jpeg|webp)|video\/(mp4|quicktime)|audio\/(wav|x-wav|mpeg))$/.test(a.type)).map(a=>`<option value="${esc(a.id)}">${esc(a.name)} · ${esc(a.type)}</option>`).join('')}</select></label><label>素材组描述<input id="ark-description" maxlength="300"></label><p class="ark-note">本机检查不证明公网文件与本机文件相同。关联视频可检查2–30秒、24–60帧和尺寸；Seedance 2.0生成参考仍限制为2–15秒。</p><button data-ark="preview">本机预览发送范围</button><div id="ark-preview"></div></section><section><h3>本项目保存的记录</h3><p class="ark-note">打开或刷新列表只读取本机。只有“查询原编号”会联系平台；处理中与待确认的记录不能引用。</p><div id="ark-records"></div></section><p id="ark-status" role="status" aria-live="polite"></p></div>`;
 document.body.append(d);d.showModal();const $=s=>d.querySelector(s);let items=[],remote=[],plan=null,previewForm=null,requestId=null,publicMediaId=null,busy=false;
 function message(s){$('#ark-status').textContent=s;}
 function clearKeys(){$('#ark-ak').value=$('#ark-sk').value='';}
 function scope(){return {endpoint:$('#ark-endpoint').value.trim(),cloudProject:$('#ark-cloud-project').value.trim()||'default'};}
 function form(){return {projectId,...scope(),kind:$('#ark-create-kind').value,name:$('#ark-name').value.trim(),assetType:$('#ark-type').value,groupId:$('#ark-group-id').value.trim(),sourceUrl:$('#ark-source-url').value.trim(),localAssetId:$('#ark-local-asset').value,description:$('#ark-description').value,...(publicMediaId?{publicMediaId}: {})};}
 function keys(){return {accessKeyId:$('#ark-ak').value.trim(),secretAccessKey:$('#ark-sk').value.trim()};}
 function consent(action,s=scope()){return {...s,action,requestLimit:1,sendCredentials:true};}
 async function load(){items=await api('/api/ark-assets?projectId='+encodeURIComponent(projectId));renderRecords();}
 function status(r){return (r.restored?'备份恢复，需查询原编号 · ':'')+(labels[r.status]||r.status);}
 function renderRecords(){
  $('#ark-records').innerHTML=items.length?items.map(r=>`<article class="ark-record"><strong>${esc(r.name)}</strong><small>${esc(status(r))} · ${esc(r.cloudProject)}${r.localSource?.duration?' · '+r.localSource.duration.toFixed(2)+'秒':''}</small><code>${esc(r.kind==='ark-group'?r.cloudId||'暂无平台编号':r.cloudId?'asset://'+r.cloudId:'暂无平台编号')}</code><div class="ark-buttons">${r.kind==='ark-group'&&r.cloudId?`<button data-ark-group="${esc(r.id)}">选择这个素材组</button>`:''}${r.kind==='ark-material'&&r.cloudId?`<button data-ark-refresh="${esc(r.id)}">查询原编号</button>`:''}${r.kind==='ark-material'&&r.status==='Active'?`<button data-ark-use="${esc(r.id)}" ${!onUse||r.restored||r.localSource?.duration>15?'disabled':''}>${r.localSource?.duration>15?'超出2.0时长':onUse?'引用到创作台':'在创作台引用'}</button>`:''}</div></article>`).join(''):'<p class="ark-note">还没有素材库记录。可查询已有素材组，或先预览后创建。</p>';
 }
 function renderPreview(){const p=plan,s=p.localSource;$('#ark-preview').innerHTML=`<div class="ark-preview"><h4>${p.kind==='ark-group'?'创建素材组':'添加素材'} · ${esc(p.name)}</h4><p>目的地：${esc(p.endpoint)}<br>火山项目：${esc(p.cloudProject)}<br>单次操作，不自动重发。</p>${p.kind==='ark-material'?`<p>平台将读取：<code>${esc(p.sourceUrl)}</code></p>${p.publicMediaId?'<p>已关联本项目的原文件上传记录；远端返回链接的内容和可访问性仍需平台检查。</p>':''}<p>${s?`本机原文件已检查：${esc(s.name)} · ${(s.size/1024/1024).toFixed(2)} MB${s.duration?' · '+s.duration.toFixed(2)+'秒':''}${s.width?' · '+s.width+'×'+s.height:''}${s.fps?' · '+s.fps.toFixed(2)+'帧/秒':''}。<br>公网文件内容尚未读取，也未核实与本机文件一致。`:'外部文件格式、时长和可访问性尚未核实，由平台检查。'}</p>`:''}<label class="ark-check"><input id="ark-create-consent" type="checkbox"><span>同意这一次签名请求${p.kind==='ark-material'?'，将上述公网地址交给火山读取原文件，包括原有声音':''}。</span></label><label class="ark-check"><input id="ark-console-consent" type="checkbox"><span>我已在火山控制台完成素材库授权函，并确认此素材可用于该用途。</span></label><button data-ark="create">确认${p.kind==='ark-group'?'创建素材组':'入库'}</button></div>`;}
 d.addEventListener('change',e=>{if(['ark-local-asset','ark-type'].includes(e.target.id)){$('#ark-preview').innerHTML='';plan=null;}});
 d.addEventListener('input',e=>{if(['ark-source-url','ark-local-asset'].includes(e.target.id)){publicMediaId=null;$('#ark-hosting-source').textContent='';}});
 d.addEventListener('close',()=>{clearKeys();d.remove();});
 d.addEventListener('click',async e=>{
  const button=e.target.closest('button');if(!button||busy)return;const action=button.dataset.ark;
  if(action==='close'){d.close();return;}
  busy=true;d.setAttribute('aria-busy','true');button.disabled=true;
  try{
   if(action==='hosting'){
    clearKeys();await openPublicMedia({projectId,assets:assets.filter(a=>/^(image\/(png|jpeg|webp)|video\/(mp4|quicktime)|audio\/(wav|x-wav|mpeg))$/.test(a.type)),selectedAssetId:$('#ark-local-asset').value,purpose:'ark-material',onUse:async r=>{
     if(!d.isConnected)throw Error('入库窗口已关闭，请重新打开');
     if(r.purpose!=='ark-material')throw Error('请使用为火山素材入库确认的上传记录');
     if(!/^(image\/(png|jpeg|webp)|video\/(mp4|quicktime)|audio\/(wav|x-wav|mpeg))$/.test(r.source.type))throw Error('此上传格式尚未接入火山素材库');
     const select=$('#ark-local-asset');if(![...select.options].some(o=>o.value===r.source.assetId)){const o=document.createElement('option');o.value=r.source.assetId;o.textContent=r.source.name;select.append(o);}
     select.value=r.source.assetId;$('#ark-source-url').value=r.url;$('#ark-type').value=({image:'Image',video:'Video',audio:'Audio'})[r.source.type.split('/')[0]];$('#ark-create-kind').value='ark-material';if(!$('#ark-name').value.trim())$('#ark-name').value=r.source.name.slice(0,64);publicMediaId=r.id;plan=null;$('#ark-preview').innerHTML='';$('#ark-hosting-source').textContent='已关联原文件上传记录；预计到期：'+new Date(r.expiresAt).toLocaleString('zh-CN');message('公网链接已填入，请预览后另行确认火山入库。');
    }});
   }
   if(action==='preview'){previewForm=form();plan=await api('/api/ark-assets/preview',previewForm);requestId=crypto.randomUUID();renderPreview();message('本机预览完成，尚未向平台发送请求。');}
   if(action==='create'){
    if(!plan||!$('#ark-create-consent')?.checked||!$('#ark-console-consent')?.checked)throw Error('请预览并勾选本次发送范围和平台授权确认');
    const current=form();if(JSON.stringify(current)!==JSON.stringify(previewForm))throw Error('信息已变化，请重新预览');
    const r=await api('/api/ark-assets/create',{...current,...keys(),fingerprint:plan.fingerprint,requestId,consent:{...consent(plan.kind==='ark-group'?'CreateAssetGroup':'CreateAsset',plan),fingerprint:plan.fingerprint,consoleAuthorizationAccepted:true,sendPublicUrl:plan.kind==='ark-material',sendOriginalMedia:plan.sendOriginalMedia}});
    plan=null;$('#ark-preview').innerHTML='';await load();message(status(r)+(r.status==='uncertain'?'；请查询平台记录，不会自动再提交。':''));
   }
   if(action==='browse'){
    if(!$('#ark-query-consent').checked)throw Error('请确认查询地址和项目');const s=scope(),query=$('#ark-query-kind').value;
    const result=await api('/api/ark-assets/browse',{projectId,...s,...keys(),action:query,pageNumber:Number($('#ark-page').value),search:$('#ark-search').value.trim(),groupId:$('#ark-group-id').value.trim(),consent:consent(query,s)});remote=result.items;
    $('#ark-remote').innerHTML=`<p>第 ${result.pageNumber} 页${result.totalCount===null?'':' · 共 '+result.totalCount+' 项'}。返回地址不会被加载或保存。</p>`+remote.map(r=>`<article class="ark-record"><strong>${esc(r.name)}</strong><small>${esc(status(r))}</small><code>${esc(r.id)}</code><button data-ark-remember="${esc(r.selectionId)}">保存到本项目</button></article>`).join('');message('这页查询完成，没有入库或生成请求。');
   }
   if(button.dataset.arkRemember){await api('/api/ark-assets/remember',{projectId,selectionId:button.dataset.arkRemember});await load();message('记录已保存到本机。');}
   if(button.dataset.arkGroup){const r=items.find(x=>x.id===button.dataset.arkGroup);$('#ark-group-id').value=r.cloudId;$('#ark-endpoint').value=r.endpoint;$('#ark-cloud-project').value=r.cloudProject;message('已选择素材组；如修改了待发送信息，请重新预览。');}
   if(button.dataset.arkRefresh){const r=items.find(x=>x.id===button.dataset.arkRefresh);if(!$('#ark-query-consent').checked)throw Error('请勾选平台查询确认');if(scope().endpoint!==r.endpoint||scope().cloudProject!==r.cloudProject)throw Error('当前地址和火山项目与记录不一致，请核对');const result=await api('/api/ark-assets/'+encodeURIComponent(r.id)+'/refresh',{projectId,...keys(),consent:consent('GetAsset',r)});await load();message(status(result)+'；未重复入库。');}
   if(button.dataset.arkUse){const r=items.find(x=>x.id===button.dataset.arkUse);if(r.status!=='Active'||r.restored)throw Error('请先查询原编号确认可用');await onUse?.({url:'asset://'+r.cloudId,type:r.type},r);message('已加入创作参考；生成前仍需确认预算与原文件范围。');}
  }catch(err){message(err.message||'操作失败，未自动重试');}
  finally{if(['create','browse'].includes(action)||button.dataset.arkRefresh)clearKeys();busy=false;d.removeAttribute('aria-busy');if(button.isConnected)button.disabled=false;}
 });
 try{await load();}catch(e){message(e.message);}
 return d;
}
