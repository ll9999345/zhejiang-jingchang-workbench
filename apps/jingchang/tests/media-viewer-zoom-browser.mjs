import {createRequire} from 'node:module';
import {spawn,execFileSync} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import assert from 'node:assert/strict';

const require=createRequire('/Users/mjd-ppps/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');
const {chromium}=require('playwright');
const root=process.cwd(),artifacts=path.join(root,'artifacts','media-viewer-zoom-qa-'+Date.now());
await fs.mkdir(artifacts,{recursive:true});
const png=execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=240x160:rate=1','-frames:v','1','-f','image2pipe','-c:v','png','pipe:1']);
const reservation=http.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(r=>reservation.close(r));
const dataDir=path.join(artifacts,'data'),server=spawn(process.execPath,['server.mjs'],{cwd:root,env:{PATH:process.env.PATH||'',PORT:String(port),JINGCHANG_DATA_DIR:dataDir,JINGCHANG_LLM_URL:'',JINGCHANG_LLM_MODEL:''},stdio:['ignore','pipe','pipe']});
let browser,page;const errors=[];
try{
  await Promise.race([once(server.stdout,'data'),once(server,'exit').then(()=>{throw Error('server exited');}),new Promise((_,reject)=>setTimeout(()=>reject(Error('startup timeout')),8000).unref())]);
  browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:960},baseURL:'http://127.0.0.1:'+port});page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  const api=async(route,method='get',data)=>{const r=await page.request[method](route,{data});assert.ok(r.ok(),await r.text());return r.json();};
  let project=await api('/api/projects','post',{name:'图片缩放验收'});const assets=[];
  for(const name of ['晨雾.png','灯会.png']){const response=await page.request.post('/api/assets?name='+encodeURIComponent(name),{data:png,headers:{'Content-Type':'image/png'}});assert.ok(response.ok(),await response.text());const asset=await response.json();assets.push(asset);project.assets.push(asset);}
  project.runs.push({id:'local-image-run',assetIds:[assets[0].id],assetReferences:[{assetId:assets[0].id,referenceAssetIds:[assets[1].id]}]});
  project=await api('/api/projects/'+project.id,'put',project);
  await page.goto('/?project='+project.id);await page.locator('.tabs [data-view="assets"]').click();
  const first=page.locator('.asset-card [data-preview-image]').first();await first.click();
  const image=page.locator('#media-viewer [data-viewer-image]'),zoom=page.locator('#media-viewer [data-viewer-zoom]');
  await image.waitFor();await zoom.waitFor();assert.equal(await zoom.textContent(),'100%');assert.equal(await page.locator('[data-viewer-name]').textContent(),'晨雾.png');
  const compare=page.locator('#media-viewer [data-viewer-compare]');await compare.waitFor();assert.equal(await compare.isVisible(),true);await compare.click();await page.locator('#media-viewer-compare').waitFor();assert.equal(await page.locator('[data-compare-reference]').isVisible(),true);assert.match(await page.locator('[data-compare-before]').getAttribute('src'),new RegExp(assets[1].id));assert.match(await page.locator('[data-compare-after]').getAttribute('src'),new RegExp(assets[0].id));const sliderFits=await page.evaluate(()=>{const root=document.querySelector('#media-viewer-compare').getBoundingClientRect(),slider=document.querySelector('[data-compare-split]').getBoundingClientRect();return slider.bottom<=root.bottom;});assert.equal(sliderFits,true,'the comparison slider is visible without scrolling');await page.screenshot({path:path.join(artifacts,'comparison-dialog.png')});await page.locator('[data-compare-split]').fill('73');assert.equal(await page.locator('[data-compare-value]').textContent(),'73%');assert.equal(await page.locator('#media-compare-stage').evaluate(el=>el.style.getPropertyValue('--split')),'73%');await page.locator('#modal [data-action="close-modal"]').first().click();
  const media=page.locator('[data-viewer-media]');
  const anchor=await media.evaluate(el=>{const r=el.getBoundingClientRect(),point={x:r.left+r.width*.72,y:r.top+r.height*.28},read=()=>{const box=el.getBoundingClientRect(),z=Number(el.dataset.viewerScale),px=Number(el.dataset.viewerPanX),py=Number(el.dataset.viewerPanY);return{x:(point.x-box.left-box.width/2-px)/z,y:(point.y-box.top-box.height/2-py)/z};},before=read();el.querySelector('img').dispatchEvent(new WheelEvent('wheel',{deltaY:-120,clientX:point.x,clientY:point.y,bubbles:true,cancelable:true}));return{before,after:read()};});
  assert.equal(await zoom.textContent(),'110%');assert.ok(Math.abs(anchor.before.x-anchor.after.x)<1&&Math.abs(anchor.before.y-anchor.after.y)<1,'wheel zoom stays anchored within one CSS pixel '+JSON.stringify(anchor));
  await media.evaluate(el=>{const img=el.querySelector('img'),r=el.getBoundingClientRect();for(let i=0;i<30;i++)img.dispatchEvent(new WheelEvent('wheel',{deltaY:-120,clientX:r.left+r.width/2,clientY:r.top+r.height/2,bubbles:true,cancelable:true}));});assert.equal(await zoom.textContent(),'600%');
  await media.evaluate(el=>{const img=el.querySelector('img'),r=el.getBoundingClientRect();for(let i=0;i<40;i++)img.dispatchEvent(new WheelEvent('wheel',{deltaY:120,clientX:r.left+r.width/2,clientY:r.top+r.height/2,bubbles:true,cancelable:true}));});assert.equal(await zoom.textContent(),'100%');
  await media.evaluate(el=>{const img=el.querySelector('img'),r=el.getBoundingClientRect();for(let i=0;i<10;i++)img.dispatchEvent(new WheelEvent('wheel',{deltaY:-120,clientX:r.left+r.width/2,clientY:r.top+r.height/2,bubbles:true,cancelable:true}));});
  const panBox=await media.boundingBox();assert.ok(panBox);const center={x:panBox.x+panBox.width/2,y:panBox.y+panBox.height/2};await page.mouse.move(center.x,center.y);await page.mouse.down();await page.mouse.move(center.x+70,center.y+35,{steps:3});await page.mouse.up();
  const pan=await media.evaluate(el=>({x:Number(el.dataset.viewerPanX),y:Number(el.dataset.viewerPanY)}));assert.ok(Math.abs(pan.x)>30||Math.abs(pan.y)>20);assert.equal(await page.locator('[data-viewer-name]').textContent(),'晨雾.png');
  await media.dispatchEvent('dblclick',{bubbles:true,cancelable:true});assert.equal(await zoom.textContent(),'100%');assert.equal(await media.getAttribute('data-viewer-pan-x'),'0');assert.equal(await media.getAttribute('data-viewer-pan-y'),'0');
  await image.dispatchEvent('wheel',{deltaY:-120,clientX:center.x,clientY:center.y,bubbles:true,cancelable:true});await page.locator('[data-viewer-zoom-reset]').click();assert.equal(await zoom.textContent(),'100%');
  assert.deepEqual(errors,[]);await fs.writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:true,checks:['wheel zoom is anchored at the pointer','zoom clamps at 100% and 600%','drag pans without switching media','double click resets zoom and pan','reset button is an accessible alternative','generation preview opens the saved local reference and result','comparison slider updates the split position'],browserErrors:errors},null,2));console.log(JSON.stringify({passed:true,artifacts,checks:7}));
}catch(error){if(page)await page.screenshot({path:path.join(artifacts,'failure.png')});throw error;}finally{await browser?.close();server.kill('SIGTERM');}
