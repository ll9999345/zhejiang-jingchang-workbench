export function installMediaViewerZoom(){
  if(typeof document==='undefined'||!document.body)return;
  const activeByContainer=new WeakMap(),stateByImage=new WeakMap();
  const resetState=state=>state?.dispose();
  function attach(container,image){
    if(activeByContainer.has(container))resetState(activeByContainer.get(container));
    let zoom=1,panX=0,panY=0,drag=null;
    const controls=document.createElement('div');
    controls.className='media-viewer-zoom-tools';
    controls.innerHTML='<output data-viewer-zoom aria-live="off">100%</output><button type="button" data-viewer-zoom-reset title="恢复原始大小" aria-label="恢复图片原始大小" hidden>↺</button>';
    const label=controls.querySelector('[data-viewer-zoom]'),resetButton=controls.querySelector('[data-viewer-zoom-reset]');
    container.setAttribute('aria-label','图片预览区：滚轮缩放、拖拽平移、双击复位');
    image.dataset.viewerImage='';image.draggable=false;image.title='滚轮缩放 · 拖拽平移 · 双击复位';
    const apply=()=>{
      image.style.transform=`translate(${panX}px, ${panY}px) scale(${zoom})`;
      label.value=label.textContent=`${Math.round(zoom*100)}%`;
      resetButton.hidden=zoom<=1.001;
      container.classList.toggle('is-zoomed',zoom>1.001);
      container.dataset.viewerScale=String(zoom);
      container.dataset.viewerPanX=String(panX);
      container.dataset.viewerPanY=String(panY);
    };
    const reset=()=>{zoom=1;panX=0;panY=0;drag=null;container.classList.remove('is-panning');apply();};
    const onWheel=event=>{
      event.preventDefault();event.stopPropagation();
      const rect=container.getBoundingClientRect(),x=event.clientX-rect.left,y=event.clientY-rect.top,cx=rect.width/2,cy=rect.height/2;
      const beforeX=(x-cx-panX)/zoom,beforeY=(y-cy-panY)/zoom,next=Math.max(1,Math.min(6,zoom*(event.deltaY>0?.9:1.1)));
      zoom=next;
      if(zoom<=1.001){panX=0;panY=0;}else{panX=x-cx-beforeX*zoom;panY=y-cy-beforeY*zoom;}
      apply();
    };
    const onPointerDown=event=>{
      if((event.pointerType!=='touch'&&event.button!==0)||zoom<=1.001||event.target.closest('.media-viewer-zoom-tools'))return;
      drag={x:event.clientX,y:event.clientY,panX,panY,pointerId:event.pointerId};
      container.classList.add('is-panning');
      try{container.setPointerCapture(event.pointerId);}catch{}
      event.preventDefault();event.stopPropagation();
    };
    const onPointerMove=event=>{
      if(!drag||drag.pointerId!==event.pointerId)return;
      panX=drag.panX+event.clientX-drag.x;panY=drag.panY+event.clientY-drag.y;apply();event.stopPropagation();
    };
    const onPointerEnd=event=>{
      if(!drag||drag.pointerId!==event.pointerId)return;
      drag=null;container.classList.remove('is-panning');
      try{if(container.hasPointerCapture(event.pointerId))container.releasePointerCapture(event.pointerId);}catch{}
      event.stopPropagation();
    };
    const onDoubleClick=event=>{if(zoom<=1.001)return;event.preventDefault();event.stopPropagation();reset();};
    const onResetClick=event=>{event.preventDefault();event.stopPropagation();reset();};
    container.addEventListener('wheel',onWheel,{passive:false});
    container.addEventListener('pointerdown',onPointerDown);
    container.addEventListener('pointermove',onPointerMove);
    container.addEventListener('pointerup',onPointerEnd);
    container.addEventListener('pointercancel',onPointerEnd);
    container.addEventListener('lostpointercapture',onPointerEnd);
    container.addEventListener('dblclick',onDoubleClick);
    resetButton.addEventListener('click',onResetClick);
    container.append(controls);
    const state={image,dispose(){
      container.removeEventListener('wheel',onWheel);container.removeEventListener('pointerdown',onPointerDown);container.removeEventListener('pointermove',onPointerMove);container.removeEventListener('pointerup',onPointerEnd);container.removeEventListener('pointercancel',onPointerEnd);container.removeEventListener('lostpointercapture',onPointerEnd);container.removeEventListener('dblclick',onDoubleClick);resetButton.removeEventListener('click',onResetClick);
      controls.remove();container.classList.remove('is-zoomed','is-panning');delete container.dataset.viewerScale;delete container.dataset.viewerPanX;delete container.dataset.viewerPanY;container.removeAttribute('aria-label');image.style.removeProperty('transform');stateByImage.delete(image);activeByContainer.delete(container);
    }};
    stateByImage.set(image,state);activeByContainer.set(container,state);apply();
  }
  function refresh(overlay){
    const container=overlay.querySelector('[data-viewer-media]');if(!container)return;
    const image=container.querySelector('img'),active=activeByContainer.get(container);
    if(active&&active.image!==image)resetState(active);
    if(image&&!stateByImage.has(image))attach(container,image);
  }
  let viewerObserver=null;
  const bodyObserver=new MutationObserver(records=>{
    for(const record of records){
      for(const removed of record.removedNodes)if(removed.nodeType===Node.ELEMENT_NODE&&removed.id==='media-viewer'){viewerObserver?.disconnect();viewerObserver=null;const container=removed.querySelector('[data-viewer-media]');resetState(container&&activeByContainer.get(container));}
      for(const added of record.addedNodes)if(added.nodeType===Node.ELEMENT_NODE&&added.id==='media-viewer'){
        viewerObserver?.disconnect();refresh(added);viewerObserver=new MutationObserver(()=>refresh(added));viewerObserver.observe(added,{childList:true,subtree:true});
      }
    }
  });
  bodyObserver.observe(document.body,{childList:true});
}
