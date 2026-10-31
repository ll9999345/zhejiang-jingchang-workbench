import './helpers/local-network-only.mjs';
import {createRequire} from 'node:module';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const NATIVE='http://127.0.0.1:4768',BRIDGE='http://127.0.0.1:4750';
const permittedOrigins=new Set([NATIVE,BRIDGE]);
const expectedCascadeSha='e196efda4b5638c9ae6ecbed7a0cc2681d200b016bd1397902d8632c35e47b25';
const base=path.join(process.cwd(),'artifacts/modelscope-browser-integration-20261007-continued/formal-readonly-browser');
let output=base;
try{await fs.mkdir(output);}catch(e){if(e.code!=='EEXIST')throw e;output=base+'-'+Date.now();await fs.mkdir(output);}
const require=createRequire('/Users/mjd-ppps/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');
const {chromium}=require('playwright');
const result={startedAt:new Date().toISOString(),evidenceKind:'formal_local_readonly',source:BRIDGE+'/canvas',output,health:{},staticSources:[],checks:[],screenshots:[],pageErrors:[],consoleErrors:[],blocked:[],requests:[],httpErrors:[],projectId:null,navigationAttempts:0,paidCalls:0,externalProviderRequests:0,formalWrites:0,realSecretsRead:0,realPhoneOrGpu:false,limits:['headless Chrome with --disable-gpu, not physical phone or GPU acceptance','formal service has not been reloaded by this script','no generation, model discovery, imports, save or provider requests','new candidate UI may load from disk while cached backend capabilities are older; reported separately']};
let browser,page;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function localRead(url,asJson=false){
 const u=new URL(url);if(!permittedOrigins.has(u.origin))throw Error('metadata outside permitted loopback origins');
 const response=await fetch(u,{method:'GET',signal:AbortSignal.timeout(6000)});
 result.requests.push({source:'node-metadata',method:'GET',origin:u.origin,path:u.pathname,status:response.status});
 const bytes=Buffer.from(await response.arrayBuffer());
 if(!response.ok)return{status:response.status,error:'local GET returned '+response.status};
 if(asJson){const value=JSON.parse(bytes.toString());return{status:response.status,version:value.version||null,capabilities:value.capabilities||{},ok:value.ok};}
 return{status:response.status,sha256:hash(bytes),bytes:bytes.length};
}
async function inspect(){return page.evaluate(()=>{
 const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth&&s.visibility!=='hidden'&&s.display!=='none'&&Number(s.opacity)!==0;};
 const nodes=[...document.querySelectorAll('.app .node')];
 const host=document.querySelector('.jc-aurora');
 let field=null;try{field=host?.dreamField?.inspect?.()||null;}catch{}
 return{url:location.href,projectId:new URL(location.href).searchParams.get('project'),viewport:{width:innerWidth,height:innerHeight},documentWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,hasHorizontalOverflow:document.documentElement.scrollWidth>innerWidth+1,unified:document.body.hasAttribute('data-unified-canvas'),theme:document.documentElement.dataset.theme,bodyClasses:document.body.className,ambientMotion:document.body.dataset.ambientMotion||null,ambientQuality:document.body.dataset.ambientQuality||null,ambientReason:document.body.dataset.ambientReason||null,sampleFps:document.body.dataset.ambientSampleFps||null,ambientSampleStatic:document.body.dataset.ambientSampleStatic||null,liquid:{host:!!host,status:host?.dataset.glassStatus||null,fieldGlobal:!!window.StudioDreamField,glassGlobal:!!window.StudioDreamGlassScene,surfaces:document.querySelectorAll('[data-glass-surface]').length,foreground:document.querySelectorAll('.studio-dream-foreground').length,field},canvas:{nodes:nodes.length,visibleNodes:nodes.filter(visible).length,topbarVisible:!!document.querySelector('.app .topbar')&&visible(document.querySelector('.app .topbar')),railVisible:!!document.querySelector('.app .rail')&&visible(document.querySelector('.app .rail')),dockVisible:!!document.querySelector('.app .dock')&&visible(document.querySelector('.app .dock')),saveStatus:document.querySelector('#save-status')?.textContent.trim()||null},scripts:[...document.scripts].map(s=>s.src).filter(Boolean),styles:[...document.querySelectorAll('link[rel=stylesheet]')].map(e=>e.href),moduleResponses:performance.getEntriesByType('resource').filter(e=>/native-cascade-ui|native-modelscope-core|unified|dream-field/.test(e.name)).map(e=>({url:e.name,duration:e.duration}))};
 });}
