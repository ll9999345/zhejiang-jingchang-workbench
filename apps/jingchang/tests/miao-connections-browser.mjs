import './helpers/local-network-only.mjs';
import {createRequire} from 'node:module';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {directorTestServer} from './helpers/director-test-server.mjs';

const require=createRequire('/Users/mjd-ppps/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');
const {chromium}=require('playwright');
const root=process.cwd(),artifacts=path.join(root,'artifacts','ai-connections-20261007-1791350715621','browser');
const attempt=String(Date.now()),data=path.join(artifacts,'data-'+attempt);
await fs.mkdir(data,{recursive:true});
await fs.writeFile(path.join(data,'config.json'),JSON.stringify({agentProvider:'local',llmUrl:'',llmModel:'',comfyUrl:'http://127.0.0.1:8188',revision:0}));
const checks=[],screenshots=[],outside=[],errors=[],captured=[],metadataRequests=[];
let server,browser,page;
const previousNodeOptions=process.env.NODE_OPTIONS;
process.env.NODE_OPTIONS='--import='+path.join(root,'tests','helpers','local-network-only.mjs');

function check(label){checks.push(label);}
async function screenshot(name,caption){
  const file=path.join(artifacts,attempt+'-'+name);
  await page.evaluate(()=>{const parent=document.querySelector('dialog[open]')||document.body,banner=document.createElement('div');banner.dataset.testEvidenceLabel='';banner.textContent='接口验收·模拟配置｜未执行真实认证或生成';banner.style.cssText='position:absolute;top:6px;left:12px;right:12px;z-index:9999;text-align:center;pointer-events:none;font:10px/15px sans-serif;color:#bff9ff;';parent.append(banner);});
  await page.screenshot({path:file});await page.locator('[data-test-evidence-label]').evaluate(e=>e.remove());
  screenshots.push({file,caption,provenance:'actual isolated headless Chrome; self-created project and mocked credential metadata; test-only provenance watermark inserted into the screenshot DOM'});
}
async function api(route,method='GET',body){const r=await server.request(route,method,body);assert.ok(r.status>=200&&r.status<300,JSON.stringify(r.body));return r.body;}
async function waitLocalSource(scope){await scope.locator('[data-miao-source]').waitFor();await page.waitForFunction(()=>[...document.querySelectorAll('[data-miao-source] option[value="miao-local"]')].some(o=>!o.disabled));}
async function selectLocal(scope,input){const select=scope.locator('[data-miao-source]'),consent=scope.locator('[data-miao-consent]');
  assert.equal(await select.inputValue(),'manual');assert.equal(await input.isDisabled(),false);assert.equal(await consent.isChecked(),false);assert.equal(await consent.isVisible(),false);
  await input.fill('not-a-credential-ui-clear-only');await select.selectOption('miao-local');
  assert.equal(await input.inputValue(),'');assert.equal(await input.isDisabled(),true);assert.equal(await consent.isChecked(),false);assert.equal(await consent.isVisible(),true);
}
async function tabReachesSourceAndConsent(scope){
  const source=scope.locator('[data-miao-source]'),consent=scope.locator('[data-miao-consent]');
  await scope.locator('input,textarea,select,button').filter({visible:true}).first().focus();
  let sourceReached=false,consentReached=false;
  for(let i=0;i<60;i++){
    await page.keyboard.press('Tab');
    sourceReached ||= await source.evaluate(e=>document.activeElement===e);
    consentReached ||= await consent.evaluate(e=>document.activeElement===e);
    if(sourceReached&&consentReached)break;
  }
  assert.ok(sourceReached,'Tab must reach the credential-source selector');assert.ok(consentReached,'Tab must reach the explicit local-credential consent');
}
async function noProductionJobs(){assert.deepEqual(await api('/api/jobs'),[]);assert.deepEqual(await server.calls(),[]);}
async function assertCaptured(kind,expectedModel){
  const request=captured.filter(r=>r.kind===kind).at(-1);assert.ok(request,kind+' submission was intercepted');
  assert.equal(request.body.credentialSource,'miao-local');assert.equal(request.body.credentialConsent,true);assert.equal(request.body.apiKey,'');
  if(expectedModel)assert.equal(request.body.model,expectedModel);
  assert.ok(!JSON.stringify(request.body).includes('not-a-credential-ui-clear-only'));
  return request;
}
async function failToast(text){await page.waitForFunction(pattern=>new RegExp(pattern).test(document.querySelector('#toast')?.textContent||''),text);}

