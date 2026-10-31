const test = require('node:test');
const assert = require('node:assert/strict');
const ui = require('../../backlot/ui/footage.js');

test('automatic assignments survive a new search while legacy and user selections stay manual', () => {
  const payload=ui.buildJobPayload({project_id:'demo',shots:[
    {id:'auto',source_path:'assets/a.mp4',selection_mode:'auto',start_seconds:5},
    {id:'legacy',source_path:'assets/b.mp4'},
    {id:'locked',source_path:'assets/c.mp4',selection_mode:'auto',source_locked:true},
  ]});
  assert.equal(payload.shots[0].selection_mode,'auto');
  assert.equal(payload.shots[0].start_seconds,5);
  assert.equal(payload.shots[1].selection_mode,'manual');
  assert.equal(payload.shots[2].selection_mode,'manual');
  assert.equal(payload.shots[2].source_locked,true);
});

test('free local music settings survive request, export and restoration', () => {
  const options=ui.sanitizeSettings({bgm_mode:'local',bgm_style:'documentary',bgm_volume:.12,duck_bgm:false});
  const payload=ui.buildJobPayload({project_id:'demo',options,material_mode:'local'});
  assert.equal(payload.options.bgm_mode,'local');
  assert.equal(payload.options.bgm_style,'documentary');
  assert.equal(payload.options.bgm_volume,.12);
  assert.equal(payload.options.duck_bgm,false);
  assert.equal(ui.normalizeOptions(ui.sanitizeSettings(payload.options)).duck_bgm,false);
  assert.equal(ui.normalizeOptions({}).duck_bgm,true);
  assert.equal(ui.normalizeOptions(payload.options).bgm_style,'documentary');
});

test('canvas edit links point only to the verified version of the displayed job', () => {
  const job='footage-'+ 'a'.repeat(24);
  const output={status:'completed',output_path:`renders/${job}/version-2/final.mp4`,canvas_cut_path:`renders/${job}/version-2/canvas-cut.json`};
  const link=new URL(ui.canvasCutUrl('demo',job,output),'http://127.0.0.1');
  assert.equal(link.pathname,'/canvas');assert.equal(link.searchParams.get('cut'),job);assert.equal(link.searchParams.get('version'),'2');
  assert.equal(ui.canvasCutUrl('other',job,{...output,status:'failed'}),'');
  assert.equal(ui.canvasCutUrl('demo','footage-'+ 'b'.repeat(24),output),'');
  assert.equal(ui.canvasCutUrl('demo',job,{...output,canvas_cut_path:'../private.json'}),'');
  assert.equal(ui.canvasCutUrl('../private',job,output),'');
});