async function screenshot(name,target=page){
 const file=path.join(output,name);await target.screenshot({path:file,timeout:10000,animations:'disabled'});const bytes=await fs.readFile(file);
 result.screenshots.push({file,sha256:hash(bytes),bytes:bytes.length,width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20),provenance:'actual formal local UI pixels, no mock configuration, no synthetic overlay or edits',viewport:page.viewportSize()});
}
function check(name,passed,details){result.checks.push({name,passed,details});}
try{
 result.health.native=await localRead(NATIVE+'/api/health',true);
 result.health.bridge=await localRead(BRIDGE+'/canvas-module/api/health',true);
 for(const name of ['native-cascade-ui.js','native-modelscope-core.js','unified.js','unified.css']){
  const url=BRIDGE+'/canvas-module/'+name,value=await localRead(url);
  result.staticSources.push({name,url,...value,expectedSha256:name==='native-cascade-ui.js'?expectedCascadeSha:undefined});
 }
 const cascade=result.staticSources.find(s=>s.name==='native-cascade-ui.js');
 check('formal-cascade-static-sha-matches-root-seal',cascade.status===200&&cascade.sha256===expectedCascadeSha,cascade);
 const core=result.staticSources.find(s=>s.name==='native-modelscope-core.js');check('native-modelscope-core-static-available',core.status===200,core);
 browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--disable-gpu','--disable-dev-shm-usage','--disable-background-networking','--disable-sync','--no-first-run']});
 result.browser={version:browser.version(),rendererMode:'headless --disable-gpu software rendering; no physical GPU claim',userProfile:'fresh isolated context, no user Chrome profile'};
 const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url()),method=request.method();
  const item={method,origin:url.origin,path:url.pathname};
  if(method!=='GET'){result.blocked.push({...item,reason:'non-GET'});return route.abort();}
  if(!permittedOrigins.has(url.origin)){result.blocked.push({...item,reason:'external-or-unapproved-origin'});return route.abort();}
  if(/\/(?:api\/)?(?:platforms|settings|api-providers|credentials|miao-credentials|ark-credentials|secrets|keychain)(?:\/|$)/i.test(url.pathname)){result.blocked.push({...item,reason:'credential-or-platform-config-privacy'});return route.abort();}
  if(/\/api\/jobs(?:\/|$)/.test(url.pathname)){result.blocked.push({...item,reason:'background-job-maintenance-disabled'});return route.abort();}
  result.requests.push({...item,source:'browser'});return route.continue();
 });
 page=await context.newPage();page.setDefaultTimeout(6500);page.on('pageerror',e=>result.pageErrors.push(e.message));page.on('console',m=>{if(m.type()==='error')result.consoleErrors.push(m.text().slice(0,500));});
 page.on('response',r=>{if(r.status()>=400){const u=new URL(r.url());result.httpErrors.push({origin:u.origin,path:u.pathname,status:r.status()});}});
 result.navigationAttempts++;let navigationError=null;
 try{await page.goto(BRIDGE+'/canvas',{waitUntil:'domcontentloaded',timeout:15000});}catch(e){navigationError=e.message;}
 result.navigationError=navigationError;
 // At most one bounded navigation. If it times out, inspect its existing page.
 try{await page.locator('.app .node').first().waitFor({state:'attached',timeout:7500});}catch(e){result.canvasWaitError=e.message;}
 result.desktop=await inspect();result.projectId=result.desktop.projectId;
 check('formal-existing-canvas-node-and-chrome-visible',result.desktop.canvas.nodes>0&&result.desktop.canvas.visibleNodes>0&&result.desktop.canvas.topbarVisible&&result.desktop.canvas.railVisible,result.desktop.canvas);
 check('unified-liquid-entry-still-mounted',result.desktop.unified&&result.desktop.liquid.host&&result.desktop.liquid.fieldGlobal,{...result.desktop.liquid,ambientMotion:result.desktop.ambientMotion,ambientQuality:result.desktop.ambientQuality});
 check('desktop-no-horizontal-overflow',!result.desktop.hasHorizontalOverflow,{viewport:result.desktop.viewport,documentWidth:result.desktop.documentWidth});
 await screenshot('01-formal-canvas-desktop.png');
 await page.setViewportSize({width:390,height:844});
 result.mobile=await inspect();check('390-no-horizontal-overflow',!result.mobile.hasHorizontalOverflow,{viewport:result.mobile.viewport,documentWidth:result.mobile.documentWidth});await screenshot('02-formal-canvas-390.png');
 await page.setViewportSize({width:1440,height:1000});
 const assets=page.locator('.rail [data-view="assets"]');
 if(await assets.count()&&await assets.isVisible()){
  await assets.click();const openCatalog=page.locator('[data-action="asset-catalog"]');
  try{await openCatalog.waitFor({state:'visible',timeout:6500});
   const saved=await page.locator('#save-status').textContent();result.beforeCatalogSaveStatus=saved?.trim()||null;
   if(/^(已保存到本机工作区|已保存到本机)$/.test(result.beforeCatalogSaveStatus)){
    await openCatalog.click();const dialog=page.locator('#asset-catalog-dialog');await dialog.waitFor({state:'visible',timeout:6500});
    await dialog.locator('[data-catalog-mode="backups"]').click();const summary=dialog.locator('summary').filter({hasText:'迁入原版 Infinite Canvas 素材库'});await summary.waitFor({state:'visible',timeout:6500});await summary.click();
    result.libraryInitial=await dialog.evaluate(d=>{const root=d.querySelector('#catalog-native-library-import');const input=root?.querySelector('[data-native-library="source"]');return{entryVisible:!!root&&!!root.querySelector('summary'),sourceEmpty:input?.value==='',previewDisabled:root?.querySelector('[data-native-library="preview"]')?.disabled??null,importButtonPresent:!!root?.querySelector('[data-native-library="import"]'),status:root?.querySelector('[role=status]')?.textContent||'',sourceInputPresent:!!input,dialogWidth:d.getBoundingClientRect().width,viewportWidth:innerWidth,documentWidth:document.documentElement.scrollWidth};});
    check('native-library-import-entry-visible-without-submit',result.libraryInitial.entryVisible&&result.libraryInitial.sourceEmpty&&result.libraryInitial.previewDisabled&&!result.libraryInitial.importButtonPresent,result.libraryInitial);
    await screenshot('03-formal-library-import-desktop.png',dialog);
    await page.setViewportSize({width:390,height:844});
    result.libraryMobile=await dialog.evaluate(d=>({dialogWidth:d.getBoundingClientRect().width,dialogScrollWidth:d.scrollWidth,documentWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth,sourceEmpty:d.querySelector('[data-native-library="source"]')?.value==='',previewDisabled:d.querySelector('[data-native-library="preview"]')?.disabled??null}));
    check('library-390-no-horizontal-overflow',result.libraryMobile.documentWidth<=390&&result.libraryMobile.dialogWidth<=390&&result.libraryMobile.dialogScrollWidth<=Math.ceil(result.libraryMobile.dialogWidth)+1,result.libraryMobile);
    await screenshot('04-formal-library-import-390.png',dialog);
   }else result.libraryStopped='Page is not in saved/clean state; no catalog click that could save project';
  }catch(e){result.libraryStopped=e.message;}
 }else result.libraryStopped='No existing pure UI asset-library entry; no project created';
 result.backendCandidateFlags={nativeModelscopeBatch:result.health.native.capabilities?.nativeModelscopeBatch===true,nativeLibraryImport:result.health.native.capabilities?.nativeLibraryImport===true,bridgeNativeModelscopeBatch:result.health.bridge.capabilities?.nativeModelscopeBatch===true,bridgeNativeLibraryImport:result.health.bridge.capabilities?.nativeLibraryImport===true};
 result.deploymentConclusion=Object.values(result.backendCandidateFlags).every(Boolean)?'health flags present; generation/import not exercised':'new backend flags not loaded at observation; do not treat as product failure or deployed candidate';
 check('no-formal-mutation-provider-or-secret-read',!result.blocked.some(x=>x.reason==='non-GET'),{blockedMutationAttempts:result.blocked.filter(x=>x.reason==='non-GET').length,allowedMethods:[...new Set(result.requests.map(r=>r.method))],paidCalls:0,formalWrites:0,providerRequests:0});
 check('no-pageerror',result.pageErrors.length===0,result.pageErrors);
 result.uiPassed=result.checks.every(c=>c.passed);result.completedAt=new Date().toISOString();
}catch(e){result.error=e.message;result.uiPassed=false;result.completedAt=new Date().toISOString();}
finally{await fs.writeFile(path.join(output,'result.json'),JSON.stringify(result,null,2)+'\n');await browser?.close();}
console.log(JSON.stringify({output,uiPassed:result.uiPassed,checks:result.checks.map(c=>({name:c.name,passed:c.passed})),screenshots:result.screenshots.map(s=>s.file),health:result.health,backendCandidateFlags:result.backendCandidateFlags,error:result.error||null,libraryStopped:result.libraryStopped||null,pageErrors:result.pageErrors,blocked:result.blocked}));
