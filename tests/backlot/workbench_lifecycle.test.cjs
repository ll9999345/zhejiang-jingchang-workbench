const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ui = path.join(__dirname, '../../backlot/ui');
const model = fs.readFileSync(path.join(ui, 'model.js'), 'utf8');
const native = fs.readFileSync(path.join(ui, 'montage-studio.js'), 'utf8');
const presentation = fs.readFileSync(path.join(ui, 'workbench-interactions.js'), 'utf8');
function fragment(source, start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing source boundary: ${start} / ${end}`);
  return source.slice(from, to);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
function element() {
  return {
    disabled: false, textContent: '', dataset: {}, attributes: {}, handlers: {},
    classList: {add(){}, toggle(){}},
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); },
    emit(type, event = {}) { return Promise.all((this.handlers[type] || []).map(fn => fn(event))); },
  };
}
function motionFixture() {
  const c = vm.createContext({window:{}});
  vm.runInContext(presentation, c);
  return c.window.WorkbenchInteractions;
}
function statePresenter(states) {
  return {...motionFixture(), setState(button, state, {label} = {}) {
    if (!button) return;
    states.push([button, state]); button.dataset.taskState = state;
    if (label != null) button.textContent = label;
  }};
}
function paidFixture(mode = 'quality') {
  const states = [], statuses = [], requests = [], receipts = [], timers = [];
  const fields = Object.fromEntries(['preparePaid','qualityPreparePaid','confirmSubmit','confirmForm','confirmText','queryTask','cancelTask','heartbeatDetail','qualityReviewBadge','qualityReviewStatus'].map(id => [id, element()]));
  const dialog = {...element(), open:false, showModal(){this.open=true;}, close(){this.open=false; void this.emit('close');}};
  const c = vm.createContext({
    ...fields, dialog,
    workflow:{mode,stage:2,draftId:'project-a',storyboardApproved:true,qualityVideoEstimateReady:true},
    lastEstimate:{valid:true,within_max_cost:true}, pendingConfirmation:null,
    currentTaskId:null, batchId:null, batchTaskIds:[], heartbeatBusy:false, heartbeatAttempts:0,
    window:{WorkbenchInteractions:statePresenter(states),confirm:()=>true},
    sessionStorage:{removeItem(){}},
    setStatus:(...args)=>statuses.push(args), syncQualityVideoControls(){}, paidPayload:()=>({project_id:'project-a'}),
    postJSON:async (url, body)=>{ requests.push([url,body]); return c.response(url,body); },
    response:async ()=>{throw new Error('Unexpected fixture request');},
    stopHeartbeat:()=>timers.push('stop'), setQualityStage(){}, setWorkflowStep(){}, statusLabel:s=>s,
    showTask:data=>{ receipts.push(data); c.currentTaskId=data.task_id; c.updatePaidReceipt(data); },
    showBatchTask:data=>{ receipts.push(data); c.batchId=data.batch_id; c.batchTaskIds=data.task_ids || c.batchTaskIds; c.currentTaskId=data.task_id || c.batchTaskIds[0]; c.updatePaidReceipt(data); },
    startHeartbeat:data=>timers.push(['single',data]), startBatchHeartbeat:data=>timers.push(['batch',data]),
  });
  vm.runInContext(fragment(model, 'const SUCCESS_STATUSES =', 'const ENTRY_MODE_CONFIG ='), c);
  vm.runInContext(fragment(model, 'async function refreshTask(', 'function startHeartbeat('), c);
  vm.runInContext(fragment(model, 'async function refreshBatch(', 'function startBatchHeartbeat('), c);
  vm.runInContext(fragment(model, 'async function preparePaidFlow(', 'refreshMediaCapabilitiesButton?.addEventListener'), c);
  const run = code => vm.runInContext(code, c);
  const submit = (value = 'confirm') => fields.confirmForm.emit('submit', {submitter:{value},preventDefault(){}});
  return {c,fields,dialog,states,statuses,requests,receipts,timers,run,submit};
}
async function prepare(f) {
  f.c.response = async () => ({confirmation_id:'confirmation-a',estimated_cost_cny:1,expires_in_seconds:60});
  await f.c.preparePaidFlow();
  assert.equal(f.run('paidPhase'), 'confirming');
}

test('paid preparation rejects duplicate calls and stays awaiting explicit confirmation', async () => {
  const f=paidFixture(), pending=deferred(); f.c.response=()=>pending.promise;
  const first=f.c.preparePaidFlow(); await f.c.preparePaidFlow();
  assert.equal(f.requests.length,1); assert.equal(f.run('paidPhase'),'preparing');
  assert.equal(f.fields.preparePaid.disabled,true); assert.equal(f.fields.qualityPreparePaid.disabled,true);
  pending.resolve({confirmation_id:'c',estimated_cost_cny:1,expires_in_seconds:60}); await first;
  assert.equal(f.run('paidPhase'),'confirming'); assert.equal(f.dialog.open,true);
  assert.equal(f.fields.qualityPreparePaid.disabled,true); assert.equal(f.fields.confirmSubmit.disabled,false);
  assert.ok(f.states.every(([,state])=>state!=='succeeded'));
});

test('dismissing paid confirmation clears its ID and restores only approved entry gates', async () => {
  const f=paidFixture(); await prepare(f); f.c.workflow.qualityVideoEstimateReady=false; f.dialog.close();
  assert.equal(f.c.pendingConfirmation,null); assert.equal(f.run('paidPhase'),'idle');
  assert.equal(f.fields.preparePaid.disabled,true); assert.equal(f.fields.qualityPreparePaid.disabled,true);
  f.c.workflow.qualityVideoEstimateReady=true; f.c.syncPaidButtons();
  assert.equal(f.fields.qualityPreparePaid.disabled,false);
  await f.submit(); assert.equal(f.requests.length,1,'dismissed confirmation cannot submit');
});

for (const mode of ['quality','speed']) {
  test(`${mode} paid submission is single-flight and accepted receipts remain queued`, async () => {
    const f=paidFixture(mode); await prepare(f); const pending=deferred(); f.c.response=()=>pending.promise;
    const first=f.submit(); await f.submit();
    assert.equal(f.requests.length,2); assert.equal(f.run('paidPhase'),'submitting');
    assert.equal(f.fields.confirmSubmit.disabled,true);
    const receipt=mode==='quality'?{batch_id:'b',task_ids:['a','b'],status:'queued'}:{task_id:'a',status:'queued'};
    pending.resolve(receipt); await first;
    assert.equal(f.requests[1][0],mode==='quality'?'/model-api/paid/submit-batch':'/model-api/paid/submit');
    assert.equal(f.run('paidPhase'),'queued'); assert.equal(f.dialog.open,false);
    assert.equal(f.fields.preparePaid.disabled,true); assert.equal(f.fields.qualityPreparePaid.disabled,true);
    assert.ok(f.states.every(([,state])=>state!=='succeeded'));
  });
}

test('Escape and the dismiss button cannot cancel a submission already sent', async () => {
  const f=paidFixture(); await prepare(f); const pending=deferred(); f.c.response=()=>pending.promise;
  const sending=f.submit(); let escapePrevented=false, dismissPrevented=false;
  await f.dialog.emit('cancel',{preventDefault(){escapePrevented=true;}});
  await f.fields.confirmForm.emit('submit',{submitter:{value:'cancel'},preventDefault(){dismissPrevented=true;}});
  assert.equal(escapePrevented,true); assert.equal(dismissPrevented,true);
  assert.equal(f.run('paidPhase'),'submitting');
  pending.resolve({batch_id:'b',task_ids:['a'],status:'queued'}); await sending;
});

test('a stale preparation cannot reopen a dialog after its context is invalidated', async () => {
  const f=paidFixture(), pending=deferred(); f.c.response=()=>pending.promise;
  const first=f.c.preparePaidFlow(); f.c.invalidatePaidContext();
  pending.resolve({confirmation_id:'old',estimated_cost_cny:1,expires_in_seconds:60}); await first;
  assert.equal(f.dialog.open,false); assert.equal(f.c.pendingConfirmation,null); assert.equal(f.run('paidPhase'),'idle');
});

test('a stale accepted submission cannot attach its task or restart polling in a new project', async () => {
  const f=paidFixture(); await prepare(f); const pending=deferred(); f.c.response=()=>pending.promise;
  const sending=f.submit(); f.c.invalidatePaidContext(); f.c.workflow.draftId='project-b';
  f.c.currentTaskId='new-task'; f.c.setPaidPhase('running'); const timerCount=f.timers.length;
  pending.resolve({batch_id:'old-batch',task_ids:['old-task'],status:'queued'}); await sending;
  assert.equal(f.receipts.length,0); assert.equal(f.c.currentTaskId,'new-task');
  assert.equal(f.run('paidPhase'),'running'); assert.equal(f.timers.length,timerCount);
});

for (const batch of [false,true]) for (const outcome of ['success','failure']) {
  test(`stale ${batch?'batch':'single'} poll ${outcome} cannot change a newer task or release its polling lock`, async () => {
    const f=paidFixture(); f.c.currentTaskId='old'; f.c.batchId='old-batch'; f.c.batchTaskIds=batch?['old']:[];
    const pending=deferred(); f.c.response=()=>pending.promise;
    const first=batch?f.c.refreshBatch():f.c.refreshTask(); f.c.invalidatePaidContext();
    f.c.currentTaskId='new'; f.c.batchId='new-batch'; f.c.heartbeatBusy=true; f.c.setPaidPhase('running');
    const statusesBefore=f.statuses.length;
    if(outcome==='success')pending.resolve({task_id:'old',batch_id:'old-batch',status:'completed'});else pending.reject(new Error('old failure'));
    await first;
    assert.equal(f.receipts.length,0); assert.equal(f.c.currentTaskId,'new'); assert.equal(f.run('paidPhase'),'running');
    assert.equal(f.c.heartbeatBusy,true); assert.equal(f.statuses.length,statusesBefore);
  });
}

test('a transient polling error is not a generation failure or an unlocked retry', async () => {
  const f=paidFixture(); f.c.currentTaskId='a'; f.c.setPaidPhase('running');
  f.c.response=async ()=>{throw new Error('temporary transport error');}; await f.c.refreshTask();
  assert.equal(f.run('paidPhase'),'running'); assert.equal(f.fields.qualityPreparePaid.disabled,true);
  assert.match(f.fields.heartbeatDetail.textContent,/temporary transport error/);
  assert.equal(f.c.heartbeatBusy,false); assert.equal(f.timers.length,0);
});

test('accepted cancellation stays cancelling until a terminal query and never stops polling early', async () => {
  const f=paidFixture(); f.c.currentTaskId='a'; f.c.setPaidPhase('running');
  f.c.response=async url=>({task_id:'a',status:url.endsWith('/cancel')?'cancel_requested':'running'});
  await f.fields.cancelTask.emit('click');
  assert.deepEqual(f.requests.map(([url])=>url),['/model-api/paid/cancel','/model-api/paid/query']);
  assert.equal(f.run('paidPhase'),'cancelling'); assert.equal(f.fields.cancelTask.disabled,true);
  assert.equal(f.fields.qualityPreparePaid.disabled,true); assert.equal(f.timers.length,0);
  f.c.response=async ()=>({task_id:'a',status:'cancelled'}); await f.c.refreshTask(true);
  assert.equal(f.run('paidPhase'),'cancelled'); assert.equal(f.run('paidCancelPending'),false);
  assert.equal(f.fields.cancelTask.disabled,true); assert.equal(f.fields.qualityPreparePaid.disabled,false);
  assert.deepEqual(f.timers,['stop']);
});

test('receipt status cancel_requested alone is not a terminal success or cancellation', () => {
  const f=paidFixture(); f.c.updatePaidReceipt({status:'cancel_requested'});
  assert.equal(f.run('paidPhase'),'cancelling'); assert.equal(f.fields.qualityPreparePaid.disabled,true);
  assert.equal(motionFixture().isActive(f.run('paidPhase')),true);
});

test('failed paid preparation restores gates without bypassing changed approval or budget', async () => {
  const f=paidFixture(), pending=deferred(); f.c.response=()=>pending.promise;
  const first=f.c.preparePaidFlow(); f.c.workflow.storyboardApproved=false;
  pending.reject(new Error('prepare failed')); await first;
  assert.equal(f.run('paidPhase'),'failed'); assert.equal(f.fields.qualityPreparePaid.disabled,true);
  f.c.workflow.storyboardApproved=true; f.c.lastEstimate.within_max_cost=false; f.c.syncPaidButtons();
  assert.equal(f.fields.qualityPreparePaid.disabled,true);
  f.c.lastEstimate.within_max_cost=true; f.c.syncPaidButtons(); assert.equal(f.fields.qualityPreparePaid.disabled,false);
});

test('a successful quality re-estimate cannot visually unlock an active paid operation', async () => {
  for (const phase of ['preparing','confirming','submitting','queued','running','cancelling','unknown']) {
    const f=paidFixture();
    Object.assign(f.c, {
      qualityVideoEstimateButton:element(),qualityVideoBadge:element(),qualityVideoEstimateStatus:element(),qualityVideoEstimatedCost:element(),
      storyboardVideoPlan:()=>({shots:[{duration_seconds:5,image_path:'assets/shot.png'}],total:5}),
      qualityVideoPayload:()=>({project_id:'project-a'}),applyEstimateReceipt:data=>{f.c.lastEstimate=data;},
      updateQualityVideoSummary(){},syncReceiptVisibility(){},renderQualityVideoShotPlan(){},
    });
    vm.runInContext(fragment(model,'async function runQualityVideoEstimate()', 'function findVideoUrl('),f.c);
    f.c.setPaidPhase(phase);f.c.response=async()=>({valid:true,within_max_cost:true,estimated_cost_cny:1});
    await f.c.runQualityVideoEstimate();
    assert.equal(f.c.workflow.qualityVideoEstimateReady,true,'fixture must reach successful estimate branch');
    assert.equal(f.fields.qualityPreparePaid.disabled,true,`${phase} must keep its existing task lock`);
    assert.equal(f.run('paidPhase'),phase);
  }
});

test('presentation task normalization separates accepted, active, cancelled, and completed receipts', () => {
  const api=motionFixture();
  for(const state of ['queued','submitted','pending','restored'])assert.equal(api.taskState(state),'queued');
  for(const state of ['cancel_requested','cancelling'])assert.equal(api.taskState(state),'cancelling');
  for(const state of ['cancelled','canceled'])assert.equal(api.taskState(state),'cancelled');
  for(const state of ['completed','succeeded','done'])assert.equal(api.taskState(state),'succeeded');
  assert.equal(api.taskState('interrupted'),'failed'); assert.equal(api.taskState('unexpected-state'),'unknown');
});

test('presentation setState never changes disabled or makes a request', () => {
  const doc={readyState:'loading',addEventListener(){}};
  const c=vm.createContext({document:doc,window:{document:doc,matchMedia:()=>({matches:true})}});
  vm.runInContext(presentation,c); const b=element(); b.disabled=true;
  for(const state of ['ready','preparing','queued','running','cancelling','succeeded','failed','cancelled']) {
    c.window.WorkbenchInteractions.setState(b,state,{label:state}); assert.equal(b.disabled,true);
  }
});

function nativeFixture() {
  const states=[],requests=[],execute=element(),check=element(); let currentProject='a';
  const checkbox=()=>({input:{checked:false},label:{hidden:false}});
  const c=vm.createContext({window:{WorkbenchInteractions:statePresenter(states)},execute,check,
    selectedTool:{name:'example',status:'available',effects:{}},submitting:false,toolRequestRevision:0,toolJobs:new Map(),toolErrors:new Set(),
    activeJob:row=>Boolean(row&&['queued','running','cancelling'].includes(row.status)),
    getProject:()=>currentProject,project:()=>currentProject,nativeInputs:()=>({input_path:'assets/test.mp4'}),
    network:checkbox(),paid:checkbox(),capture:checkbox(),code:checkbox(),paidLimit:{hidden:false},controls:[],
    ceiling:{value:'1'},confirmed:{input:{checked:true}},status:element(),form:{append(){}},el(){},
    api:async(url,body)=>{requests.push([url,body]);return c.response(url,body);},
    response:async()=>{throw new Error('Unexpected fixture request');},refreshHistory:async()=>{},
    // The native tool's finally block also refreshes adjacent director buttons.
    // This fixture isolates tool lifecycle state, not the director UI.
    syncDirectorButtons(){},
  });
  vm.runInContext(fragment(native,'    function syncToolButton()', '    function nativeInputs()'),c);
  vm.runInContext(fragment(native,'    async function doTool(', '    async function doDirector('),c);
  const reconciliation=fragment(native,'        const newestJobs = new Map();','        const rows =');
  vm.runInContext(`function applyHistorySnapshot(jobs,id){${reconciliation}}`,c);
  return {c,execute,check,states,requests,setProject:id=>{currentProject=id;}};
}

test('native execute requires confirmation and makes no request without it',async()=>{
  const f=nativeFixture();f.c.confirmed.input.checked=false;await f.c.doTool(true);
  assert.equal(f.requests.length,0);assert.match(f.c.status.textContent,/确认/);
});
test('native execute is single-flight and a saved queued job keeps its button locked',async()=>{
  const f=nativeFixture(),pending=deferred();f.c.response=()=>pending.promise;
  const first=f.c.doTool(true);await f.c.doTool(true);assert.equal(f.requests.length,1);
  pending.resolve({job_id:'job-a',status:'queued'});await first;
  assert.equal(f.execute.dataset.taskState,'queued');assert.equal(f.execute.disabled,true);
  assert.equal(f.c.confirmed.input.checked,false);await f.c.doTool(true);assert.equal(f.requests.length,1);
});
test('native terminal receipts unlock only available tools and never override a submission lock',()=>{
  const f=nativeFixture();
  for(const [status,state] of [['completed','succeeded'],['failed','failed'],['cancelled','cancelled'],['interrupted','failed']]){
    f.c.toolJobs.set('a:example',{job_id:'j',status});f.c.syncToolButton();
    assert.equal(f.execute.dataset.taskState,state);assert.equal(f.execute.disabled,false);
  }
  f.c.selectedTool.status='unavailable';f.c.syncToolButton();assert.equal(f.execute.disabled,true);
  f.c.selectedTool.status='available';f.c.submitting=true;f.c.syncToolButton();assert.equal(f.execute.disabled,true);
});
test('native late response cannot mutate a different selected tool or project',async()=>{
  const f=nativeFixture(),pending=deferred();f.c.response=()=>pending.promise;
  const first=f.c.doTool(true);f.setProject('b');f.c.selectedTool={name:'other',status:'available',effects:{network:false}};
  pending.resolve({job_id:'old',status:'queued',effects:{network:true}});await first;
  assert.equal(f.c.selectedTool.effects.network,false);assert.equal(f.c.toolJobs.size,0);
  assert.notEqual(f.execute.dataset.taskState,'queued');assert.equal(f.execute.disabled,false);
});
test('native failed execution remains visibly failed after its finally block',async()=>{
  const f=nativeFixture();f.c.response=async()=>{throw new Error('native failed');};await f.c.doTool(true);
  assert.match(f.c.status.textContent,/native failed/);assert.equal(f.execute.dataset.taskState,'failed');
});
test('an older completed history row cannot replace a newly accepted queued native job',async()=>{
  const f=nativeFixture();f.c.response=async()=>({job_id:'new-job',status:'queued'});await f.c.doTool(true);
  f.c.applyHistorySnapshot({jobs:[{job_id:'old-job',tool:'example',status:'completed',created_at:'2026-09-01'}]},'a');
  assert.equal(f.c.toolJobs.get('a:example').job_id,'new-job');assert.equal(f.execute.disabled,true);
});
test('missing history rows do not turn an accepted native job into success',async()=>{
  const f=nativeFixture();f.c.response=async()=>({job_id:'new-job',status:'queued'});await f.c.doTool(true);
  f.c.applyHistorySnapshot({jobs:[]},'a');assert.equal(f.execute.dataset.taskState,'queued');assert.equal(f.execute.disabled,true);
});
test('matching authoritative native terminal receipt clears the accepted-job wait and unlocks execution',async()=>{
  const f=nativeFixture();f.c.response=async()=>({job_id:'new-job',status:'queued'});await f.c.doTool(true);
  f.c.applyHistorySnapshot({jobs:[{job_id:'new-job',tool:'example',status:'completed',created_at:'2026-10-01'}]},'a');
  assert.equal(f.c.toolJobs.get('a:example').job_id,'new-job');assert.equal(f.execute.dataset.taskState,'succeeded');
  assert.equal(f.execute.disabled,false);
});