test('edited scripts replan without carrying obsolete shot selections', () => {
  const r=ui.buildPlanRequest({projectId:'demo',script:'新旁白',shots:[{id:'old',source_path:'old.mp4'}],omitShots:true});
  assert.equal(r.project_id,'demo');assert.equal(r.script,'新旁白');assert.equal(r.shots,undefined);
});
test('edited scripts can generate directly while export of obsolete selections stays disabled', () => {
  const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
  const nodes=Object.fromEntries(['collectButton','createButton','renderButton','cancelButton','actionHint','materialMode','stopAt','narrationMode','networkConfirm','stepScript','stepMaterials','stepExport']
    .map(id=>[id,{value:'',textContent:'',checked:false,classList:{toggle(){},remove(){}},setAttribute(){},removeAttribute(){}}]));
  nodes.materialMode.value='online';nodes.stopAt.value='video';nodes.narrationMode.value='local';
  const context=vm.createContext({module:{exports:{}},controls:nodes});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../../backlot/ui/footage.js'),'utf8'),context);
  vm.runInContext('dom=controls;state={ready:true,busy:false,scriptText:"新的文案",shots:[{id:"old",source_path:"old.mp4"}],planDirty:true,availableSources:["wikimedia"]};updateActionButtons();',context);
  assert.equal(nodes.createButton.disabled,false);
  assert.equal(nodes.collectButton.disabled,false);
  assert.equal(nodes.renderButton.disabled,true);
  assert.match(nodes.actionHint.textContent,/生成时会更新/);
  vm.runInContext('state.planBusy=true;updateActionButtons();',context);
  assert.equal(nodes.createButton.disabled,true);
  assert.equal(nodes.collectButton.disabled,true);
  vm.runInContext('state.planBusy=false;',context);
  vm.runInContext('state.scriptText=" ";updateActionButtons();',context);
  assert.equal(nodes.createButton.disabled,true);
  assert.equal(nodes.collectButton.disabled,true);
});
test('batch export preserves music and never changes narration order implicitly', () => {
  const r=ui.buildJobPayload({projectId:'demo',action:'create',options:{variants:3,bgm_mode:'selected',bgm_path:'assets/music/a.mp3',order:'sequential'}});
  assert.equal(r.options.variants,3);assert.equal(r.options.bgm_path,'assets/music/a.mp3');assert.equal(r.options.order,'sequential');
});
test('foreign receipts and unsafe links do not attach to the current project', () => {
  assert.equal(ui.jobBelongsToProject({project_id:'other',job_id:'1'},'demo'),false);
  assert.equal(ui.jobBelongsToProject({project_id:'demo',job_id:'2'},'demo','1'),false);
  assert.equal(ui.assetUrl('demo','javascript:alert(1)'), '');
  assert.match(ui.assetUrl('demo','assets/a b.mp4'),/a%20b\.mp4/);
});
test('settings imports cannot smuggle credentials or unrecognized fields', () => {
  assert.throws(()=>ui.sanitizeSettings({api_key:'unit-test'}));
  assert.throws(()=>ui.sanitizeSettings({subtitles:{token:'unit-test'}}));
  assert.throws(()=>ui.sanitizeSettings({new_provider:'x'}));
  assert.deepEqual(ui.sanitizeSettings({resolution:1080,subtitles:{color:'#FFFFFF'}}),{resolution:1080,subtitles:{color:'#FFFFFF'}});
});
test('missing materials and interruption are terminal states, not running or successful', () => {
  for(const status of ['needs_materials','interrupted','failed','awaiting_review','stage_completed'])assert.equal(ui.isTerminalStatus(status),true);
  assert.equal(ui.isTerminalStatus('running'),false);
  const job=ui.normalizeJobSnapshot({status:'failed',project_id:'demo',outputs:[]});assert.equal(job.outputs.length,0);
});

test('imported subtitle colors and outline survive visible controls and the next job/export', () => {
  const imported = ui.normalizeOptions(ui.sanitizeSettings({subtitles:{color:'#F1BC32',outline_color:'#243B75',outline_width:4.5,font_size:54,background:true,position:'top'}}));
  const controls = Object.fromEntries(['subtitleEnabled','subtitleFont','subtitleFontSize','subtitleColor','subtitleOutlineColor','subtitleOutlineWidth','subtitleBackground','subtitlePosition'].map(key => [key, {value:'',checked:false}]));
  ui.applySubtitleControls(controls, imported.subtitles);
  const rendered = ui.normalizeOptions({subtitles:ui.readSubtitleControls(controls)});
  const request = ui.buildJobPayload({project_id:'demo',options:rendered});
  const exported = ui.sanitizeSettings(request.options);
  assert.equal(request.options.subtitles.color, '#F1BC32');
  assert.equal(request.options.subtitles.outline_color, '#243B75');
  assert.equal(request.options.subtitles.outline_width, 4.5);
  assert.deepEqual(exported.subtitles, imported.subtitles);
});

test('sound and subtitle stage receipts do not create a video path', () => {
  const audio=ui.outputMedia({stage:'audio',audio_path:'assets/audio/voice.wav'});
  assert.deepEqual(audio,{video:'',audio:'assets/audio/voice.wav',subtitle:''});
  const subtitle=ui.outputMedia({stage:'subtitle',subtitle_path:'assets/subtitles.srt'});
  assert.deepEqual(subtitle,{video:'',audio:'',subtitle:'assets/subtitles.srt'});
  assert.equal(ui.buildJobPayload({project_id:'demo',stop_at:'audio',options:{variants:5}}).stop_at,'audio');
  assert.equal(ui.buildJobPayload({project_id:'demo',stop_at:'subtitle',options:{variants:5}}).options.variants,5);
});

