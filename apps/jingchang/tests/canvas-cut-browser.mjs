import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import assert from 'node:assert/strict';
const require=createRequire('/Users/mjd-ppps/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');
const {chromium}=require('playwright');
const root=process.cwd(),artifacts=path.join(root,'artifacts','canvas-cut-qa-'+Date.now());
await fs.mkdir(artifacts,{recursive:true});
const reservation=http.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
const server=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),JINGCHANG_DATA_DIR:path.join(artifacts,'data'),JINGCHANG_LLM_URL:'',JINGCHANG_LLM_MODEL:''},stdio:['ignore','pipe','pipe']});
let browser,page;const errors=[];
try{
  await Promise.race([once(server.stdout,'data'),once(server,'exit').then(()=>{throw Error('server exited');}),new Promise((_,reject)=>setTimeout(()=>reject(Error('startup timeout')),8000).unref())]);
  browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  page=await browser.newPage({viewport:{width:1440,height:960},baseURL:'http://127.0.0.1:'+port});page.on('pageerror',e=>errors.push(e.message));
  const api=async(route,method='get',data)=>{const response=await page.request[method](route,{data});assert.ok(response.ok(),await response.text());return response.json();};
  await page.goto('/');await page.waitForSelector('.node');
  const projects=await api('/api/projects');let project=await api('/api/projects/'+projects[0].id);
  const source={...project.nodes[0],id:'cut-source',type:'text',title:'连线起点',text:'',x:100,y:240,assetId:null,params:{...(project.nodes[0].params||{})}};
  const target={...source,id:'cut-target',title:'连线终点',x:650};
  project={...project,nodes:[source,target],groups:[],edges:[{id:'cut-edge',source:source.id,target:target.id}],viewport:{x:0,y:0,zoom:1}};
  project=await api('/api/projects/'+project.id,'put',project);await page.goto('/?project='+project.id);await page.waitForFunction(()=>document.querySelector('[data-edge-geometry="cut-edge"]'));
  const crossing=await page.locator('[data-edge-geometry="cut-edge"]').evaluate(path=>{const point=path.getPointAtLength(path.getTotalLength()/2),screen=new DOMPoint(point.x,point.y).matrixTransform(path.getScreenCTM());return{x:screen.x,y:screen.y};});
  await page.keyboard.down('Shift');await page.mouse.move(crossing.x,crossing.y-42);await page.mouse.down();await page.mouse.move(crossing.x,crossing.y+42,{steps:12});await page.mouse.up();await page.keyboard.up('Shift');
  await page.waitForFunction(()=>document.querySelector('#toast')?.textContent.includes('已切断 1 条连线'));
  await page.waitForFunction(()=>document.querySelector('#save-status')?.textContent==='已保存到本机');
  project=await api('/api/projects/'+project.id);assert.equal(project.edges.length,0,'crossed edge should be removed and saved');
  await page.keyboard.press('Meta+z');await page.waitForFunction(()=>document.querySelector('#save-status')?.textContent==='已保存到本机');
  project=await api('/api/projects/'+project.id);assert.equal(project.edges.length,1,'undo should restore the removed edge');
  const canvas=await page.locator('#canvas').boundingBox();await page.keyboard.down('r');await page.mouse.move(canvas.x+30,canvas.y+200);await page.mouse.down();await page.mouse.move(canvas.x+980,canvas.y+430,{steps:8});await page.mouse.up();await page.keyboard.up('r');assert.equal(await page.locator('.node.selected').count(),2,'R-drag should preserve marquee selection');
  const originalTransform=await page.locator('#world').evaluate(el=>el.style.transform);await page.keyboard.press('z');assert.notEqual(await page.locator('#world').evaluate(el=>el.style.transform),originalTransform,'Z should fit a temporary overview');assert.equal(await page.locator('body').evaluate(el=>el.classList.contains('canvas-zoom-preview')),true);await page.keyboard.press('z');assert.equal(await page.locator('#world').evaluate(el=>el.style.transform),originalTransform,'second Z should restore the prior view');assert.equal(await page.locator('body').evaluate(el=>el.classList.contains('canvas-zoom-preview')),false);await page.waitForFunction(()=>document.querySelector('#toast')?.textContent==='已恢复原画布视图');
  await page.screenshot({path:path.join(artifacts,'01-cut-and-undo.png')});assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:true,checks:['shift-drag crosses and removes a canvas connection','cut change auto-saves into the isolated local project','undo restores the exact connection','R-drag still selects nodes','Z overview preview restores the exact prior viewport','no browser errors'],projectId:project.id},null,2));
  console.log(JSON.stringify({passed:true,artifacts}));
}catch(error){if(page){await page.screenshot({path:path.join(artifacts,'failure.png')});console.error('toast:',await page.locator('#toast').textContent());console.error('page errors:',errors);}throw error;}
finally{await browser?.close();server.kill('SIGTERM');}
