import './helpers/local-network-only.mjs';import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';import vm from 'node:vm';
import {canvasPastePlacement,canvasPasteAnchor,canvasClipboardSnapshot,prepareCanvasPaste} from '../public/canvas-clipboard-core.js';import {copySelectedNodes} from '../lib/canvas-tools.mjs';import {fragmentPlacement,mergeCanvasFragment,fragmentMaps} from '../lib/canvas-fragments.mjs';import {makeProject} from '../lib/model.mjs';import {smartDragFixture} from './helpers/smart-drag-fixture.mjs';
const source=await readFile('tests/fixtures/reference/01-smart-canvas.js.reference','utf8');assert.equal(createHash('sha256').update(source).digest('hex'),'5a5fc55e1f8a47a47904e767341d59b831b6cdebd503365bcf95037efc178a84');
const start=source.indexOf('    const xs = sourceNodes.map',source.indexOf('function pasteNodes(){')),end=source.indexOf('    const idMap',start);assert(start>=0&&end>start);const geometry=source.slice(start,end);
test('固定源纯坐标段：节点原点中心对齐指针，卡片尺寸与选区顺序不影响结果',()=>{
 for(const point of [{x:1200,y:900},{x:-730.5,y:420.25},{x:0,y:0}])for(const ids of [['image','prompt'],['prompt','image','loop']]){
  const f=smartDragFixture(),clip=canvasClipboardSnapshot(f.p,ids.map(f.id)),rows=clip.nodeIds.map(id=>f.p.nodes.find(n=>n.id===id)),ctx=vm.createContext({sourceNodes:rows,lastMouseWorld:point,viewportCenter:()=>({x:99,y:88})},{codeGeneration:{strings:false,wasm:false}});const expected=JSON.parse(vm.runInContext(geometry+'JSON.stringify({dx,dy})',ctx,{timeout:250})),actual=canvasPastePlacement(clip,{anchor:point});assert.deepEqual({dx:actual.dx,dy:actual.dy},expected);assert.equal(actual.x,Math.min(...rows.map(n=>n.x))+expected.dx);
 }
});
test('同工程与子图插入采用同一位移，原生坐标同步、视图与原节点保留',()=>{
 const f=smartDragFixture(),clip=canvasClipboardSnapshot(f.p,f.p.nodes.map(n=>n.id)),anchor={x:1200,y:900},before=structuredClone(f.p),local=prepareCanvasPaste(f.p,clip,{copyNodes:copySelectedNodes,anchor}),placement=fragmentPlacement(f.p,f.p,local.placement),cross=mergeCanvasFragment(f.p,f.p,fragmentMaps(f.p),local.placement);
 for(let i=0;i<f.p.nodes.length;i++){const a=local.project.nodes[f.p.nodes.length+i],b=cross.project.nodes[f.p.nodes.length+i];assert.equal(a.x,b.x);assert.equal(a.y,b.y);assert.equal(a.params.nativeCanvas.node.x,a.x);assert.equal(a.params.nativeCanvas.node.y,a.y);assert.equal(a.x,f.p.nodes[i].x+placement.dx);assert.equal(a.y,f.p.nodes[i].y+placement.dy);}
 assert.deepEqual(local.project.viewport,before.viewport);assert.deepEqual(local.project.nodes.slice(0,f.p.nodes.length),before.nodes);assert.deepEqual(f.p,before);
});
test('连续粘贴在相同指针位置重叠但编号独立，不随pasteCount漂移；旧调用仍保留偏移',()=>{
 const f=smartDragFixture(),clip=canvasClipboardSnapshot(f.p,f.p.nodes.map(n=>n.id)),anchor={x:500,y:600},first=prepareCanvasPaste(f.p,clip,{copyNodes:copySelectedNodes,anchor});clip.pasteCount=999;const second=prepareCanvasPaste(first.project,clip,{copyNodes:copySelectedNodes,anchor});assert.deepEqual(second.project.nodes.slice(-3).map(n=>[n.x,n.y]),first.project.nodes.slice(-3).map(n=>[n.x,n.y]));assert.equal(new Set(second.project.nodes.map(n=>n.id)).size,9);clip.pasteCount=0;assert.deepEqual(canvasPastePlacement(clip),{x:40,y:40,dx:40,dy:40});
});
test('未移动指针与切换工程回退当前视图中心，缩放与平移正确换算',()=>{
 const viewport={x:-130,y:75,zoom:.5},options={projectId:'new',viewport,width:1000,height:800};assert.deepEqual(canvasPasteAnchor(options),{x:1260,y:650});assert.deepEqual(canvasPasteAnchor({...options,pointer:{projectId:'old',x:1,y:2}}),{x:1260,y:650});assert.deepEqual(canvasPasteAnchor({...options,pointer:{projectId:'new',x:301,y:-22}}),{x:301,y:-22});assert.throws(()=>canvasPasteAnchor({...options,viewport:{...viewport,zoom:0}}),/尺寸/);
});
test('非法、超范围指针和遗失选区拒绝，不改原工程或剪贴板',()=>{
 const f=smartDragFixture(),clip=canvasClipboardSnapshot(f.p,[f.id('prompt'),f.id('image')]),before=structuredClone(clip),target=makeProject();for(const anchor of [{x:Infinity,y:0},{x:0,y:NaN},{x:1e7,y:0},null])assert.throws(()=>prepareCanvasPaste(target,clip,{copyNodes:copySelectedNodes,anchor}),/坐标|超出/);assert.deepEqual(clip,before);assert.equal(target.nodes.length,1);assert.throws(()=>canvasPastePlacement({...clip,nodeIds:['missing']},{anchor:{x:0,y:0}}),/坐标/);
});
