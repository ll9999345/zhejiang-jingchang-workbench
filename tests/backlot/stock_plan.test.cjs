const test = require('node:test');
const assert = require('node:assert/strict');
const {buildStockPlan} = require('../../backlot/ui/stock-plan.js');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
test('plan derives bilingual location and shot keywords without user input', () => {
  const plan = buildStockPlan('三清山', {}, [{id:'s1',visual_prompt:'三清山，瀑布与岩石'}, {id:'s2',visual_prompt:'三清山，林间树叶'}]);
  assert.deepEqual(plan.find(row => row.query === 'Mount Sanqing').shot_ids, ['s1','s2']);
  assert.deepEqual(plan.find(row => row.query === 'waterfall').shot_ids, ['s1']);
  assert.match(plan.find(row => row.query === 'forest').kind, /不代表景点/);
});
test('unknown place is preserved and proposal works before storyboarding', () => {
  const plan = buildStockPlan('未知古村，晨游', {title:'晨游',concept:'瀑布流水'}, []);
  assert.equal(plan[0].query, '未知古村');
  assert.deepEqual(plan[0].shot_ids, ['proposal']);
  assert(plan.some(row => row.query === 'waterfall'));
});
test('choosing a proposal persists it then starts free stock search', async () => {
  const calls = [];
  const source = fs.readFileSync(path.join(__dirname, '../../backlot/ui/model.js'), 'utf8');
  const context = vm.createContext({workflow:{draftId:'test-project', candidates:[{id:'a',title:'A'}]}, creativeStatus:{},
    renderCandidates(){}, syncReceiptVisibility(){}, setStatus(){},
    async persistWorkflowDraft(){calls.push('persist');},
    showMediaPanel(id){calls.push(id);}, prepareStockPlan(){calls.push('plan');},
    searchStockMedia(options){calls.push(options.automatic);},
  });
  vm.runInContext(source.slice(source.indexOf('function selectCandidate('), source.indexOf('async function runCandidates(')), context);
  context.selectCandidate('a');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['persist','test-project','plan',true]);
});