test('text stages remain usable without media sources or Edge consent and expose downloads', () => {
  const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
  const nodes=Object.fromEntries(['collectButton','createButton','renderButton','cancelButton','actionHint','materialMode','stopAt','narrationMode','networkConfirm','stepScript','stepMaterials','stepExport']
    .map(id=>[id,{value:'',textContent:'',checked:false,classList:{toggle(){},remove(){}},setAttribute(){},removeAttribute(){}}]));
  nodes.materialMode.value='stock';nodes.narrationMode.value='edge';
  const context=vm.createContext({module:{exports:{}},controls:nodes});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../../backlot/ui/footage.js'),'utf8'),context);
  vm.runInContext('dom=controls;state={ready:true,busy:false,planBusy:false,planDirty:false,scriptText:"当前文案",shots:[{id:"one",source_path:""}],availableSources:[],projectId:"demo",currentJob:null};',context);
  for(const [stage,label] of [['script','保存当前文案'],['terms','整理镜头关键词']]){
    nodes.stopAt.value=stage;
    vm.runInContext('updateActionButtons()',context);
    assert.equal(nodes.createButton.disabled,false);assert.equal(nodes.renderButton.disabled,false);
    assert.equal(nodes.createButton.textContent,label);
    assert.equal(vm.runInContext('actionNeedsNetwork("create")',context),false);
    assert.equal(vm.runInContext('networkConfirmationValid("create")',context),true);
    assert.equal(ui.buildJobPayload({project_id:'demo',action:'create',stop_at:stage}).stop_at,stage);
  }
  nodes.materialMode.value='local';
  assert.equal(vm.runInContext('networkConfirmationValid("collect")',context),true);
  const receipt=ui.outputMedia({stage:'terms',script_path:'artifacts/footage_jobs/footage-example/script.txt',terms_path:'artifacts/footage_jobs/footage-example/search-terms.json'});
  assert.equal(receipt.video,'');assert.equal(receipt.audio,'');assert.equal(receipt.script.endsWith('script.txt'),true);assert.equal(receipt.terms.endsWith('search-terms.json'),true);
});

test('actual MPT preset schema maps native style fields without clamping', () => {
  const source=require('node:fs').readFileSync(require('node:path').join(__dirname,'../../integrations/moneyprinterturbo/upstream/webui/Main.py'),'utf8');
  const schema=source.match(/SETTINGS_PRESET_SCHEMA = "([^"]+)"/)[1];
  const result=ui.convertMptSettings({schema,version:1,app_version:'1.3.7',params:{video_aspect:'9:16',video_fit_mode:'contain',video_concat_mode:'sequential',video_count:5,video_transition_mode:null,voice_name:'Tingting',voice_rate:1.15,voice_volume:.8,bgm_type:'',bgm_volume:.2,subtitle_enabled:true,subtitle_position:'top',font_name:'PingFang SC',font_size:54,text_fore_color:'#F1BC32',stroke_color:'#243B75',stroke_width:3.5,text_background_color:false}}, {voices:[{id:'Tingting',available:true,network:false}]});
  assert.deepEqual(result.unsupported,[]);
  const options=ui.normalizeOptions(result.options);
  assert.equal(options.aspect_ratio,'9:16');assert.equal(options.variants,5);assert.equal(options.fit,'contain');assert.equal(options.transition,'cut');
  assert.equal(options.voice_rate,1.15);assert.equal(options.narration_volume,.8);assert.equal(options.narration,'local');assert.equal(options.bgm_mode,'none');
  assert.equal(options.subtitles.color,'#F1BC32');assert.equal(options.subtitles.outline_color,'#243B75');assert.equal(options.subtitles.outline_width,3.5);
  const invalid=ui.convertMptSettings({schema,version:1,params:{video_count:6,voice_volume:5,font_size:140,voice_rate:3}});
  assert.equal(invalid.unsupported.length,4);assert.deepEqual(invalid.options,{});
});

