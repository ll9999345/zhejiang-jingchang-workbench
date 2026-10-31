import test from 'node:test';
import assert from 'node:assert/strict';
import {libraryBackupPanel} from '../public/library-backups.js';
import {nativeLibraryImportPanel} from '../public/native-library-import.js';

// Minimal disconnected DOM and controlled fetch/timers. These tests exercise
// the real panel handlers and redraws without a browser, socket or file copy.
class Element {
 constructor(tag,attrs='',root=null){this.tagName=tag;this.root=root;this.attr=new Map();this.dataset={};this.listeners=new Map();this.files=[];this.disabled=false;this.textContent='';for(const m of attrs.matchAll(/([^\s=/>]+)(?:="([^"]*)"|'([^']*)'|=([^\s>]+))?/g)){const key=m[1],value=m[2]??m[3]??m[4]??'';this.attr.set(key,value);if(key.startsWith('data-'))this.dataset[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=value;}this.disabled=this.attr.has('disabled');this.value=this.attr.get('value')||'';this.type=this.attr.get('type')||'';}
 get attributes(){return [...this.attr].map(([name,value])=>({name,value}));}
 getAttribute(key){return this.attr.get(key)??null;}
 closest(tag){return tag===this.tagName?this:null;}
 addEventListener(type,callback){this.listeners.set(type,callback);}
 fire(type){this.listeners.get(type)?.({target:this});this['on'+type]?.({target:this});}
 focus(){} setSelectionRange(){} scrollIntoView(){}
 append(value){if(typeof value==='string'){this.textContent+=value;return;}value.root=this.root;this.root?.elements.push(value);}
 remove(){if(this.root)this.root.elements=this.root.elements.filter(e=>e!==this);}
}
const matches=(element,selector)=>{if(selector.startsWith('#'))return element.getAttribute('id')===selector.slice(1);if(selector.startsWith('[')){const m=selector.match(/^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/);return !!m&&element.attr.has(m[1])&&(m[2]===undefined||element.getAttribute(m[1])===m[2]);}return element.tagName===selector;};
class Root {
 isConnected=true;elements=[];renders=0;
 set innerHTML(value){this.html=value;this.renders++;this.elements=[...value.matchAll(/<(button|input|details|article|progress|p)\b([^>]*)>/g)].map(m=>new Element(m[1],m[2],this));}
 get innerHTML(){return this.html;}
 contains(element){return element?.root===this&&this.elements.includes(element);}
 querySelector(selector){return this.elements.find(e=>matches(e,selector))||null;}
 querySelectorAll(selector){return this.elements.filter(e=>selector.split(',').some(s=>matches(e,s.trim())));}
 click(selector){const button=typeof selector==='string'?this.querySelector(selector):selector;assert(button,'expected test control');this.onclick({target:button,stopPropagation(){}});}
}
const response=value=>({ok:true,status:200,headers:new Headers({'x-jingchang-media-session':'1;smart=0'}),json:async()=>structuredClone(value)});
async function flush(predicate=()=>true){for(let i=0;i<80;i++){await Promise.resolve();if(i>8&&predicate())return;}assert(predicate(),'panel operation did not settle');}
function harness(t){
 const originals=new Map(),calls=[],timers=new Set(),xhrs=[],busy=[];let route;
 const install=(key,value)=>{originals.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});};
 install('document',{activeElement:null,body:{},createElement:tag=>new Element(tag)});install('CSS',{escape:String});install('DataTransfer',undefined);
 install('fetch',async(url,options={})=>{if(url==='/api/health')return response({ok:true,nativeMediaSession:{version:1,storedMedia:false},capabilities:{smartGroupStoredMedia:false}});calls.push({url,method:options.method||'GET',payload:options.body?JSON.parse(options.body):undefined});assert.equal(new Headers(options.headers).get('x-jingchang-media-session'),'1;smart=0');return route(url,options);});
 install('setTimeout',(callback,delay)=>{const timer={callback,delay};timers.add(timer);return timer;});install('clearTimeout',timer=>timers.delete(timer));
 class XHR {constructor(){this.upload={};}open(method,url){this.method=method;this.url=url;}setRequestHeader(){}send(file){this.file=file;xhrs.push(this);}abort(){this.aborted=true;this.onabort?.();}}
 install('XMLHttpRequest',XHR);
 t.after(()=>{for(const [key,descriptor]of originals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}});
 return{calls,timers,xhrs,busy,setRoute:fn=>{route=fn;},runPoll(){const timer=[...timers].find(timer=>timer.delay===1000);assert(timer,'expected a real panel poll');timers.delete(timer);timer.callback();}};
}
const projectId='panel-lock-project',running={id:'own-running',kind:'library-backup',name:'synthetic backup',status:'running',message:'pending'};
const checked={id:'checked-original',status:'checked',libraries:1,folders:1,items:1,bytes:1,canvases:0,fragments:0,workflows:0,archivedLibraries:0,libraryNames:[]};
function backupRoute(g,{jobs=[],imports=[]}={}){g.setRoute(async url=>{if(url==='/api/asset-library-backups?projectId='+projectId)return response(jobs);if(url==='/api/asset-library-backups/imports?projectId='+projectId)return response(imports);throw Error('unexpected route '+url);});}

