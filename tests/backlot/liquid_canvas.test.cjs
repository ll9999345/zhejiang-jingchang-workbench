// Exercise the shared renderer's DOM/layout lifecycle, not shader aesthetics.
// The browser acceptance separately verifies the real mounted app and fallback.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../../backlot/ui/dream-field.js'),'utf8');

function fixture({unavailable=false,reduced=false,software=false}={}){
 const raf=new Map(),observers=[],queries=new Map(),calls=[],elements=[];
 let next=0,now=1000,contexts=0,copies=0;
 class Element{
  constructor(tag,selectors=[]){this.tagName=tag.toUpperCase();this.selectors=new Set(selectors);this.className='';this.attributes=new Map();this.dataset={};this.children=[];this.isConnected=true;this.parentElement=null;this.listeners=new Map();this.rect={left:0,top:0,width:240,height:160,bottom:160,right:240};this.style={transform:'',setProperty(){}};}
  getBoundingClientRect(){return this.rect;}
  matches(value){return value.split(',').some(s=>this.selectors.has(s.trim()));}
  closest(value){if(this.matches(value))return this;return this.parentElement?.closest(value)||null;}
  setAttribute(key,value){this.attributes.set(key,value);}
  hasAttribute(key){return key.startsWith('data-')?this.dataset[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]!==undefined:this.attributes.has(key);}
  removeAttribute(key){this.attributes.delete(key);if(key.startsWith('data-'))delete this.dataset[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())];}
  append(child){child.parentElement=this;this.children.push(child);}
  prepend(child){child.parentElement=this;this.children.unshift(child);}
  after(child){child.parentElement=this.parentElement;elements.push(child);}
  remove(){this.isConnected=false;if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(e=>e!==this);}
  addEventListener(type,fn){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(fn);}
  removeEventListener(type,fn){this.listeners.get(type)?.delete(fn);}
  dispatchEvent(event){for(const fn of this.listeners.get(event.type)||[])fn(event);}
 }
 const gl=new Proxy({
  isContextLost:()=>false,getError:()=>0,
  getExtension:name=>name==='WEBGL_debug_renderer_info'?{UNMASKED_RENDERER_WEBGL:'renderer'}:null,
  getParameter:()=>software?'ANGLE (Google, SwiftShader Device)':'Apple GPU',
  getShaderParameter:()=>true,getProgramParameter:()=>true,
  createShader:()=>({}),createProgram:()=>({}),createBuffer:()=>({}),createTexture:()=>({}),createFramebuffer:()=>({}),
  getAttribLocation:()=>0,getUniformLocation:(_,name)=>name,
  viewport:(...value)=>calls.push({type:'viewport',value}),
  uniform2f:(name,...value)=>calls.push({type:'uniform',name,value}),
 },{get(target,key){if(key in target)return target[key];if(/^[A-Z0-9_]+$/.test(key))return key;return (...value)=>calls.push({type:key,value});}});
 class Canvas extends Element{
  constructor(){super('canvas');this.width=300;this.height=150;this.rect={left:0,top:0,width:1280,height:720,bottom:720,right:1280};}
  getContext(kind){if(kind==='webgl2'){contexts++;return unavailable?null:gl;}return {clearRect(){},drawImage(){copies++;}};}
 }
 class Video extends Element{
  constructor(){super('video');this.readyState=2;this.currentTime=1;this.videoWidth=1280;this.videoHeight=720;this.paused=true;this.playCount=0;this.pauseCount=0;}
  play(){this.paused=false;this.playCount++;return Promise.resolve();}
  pause(){this.paused=true;this.pauseCount++;}
  load(){}
  getVideoPlaybackQuality(){return {totalVideoFrames:Math.round(this.currentTime*30)};}
  requestVideoFrameCallback(fn){const id=++next;raf.set(id,fn);return id;}
  cancelVideoFrameCallback(id){raf.delete(id);}
 }
 const body=new Element('body'),root=new Element('html');root.dataset.theme='dark';root.style={setProperty(){}};
 const document={body,documentElement:root,hidden:false,createElement(tag){const e=tag==='canvas'?new Canvas():tag==='video'?new Video():new Element(tag);elements.push(e);return e;},querySelectorAll(selector){return elements.filter(e=>e.isConnected&&e.matches(selector));},querySelector(selector){return this.querySelectorAll(selector)[0]||null;},addEventListener(){},removeEventListener(){}};
 function matchMedia(query){if(!queries.has(query))queries.set(query,{matches:reduced&&query.includes('reduced-transparency'),addEventListener(type,fn){this.listener=fn;},removeEventListener(){}});return queries.get(query);}
 class Observer{constructor(callback){this.callback=callback;observers.push(this);}observe(target,options){this.target=target;this.options=options;}disconnect(){this.disconnected=true;}}
 const context=vm.createContext({window:{},document,Element,URL,location:{href:'http://127.0.0.1/?flow=analytic'},matchMedia,
  innerWidth:1280,innerHeight:720,performance:{now:()=>now},requestAnimationFrame:fn=>{const id=++next;raf.set(id,fn);return id;},cancelAnimationFrame:id=>raf.delete(id),
  MutationObserver:Observer,ResizeObserver:Observer,getComputedStyle:()=>({borderTopLeftRadius:'18px',display:'block',visibility:'visible'}),Event});
 context.window.addEventListener=()=>{};context.window.removeEventListener=()=>{};
 vm.runInContext(source,context);
 function pane(selectors,rect){const e=new Element('aside',selectors);if(rect)e.rect={...e.rect,...rect};e.parentElement=body;elements.push(e);return e;}
 const host=pane(['.jc-aurora']),video=new Video();
 function flush(){now+=40;const pending=[...raf.values()];raf.clear();pending.forEach(fn=>fn(now));}
 return {context,document,host,video,pane,gl,calls,queries,observers,flush,raf,elements,get contexts(){return contexts;},get copies(){return copies;}};
}

