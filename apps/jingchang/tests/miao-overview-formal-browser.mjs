import './helpers/local-network-only.mjs';
import {createRequire} from 'node:module';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

// Run only after the main agent confirms that formal 0.99.1 is loaded.
// This script does not start, stop, or change the formal server or its data.
const BASE='http://127.0.0.1:4768',EXPECTED_VERSION='0.99.1';
const require=createRequire('/Users/mjd-ppps/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');
const {chromium}=require('playwright');
const output=path.join(process.cwd(),'artifacts','ai-connections-20261007-1791350715621','formal-browser'),attempt=String(Date.now());
const requests=[],blockedSubmissions=[],blockedExternal=[],blockedMedia=[],blockedUnexpectedReads=[],pageErrors=[],screenshots=[];
let browser,page,projectId,version,counts,metadata;
await fs.mkdir(output,{recursive:true});

async function get(endpoint){
  const url=new URL(endpoint,BASE);assert.equal(url.origin,BASE);assert.equal(url.search,'');
  const r=await fetch(url,{method:'GET'});assert.ok(r.ok,'formal read failed: '+endpoint+' status '+r.status);return r.json();
}
function privacySafe(project){
  return project&&Array.isArray(project.nodes)&&project.nodes.length<=1&&
    ['assets','shots','messages','runs'].every(name=>Array.isArray(project[name])&&project[name].length===0)&&
    project.nodes.every(node=>!node.assetId&&typeof node.text==='string'&&!node.text.trim()&&!node.raw&&
      !/https?:\/\/|data:|file:|asset:\/\//i.test(JSON.stringify(node)));
}
async function screenshot(name,viewport){
  await page.setViewportSize(viewport);
  const modal=page.locator('#modal');await modal.waitFor({state:'visible'});await modal.locator('h2').filter({hasText:'API 平台与模型'}).waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'API overview must not cause horizontal viewport overflow');
  await modal.evaluate(dialog=>{const banner=document.createElement('div');banner.dataset.testEvidenceLabel='';banner.textContent='本机配置实景｜未验证云端调用';banner.style.cssText='position:absolute;top:6px;left:12px;right:12px;text-align:center;font:10px/15px sans-serif;color:#bff9ff;pointer-events:none;';dialog.append(banner);});
  // Crop to the real settings dialog so no background project or private media
  // enters the evidence image. Viewport dimensions are recorded separately.
  const file=path.join(output,attempt+'-'+name);await modal.screenshot({path:file});await page.locator('[data-test-evidence-label]').evaluate(e=>e.remove());
  const bytes=await fs.readFile(file);screenshots.push({file,viewport,scope:'actual formal API-settings dialog only',sha256:createHash('sha256').update(bytes).digest('hex'),watermark:'本机配置实景｜未验证云端调用'});
}

