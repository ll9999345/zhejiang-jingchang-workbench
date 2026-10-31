// Live local handoff. No reference cloning, model submissions or cloud hosts.
const {chromium}=require('/Users/mjd-ppps/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const BASE='http://127.0.0.1:4750',PROJECT='draft-20260914-141923-cc721bf9b9';
const ROOT=path.resolve(__dirname,'../..');
const OUT=path.join(process.env.CANVAS_QA_OUTPUT||path.join(ROOT,'artifacts/canvas-integration-20261002'),'browser-'+new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(OUT,{recursive:true});
const report={pageErrors:[],consoleErrors:[],externalRequests:[],blockedMutations:[],checks:[],productionModelCalls:0,cloudUploads:0};
const record=(name,data={})=>{report.checks.push({name,...data});fs.writeFileSync(path.join(OUT,'receipt.json'),JSON.stringify(report,null,2));};
(async()=>{
 const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--no-sandbox']});
 try{
  const p=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  p.on('pageerror',error=>report.pageErrors.push(error.message));
  p.on('console',message=>{if(message.type()==='error')report.consoleErrors.push(message.text());});
  await p.route('**/*',route=>{
   const req=route.request(),url=new URL(req.url());
   if(![BASE,'http://127.0.0.1:4768'].includes(url.origin)){report.externalRequests.push(url.origin);return route.abort();}
   if(!['GET','HEAD','OPTIONS'].includes(req.method())){
    const allowed=url.origin===BASE?['/model-api/canvas/push','/model-api/canvas/pull','/model-api/canvas/open'].includes(url.pathname):/^\/api\/projects\/[a-zA-Z0-9_-]+$/.test(url.pathname)&&req.method()==='PUT';
    if(!allowed){report.blockedMutations.push({path:url.pathname,method:req.method()});return route.abort();}
   }
   return route.continue();
  });
  await p.goto(`${BASE}/canvas?project=${PROJECT}`,{waitUntil:'networkidle'});
  await p.waitForFunction(()=>!document.getElementById('canvasPush').disabled);
  assert.equal(await p.locator('#canvasProject').inputValue(),PROJECT);
  const service=await p.request.get(`${BASE}/model-api/canvas/status`).then(r=>r.json());
  assert.equal(service.ready,true);
  assert.equal(await p.locator('#canvasConnection').textContent(),`镜场 ${service.version} · 已连接`);
  report.canvas_version=service.version;
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await p.screenshot({path:path.join(OUT,'01-entry.png')});record('real entry and project selection');
  await p.locator('#canvasPush').click();
  await p.locator('#canvasExchange').waitFor({state:'visible'});
  assert.equal(await p.locator('#canvasTimeline').isChecked(),true);
  await p.locator('#canvasScenes').uncheck();
  assert.equal(await p.locator('#canvasTimeline').isDisabled(),true);
  await p.locator('#canvasScenes').check();
  assert.equal(await p.locator('#canvasTimelineNote').isVisible(),true);
  const rows=p.locator('.canvas-file');
  const inventory=await p.request.get(`${BASE}/model-api/canvas/projects/${PROJECT}`).then(r=>r.json());
  const chosen=inventory.media.filter(m=>/^assets\/frames\/shot-\d+\.png$/.test(m.path)||m.path==='renders/openmontage-compose.mp4');
  assert.ok(chosen.length>1,'real project source images/video exist');
  for(const item of chosen)await rows.filter({hasText:item.path}).locator('input').check();
  await p.screenshot({path:path.join(OUT,'02-selected-source.png')});
  const pushPromise=p.waitForResponse(r=>r.url()===BASE+'/model-api/canvas/push');
  await p.locator('#canvasExchangeSubmit').click();
  const pushResponse=await pushPromise,pushed=await pushResponse.json();
  assert.equal(pushResponse.request().postDataJSON().include_timeline,true);
  record('source handoff HTTP response',{http_status:pushResponse.status(),response:pushed});
  assert.ok(pushed.canvas_project_id);report.canvas_project_id=pushed.canvas_project_id;
  await p.locator('#canvasExchange').waitFor({state:'hidden'});
  const frame=p.frameLocator('#canvasFrame');
  await frame.locator('#canvas').waitFor({state:'visible',timeout:45000});
  const savedView=p.waitForResponse(r=>r.url()===`http://127.0.0.1:4768/api/projects/${pushed.canvas_project_id}`&&r.request().method()==='PUT');
  await frame.getByRole('button',{name:'适应画布',exact:true}).click();
  assert.equal((await savedView).status(),200);
  await p.screenshot({path:path.join(OUT,'03-native-canvas.png')});
  record('real native canvas loaded after source handoff',{selectedFiles:chosen.length,addedNodes:pushed.added_nodes});
  const canvas=await p.request.get(`http://127.0.0.1:4768/api/projects/${pushed.canvas_project_id}`).then(r=>r.json());
  assert.equal(canvas.settings.ratio,'9:16');
  assert.ok(canvas.nodes.some(n=>n.type==='script')&&canvas.edges.length>0);
  assert.ok(canvas.viewport.zoom<1);
  record('native viewport editing saves through the real API');
  const sourceScenes=JSON.parse(fs.readFileSync(path.join(ROOT,'projects',PROJECT,'artifacts/scene_plan.json'))).scenes;
  const importedShots=canvas.shots.filter(s=>s.workbenchSource?.projectId===PROJECT);
  assert.equal(importedShots.length,sourceScenes.length);
  assert.ok(importedShots.every(s=>s.assetId));
  if(pushed.added_shots===sourceScenes.length)assert.deepEqual(importedShots.map(s=>s.duration),sourceScenes.map(s=>s.end_seconds-s.start_seconds));
  record('source scene lengths and selected media join actual native editable shots',{shots:importedShots.length,addedShots:pushed.added_shots});
  for(const target of ['storyboard','timeline','assets','canvas']){
   await frame.locator(`button[data-view="${target}"]`).first().click();
   if(target==='storyboard'){
    assert.ok(await frame.locator('[data-edit-shot]').count()>=importedShots.length);
    await p.screenshot({path:path.join(OUT,'03b-imported-storyboard.png')});
    await frame.locator(`[data-edit-shot="${importedShots[0].id}"]`).click();
    assert.equal(await frame.locator('[name=assetId]').inputValue(),importedShots[0].assetId);
    assert.equal(await frame.locator('[name=dialogue]').inputValue(),importedShots[0].dialogue);
    assert.equal(Number(await frame.locator('[name=duration]').inputValue()),importedShots[0].duration);
    await frame.locator('[data-action=close-modal]').first().click();
    record('imported shot opens real trim subtitle and media editor without modifying original');
   }
   if(target==='timeline'){
    assert.ok(await frame.locator('[data-preview-shot]').count()>=importedShots.length);
    await frame.locator('#player img').waitFor();
    await p.screenshot({path:path.join(OUT,'03c-imported-timeline.png')});
    record('native timeline contains imported shots and actual source image');
   }
   if(target==='canvas')await frame.locator('#canvas').waitFor({state:'visible'});
  }
  record('native storyboard, timeline, assets and canvas views open');
  // Imported source is a candidate, not falsely described as generated output.
  await p.locator('#canvasPull').click();
  await p.locator('#canvasExchange').waitFor({state:'visible'});
  assert.ok(await p.locator('.canvas-file').count()>=chosen.length);
  const returnedChoices=[canvas.assets.find(a=>a.type.startsWith('image/')),canvas.assets.find(a=>a.type.startsWith('video/'))];
  assert.ok(returnedChoices.every(Boolean));
  for(const asset of returnedChoices)await p.locator('.canvas-file').filter({hasText:asset.name}).locator('input').check();
  await p.screenshot({path:path.join(OUT,'04-return-selector.png')});
  const pullPromise=p.waitForResponse(r=>r.url()===BASE+'/model-api/canvas/pull');
  await p.locator('#canvasExchangeSubmit').click();
  const pullResponse=await pullPromise,pulled=await pullResponse.json();
  record('return handoff HTTP response',{http_status:pullResponse.status(),response:pulled});
  assert.equal(pullResponse.status(),200);
  assert.equal(pulled.assets.length,2);
  for(const asset of pulled.assets){
   const file=path.join(ROOT,'projects',PROJECT,asset.path),bytes=fs.readFileSync(file);
   assert.equal(bytes.length,asset.size_bytes);
   assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),asset.sha256);
  }
  await p.locator('#canvasExchange').waitFor({state:'hidden'});
  record('real return button copies original bytes without generation',{returnedMedia:2});
  assert.equal(new URL(await p.locator('#canvasReturn').getAttribute('href'),BASE).searchParams.get('workspace'),'edit');
  await p.reload({waitUntil:'networkidle'});
  await p.frameLocator('#canvasFrame').locator('#canvas').waitFor({state:'visible'});
  assert.equal(new URL(await p.locator('#canvasFrame').getAttribute('src')).searchParams.get('project'),pushed.canvas_project_id);
  record('reopen keeps original canvas link');
  await p.goto(`${BASE}/model?project=${PROJECT}&workspace=edit&view=quality`,{waitUntil:'networkidle'});
  await p.waitForFunction(()=>Array.from(document.querySelectorAll('select option')).some(o=>o.value.startsWith('assets/canvas/')&&o.value.endsWith('.mp4')));
  await p.screenshot({path:path.join(OUT,'05-postproduction-return.png')});
  record('returned canvas video is available in real postproduction selectors');
  const mobile=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'});
  mobile.on('pageerror',error=>report.pageErrors.push(error.message));
  mobile.on('console',message=>{if(message.type()==='error')report.consoleErrors.push(message.text());});
  await mobile.route('**/*',route=>{const url=new URL(route.request().url());if(![BASE,'http://127.0.0.1:4768'].includes(url.origin)||!['GET','HEAD','OPTIONS'].includes(route.request().method()))return route.abort();return route.continue();});
  await mobile.goto(BASE+'/canvas',{waitUntil:'networkidle'});
  assert.equal(await mobile.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.equal(await mobile.locator('#canvasPush').isDisabled(),true);
  await mobile.screenshot({path:path.join(OUT,'06-mobile-independent.png')});
  record('mobile entry has no overflow and allows standalone canvas');
  assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.consoleErrors,[]);assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.blockedMutations,[]);
  record('no page errors, external hosts or generation requests');
 }finally{await browser.close();fs.writeFileSync(path.join(OUT,'receipt.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output:OUT,...report}));}
})().catch(error=>{console.error(error);process.exitCode=1;});