test('main workbench defaults retain one raised topbar and its foreground copy',()=>{
 const f=fixture(),top=f.pane(['.studio-topbar']),card=f.pane(['.media-card']);
 const renderer=f.context.window.StudioDreamGlassScene.create(f.video,f.host);
 assert.equal(renderer.inspect().visibleSurfaces,2);
 assert.equal(renderer.inspect().foregroundSurfaces,1);
 assert.equal(top.dataset.glassSurface,'webgl');assert.equal(card.dataset.glassSurface,'webgl');
 assert.equal(f.contexts,1);assert.equal(f.copies,1);renderer.dispose();
});

test('native chrome and cards share one WebGL scene with fixed DOM geometry',()=>{
 const f=fixture(),top=f.pane(['.app .topbar','.topbar']),rail=f.pane(['.app .rail','.rail']),node=f.pane(['.app .node','.node']);
 const before=JSON.stringify([top.rect,rail.rect,node.rect]);
 const renderer=f.context.window.StudioDreamGlassScene.create(f.video,f.host,{surfaces:'.app .topbar,.app .rail,.app .node',raised:'.topbar,.rail',foreground:'.topbar,.rail'});
 assert.equal(renderer.inspect().visibleSurfaces,3);assert.equal(renderer.inspect().foregroundSurfaces,2);
 assert.equal(f.contexts,1);assert.equal(f.copies,2);assert.equal(JSON.stringify([top.rect,rail.rect,node.rect]),before);
 assert.equal(node.dataset.glassSurface,'webgl');renderer.dispose();
});

test('native pan/zoom style changes remeasure panes without observing button animation styles',()=>{
 const f=fixture(),node=f.pane(['.app .node','.node']),world=f.pane(['.app #world']),button=f.pane(['button']);
 node.offsetWidth=240;
 const renderer=f.context.window.StudioDreamGlassScene.create(f.video,f.host,{surfaces:'.app .node',scaledSurfaces:'.app .node',geometryAttributes:['style'],geometryTargets:'.app #world,.app .node'});
 const observer=f.observers.find(o=>o.options?.attributeFilter?.includes('style'));
 node.rect={...node.rect,left:180,top:120,width:120,height:80,right:300,bottom:200};
 observer.callback([{attributeName:'style',type:'attributes',target:button}]);assert.equal(f.raf.size,0);
 observer.callback([{attributeName:'style',type:'attributes',target:world}]);f.flush();
 const surface=renderer.inspect().surfaces[0];assert.equal(surface.x,180);assert.equal(surface.width,120);
 assert(f.calls.some(c=>c.type==='uniform1f'&&c.value[0]==='radius'&&c.value[1]===9),'rounded glass edge follows the same half-scale as its native node');
 renderer.dispose();
});

