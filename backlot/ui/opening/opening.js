/*
 * ZHEJIANG CULTURE / LIQUID STUDIO — ADAPTED ORIGINAL BRAND OPENING
 * Installation: after studio.js on the library's index.html, not the canvas proxy.
 * Pure presentation. No fetch/XHR, API calls, navigation, data edits, or storage
 * except one namespaced sessionStorage boolean that prevents repeat autoplay.
 * Accessible fallback, canvas/WebGL fallback, interruption-safe teardown.
 */
(function (global, doc) {
  'use strict';
  if(global.ZhejiangOpening) return;
  const KEY='zhejiang:opening:field-notes:v1:seen';
  const REAL_MS=6480;
  const PHASES=[['awake',100],['story',1450],['system',3470],['handoff',4990]];
  const params=new URLSearchParams(location.search);
  const media=global.matchMedia?.('(prefers-reduced-motion: reduce)');
  const isReduced=()=>!!media?.matches;
  const clamp=(n,a,b)=>Math.min(b,Math.max(a,n));
  const ease=(n)=>1-Math.pow(1-clamp(n,0,1),3.1);
  const safeStore={
    get(){try{return sessionStorage.getItem(KEY)==='1';}catch{return false;}},
    set(){try{sessionStorage.setItem(KEY,'1');}catch{/* optional */}}
  };
  const markSVG=`<svg viewBox="0 0 58 58" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M5 13.5 29 2l24 11.5v31L29 56 5 44.5V13.5Z" stroke="currentColor" stroke-opacity=".76"/><path d="m15 34 7-11 7 12 7-17 7 14" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="m15 41 7-6 7 5 7-8 7 6" stroke="currentColor" stroke-width="1" opacity=".55"/></svg>`;
  const arrowSVG='<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 12h16m-6-6 6 6-6 6"/></svg>';
  const replaySVG='<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.7 9.1a7 7 0 0 1 12.7-1.2L20 12M4 12l1.6 3.9A7 7 0 0 0 18.3 15"/></svg>';
  function glassStudy(variant) {
    return `<div class="zo-glass-study zo-glass-study-${variant}"><i class="zo-study-fluid"></i><i class="zo-study-fluid zo-study-fluid-b"></i><i class="zo-study-contour"></i><div class="zo-study-track"><i></i><i></i><i></i></div></div>`;
  }
  function markup() {
    return `<div class="zo-land" aria-hidden="true">
      <div class="zo-solid-backdrop"></div>
      <canvas class="zo-terrain" aria-hidden="true"></canvas>
      <div class="zo-liquid-orbit"></div><div class="zo-ambient-bloom"></div>
      <div class="zo-shade"></div>
    </div>
    <div class="zo-guides" aria-hidden="true"><i></i><i></i><i></i></div>
    <div class="zo-corner zo-corner-tl" aria-hidden="true"></div><div class="zo-corner zo-corner-tr" aria-hidden="true"></div>
    <div class="zo-corner zo-corner-bl" aria-hidden="true"></div><div class="zo-corner zo-corner-br" aria-hidden="true"></div>
    <header class="zo-head">
      <div class="zo-brand"> <span class="zo-symbol">${markSVG}</span>
       <span><b>ZHEJIANG<span class="zo-brand-dot">.</span></b><small>文旅智能影像工作台</small></span>
      </div>
      <div class="zo-top-center"><span class="zo-blink"></span> MADE OF PLACES, MADE OF STORIES <span class="zo-top-index"> / VOL. 001</span></div>
      <button class="zo-skip" type="button" aria-label="跳过品牌片头并进入项目库">跳过片头 <span aria-hidden="true">↗</span></button>
    </header>
    <aside class="zo-side" aria-hidden="true"><span>EST. 2026 — ZHEJIANG</span><span class="zo-vertical-rule"></span><span>28°–31° N / 118°–123° E</span></aside>
    <div class="zo-opening-flash" aria-hidden="true"></div>
    <div class="zo-main-type">
       <p class="zo-kicker"><span class="zo-kicker-rule"></span> 不止记录风景 <span class="zo-kicker-num">01 / THE VISION</span></p>
       <h1 class="zo-title"><span class="zo-text-line"><span>让山海</span></span><span class="zo-text-line"><span>成为<span class="zo-em">故事</span><b class="zo-period">。</b></span></span></h1>
       <p class="zo-desc">把一座城的呼吸，写成每一帧的光。<br>从灵感、分镜到影像，在一张自由的画布上发生。</p>
       <div class="zo-type-accent" aria-hidden="true"><span>FROM PLACE</span><i></i><span>TO FRAME</span></div>
    </div>
    <div class="zo-giant-glyph" aria-hidden="true">浙</div>
    <div class="zo-frame-system" aria-hidden="true">
      <div class="zo-film-card zo-film-side zo-film-side-a">${glassStudy('forest')}<span>01 — INTO THE WILD</span></div>
      <div class="zo-film-card zo-film-side zo-film-side-b">${glassStudy('night')}<span>03 — AFTER DARK</span></div>
      <div class="zo-main-film">
         <div class="zo-film-art">${glassStudy('main')}</div>
         <div class="zo-film-sheen"></div>
         <div class="zo-filmbox-head"><span class="zo-record-dot"></span><span>LIVE COMPOSITION</span><b>REC • 00:08:24</b></div>
         <div class="zo-film-cross zo-film-cross-a"></div><div class="zo-film-cross zo-film-cross-b"></div>
         <div class="zo-filmbox-foot"><span>SCENE 001 / 浙江 · 山与海</span><span>16:9 — 4K</span></div>
      </div>
      <div class="zo-frame-label"><span class="zo-number">01</span><span>捕捉一束光<br>展开万千叙事</span></div>
      <div class="zo-halo-ring"></div>
    </div>
    <div class="zo-editor-flow" aria-hidden="true">
      <svg class="zo-flow-lines" viewBox="0 0 760 220" preserveAspectRatio="none"><path d="M12 110 C115 110 75 35 195 35 S315 110 372 110 S469 186 550 186 S649 110 745 110" fill="none" stroke="currentColor" stroke-opacity=".52" stroke-width="1.2" stroke-dasharray="5 6"/></svg>
      <div class="zo-flow-node zo-flow-node-1"><span>01</span><b>灵感</b><small>想象</small></div>
      <div class="zo-flow-node zo-flow-node-2"><span>02</span><b>分镜</b><small>导演</small></div>
      <div class="zo-flow-node zo-flow-node-3"><span>03</span><b>成片</b><small>讲述</small></div>
    </div>
    <section class="zo-final-statement" aria-label="浙江文旅智能导演与镜场">
      <div class="zo-final-overline"><span class="zo-spark">✳</span> EVERY CITY HAS A STORY TO TELL</div>
      <h2>从想法<br><span>到作品。</span></h2>
      <div class="zo-final-foot"><span>浙江文旅智能导演</span><i></i><b>镜场</b><small>ONE SPACE. INFINITE STORIES.</small></div>
    </section>
    <div class="zo-static-content"><span class="zo-static-mark">${markSVG}</span><p>浙江文旅 · 智能导演 × 镜场</p><h2>让山海，成为故事。</h2><p>从一束光，到一部作品。</p><button class="zo-static-enter" type="button">进入工作台 ${arrowSVG}</button></div>
    <footer class="zo-bottom"><div class="zo-chapters"><span class="zo-chapter-num">01</span><span class="zo-divider-slash">/</span><span>03</span><i></i><span class="zo-chapter-name">山海入镜 · OPENING SCENE</span></div>
      <div class="zo-progress-track"><i class="zo-progress-inner"></i></div>
      <div class="zo-bottom-right"><span>DIRECTOR'S STUDIO</span><span class="zo-reelclock">00:00:00</span><span class="zo-play-dot">●</span></div></footer>`;
  }
  class Opening {
    constructor(settings={}) {
      this.settings=settings;
      this.speed=clamp(Number(settings.durationScale)||1,.12,4);
      this.reduced=!!(settings.reducedOverride ?? isReduced());
      this.rendererWanted=settings.renderer||params.get('openingRenderer')||'auto';
      this.state='initializing';this.phase='seed';this.raf=0;
      this.started=0;this.lastDraw=0;this.pointer={x:.5,y:.5};this.tearDown=false;
      this.listeners=new AbortController();
      this.oldFocus=doc.activeElement;
      this.root=doc.createElement('div');
      this.root.className='zo-root';this.root.id='zj-brand-opening';
      this.root.setAttribute('role','dialog');
      this.root.setAttribute('aria-modal','true');
      this.root.setAttribute('aria-label','浙江文旅品牌开屏，按 Escape 键可直接进入工作台');
      this.root.dataset.phase='seed';
      this.root.dataset.reduced=this.reduced?'true':'false';
      this.root.style.setProperty('--zo-speed',String(this.speed));
      this.root.innerHTML=markup();
      doc.body.append(this.root);
      this.skipButton=this.root.querySelector('.zo-skip');
      this.enterButton=this.root.querySelector('.zo-static-enter');
      this.focusButton=this.reduced?this.enterButton:this.skipButton;
      this.skipButton.addEventListener('click',()=>this.finish('skip'),{signal:this.listeners.signal});
      this.enterButton.addEventListener('click',()=>this.finish('enter'),{signal:this.listeners.signal});
      // During opening, background actions must not receive unintentional clicks.
      this.root.addEventListener('pointerdown',(e)=>{
        if(e.target.closest('button')) return;
        if(e.pointerType==='mouse') return; // Touch users can tap anywhere to enter.
        this.finish('tap');
      },{signal:this.listeners.signal});
      doc.addEventListener('keydown',(event)=>{
        // Each mode has one visible action; keep Tab / Shift+Tab inside the dialog.
        if(event.key==='Tab'){
          event.preventDefault();event.stopPropagation();
          this.focusButton.focus({preventScroll:true});
        }
        if(event.key==='Escape'){
          event.preventDefault();event.stopPropagation();this.finish('escape');
        }
      },{signal:this.listeners.signal,capture:true});
      doc.addEventListener('visibilitychange',()=>{
        if(doc.hidden) this.finish('hidden');
      },{signal:this.listeners.signal});
      global.addEventListener('pagehide',()=>this.finish('pagehide'),{signal:this.listeners.signal});
      this.root.addEventListener('pointermove',event=>{
        if(this.reduced || this.state==='finishing')return;
        const next={x:clamp(event.clientX/Math.max(1,innerWidth),0,1),y:clamp(event.clientY/Math.max(1,innerHeight),0,1)};
        this.pointer=next;
        this.root.style.setProperty('--zo-look-x',(next.x-.5).toFixed(3));
        this.root.style.setProperty('--zo-look-y',(next.y-.5).toFixed(3));
      },{signal:this.listeners.signal,passive:true});
      if(!this.reduced) {
        let canvas=this.root.querySelector('.zo-terrain');
        this.renderer=global.ZJTerrainRenderer?.create(canvas,{
          renderer:this.rendererWanted,
          onFallback:()=>this.root?.classList.add('zo-gpu-fallback'),
          onContextLost:()=>this.onContextLost()
        });
      }
      this.root.dataset.renderer=this.renderer?.kind||'css-static';
      this.state=this.reduced?'static':'playing';
      if(this.reduced) {
        this.root.dataset.phase='static';
      } else {
        this.started=performance.now();
        this.raf=requestAnimationFrame(t=>this.tick(t));
      }
      this.focusButton.focus({preventScroll:true});
      doc.dispatchEvent(new CustomEvent('opening:started',{detail:{renderer:this.root.dataset.renderer,reduced:this.reduced}}));
    }
    onContextLost() {
      if(this.state!=='playing') return;
      this.renderer?.dispose();
      this.renderer=null;
      const old=this.root?.querySelector('.zo-terrain');
      if(old){const newCanvas=old.cloneNode(false);old.replaceWith(newCanvas);
        this.renderer=global.ZJTerrainRenderer?.create(newCanvas,{renderer:'2d'});
      }
      if(this.root){this.root.dataset.renderer=this.renderer?.kind||'css-static';this.root.classList.add('zo-gpu-fallback');}
    }
    setPhase(name) {
      if(name===this.phase || !this.root) return;
      this.phase=name;this.root.dataset.phase=name;
      const chapters={seed:['01','山海入镜 · OPENING SCENE'],awake:['01','山海入镜 · OPENING SCENE'],story:['02','光影成章 · STORYBOARD'],system:['03','无限创作 · ONE WORKSPACE'],handoff:['03','欢迎进入创作工作台']};
      const [num,label]=chapters[name]||chapters.seed;
      this.root.querySelector('.zo-chapter-num').textContent=num;
      this.root.querySelector('.zo-chapter-name').textContent=label;
      doc.dispatchEvent(new CustomEvent('opening:phase',{detail:{phase:name}}));
    }
    tick(now) {
      if(this.state!=='playing') return;
      const elapsed=(now-this.started)/this.speed;
      const pct=clamp(elapsed/REAL_MS,0,1);
      for(let i=PHASES.length-1;i>=0;i--) {
        if(elapsed>=PHASES[i][1]) {this.setPhase(PHASES[i][0]);break;}
      }
      this.root.querySelector('.zo-progress-inner').style.transform=`scaleX(${pct.toFixed(4)})`;
      const frames=Math.floor(elapsed/40);
      this.root.querySelector('.zo-reelclock').textContent=`00:${String(Math.floor(elapsed/1000)).padStart(2,'0')}:${String(frames%25).padStart(2,'0')}`;
      if(this.renderer && elapsed<5300 && now-this.lastDraw>(this.renderer.kind==='webgl2'?30:48)) {
        this.lastDraw=now;
        try {this.renderer.render({time:elapsed/1000,progress:pct,pointer:this.pointer});}
        catch {this.onContextLost();}
      }
      if(elapsed>=4990) {
        const p=ease((elapsed-4990)/1260);
        // Expanding transparent iris reveals *the already initialized real DOM*.
        // Nothing underneath is cloned, rerouted, reparented, or mutated.
        const radius=p*Math.hypot(innerWidth,innerHeight)*1.34;
        const mask=`radial-gradient(circle at 54% 53%, transparent ${Math.max(0,radius-2)}px, #000 ${radius+3}px)`;
        this.root.style.maskImage=mask;
        this.root.style.webkitMaskImage=mask;
        // Opacity also makes the transition legible on browsers without CSS mask.
        this.root.style.opacity=String(1-Math.pow(p,4)*.998);
      }
      if(elapsed>=5300 && this.renderer){this.renderer.dispose();this.renderer=null;}
      if(elapsed>=REAL_MS){this.finish('complete');return;}
      this.raf=requestAnimationFrame(t=>this.tick(t));
    }
    finish(reason) {
      if(this.tearDown)return;
      this.tearDown=true;this.state='finishing';
      cancelAnimationFrame(this.raf);this.raf=0;
      this.renderer?.dispose();this.renderer=null;
      this.listeners.abort();
      const root=this.root;
      root?.remove();this.root=null;
      if(this.oldFocus?.isConnected && this.oldFocus!==doc.body){
        try{this.oldFocus.focus({preventScroll:true});}catch{/* no-op */}
      } else if(doc.activeElement===doc.body || doc.activeElement===root?.querySelector('.zo-skip')){
        // Do not make a formerly unfocused business control act as if clicked.
        doc.querySelector('#studioMain')?.focus?.({preventScroll:true});
      }
      safeStore.set();
      this.state='finished';
      if(active===this)active=null;
      doc.dispatchEvent(new CustomEvent('opening:entered',{detail:{reason}}));
    }
    inspect() {return {state:this.state,phase:this.phase,renderer:this.renderer?.kind||'released',active:!!this.root,raf:!!this.raf,reduced:this.reduced};}
  }
  let active=null,initialized=false;
  function play(opts={}) {
    active?.finish('interrupted');
    const opening=new Opening(opts);active=opening;
    return opening;
  }
  function injectReplay() {
    const top=doc.querySelector('.studio-top-actions');
    if(!top || doc.getElementById('zo-replay-button'))return;
    const b=doc.createElement('button');
    b.id='zo-replay-button';b.type='button';b.className='studio-icon-button zo-replay';
    b.title='重播品牌开屏';b.setAttribute('aria-label','重播品牌开屏');
    b.innerHTML=replaySVG;
    b.addEventListener('click',()=>play());
    top.append(b);
  }
  function boot() {
    if(initialized)return;initialized=true;
    // Production always runs on `/` (library), never on actual `/canvas` or create flows.
    if(doc.body?.dataset.studioPage!=='library')return;
    injectReplay();
    const mode=params.get('opening');
    if(mode==='off'||(mode!=='always'&&safeStore.get())||isReduced())return;
    // On slow devices, the library is already usable; this is never a loading gate.
    play();
  }
  doc.addEventListener('studio:ready',boot,{once:true});
  if(doc.readyState==='loading')doc.addEventListener('DOMContentLoaded',()=>{
    if(doc.body?.classList.contains('studio-ready'))boot();
  },{once:true});
  else if(doc.body?.classList.contains('studio-ready'))boot();
  global.ZhejiangOpening=Object.freeze({
    replay(settings){return play(settings||{});},
    skip(){active?.finish('api');},
    inspect(){return active?.inspect()||{state:'idle',phase:'none',renderer:'released',active:false,raf:false,reduced:isReduced()};},
    get sessionSeen(){return safeStore.get();},
    version:'1.1.0-liquid'
  });
})(window,document);
