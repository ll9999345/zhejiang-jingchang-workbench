import {createRequire} from 'node:module';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import assert from 'node:assert/strict';
const require=createRequire('/Users/mjd-ppps/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');
const {chromium}=require('playwright'),run=promisify(execFile),root=process.cwd();
const artifacts=path.join(root,'artifacts','protocols-qa-'+Date.now());await fs.mkdir(artifacts,{recursive:true});
const picture=path.join(artifacts,'fixture.png'),video=path.join(artifacts,'fixture.mp4');
await run('ffmpeg',['-v','error','-nostdin','-f','lavfi','-i','testsrc=size=160x120:rate=1','-frames:v','1','-threads','1','-update','1',picture]);
await run('ffmpeg',['-v','error','-nostdin','-f','lavfi','-i','testsrc2=size=160x120:rate=10:duration=1','-c:v','mpeg4','-threads','1',video]);
const png=await fs.readFile(picture),mp4=await fs.readFile(video),requests=[];let imageCount=1,pending=false;
const mock=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);let body;try{body=JSON.parse(Buffer.concat(chunks));}catch{}requests.push({url:req.url,method:req.method,body});res.setHeader('Content-Type','application/json');
 if(req.url==='/v1beta/models')return res.end(JSON.stringify({models:[{name:'models/gemini-test-image',supportedGenerationMethods:['generateContent']}],nextPageToken:'remaining'}));
 if(req.url==='/v1beta/models/gemini-test-image:generateContent')return res.end(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{inlineData:{mimeType:'image/png',data:png.toString('base64')}}]}}]}));
 if(req.url==='/v1/images/generations'){imageCount=body.n;return res.end(JSON.stringify({code:200,data:[{task_id:'image-task',status:'submitted'}]}));}
 if(req.url==='/v1/videos/generations')return res.end(JSON.stringify({code:200,data:[{task_id:'video-task',status:'submitted'}]}));
 if(req.url.startsWith('/v1/tasks/')){const id=req.url.split('/').at(-1);return res.end(JSON.stringify({code:200,data:{id,status:pending?'processing':'completed',progress:30,result:id==='image-task'?{images:[{url:Array(imageCount).fill(base+'/image')}]}:{videos:[{url:[base+'/video']}]}}}));}
 if(req.url==='/image'){res.setHeader('Content-Type','image/png');return res.end(png);}
 if(req.url==='/video'){res.setHeader('Content-Type','video/mp4');return res.end(mp4);}
 res.statusCode=404;res.end('{}');});