test('removed native panels release their foreground copy and material flag',()=>{
 const f=fixture(),panel=f.pane(['.app .panel','.panel']);
 const renderer=f.context.window.StudioDreamGlassScene.create(f.video,f.host,{surfaces:'.app .panel',foreground:'.panel'});
 assert.equal(renderer.inspect().foregroundSurfaces,1);panel.remove();
 f.observers.find(o=>o.options?.childList).callback([{type:'childList'}]);f.flush();
 assert.equal(renderer.inspect().foregroundSurfaces,0);assert.equal(panel.dataset.glassSurface,undefined);renderer.dispose();
});

test('reduced transparency restores readable DOM surfaces without disposing media controls',()=>{
 const f=fixture(),node=f.pane(['.media-card']);
 const renderer=f.context.window.StudioDreamGlassScene.create(f.video,f.host);
 const media=f.queries.get('(prefers-reduced-transparency:reduce)');media.matches=true;media.listener();f.flush();
 assert.equal(node.dataset.glassSurface,undefined);assert.equal(f.elements.find(e=>e.className==='studio-glass-scene').hidden,true);
 assert.equal(node.isConnected,true);media.matches=false;media.listener();f.flush();
 assert.equal(node.dataset.glassSurface,'webgl');renderer.dispose();
});

test('measured session performance fallback releases glass and allows an explicit resume',()=>{
 const f=fixture(),top=f.pane(['.app .topbar','.topbar']);
 const renderer=f.context.window.StudioDreamGlassScene.create(f.video,f.host,{surfaces:'.app .topbar',foreground:'.topbar',performanceFallback:true});
 assert.equal(top.dataset.glassSurface,'webgl');const frames=renderer.inspect().frames;
 f.document.body.dataset.ambientQuality='static';f.document.body.dataset.ambientReason='performance';renderer.setRunning(false);
 assert.equal(f.host.dataset.glassStatus,'performance-fallback');assert.equal(top.dataset.glassSurface,undefined);
 assert.equal(top.children[0].hidden,true);assert.equal(f.elements.find(e=>e.className==='studio-glass-scene').hidden,true);
 renderer.render();assert.equal(renderer.inspect().frames,frames);assert.equal(top.isConnected,true);
 f.document.body.dataset.ambientQuality='standard';f.document.body.dataset.ambientReason='';renderer.setRunning(true);f.flush();
 assert.equal(top.dataset.glassSurface,'webgl');assert.equal(top.children[0].hidden,false);assert.equal(f.host.dataset.glassStatus,'ready');
 assert.equal(f.contexts,1);renderer.dispose();assert.equal(f.raf.size,0);
});

test('WebGL unavailable leaves the native app intact and one usable media fallback',async()=>{
 const f=fixture({unavailable:true}),node=f.pane(['.app .node']);
 const field=f.context.window.StudioDreamField.create(f.host,{glass:{surfaces:'.app .node'}});
 assert.equal(f.host.dataset.glassStatus,'webgl-unavailable');assert.equal(node.dataset.glassSurface,undefined);
 assert.equal(f.host.children.filter(e=>e.tagName==='VIDEO').length,1);
 field.setRunning(true);await Promise.resolve();assert.equal(field.state.running,true);
 field.setRunning(false);assert.equal(field.state.running,false);field.dispose();assert.equal(node.isConnected,true);
});

test('field cancellation prevents a late play promise from restarting its clock',async()=>{
 const f=fixture({unavailable:true}),field=f.context.window.StudioDreamField.create(f.host);
 const video=f.host.children[0];let finish;video.play=()=>new Promise(resolve=>{finish=resolve;video.paused=false;});
 field.setRunning(true);field.setRunning(false);finish();await Promise.resolve();
 assert.equal(video.paused,true);assert.equal(f.raf.size,0);field.dispose();
});

test('context loss and disposal release foreground canvases and retain original nodes',()=>{
 const f=fixture(),top=f.pane(['.studio-topbar']);
 const renderer=f.context.window.StudioDreamGlassScene.create(f.video,f.host),scene=f.elements.find(e=>e.className==='studio-glass-scene');
 scene.dispatchEvent({type:'webglcontextlost',preventDefault(){}});
 assert.equal(top.dataset.glassSurface,undefined);assert.equal(scene.hidden,true);
 renderer.dispose();assert.equal(scene.isConnected,false);assert.equal(top.children.length,0);assert.equal(top.isConnected,true);
 assert(f.observers.every(o=>o.disconnected));assert.equal(f.raf.size,0);
});

