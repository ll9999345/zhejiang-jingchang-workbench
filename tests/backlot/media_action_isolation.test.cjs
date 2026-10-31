const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../../backlot/ui/model.js'), 'utf8');
for (const outcome of ['success', 'failure']) {
  test(`late ${outcome} from a different project never replaces current results`, async () => {
    let currentProject = 'a';
    const results = [];
    const c = vm.createContext({mediaActionBusy:false, HTMLButtonElement:class {}, document:{activeElement:null},
      window:{setInterval(){return 1;},clearInterval(){}}, mediaPipeline:{setAttribute(){},removeAttribute(){}},
      mediaProject:()=>currentProject, requireMediaProject:()=>currentProject,
      setStatus(){}, setMediaNarrationStatus(){}, showMediaResult:data=>results.push(data),
      mediaNarrationResultStatus:()=>['success','done']});
    vm.runInContext(source.slice(source.indexOf('async function runMediaAction('), source.indexOf('async function estimateAudioMedia(')), c);
    await c.runMediaAction(async () => {currentProject='b'; if(outcome==='failure') throw new Error('old failure'); return {status:'completed'};}, ()=>{});
    assert.deepEqual(results, []);
    assert.equal(c.mediaActionBusy, false);
  });
}
test('preflight and failure do not change media selections or previews', () => {
  const updates = [];
  const c = vm.createContext({mediaOutput:{textContent:''}, mediaProject:()=> 'a', setStatus(){}, mediaMusicStatus:null,
    autofillMediaPaths:()=>updates.push('fill'), updateAssetPickers:()=>updates.push('picker'), renderMediaPreview:()=>updates.push('preview')});
  vm.runInContext(source.slice(source.indexOf('function showMediaResult('), source.indexOf('function renderMediaCapabilities(')), c);
  c.showMediaResult({status:'dry_run', output:{path:'planned.mp4'}});
  c.showMediaResult({status:'invalid_request', error:'missing input'});
  assert.deepEqual(updates, []);
  c.showMediaResult({status:'completed', output:{path:'real.mp4'}});
  assert.deepEqual(updates, ['fill','picker','preview']);
});
