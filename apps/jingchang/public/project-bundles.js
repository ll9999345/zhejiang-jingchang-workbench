import {nativeMediaFetch as fetch} from './native-media-session.js';
import {transferSize} from './media-transfer-core.js';
let pendingImport=null,busy=false;
const $=s=>document.querySelector(s);
function stats(x){return `${x.nodes} 个节点 · ${x.shots} 个镜头 · ${x.assets} 份素材（${transferSize(x.bytes)}）<br>${x.workflows} 个本机工作流 · ${x.cloudWorkflows} 个云工作流 · ${x.studios} 个创作台 · ${x.conversations} 个对话 · ${x.imageEdits||0} 份图片编辑记录 · ${x.panoramas||0} 张全景视角 · ${x.enhancements||0} 张增强结果 · ${x.loras||0} 份 LoRA 文件 · ${x.loraReceipts||0} 条上传记录 · ${x.arkMaterials||0} 条火山素材库记录 · ${x.publicMedia||0} 条公网上传记录 · ${x.assetLibraries||0} 个关联素材库 · ${x.assetFolders||0} 个分组`;}
export async function bundleActions(action,button,{save,getProject,api,modal,esc,toast}){
 if(!['export-bundle','import-bundle','inspect-bundle','restore-bundle'].includes(action))return false;
 if(busy)return true;
 if(action==='import-bundle'){
  await save();pendingImport=null;modal('导入完整备份',`<p class="muted" style="line-height:1.9">选择另一台电脑导出的镜场完整备份，先检查内容，再创建新项目。</p><label>备份文件<input id="bundle-file" type="file" accept=".jingchang"></label><p class="muted small">合计最多4GiB文件；单份常见媒体最多4GB，含大文件使用v18或更新备份；含Midjourney配置使用v19；BMP或MKV原件使用v20；素材库组织关系使用v21（镜场0.88及更新版本）。上传和检查均在本机进行，原项目与文件保留。</p>`,`<button class="primary" data-action="inspect-bundle">检查备份</button>`);return true;
 }
 busy=true;if(button)button.disabled=true;
 try{
  if(action==='export-bundle'){
   await save();const p=getProject();toast('正在打包并校验素材…');const result=await api('/api/projects/'+p.id+'/bundle',{method:'POST',body:JSON.stringify({revision:p.revision})});
   modal('完整备份已准备',`<h3>${esc(result.name)}</h3><p style="line-height:2;margin:16px 0">${stats(result)}</p><p class="muted small" style="line-height:1.9">包含当前项目内容、媒体、绑定工作流、创作台和对话，以及图片编辑的原图、输出与笔画记录。不包含历史修订、密钥、平台账号、生成任务或未导入的模型文件。已导入的 LoRA 文件及成功上传记录会保留，使用平台记录仍需原账号权限。导入时创建新项目。含图片编辑记录需镜场0.17或更新版本，含全景视角需0.18或更新版本，含增强原图关联需0.29或更新版本，含 LoRA 文件需0.31或更新版本，含视频抽样需0.32或更新版本，含对话系统指令或 Agent 结果需0.33或更新版本；含大文件或超过512MiB普通媒体需0.85或更新版本；含Midjourney配置需0.86或更新版本；含素材库组织关系需0.88或更新版本。只包含本工程关联的素材条目与工作流，保留所在库及空分组；其它工程素材和库中的整项目快照未打包。${result.externalReferences?'有 '+result.externalReferences+' 个公网参考链接仅保存地址，未下载，日后可能失效。':''}</p>`,`<a class="download-link" href="${esc(result.url)}" download="${esc(result.name)}.jingchang">下载完整备份</a>`);
  }else if(action==='inspect-bundle'){
   const file=$('#bundle-file')?.files[0];if(!file)throw Error('请选择 .jingchang 备份文件');if(file.size>(4*1024**3+13*1024**2))throw Error('备份文件过大');toast('正在检查备份与素材完整性…');const response=await fetch('/api/project-bundles/inspect',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});const result=await response.json();if(!response.ok)throw Error(result.error||'备份检查失败');pendingImport=result.id;
   modal('确认导入备份',`<h3>${esc(result.name)}</h3><p style="line-height:2;margin:16px 0">${stats(result)}</p><p class="muted small" style="line-height:1.9">素材校验已通过。将以新编号导入并重新关联素材和工作流，不会替换现有项目。导入不会启动模型或生成任务。${result.externalReferences?'公网参考链接仅保留地址，联网使用前仍须确认。':''}</p>`,`<button class="primary" data-action="restore-bundle">创建并打开新项目</button>`);
  }else if(action==='restore-bundle'){
   if(!pendingImport)throw Error('请先检查备份');const result=await api('/api/project-bundles/'+pendingImport+'/import',{method:'POST',body:'{}'});location.href='/?project='+encodeURIComponent(result.id);
  }
 }finally{busy=false;if(button?.isConnected)button.disabled=false;}
 return true;
}
