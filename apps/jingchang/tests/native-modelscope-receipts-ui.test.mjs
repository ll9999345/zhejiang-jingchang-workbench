import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeCascadePlanMarkup,nativeCascadeRequestMarkup} from '../public/native-cascade-ui.js';
const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const marker={version:1,modelKey:'custom',acceptsImages:true};
test('串联计划展示实际WxH及逐份独立请求数量，非ModelScope不加该收据',()=>{
 const plan={summary:{operations:1,generations:1,requests:3,sharedCopies:0},program:{},steps:[{title:'node',cascadeKind:'generate',count:3,studio:{config:{nativeModelscope:marker,size:'641x1279',count:3}}}]};
 const html=nativeCascadePlanMarkup(plan,esc);assert.match(html,/ModelScope · 641x1279/);assert.match(html,/最多 3 次独立请求/);delete plan.steps[0].studio;assert.equal(nativeCascadePlanMarkup(plan,esc).includes('native-modelscope-receipt'),false);
});
test('实际收据区分尝试/接受/完成份数，逐份原编号和未知接受状态均显示并转义',()=>{
 const step={actualInput:{referenceRefs:[],unusedRefs:[],modelscope:{nativeModelscope:marker,count:3,size:'641x1279',referenceAssetIds:['ref']}},childRequests:{kind:'modelscope',count:3,attempted:3,submitted:2,completed:1,items:[{index:0,status:'completed',upstreamId:'original-id'},{index:1,status:'pending',upstreamId:'<script>secret-free</script>'},{index:2,status:'failed'}]}};
 const html=nativeCascadeRequestMarkup(step,esc);assert.match(html,/已尝试 3 \/ 3 次 · 已接受 2 \/ 3 次 · 已完成 1 \/ 3 份/);assert.match(html,/实际使用 1 张参考图/);assert.match(html,/第 1 份 · 结果已保存 · 原编号 original-id/);assert.match(html,/第 3 份 · 已停止，需核对原任务 · 未收到可查询编号/);assert.match(html,/&lt;script&gt;/);assert.equal(html.includes('<script>'),false);assert.match(html,/未收到编号的份数不会补发/);
});
test('Comfy列表和单图放大收据保持各自字段与原编号展示',()=>{
 const step={actualInput:{referenceRefs:[{kind:'image',assetId:'a',name:'source'}],unusedRefs:[],enhancement:{kind:'upscale',resolution:4096,maxResolution:4096,seedMode:'workflow',sourceAssetId:'a'},promptBatch:{values:['literal <p>']},providerRequestCount:1},childRequests:{submitted:1,items:[{promptId:'comfy-original'}]}};
 const html=nativeCascadeRequestMarkup(step,esc);assert.match(html,/单图放大 · 4K/);assert.match(html,/提示词列表 · 1 条 · 已提交 1 \/ 1 次请求/);assert.match(html,/原编号 comfy-original/);assert.match(html,/literal &lt;p&gt;/);assert.equal(html.includes('native-modelscope-receipt'),false);
});
