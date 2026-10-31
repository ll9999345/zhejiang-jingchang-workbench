const test = require('node:test');
const assert = require('node:assert/strict');
const batch = require('../../backlot/ui/footage-batch.js');

test('JSON and JSONL manifests preserve per-item network authorization and project ownership', () => {
  const requests=[{project_id:'first',topic:'甲',confirm_network:false},{project_id:'second',confirm_network:true}];
  assert.deepEqual(batch.parseBatchManifest(JSON.stringify(requests)), requests);
  assert.deepEqual(batch.parseBatchManifest('\uFEFF'+requests.map(item=>JSON.stringify(item)).join('\n\n')), requests);
  assert.throws(()=>batch.parseBatchManifest('null'),/JSON 对象/);
  assert.throws(()=>batch.parseBatchManifest('[{}]\n{}'),/格式/);
  assert.throws(()=>batch.parseBatchManifest(JSON.stringify(Array(101).fill({}))),/1–100/);
  assert.throws(()=>batch.parseBatchManifest('中'.repeat(400000)),/1 MiB/);
  assert.throws(()=>batch.parseBatchManifest('{}\nbad'),/第 2 行/);
});

test('batch execution requires an unchanged preflight and a separate explicit confirmation', () => {
  const requests=[{project_id:'demo',confirm_network:false}];
  const state={requests, checkedFingerprint:JSON.stringify(requests), ready:true, confirmed:true, active:false};
  assert.equal(batch.batchCanSubmit(state), true);
  for(const override of [{confirmed:false},{ready:false},{active:true},{requests:[{project_id:'other'}]}]) assert.equal(batch.batchCanSubmit({...state,...override}),false);
  const template=batch.parseBatchManifest(batch.batchTemplate({...requests[0],request_id:'old',confirm_network:true}));
  assert.equal(template[0].confirm_network,false);
  assert.equal(template[0].request_id,undefined);
});

test('batch UI initializes and preflights without submitting; editing revokes confirmation', async () => {
  const calls=[];
  class Node {
    constructor(){this.value='';this.checked=false;this.disabled=false;this.handlers={};this.children=[];}
    addEventListener(name, handler){this.handlers[name]=handler;}
    replaceChildren(...children){this.children=children;}
    append(...children){this.children.push(...children);}
    appendChild(child){this.children.push(child);}
  }
  const nodes={};
  const previous={document:global.document,fetch:global.fetch,Option:global.Option};
  global.document={getElementById:id=>nodes[id]||(nodes[id]=new Node()),createElement:()=>new Node(),createTextNode:text=>({textContent:text})};
  global.Option=class extends Node {constructor(label,value){super();this.textContent=label;this.value=value;}};
  global.fetch=async(url,options={})=>{calls.push({url,body:options.body&&JSON.parse(options.body)});return {ok:true,json:async()=>url.endsWith('/preflight')?{ready:true,items:[{index:0,project_id:'demo',ready:true,topic:'甲',network_required:false,plan:{stop_at:'audio'}}],errors:[]}:{batches:[]}};};
  try {
    await batch.initBatchUI({projectId:'demo',getCurrentRequest:()=>({project_id:'demo'})});
    assert.equal(calls.length,1);assert.equal(calls[0].body,undefined);
    nodes.batchManifest.value=JSON.stringify([{project_id:'demo',topic:'甲',confirm_network:false}]);
    await nodes.batchManifest.handlers.input();
    await nodes.batchPreflightButton.handlers.click();
    assert.equal(calls.length,2);assert.equal(calls[1].body.requests[0].confirm_network,false);
    assert.equal(nodes.batchSubmitButton.disabled,true);
    nodes.batchConfirm.checked=true;nodes.batchConfirm.handlers.change();
    assert.equal(nodes.batchSubmitButton.disabled,false);
    nodes.batchManifest.value=JSON.stringify([{project_id:'demo',topic:'改了'}]);nodes.batchManifest.handlers.input();
    assert.equal(nodes.batchConfirm.checked,false);assert.equal(nodes.batchSubmitButton.disabled,true);
    await nodes.batchSubmitButton.handlers.click();assert.equal(calls.length,2);
  } finally {global.document=previous.document;global.fetch=previous.fetch;global.Option=previous.Option;}
});

test('confirmed batches submit once and cancel under the owner returned by the receipt', async () => {
  const calls=[];
  class Node {
    constructor(){this.value='';this.checked=false;this.handlers={};this.children=[];}
    addEventListener(name, handler){this.handlers[name]=handler;}
    replaceChildren(...children){this.children=children;}
    append(...children){this.children.push(...children);}
  }
  const nodes={};
  const previous={document:global.document,fetch:global.fetch,Option:global.Option,setTimeout:global.setTimeout};
  global.document={getElementById:id=>nodes[id]||(nodes[id]=new Node()),createElement:()=>new Node(),createTextNode:text=>({textContent:text})};
  global.Option=class extends Node {constructor(label,value){super();this.textContent=label;this.value=value;}};
  global.setTimeout=()=>0;
  global.fetch=async(url,options={})=>{
    const body=options.body&&JSON.parse(options.body);calls.push({url,body});
    const receipt={batch_id:'batch-1',project_id:'owner',status:url.endsWith('/cancel')?'cancelled':'queued',items:[],progress:0,message:''};
    const value=url.endsWith('/preflight')?{ready:true,items:[],errors:[]}:body&&url.endsWith('/batches')||url.endsWith('/cancel')?receipt:{batches:[]};
    return {ok:true,json:async()=>value};
  };
  try {
    await batch.initBatchUI({projectId:'current',getCurrentRequest:()=>({project_id:'current'})});
    nodes.batchManifest.value=JSON.stringify([{project_id:'owner',confirm_network:false},{project_id:'current',confirm_network:true}]);
    await nodes.batchPreflightButton.handlers.click();
    await nodes.batchSubmitButton.handlers.click();assert.equal(calls.filter(call=>call.body?.confirm).length,0);
    nodes.batchConfirm.checked=true;nodes.batchConfirm.handlers.change();
    await nodes.batchSubmitButton.handlers.click();
    await nodes.batchSubmitButton.handlers.click();
    const submitted=calls.filter(call=>call.body?.confirm);
    assert.equal(submitted.length,1);assert.equal(submitted[0].body.requests[1].confirm_network,true);
    assert.equal(nodes.batchCancelButton.hidden,false);
    await nodes.batchCancelButton.handlers.click();
    assert.deepEqual(calls.find(call=>call.url.endsWith('/cancel')).body,{project_id:'owner'});
    assert.equal(nodes.batchCancelButton.hidden,true);
  } finally {global.document=previous.document;global.fetch=previous.fetch;global.Option=previous.Option;global.setTimeout=previous.setTimeout;}
});
