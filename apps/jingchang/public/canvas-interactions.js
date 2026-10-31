// Pointer and context-menu controls share the application's mutations and undo stack.
export function installCanvasInteractions(ctx) {
  let wire=null, menu=null, restoreFocus=null, suppressClick=false;
  const editable=e=>e.closest('input,textarea,select,[contenteditable],video,audio');
  const enabled=()=>ctx.enabled()&&!document.querySelector('dialog[open]');
  function closeMenu(restore=false){menu?.remove();menu=null;if(restore&&restoreFocus?.isConnected)restoreFocus.focus();}
  function clearWire(){wire?.overlay?.remove();document.querySelectorAll('.port.drop-valid,.port.drop-invalid').forEach(p=>p.classList.remove('drop-valid','drop-invalid'));wire=null;}
  function endpoint(port){const r=port.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};}
  function pair(target){if(!target||target.dataset.port===wire.port)return null;return wire.port==='out'?{source:wire.id,target:target.dataset.id}:{source:target.dataset.id,target:wire.id};}
  document.addEventListener('pointerdown',e=>{
    if(menu&&!menu.contains(e.target))closeMenu();
    const p=e.target.closest('.port');if(!enabled()||e.button!==0||!p)return;
    closeMenu();clearWire();wire={id:p.dataset.id,port:p.dataset.port,pointerId:e.pointerId,start:endpoint(p),sx:e.clientX,sy:e.clientY,active:false};
    e.preventDefault();e.stopImmediatePropagation();
  },true);
  document.addEventListener('pointermove',e=>{
    if(!wire||e.pointerId!==wire.pointerId)return;
    if(!wire.active&&Math.hypot(e.clientX-wire.sx,e.clientY-wire.sy)<5)return;
    if(!wire.active){wire.active=true;wire.overlay=document.createElementNS('http://www.w3.org/2000/svg','svg');wire.overlay.classList.add('wire-preview');wire.overlay.innerHTML='<path/>';document.body.append(wire.overlay);}
    document.querySelectorAll('.port.drop-valid,.port.drop-invalid').forEach(p=>p.classList.remove('drop-valid','drop-invalid'));
    const target=document.elementFromPoint(e.clientX,e.clientY)?.closest('.port'),connection=pair(target);
    if(target)target.classList.add(connection&&!ctx.connectionError(connection.source,connection.target)?'drop-valid':'drop-invalid');
    let a=wire.start,b={x:e.clientX,y:e.clientY};if(wire.port==='in')[a,b]=[b,a];const bend=Math.max(60,Math.abs(b.x-a.x)/2);
    wire.overlay.firstChild.setAttribute('d',`M ${a.x} ${a.y} C ${a.x+bend} ${a.y} ${b.x-bend} ${b.y} ${b.x} ${b.y}`);
    e.preventDefault();e.stopImmediatePropagation();
  },true);
  document.addEventListener('pointerup',e=>{
    if(!wire||e.pointerId!==wire.pointerId)return;const active=wire.active;
    const connection=pair(document.elementFromPoint(e.clientX,e.clientY)?.closest('.port'));
    clearWire();if(!active)return;
    suppressClick=true;setTimeout(()=>{suppressClick=false;},0);
    e.preventDefault();e.stopImmediatePropagation();
    if(connection)Promise.resolve().then(()=>ctx.connect(connection.source,connection.target)).catch(err=>ctx.notify(err.message));
  },true);
  document.addEventListener('click',e=>{if(suppressClick){suppressClick=false;e.preventDefault();e.stopImmediatePropagation();}},true);
  document.addEventListener('pointercancel',clearWire);
  window.addEventListener('blur',()=>{clearWire();closeMenu();});
  window.addEventListener('resize',()=>{clearWire();closeMenu();});
  document.addEventListener('wheel',()=>{clearWire();closeMenu();},{capture:true,passive:true});
  document.addEventListener('contextmenu',e=>{
    const canvas=e.target.closest('#canvas');if(!enabled()||!canvas||editable(e.target))return;
    e.preventDefault();clearWire();closeMenu();restoreFocus=document.activeElement;
    const node=e.target.closest('[data-node]'),edge=e.target.closest('[data-edge]'),rect=canvas.getBoundingClientRect(),v=ctx.viewport();
    const point={x:(e.clientX-rect.left-v.x)/v.zoom,y:(e.clientY-rect.top-v.y)/v.zoom};
    if(node)ctx.selectContext(node.dataset.node);
    const items=edge?[['移除连接',()=>ctx.removeEdge(edge.dataset.edge)]]:node?[
      ['编辑节点',()=>ctx.edit(node.dataset.node)],['复制选中节点',ctx.duplicate],['编组',()=>ctx.action('group-selection')],['解组',()=>ctx.action('ungroup-selection')],['左对齐',()=>ctx.action('align-left')],['右对齐',()=>ctx.action('align-right')],['顶对齐',()=>ctx.action('align-top')],['底对齐',()=>ctx.action('align-bottom')],['水平居中',()=>ctx.action('align-hcenter')],['垂直居中',()=>ctx.action('align-vcenter')],['移出画布',ctx.remove]
    ]:[...Object.entries(ctx.labels).map(([type,label])=>['新建'+label,()=>ctx.add(type,point)]),['全选节点',ctx.selectAll],['适应画布',ctx.fit]];
    menu=document.createElement('div');menu.className='canvas-context-menu';menu.setAttribute('role','menu');menu.setAttribute('aria-label','画布操作');
    for(const [label,run] of items){const button=document.createElement('button');button.type='button';button.role='menuitem';button.textContent=label;button.addEventListener('click',async e=>{e.stopPropagation();closeMenu();try{await run();}catch(err){ctx.notify(err.message);}});menu.append(button);}
    document.body.append(menu);const bounds=menu.getBoundingClientRect();menu.style.left=Math.max(8,Math.min(e.clientX,innerWidth-bounds.width-8))+'px';menu.style.top=Math.max(8,Math.min(e.clientY,innerHeight-bounds.height-8))+'px';menu.firstChild.focus();
  });
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'&&(wire||menu)){e.preventDefault();e.stopImmediatePropagation();clearWire();closeMenu(true);return;}
    if(!menu)return;
    const items=[...menu.querySelectorAll('button')],index=items.indexOf(document.activeElement);
    if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();e.stopImmediatePropagation();items[e.key==='Home'?0:e.key==='End'?items.length-1:(index+(e.key==='ArrowDown'?1:-1)+items.length)%items.length].focus();}
    else if(e.key==='Tab')closeMenu();
  },true);
  return {closeMenu,clearWire};
}
