// Actual local services and media; no mocked provider, model or stock search.
const {chromium}=require('/Users/mjd-ppps/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'../..');
const OUT=path.resolve(process.argv[2]||path.join(ROOT,'artifacts','footage-canvas-browser-'+Date.now()));
fs.mkdirSync(OUT,{recursive:true});
const report={evidence:'actual_local_test_with_synthetic_visual_and_macOS_Chinese_voice',checks:[],pageErrors:[],consoleErrors:[],httpErrors:[],externalRequests:[],blockedMutations:[],paidModelCalls:0,stockSearches:0};
const record=(name,data={})=>{report.checks.push({name,...data});fs.writeFileSync(path.join(OUT,'receipt.json'),JSON.stringify(report,null,2));};
(async()=>{
 const logs=fs.createWriteStream(path.join(OUT,'fixture-server.log'),{flags:'wx'});
 const child=spawn(path.join(ROOT,'.venv/bin/python'),[path.join(ROOT,'tests/integrations/footage_canvas_browser_fixture.py'),path.join(OUT,'fixture')],{cwd:ROOT});
 child.stderr.pipe(logs);let output='';child.stdout.on('data',chunk=>{output+=chunk.toString();logs.write(chunk);});
 let browser,p;
 try{
  const ready=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('fixture startup timeout')),45000);child.on('exit',()=>{clearTimeout(timer);reject(Error('fixture exited before readiness'));});child.stdout.on('data',()=>{const line=output.split('\n').find(l=>l.startsWith('{"base":'));if(line){clearTimeout(timer);resolve(JSON.parse(line));}});});
  const {base,native,project_id:project}=ready;report.services=ready;
  browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--no-sandbox']});
  const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  await context.route('**/*',route=>{
   const request=route.request(),url=new URL(request.url());
   if(![base,native].includes(url.origin)){report.externalRequests.push(url.origin);return route.abort();}
   if(!['GET','HEAD','OPTIONS'].includes(request.method())){
    const allowed=url.origin===base?['/model-api/footage/jobs','/model-api/footage/plan','/model-api/footage/draft','/model-api/canvas/push','/model-api/canvas/pull','/model-api/canvas/open'].includes(url.pathname):/^\/api\/projects\/[A-Za-z0-9_-]+$/.test(url.pathname)&&request.method()==='PUT';
    if(!allowed){report.blockedMutations.push({path:url.pathname,method:request.method()});return route.abort();}
   }
   return route.continue();
  });
  p=await context.newPage();p.on('pageerror',e=>report.pageErrors.push(e.message));p.on('console',m=>{if(m.type()==='error')report.consoleErrors.push({text:m.text(),location:m.location()});});
  p.on('response',r=>{if(r.status()>=400)report.httpErrors.push({url:r.url(),status:r.status()});});
  await p.goto(base+'/footage?project='+project,{waitUntil:'networkidle'});
  await p.waitForFunction(()=>!document.querySelector('#createButton').disabled);
  await p.locator('#materialMode').selectOption('local');
  await p.locator('#bgmMode').selectOption('local');
  assert.equal(await p.locator('#bgmStyle').isVisible(),true);assert.equal(await p.locator('#bgmPath').isVisible(),false);
  await p.locator('#bgmStyle').selectOption('cinematic');
  await p.screenshot({path:path.join(OUT,'01-free-local-music.png')});
  record('visible free music choice, style and simple conditional controls');
  const submitted=p.waitForResponse(r=>r.url()===base+'/model-api/footage/jobs'&&r.request().method()==='POST');
  await p.locator('#createButton').click();const response=await submitted,queued=await response.json();assert.equal(response.status(),202);
  assert.equal(response.request().postDataJSON().options.bgm_mode,'local');assert.equal(response.request().postDataJSON().options.bgm_style,'cinematic');
  const jobId=queued.job_id;report.footage_job_id=jobId;
  await p.waitForFunction(()=>document.querySelector('#jobStatus').textContent==='已完成',{},{timeout:90000});
  const job=await p.request.get(base+'/model-api/footage/jobs/'+jobId+'?project_id='+project).then(r=>r.json());
  assert.equal(job.status,'completed');assert.equal(job.music.provider.provider,'local_synthesis');assert.equal(job.music.paid_calls,0);
  assert.ok(job.outputs[0].canvas_cut_path);report.actual_duration=job.outputs[0].duration_seconds;
  await p.locator('#outputArea video').evaluate(video=>video.play());
  await p.waitForFunction(()=>document.querySelector('#outputArea video').currentTime>.15);
  await p.locator('#outputArea video').evaluate(video=>video.pause());
  record('actual local Chinese narration, generated music, subtitles and playable MP4',{duration:report.actual_duration});
  await p.locator('#outputArea').scrollIntoViewIfNeeded();
  await p.screenshot({path:path.join(OUT,'02-actual-film-and-edit-link.png')});
  const link=p.getByRole('link',{name:'在画布中继续剪辑 →'});const target=await link.getAttribute('href');
  await link.click();await p.waitForFunction(()=>!document.querySelector('#canvasPush').disabled);
  assert.ok((await p.locator('#canvasCutSummary').textContent()).includes('独立剪辑版本'));
  await p.locator('#canvasPush').click();await p.locator('#canvasExchange').waitFor({state:'visible'});
  assert.equal(await p.locator('#canvasSelectAll').isChecked(),true);
  assert.equal(await p.locator('.canvas-file input').count(),3);
  assert.equal(await p.locator('#canvasCutWarnings').isVisible(),true);
  await p.screenshot({path:path.join(OUT,'03-selected-cut-handoff.png')});
  const imported=p.waitForResponse(r=>r.url()===base+'/model-api/canvas/push');await p.locator('#canvasExchangeSubmit').click();const importedResponse=await imported,pushed=await importedResponse.json();
  assert.equal(importedResponse.status(),200);assert.equal(pushed.added_shots,2);assert.equal(pushed.unassigned_shots,0);
  report.canvas_project_id=pushed.canvas_project_id;record('one local confirmation imports only this version and its three actual media files');
  const frame=p.frameLocator('#canvasFrame');await frame.locator('#canvas').waitFor({state:'visible',timeout:45000});
  await frame.locator('button[data-view=timeline]').first().click();
  const projectRoute=native+'/api/projects/'+pushed.canvas_project_id;
  const canvas=await p.request.get(projectRoute).then(r=>r.json());
  assert.deepEqual(canvas.shots.map(s=>s.edit.sourceStart),[.5,2]);
  assert.ok(canvas.shots.every(s=>s.audioId));assert.equal(canvas.settings.edit.music.length,1);
  assert.deepEqual(canvas.shots.map(s=>s.duration),job.shots.map(s=>s.duration_seconds));
  await frame.locator('[data-edit-shot]').first().click();
  assert.equal(Number(await frame.locator('[name=sourceStart]').inputValue()),.5);
  await p.screenshot({path:path.join(OUT,'04-native-edit-with-cut-and-voice.png')});
  await frame.locator('[name=sourceStart]').scrollIntoViewIfNeeded();
  await p.screenshot({path:path.join(OUT,'04b-native-trim-and-audio.png')});
  await frame.locator('[data-action=close-modal]').first().click();
  record('real native editor retains source trim, measured voice lengths and independent music');
  await p.reload({waitUntil:'networkidle'});await p.frameLocator('#canvasFrame').locator('#canvas').waitFor({state:'visible'});
  assert.equal(new URL(await p.locator('#canvasFrame').getAttribute('src')).searchParams.get('project'),pushed.canvas_project_id);
  record('refresh reopens the same version without creation or generation');
  await p.goto(base+'/footage?project='+project,{waitUntil:'networkidle'});
  await p.waitForFunction(()=>document.querySelector('#bgmMode').value==='local');
  assert.equal(await p.locator('#bgmStyle').inputValue(),'cinematic');assert.equal(await p.getByRole('link',{name:'在画布中继续剪辑 →'}).getAttribute('href'),target);
  record('saved music choice and the exact rendered version link survive reload');
  await p.setViewportSize({width:390,height:844});
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await p.locator('#bgmStyle').scrollIntoViewIfNeeded();await p.screenshot({path:path.join(OUT,'05-local-music-mobile.png')});
  await p.goto(base+target,{waitUntil:'networkidle'});await p.waitForFunction(()=>!document.querySelector('#canvasPush').disabled);
  await p.locator('#canvasPush').click();await p.locator('#canvasExchange').waitFor({state:'visible'});
  assert.equal(await p.locator('#canvasExchange').evaluate(e=>e.scrollWidth>e.clientWidth),false);
  assert.equal(await p.locator('#canvasExchangeSubmit').evaluate(e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}),true);
  assert.equal(await p.locator('.canvas-dialog-top button').evaluate(e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}),true);
  await p.locator('.canvas-dialog-body').evaluate(e=>e.scrollTop=e.scrollHeight);
  assert.equal(await p.locator('.canvas-file').last().isVisible(),true);
  await p.screenshot({path:path.join(OUT,'06-cut-handoff-mobile.png')});record('390px music controls and handoff dialog have no horizontal overflow');
  record('mobile confirmation and close remain visible while the actual file list scrolls');
  assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.consoleErrors,[]);assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.blockedMutations,[]);
  record('no browser errors, cloud hosts or paid generation');report.passed=true;
 }catch(error){
  report.passed=false;report.failure=error.message;
  if(p&&!p.isClosed()){report.frames=p.frames().map(f=>f.url());await p.screenshot({path:path.join(OUT,'failed-screen.png')}).catch(()=>{});}
  throw error;
 }finally{
  if(browser)await browser.close();
  if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}
  logs.end();fs.writeFileSync(path.join(OUT,'receipt.json'),JSON.stringify(report,null,2));
 }
 console.log(JSON.stringify(report,null,2));
})().catch(e=>{console.error(e);process.exitCode=1});
