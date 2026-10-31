import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installExchangeSaveGuard} from '../public/exchange-save-guard.js';
function fixture({referrer='http://127.0.0.1:4750/canvas?project=test',editing=false,save=async()=>{}}={}){
 const replies=[],listeners=new Map();let calls=0,project={id:'current'};
 const parent={postMessage:(message,origin)=>replies.push({message,origin})};
 const win={parent,document:{referrer},addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
 const dispose=installExchangeSaveGuard({win,getProject:()=>project,isEditing:()=>editing,save:async()=>{calls++;await save();}});
 const send=(override={})=>listeners.get('message')?.({source:parent,origin:'http://127.0.0.1:4750',data:{type:'jingchang:prepare-exchange',requestId:'request',projectId:'current'},...override});
 return{replies,send,dispose,listeners,get calls(){return calls;},setProject:value=>{project=value;}};
}
test('only the actual local embedding parent may request a save',async()=>{
 const f=fixture();await f.send({origin:'https://example.com'});await f.send({source:{}});await f.send({data:{type:'other'}});assert.equal(f.calls,0);assert.deepEqual(f.replies,[]);
 await f.send();assert.equal(f.calls,1);assert.deepEqual(f.replies,[{message:{type:'jingchang:exchange-ready',requestId:'request',projectId:'current',ok:true},origin:'http://127.0.0.1:4750'}]);f.dispose();assert.equal(f.listeners.size,0);
});
test('remote or missing referrers never install a save channel',()=>{for(const referrer of ['','https://127.0.0.1:4750/','http://example.com/'])assert.equal(fixture({referrer}).listeners.size,0);});
test('an editing dialog or switched project blocks exchange before saving',async()=>{
 const f=fixture({editing:true});await f.send();assert.equal(f.calls,0);assert.match(f.replies[0].message.error,/编辑窗口/);
 const g=fixture();g.setProject({id:'other'});await g.send();assert.equal(g.calls,0);assert.equal(g.replies[0].message.ok,false);
});
test('save receipt waits for the real save and rejects parallel requests',async()=>{
 let finish;const f=fixture({save:()=>new Promise(r=>{finish=r;})});const pending=f.send();assert.equal(f.replies.length,0);await f.send();assert.equal(f.calls,1);assert.equal(f.replies[0].message.ok,false);finish();await pending;assert.equal(f.replies[1].message.ok,true);
});
test('failed saves retain the error and allow a later successful attempt',async()=>{
 let fail=true;const f=fixture({save:async()=>{if(fail)throw Error('项目已在另一窗口更新');}});await f.send();assert.equal(f.replies[0].message.ok,false);assert.match(f.replies[0].message.error,/另一窗口/);fail=false;await f.send();assert.equal(f.replies[1].message.ok,true);
});
test('switching projects during save cannot acknowledge the old project',async()=>{
 let f;f=fixture({save:async()=>{f.setProject({id:'other'});}});await f.send();assert.equal(f.replies[0].message.ok,false);
});
