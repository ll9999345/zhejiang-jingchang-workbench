/* Small, interruptible presentation layer. Business owners retain all locks,
 * authorizations and requests. No network, fake progress or timed success. */
(function (root) {
  'use strict';
  const groups = {mediaNarrationCard:'copy', mediaVideoComposeCard:'video', mediaVoiceCard:'audio', mediaMusicCard:'audio', mediaAudioMixCard:'audio', mediaAudioEnhanceCard:'audio', mediaSubtitleCard:'subtitle'};
  const active = new Set(['preparing','submitting','queued','running','cancelling','unknown']);
  function taskState(status) {
    status = String(status || '').toLowerCase();
    if (['succeeded','success','completed','done','passed'].includes(status)) return 'succeeded';
    if (['failed','error','interrupted','invalid_request'].includes(status)) return 'failed';
    if (['cancelled','canceled'].includes(status)) return 'cancelled';
    if (['cancel_requested','cancelling'].includes(status)) return 'cancelling';
    if (['queued','submitted','pending','restored'].includes(status)) return 'queued';
    if (['running','processing','in_progress'].includes(status)) return 'running';
    if (['available','dry_run','ready'].includes(status)) return 'ready';
    return 'unknown';
  }
  // Exact damped oscillator continuation, carrying BOTH position and velocity
  // when the target changes. No queued transitions and no frame-rate integration.
  function springAt(state, now) {
    const dt = Math.max(0, (now-state.time)/1000), w = state.omega || 30, z = .82;
    const wd=w*Math.sqrt(1-z*z), dx=state.x-state.target, c=(state.v+z*w*dx)/wd;
    const e=Math.exp(-z*w*dt), co=Math.cos(wd*dt), si=Math.sin(wd*dt);
    return {x:state.target+e*(dx*co+c*si),v:e*((-z*w)*(dx*co+c*si)+wd*(-dx*si+c*co))};
  }
  function retarget(state, target, now, omega=30) { const current=springAt(state,now); return {...current,target,time:now,omega}; }
  const api = {groupFor:id=>groups[id]||id, taskState, isActive:state=>active.has(state), springAt,retarget};
  if (typeof module !== 'undefined' && module.exports) module.exports=api;
  root.WorkbenchInteractions=api;
  if (!root.document) return;
  const reduced=root.matchMedia('(prefers-reduced-motion: reduce)');
  const motions=new WeakMap();
  api.setState=(button,state,{label}={})=>{
    if (!button) return;
    const changed=button.dataset.taskState!==state;
    button.classList.add('task-motion'); button.dataset.taskState=state;
    button.setAttribute('aria-busy',String(active.has(state)));
    if(label!=null) button.textContent=label;
    if(changed && root.StudioButtonFeedback) root.StudioButtonFeedback.stateChanged(button);
    if(changed && !root.StudioButtonFeedback && !reduced.matches && root.Motion) {
      motions.get(button)?.stop?.();
      motions.set(button,root.Motion.animate(button,{scale:1},{type:'spring',stiffness:540,damping:32,mass:.65}));
    }
  };
  function init(){
    for(const id of ['mediaRenderAudio','mediaRenderSubtitles','mediaCompose']) api.setState(document.getElementById(id),'ready');
    const nav=document.querySelector('.settings-tabs');if(!nav)return;
    const tabs=[...nav.querySelectorAll('[role="tab"]')];
    const indicator=document.createElement('i');indicator.className='settings-indicator';indicator.setAttribute('aria-hidden','true');nav.prepend(indicator);
    let left={x:0,v:0,target:0,time:0},right={x:0,v:0,target:0,time:0},last='',frame=0,ready=false;
    const contentMotions=new Map();
    function draw(now){
      const l=springAt(left,now),r=springAt(right,now);
      indicator.style.transform=`translateX(${l.x}px)`;indicator.style.width=`${Math.max(0,r.x-l.x)}px`;
      if(Math.abs(l.x-left.target)+Math.abs(r.x-right.target)+Math.abs(l.v)+Math.abs(r.v)>.04)frame=requestAnimationFrame(draw);else{frame=0;indicator.style.transform=`translateX(${left.target}px)`;indicator.style.width=`${right.target-left.target}px`;}
    }
    function sync(force=false){
      const tab=tabs.find(t=>t.classList.contains('selected'))||tabs[0];
      tabs.forEach(t=>{t.setAttribute('aria-selected',String(t===tab));t.tabIndex=t===tab?0:-1});
      if(!nav.getClientRects().length)return;
      const x=tab.offsetLeft,w=tab.offsetWidth,now=performance.now(),changed=last&&last!==tab.id;
      if(!ready||reduced.matches||force){left={x,v:0,target:x,time:now};right={x:x+w,v:0,target:x+w,time:now};ready=true;cancelAnimationFrame(frame);frame=0;draw(now);}
      else if(left.target!==x||right.target!==x+w){
        const forward=x>left.target;
        left=retarget(left,x,now,forward?27:35);right=retarget(right,x+w,now,forward?35:27);
        if(!frame)frame=requestAnimationFrame(draw);
      }
      if(changed){
        for(const [card,motion] of contentMotions){motion.stop?.();card.style.opacity='1';card.style.transform='none';}contentMotions.clear();
        if(!reduced.matches&&root.Motion) for(const id of tab.getAttribute('aria-controls').split(' ')){
          const card=document.getElementById(id);if(card&&!card.hidden)contentMotions.set(card,root.Motion.animate(card,{opacity:[.7,1],y:[3,0]},{duration:.16,ease:'easeOut'}));
        }
      }
      last=tab.id;
    }
    nav.addEventListener('keydown',event=>{
      const index=tabs.indexOf(event.target);if(index<0)return;
      let next;if(event.key==='ArrowRight')next=(index+1)%tabs.length;else if(event.key==='ArrowLeft')next=(index+tabs.length-1)%tabs.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=tabs.length-1;else if(event.key===' '){event.preventDefault();event.target.click();return;}else return;
      event.preventDefault();tabs[next].focus({preventScroll:true});tabs[next].click();
    });
    api.reveal=element=>{
      const panel=element?.closest('[data-settings-column]');const tab=tabs.find(t=>t.dataset.settingsTab===panel?.dataset.settingsColumn);
      if(!tab)return false;tab.click();return true;
    };
    // Only changes in actual selection trigger motion. Writing aria-selected is
    // intentionally outside this observer's filter to avoid feedback loops.
    new MutationObserver(()=>sync()).observe(nav,{subtree:true,attributes:true,attributeFilter:['class']});
    new ResizeObserver(()=>sync(true)).observe(nav);
    reduced.addEventListener('change',()=>{for(const [card,m] of contentMotions){m.stop?.();card.style.opacity='1';card.style.transform='none';}contentMotions.clear();document.querySelectorAll('.task-motion').forEach(b=>{motions.get(b)?.stop?.();b.style.transform='none'});sync(true)});
    document.addEventListener('studio:settings-sync',()=>sync());sync(true);
    // Pressure feedback applies only to real enabled buttons; pointerup/cancel
    // restore the same object, including a drag away from its hit area.
    document.addEventListener('pointerdown',event=>{
      const button=event.target.closest('.task-motion');if(root.StudioButtonFeedback||!button||button.disabled||reduced.matches||!root.Motion)return;
      motions.get(button)?.stop?.();motions.set(button,root.Motion.animate(button,{scale:.976},{duration:.09}));
      const release=()=>{root.removeEventListener('pointerup',release);root.removeEventListener('pointercancel',release);motions.get(button)?.stop?.();motions.set(button,root.Motion.animate(button,{scale:1},{type:'spring',stiffness:540,damping:32,mass:.65}));};
      root.addEventListener('pointerup',release,{once:true});root.addEventListener('pointercancel',release,{once:true});
    });
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})(typeof window==='undefined'?globalThis:window);
