import {createRequire} from 'node:module';
import {spawn,execFileSync} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import assert from 'node:assert/strict';

const require=createRequire('/Users/mjd-ppps/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json'),{chromium}=require('playwright');
const root=process.cwd(),artifacts=path.join(root,'artifacts','prompt-mentions-qa-'+Date.now());await fs.mkdir(artifacts,{recursive:true});
const png=execFileSync('ffmpeg',['-v','error','-nostdin','-f','lavfi','-i','testsrc=size=180x120:rate=1','-frames:v','1','-threads','1','-update','1','-f','image2pipe','-vcodec','png','pipe:1']);
const reservation=http.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
const dataDir=path.join(artifacts,'data'),server=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),JINGCHANG_DATA_DIR:dataDir,JINGCHANG_LLM_URL:'',JINGCHANG_LLM_MODEL:''},stdio:['ignore','pipe','pipe']});
let browser,page;const errors=[],remoteRequests=[];const base='http://127.0.0.1:'+port;
async function start(){await Promise.race([once(server.stdout,'data'),once(server,'exit').then(()=>{throw Error('server exited before startup');}),new Promise((_,reject)=>setTimeout(()=>reject(Error('startup timeout')),8000).unref())]);}
async function api(route,method='get',data){const response=await page.request[method](base+route,{data});assert.ok(response.ok(),await response.text());return response.json();}
try{
 await start();browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});page=await browser.newPage({viewport:{width:1440,height:1000},baseURL:base});
 page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(!request.url().startsWith(base+'/'))remoteRequests.push(request.url());});
 let project=await api('/api/projects','post',{name:'提示词图片引用浏览器验收'});const node=project.nodes[0];node.type='text';node.title='镜头提示词';node.text='描绘主角与环境';node.params={};project=await api('/api/projects/'+project.id,'put',project);
 const assets=[];for(const name of ['角色参考.png','青绿风格.png']){const response=await page.request.post(base+'/api/assets?name='+encodeURIComponent(name),{data:png,headers:{'Content-Type':'image/png'}});assert.ok(response.ok(),await response.text());assets.push(await response.json());}
 await page.goto('/?project='+project.id);await page.locator('[data-select="'+node.id+'"]').click();await page.locator('#prompt-mention-wrap').waitFor();const input=page.locator('.panel [data-field="text"]');
 await input.fill('描绘主角：@');await page.locator('[data-prompt-asset]').nth(1).waitFor();assert.equal(await page.locator('[data-prompt-asset]').count(),2);
 const chosenId=await page.locator('[data-prompt-asset]').nth(1).getAttribute('data-prompt-asset'),chosen=assets.find(asset=>asset.id===chosenId);assert.ok(chosen);
 await input.press('ArrowDown');await input.press('Enter');assert.equal(await input.inputValue(),'描绘主角：@'+chosen.name);
 await page.locator('[data-remove-prompt-asset="'+chosen.id+'"]').waitFor();await page.waitForFunction(()=>document.querySelector('#save-status')?.textContent==='已保存到本机');
 project=await api('/api/projects/'+project.id);assert.deepEqual(project.nodes[0].params.promptAssetIds,[chosen.id]);assert.ok(project.assets.some(asset=>asset.id===chosen.id));assert.ok(await page.locator('.prompt-reference-chip img').getAttribute('src')==='/media/'+chosen.id);
 await page.screenshot({path:path.join(artifacts,'01-mentioned-image.png')});await page.reload();await page.locator('[data-select="'+node.id+'"]').click();await page.locator('[data-remove-prompt-asset="'+chosen.id+'"]').waitFor();
 await page.locator('[data-remove-prompt-asset="'+chosen.id+'"]').click();await page.waitForFunction(()=>document.querySelector('#save-status')?.textContent==='已保存到本机');project=await api('/api/projects/'+project.id);assert.equal(project.nodes[0].text,'描绘主角：@'+chosen.name);assert.equal(project.nodes[0].params.promptAssetIds,undefined);
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(artifacts,'02-mobile-inspector.png')});
 assert.deepEqual(errors,[]);assert.deepEqual(remoteRequests,[]);await fs.writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:true,checks:['global library @ lookup','keyboard navigation and selection','selected asset linked to project and prompt saved','selection persists after reload','chip removal unlinks without erasing prompt text','mobile layout has no horizontal overflow','no remote requests or page errors'],chosenAsset:chosen.name,pageErrors:errors,remoteRequests},null,2));console.log(JSON.stringify({passed:true,artifacts,checks:7}));
}catch(error){if(page){await page.screenshot({path:path.join(artifacts,'failure.png')});console.error('Toast',await page.locator('#toast').textContent().catch(()=>''));}throw error;}finally{await browser?.close();server.kill('SIGTERM');}
