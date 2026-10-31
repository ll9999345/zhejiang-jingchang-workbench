const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = vm.createContext({window:{}});
vm.runInContext(fs.readFileSync('backlot/ui/montage-studio.js','utf8'),context);
const ui = context.window.ZhejiangMontageStudio;

test('stock summaries distinguish references from distinct source IDs and explain shortages',()=>{
 assert.match(ui.stockResultNotice({total_clips:2,distinct_clip_ids:1,queries_without_clips:1}),/部分关键词复用了同一素材/);
 assert.match(ui.stockResultNotice({total_clips:1,distinct_clip_ids:1,queries_without_clips:1}),/1 个关键词尚未取得素材/);
 assert.equal(ui.stockResultNotice({total_clips:2,distinct_clip_ids:3}),'');
 assert.equal(ui.stockResultNotice({total_clips:true,distinct_clip_ids:1}),'');
});

test('plain search lines become native query objects without losing spaces or inventing keywords',()=>{
  const queries=ui.queriesFromLines('  三清山 云海\r\n\r\nMount Sanqing sunrise  ','video',2,true);
  assert.deepEqual(JSON.parse(JSON.stringify(queries)),[{query:'三清山 云海',kind:'video',per_source:2},{query:'Mount Sanqing sunrise',kind:'video',per_source:2}]);
  assert.equal(ui.queriesFromLines('one','image',0,false)[0].per_source,undefined);
  for(const text of ['',null,'x'.repeat(501),Array(21).fill('x').join('\n')])assert.throws(()=>ui.queriesFromLines(text,'video',2,true));
  assert.throws(()=>ui.queriesFromLines('one','video',2.5,true));
  assert.throws(()=>ui.queriesFromLines('one','unsupported',2,true));
});
test('raw query settings cannot be silently flattened into simple fields',()=>{
  const value=ui.queriesToGuide([{query:'a',kind:'video',per_source:2},{query:'b',kind:'video',per_source:2}],true);
  assert.equal(value.text,'a\nb');assert.equal(value.perSource,2);
  for(const rows of [[{query:'a',slot_id:'one'}],[{query:'a',required_duration_seconds:5}],[{query:'a',kind:'video'},{query:'b',kind:'image'}],[{query:'a\nb'}],[{query:' a '}],[{query:''}]])assert.throws(()=>ui.queriesToGuide(rows));
  assert.throws(()=>ui.queriesToGuide([{query:'a',per_source:2},{query:'b',per_source:3}],true));
});

test('native progress uses real counters, no percentage or provider strings, and labels retained records',()=>{
  const progress={phase:'embedding_images',query_index:1,queries_total:2,indexed:3,query:'PRIVATE',message:'<img src=x>',source:'secret'};
  assert.equal(ui.progressNotice({status:'running',progress}),'计算画面语义（首次可能较久） · 搜索词 1/2 · 本次入库 3 条');
  assert.match(ui.progressNotice({status:'cancelled',progress}),/^最后记录/);
  assert.equal(ui.progressNotice({progress:{phase:'__proto__'}}),'');
  assert.equal(ui.progressNotice({progress:{phase:'unknown',message:'private'}}),'');
  assert.equal(ui.progressNotice({status:'running',progress:{phase:'search_started',indexed:true,clips_ready:-1}}),'搜索素材');
});

