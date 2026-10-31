const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('backlot/ui/model.js','utf8');
const functionSource = source.slice(source.indexOf('async function openTranscriptTool('),source.indexOf('function bindTranscriptReview('));
function fixture(project='demo', edited='湖光') {
  const calls = [], warnings = [];
  const host = {prepareMontageTool: async (name,values)=>calls.push({name,values}),scrollIntoView(){}};
  const c = vm.createContext({currentTranscriptReview:{project_id:'demo',media_path:'assets/video/source.mp4',
    segments:[{start:.28,end:1.92,text:'湖光'}],files:{json:{path:'transcripts/runs/accepted/source.json'}}},
    mediaProject:()=>project,document:{getElementById:id=>id==='montageTools'?host:{value:edited}},
    openWorkspaceFragment(){},setMediaNarrationStatus:(_,message)=>warnings.push(message)});
  vm.runInContext(functionSource,c);
  return {c,calls,warnings};
}
test('corrected text keeps source time segments and goes only to the real aligner',async()=>{
  const f=fixture('demo','湖面晨光');await f.c.openTranscriptTool(true);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].name,'transcript_aligner');
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0].values)),{input_path:'assets/video/source.mp4',segments:[{start:.28,end:1.92,text:'湖面晨光'}]});
  assert.equal(f.c.currentTranscriptReview.segments[0].text,'湖光');
});
test('changing segments cannot invent new times',async()=>{
  const f=fixture('demo','湖光\n晨雾');await f.c.openTranscriptTool(true);
  assert.equal(f.calls.length,0);assert.match(f.warnings[0],/保持原有字幕段数/);
});
test('unsaved edits cannot be exported as though they were already aligned',async()=>{
  const f=fixture('demo','湖面晨光');await f.c.openTranscriptTool(false);
  assert.equal(f.calls.length,0);assert.match(f.warnings[0],/未保存/);
});
test('switching projects cannot reuse another project’s transcript',async()=>{
  const f=fixture('other');await f.c.openTranscriptTool(false);
  assert.equal(f.calls.length,0);assert.match(f.warnings[0],/当前项目/);
});
test('saved transcript handoff carries the actual input and JSON, with no execution',async()=>{
  const f=fixture();await f.c.openTranscriptTool(false);
  assert.equal(f.calls[0].name,'remotion_caption_burn');
  assert.equal(f.calls[0].values.transcript_path,'transcripts/runs/accepted/source.json');
  assert.equal(f.calls[0].values.input_path,'assets/video/source.mp4');
  assert.equal(f.calls[0].values.confirm,undefined);
});

function restoreFixture({draft='', project='demo', response}={}) {
  const input={value:draft},panel={hidden:true},reads=[];
  const payload={segments:[{start:.28,end:1.92,text:'湖光'}],duration_seconds:2};
  const manifest={status:'completed',project_id:'demo',source_media:{path:'assets/video/source.mp4'},outputs:{json:{path:'transcripts/runs/accepted/source.json'}}};
  const c=vm.createContext({currentTranscriptReview:null,mediaProject:()=>project,
    document:{getElementById:id=>id==='mediaTranscriptText'?input:panel},
    setMediaNarrationStatus(){},
    getJSON:async url=>{reads.push(url);return response ? response() : payload;}});
  vm.runInContext(functionSource,c);
  return {c,input,panel,reads,manifest};
}
test('refresh reads an existing transcript without restarting recognition',async()=>{
  const f=restoreFixture();await f.c.restoreTranscriptReview('demo',f.manifest);
  assert.equal(f.input.value,'湖光');assert.equal(f.panel.hidden,false);
  assert.deepEqual(f.reads,['/media/demo/transcripts/runs/accepted/source.json']);
  assert.equal(f.c.currentTranscriptReview.files.json.path,f.manifest.outputs.json.path);
});
test('refresh does not overwrite the user’s retained correction',async()=>{
  const f=restoreFixture({draft:'湖面晨光'});await f.c.restoreTranscriptReview('demo',f.manifest);
  assert.equal(f.input.value,'湖面晨光');assert.equal(f.c.currentTranscriptReview.segments[0].text,'湖光');
});
test('a delayed previous-project read cannot repopulate the current editor',async()=>{
  let finish;
  const f=restoreFixture({response:()=>new Promise(resolve=>{finish=resolve;})});
  const pending=f.c.restoreTranscriptReview('demo',f.manifest);
  f.c.mediaProject=()=> 'other';finish({segments:[{start:0,end:1,text:'旧项目'}]});await pending;
  assert.equal(f.panel.hidden,true);assert.equal(f.c.currentTranscriptReview,null);
});
test('incomplete or cross-project manifests do not fetch subtitle content',async()=>{
  const f=restoreFixture({project:'other'});await f.c.restoreTranscriptReview('demo',f.manifest);
  f.c.mediaProject=()=> 'demo';await f.c.restoreTranscriptReview('demo',{...f.manifest,status:'failed'});
  await f.c.restoreTranscriptReview('demo',{...f.manifest,outputs:{json:{path:'../outside.json'}}});
  assert.equal(f.reads.length,0);assert.equal(f.panel.hidden,true);
});
