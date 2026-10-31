import test from 'node:test';
import assert from 'node:assert/strict';
import {materializeMinimaxSeed,minimaxSubmittedParameters,minimaxRandomMode,MINIMAX_RANDOM_SEED_MAX} from '../lib/minimax-seed.mjs';
import {newMinimaxSegment,normalizeMinimaxTimeline,applyMinimaxLoopValues,minimaxFromNative} from '../public/minimax-h3-core.js';
import {compileMinimaxH3} from '../lib/minimax-h3.mjs';
import {h3Workflow} from './helpers/minimax-h3-fixture.mjs';
const timeline=()=>normalizeMinimaxTimeline({version:1,segments:[newMinimaxSegment('clip',0,{prompt:'本机参数验收',seed:17})],selectedSegmentId:'clip'});

test('固定模式保留旧时间轴，不抽取新种子或改原数据',()=>{
 const input=timeline(),before=structuredClone(input),choice=materializeMinimaxSeed(input,{draw:()=>assert.fail('fixed mode must not draw')});
 assert.equal(minimaxRandomMode(input),false);assert.equal(choice.record,null);assert.deepEqual(choice.timeline,input);assert.notEqual(choice.timeline,input);assert.deepEqual(input,before);
 assert.throws(()=>normalizeMinimaxTimeline({...input,segments:[{...input.segments[0],seedMode:'unknown'}]}),/种子方式/);
});
test('新随机请求使用原项目范围，原种子仅保留在编辑数据，恢复种子不重新抽取',()=>{
 const input=timeline();input.segments[0].seedMode='random';const before=structuredClone(input);
 for(const seed of [0,MINIMAX_RANDOM_SEED_MAX-1]){
  const choice=materializeMinimaxSeed(input,{draw:()=>seed});assert.equal(choice.timeline.segments[0].seed,seed);assert.equal(choice.timeline.segments[0].seedMode,undefined);
  assert.deepEqual(choice.record,{version:1,mode:'random',segmentId:'clip',seed});
  assert.deepEqual(materializeMinimaxSeed(input,{seed,draw:()=>assert.fail('recovery must not draw')}),choice);
 }
 for(const seed of [-1,MINIMAX_RANDOM_SEED_MAX,1.5,NaN])assert.throws(()=>materializeMinimaxSeed(input,{seed}),/随机种子/);
 assert.deepEqual(input,before);assert.equal(minimaxRandomMode(input),true);
});
test('复用结果和显式逐轮种子会切换执行副本为固定，原随机设置保留',()=>{
 const input=timeline();input.segments[0].seedMode='random';const next=applyMinimaxLoopValues(input,{seed:77,prompt:'可复用参数'});
 assert.equal(next.segments[0].seedMode,undefined);assert.equal(next.segments[0].seed,77);assert.equal(input.segments[0].seedMode,'random');
 const original=normalizeMinimaxTimeline({...input,segments:[{...input.segments[0],resultAssetId:'result',resultAssetIds:['result'],resultVariants:[{assetId:'result',parameters:{prompt:'已提交',duration:1,aspectRatio:'9:16',megapixels:.5,seed:77}}]}]});
 assert.equal(original.segments[0].resultVariants[0].roundIndex,undefined);
 for(const pair of [{loopId:'loop'},{roundIndex:1}])assert.throws(()=>normalizeMinimaxTimeline({...original,segments:[{...original.segments[0],resultVariants:[{...original.segments[0].resultVariants[0],...pair}]}]}),/结果记录/);
});
test('实际工作流参数来自提交图，Comfy原生迁移默认随机，RunningHub旧来源保持固定',()=>{
 const input=timeline(),built=compileMinimaxH3(input,h3Workflow,{project:{assets:[]}});built.graph['129'].inputs.noise_seed=99;built.graph['138'].inputs.value='实际提交文字';built.graph['115'].inputs.aspect_ratio='9:16 (Portrait)';
 assert.deepEqual(minimaxSubmittedParameters(built.graph),{prompt:'实际提交文字',duration:8,aspectRatio:'9:16',megapixels:.4,seed:99});
 const native={type:'minimax',minimaxEngine:'comfyui',segments:[{id:'clip',start:0,duration:1,prompt:'原生'}]};
 for(const type of ['minimax','smart-minimax'])assert.equal(minimaxFromNative({...native,type},()=>null,'owned').segments[0].seedMode,'random');
 assert.equal(minimaxFromNative({...native,minimaxEngine:'runninghub'},()=>null,'owned').segments[0].seedMode,undefined);
});