test('MPT advanced choices and unknown fields produce explicit rejection reasons', () => {
  const result=ui.convertMptSettings({schema:'moneyprinterturbo.settings-preset',version:1,params:{video_aspect:'16:9',video_transition_mode:'Shuffle',subtitle_display_mode:'word_by_word',subtitle_animation:'pop_spring',subtitle_position:'custom',custom_position:60,rounded_subtitle_background:true,font_name:'STHeitiMedium.ttc',video_clip_speed:1.5,video_clip_duration:5,new_option:true}});
  assert.equal(result.unsupported.length,10);
  for(const key of ['video_transition_mode','subtitle_display_mode','subtitle_animation','subtitle_position','custom_position','rounded_subtitle_background','font_name','video_clip_speed','video_clip_duration','new_option']) assert.ok(result.unsupported.some(reason=>reason.startsWith(key+':')||reason.startsWith(key+'：')));
  assert.deepEqual(result.options,{aspect_ratio:'16:9'});
  assert.throws(()=>ui.convertMptSettings({schema:'moneyprinterturbo.key-backup',version:1,keys:{dummy:'unit-test'}}),/凭据备份|密钥/);
  assert.throws(()=>ui.convertMptSettings({schema_version:1,params:{}}),/schema/);
  assert.throws(()=>ui.convertMptSettings({schema:'moneyprinterturbo.settings-preset',version:2,params:{}}),/version/);
  assert.throws(()=>ui.convertMptSettings({schema:'moneyprinterturbo.settings-preset',version:1,params:{api_key:'unit-test'}}),/密钥/);
});

test('MPT audio paths must already belong to this project and uploaded narration overrides unused TTS', () => {
  const result=ui.convertMptSettings({schema:'moneyprinterturbo.settings-preset',version:1,params:{voice_name:'remote-voice',custom_audio_file:'assets/audio/narration.wav',bgm_type:'custom',bgm_file:'assets/music/bed.mp3'}},{assets:[{path:'assets/audio/narration.wav',kind:'audio'},{path:'assets/music/bed.mp3',kind:'audio'}]});
  assert.deepEqual(result.unsupported,[]);assert.equal(result.options.narration,'uploaded');assert.equal(result.options.audio_path,'assets/audio/narration.wav');assert.equal(result.options.bgm_path,'assets/music/bed.mp3');
  for(const path of ['/tmp/voice.wav','../voice.wav','https://example.org/voice.wav','assets/audio/missing.wav']) {
    const invalid=ui.convertMptSettings({schema:'moneyprinterturbo.settings-preset',version:1,params:{custom_audio_file:path}});
    assert.equal(invalid.unsupported.length,1);assert.equal(invalid.options.audio_path,undefined);
  }
});

