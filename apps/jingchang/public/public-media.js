import {nativeMediaFetch as fetch} from './native-media-session.js';
import {importMediaFile} from './media-import.js';
import {transferSize} from './media-transfer-core.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={uploading:'正在上传',ready:'服务已返回链接',expired:'预计已过期',uncertain:'上传结果待确认',rejected:'服务拒绝上传'};
const purposeLabels={'ark-material':'火山素材入库','apimart-material':'APIMart素材入库','generation-reference':'其他模型参考'};
async function api(url,body){const res=await fetch(url,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}),r=await res.json();if(!res.ok)throw Error(r.error||'公网素材操作失败');return r;}
export async function openPublicMedia({projectId,assets=[],selectedAssetId='',purpose='generation-reference',onUse,onImport}){
 if(document.querySelector('#public-media-dialog'))return;
 const profiles=await api('/api/public-media/profiles');
 if(!document.querySelector('#public-media-css')){const link=document.createElement('link');link.id='public-media-css';link.rel='stylesheet';link.href='/public-media.css';document.head.append(link);}
 const media=assets.filter(a=>/^(image\/|video\/|audio\/)/.test(a.type)),d=document.createElement('dialog');d.id='public-media-dialog';d.className='public-media-dialog';
 d.innerHTML=`<header><div><strong>公网素材链接</strong><small>选择原文件，确认后上传一次</small></div><button data-host="close" aria-label="关闭公网素材链接">×</button></header><div class="public-media-body"><p class="public-media-note">文件会离开本机。所选服务将保存完整文件；持有链接的人可以访问。不会公开你的本机工作台。</p><div class="public-media-grid"><label>上传用途<select id="public-purpose">${Object.entries(purposeLabels).map(([id,name])=>`<option value="${id}" ${id===purpose?'selected':''}>${name}</option>`).join('')}</select></label><label>目标服务<select id="public-service">${profiles.map(p=>`<option value="${p.id}" ${p.id==='temp'?'selected':''}>${esc(p.name)} · ${transferSize(p.maxBytes)} · 预计72小时</option>`).join('')}</select></label></div><label>本机原文件<select id="public-asset"><option value="">请选择图片、视频或音频</option>${media.map(a=>`<option value="${esc(a.id)}" ${a.id===selectedAssetId?'selected':''}>${esc(a.name)} · ${transferSize(a.size)}</option>`).join('')}</select></label><p id="public-capacity" class="public-media-note"></p><label>从电脑选择原文件<input id="public-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif,video/*,audio/*,.mov,.flv,.m4a,.flac,.opus"></label><button data-host="import">仅保存到本机</button><p class="public-media-note">此步只保存本机副本；稍后预览并确认后，才会发送到托管服务。大文件按小块传输，不裁剪或转码。</p><details><summary>上传接口与本机模拟</summary><label>所选服务的上传接口<input id="public-endpoint" type="url" value="${esc(profiles.find(p=>p.id==='temp').endpoint)}"></label><p class="public-media-note">正式上传仅允许所选服务的官方地址。模拟测试只接受相同路径的本机地址。</p></details><button data-host="preview">预览这次上传</button><div id="public-preview"></div><section><div class="public-media-heading"><h3>本项目上传记录</h3><button data-host="reload">读取本机记录</button></div><p class="public-media-note">刷新只读取本机记录。保留时限为预计值，不保证平台可访问性；恢复备份不会重新上传或延长时限。</p><div id="public-records"></div></section><p id="public-status" role="status" aria-live="polite"></p></div>`;
 document.body.append(d);d.showModal();const $=s=>d.querySelector(s);let rows=[],plan=null,previewForm=null,requestId=null,busy=false,timer,trackedUploadId=null;
 const message=s=>{if($('#public-status'))$('#public-status').textContent=s;};
 const form=()=>({projectId,purpose:$('#public-purpose').value,service:$('#public-service').value,endpoint:$('#public-endpoint').value.trim(),assetId:$('#public-asset').value});
 function render(){
  $('#public-records').innerHTML=rows.length?rows.map(r=>`<article class="public-media-record"><strong>${esc(r.source.name)}</strong><small>${r.restored?'备份恢复 · ':''}${esc(labels[r.status])} · ${esc(profiles.find(p=>p.id===r.service)?.name)} · ${esc(purposeLabels[r.purpose])}</small><small>${r.status==='uploading'?transferSize(r.bytesSent)+' / '+transferSize(r.source.size)+' · ':''}预计到期：${esc(new Date(r.expiresAt).toLocaleString('zh-CN'))}</small>${r.url?`<code>${esc(r.url)}</code>`:''}<div class="public-media-buttons">${r.url?`<button data-host-copy="${esc(r.id)}">复制链接</button>`:''}${onUse?`<button data-host-use="${esc(r.id)}" ${r.status==='ready'?'':'disabled'}>填入入库表单</button>`:''}</div>${r.status==='uncertain'?'<p>本次上传可能已被服务接受。未获得可确认的链接，不会自动重发或改用另一服务。</p>':''}</article>`).join(''):'<p class="public-media-note">尚无上传记录。预览和打开此窗口不会联系目标服务。</p>';
 }
 async function load(){rows=await api('/api/public-media?projectId='+encodeURIComponent(projectId));if(d.isConnected){render();const current=rows.find(r=>r.id===trackedUploadId);if(current)message(labels[current.status]+'；上传记录保存在本机。');}clearTimeout(timer);if(d.isConnected&&rows.some(r=>r.status==='uploading'))timer=setTimeout(()=>load().catch(e=>message(e.message)),1500);}
 function showPlan(){const p=plan;$('#public-preview').innerHTML=`<div class="public-media-preview"><h4>${esc(p.source.name)}</h4><p>${esc(p.source.type)} · ${transferSize(p.source.size)}<br>用途：${esc(purposeLabels[p.purpose])}<br>目的地：${esc(p.endpoint)}<br>预计保留72小时，仅发送一次。</p><p>完整原文件${/^(video|audio)\//.test(p.source.type)?'及原有声音':''}，不裁剪或转码。原文件名和本机路径不会发送给托管服务。</p><details><summary>原文件内容校验</summary><code>${esc(p.source.sourceSha256)}</code></details><label class="public-media-check"><input id="public-consent" type="checkbox"><span>同意将这份完整原文件上传到上述服务，预计保留72小时，用于${esc(purposeLabels[p.purpose])}；持有链接的人可以访问。</span></label><button data-host="start">确认上传一次</button></div>`;}
 function invalidate(){plan=null;previewForm=null;$('#public-preview').innerHTML='';}
 function capacity(){const profile=profiles.find(p=>p.id===$('#public-service').value);$('#public-capacity').textContent='本机接入上限：'+transferSize(profile.maxBytes)+'。生成模型另有各自输入限制。';for(const option of $('#public-asset').options){const a=media.find(a=>a.id===option.value);option.disabled=!!a&&a.size>profile.maxBytes;if(option.disabled&&option.selected)$('#public-asset').value='';}}
 capacity();
 d.addEventListener('change',e=>{if(['public-purpose','public-service','public-asset','public-endpoint'].includes(e.target.id)){if(e.target.id==='public-service')$('#public-endpoint').value=profiles.find(p=>p.id===e.target.value).endpoint;capacity();invalidate();}});
 d.addEventListener('change',e=>{if(e.target.id==='public-file'){invalidate();message('原文件已选择；点击“仅保存到本机”完成本机导入。');}});
 d.addEventListener('close',()=>{clearTimeout(timer);d.remove();});
 d.addEventListener('click',async e=>{
  const b=e.target.closest('button');if(!b)return;
  if(b.dataset.host==='close'){d.close();return;}if(busy)return;
  busy=true;b.disabled=true;d.setAttribute('aria-busy','true');
  try{
   if(b.dataset.host==='import'){
    const file=$('#public-file').files[0],profile=profiles.find(p=>p.id===$('#public-service').value);if(!file)throw Error('请先从电脑选择原文件');if(file.size>profile.maxBytes)throw Error('文件超过'+profile.name+'的本机接入上限：'+transferSize(profile.maxBytes)+'；可先选择支持此大小的服务');
    const a=await importMediaFile(file,{projectId,onProgress:message});media.push(a);if(!onImport&&!assets.some(x=>x.id===a.id))assets.push(a);
    if(d.isConnected){$('#public-asset').insertAdjacentHTML('beforeend',`<option value="${esc(a.id)}">${esc(a.name)} · ${transferSize(a.size)}</option>`);$('#public-asset').value=a.id;$('#public-file').value='';invalidate();capacity();}
    try{await onImport?.(a);}catch{throw Error('文件已保存在本机素材库；项目关联未保存，请在全局素材库选择此文件');}
    message('完整原文件已保存在本机；尚未发送到托管服务。');
   }
   if(b.dataset.host==='preview'){if(!$('#public-asset').value)throw Error('请选择已完整导入且符合目标服务大小限制的本机原文件');previewForm=form();plan=await api('/api/public-media/preview',previewForm);requestId=crypto.randomUUID();if(d.isConnected)showPlan();message('预览完成，尚未上传。');}
   if(b.dataset.host==='start'){
    if(!plan||!$('#public-consent')?.checked)throw Error('请预览并勾选这次原文件、目的地和公开范围确认');
    const current=form();if(JSON.stringify(current)!==JSON.stringify(previewForm))throw Error('上传信息已变化，请重新预览');
    const r=await api('/api/public-media/start',{...current,fingerprint:plan.fingerprint,requestId,consent:{fingerprint:plan.fingerprint,endpoint:plan.endpoint,service:plan.service,purpose:plan.purpose,retentionHours:72,requestLimit:1,publicScope:'anyone-with-url',sendOriginalMedia:true}});
    trackedUploadId=r.id;if(d.isConnected)invalidate();await load();
   }
   if(b.dataset.host==='reload'){await load();message('本机记录已读取，未重新上传。');}
   if(b.dataset.hostCopy){const r=rows.find(x=>x.id===b.dataset.hostCopy);await navigator.clipboard.writeText(r.url);message('链接已复制；有效性仍由使用它的平台检查。');}
   if(b.dataset.hostUse){const r=await api('/api/public-media/'+encodeURIComponent(b.dataset.hostUse)+'/reference',{projectId});await onUse?.(r);message('已填入入库表单；尚未向火山发送请求。');d.close();}
  }catch(e){message(e.message||'上传未完成，不会自动重试');if(d.isConnected&&b.dataset.host==='start')await load().catch(()=>{});}
  finally{busy=false;d.removeAttribute('aria-busy');if(b.isConnected)b.disabled=false;}
 });
 try{await load();}catch(e){message(e.message);}
 return d;
}
