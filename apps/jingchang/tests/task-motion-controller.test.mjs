import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as realDelay} from 'node:timers/promises';
import {taskProgressMarkup} from '../public/task-motion.js';

// A minimal DOM boundary for controller wiring tests. It does not render CSS,
// simulate layout, or claim browser/visual acceptance.
class Element extends EventTarget{
 constructor(tag='div'){super();this.tag=tag;this.dataset={};this.attributes=new Map();this.children=[];this.isConnected=true;this.textContent='';this.hidden=false;this.classes=new Set();this.classList={add:(...xs)=>xs.forEach(x=>this.classes.add(x)),remove:(...xs)=>xs.forEach(x=>this.classes.delete(x)),contains:x=>this.classes.has(x)};this.style={setProperty:(k,v)=>this.style[k]=v,removeProperty:k=>delete this.style[k]};this.nodes=new Map();}
 setAttribute(k,v){this.attributes.set(k,String(v));}getAttribute(k){return this.attributes.get(k);}hasAttribute(k){return this.attributes.has(k);}
 append(node){this.children.push(node);}remove(){this.isConnected=false;}focus(){this.focused=true;}
 querySelector(selector){if(!this.nodes.has(selector))this.nodes.set(selector,new Element(selector.includes('toggle')?'button':'div'));return this.nodes.get(selector);}
 matches(selector){return selector==='button'?this.tag==='button':selector==='input[type="range"]'?this.tag==='range':false;}
 closest(selector){return this.matches(selector)?this:null;}
 getAnimations(){return[];}animate(frames,options){this.lastAnimation={frames,options};return{id:'',cancel(){}};}
}
class Document extends EventTarget{
 constructor(){super();this.body=new Element('body');this.app=new Element();this.hidden=false;this.ranges=[];}
 createElement(tag){return new Element(tag);}
 querySelector(selector){return selector==='#app'?this.app:null;}
 querySelectorAll(selector){return selector==='input[type="range"]'?this.ranges:[];}
}
function send(target,type,source,extra={}){const event=new Event(type);Object.defineProperty(event,'target',{value:source});for(const [key,value]of Object.entries(extra))Object.defineProperty(event,key,{value});target.dispatchEvent(event);}
const running=(id='live',extra={})=>({id,kind:'image-api',projectId:'p',status:'running',name:'真实样本任务',createdAt:'2026-10-02T00:00:00Z',...extra});
async function setup(t,{records=[],projectId='p'}={}){
 const globals=['document','window','innerWidth','matchMedia','MutationObserver','requestAnimationFrame','fetch','setTimeout','clearTimeout'],saved=new Map(globals.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)])),originalNow=Date.now;
 const document=new Document(),window=new EventTarget(),timers=new Map(),calls=[];let now=10000,next=0,fail=false,current=records,scope=projectId;
 const set=(key,value)=>Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
 set('document',document);set('window',window);set('innerWidth',1100);set('matchMedia',()=>({matches:true}));set('MutationObserver',class{observe(){}});set('requestAnimationFrame',callback=>{callback();return 1;});
 set('setTimeout',(callback,delay=0)=>{const id=++next;timers.set(id,{callback,due:now+delay});return id;});set('clearTimeout',id=>timers.delete(id));Date.now=()=>now;
 set('fetch',async(url,options)=>{calls.push({url,options});if(fail)throw Error('本机暂不可达');const value=url.startsWith('/api/jobs/')?current.find(job=>job.id===url.split('/').at(-1)):current;return{ok:!!value,json:async()=>structuredClone(value)};});
 const module=await import('../public/task-motion.js?controller-test='+Math.random()),controller=module.installTaskMotion({getProjectId:()=>scope}),root=document.body.children[0];
 const flush=async()=>{for(let i=0;i<6;i++)await Promise.resolve();await realDelay(0);};
 await flush();
 async function advance(ms){now+=ms;for(let i=0;i<20;i++){const ready=[...timers].filter(([,item])=>item.due<=now).sort((a,b)=>a[1].due-b[1].due);if(!ready.length)break;for(const [id,item]of ready){timers.delete(id);item.callback();}await flush();}}
 t.after(()=>{controller.dispose();Date.now=originalNow;for(const [key,descriptor]of saved)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];});
 return{module,controller,root,document,window,calls,flush,advance,setRecords:value=>current=value,setFail:value=>fail=value,setScope:value=>scope=value};
}

