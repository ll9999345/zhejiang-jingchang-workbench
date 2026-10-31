const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const mediaUrl=id=>'/media/'+encodeURIComponent(id);

function referencesFor(project,outputId){
  const ids=(project?.runs||[]).flatMap(run=>(run.assetReferences||[])
    .filter(item=>item.assetId===outputId).flatMap(item=>item.referenceAssetIds||[]));
  const assets=new Map((project?.assets||[]).map(asset=>[asset.id,asset]));
  return [...new Set(ids)].map(id=>assets.get(id)).filter(asset=>asset?.type?.startsWith('image/'));
}

export function syncMediaViewerCompare(project,outputId,info){
  if(!info)return;
  let button=info.querySelector('[data-viewer-compare]');
  if(!button){
    button=document.createElement('button');button.type='button';button.className='media-viewer-node-link';
    button.dataset.viewerCompare='';button.textContent='生成前后对比';
    info.querySelector('[data-viewer-meta]')?.after(button);
  }
  button.dataset.viewerCompare=outputId;
  button.hidden=referencesFor(project,outputId).length===0;
}

function openCompare(project,outputId){
  const output=project?.assets?.find(asset=>asset.id===outputId&&asset.type?.startsWith('image/'));
  const references=referencesFor(project,outputId);
  if(!output||!references.length)return;
  const dialog=document.querySelector('#modal');if(!dialog)return;
  const options=references.map((asset,index)=>`<option value="${escapeHtml(asset.id)}" ${index===0?'selected':''}>${escapeHtml(asset.name)}</option>`).join('');
  dialog.innerHTML=`<div class="dialog-head"><h2>生成前后对比</h2><button data-action="close-modal" aria-label="关闭">×</button></div><div class="dialog-body" id="media-viewer-compare" data-output="${escapeHtml(output.id)}"><div class="row"><label>参考图<select data-compare-reference>${options}</select></label><span class="muted small">本机保存的参考图与生成结果</span></div><p class="muted small">拖动滑块查看参考图和生成结果的差异；素材不会上传。</p><div class="enhance-compare-scroll"><figure class="enhance-compare-stage" id="media-compare-stage"><img class="enhance-before" data-compare-before src="${mediaUrl(references[0].id)}" alt="参考图：${escapeHtml(references[0].name)}"><img class="enhance-after" data-compare-after src="${mediaUrl(output.id)}" alt="生成结果：${escapeHtml(output.name)}"><span class="enhance-before-label" data-compare-before-label>参考图</span><span class="enhance-after-label">生成结果</span><span class="enhance-divider"></span></figure></div><label class="enhance-control" style="display:flex;align-items:center;gap:12px;margin-top:12px">分割位置<input data-compare-split type="range" min="0" max="100" value="50"><output data-compare-value>50%</output></label></div><div class="dialog-footer"><button data-action="close-modal">关闭</button></div>`;
  if(!dialog.open)dialog.showModal();
  const stage=dialog.querySelector('#media-compare-stage'),before=dialog.querySelector('[data-compare-before]'),after=dialog.querySelector('[data-compare-after]'),selector=dialog.querySelector('[data-compare-reference]'),range=dialog.querySelector('[data-compare-split]'),value=dialog.querySelector('[data-compare-value]'),beforeLabel=dialog.querySelector('[data-compare-before-label]');
  const updateAspect=()=>{const image=before.naturalWidth&&before.naturalHeight?before:after;if(!image.naturalWidth||!image.naturalHeight)return;const aspect=image.naturalWidth/image.naturalHeight,body=dialog.querySelector('.dialog-body'),maxHeight=Math.max(160,window.innerHeight*.44),width=Math.min(1000,body?.clientWidth||1000,maxHeight*aspect);stage.style.aspectRatio=`${image.naturalWidth} / ${image.naturalHeight}`;stage.style.width=`${Math.floor(width)}px`;stage.style.height=`${Math.floor(width/aspect)}px`;};
  const onResize=()=>updateAspect();before.addEventListener('load',updateAspect,{once:true});after.addEventListener('load',updateAspect,{once:true});window.addEventListener('resize',onResize);dialog.addEventListener('close',()=>window.removeEventListener('resize',onResize),{once:true});updateAspect();
  range.addEventListener('input',()=>{stage.style.setProperty('--split',`${range.value}%`);value.value=value.textContent=`${range.value}%`;});
  selector.addEventListener('change',()=>{const asset=references.find(item=>item.id===selector.value);if(!asset)return;before.src=mediaUrl(asset.id);before.alt=`参考图：${asset.name}`;beforeLabel.textContent=asset.name;before.addEventListener('load',updateAspect,{once:true});updateAspect();});
}

export function installMediaViewerCompare(getProject){
  if(typeof document==='undefined'||!document.body)return;
  document.addEventListener('click',event=>{
    const button=event.target.closest?.('[data-viewer-compare]');if(!button||button.hidden)return;
    event.preventDefault();event.stopImmediatePropagation();openCompare(getProject(),button.dataset.viewerCompare);
  },true);
}
