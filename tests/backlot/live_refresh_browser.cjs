// Real files, watcher, SSE, browser and server restart; no external services.
const {chromium}=require('/Users/mjd-ppps/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const {spawn}=require('node:child_process'),http=require('node:http'),{once}=require('node:events'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'../..'),OUT=path.resolve(process.argv[2]||path.join(ROOT,'artifacts','live-refresh-'+Date.now()));fs.mkdirSync(OUT,{recursive:true});
const adapter=process.argv.includes('--adapter');
const report={checks:[],pageErrors:[],externalRequests:[],paidCalls:0};
(async()=>{
 const reserve=http.createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));const base='http://127.0.0.1:'+port;
 let child,browser,library,board,log,generation=0;
 async function start(){log=fs.createWriteStream(path.join(OUT,'fixture-'+(++generation)+'.log'),{flags:'wx'});child=spawn(path.join(ROOT,'.venv/bin/python'),[path.join(ROOT,'tests/integrations/live_refresh_fixture.py'),path.join(OUT,'fixture'),String(port),...(adapter?['--adapter']:[])],{cwd:ROOT});child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok)return;}catch{}if(child.exitCode!==null)throw Error('fixture exited');await new Promise(r=>setTimeout(r,100));}throw Error('fixture startup timeout');}
 async function stop(){if(!child||child.exitCode!==null)return;const current=child;current.kill('SIGTERM');await Promise.race([once(current,'exit'),new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('fixture shutdown timeout')),8000);t.unref();})]);log.end();}
 async function change(title,burst=1,notify=true){const r=await fetch(base+'/__qa/change',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title,burst,notify})});if(!r.ok)throw Error('local test change endpoint '+r.status+': '+await r.text());return r.json();}
 async function shown(title){await Promise.all([library.locator('.lib-card h3').getByText(title,{exact:true}).waitFor(),board.getByRole('heading',{name:title,exact:true,level:1}).waitFor()]);}
 try{
  await start();browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  await context.addInitScript(()=>{window.__qaToken=crypto.randomUUID();window.__qaFeed={opens:0,errors:0,changes:0};const Native=window.EventSource;window.EventSource=class extends Native{constructor(url){super(url);this.addEventListener('open',()=>window.__qaFeed.opens++);this.addEventListener('error',()=>window.__qaFeed.errors++);this.addEventListener('message',event=>{try{if(JSON.parse(event.data).type==='change')window.__qaFeed.changes++;}catch{}});}};});
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==base){report.externalRequests.push(route.request().url());return route.abort();}return route.continue();});
  library=await context.newPage();board=await context.newPage();for(const page of [library,board])page.on('pageerror',e=>report.pageErrors.push(e.message));
  await Promise.all([library.goto(base+'/'),board.goto(base+'/p/demo')]);await shown('实时刷新测试');
  const tokens=await Promise.all([library.evaluate(()=>__qaToken),board.evaluate(()=>__qaToken)]);
  await Promise.all([library.waitForFunction(()=>__qaFeed.opens>0),board.waitForFunction(()=>__qaFeed.opens>0)]);
  await change('第一版 · 自动刷新',1,false);await shown('第一版 · 自动刷新');report.checks.push('real file watcher updates project library and project board without explicit notification or reload');
  await library.screenshot({path:path.join(OUT,'01-library-live.png')});await board.screenshot({path:path.join(OUT,'02-board-live.png')});
  let hold=true,release,ready;const captured=new Promise(r=>{ready=r;});const barrier=new Promise(r=>{release=r;});let reads=0;
  await library.route(base+'/api/projects',async route=>{reads++;if(hold){hold=false;const response=await route.fetch();const body=await response.body();assert.equal(JSON.parse(body)[0].title,'慢读取快照');ready();await barrier;return route.fulfill({response,body});}return route.continue();});
  await change('慢读取快照');await Promise.race([captured,new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('no delayed library read')),8000);t.unref();})]);const changes=await library.evaluate(()=>__qaFeed.changes);await change('读取期间又有新修改');await library.waitForFunction(n=>__qaFeed.changes>n,changes);await new Promise(r=>setTimeout(r,800));release();await shown('读取期间又有新修改');assert.ok(reads>=2);report.checks.push('a change during a delayed real library response queues a fresh read instead of leaving stale cards');
  await change('重启前状态',120);await shown('重启前状态');await context.setOffline(true);
  await change('断线期间的修改');await stop();await Promise.all([library.waitForFunction(()=>__qaFeed.errors>0),board.waitForFunction(()=>__qaFeed.errors>0)]);await start();await context.setOffline(false);await shown('断线期间的修改');report.checks.push('real isolated server restart and reconnection recover changes made while browser was offline');
  await change('重启后第一个修改');await shown('重启后第一个修改');assert.deepEqual(await Promise.all([library.evaluate(()=>__qaToken),board.evaluate(()=>__qaToken)]),tokens);report.checks.push('new low server revisions still update both existing pages after restart');
  await library.screenshot({path:path.join(OUT,'03-reconnected-library.png')});report.feedCounters=await Promise.all([library.evaluate(()=>__qaFeed),board.evaluate(()=>__qaFeed)]);
  assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.externalRequests,[]);report.checks.push('no programming page errors or external hosts');report.passed=true;
 }catch(error){report.passed=false;report.failure=error.message;await library?.screenshot({path:path.join(OUT,'failure.png')}).catch(()=>{});throw error;}
 finally{await browser?.close();await stop();fs.writeFileSync(path.join(OUT,'receipt.json'),JSON.stringify(report,null,2));}
 console.log(JSON.stringify({passed:true,out:OUT,checks:report.checks.length}));
})().catch(e=>{console.error(e);process.exitCode=1;});