try{
  server=await directorTestServer(data);
  let project=await api('/api/projects','POST',{name:'接口验收·模拟配置'});
  const seed=project.nodes[0];project.nodes=[{...seed,type:'image',title:'模拟接口图片节点',text:'自制验收文本：翡翠色玻璃方块，仅检查配置，不生成',params:{}}];project.edges=[];
  project=await api('/api/projects/'+project.id,'PUT',project);
  const platforms=await api('/api/platforms');
  const saved=await api('/api/platforms','PUT',{revision:platforms.revision,platform:{name:'喵喵 API · 模拟配置验收',protocol:'openai-compatible',baseUrl:'https://miaoapi.xyz/v1',models:[{id:'gpt-5.4-mini',label:'模拟对话 gpt-5.4-mini',category:'chat',referenceSupport:false},{id:'gpt-image-2',label:'模拟图片 gpt-image-2',category:'image',referenceSupport:false}]}});
  const platform=saved.platforms.at(-1);
  browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--disable-gpu','--disable-dev-shm-usage']});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&!['data:','blob:'].includes(url.protocol)){outside.push(url.origin);return route.abort();}
    if(url.pathname==='/api/miao-credentials/status'){metadataRequests.push('miao');return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({configured:true,source:'mock-metadata',containsCredentials:false,model:'gpt-5.4-mini',baseUrl:'https://miaoapi.xyz/v1'})});}
    if(url.pathname==='/api/ark-credentials/status'){metadataRequests.push('ark');return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({configured:true,source:'mock-metadata',containsCredentials:false})});}
    if(url.pathname==='/api/director/status')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({configured:false,provider:url.searchParams.get('provider'),error:'隔离模拟配置：未执行认证'})});
    if(request.method()==='POST'&&(url.pathname==='/api/platforms/discover'||/\/generate-image$/.test(url.pathname)||/\/conversations\/[^/]+\/messages$/.test(url.pathname))){
      const body=request.postDataJSON();const kind=url.pathname==='/api/platforms/discover'?'discover':/\/generate-image$/.test(url.pathname)?'canvas-image':body.mode==='image'?'conversation-image':'conversation-chat';
      captured.push({kind,path:url.pathname,body});
      if(kind==='discover')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({models:[{id:'mock-discovered-model',category:'chat'}],note:'本地模拟列表；未联系供应商'})});
      return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'隔离验收：请求已拦截，没有发送模型请求'})});
    }
    return route.continue();
  });
  page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(server.base+'/?project='+project.id);await page.locator('.node').waitFor();
  await page.locator('.rail [data-action="api-settings"]').click();await page.getByText('本机 AI 接入',{exact:true}).waitFor();
  assert.match(await page.locator('#modal').textContent(),/喵喵专用配置.*已识别/s);assert.match(await page.locator('#modal').textContent(),/火山视频配置.*已识别/s);
  assert.match(await page.locator('#modal').textContent(),/认证不等于|不等于账户模型权限/);
  assert.equal(captured.length,0);await noProductionJobs();
  await screenshot('01-ai-overview-desktop.png','电脑：API 配置总览，仅模拟“已配置”状态，未验证真实账户');check('API 设置显示本机接入总览，打开页面不创建模型任务');

  await page.locator('[data-edit-platform="'+platform.id+'"]').click();await page.locator('#modal details summary').click();await waitLocalSource(page.locator('#modal'));
  await selectLocal(page.locator('#modal'),page.locator('#discovery-key'));await page.locator('[data-action="discover-models"]').click();await failToast('请确认本次使用');assert.equal(captured.length,0);
  await page.locator('[data-miao-consent]').check();await page.locator('[data-action="discover-models"]').click();await page.locator('[data-discovered-model="mock-discovered-model"]').waitFor();await assertCaptured('discover');
  assert.equal(captured.filter(r=>r.kind==='discover').length,1);await noProductionJobs();check('模型发现使用相同来源入口，未勾本机配置授权不提交；模拟发现请求只发送来源描述符');
  await page.locator('#modal [data-action="api-settings"]').click();await page.locator('#modal h2').filter({hasText:'API 平台与模型'}).waitFor();await page.locator('#modal [data-action="close-modal"]').click();await page.waitForFunction(()=>!document.querySelector('#modal').open);

  await page.locator('[data-select="'+seed.id+'"]').click();await page.locator('[data-action="generate-node"]').click();const canvas=page.locator('#direct-image-form');await waitLocalSource(canvas);
  assert.equal(await canvas.locator('[name="model"]').inputValue(),'gpt-image-2');await selectLocal(canvas,canvas.locator('[name="apiKey"]'));await canvas.locator('[name="budget"]').fill('0.01');await canvas.locator('[name="consent"]').check();
  await tabReachesSourceAndConsent(canvas);await page.locator('[data-action="submit-direct-image"]').click();await failToast('请确认本次使用');assert.equal(captured.filter(r=>r.kind==='canvas-image').length,0);await noProductionJobs();
  await canvas.locator('[data-miao-consent]').check();await canvas.locator('[data-miao-source]').scrollIntoViewIfNeeded();await screenshot('02-canvas-image-desktop.png','电脑：画布生图来源默认手填，明确选择模拟本机配置后仍须逐次勾选');
  await page.setViewportSize({width:390,height:844});await canvas.locator('[data-miao-source]').scrollIntoViewIfNeeded();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await screenshot('03-canvas-image-mobile.png','手机 390px：密钥来源与独立授权可操作；不代表实体手机验收');
  await page.locator('[data-action="submit-direct-image"]').click();await failToast('隔离验收');await assertCaptured('canvas-image','gpt-image-2');await noProductionJobs();check('画布生图支持手填与本机来源切换，禁用并清空密码，未授权不提交，拦截载荷无密钥');check('画布来源选择与授权能用 Tab 到达，390px 页面无横向溢出');

  await page.setViewportSize({width:1440,height:1000});await page.goto(server.base+'/conversation.html?project='+project.id);await page.locator('main:not([inert])').waitFor();assert.equal(await page.locator('#model').inputValue(),'gpt-5.4-mini');
  await page.locator('#text').fill('自制验收问题：只测试接口选择，不调用模型');await page.locator('#send').click();const dialog=page.locator('#dialog');await waitLocalSource(dialog);await selectLocal(dialog,page.locator('#key'));
  await page.locator('#budget').fill('0.01');await page.locator('#consent').check();await tabReachesSourceAndConsent(dialog);
  await page.locator('#confirm').click();await failToast('请确认本次使用');assert.equal(captured.filter(r=>r.kind==='conversation-chat').length,0);assert.deepEqual(errors,[]);
  await page.locator('[data-miao-consent]').check();await screenshot('04-conversation-chat-desktop.png','电脑：独立文字对话逐次选择来源并确认；模拟配置不代表真实认证成功');
  await page.locator('#confirm').click();await failToast('隔离验收');await assertCaptured('conversation-chat','gpt-5.4-mini');await page.locator('#close').click();await noProductionJobs();check('独立对话有相同来源和授权入口；缺少来源授权给出提示，不产生未处理异常或真实任务');

  await page.locator('#mode').selectOption('image');assert.equal(await page.locator('#model').inputValue(),'gpt-image-2');await page.locator('#text').fill('自制图片验收：翡翠玻璃方块，仅检查载荷');await page.locator('#send').click();await waitLocalSource(dialog);await selectLocal(dialog,page.locator('#key'));await page.locator('#budget').fill('0.01');await page.locator('#consent').check();
  await page.locator('#confirm').click();await failToast('请确认本次使用');assert.equal(captured.filter(r=>r.kind==='conversation-image').length,0);await page.locator('[data-miao-consent]').check();
  await page.setViewportSize({width:390,height:844});await page.locator('[data-miao-source]').scrollIntoViewIfNeeded();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await screenshot('05-conversation-image-mobile.png','手机 390px：独立图片模式与对话共用来源选择，模拟确认界面');
  await page.locator('#confirm').click();await failToast('隔离验收');await assertCaptured('conversation-image','gpt-image-2');await noProductionJobs();check('独立图片模式使用同源选择，模型分类正确，未授权不提交，拦截载荷无密钥');

  await page.locator('[data-miao-source]').selectOption('manual');assert.equal(await page.locator('#key').isDisabled(),false);assert.equal(await page.locator('#key').inputValue(),'');assert.equal(await page.locator('[data-miao-consent]').isChecked(),false);assert.equal(await page.locator('[data-miao-consent]').isVisible(),false);check('切回手填来源恢复输入并清除本机授权、不显示本机授权标签，不保存或自动复用选择');
  assert.deepEqual(outside,[]);assert.deepEqual(errors,[]);assert.ok(metadataRequests.includes('miao')&&metadataRequests.includes('ark'));
  assert.equal(captured.length,4);const browserStorage=await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}));assert.ok(!browserStorage.includes('not-a-credential-ui-clear-only'));
  const result={passed:true,checks,screenshots,capturedRequests:captured.map(r=>({kind:r.kind,path:r.path,credentialSource:r.body.credentialSource,credentialConsent:r.body.credentialConsent,apiKeyEmpty:r.body.apiKey==='',model:r.body.model||null})),pageErrors:errors,externalRequests:outside,metadataMocks:metadataRequests.length,productionRequests:0,productionJobs:0,network:'Browser external requests aborted; submission and discovery intercepted; isolated server loopback-only; no user Chrome, Keychain, provider login, generation, or real credential access',unverified:['真实账户认证与模型权限','真实云端图片/视频生成','实体手机和真实触控板'],dataDirectory:data};
  await fs.writeFile(path.join(artifacts,'result-'+attempt+'.json'),JSON.stringify(result,null,2));await fs.writeFile(path.join(artifacts,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:true,checks:checks.length,screenshots:screenshots.length,artifacts}));
}catch(error){
  if(page)await page.screenshot({path:path.join(artifacts,'failure-'+attempt+'.png')}).catch(()=>{});
  await fs.writeFile(path.join(artifacts,'failure-'+attempt+'.json'),JSON.stringify({passed:false,error:error.message,checks,pageErrors:errors,externalRequests:outside,capturedRequests:captured.map(r=>({kind:r.kind,path:r.path,apiKeyEmpty:r.body.apiKey===''})),dataDirectory:data},null,2));
  throw error;
}finally{
  await browser?.close();await server?.stop();
  if(previousNodeOptions===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=previousNodeOptions;
}