test('native inputs retain zero, booleans and structured data, without rounding',()=>{
  assert.equal(ui.parseValue('0',{type:'number'},'start_seconds'),0);
  assert.equal(ui.parseValue(false,{type:'boolean'},'render_video'),false);
  assert.equal(ui.parseValue('3.5',{type:'number'},'duration_seconds'),3.5);
  assert.equal(ui.parseValue('   ',{type:'string'},'input_path'),undefined);
  assert.equal(ui.parseValue('[{"start":0}]',{type:'array'},'segments')[0].start,0);
});
test('invalid JSON and fractional integer inputs cannot be submitted',()=>{
  assert.throws(()=>ui.parseValue('not JSON',{type:'object'},'world_spec'));
  assert.throws(()=>ui.parseValue('[]',{type:'object'},'world_spec'));
  assert.throws(()=>ui.parseValue('{}',{type:'array'},'segments'));
  assert.throws(()=>ui.parseValue('2.5',{type:'integer'},'fps'));
  assert.throws(()=>ui.parseValue('5',{type:'number',maximum:4},'count'));
});
test('download links remain scoped and encode names instead of executing them',()=>{
  assert.match(ui.urlFor('demo','analysis/montage/run/a b.mp4'),/a%20b\.mp4$/);
  for(const path of ['/etc/passwd','../other.mp4','analysis/montage/../other',''])assert.throws(()=>ui.urlFor('demo',path));
  assert.match(ui.urlFor('demo','analysis/montage/run/<script>.html'),/%3Cscript%3E/);
});
test('caption previews show the rendered output and retain declared project downloads, not copied input',()=>{
  const output={path:'analysis/montage/job/output.mp4',kind:'video'};
  const props={path:'analysis/montage/job/props.json',kind:'file'};
  const row={tool:'remotion_caption_burn',outputs:[{path:'analysis/montage/job/project/public/source.mp4',kind:'video'},output,props],native_result:{artifacts:[output.path,props.path]}};
  assert.deepEqual(Array.from(ui.visibleOutputs(row)),[output,props]);
  assert.equal(ui.visibleOutputs({...row,tool:'audio_probe'}).length,3);
});
test('director reference paths only identify project-relative video files',()=>{
  assert.equal(ui.referencePath(' assets/video/reference.mp4 '),'assets/video/reference.mp4');
  assert.equal(ui.referencePath(''),null);
  for(const path of ['/private/reference.mp4','../other/reference.mp4','assets/../reference.mp4','assets\\reference.mp4','https://example.com/ref.mp4','assets/ref.json','assets//ref.mp4','mp4'])assert.throws(()=>ui.referencePath(path));
});
test('reference previews use project media protocol for both assets and local reference imports',()=>{
  assert.equal(ui.referencePreviewUrl('demo','assets/video/ref a.mp4'),'/model-api/footage/assets/demo?path=assets%2Fvideo%2Fref%20a.mp4');
  assert.equal(ui.referencePreviewUrl('demo','analysis/reference_imports/abc.mp4'),'/model-api/footage/assets/demo?path=analysis%2Freference_imports%2Fabc.mp4');
  for(const path of ['../reference.mp4','/private/reference.mp4','assets/reference.html'])assert.throws(()=>ui.referencePreviewUrl('demo',path));
  assert.throws(()=>ui.referencePreviewUrl('','assets/reference.mp4'));
  assert.match(ui.urlFor('demo','analysis/montage/run/output.mp4'),/^\/model-api\/montage\/files\/demo\//);
});
test('reference import accept extensions remain aligned with the existing backend video contract',()=>{
  const declaration=fs.readFileSync('web_api/footage_pipeline.py','utf8').match(/^VIDEO_EXTS\s*=\s*\{([^\n]+)\}/m);
  assert(declaration,'backend must declare its accepted video formats');
  const extensions=Array.from(declaration[1].matchAll(/['"]\.([a-z0-9]+)['"]/g),match=>match[1]);
  assert.deepEqual(Array.from(ui.referenceVideoExtensions).sort(),extensions.sort());
});

test('corpus recovery is explained outside raw native JSON using a fixed readable message',()=>{
  assert.match(ui.corpusRecoveryNotice({persistence:{recovered:true}}),/上一份完整素材库/);
  assert.match(ui.corpusRecoveryNotice({loaded_persistence:{recovered:true},persistence:{recovered:false}}),/相关文件已保留/);
  assert.equal(ui.corpusRecoveryNotice({persistence:{recovered:false}}),'');
  assert.equal(ui.corpusRecoveryNotice({persistence:{recovered:'true'},persistence_warning:'<img src=x>'}),'');
  assert(!ui.corpusRecoveryNotice({persistence:{recovered:true},persistence_warning:'private fixture'}).includes('private'));
});
