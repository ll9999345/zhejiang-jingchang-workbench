import './helpers/local-network-only.mjs';
import assert from 'node:assert/strict';import {promises as fs} from 'node:fs';import path from 'node:path';import {randomUUID,createHash} from 'node:crypto';import {createRequire} from 'node:module';
import {nativeRoundMediaFixture} from './helpers/native-round-media-fixture.mjs';
import {ownedSmartFixture} from './helpers/smart-group-owned-fixture.mjs';
import {nativeReferencePlan} from '../lib/native-flow-execution.mjs';
import {localServer,persistFixture} from './helpers/library-backup-server.mjs';
const stage=path.resolve('artifacts','legacy-native-input-browser-'+Date.now()),data=path.join(stage,'data'),errors=[],external=[],writes=[];
await fs.mkdir(stage,{recursive:true});const owned=await ownedSmartFixture(data),f=nativeRoundMediaFixture({start:1,batch:2,count:2,producerCount:5});f.p.assets=owned.p.assets;
for(const n of f.p.nodes){if(n.assetId)n.assetId=owned.mapping.get(n.assetId);const v=n.params.nativeCanvas;v.mediaAssetIds=v.mediaAssetIds.map(id=>owned.mapping.get(id));for(const r of v.resources)r.assetId=owned.mapping.get(r.assetId);}
f.p.name='旧任务素材序号 · 隔离检查';f.p.viewport={x:40,y:100,zoom:.6};
const node=f.node('target'),referenceSources=[{sourceNodeId:f.loop.id}],contexts={[f.loop.id]:{index:3,total:4}},plan=nativeReferencePlan(f.p,node,referenceSources,{planning:true,loopContexts:contexts}),details=structuredClone(plan.details);delete details[0].producerIndices;
const job={id:randomUUID(),projectId:f.p.id,kind:'canvas-run',name:'旧切片任务',status:'interrupted',createdAt:new Date().toISOString(),message:'原任务已中断，已有上游素材保留。',assets:[f.p.assets[0]],snapshot:f.p,steps:[{kind:'image-api',nodeId:node.id,title:'旧切片消费者',status:'pending',nativeLoop:{contexts},image:{referenceSources},nativeReferences:{version:1,kinds:plan.kinds,details}}]};
await persistFixture({data,p:f.p});await fs.mkdir(path.join(data,'jobs'),{recursive:true});const jobFile=path.join(data,'jobs',job.id+'.json');await fs.writeFile(jobFile,JSON.stringify(job));const projectFile=path.join(data,'projects',f.p.id,'project.json'),before={job:await fs.readFile(jobFile),project:await fs.readFile(projectFile)};
let server,browser,page;const {chromium}=createRequire('/Users/mjd-ppps/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json')('playwright');
try{
 server=await localServer(data,{envOverrides:{JINGCHANG_SMART_GROUP_MEDIA_TEST:'1'}});
 browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>{const r=route.request(),u=new URL(r.url());if(['http:','https:'].includes(u.protocol)&&u.hostname!=='127.0.0.1'){external.push(u.hostname);return route.abort();}if(!['GET','HEAD'].includes(r.method())){writes.push({method:r.method(),path:u.pathname});return route.abort();}return route.continue();});
 await page.goto(server.base+'/?project='+f.p.id,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>document.querySelector('main')?.inert===false);await page.keyboard.press('Escape');
 await page.locator('[data-action="tasks"]').first().click();await page.locator('[data-task="'+job.id+'"]').click();
 await page.getByText('旧任务素材需要重新核对',{exact:true}).waitFor();
 assert.match(await page.locator('#modal').innerText(),/旧确认序号：1、2；快照所需序号：3、4/);
 assert.equal(await page.locator('#modal [data-action="resume-canvas-run"]').count(),0);
 assert.equal(await page.locator('#modal [data-action="apply-partial-generation"]').count(),1);
 await page.locator('#modal').screenshot({path:path.join(stage,'desktop-review.png')});
 await page.setViewportSize({width:390,height:844});await page.emulateMedia({reducedMotion:'reduce'});await page.locator('#modal').screenshot({path:path.join(stage,'mobile-review.png')});
 const dialogOverflow=await page.locator('#modal').evaluate(e=>e.scrollWidth>e.clientWidth+1);assert.equal(dialogOverflow,false);
 assert.deepEqual(await fs.readFile(jobFile),before.job);assert.deepEqual(await fs.readFile(projectFile),before.project);
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(writes,[]);
 await fs.writeFile(path.join(stage,'receipt.json'),JSON.stringify({status:'passed',stage,scope:'real isolated Node/HTTP/UI, saved legacy fixture, owned PNG',oldIndices:[1,2],snapshotIndices:[3,4],resumeHidden:true,partialResultsEntryAvailable:true,partialApplyNotExecuted:true,taskUnchanged:true,projectUnchanged:true,errors,external,writes,dialogOverflow,modelCalls:0,paidCalls:0,thirdPartyUploads:0,taskSha256:createHash('sha256').update(before.job).digest('hex')},null,2));console.log(JSON.stringify({status:'passed',stage}));
}catch(e){if(page)await page.screenshot({path:path.join(stage,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(stage,'failure.json'),JSON.stringify({error:e.message,errors,external,writes},null,2));throw e;}
finally{await browser?.close();await server?.stop();}
