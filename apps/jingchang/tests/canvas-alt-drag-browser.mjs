import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {makeNode} from '../lib/model.mjs';

const require=createRequire('/Users/mjd-ppps/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');
const {chromium}=require('playwright');
const root=process.cwd(),artifacts=path.join(root,'artifacts','canvas-alt-drag-qa-'+Date.now());
await fs.mkdir(artifacts,{recursive:true});
const reservation=http.createServer();
reservation.listen(0,'127.0.0.1');
await once(reservation,'listening');
const port=reservation.address().port;
await new Promise(resolve=>reservation.close(resolve));
const server=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),JINGCHANG_DATA_DIR:path.join(artifacts,'data'),JINGCHANG_LLM_URL:'',JINGCHANG_LLM_MODEL:''},stdio:['ignore','pipe','pipe']});
let browser,page;
try{
  await Promise.race([once(server.stdout,'data'),once(server,'exit').then(()=>{throw Error('server exited');}),new Promise((_,reject)=>setTimeout(()=>reject(Error('startup timeout')),8000).unref())]);
  browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  page=await browser.newPage({viewport:{width:1440,height:960},baseURL:'http://127.0.0.1:'+port});
  await page.goto('/');
  await page.waitForSelector('.node');
  const project=await(await page.request.post('/api/projects',{data:{name:'Alt 拖动复制验收'}})).json();
  const a=makeNode('image',100,110,{title:'组内上游'}),b=makeNode('image',420,150,{title:'组内下游'});
  const c=makeNode('image',760,110,{title:'外部上游'}),d=makeNode('image',760,420,{title:'外部下游'});
  project.nodes=[a,b,c,d];
  project.edges=[
    {id:'internal-edge',source:a.id,target:b.id},
    {id:'incoming-edge',source:c.id,target:a.id},
    {id:'outgoing-edge',source:b.id,target:d.id}
  ];
  project.groups=[{id:'original-group',title:'镜头组',nodeIds:[a.id,b.id],color:'#78905b',collapsed:false}];
  project.viewport={x:10,y:10,zoom:1};
  const write=await page.request.put('/api/projects/'+project.id,{data:project});
  assert.ok(write.ok(),await write.text());
  await page.reload();
  await page.waitForSelector('.node-group');
  assert.equal(await page.locator('.node').count(),4);

  async function dragCopy(keys){
    const header=page.locator(`[data-node="${a.id}"] .node-header`),box=await header.boundingBox();
    assert.ok(box);
    const start={x:box.x+box.width/2,y:box.y+box.height/2};
    const save=page.waitForResponse(response=>response.url().endsWith('/api/projects/'+project.id)&&response.request().method()==='PUT');
    for(const key of keys)await page.keyboard.down(key);
    await page.mouse.move(start.x,start.y);
    await page.mouse.down();
    await page.mouse.move(start.x+120,start.y+75,{steps:8});
    await page.mouse.up();
    for(const key of [...keys].reverse())await page.keyboard.up(key);
    await save;
    await page.waitForFunction(()=>document.querySelectorAll('.node').length===6&&document.querySelectorAll('.node-group').length===2);
    return(await page.request.get('/api/projects/'+project.id)).json();
  }

  async function undoCopy(expectedEdges){
    const save=page.waitForResponse(response=>response.url().endsWith('/api/projects/'+project.id)&&response.request().method()==='PUT');
    await page.keyboard.press('Meta+z');
    await page.waitForFunction(()=>document.querySelectorAll('.node').length===4&&document.querySelectorAll('.node-group').length===1);
    await save;
    const saved=await(await page.request.get('/api/projects/'+project.id)).json();
    assert.equal(saved.edges.length,expectedEdges);
  }

  const altOnly=await dragCopy(['Alt']);
  const firstGroup=altOnly.groups.find(group=>group.id!=='original-group');
  assert.ok(firstGroup);
  assert.deepEqual(firstGroup.nodeIds,altOnly.nodes.slice(4).map(node=>node.id));
  assert.equal(altOnly.edges.length,3,'Alt alone must not copy any connections');
  for(const id of firstGroup.nodeIds){
    const node=altOnly.nodes.find(item=>item.id===id),original=node.title==='组内上游'?a:b;
    assert.equal(node.x-original.x,120);
    assert.equal(node.y-original.y,75);
  }
  await undoCopy(3);

  const altShift=await dragCopy(['Alt','Shift']);
  const copiedGroup=altShift.groups.find(group=>group.id!=='original-group');
  assert.ok(copiedGroup);
  assert.equal(copiedGroup.title,'镜头组（副本）');
  assert.deepEqual(copiedGroup.nodeIds,altShift.nodes.slice(4).map(node=>node.id));
  const [copyA,copyB]=copiedGroup.nodeIds;
  const copiedEdges=altShift.edges.filter(edge=>!project.edges.some(original=>original.id===edge.id));
  assert.equal(altShift.edges.length,5);
  assert.ok(copiedEdges.some(edge=>edge.source===copyA&&edge.target===copyB),'Alt+Shift must copy internal group connections');
  assert.ok(copiedEdges.some(edge=>edge.source===c.id&&edge.target===copyA),'Alt+Shift must preserve incoming connections');
  assert.ok(!copiedEdges.some(edge=>edge.source===copyB&&edge.target===d.id),'Alt+Shift must not copy outgoing connections');
  await undoCopy(3);
  console.log(JSON.stringify({passed:true,artifacts,checks:[
    'Alt+drag copies the node group and preserves group metadata without connections',
    'Alt+Shift+drag preserves internal and incoming connections, but not outgoing connections',
    'copies move and persist, and one undo removes the complete copy'
  ]}));
}catch(error){if(page)await page.screenshot({path:path.join(artifacts,'failure.png')});throw error;}
finally{await browser?.close();server.kill('SIGTERM');}