test('初次备份记录未读完立即报告busy，成功读取空记录后才解除',async t=>{
 const g=harness(t),pending=[];g.setRoute(()=>new Promise(resolve=>pending.push(resolve)));const panel=libraryBackupPanel({projectId,onBusy:value=>g.busy.push(value)});t.after(()=>panel.dispose());const root=new Root();panel.mount(root);
 assert.deepEqual(g.busy,[true]);assert.equal(root.querySelector('[data-library-backup=export]').disabled,true);await flush(()=>g.calls.length===2);assert.equal(g.calls.length,2);
 for(const resolve of pending)resolve(response([]));await flush(()=>g.busy.at(-1)===false);assert.equal(root.querySelector('[data-library-backup=export]').disabled,false);assert.equal(g.calls.filter(c=>c.method==='POST').length,0);
});
test('真实fetch轮询重绘后foreign锁持续阻止新备份和恢复POST，包括强制调用旧点击入口',async t=>{
 const g=harness(t);backupRoute(g,{jobs:[running],imports:[checked]});let blocked=false;const panel=libraryBackupPanel({projectId,isBlocked:()=>blocked});t.after(()=>panel.dispose());const root=new Root();panel.mount(root);await flush(()=>g.timers.size>0);const before=root.renders;
 blocked=true;g.runPoll();await flush(()=>root.renders>before);assert.equal(g.calls.length,4);assert.equal(root.querySelector('[data-library-backup=export]').disabled,true);assert.equal(root.querySelector('[data-library-restore=checked-original]').disabled,true);
 root.click('[data-library-backup=export]');root.click('[data-library-restore=checked-original]');await flush();assert.equal(g.calls.filter(c=>c.method==='POST').length,0);
});
test('native自己已有等待时foreign锁保留stop，停止只abort本次请求且不补发POST',async t=>{
 const g=harness(t);let previewSignal,blocked=false;
 g.setRoute(async(url,options)=>{if(url==='/api/native-library-imports?projectId='+projectId)return response({items:[],issues:[]});if(url==='/api/native-library-imports/preview'){previewSignal=options.signal;return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('synthetic stopped','AbortError')),{once:true}));}throw Error('unexpected route '+url);});
 const panel=nativeLibraryImportPanel({projectId,isBlocked:()=>blocked,onBusy:value=>g.busy.push(value)});t.after(()=>panel.dispose());const root=new Root();panel.mount(root);await flush(()=>g.busy.at(-1)===false);const input=root.querySelector('[data-native-library=source]');input.value='/tmp/synthetic-canvas';input.fire('input');root.click('[data-native-library=preview]');await flush(()=>!!previewSignal);
 blocked=true;panel.refresh();const stop=root.querySelector('[data-native-library=stop]');assert(stop);assert.equal(stop.disabled,false);root.click(stop);await flush(()=>g.busy.at(-1)===false);assert.equal(previewSignal.aborted,true);assert.equal(g.calls.filter(c=>c.method==='POST').length,1);
});
test('自己的整库上传stop-upload不会被foreign锁屏蔽，abort保留接收记录且不重新发送',async t=>{
 const g=harness(t);backupRoute(g);let blocked=false;const panel=libraryBackupPanel({projectId,isBlocked:()=>blocked,onBusy:value=>g.busy.push(value)});t.after(()=>panel.dispose());const root=new Root();panel.mount(root);await flush(()=>g.busy.at(-1)===false);const input=root.querySelector('#library-backup-file');input.files=[{name:'synthetic.jingchang-library',size:64}];input.fire('change');root.click('[data-library-backup=upload]');await flush(()=>g.xhrs.length===1);
 blocked=true;panel.refresh();const stop=root.querySelector('[data-library-backup=stop-upload]');assert(stop);assert.equal(stop.disabled,false);root.click(stop);await flush(()=>g.busy.at(-1)===false);assert.equal(g.xhrs[0].aborted,true);assert.equal(g.xhrs.length,1);assert.match(root.innerHTML,/收到的副本保留/);
});
test('自己的运行中备份任务cancel在foreign锁下仍可停止，零新建或恢复POST',async t=>{
 const g=harness(t);let jobs=[running];g.setRoute(async url=>{if(url==='/api/asset-library-backups?projectId='+projectId)return response(jobs);if(url==='/api/asset-library-backups/imports?projectId='+projectId)return response([]);if(url==='/api/asset-library-backups/own-running/cancel'){jobs=[{...running,status:'cancelled'}];return response({ok:true});}throw Error('unexpected route '+url);});
 const panel=libraryBackupPanel({projectId,isBlocked:()=>true,onBusy:value=>g.busy.push(value)});t.after(()=>panel.dispose());const root=new Root();panel.mount(root);await flush(()=>!!root.querySelector('[data-library-cancel=own-running]'));const stop=root.querySelector('[data-library-cancel=own-running]');assert.equal(stop.disabled,false);root.click(stop);await flush(()=>g.calls.some(c=>c.method==='POST'));
 await flush(()=>g.busy.at(-1)===false&&!root.querySelector('[data-library-cancel=own-running]'));await flush();
 assert.deepEqual(g.calls.filter(c=>c.method==='POST').map(c=>({url:c.url,payload:c.payload})),[{url:'/api/asset-library-backups/own-running/cancel',payload:{projectId}}]);
});
