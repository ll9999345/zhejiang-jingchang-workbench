import {createRequire} from 'node:module';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import assert from 'node:assert/strict';
const require=createRequire('/Users/mjd-ppps/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');
const {chromium}=require('playwright'),run=promisify(execFile);
const root=process.cwd(),artifacts=path.join(root,'artifacts','expanded-qa-'+Date.now());
await fs.mkdir(artifacts,{recursive:true});
const picture=path.join(artifacts,'fixture.png'),video=path.join(artifacts,'fixture.mp4');
await run('ffmpeg',['-v','error','-nostdin','-f','lavfi','-i','testsrc=size=160x120:rate=1','-frames:v','1','-threads','1','-update','1',picture]);
await run('ffmpeg',['-v','error','-nostdin','-f','lavfi','-i','testsrc2=size=160x120:rate=10:duration=1','-c:v','mpeg4','-threads','1',video]);
const png=await fs.readFile(picture);let posts=0;
const prompts=[],chatRequests=[];let uploaded=0;
const mock=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);let body;try{body=JSON.parse(Buffer.concat(chunks));}catch{}res.setHeader('Content-Type','application/json');
 if(req.url==='/v1/chat/completions'){chatRequests.push(body);return res.end(JSON.stringify({choices:[{message:{content:'建议：先用全景介绍环境，再推近人物。'}}]}));}
 if(req.url==='/prompt'){prompts.push(body);return res.end(JSON.stringify({prompt_id:'p-'+prompts.length}));}
 if(req.url.startsWith('/history/')){const id=req.url.split('/').at(-1);return res.end(JSON.stringify({[id]:{status:{completed:true,status_str:'success'},outputs:{'3':{images:[{filename:'out.png',subfolder:'',type:'output'}]}}}}));}
 if(req.url.startsWith('/view')){res.setHeader('Content-Type','image/png');return res.end(png);}
 if(req.url==='/upload/image'){uploaded++;return res.end(JSON.stringify({name:'upstream.png',subfolder:'',type:'input'}));}
 if(req.url==='/v1/images/generations'){posts++;return res.end(JSON.stringify({task_id:'ms-1'}));}
 if(req.url==='/v1/tasks/ms-1')return res.end(JSON.stringify({task_status:'SUCCEED',output_images:['http://127.0.0.1:'+mock.address().port+'/view']}));
 res.statusCode=404;res.end('{}');});
