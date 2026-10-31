import {createRequire} from 'node:module';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {once} from 'node:events';

const require=createRequire('/Users/mjd-ppps/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');
const {chromium}=require('playwright');
const root=process.cwd(),extensionDir=path.join(root,'tools','chrome-local-asset-importer');
const assets=[
  {url:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP9sAAAAASUVORK5CYII=',kind:'image',name:'角色.png',unsupported:false},
  {url:'data:image/jpeg;base64,/9j/2Q==',kind:'image',name:'场景.jpg',unsupported:false}
];
const state={imports:[],classifications:[],failClassification:false,preferences:[],pauseClassification:false,resumes:[],nextClassification:null};
const staticServer=http.createServer(async(req,res)=>{
  try{const relative=decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\/+/, '')||'popup.html';const file=path.resolve(extensionDir,relative);if(!file.startsWith(extensionDir+path.sep))throw new Error('bad path');const bytes=await fs.readFile(file);const type=file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'application/octet-stream';res.writeHead(200,{'content-type':type});res.end(bytes);}catch{res.writeHead(404);res.end('not found');}
});
staticServer.listen(0,'127.0.0.1');await once(staticServer,'listening');
const appOrigin='http://127.0.0.1:4768',popupOrigin=`http://127.0.0.1:${staticServer.address().port}`;
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const context=await browser.newContext({viewport:{width:430,height:900}});
await context.addInitScript(({appOrigin,assets,state})=>{
  window.__savedPreferences=state.preferences;
  window.__execScripts=[];
  Object.defineProperty(window,'chrome',{configurable:true,value:{
    storage:{local:{get:async()=>({serverUrl:appOrigin}),set:async value=>{window.__savedPreferences.push(value);}}},
    tabs:{query:async()=>[{id:7,windowId:1,title:'测试素材页',url:'https://assets.example.test/gallery'}]},
    scripting:{executeScript:async details=>{window.__execScripts.push({allFrames:details.target?.allFrames,frameIds:details.target?.frameIds});return[{frameId:0,result:{title:'测试素材页',frameOrigins:[],items:assets}}];}},
    permissions:{request:async()=>true},
    downloads:{download:async()=>1},
    runtime:{connect:()=>({postMessage(){},disconnect(){},onMessage:{addListener(){}},onDisconnect:{addListener(){}}})},
    sidePanel:{open:async()=>true}
  }});
},{appOrigin,assets,state});
const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
let externalRequests=0;
await context.route('https://**',route=>{externalRequests++;return route.abort();});
await context.route(appOrigin+'/**',async route=>{
  const request=route.request(),url=new URL(request.url()),headers={'Access-Control-Allow-Origin':popupOrigin,'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'content-type','Access-Control-Allow-Private-Network':'true','Vary':'Origin','Cache-Control':'no-store'};
  if(request.method()==='OPTIONS')return route.fulfill({status:204,headers});
  if(url.pathname==='/api/health')return route.fulfill({status:200,headers,contentType:'application/json',body:JSON.stringify({ok:true,version:'browser-test'})});
  if(url.pathname==='/api/chrome-import/classification-models')return route.fulfill({status:200,headers,contentType:'application/json',body:JSON.stringify({models:[{platformId:'local-vision',platformName:'本机',modelId:'local-vlm',modelName:'本机视觉模型',origin:'http://127.0.0.1:12000',local:true},{platformId:'external-vision',platformName:'外部模拟服务',modelId:'remote-vlm',modelName:'外部视觉模型',origin:'https://vision.example.test',local:false}]})});
  if(url.pathname==='/api/chrome-import'){
    const id=`asset-${state.imports.length+1}`;state.imports.push({id,contentType:request.headers()['content-type'],bytes:request.postDataBuffer()?.length||0});
    return route.fulfill({status:201,headers,contentType:'application/json',body:JSON.stringify({id,name:url.searchParams.get('name'),type:request.headers()['content-type'],size:request.postDataBuffer()?.length||0})});
  }
  if(/^\/api\/assets\/[^/]+\/classify$/.test(url.pathname)){
    const payload=request.postDataJSON();state.classifications.push(payload);
    if(state.pauseClassification)await new Promise(resolve=>{state.resumes.push(resolve);state.nextClassification?.();state.nextClassification=null;});
    if(state.failClassification)return route.fulfill({status:502,headers,contentType:'application/json',body:JSON.stringify({error:`模拟上游结果不确定，回显 ${payload.apiKey}`})});
    return route.fulfill({status:200,headers,contentType:'application/json',body:JSON.stringify({id:url.pathname.split('/')[3],classification:{summary:'本地模拟结果'}})});
  }
  return route.fulfill({status:404,headers,contentType:'application/json',body:JSON.stringify({error:'mock route missing'})});
});
try{
  await page.goto(popupOrigin+'/popup.html');
  await page.waitForFunction(()=>document.querySelector('#connection-status')?.textContent.includes('已连接'));
  assert.equal(await page.locator('#classify-after-import').isEnabled(),true);
  await page.locator('#scan').click();await page.locator('[data-entry-index]').first().waitFor({timeout:5000}).catch(async error=>{throw new Error(`scan failed: ${await page.locator('#connection-status').textContent()} | count=${await page.locator('#result-count').textContent()} | html=${await page.locator('#items').innerHTML()} | calls=${JSON.stringify(await page.evaluate(()=>window.__execScripts))} | ${errors.join('; ')} | ${error.message}`);});
  await page.locator('#classify-after-import').check();await page.locator('#classification-model').selectOption('1');
  assert.equal(await page.locator('#classification-key').getAttribute('required'), '');
  assert.equal(await page.locator('#classification-budget').getAttribute('required'), '');
  assert.match(await page.locator('#classification-summary').textContent(),/最多处理所选 2 张图片/);
  await page.locator('#import').click();await page.waitForFunction(()=>document.querySelector('#connection-status')?.textContent.includes('本次图片发送和费用授权'));
  assert.equal(state.imports.length,0);assert.equal(state.classifications.length,0);
  await page.locator('#classification-key').fill('sk-browser-mock-only');await page.locator('#classification-budget').fill('0.25');await page.locator('#classification-consent').check();
  state.pauseClassification=true;let reachedClassification=new Promise(resolve=>state.nextClassification=resolve);
  await page.locator('#import').click();await reachedClassification;assert.equal(await page.locator('#import').isDisabled(),true);
  reachedClassification=new Promise(resolve=>state.nextClassification=resolve);state.resumes.shift()();await reachedClassification;assert.equal(await page.locator('#import').isDisabled(),true);state.resumes.shift()();state.pauseClassification=false;
  await page.waitForFunction(()=>document.querySelector('#connection-status')?.textContent.includes('已保存 2/2'));
  assert.equal(state.imports.length,2);assert.equal(state.classifications.length,2);
  assert.ok(state.classifications.every(body=>body.apiKey==='sk-browser-mock-only'&&body.authorization.requestLimit===1&&body.authorization.sendImage===true&&body.authorization.budget===0.25&&body.consent===true));
  const savedPreferences=await page.evaluate(()=>window.__savedPreferences);assert.ok(!JSON.stringify(savedPreferences).includes('sk-browser-mock-only'));assert.equal(externalRequests,0);

  state.failClassification=true;await page.reload();await page.waitForFunction(()=>document.querySelector('#connection-status')?.textContent.includes('已连接'));
  await page.locator('#scan').click();await page.locator('[data-entry-index]').first().waitFor();
  await page.locator('#classify-after-import').check();await page.locator('#classification-model').selectOption('1');
  await page.locator('#classification-key').fill('sk-browser-mock-only');await page.locator('#classification-budget').fill('0.25');await page.locator('#classification-consent').check();
  const callsBefore=state.classifications.length,importsBefore=state.imports.length;
  await page.locator('#import').click();await page.waitForFunction(()=>document.querySelector('#connection-status')?.textContent.includes('没有自动重试'));
  assert.equal(state.imports.length-importsBefore,2);assert.equal(state.classifications.length-callsBefore,1);assert.equal(externalRequests,0);
  assert.equal(await page.locator('#classification-key').inputValue(),'');assert.ok(!(await page.locator('#connection-status').textContent()).includes('sk-browser-mock-only'));assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,checks:19,imports:state.imports.length,classificationRequests:state.classifications.length,failedRunNoRetry:true,duplicateSubmitBlocked:true,keyEchoRedacted:true,externalRequests,errors}));
}finally{await context.close();await browser.close();await new Promise(resolve=>staticServer.close(resolve));}