test('首次安装可发现任务，第二次刷新继续工作；所有请求仅本机GET且无请求体',async t=>{
 const f=await setup(t,{records:[running()]});assert.equal(f.calls.length,1);assert.equal(f.root.dataset.status,'running');assert.equal(f.root.dataset.active,'true');
 await f.controller.refresh();assert.equal(f.calls.length,2);
 for(const call of f.calls){assert.ok(call.url.startsWith('/api/jobs'));assert.equal(call.options.method,undefined);assert.equal(call.options.body,undefined);assert.ok(call.url.includes('includeActive=true'));}
});
test('重复快照合并轮询，隐藏页面保持降频，不按350ms读取整份任务列表',async t=>{
 const f=await setup(t,{records:[running()]});
 for(let i=0;i<5;i++){f.module.publishTaskSnapshot(running('live',{progress:i*10}));await f.advance(350);}
 assert.ok(f.calls.length<=2,'Repeated page snapshots must not trigger a read every 350ms');
 f.document.hidden=true;f.document.dispatchEvent(new Event('visibilitychange'));const before=f.calls.length;
 for(let i=0;i<8;i++){f.module.publishTaskSnapshot(running('live',{message:'状态'+i}));await f.advance(350);}
 assert.equal(f.calls.length,before);
});
test('用户看过历史终态后，新活动任务仍在头部显示，不被已完成状态遮住',async t=>{
 const old=running('old',{status:'completed'}),f=await setup(t,{records:[old]});const choice=new Element('button');choice.dataset.islandJob='old';send(f.root,'click',choice);
 f.setRecords([running('new'),old]);f.module.publishTaskSnapshot(running('new'));await f.advance(1000);
 assert.equal(f.root.dataset.status,'running');assert.equal(f.root.dataset.active,'true');
});
test('网络错误保留上次运行状态并标注待确认，不推断成功或失败',async t=>{
 const f=await setup(t,{records:[running()]});f.setFail(true);await f.controller.refresh();assert.equal(f.root.dataset.status,'running');assert.equal(f.root.dataset.tone,'warning');assert.match(f.root.querySelector('.task-island-body').innerHTML,/暂时无法确认/);
});
test('列表窗口缺失时按已观察任务编号续查，跨项目响应不混入新范围',async t=>{
 const f=await setup(t,{records:[running()]});f.setRecords([]);await f.controller.refresh();assert.ok(f.calls.some(call=>call.url==='/api/jobs/live'));assert.equal(f.root.dataset.status,'running');assert.equal(f.root.dataset.tone,'warning');
 f.setScope('other');f.setRecords([running('other',{projectId:'other',status:'completed'})]);await f.controller.refresh();assert.equal(f.root.dataset.status,'completed');assert.match(f.calls.at(-1).url,/projectId=other/);
});
test('事件仅包含展示状态，原始任务输入与授权秘密不会广播',async t=>{
 const f=await setup(t),seen=[];f.document.addEventListener('jingchang:task-snapshot',event=>seen.push(event.detail));
 f.module.publishTaskSnapshot(running('safe',{input:{apiKey:'synthetic-private-input'},authorization:{apiKey:'synthetic-private-authorization'},snapshot:{private:'synthetic-private-snapshot'}}));
 assert.equal(seen.length,1);assert.doesNotMatch(JSON.stringify(seen),/synthetic-private|apiKey|authorization|snapshot/);
 f.module.publishTaskSnapshot({id:'project',kind:'project',name:'普通项目'});assert.equal(seen.length,1);
});
test('拖动滑条仅更新视觉与按压反馈，原值及按钮transform保持不变',async t=>{
 const f=await setup(t),range=new Element('range');range.min='0';range.max='20';range.value='8';send(f.document,'pointerdown',range);assert.ok(range.classes.has('is-range-dragging'));assert.equal(range.style['--range-progress'],'40%');assert.equal(range.value,'8');
 send(f.document,'pointerup',range);assert.ok(!range.classes.has('is-range-dragging'));assert.equal(range.value,'8');
 const button=new Element('button');button.style.transform='translateX(-50%)';send(f.document,'pointerdown',button);send(f.document,'pointerup',button);assert.equal(button.style.transform,'translateX(-50%)');
});

test('任务详情忽略云端占位百分比，只呈现明确单位或未知进度',()=>{
 const cloud=taskProgressMarkup(running('cloud',{progress:20}));assert.match(cloud,/data-indeterminate="true"/);assert.doesNotMatch(cloud,/20%|aria-valuenow/);assert.match(cloud,/进度不可估算/);
 const measured=taskProgressMarkup(running('canvas',{kind:'canvas-run',steps:[{status:'completed'},{status:'running'}]}));assert.match(measured,/aria-valuemax="2" aria-valuenow="1"/);assert.match(measured,/1 \/ 2 步/);
 const partial=taskProgressMarkup(running('partial',{status:'incomplete',progress:100}));assert.match(partial,/未完整完成/);assert.doesNotMatch(partial,/100%|已完成|role="progressbar"/);
});

test('任务详情的可选元素编号经过转义，不产生额外标签',()=>{
 const html=taskProgressMarkup(running(),undefined,'bad"><img src=x>');assert.doesNotMatch(html,/<img/);assert.match(html,/&quot;&gt;&lt;img/);
});