try{
  const health=await get('/api/health');version=health.version;assert.equal(version,EXPECTED_VERSION,'formal service version is not yet '+EXPECTED_VERSION+'; stop without opening Chrome');
  const list=await get('/api/projects'),requested=process.env.JINGCHANG_FORMAL_SCREENSHOT_PROJECT;
  // Inspect at most one eligible existing project. Do not create a project or
  // search through all saved contents to find a convenient screenshot target.
  const candidate=requested?list.find(project=>project.id===requested):list.find(project=>!project.archived&&project.nodes<=1&&project.shots===0&&/^(未命名项目|接口验收|测试|验收|本地.*验收|镜场.*验收)/.test(project.name));
  assert.ok(candidate,'no eligible existing blank/acceptance project; stop without creating or modifying data');
  assert.ok(candidate.nodes<=1&&candidate.shots===0,'selected project is not an eligible blank screenshot target');
  const existing=await get('/api/projects/'+encodeURIComponent(candidate.id));assert.ok(privacySafe(existing),'selected existing project is not empty; stop before opening Chrome or reading other project contents');projectId=candidate.id;
  const [platforms,miao,ark]=await Promise.all([get('/api/platforms'),get('/api/miao-credentials/status'),get('/api/ark-credentials/status')]);
  counts=Object.fromEntries(['chat','image','video'].map(category=>[category,platforms.platforms.reduce((sum,p)=>sum+p.models.filter(model=>model.category===category).length,0)]));
  assert.equal(counts.chat,3,'formal chat-model metadata count');assert.equal(counts.image,1,'formal image-model metadata count');
  assert.equal(miao.configured,true,'formal Miao local metadata must be present');assert.equal(ark.configured,true,'formal Ark local metadata must be present');
  metadata={miao:{configured:miao.configured,source:miao.source||null},ark:{configured:ark.configured,source:ark.source||null}};
  browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--disable-gpu','--disable-dev-shm-usage']});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const apiAllow=new Set(['/api/health','/api/projects','/api/projects/'+projectId,'/api/platforms','/api/miao-credentials/status','/api/ark-credentials/status']);
  await context.route('**/*',route=>{
    const request=route.request(),url=new URL(request.url()),method=request.method();
    if(!['GET','HEAD'].includes(method)){blockedSubmissions.push({method,path:url.pathname});return route.abort();}
    if(!['data:','blob:'].includes(url.protocol)&&url.origin!==BASE){blockedExternal.push({origin:url.origin,path:url.pathname});return route.abort();}
    if(url.pathname.startsWith('/media/')){blockedMedia.push(url.pathname);return route.abort();}
    if(url.pathname.startsWith('/api/')&&!apiAllow.has(url.pathname)){blockedUnexpectedReads.push(url.pathname);return route.abort();}
    requests.push({method,path:url.pathname});return route.continue();
  });
  page=await context.newPage();page.on('pageerror',e=>pageErrors.push(e.message));
  await page.goto(BASE+'/?project='+encodeURIComponent(projectId));await page.locator('.rail [data-action="api-settings"]').waitFor();await page.locator('.rail [data-action="api-settings"]').click();
  await page.locator('#modal h2').filter({hasText:'API 平台与模型'}).waitFor();const text=await page.locator('#modal').textContent();
  assert.match(text,/已登记 3 个对话模型、1 个图片模型/);assert.match(text,/喵喵专用配置：已识别/);assert.match(text,/火山视频配置：已识别/);assert.match(text,/不等于账户模型权限或真实生成已通过/);
  await screenshot('01-formal-ai-overview-desktop.png',{width:1440,height:1000});await screenshot('02-formal-ai-overview-mobile.png',{width:390,height:844});
  assert.deepEqual(blockedSubmissions,[],'the read-only UI must not attempt a submission');assert.deepEqual(blockedExternal,[]);assert.deepEqual(blockedMedia,[]);assert.deepEqual(blockedUnexpectedReads,[]);assert.deepEqual(pageErrors,[]);
  const result={passed:true,version,projectId,counts,metadata,screenshots,submitAttempts:blockedSubmissions.length,externalAttempts:blockedExternal.length,cloudGenerationRequests:0,pageErrors,requests,guards:{readOnly:'every non-GET/HEAD blocked',sameOrigin:BASE,mediaReads:'blocked',credentialReads:'only public configured/source metadata; no user Chrome profile or credential extraction'},unverified:['供应商认证与当前模型权限','真实云端生成','实体手机']};
  await fs.writeFile(path.join(output,'result-'+attempt+'.json'),JSON.stringify(result,null,2));await fs.writeFile(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:true,version,screenshots:screenshots.length,output}));
}catch(error){
  await fs.writeFile(path.join(output,'blocked-'+attempt+'.json'),JSON.stringify({passed:false,error:error.message,version:version||null,projectId:projectId||null,counts:counts||null,metadata:metadata||null,blockedSubmissions,blockedExternal,blockedMedia,blockedUnexpectedReads,pageErrors,openedBrowser:!!browser,screenshots},null,2));
  throw error;
}finally{await browser?.close();}