test('preset import rejects unsupported choices before any local save and never starts production', async () => {
  const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
  class Node {replaceChildren(){} appendChild(){} }
  const calls=[],context=vm.createContext({module:{exports:{}},document:{getElementById:()=>new Node(),createElement:()=>new Node()}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../../backlot/ui/footage.js'),'utf8'),context);
  context.testPost=(path,body)=>{calls.push({path,body});return Promise.resolve({options:body});};
  vm.runInContext('state={projectId:"demo",assets:[],capabilities:{voices:[]}};dom={networkConfirm:{checked:false}};postJSON=testPost;currentOptions=()=>normalizeOptions({});applyOptions=()=>{};setPageMessage=()=>{};',context);
  context.event={target:{value:'file',files:[{text:async()=>JSON.stringify({schema:'moneyprinterturbo.settings-preset',version:1,params:{video_aspect:'9:16',subtitle_animation:'pop_spring'}})}]}};
  await vm.runInContext('importSettings(event)',context);
  assert.equal(calls.length,0);
  context.event.target.files[0].text=async()=>JSON.stringify({schema:'moneyprinterturbo.settings-preset',version:1,params:{video_aspect:'9:16',video_count:5}});
  await vm.runInContext('importSettings(event)',context);
  assert.equal(calls.length,1);assert.equal(calls[0].path,'/model-api/footage/settings/demo');assert.equal(calls[0].body.aspect_ratio,'9:16');assert.equal(calls[0].body.variants,5);
  assert.equal(calls[0].body.params,undefined);
});

function searchTermFixture() {
  const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
  class Node {
    constructor(){this.children=[];this.dataset={};this.textContent='';}
    get firstChild(){return this.children[0];}
    removeChild(node){this.children.splice(this.children.indexOf(node),1);}
    replaceChildren(){this.children=[];}
    appendChild(node){this.children.push(node);}
  }
  const row=new Node(),shot=ui.normalizeShot({id:'new-shot',query:'自动湖面词',queries:[{text:'自动湖面词',kind:'place'},{text:'自动氛围词',kind:'generic'}],query_override:'候选覆盖词 <湖面>'});
  const input={dataset:{field:'query_override'},value:shot.query_override,selectionStart:4,selectionEnd:4};
  const card={dataset:{shotId:shot.id},querySelector:()=>row};input.closest=()=>card;
  const document={createElement:()=>new Node(),activeElement:input};
  const context=vm.createContext({module:{exports:{}},document,fixtureShot:shot});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../../backlot/ui/footage.js'),'utf8'),context);
  vm.runInContext('state={shots:[fixtureShot],shotsDirty:false};updateActionButtons=()=>{};',context);
  return {row,shot,input,card,document,context,render:()=>context.module.exports.renderShotQueries(row,shot),inputEvent:()=>{context.fixtureEvent={target:input};vm.runInContext('handleShotInput(fixtureEvent)',context);}};
}

test('actual search overrides display plainly without geographic claims or changing the request', () => {
  const f=searchTermFixture(),before=ui.buildJobPayload({projectId:'demo',shots:[f.shot],requestId:'search-unit-request'});
  f.render();
  assert.equal(f.row.dataset.querySource,'override');
  assert.deepEqual(f.row.children.map(node=>node.textContent),['实际搜索词','候选覆盖词 <湖面>']);
  assert.equal(f.row.children[1].title,'候选覆盖词 <湖面>');
  assert.equal(f.row.children[1].className,'query-chip');
  assert.deepEqual(ui.buildJobPayload({projectId:'demo',shots:[f.shot],requestId:'search-unit-request'}),before);
});

test('editing and clearing an override updates its label without replacing the focused input', () => {
  const f=searchTermFixture(),automatic=JSON.stringify(f.shot.queries);
  f.render();f.input.value='手动词';f.inputEvent();
  assert.deepEqual(f.row.children.map(node=>node.textContent),['实际搜索词','手动词']);
  assert.equal(f.document.activeElement,f.input);assert.equal(f.input.selectionStart,4);
  f.input.value='';f.inputEvent();
  assert.equal(f.row.dataset.querySource,'auto');
  assert.deepEqual(f.row.children.map(node=>node.textContent),['自动搜索词','地点：自动湖面词','通用：自动氛围词']);
  assert.equal(f.document.activeElement,f.input);assert.equal(f.input.selectionEnd,4);
  assert.equal(f.shot.query,'自动湖面词');assert.equal(JSON.stringify(f.shot.queries),automatic);
});

test('clearing a candidate override displays its actual default query without changing search semantics', () => {
  const f=searchTermFixture();f.shot.query=f.shot.query_override;
  const before=ui.buildJobPayload({projectId:'demo',shots:[f.shot],requestId:'candidate-clear-request'});
  f.render();f.input.value='';f.inputEvent();
  assert.deepEqual(f.row.children.map(node=>node.textContent),['自动搜索词','候选覆盖词 <湖面>']);
  assert.equal(f.row.children[1].className,'query-chip');assert.equal(f.document.activeElement,f.input);
  assert.deepEqual(ui.buildJobPayload({projectId:'demo',shots:[f.shot],requestId:'candidate-clear-request'}),before);
});

test('probed timeline coverage remains readable without implying location or quality approval', () => {
  const coverage={evidence:'probed_selected_windows',required_seconds:3,covered_seconds:1.5,total_shots:2,ready_shots:1};
  const text=ui.materialCoverageText(coverage);
  assert.ok(text.includes('1.5/3 秒（1/2 镜头可用）'));
  assert.ok(text.includes('仍需逐镜核对地点、内容与许可'));
  assert.ok(ui.materialCoverageText({...coverage,rows:[{reason:'probed_still_image_hold'}]}).includes('含静态图片定格'));
  for(const invalid of [undefined,{}, {...coverage,evidence:'provider_claim'}, {...coverage,covered_seconds:4},
      {...coverage,covered_seconds:Infinity}, {...coverage,ready_shots:3}, {...coverage,required_seconds:'3'}]) {
    assert.equal(ui.materialCoverageText(invalid),'');
  }
});
