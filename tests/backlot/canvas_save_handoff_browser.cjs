// Isolated real services. Delay only the local browser save to expose handoff ordering.
const {chromium}=require('/Users/mjd-ppps/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'../..'),OUT=path.resolve(process.argv[2]||path.join(ROOT,'artifacts','canvas-save-handoff-'+Date.now()));
const mounted=process.argv.includes('--mounted');
fs.mkdirSync(OUT,{recursive:true});
const report={checks:[],pageErrors:[],externalRequests:[],pushes:0,paidCalls:0};
(async()=>{
 const log=fs.createWriteStream(path.join(OUT,'fixture.log'),{flags:'wx'}),child=spawn(path.join(ROOT,'.venv/bin/python'),[path.join(ROOT,'tests/integrations/footage_canvas_browser_fixture.py'),path.join(OUT,'fixture'),...(mounted?['--mounted']:[])],{cwd:ROOT});
 child.stderr.pipe(log);let output='',browser,page;
 child.stdout.on('data',b=>{output+=b;log.write(b);});
 try{
  const ready=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('fixture timeout')),45000);child.on('exit',()=>{clearTimeout(timer);reject(Error('fixture stopped'));});child.stdout.on('data',()=>{const line=output.split('\n').find(l=>l.startsWith('{"base":'));if(line){clearTimeout(timer);resolve(JSON.parse(line));}});});
  const {base,native,project_id:project}=ready;report.services=ready;
  browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  let delayedSave=false,saveStarted=false,savedBeforePush=null,editedNode='',editText='';
  await context.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());if(![base,native].includes(url.origin)){report.externalRequests.push(url.origin);return route.abort();}
   if(delayedSave&&req.method()==='PUT'&&/^\/(canvas-module\/)?api\/projects\//.test(url.pathname)){delayedSave=false;saveStarted=true;await new Promise(r=>setTimeout(r,1500));}
   if(url.origin===base&&url.pathname==='/model-api/canvas/push'){
    report.pushes++;
    if(editedNode){const p=await context.request.get(native+'/api/projects/'+report.canvasProject).then(r=>r.json());savedBeforePush=p.nodes.find(n=>n.id===editedNode)?.text===editText;}
   }
   return route.continue();
  });
  page=await context.newPage();page.on('pageerror',e=>report.pageErrors.push(e.message));page.on('dialog',d=>d.accept());
  await page.goto(base+(mounted?'/canvas-exchange':'/canvas')+'?project='+project,{waitUntil:'networkidle'});await page.waitForFunction(()=>!document.querySelector('#canvasPush').disabled);
  await page.locator('#canvasPush').click();await page.locator('#canvasExchange').waitFor();
  const imported=page.waitForResponse(r=>r.url()===base+'/model-api/canvas/push');await page.locator('#canvasExchangeSubmit').click();const link=await (await imported).json();report.canvasProject=link.canvas_project_id;
  const frame=page.frameLocator('#canvasFrame');await frame.locator('#canvas').waitFor();
  const p=await context.request.get(native+'/api/projects/'+link.canvas_project_id).then(r=>r.json());editedNode=p.nodes.find(n=>n.type==='script'||n.type==='text').id;
  await frame.locator('[data-node="'+editedNode+'"] header').click();await frame.locator('.panel [data-field="text"]').waitFor();
  editText='刚刚修改的内容必须先保存，再带入新资料。';delayedSave=true;
  await frame.locator('.panel [data-field="text"]').fill(editText);
  await page.locator('#canvasPush').click();await page.locator('#canvasExchange').waitFor();await page.waitForFunction(()=>true);while(!saveStarted)await new Promise(r=>setTimeout(r,30));
  await page.locator('#canvasSelectAll').check();const pushed=page.waitForResponse(r=>r.url()===base+'/model-api/canvas/push');await page.locator('#canvasExchangeSubmit').click();await pushed;
  assert.equal(savedBeforePush,true,'the parent imports before the active editor save has reached disk');
  await frame.locator('#canvas').waitFor();const after=await context.request.get(native+'/api/projects/'+link.canvas_project_id).then(r=>r.json());assert.equal(after.nodes.find(n=>n.id===editedNode).text,editText);report.checks.push('in-flight edit is durably saved before importing new nodes and refreshing frame');
  await frame.locator('[data-node="'+editedNode+'"] header').click();assert.equal(await frame.locator('.panel [data-field="text"]').inputValue(),editText);await page.screenshot({path:path.join(OUT,'saved-edit-after-import.png')});
  // A shot dialog contains unsaved form values, which must not be silently committed or lost.
  await frame.locator('[data-view=timeline]').first().click();await frame.locator('[data-action=edit-film]').click();await frame.locator('[name=fontSize]').fill('45');
  const beforeDialogPushes=report.pushes;await page.locator('#canvasPush').click();await page.locator('#canvasExchange').waitFor();await page.locator('#canvasExchangeSubmit').click();
  await page.waitForFunction(()=>document.querySelector('#canvasExchangeError').textContent.includes('编辑窗口'));
  assert.equal(report.pushes,beforeDialogPushes);assert.equal(await frame.locator('[name=fontSize]').inputValue(),'45');assert.equal(await page.locator('#canvasFrame').evaluate(f=>f.inert),false);report.checks.push('open native editing dialog prevents import, unlocks frame and retains its uncommitted values');
  await page.screenshot({path:path.join(OUT,'blocked-unsaved-dialog.png')});
  await page.locator('.canvas-dialog-top button').click();
  await page.locator('#canvasProject').selectOption('');await page.waitForFunction(expected=>document.querySelector('#canvasMessage').textContent.includes('编辑窗口')&&document.querySelector('#canvasProject').value===expected&&!document.querySelector('#canvasProject').disabled,project);
  assert.equal(await page.locator('#canvasProject').inputValue(),project);assert.equal(await frame.locator('[name=fontSize]').inputValue(),'45');report.checks.push('switching parent projects cannot discard an open native editing form');
  await frame.locator('[data-action=close-modal]').first().click();
  await page.locator('#canvasProject').selectOption('');await page.waitForFunction(()=>document.querySelector('#canvasFrame').hidden);assert.equal(new URL(page.url()).searchParams.has('project'),false);report.checks.push('after closing the dialog, normal parent project switching still works');
  assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.externalRequests,[]);report.passed=true;
 }catch(error){report.passed=false;report.failure=error.message;if(page)await page.screenshot({path:path.join(OUT,'failure.png')}).catch(()=>{});throw error;}
 finally{await browser?.close();if(child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}log.end();fs.writeFileSync(path.join(OUT,'receipt.json'),JSON.stringify(report,null,2));}
 console.log(JSON.stringify({passed:true,out:OUT,checks:report.checks.length}));
})().catch(e=>{console.error(e);process.exitCode=1;});
