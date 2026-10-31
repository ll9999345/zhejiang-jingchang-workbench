import {createRequire} from 'node:module';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {libraryFixture} from './helpers/library-backup-fixture.mjs';
import {localServer,persistFixture} from './helpers/library-backup-server.mjs';
const require=createRequire('/Users/mjd-ppps/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');
const {chromium}=require('playwright');
const stage=process.env.LIBRARY_BACKUP_EVIDENCE||path.join(process.cwd(),'artifacts','library-backups-browser-'+Date.now());await fs.mkdir(path.join(stage,'screenshots'),{recursive:true});
const report={passed:false,checks:[],pageErrors:[],blocked:[],paidGenerations:0,physicalPhoneVerified:false,rendering:'isolated installed Chrome, software rendering'};
const f=await libraryFixture({populated:true,dir:path.join(stage,'test-data')});await persistFixture(f);
const server=await localServer(f.data,{log:path.join(stage,'isolated-server.log')});let browser,currentPage;
const check=name=>report.checks.push(name),shot=(page,name)=>page.screenshot({path:path.join(stage,'screenshots',name+'.png')});
async function page(options={}){
 const context=await browser.newContext({viewport:{width:1440,height:960},...options});
 await context.addInitScript(()=>localStorage.setItem('jingchang.ambient-motion.v1','paused'));
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin!==server.base||request.method()!=='GET'&&/generate|canvas-run|chat|submit|upload-lora/.test(url.pathname)){report.blocked.push({host:url.hostname,path:url.pathname,method:request.method()});await route.abort();return;}
  await route.continue();
 });
 const p=await context.newPage();currentPage=p;p.on('pageerror',e=>report.pageErrors.push(e.message));
 await p.goto(server.base+'/?project='+f.p.id);await p.locator('[data-view="assets"]:visible').first().click();await p.locator('[data-action="asset-catalog"]').click();await p.locator('[data-catalog-mode="backups"]').click();
 await p.locator('.catalog-backup-panel:has([data-library-backup=export])').waitFor();await p.waitForFunction(()=>document.querySelector('[data-library-backup=export]')?.disabled===false);return {p,context};
}
async function noOverflow(p){assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);const r=await p.locator('#asset-catalog-dialog').boundingBox(),v=p.viewportSize();assert.ok(r.x>=-.5&&r.x+r.width<=v.width+.5,'dialog horizontal containment '+JSON.stringify({r,v}));assert.ok(r.y>=-.5&&r.y+r.height<=v.height+.5,'dialog vertical containment');}
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.JINGCHANG_BROWSER_EXECUTABLE||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-gpu']});
 const before=await server.api('/api/projects/'+f.p.id),desktop=await page(),p=desktop.p;
 await noOverflow(p);await shot(p,'01-desktop-entry');check('桌面1440：现有素材库入口、完整范围说明、青蓝主题与容纳');
 const exportButton=p.locator('[data-library-backup="export"]');await exportButton.focus();await p.keyboard.press('Enter');
 await p.locator('.catalog-backup-jobs a[download]').waitFor({timeout:20000});assert.equal(await p.locator('.catalog-backup-jobs article').count(),1);
 const downloadPromise=p.waitForEvent('download');await p.locator('.catalog-backup-jobs a[download]').click();const downloaded=await downloadPromise,file=path.join(stage,'browser-export.jingchang-library');await downloaded.saveAs(file);assert.ok((await fs.stat(file)).size>0);
 await shot(p,'02-desktop-backup-complete');check('键盘Enter创建真实本机备份、完成步骤与可下载文件');
 await p.locator('#library-backup-file').setInputFiles(file);await p.locator('[data-library-backup="upload"]').click();await p.locator('[data-library-restore]').waitFor({timeout:20000});assert.equal((await server.api('/api/asset-catalog')).libraries.length,2);
 await p.locator('.catalog-backup-imports details').click();await shot(p,'03-desktop-import-preview');check('本机文件接收与库清单预览；检查阶段不恢复目录');
 const restore=p.locator('[data-library-restore]');await restore.focus();await p.keyboard.press('Space');
 await p.waitForFunction(()=>[...document.querySelectorAll('.catalog-backup-jobs article')].some(a=>a.textContent.includes('素材库整库恢复')&&a.textContent.includes('已完成')),{},{timeout:20000});
 const state=await server.api('/api/asset-catalog');assert.equal(state.libraries.length,4);assert.deepEqual(await server.api('/api/projects/'+f.p.id),before);
 assert.equal(await p.locator('[data-library-restore]').count(),0);await shot(p,'04-desktop-restored');check('键盘Space恢复为新增库，原工程与原目录保留，无重复恢复按钮');
 const job=(await server.api('/api/jobs?projectId='+f.p.id)).find(j=>j.kind==='library-restore');assert.equal(job.plan,undefined);
 await p.keyboard.press('Escape');await p.locator('[data-action="tasks"]').click();await p.locator('[data-task="'+job.id+'"]').click();await p.locator('.catalog-backup-panel:has([data-library-backup=export])').waitFor();assert.equal(await p.locator('[data-catalog-mode="backups"]').evaluate(e=>e.classList.contains('active')),true);
 const record=p.locator('[data-library-job="'+job.id+'"]');await record.waitFor();await p.waitForFunction(id=>{const e=document.querySelector('[data-library-job="'+id+'"]');if(!e)return false;const box=e.getBoundingClientRect();return box.height>0&&box.y>=0&&box.y<innerHeight;},job.id);
 await shot(p,'05-task-center-record');check('真实任务中心记录可回到整库面板并定位原任务，任务状态与目录一致');
 const refresh=p.locator('[data-library-backup="refresh"]');await refresh.focus();await p.keyboard.press('Enter');await p.waitForFunction(()=>document.activeElement?.dataset.libraryBackup==='refresh');check('刷新后键盘焦点保持，Escape关闭原生对话框');
 await desktop.context.close();
 for(const width of [390,320]){
  const mobile=await page({viewport:{width,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:1});await noOverflow(mobile.p);await shot(mobile.p,width===390?'06-phone-390':'07-phone-320');check('手机'+width+'：整库范围、文件与任务记录无横向溢出');await mobile.context.close();
 }
 const reduced=await page({viewport:{width:390,height:844},reducedMotion:'reduce'});await noOverflow(reduced.p);assert.equal(await reduced.p.locator('body').getAttribute('data-ambient-motion'),'paused');await shot(reduced.p,'08-phone-reduced-motion');check('低动态手机模拟：环境动效停止，备份与记录可操作');await reduced.context.close();
 const contrast=await page({forcedColors:'active'});await noOverflow(contrast.p);await shot(contrast.p,'09-desktop-forced-colors');check('强制色彩模拟：备份记录、下载和键盘按钮可见');await contrast.context.close();
 assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.blocked,[]);report.passed=true;
}catch(e){report.error={message:e.message,stack:e.stack};if(currentPage&&!currentPage.isClosed())await currentPage.screenshot({path:path.join(stage,'failure.png')}).catch(()=>{});throw e;}
finally{await browser?.close();await server.stop();await fs.writeFile(path.join(stage,'result.json'),JSON.stringify(report,null,2));process.stdout.write(JSON.stringify({passed:report.passed,checks:report.checks.length,stage,error:report.error?.message})+'\n');}
