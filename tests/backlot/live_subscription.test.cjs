const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../../backlot/ui/lib.js'),'utf8').replace(/^export /gm,'');
function fixture(){
 const timers=new Map();let next=0,calls=0;
 class Feed{constructor(url){this.url=url;this.closed=false;}close(){this.closed=true;}}
 const context=vm.createContext({EventSource:Feed,Map,JSON,Number,String,setTimeout:fn=>{timers.set(++next,fn);return next;},clearTimeout:id=>timers.delete(id)});
 vm.runInContext(source+';globalThis.start=subscribe;',context);
 const feed=context.start('/events',()=>{calls++;});
 return{feed,send:data=>feed.onmessage({data:JSON.stringify(data)}),tick:()=>{const pending=[...timers.values()];timers.clear();pending.forEach(fn=>fn());},get calls(){return calls;}};
}
test('opening or reconnecting refreshes the latest snapshot without waiting for an edit',()=>{
 const f=fixture();f.feed.onopen?.();f.send({type:'hello'});f.tick();assert.equal(f.calls,1);
 f.feed.onerror?.();f.feed.onopen?.();f.send({type:'hello'});f.tick();assert.equal(f.calls,2);
});
test('reconnect clears server revisions so a restarted server can begin at one',()=>{
 const f=fixture();f.send({type:'change',project_id:'film',revision:120});f.tick();assert.equal(f.calls,1);
 f.feed.onopen?.();f.send({type:'hello'});f.tick();const before=f.calls;
 f.send({type:'change',project_id:'film',revision:1});f.tick();assert.equal(f.calls,before+1);
});
test('per-project revisions reject duplicates and debounce a burst',()=>{
 const f=fixture();f.send({type:'change',project_id:'film',revision:9});f.send({type:'change',project_id:'film',revision:8});f.send({type:'change',project_id:'other',revision:1});f.tick();assert.equal(f.calls,1);
 f.send({type:'change',project_id:'film',revision:9});f.tick();assert.equal(f.calls,1);
});
test('older feeds without a revision still trigger refresh',()=>{const f=fixture();f.send({type:'change',project_id:'film',revision:null});f.tick();assert.equal(f.calls,1);});
test('closing the feed cancels pending refresh work',()=>{const f=fixture();f.send({type:'change',project_id:'film',revision:1});f.feed.close();f.tick();assert.equal(f.calls,0);assert.equal(f.feed.closed,true);});
