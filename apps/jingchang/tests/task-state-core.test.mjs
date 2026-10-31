import test from 'node:test';
import assert from 'node:assert/strict';
import {taskPresentation,selectTask,taskFingerprint} from '../public/task-state-core.js';

const task=(id,extra={})=>({id,kind:'studio',projectId:'project-a',status:'running',createdAt:'2026-10-02T10:00:00Z',...extra});

test('云生成、语言模型与导出不把通用 progress 当真实比例',()=>{
 for(const kind of ['studio','runninghub','image-api','canvas-llm','render','conversation','unknown']){
  for(const progress of [0,10,20,92,100]){
   const state=taskPresentation(task('job',{kind,progress,count:4,items:[{index:0,status:'completed'}]}));
   assert.equal(state.progress,null);assert.equal(state.label,'进行中');assert.equal(state.active,true);
  }
 }
});

test('画布只计算已完成步骤，明确区别于当前模型进度',()=>{
 const state=taskPresentation(task('canvas',{kind:'canvas-run',progress:92,steps:[{status:'completed'},{status:'running',childProgress:99},{status:'pending'}]}));
 assert.deepEqual(state.progress,{value:1,total:3,unit:'步',ratio:1/3});assert.equal(state.detail,'已完成 1 / 3 步');
});

test('Comfy 只计算完成批次，不按素材数量或提交次数推算',()=>{
 const state=taskPresentation(task('comfy',{kind:'comfy',count:3,progress:80,assets:Array(12).fill({}),items:[{index:0,status:'completed',assets:Array(12).fill({})},{index:1,status:'pending',promptId:'upstream'}]}));
 assert.deepEqual(state.progress,{value:1,total:3,unit:'批次',ratio:1/3});
});

test('排队与待确认没有 0% 已生成的误导，真实 running 零完成仍可计数',()=>{
 for(const status of ['queued','preparing','pending','submitting','awaiting-confirmation']){
  assert.equal(taskPresentation(task('queued',{status,kind:'canvas-run',steps:[{status:'pending'}]})).progress,null);
 }
 assert.deepEqual(taskPresentation(task('started',{kind:'comfy',count:2,items:[]})).progress,{value:0,total:2,unit:'批次',ratio:0});
});

test('非法或不足的数量证据退回未知，不钳制或猜测百分比',()=>{
 const cases=[{kind:'canvas-run',steps:[]},{kind:'canvas-run',steps:[null]},{kind:'canvas-run',steps:[{}]},{kind:'comfy',count:'2',items:[]},{kind:'comfy',count:0,items:[]},{kind:'comfy',count:2,items:[{status:'completed'}]},{kind:'comfy',count:2,items:[{index:2,status:'completed'}]},{kind:'comfy',count:2,items:[{index:0,status:'completed'},{index:0,status:'completed'}]}];
 for(const value of cases)assert.equal(taskPresentation(task('invalid',value)).progress,null);
});

test('完成、中断、停止、暂停、失败、部分完成均有不同状态',()=>{
 const statuses=['completed','interrupted','cancelled','paused','failed','incomplete','partial'],states=statuses.map(status=>taskPresentation(task(status,{status})));
 assert.equal(new Set(states.map(state=>state.label)).size,statuses.length);
 assert.ok(states.every(state=>state.terminal&&!state.active));
 assert.deepEqual(states.filter(state=>state.tone==='success').map(state=>state.status),['completed']);
 assert.equal(taskPresentation(task('done',{status:'completed',progress:100})).progress,null);
});

test('提交不确定保留服务状态，既不冒充失败已确定也不冒充完成',()=>{
 const state=taskPresentation(task('uncertain',{status:'failed',uncertain:true}));
 assert.equal(state.status,'failed');assert.equal(state.label,'提交结果待核实');assert.equal(state.tone,'warning');assert.equal(state.active,false);
 const legacy=taskPresentation(task('comfy',{kind:'comfy',status:'failed',count:1,items:[{index:0,status:'submitting',promptId:null}]}));
 assert.equal(legacy.label,'提交结果待核实');
 const failed=taskPresentation(task('comfy',{kind:'comfy',status:'failed',count:1,items:[{index:0,status:'failed',promptId:'accepted'}]}));
 assert.equal(failed.label,'失败');
 assert.equal(taskPresentation(task('resuming',{uncertain:true,message:'正在查询原任务'})).label,'进行中');
});

