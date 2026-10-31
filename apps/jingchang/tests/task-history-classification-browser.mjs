// Real production API export/import and read-only UI in isolated local data.
// Classification inference alone is simulated; no remote service is contacted.
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {makeProject} from '../lib/model.mjs';
import {atomicJson,readJson,storeAsset,loadAsset} from '../lib/workspace.mjs';
import {assetClassificationService} from '../lib/asset-classification.mjs';
import {assetClassificationReceiptStore} from '../lib/asset-classification-receipts.mjs';
import {projectBundleService} from '../lib/project-bundles.mjs';
import {taskHistoryArchiveService} from '../lib/task-history-archive.mjs';
import './helpers/local-network-only.mjs';

const root=process.cwd(),stage=path.join(root,'artifacts','classification-history-browser-'+Date.now());await fs.mkdir(stage);
const data=await fs.mkdtemp(path.join(os.tmpdir(),'jingchang-classification-archive-browser-'));
const sourceData=await fs.mkdtemp(path.join(os.tmpdir(),'jingchang-classification-archive-source-'));
const sourceNames=['server.mjs','lib/task-history-archive.mjs','lib/task-history-schema.mjs','lib/asset-classification-history.mjs','lib/asset-classification.mjs','lib/asset-classification-receipts.mjs','public/task-history-archive.js','public/classification-history-view.js','public/style.css','tests/task-history-classification-browser.mjs'];
const sha=b=>createHash('sha256').update(b).digest('hex'),sources=async()=>Object.fromEntries(await Promise.all(sourceNames.map(async f=>[f,sha(await fs.readFile(path.join(root,f)))])));
const sourceBefore=await sources(),checks=[],network=[],external=[],pageErrors=[],downloads=[];let browser,child,page,base,modelCalls=0;const logs=[];
async function ownedStop(){if(child&&child.exitCode===null){const c=child;child=null;const exited=once(c,'exit');c.kill('SIGTERM');await exited;}}
async function start(){
 const reservation=http.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(r=>reservation.close(r));base='http://127.0.0.1:'+port;
 child=spawn(process.execPath,['--import',path.join(root,'tests/helpers/local-network-only.mjs'),'server.mjs'],{cwd:root,env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'zh_CN.UTF-8',PORT:String(port),JINGCHANG_DATA_DIR:data,JINGCHANG_LLM_URL:'',JINGCHANG_LLM_MODEL:''},stdio:['ignore','pipe','pipe']});
 for(const stream of [child.stdout,child.stderr])stream.on('data',b=>logs.push(fs.appendFile(path.join(stage,'backend.log'),b)));
 const until=Date.now()+30000;while(Date.now()<until){try{if((await api('/api/health')).ok)return;}catch{}if(child.exitCode!==null)throw Error('Owned isolated backend exited');await new Promise(r=>setTimeout(r,100));}throw Error('Owned backend did not become ready');
}
async function api(route,options={}){const r=await fetch(base+route,options);assert.ok(r.ok,'Local API '+route+' returned '+r.status);return r.json();}
async function seed(){
 const projects={load:id=>readJson(path.join(sourceData,'projects',id,'project.json')),save:async p=>{await atomicJson(path.join(sourceData,'projects',p.id,'project.json'),p);return p;}};
 const p=makeProject('分类原记录迁移 · 本机验收'),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGbcAAAAASUVORK5CYII=','base64');
 await fs.mkdir(path.join(sourceData,'assets'));const asset=await storeAsset(sourceData,png,{name:'隔离测试图片.png',type:'image/png'});p.assets=[asset];p.nodes[0].assetId=asset.id;await projects.save(p);
 const platform={id:'loopback-vision',protocol:'openai-compatible',baseUrl:'http://127.0.0.1:18889/v1',models:[{id:'vision-fixture',category:'chat',referenceSupport:true}]};
 for(const [id,state]of [['a-completed','completed'],['b-failed','failed'],['c-uncertain','uncertain']]){
  const service=assetClassificationService({data:sourceData,platforms:{get:async()=>platform},apiCall:async()=>{modelCalls++;if(state!=='completed')throw Object.assign(new Error('simulated model failure'),state==='failed'?{upstreamStatus:401}:{});return{choices:[{finish_reason:'stop',message:{content:JSON.stringify({summary:'隔离示例 <img src=x onerror="window.archiveXss=1">',categories:{environment:['室外'],custom_theme:['江南']},tags:['文旅']})}}]};}});
  const b={requestId:id,projectId:p.id,platformId:platform.id,model:'vision-fixture',apiKey:'',consent:true,authorization:{origin:'http://127.0.0.1:18889',model:'vision-fixture',sendImage:true,requestLimit:1,budget:0,currency:'CNY',consent:true}};
  await service.classify(asset.id,b).catch(e=>{if(state==='completed')throw e;assert.equal(e.classificationTask?.status,state);});assert.equal((await service.get(id)).status,state);
 }
 const store=assetClassificationReceiptStore(sourceData),row=await store.read('a-completed'),pending={...structuredClone(row),id:'d-cancelled',requestId:'d-cancelled',status:'queued'};delete pending.result;delete pending.sendIntentAt;delete pending.finishedAt;await store.write(pending,{create:true});await assetClassificationService({data:sourceData,platforms:{get:async()=>platform}}).cancel(pending.id);
 p.assets=[await loadAsset(sourceData,asset.id)];await projects.save(p);await atomicJson(path.join(sourceData,'projects',p.id,'history','0-snapshot.json'),p);
 const bundles=projectBundleService({data:sourceData,projects,activeJobs:new Map()}),history=taskHistoryArchiveService({data:sourceData,projects,activeJobs:new Map(),projectBundles:bundles});const receipt=await history.exportArchive(p.id,p.revision);assert.equal(receipt.complete,true);assert.equal(receipt.classifications,4);const file=await history.download(receipt.id);
 await fs.writeFile(path.join(stage,'source-export.json'),JSON.stringify(receipt,null,2),{flag:'wx'});
 return{file,p,asset,png,initial:null};
}
async function openArchive(){
 await page.locator('button[data-action="history"]').click();await page.locator('[data-action="list-task-history"]').click();await page.locator('[data-action="read-task-history"]').click();await page.locator('[data-classification-history]>summary').waitFor();
 await page.locator('[data-classification-history]>summary').focus();await page.keyboard.press('Enter');
 assert.equal(await page.locator('[data-classification-history-id]').count(),4);await page.locator('[data-classification-history-id="a-completed"]>summary').focus();await page.keyboard.press('Enter');
}
try{
 const fixture=await seed();await start();fixture.initial=await api('/api/projects',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'独立目标入口'})});
 const {chromium}=createRequire('/Users/mjd-ppps/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json')('playwright');
 browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-gpu','--disable-background-networking']});
 const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true,serviceWorkers:'block',locale:'zh-CN'});
 await context.route('**/*',route=>{const r=route.request(),u=new URL(r.url());if(u.origin!==base){external.push({path:u.pathname,origin:u.origin});return route.abort();}network.push({method:r.method(),path:u.pathname});return route.continue();});
 page=await context.newPage();page.on('pageerror',e=>pageErrors.push(e.message));await page.goto(base+'/?project='+fixture.initial.id);await page.locator('.app').waitFor();
 await page.locator('button[data-action="history"]').click();await page.locator('[data-action="import-task-history"]').click();await page.locator('#task-history-file').setInputFiles(fixture.file);await page.locator('[data-action="inspect-task-history"]').click();await page.locator('[data-action="restore-task-history"]').waitFor();
 assert.match(await page.locator('#modal').innerText(),/4 份图片分类记录/);checks.push('actual uploaded archive preview counts all four original classification outcomes');
 await page.locator('[data-action="restore-task-history"]').click();await page.waitForURL(u=>u.searchParams.get('project')&&u.searchParams.get('project')!==fixture.initial.id);await page.locator('.app').waitFor();const restoredId=new URL(page.url()).searchParams.get('project');
 const records=await api('/api/task-history-archives?projectId='+restoredId);assert.equal(records.length,1);const record=await api('/api/task-history-archives/'+records[0].id+'?projectId='+restoredId);assert.equal(record.classifications,4);assert.equal(record.canResume,false);assert.notEqual(restoredId,fixture.p.id);await fs.writeFile(path.join(stage,'restored-readonly.json'),JSON.stringify(record,null,2),{flag:'wx'});
 await openArchive();const completed=page.locator('[data-classification-history-id="a-completed"]');assert.match(await completed.innerText(),/江南/);assert.match(await completed.innerText(),/原请求编号：a-completed/);assert.equal(await page.evaluate(()=>window.archiveXss),undefined);assert.equal(await page.locator('#modal img').count(),0);assert.equal(await page.locator('#modal [data-action]').count(),1);checks.push('actual new-project import shows original service model media hash authorization and dynamic labels, with no generation or resume action and escaped model text');
 await page.screenshot({path:path.join(stage,'01-classification-history-desktop.png')});
 const [download]=await Promise.all([page.waitForEvent('download'),completed.locator('a[download]').click()]);const file=path.join(stage,'downloaded-original.png');await download.saveAs(file);assert.deepEqual(await fs.readFile(file),fixture.png);downloads.push({file,sha256:sha(await fs.readFile(file))});checks.push('read-only download returns the actual hash-matching original classification image');
 await page.locator('[data-classification-history-id="c-uncertain"]>summary').focus();await page.keyboard.press('Enter');assert.match(await page.locator('[data-classification-history-id="c-uncertain"]').innerText(),/不会重新发送/);checks.push('uncertain remains explicitly unconfirmed and cannot be resumed from the archive');
 await page.keyboard.press('Escape');await page.setViewportSize({width:390,height:844});await page.emulateMedia({reducedMotion:'reduce'});await openArchive();await completed.scrollIntoViewIfNeeded();const layout=await page.evaluate(()=>{const d=document.querySelector('#modal'),r=document.querySelector('.task-history-record');return{viewport:innerWidth,dialog:d.getBoundingClientRect().toJSON(),bodyWidth:r.clientWidth,bodyScrollWidth:r.scrollWidth,pageScrollWidth:document.documentElement.scrollWidth};});assert.ok(layout.dialog.left>=-1&&layout.dialog.right<=391);assert.ok(layout.bodyScrollWidth<=layout.bodyWidth+1&&layout.pageScrollWidth<=391);await fs.writeFile(path.join(stage,'mobile-layout.json'),JSON.stringify(layout,null,2),{flag:'wx'});await page.screenshot({path:path.join(stage,'02-classification-history-390.png')});await page.keyboard.press('Escape');assert.equal(await page.locator('#modal').evaluate(e=>e.open),false);checks.push('390px reduced-motion dialog, original hash/labels and keyboard Enter/Escape work without horizontal overflow');
 assert.deepEqual(await api('/api/jobs'),[]);assert.deepEqual(await api('/api/asset-classification-tasks'),[]);await context.close();await ownedStop();await start();const afterRestart=await api('/api/task-history-archives/'+record.id+'?projectId='+restoredId);assert.deepEqual(afterRestart.manifest,record.manifest);assert.deepEqual(await api('/api/jobs'),[]);assert.deepEqual(await api('/api/asset-classification-tasks'),[]);checks.push('a real backend process restart preserves the imported read-only receipt and creates no active classification or generation tasks');
 assert.equal(modelCalls,3);assert.equal(network.filter(r=>/classify|generate|resume|\/cancel/.test(r.path)).length,0);assert.deepEqual(pageErrors,[]);assert.deepEqual(external,[]);assert.deepEqual(await sources(),sourceBefore);
 const result={ok:true,date:new Date().toISOString(),scope:'Actual isolated classification/history services and real production UI; only model responses simulated',checks,modelCalls,paidCalls:0,external,network,pageErrors,downloads,sourceData,data,sourceBefore,sourceAfter:await sources(),sourceStable:true,originalProjectId:fixture.p.id,restoredProjectId:restoredId,archiveId:record.id,limitations:['No real cloud inference, billing, GPU or physical-phone acceptance','Imported classification receipts stay read-only in history archives; .jingchang project-only backup excludes task history']};
 await fs.writeFile(path.join(stage,'result.json'),JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify({ok:true,checks:checks.length,stage}));
}catch(e){if(page&&!page.isClosed())await page.screenshot({path:path.join(stage,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(stage,'failure.json'),JSON.stringify({ok:false,error:e.message,stack:e.stack,checks,network,external,pageErrors,data,sourceData,sourceBefore,sourceAfter:await sources()},null,2),{flag:'wx'});throw e;}
finally{await browser?.close();await ownedStop();await Promise.allSettled(logs);}
