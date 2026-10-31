/* Bounded contact feedback. Events and task state remain owned by the app. */
(() => {
  'use strict';
  if(window.StudioButtonFeedback)return;
  const reduced=matchMedia('(prefers-reduced-motion: reduce)'),states=new Map();
  // Semantic controls resolve at event time, so later inserted controls work
  // without registration. Legacy click targets are grounded in the six pages.
  const semantic='button,a[href],select,input[type="button"],input[type="submit"],input[type="reset"],[role="button"],[role="tab"],[role="link"],[role="option"],summary,label.upload-zone,[data-press-feedback="on"]';
  // board.js el() turns its onclick options into addEventListener calls.
  // These exact targets are audited there; .narr.tc-note has no action.
  const legacy='body[data-studio-page="board"] :is(.drawer .close,.modal-close,.script-preview,.narr:not(.tc-note),.render-meta .v)';
  const propertyActions='.thumb.approved,.wave';
  const structural='.port,.world,#canvas,.node-header,.connections,.edge-hit,.clip,.track,.player,body,main,nav,aside,section,form,dialog,.studio-nav-shade,.modal-bg,[role="slider"],input[type="range"],video,audio,iframe,[data-press-feedback="off"]';
  // The canvas wrapper route does not load theme.css. Keep this component's
  // small presentation contract with its controller, scoped to this app only.
  const style=document.createElement('style');style.id='studio-button-feedback-style';style.textContent=`
    body[data-unified-canvas] [data-studio-press] { scale:var(--press-x,1) var(--press-y,1); filter:brightness(var(--press-light,1)); transform-origin:center; will-change:scale,filter; transition:background-color .16s,border-color .16s,color .16s,box-shadow .16s; }
    body[data-unified-canvas] [data-studio-press-inline] { scale:none; text-shadow:0 0 calc((var(--press-light,1) - 1)*50px) currentColor; }
    @media(prefers-reduced-motion:reduce) { body[data-unified-canvas] [data-studio-press] { scale:none!important; filter:none!important; text-shadow:none!important; will-change:auto; } }
  `;document.head.append(style);
  let frame=0;
  const busy=b=>b.matches(':disabled')||b.getAttribute('aria-disabled')==='true'||b.getAttribute('aria-busy')==='true'||!!b.closest('[inert],[hidden]');
  function buttonFor(target){
    for(let b=target instanceof Element?target:target?.parentElement;b&&b!==document.body;b=b.parentElement){
      if(b.matches(structural)){if(b.matches('video,audio')&&!b.controls)continue;return null;}
      if(b.matches(semantic)||b.matches(legacy)||(b.matches(propertyActions)&&typeof b.onclick==='function'))return b.closest('body[data-unified-canvas]')?b:null;
    }return null;
  }
  function keyboardTarget(e){
    // Combobox activation belongs to its selected option, not its text field.
    if(e.key==='Enter'&&e.target.getAttribute?.('aria-activedescendant'))return buttonFor(document.getElementById(e.target.getAttribute('aria-activedescendant')));
    const b=buttonFor(e.target);if(e.key===' '&&b?.matches('a[href],[role="link"]')&&!b.matches('[role="button"],[role="tab"]'))return null;return b;
  }
  function pose(s,now){const dt=Math.max(0,(now-s.time)/1000),w=s.omega,z=s.damping,wd=w*Math.sqrt(1-z*z),dx=s.x-s.target,c=(s.v+z*w*dx)/wd,e=Math.exp(-z*w*dt),co=Math.cos(wd*dt),si=Math.sin(wd*dt);return{x:s.target+e*(dx*co+c*si),v:e*(-z*w*(dx*co+c*si)+wd*(-dx*si+c*co))};}
  const axis=(now)=>({x:1,v:0,target:1,time:now,omega:30,damping:.7});
  function aim(s,target,now,omega,damping){return{...pose(s,now),target,time:now,omega,damping};}
  function reset(b){states.delete(b);b.removeAttribute('data-studio-press');b.removeAttribute('data-studio-press-inline');for(const k of ['--press-x','--press-y','--press-light'])b.style.removeProperty(k);if(!states.size){cancelAnimationFrame(frame);frame=0;}}
  function draw(now){frame=0;let moving=false;for(const[b,s]of states){if(!b.isConnected||busy(b)||reduced.matches||document.hidden){reset(b);continue;}const x=pose(s.x,now),y=pose(s.y,now);const settled=Math.abs(x.x-s.x.target)+Math.abs(y.x-s.y.target)+.02*(Math.abs(x.v)+Math.abs(y.v))<.0003;
      if(settled&&!s.held){reset(b);continue;}
      b.style.setProperty('--press-x',(settled?s.x.target:x.x).toFixed(5));b.style.setProperty('--press-y',(settled?s.y.target:y.x).toFixed(5));b.style.setProperty('--press-light',(1+Math.min(.065,Math.max(0,1-y.x)*1.15)).toFixed(4));if(!settled)moving=true;
    }if(moving)frame=requestAnimationFrame(draw);}
  function schedule(){if(!frame)frame=requestAnimationFrame(draw);}
  function press(b,input,id){if(!b||busy(b)||reduced.matches||document.hidden)return;const now=performance.now();let s=states.get(b);if(s?.held)return;
    const css=getComputedStyle(b);if(/auto|scroll/.test(css.overflowY)&&b.scrollHeight>b.clientHeight+2)return;
    const rect=b.getBoundingClientRect(),surface=rect.width>220&&rect.height>100,tab=b.matches('[role="tab"],.workspace-nav button'),icon=b.matches('.studio-icon-button,.studio-pin');
    if(css.display==='inline')b.setAttribute('data-studio-press-inline','');
    s||={x:axis(now),y:axis(now)};s.x=aim(s.x,surface?.991:tab?.982:icon?.95:.974,now,36,.84);s.y=aim(s.y,surface?.985:tab?.964:.946,now,36,.84);s.x.v=Math.min(s.x.v,surface?-.14:-.40);s.y.v=Math.min(s.y.v,surface?-.24:-.75);s.surface=surface;s.held={input,id};s.pressedAt=now;states.set(b,s);b.setAttribute('data-studio-press','');schedule();}
  function release(b,cancelled=false){const s=states.get(b);if(!s)return;if(!b.isConnected||busy(b)||reduced.matches||document.hidden)return reset(b);const now=performance.now(),quick=!cancelled&&now-s.pressedAt<85;s.held=null;s.x=aim(s.x,1,now,cancelled?34:25,cancelled?.9:.52);s.y=aim(s.y,1,now,cancelled?34:25,cancelled?.9:.52);if(quick){s.x.v=Math.min(s.x.v,s.surface?-.12:-.34);s.y.v=Math.min(s.y.v,s.surface?-.20:-.62);}schedule();}
  function pressInput(b,input,id){press(b,input,id);if(b?.matches('select'))requestAnimationFrame(()=>release(b));}
  document.addEventListener('pointerdown',e=>{if(e.button!==0||e.isPrimary===false)return;pressInput(buttonFor(e.target),'pointer',e.pointerId)},{passive:true,capture:true});
  const releasePointer=e=>{for(const[b,s]of states)if(s.held?.input==='pointer'&&s.held.id===e.pointerId)release(b,e.type!=='pointerup');};
  window.addEventListener('pointerup',releasePointer,{passive:true});window.addEventListener('pointercancel',releasePointer,{passive:true});window.addEventListener('lostpointercapture',releasePointer,{passive:true});
  document.addEventListener('pointerout',e=>{const b=buttonFor(e.target),s=states.get(b);if(s?.held?.input==='pointer'&&!b.contains(e.relatedTarget))release(b,true)},{passive:true});
  document.addEventListener('keydown',e=>{if((e.key===' '||e.key==='Enter')&&!e.repeat)pressInput(keyboardTarget(e),'key',e.key)},true);
  document.addEventListener('keyup',e=>{for(const[b,s]of states)if(s.held?.input==='key'&&s.held.id===e.key)release(b)});
  document.addEventListener('focusout',e=>{const b=buttonFor(e.target);if(b&&states.has(b))release(b,true)});
  document.addEventListener('contextmenu',()=>{for(const[b,s]of states)if(s.held)release(b,true)});
  document.addEventListener('click',e=>{if(!e.isTrusted||e.detail!==0)return;const b=buttonFor(e.target);if(b&&!states.has(b)){press(b,'assistive',0);release(b)}},{passive:true,capture:true});
  const resetAll=()=>{for(const b of states.keys())reset(b)};
  window.addEventListener('blur',resetAll);window.addEventListener('pagehide',resetAll);document.addEventListener('visibilitychange',()=>{if(document.hidden)resetAll()});reduced.addEventListener('change',resetAll);
  // Observe real state only. No timer promotes a task to success, and becoming
  // available again does not replay the previous user's press.
  new MutationObserver(()=>{for(const b of states.keys())if(!b.isConnected||busy(b))reset(b);}).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['disabled','aria-disabled','aria-busy','data-task-state','hidden']});
  window.StudioButtonFeedback=Object.freeze({stateChanged(b){if(states.has(b))release(b,true)},classify(b){if(b.matches(structural))return 'structural-or-native-scrubber';if(buttonFor(b)!==b)return 'not-action-control';if(busy(b))return 'disabled-busy-or-hidden';return reduced.matches?'reduced-motion':'covered'},inspect(){return{active:states.size,raf:!!frame,reduced:reduced.matches,held:[...states].filter(([,s])=>s.held).length}}});
})();