test('restored GPU context never reuses invalid resources or clears readable fallback',()=>{
 const f=fixture(),top=f.pane(['.studio-topbar']);
 const renderer=f.context.window.StudioDreamGlassScene.create(f.video,f.host),scene=f.elements.find(e=>e.className==='studio-glass-scene');
 const frames=renderer.inspect().frames;
 scene.dispatchEvent({type:'webglcontextlost',preventDefault(){}});
 scene.dispatchEvent({type:'webglcontextrestored'});
 // A real restored context reports isContextLost=false, as this fixture does.
 renderer.setRunning(true);f.video.currentTime+=1;
 f.observers.find(o=>o.options?.childList).callback([{type:'childList'}]);f.flush();renderer.render();
 assert.equal(renderer.inspect().frames,frames,'Lost programs must not be used again');
 assert.equal(top.dataset.glassSurface,undefined,'The original readable DOM material remains active');
 assert.equal(scene.hidden,true);assert.equal(top.children[0].hidden,true);
 assert.equal(f.host.dataset.sharedGlass,undefined);assert.equal(f.host.dataset.glassStatus,'context-lost');
 renderer.dispose();assert.equal(top.isConnected,true);
});


test('explicit native open dialogs share the scene through a top-layer foreground copy',()=>{
 const f=fixture(),dialog=f.pane(['dialog','dialog[open]']),inside=f.pane(['.media-card']);inside.parentElement=dialog;
 const renderer=f.context.window.StudioDreamGlassScene.create(f.video,f.host,{surfaces:'dialog[open],.media-card',dialogs:'dialog[open]',foreground:'dialog[open]',nested:'dialog'});
 assert.equal(renderer.inspect().visibleSurfaces,1);assert.equal(renderer.inspect().foregroundSurfaces,1);
 assert.equal(dialog.dataset.glassSurface,'webgl');assert.equal(inside.dataset.glassSurface,undefined);
 dialog.selectors.delete('dialog[open]');f.observers.find(o=>o.options?.childList).callback([{type:'attributes',attributeName:'open',target:dialog}]);f.flush();
 assert.equal(renderer.inspect().visibleSurfaces,0);assert.equal(dialog.dataset.glassSurface,undefined);
 dialog.selectors.add('dialog[open]');f.observers.find(o=>o.options?.childList).callback([{type:'attributes',attributeName:'open',target:dialog}]);f.flush();
 assert.equal(renderer.inspect().visibleSurfaces,1);assert.equal(dialog.dataset.glassSurface,'webgl');renderer.dispose();
});

test('default workbench still excludes modal descendants and uses native readable dialogs',()=>{
 const f=fixture(),dialog=f.pane(['dialog']),inside=f.pane(['.media-card']);inside.parentElement=dialog;
 const renderer=f.context.window.StudioDreamGlassScene.create(f.video,f.host);
 assert.equal(renderer.inspect().visibleSurfaces,0);assert.equal(inside.dataset.glassSurface,undefined);renderer.dispose();
});

test('native dialog content replacement restores its detached foreground without duplicating the scene',()=>{
 const f=fixture(),dialog=f.pane(['dialog','dialog[open]']);
 const renderer=f.context.window.StudioDreamGlassScene.create(f.video,f.host,{surfaces:'dialog[open]',dialogs:'dialog[open]',foreground:'dialog[open]'});
 const first=dialog.children[0];assert.equal(first.className,'studio-glass-front');first.remove();
 f.observers.find(o=>o.options?.childList).callback([{type:'childList',target:dialog}]);f.flush();
 const second=dialog.children[0];assert.notEqual(first,second);assert.equal(second.isConnected,true);assert.equal(second.hidden,false);
 assert.equal(renderer.inspect().foregroundSurfaces,1);assert.equal(f.contexts,1);assert.equal(dialog.children.length,1);
 renderer.dispose();assert.equal(dialog.children.length,0);assert.equal(dialog.isConnected,true);
});


test('software WebGL keeps the native video clock without compiling a blocking glass scene',async()=>{
 const f=fixture({software:true}),node=f.pane(['.media-card']);
 const field=f.context.window.StudioDreamField.create(f.host);
 assert.equal(f.host.dataset.glassStatus,'software-video');
 assert.equal(f.calls.filter(c=>c.type==='shaderSource').length,0);
 assert.equal(node.dataset.glassSurface,undefined);
 field.setRunning(true);await Promise.resolve();assert.equal(field.state.running,true);
 assert.equal(f.document.body.dataset.ambientQuality,undefined);
 field.dispose();assert.equal(f.raf.size,0);assert.equal(node.isConnected,true);
});
