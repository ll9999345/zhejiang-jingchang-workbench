/* Presentation and navigation only; all project/task actions remain native. */
(() => {
 document.body.dataset.unifiedCanvas='';
 if(['cloud-workflows','loras','model3d'].includes(document.body.dataset.nativePage))document.body.dataset.unifiedFunction='';
 const parentOrigin=location.origin;
 const config=window.CanvasModule||{};if(config.path)history.replaceState(null,'',config.path+(config.query?'?'+config.query:''));
 const reduced=matchMedia('(prefers-reduced-motion: reduce)');
 const transparency=matchMedia('(prefers-reduced-transparency: reduce)');
 const contrast=matchMedia('(forced-colors: active)');
 // The same light field, material and fluid solver as the main workbench.
 // These are surface selectors, never another app shell or project model.
 const glass={
  surfaces:'.unified-navigation,.app .topbar,.app .rail,.app .panel,.app .dock,.app .canvas-controls,.app .floating-menu,.app .node,.studio .topbar,.studio .left-panel,.studio .right-panel,.studio .canvas-toolbar,.studio .workflow-node,body[data-unified-conversation]>header,body[data-unified-conversation]>main>aside,body[data-unified-conversation] .connection,body[data-unified-conversation] #composer,body[data-unified-conversation] .bubble,body[data-unified-function]>header,body[data-unified-function]>main>section,body[data-unified-function]>main>aside,body[data-unified-function]>footer,dialog[open]',
  raised:'.unified-navigation,.topbar,.rail,.dock,.canvas-controls,.canvas-toolbar',
  foreground:'.unified-navigation,.topbar,.rail,.panel,.dock,.canvas-controls,.floating-menu,.left-panel,.right-panel,.canvas-toolbar,body[data-unified-conversation]>header,body[data-unified-conversation]>main>aside,body[data-unified-conversation] .connection,body[data-unified-conversation] #composer,body[data-unified-function]>header,body[data-unified-function]>main>section,body[data-unified-function]>main>aside,body[data-unified-function]>footer,dialog[open]',
  nested:'.app .node,.app .panel,.studio .left-panel,.studio .right-panel,body[data-unified-function]>main>section,body[data-unified-function]>main>aside,dialog',
  dialogs:'dialog[open]',
  performanceFallback:true,
  scaledSurfaces:'.app .node,.studio .workflow-node',
  geometryAttributes:['hidden','open','class','data-workspace-view','style'],
  geometryTargets:'.app #world,.app .node,.app .panel,.app .rail,.app .dock,.app .canvas-controls,.app .floating-menu,.studio .canvas-wrap,.studio .canvas-world,.studio .workflow-node,dialog',
 };
 const utilitySurfaces='.cc-header,.cli-header,.cc-glass,.cli-glass';
 for(const key of ['surfaces','foreground'])glass[key]+=','+utilitySurfaces;
 glass.nested+=',.cc-glass,.cli-glass';
 let field, light, navigation, previous='', loading=false, failed=false, fallback, performancePending=false;
 const preference=key=>{try{return localStorage.getItem(key);}catch{return null;}};
 const initialTheme=window.JingchangTheme?.read()||(preference('backlot.theme')==='light'?'light':'dark');
 if(window.JingchangTheme)window.JingchangTheme.set(initialTheme);else document.documentElement.dataset.theme=initialTheme;
 function guardNavigation(event){
  if(!event.target.closest('a')||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
  const status=document.querySelector('.studio #save-indicator,.app #save-status');
  if(status&&!/^(已保存到本机工作区|已保存到本机)$/.test(status.textContent.trim())){
   event.preventDefault();
   alert('当前修改尚未保存，请等待保存完成；若保存失败，请先处理，当前页面和修改会保留。');
  }
 }
 function syncVideo(){
  const stop=document.hidden||reduced.matches||transparency.matches||contrast.matches||document.body.dataset.ambientMotion==='paused';
  field?.setRunning(!stop);
  if(fallback){if(stop)fallback.pause();else fallback.play().catch(()=>{});}
 }
 async function checkPerformance(){
  const measured=Number(document.body.dataset.ambientSampleFps);
  if(performancePending||!Number.isFinite(measured)||measured>=24&&document.body.dataset.ambientSampleStatic!=='true'||document.body.dataset.ambientMotion!=='running')return;
  performancePending=true;
  try{const ambient=await import('/canvas-module/ambient-glass.js');ambient.applyAmbientPerformanceFallback();}
  catch{/* Readable CSS and the existing motion control remain available. */}
  finally{performancePending=false;syncVideo();}
 }
 function createField(){
  if(!light?.isConnected||field)return;
  if(window.StudioDreamField){
   field=window.StudioDreamField.create(light,{glass});light.dreamField=field;syncVideo();return;
  }
  if(loading)return;
  if(failed){
   if(!fallback){fallback=document.createElement('video');fallback.className='studio-dream-video';fallback.muted=true;fallback.loop=true;fallback.playsInline=true;fallback.preload='metadata';fallback.poster='/ui/dream-field-poster.png';fallback.src='/ui/dream-field.mp4';fallback.tabIndex=-1;fallback.setAttribute('aria-hidden','true');light.append(fallback);}
   syncVideo();return;
  }
  loading=true;
  const script=document.createElement('script');script.src='/ui/dream-field.js';
  script.onload=()=>{loading=false;createField();};
  script.onerror=()=>{loading=false;failed=true;createField();};
  document.head.append(script);
 }
 function mount(){
  if(document.querySelector('body>main>.conversation'))document.body.dataset.unifiedConversation='';
  // All feature pages share the same light field, including utility pages.
  if(!document.querySelector('.jc-aurora')){const ambient=document.createElement('div');ambient.className='jc-aurora';ambient.setAttribute('aria-hidden','true');document.body.prepend(ambient);}
  const next=document.querySelector('.jc-aurora');
  if(next!==light){field?.dispose();field=null;fallback?.remove();fallback=null;light=next;}
  if(light)createField();
  const rail=document.querySelector('.app,.studio,body>header,body>main>.cc-header,body>main>.cli-header');
  if(rail){
   if(!navigation){navigation=document.createElement('nav');navigation.className='unified-navigation';navigation.setAttribute('aria-label','浙江文旅导航');navigation.addEventListener('click',guardNavigation);
    navigation.innerHTML='<a href="'+parentOrigin+'/" target="_top" title="返回浙江文旅工作台">返回浙江文旅</a><a href="'+parentOrigin+'/canvas-exchange" target="_top" title="带入文旅资料或取回产物">资料</a>';
    const source=new URLSearchParams(location.search).get('sourceProject');
    if(source&&/^[\w-]+$/.test(source))navigation.lastElementChild.href+='?project='+encodeURIComponent(source);
   }
   if(navigation.parentElement!==rail)rail.insertBefore(navigation,rail.firstChild);
  }
 }
 window.addEventListener('jingchang:location',event=>{
  const {project,view}=event.detail||{};if(!/^[\w-]+$/.test(project||''))return;
  const state=project+':'+view;if(state===previous)return;previous=state;
  const url=new URL(location.href);url.searchParams.set('project',project);url.searchParams.set('view',view);history.replaceState(null,'',url);
  // Native project/view identity remains in the workbench URL.
 });
 document.addEventListener('visibilitychange',syncVideo);window.addEventListener('pageshow',syncVideo);
 for(const media of [reduced,transparency,contrast])media.addEventListener('change',syncVideo);
 new MutationObserver(mount).observe(document.body,{childList:true,subtree:true});
 new MutationObserver(syncVideo).observe(document.body,{attributes:true,attributeFilter:['data-ambient-motion','data-ambient-transparency']});
 new MutationObserver(checkPerformance).observe(document.body,{attributes:true,attributeFilter:['data-ambient-sample-fps']});
 window.addEventListener('storage',event=>{if(event.key==='backlot.theme'&&!window.JingchangTheme)document.documentElement.dataset.theme=event.newValue==='light'?'light':'dark';});
 window.addEventListener('pagehide',event=>{if(!event.persisted){field?.dispose();fallback?.pause();}});
 mount();
})();