mock.listen(0,'127.0.0.1');await once(mock,'listening');const base='http://127.0.0.1:'+mock.address().port;
const reservation=http.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(r=>reservation.close(r));
const server=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),JINGCHANG_DATA_DIR:path.join(artifacts,'data')},stdio:['ignore','pipe','pipe']});
let browser,page;const errors=[];
async function connect(protocol,model){await page.locator('#open-connect').click();await page.locator('#connect-protocol').selectOption(protocol);await page.locator('#connect-url').fill(base+(protocol==='gemini'?'/v1beta':'/v1'));await page.locator('#connect-model').fill(model);}
async function submit(){await page.locator('#generate-button').click();await page.locator('#generation-budget').fill('1');await page.locator('#authorize-send').check();await page.locator('#authorize-budget').check();await page.locator('[data-dialog-action="submit-generation"]').dblclick();}
async function apply(){await page.waitForSelector('[data-dialog-action="apply-job"]',{timeout:20000});await page.locator('[data-dialog-action="apply-job"]').click();await page.waitForFunction(()=>document.querySelector('[data-dialog-action="apply-job"]')?.disabled);}
async function close(){await page.locator('[data-dialog-action="close"]').click();}
try{
 await Promise.race([once(server.stdout,'data'),once(server,'exit').then(()=>{throw Error('server exited');}),new Promise((_,r)=>setTimeout(()=>r(Error('startup timeout')),8000).unref())]);
 browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});page=await browser.newPage({viewport:{width:1440,height:960},baseURL:'http://127.0.0.1:'+port});page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/');await page.waitForSelector('.node');const projectId=(await(await page.request.get('/api/projects')).json())[0].id;
 await page.locator('[data-action="open-creation-studio"]').click();await page.waitForSelector('#prompt-input');await page.locator('#mode-image').click();await page.locator('#prompt-input').fill('根据参考图创作水彩画');
 await page.locator('[data-jump="references"]').click();await page.locator('#file-picker').setInputFiles(picture);await page.waitForSelector('.ref-row');
 await connect('gemini','gemini-test-image');await page.locator('#connect-key').fill('synthetic-browser-secret');await page.locator('[data-dialog-action="discover"]').click();await page.getByText('仅显示平台返回的第一页',{exact:false}).waitFor();await page.locator('[data-dialog-action="save-connect"]').click();
 await page.locator('[data-jump="config"]').click();assert.equal(await page.locator('[data-config="quality"]').count(),0);await page.locator('[data-config="ratio"]').selectOption('1:1');await submit();await apply();assert.equal(requests.filter(r=>r.method==='POST').length,1);assert.ok(requests[1].body.contents[0].parts[1].inlineData);await page.screenshot({path:path.join(artifacts,'01-gemini-result.png')});await close();
 await connect('apimart','gpt-image-2');await page.locator('[data-dialog-action="save-connect"]').click();await page.locator('[data-jump="config"]').click();await page.locator('[data-config="imageResolution"]').selectOption('2k');await page.locator('[data-config="count"]').selectOption('2');
 pending=true;await submit();await page.locator('[data-dialog-action="cancel-wait"]').click();await page.waitForSelector('[data-dialog-action="resume-job"]',{timeout:20000});pending=false;await page.locator('[data-dialog-action="resume-job"]').click();await apply();assert.equal(await page.locator('.job-result').count(),2);assert.equal(requests.filter(r=>r.url==='/v1/images/generations').length,1);await page.screenshot({path:path.join(artifacts,'02-apimart-images.png')});await close();
 await page.locator('#mode-video').click();await connect('apimart','doubao-seedance-2.0');await page.locator('[data-dialog-action="save-connect"]').click();await page.locator('#generate-button').click();assert.equal(await page.locator('#generation-budget').count(),0);await page.locator('[data-jump="references"]').click();await page.locator('[data-remove-ref]').click();
 for(const name of ['first','last']){await page.locator('#reference-url').fill('https://example.com/'+name+'.png');await page.locator('#add-url-ref').click();}
 await page.locator('[data-jump="config"]').click();await page.locator('[data-config="duration"]').fill('6');await page.locator('[data-config="duration"]').blur();await submit();await apply();const videoPost=requests.find(r=>r.url==='/v1/videos/generations');assert.equal(videoPost.body.duration,6);assert.equal(videoPost.body.image_with_roles[1].role,'last_frame');await page.screenshot({path:path.join(artifacts,'03-apimart-video.png')});await close();
 await page.reload();await page.waitForSelector('#prompt-input');await page.locator('[data-jump="config"]').click();assert.equal(await page.locator('[data-config="model"]').inputValue(),'doubao-seedance-2.0');await page.setViewportSize({width:390,height:844});await page.waitForFunction(()=>document.querySelector('#left-panel').getBoundingClientRect().right<=0);if(!await page.locator('#right-panel').evaluate(el=>el.classList.contains('open')))await page.locator('#mobile-right-toggle').click();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(artifacts,'04-mobile-settings.png'),animations:'disabled'});
 const project=await(await page.request.get('/api/projects/'+projectId)).json();assert.equal(project.runs.filter(r=>r.kind==='studio-generation').length,3);assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:true,checks:['Gemini native model discovery','Gemini reference image and result apply','protocol-specific controls','APIMart two-image generation','APIMart stop/resume without duplicate POST','unsupported local video reference blocked','APIMart first/last frame video result apply','saved protocol reload','mobile layout','same main project results'],generationPosts:requests.filter(r=>r.method==='POST').length,pageErrors:errors},null,2));console.log(JSON.stringify({passed:true,artifacts}));
}catch(e){if(page)await page.screenshot({path:path.join(artifacts,'failure.png')});throw e;}
finally{await browser?.close();server.kill('SIGTERM');await new Promise(r=>mock.close(r));}
