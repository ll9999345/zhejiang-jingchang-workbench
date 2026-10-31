import {createRequire} from 'node:module';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {localServer} from './helpers/library-backup-server.mjs';
import {studioModelChoiceKey} from '../public/studio-model-catalog-core.js';
const require=createRequire('/Users/mjd-ppps/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');
const {chromium}=require('playwright');
const stage=path.resolve(process.env.STUDIO_SERVICE_EVIDENCE||'artifacts/studio-service-browser-'+Date.now());
await fs.mkdir(path.join(stage,'screenshots'),{recursive:true});
const platform={id:'9ce79a6e-5796-4904-9b05-2f069e046f1a',name:'喵喵中转站',protocol:'openai-compatible',baseUrl:'https://miaoapi.xyz/v1',models:[{id:'gpt-image-2.5-flare',label:'gpt-image-2.5-flare · MiaoAPI',category:'image'}]};
const alternate={...platform,id:'4e7ff9ce-af03-4f26-9155-91fc2e5b7419',name:'备用模型服务',baseUrl:'https://alternate.example/v1',models:[{id:'gpt-image-1',category:'image'}]};
const discovery=[{id:'gpt-image-2.5-flare'},{id:'gpt-image-2.5-sunburst'},{id:'seedance-2.0-fast'},{id:'MiniMax-H3'},{id:'MiniMax-M2'},{id:'unclassified-model'}];
let app,browser,page,requests=[],outside=[],errors=[],checks=[];
try{
 app=await localServer(path.join(stage,'isolated-data'));
 let studio=await app.api('/api/studios','POST',{name:'模型接入本地隔离验收',mode:'image'});
 studio=await app.api('/api/studios/'+studio.id,'PUT',{...studio,prompt:'湖面倒映晨光',config:{...studio.config,model:'gpt-image-2.5-flare',baseUrl:''}});
 browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--no-sandbox','--disable-gpu']});
 const context=await browser.newContext({viewport:{width:1440,height:1000},colorScheme:'light'});
 let discovered=false,mockJob=null,holdDiscovery=false,releaseDiscovery=null,discoveryPending=false,holdStudioId=null,releaseStudio=null,studioRequestPending=false;
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&!['data:','blob:'].includes(url.protocol)){outside.push(url.origin);return route.abort();}
  if(holdStudioId&&url.pathname==='/api/studios/'+holdStudioId&&route.request().method()==='GET'){studioRequestPending=true;await new Promise(resolve=>releaseStudio=resolve);studioRequestPending=false;return route.continue();}
  if(url.pathname==='/api/studio-catalog')return route.fulfill({json:{platforms:[platform,alternate],discoveredByPlatform:discovered?{[platform.id]:discovery}:{},credentialStatus:{configured:true,source:'macos-keychain',checkedWithoutReadingSecret:true}}});
  if(url.pathname==='/api/studio-models'&&route.request().method()==='POST'){requests.push({kind:'catalog',body:route.request().postDataJSON()});if(holdDiscovery){discoveryPending=true;await new Promise(resolve=>releaseDiscovery=resolve);discoveryPending=false;}discovered=true;return route.fulfill({json:{models:discovery,platformId:platform.id}});}
  if(url.pathname==='/api/miao-credentials/status')return route.fulfill({json:{configured:true,source:'macos-keychain',checkedWithoutReadingSecret:true}});
  if(url.pathname==='/api/studios/'+studio.id+'/generate'){requests.push({kind:'generate',body:route.request().postDataJSON()});mockJob={id:'ef9e51cb-09e6-4e02-8973-16d6dd5bfe48',kind:'studio',studioId:studio.id,status:'failed',message:'仅本地模拟，不会发起上游生成',assets:[],input:{studio:await app.api('/api/studios/'+studio.id)}};return route.fulfill({status:202,json:mockJob});}if(mockJob&&url.pathname==='/api/jobs/'+mockJob.id)return route.fulfill({json:mockJob});
  return route.continue();
 });
 page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(app.base+'/creation-studio.html?project='+studio.id);
 await page.waitForFunction(()=>document.querySelector('#save-indicator')?.textContent==='已保存到本机工作区');
 await page.locator('#view-list').click();await page.locator('[data-list-node=config]').click();
 const imageKey=studioModelChoiceKey({platformId:platform.id,id:'gpt-image-2.5-sunburst'});
 await page.locator('#studio-service-model option[value="'+imageKey+'"]').waitFor({state:'attached'});
 const options=await page.locator('#studio-service-model option').allTextContents();
 assert.ok(options.some(s=>s.includes('gpt-image-2.5-flare')));assert.ok(options.some(s=>s.includes('gpt-image-2.5-sunburst')));assert.ok(options.every(s=>!/seedance|MiniMax|unclassified|喵喵|MiaoAPI/.test(s)));
 checks.push('图片模式启动读取真实保存型号及只读目录；过滤对话、视频、未知型号与重复品牌');
 await page.locator('#studio-service-model').selectOption(imageKey);
 await page.waitForFunction(()=>document.querySelector('#save-indicator')?.textContent==='已保存到本机工作区');
 const saved=await app.api('/api/studios/'+studio.id);assert.equal(saved.config.platformId,platform.id);assert.equal(saved.config.model,'gpt-image-2.5-sunburst');assert.equal(saved.config.baseUrl,platform.baseUrl);assert.equal(saved.config.protocol,'studio');
 checks.push('选择同时保存准确模型ID、平台ID、服务地址与接口');
 await page.screenshot({path:path.join(stage,'screenshots','image-catalog-desktop.png')});
 await page.locator('#open-connect').click();await page.locator('#connect-platform').waitFor();assert.equal(await page.locator('#connect-platform').inputValue(),platform.id);assert.equal(await page.locator('#connect-source').inputValue(),'miao-local');assert.equal(await page.locator('#connect-key').isVisible(),false);assert.equal(await page.locator('#connect-url').isVisible(),false);assert.doesNotMatch(await page.locator('#dialog-body').innerText(),/喵喵|MiaoAPI/);await page.locator('[data-dialog-action=cancel]').click();
 checks.push('已登记服务无需手填网址或密钥；本机钥匙串来源仅发送标记');
 await page.locator('#generate-button').click();await page.locator('#generation-budget').fill('1');await page.locator('#authorize-send').check();await page.locator('#authorize-budget').check();assert.equal(await page.locator('#generate-source').inputValue(),'miao-local');await page.locator('[data-dialog-action=submit-generation]').click();await page.waitForFunction(()=>document.querySelector('#job-message')?.textContent.includes('仅本地模拟'));
 const generated=requests.find(r=>r.kind==='generate')?.body;assert.equal(generated.credentialSource,'miao-local');assert.equal(generated.credentialConsent,true);assert.equal(generated.apiKey,'');assert.equal(generated.authorization.model,'gpt-image-2.5-sunburst');assert.equal(generated.authorization.origin,'https://miaoapi.xyz');assert.equal(generated.authorization.requestLimit,1);assert.equal(generated.authorization.budget,1);await page.locator('[data-dialog-action=close]').click();
 checks.push('本地拦截生成payload包含准确ID、既有凭据标记和一次预算授权；未调用上游');
 await page.locator('#open-connect').click();await page.locator('#connect-platform').waitFor();holdDiscovery=true;await page.locator('[data-dialog-action=discover]').click();while(!discoveryPending)await new Promise(resolve=>setTimeout(resolve,10));await page.locator('#connect-platform').selectOption(alternate.id);await page.locator('#connect-key').fill('synthetic-current-dialog-key');releaseDiscovery();while(discoveryPending)await new Promise(resolve=>setTimeout(resolve,10));await page.waitForTimeout(100);assert.equal(await page.locator('#connect-platform').inputValue(),alternate.id);assert.equal(await page.locator('#connect-url').inputValue(),alternate.baseUrl);assert.equal(await page.locator('#connect-model').inputValue(),'gpt-image-1');assert.equal(await page.locator('#connect-key').inputValue(),'synthetic-current-dialog-key');await page.locator('[data-dialog-action=cancel]').click();checks.push('慢目录返回不覆盖后来选择的平台、模型、地址或新输入的临时密钥');
 await page.locator('#mode-video').click();await page.locator('[data-list-node=config]').click();
 const videoOptions=await page.locator('#studio-service-model option').evaluateAll(els=>els.map(el=>({text:el.textContent,disabled:el.disabled})));
 assert.ok(videoOptions.some(o=>o.text.includes('seedance-2.0-fast')&&o.disabled));assert.ok(videoOptions.some(o=>o.text.includes('MiniMax-H3')&&o.disabled));assert.ok(videoOptions.every(o=>!/MiniMax-M2|unclassified|gpt-image/.test(o.text)));
 await page.screenshot({path:path.join(stage,'screenshots','video-unverified-desktop.png')});
 checks.push('真实目录中的未核实视频型号清楚显示且禁止运行，不伪造Seedance或H3协议');
 await page.setViewportSize({width:390,height:844});await page.locator('#mobile-right-toggle').click();await page.locator('#studio-service-model').scrollIntoViewIfNeeded();const bounds=await page.locator('#studio-service-model').boundingBox();assert.ok(bounds.width<390);assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');assert.equal(await page.locator('html').getAttribute('data-studio-service-build'),'2026.10.09-service.1');await page.screenshot({path:path.join(stage,'screenshots','video-catalog-phone.png')});
 checks.push('390px下选择器保持蓝紫液态和可操作尺寸');
 const projectB=await app.api('/api/studios','POST',{name:'隔离项目B',mode:'image'}),projectC=await app.api('/api/studios','POST',{name:'隔离项目C',mode:'image'});await page.evaluate(async()=>{document.querySelector('#open-connect').click();});await page.locator('#connect-platform').waitFor();await page.locator('[data-dialog-action=cancel]').click();await page.reload();await page.waitForFunction(()=>document.querySelector('#save-indicator')?.textContent==='已保存到本机工作区');holdStudioId=projectB.id;await page.locator('#project-select').selectOption(projectB.id);while(!studioRequestPending)await new Promise(resolve=>setTimeout(resolve,10));await page.locator('#project-select').selectOption(projectC.id);await page.waitForURL('**project='+projectC.id);releaseStudio();while(studioRequestPending)await new Promise(resolve=>setTimeout(resolve,10));await page.waitForTimeout(100);assert.ok(page.url().includes(projectC.id));assert.equal(await page.locator('#project-select').inputValue(),projectC.id);checks.push('较慢旧项目响应不会覆盖用户最后选择的新项目');
 assert.equal(requests.filter(r=>r.kind==='catalog').length,3);assert.deepEqual(outside,[]);assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(stage,'result.json'),JSON.stringify({pass:true,checks,requests,outside,errors,paidCalls:0,mediaUploads:0,realProjectChanges:0},null,2));console.log(JSON.stringify({stage,checks:checks.length,pass:true}));
}catch(e){await fs.writeFile(path.join(stage,'failure.json'),JSON.stringify({message:e.message,stack:e.stack,requests,outside,errors,checks},null,2));if(page)await page.screenshot({path:path.join(stage,'failure.png')}).catch(()=>{});throw e;}
finally{await browser?.close();await app?.stop();}
