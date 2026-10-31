// Read-only acceptance on the running workbench. Every mutation and remote host
// is blocked, so this check cannot submit a second paid model request.
const {chromium}=require('/Users/mjd-ppps/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const base='http://127.0.0.1:4750',native='http://127.0.0.1:4768';
const project='draft-20260914-141923-cc721bf9b9';
const out=process.env.DIRECTOR_CONNECTED_OUTPUT||path.resolve(__dirname,'../../artifacts/canvas-director-connected-'+Date.now());
fs.mkdirSync(out,{recursive:true});
const report={passed:false,readOnly:true,checks:[],pageErrors:[],externalRequests:[],blockedMutations:[],modelRequests:0};
(async()=>{
 const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--disable-gpu']});let page;
 try{
  const context=await browser.newContext({viewport:{width:1600,height:1000},reducedMotion:'reduce'});
  await context.route('**/*',route=>{
   const req=route.request(),url=new URL(req.url());
   if(![base,native].includes(url.origin)){report.externalRequests.push(url.origin);return route.abort();}
   if(!['GET','HEAD','OPTIONS'].includes(req.method())){report.blockedMutations.push({path:url.pathname,method:req.method()});return route.abort();}
   return route.continue();
  });
  page=await context.newPage();page.on('pageerror',e=>report.pageErrors.push(e.message));
  await page.goto(base+'/canvas?project='+project,{waitUntil:'networkidle'});
  const frame=page.frameLocator('#canvasFrame');await frame.locator('#canvas').waitFor({timeout:45000});
  assert.equal(await page.locator('#canvasProject').inputValue(),project);
  assert.equal(new URL(await page.locator('#canvasFrame').getAttribute('src')).origin,native);
  report.checks.push('原文旅作品打开已关联的真实画布，没有导入或生成操作');
  await frame.locator('[data-action=agent]').waitFor();
  if(!await frame.locator('#agent-prompt').isVisible())await frame.locator('[data-action=agent]').click();
  await frame.locator('#agent-prompt').waitFor();
  assert.match(await frame.locator('.agent-input').innerText(),/DeepSeek V4.1 Flash · 已配置/);
  assert.equal(await frame.locator('#agent-mode').inputValue(),'model');
  await page.screenshot({path:path.join(out,'01-real-canvas-assistant.png')});
  report.checks.push('生产网页中的创作助理实际显示 DeepSeek V4.1 Flash 并默认选中');
  await frame.locator('[data-view=storyboard]:visible').first().click();
  const shots=frame.locator('.shot-card');report.shots=await shots.count();assert.equal(report.shots,5);
  assert.ok(await frame.locator('.shot-card .preview img').count()>0);
  await page.screenshot({path:path.join(out,'02-real-storyboard.png')});
  report.checks.push('原有五个可编辑分镜与本机画面仍能显示');
  await frame.locator('.rail [data-action=settings]').click();await frame.locator('[name=agentProvider]').waitFor();
  assert.equal(await frame.locator('[name=agentProvider]').inputValue(),'deepseek');
  assert.equal(await frame.locator('#modal input[type=password]').count(),0);
  report.checks.push('已存 DeepSeek 接法在设置中生效，无重复密钥输入');
  await frame.locator('[data-action=close-modal]:visible').last().click();
  assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.blockedMutations,[]);
  report.checks.push('无页面异常、远程请求或项目修改');report.passed=true;
 }catch(error){report.error=error.message;if(page)await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});throw error;}
 finally{await browser.close();fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,out,error:report.error}));}
})().catch(error=>{console.error(error);process.exitCode=1;});