mock.listen(0,'127.0.0.1');await once(mock,'listening');
const reservation=http.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(r=>reservation.close(r));
const server=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),JINGCHANG_DATA_DIR:path.join(artifacts,'data')},stdio:['ignore','pipe','pipe']});
let browser,page;const errors=[];
try{
 await Promise.race([once(server.stdout,'data'),once(server,'exit').then(()=>{throw new Error('server exited');}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('startup timeout')),8000).unref())]);
 browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 page=await browser.newPage({viewport:{width:1440,height:960},baseURL:'http://127.0.0.1:'+port});page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/');await page.waitForSelector('.node');
 const summary=(await(await page.request.get('/api/projects')).json())[0],projectId=summary.id;
 const base='http://127.0.0.1:'+mock.address().port;
 await page.request.put('/api/platforms',{data:{revision:0,platform:{name:'本地多模态',protocol:'openai-compatible',baseUrl:base+'/v1',models:[{id:'local-chat',category:'chat',referenceSupport:true}]}}});
 let p=await(await page.request.get('/api/projects/'+projectId)).json();const asset=await(await page.request.post('/api/assets?name=reference.png',{data:png,headers:{'Content-Type':'image/png'}})).json();p.assets.push(asset);p.nodes[0].assetId=asset.id;p.nodes[0].text='清晨的主角';p=await(await page.request.put('/api/projects/'+projectId,{data:p})).json();
 await page.reload();await page.locator('[data-action="open-conversation"]').click();await page.waitForSelector('#text');
 await page.locator('#text').fill('参考这张图片，给我一段镜头建议');await page.locator('#pick').click();await page.locator('[name=image]').check();await page.locator('#choose').click();
 await page.locator('#send').click();await page.locator('#budget').fill('1');await page.locator('#key').fill('synthetic-browser-secret');await page.locator('#consent').check();await page.locator('#confirm').dblclick();await page.waitForSelector('[data-apply]');assert.equal(chatRequests.length,1);assert.ok(Array.isArray(chatRequests[0].messages[0].content));await page.locator('[data-apply]').click();await page.waitForFunction(()=>document.querySelector('[data-apply]')?.textContent==='已放入画布');
 await page.screenshot({path:path.join(artifacts,'01-conversation.png')});await page.reload();await page.waitForSelector('[data-apply]');assert.equal(await page.locator('.bubble').count(),2);
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(artifacts,'02-mobile-chat.png')});await page.setViewportSize({width:1440,height:960});await page.locator('#back').click();await page.waitForSelector('.node');
 const config=await(await page.request.get('/api/config')).json();await page.request.put('/api/config',{data:{...config,comfyUrl:base}});
 const workflow={'1':{class_type:'Text',inputs:{text:'默认'}},'3':{class_type:'SaveImage',inputs:{images:['1',0]}}};
 const template=await(await page.request.post('/api/workflows',{data:{name:'第一步生成',workflow}})).json();
 const next=await(await page.request.post('/api/workflows',{data:{name:'接上游图片',workflow:{...workflow,'2':{class_type:'LoadImage',inputs:{image:'original.png'}}}}})).json();
 await page.locator('[data-select="'+p.nodes[0].id+'"]').click();await page.locator('[data-action="generate-node"]').click();await page.locator('[data-action="generate-workflow"]').click();await page.locator('[data-workflow="'+template.id+'"]').click();await page.locator('[name="promptField"]').selectOption('0');await page.locator('[data-action="bind-generation"]').click();await page.waitForFunction(()=>!document.querySelector('#modal').open);
 p=await(await page.request.get('/api/projects/'+projectId)).json();assert.equal(p.nodes[0].params.workflowBinding.workflowId,template.id);
 const downstream={...structuredClone(p.nodes[0]),id:'downstream',x:560,title:'下游图片',text:'第二镜',assetId:null};downstream.params.workflowBinding={workflowId:next.id,overrides:[],imageSources:[{nodeId:'2',name:'image',sourceNodeId:p.nodes[0].id}],promptField:{nodeId:'1',name:'text'},count:1};p.nodes.push(downstream);p.edges.push({id:'flow-edge',source:p.nodes[0].id,target:downstream.id});p=await(await page.request.put('/api/projects/'+projectId,{data:p})).json();
 await page.reload();await page.waitForSelector('.node');await page.locator('[data-action="run"]').click();await page.locator('#canvas-run-consent').check();await page.locator('[data-action="start-canvas-run"]').click();await page.waitForSelector('[data-action="apply-generation"]',{timeout:20000});assert.equal(prompts.length,2);assert.equal(uploaded,1);assert.equal(prompts[1].prompt['2'].inputs.image,'upstream.png');await page.screenshot({path:path.join(artifacts,'03-canvas-run.png')});await page.locator('[data-action="apply-generation"]').click();await page.waitForFunction(()=>!document.querySelector('#modal').open);
 await page.locator('[data-action="open-creation-studio"]').click();await page.waitForSelector('#prompt-input');await page.locator('#mode-image').click();await page.locator('#prompt-input').fill('本地模拟生图');await page.locator('#open-connect').click();await page.locator('#connect-protocol').selectOption('modelscope');await page.locator('#connect-url').fill(base+'/v1');await page.locator('#connect-model').fill('Qwen/test');await page.locator('#connect-loras').fill('{"author/style":1}');await page.locator('[data-dialog-action="save-connect"]').click();
 await page.locator('[data-jump="config"]').click();await page.getByText('ModelScope 异步单图',{exact:false}).waitFor();await page.locator('#generate-button').click();await page.locator('#generation-budget').fill('1');await page.locator('#authorize-send').check();await page.locator('#authorize-budget').check();await page.locator('[data-dialog-action="submit-generation"]').click();await page.waitForSelector('[data-dialog-action="apply-job"]',{timeout:20000});assert.equal(posts,1);await page.locator('[data-dialog-action="apply-job"]').click();await page.waitForFunction(()=>document.querySelector('[data-dialog-action="apply-job"]')?.disabled);
 await page.screenshot({path:path.join(artifacts,'04-modelscope.png')});assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:true,checks:['multimodal conversation','single post on double click','answer applied to original project','conversation reload and mobile layout','workflow binding UI','dependency ordered execution','generated image passed downstream','canvas result application','ModelScope protocol and LoRA UI','native task result applied'],chatPosts:chatRequests.length,comfyPosts:prompts.length,modelScopePosts:posts,errors},null,2));console.log(JSON.stringify({passed:true,artifacts}));
}catch(e){if(page){await page.screenshot({path:path.join(artifacts,'failure.png')});console.error('Toast:',await page.locator('#toast').textContent());}console.error(errors);throw e;}
finally{await browser?.close();server.kill('SIGTERM');await new Promise(r=>mock.close(r));}