test('待确认和待补参可见但不是自动运行，未知状态不推断成功',()=>{
 for(const status of ['awaiting_input','awaiting-confirmation']){
  const state=taskPresentation(task('waiting',{status}));assert.equal(state.active,false);assert.equal(state.terminal,false);assert.equal(state.tone,'warning');
 }
 const unknown=taskPresentation(task('unknown',{status:'future-state',progress:100}));
 assert.equal(unknown.status,'future-state');assert.equal(unknown.label,'状态未知');assert.equal(unknown.active,false);assert.equal(unknown.terminal,false);
});

test('优先当前项目活动任务，当前项目终态不遮蔽其他活动任务',()=>{
 const other=task('other',{projectId:'project-b',createdAt:'2026-10-02T11:00:00Z'}),current=task('current');
 assert.equal(selectTask([other,current],{projectId:'project-a'}).id,'current');
 assert.equal(selectTask([other,{...current,status:'completed'}],{projectId:'project-a'}).id,'other');
 assert.equal(selectTask([{...other,status:'completed'},{...current,status:'awaiting-confirmation'}],{projectId:'project-a'}).id,'current');
});

test('父画布聚合子任务，兼容两种父字段及步骤 jobId',()=>{
 for(const child of [task('child',{parentId:'parent'}),task('child',{parentJobId:'parent'}),task('child',{kind:'comfy'})]){
  const parent=task('parent',{kind:'canvas-run',steps:[{status:'running',jobId:'child'}]});
  assert.equal(selectTask([child,parent],{projectId:'project-a'}).id,'parent');
 }
});

test('恢复窗口可按确切步骤请求号识别无 parentId 子任务，不凭名称猜关联',()=>{
 const parent=task('parent',{kind:'canvas-run',status:'completed',steps:[{status:'completed',kind:'image-api'}]});
 const child=task('child',{kind:'image-api',requestId:'parent-0',status:'completed',createdAt:'2026-10-02T11:00:00Z'});
 assert.equal(selectTask([child,parent],{projectId:'project-a'}).id,'parent');
 const falseChild={...child,requestId:'parent-10',status:'running'};
 assert.equal(selectTask([parent,falseChild],{projectId:'project-a'}).id,'child');
 const differentProject={...child,projectId:'project-b',parentId:'parent',status:'running'};
 assert.equal(selectTask([parent,differentProject],{projectId:'project-a'}).id,'child');
});

test('父任务中断时仍运行的子任务不能被藏起来',()=>{
 const parent=task('parent',{kind:'canvas-run',status:'interrupted',steps:[{status:'running',jobId:'child'}]});
 const child=task('child',{parentId:'parent'});
 assert.equal(selectTask([parent,child],{projectId:'project-a'}).id,'child');
});

test('同优先级按真实时间选择，重复记录保留较新的记录',()=>{
 const older=task('same',{updatedAt:'2026-10-02T09:00:00Z',status:'queued'}),newer={...older,updatedAt:'2026-10-02T12:00:00Z',status:'running'};
 assert.equal(selectTask([older,newer]).status,'running');
 assert.equal(selectTask([task('old'),task('recent',{createdAt:'2026-10-02T11:00:00Z'})]).id,'recent');
 const oldCanvas=task('old-canvas',{kind:'canvas-run',status:'completed',steps:[{status:'completed'}]});
 assert.equal(selectTask([oldCanvas,task('recent',{status:'completed',createdAt:'2026-10-02T11:00:00Z'})]).id,'recent');
});

test('空或坏记录可安全忽略',()=>{
 assert.equal(taskPresentation(null),null);assert.equal(taskPresentation({}),null);assert.equal(taskPresentation({id:'  '}),null);
 assert.equal(selectTask(undefined),null);assert.equal(selectTask([null,{},[],{id:''}]),null);assert.equal(taskFingerprint(null),'');
});

test('纯模型不改原始记录，指纹只记录展示状态且不含任务输入或密钥',()=>{
 const jobs=[task('safe',{kind:'canvas-run',steps:[{status:'running'}],input:{apiKey:'synthetic-private-value'},progress:10})],before=structuredClone(jobs);
 const state=selectTask(jobs),fingerprint=taskFingerprint(state);
 assert.deepEqual(jobs,before);assert.doesNotMatch(fingerprint,/synthetic-private-value|apiKey/);
 assert.equal(fingerprint,taskFingerprint(selectTask([{...jobs[0],progress:99}])));
 assert.notEqual(fingerprint,taskFingerprint(selectTask([{...jobs[0],steps:[{status:'completed'}]}])));
 assert.notEqual(fingerprint,taskFingerprint({...state,status:'interrupted',label:'已中断'}));
});
