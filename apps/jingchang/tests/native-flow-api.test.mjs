import {NATIVE_MEDIA_SESSION_HEADER,nativeMediaSessionToken,nativeMediaSessionFromHealth} from '../public/native-media-session-core.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID,createHash} from 'node:crypto';
import {nativeToFragment,normalizeNativeWorkflow} from '../lib/native-canvas-core.mjs';
import {storeAsset,atomicJson} from '../lib/workspace.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const source=(id,type,extra={})=>({id,type,x:0,y:0,...extra});
async function inventory(directory){const result={};for(const entry of await fs.readdir(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isDirectory())for(const [key,value]of Object.entries(await inventory(file)))result[entry.name+'/'+key]=value;else if(entry.isFile())result[entry.name]=hash(await fs.readFile(file));}return result;}

test('隔离服务的原生数据流 API：保存项目、任务快照、全量结果、回合隔离及 GET 不写数据',async t=>{
 const stage=path.join(root,'artifacts','native-flow-progress-1790869861556');await fs.mkdir(stage,{recursive:true});
 const data=await fs.mkdtemp(path.join(stage,'api-data-')),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
 const a=await storeAsset(data,png,{name:'本机样本甲.png',type:'image/png'}),b=await storeAsset(data,png,{name:'本机样本乙.png',type:'image/png'});
 const project=nativeToFragment(normalizeNativeWorkflow({format:'infinite-smart-canvas-workflow',nodes:[source('p','smart-prompt',{text:'甲;乙',promptSplitEnabled:true}),source('g','smart-group',{items:['p']}),source('c','comfy'),source('o','output')],connections:[{from:'g',to:'c'},{from:'c',to:'o'}]}),[],'接口独立样本');
 const [prompt,group,generator,output]=project.nodes;
 const snapshot=structuredClone(project);project.revision=7;project.nodes[0].text='任务提交后新编辑';
 await atomicJson(path.join(data,'projects',project.id,'project.json'),project);
 const job={id:randomUUID(),kind:'canvas-run',projectId:project.id,status:'completed',snapshot,steps:[{nodeId:generator.id,status:'completed'}],assets:[{...a,sourceNodeId:generator.id},{...b,sourceNodeId:generator.id}],textResults:[]};
 const loopId=randomUUID(),looped={...job,id:randomUUID(),steps:[{nodeId:generator.id,status:'completed',loopId,roundIndex:0},{nodeId:generator.id,status:'completed',loopId,roundIndex:1}],assets:[{...a,sourceNodeId:generator.id,loopId,roundIndex:0},{...b,sourceNodeId:generator.id,loopId,roundIndex:1}]};
 const incomplete={...job,id:randomUUID(),status:'interrupted',steps:[{nodeId:generator.id,status:'incomplete'}]},foreign={...job,id:randomUUID(),projectId:randomUUID()},empty={...job,id:randomUUID(),assets:[]};
 for(const record of [job,looped,incomplete,foreign,empty])await atomicJson(path.join(data,'jobs',record.id+'.json'),record);
 const reservation=http.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
 const server=spawn(process.execPath,['--import','./tests/helpers/local-network-only.mjs','server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),JINGCHANG_DATA_DIR:data,JINGCHANG_SMART_GROUP_MEDIA_TEST:'1',JINGCHANG_LLM_URL:'',JINGCHANG_LLM_MODEL:'',ARK_API_KEY:'',OPENAI_API_KEY:''},stdio:['ignore','pipe','pipe']});let serverOutput='';server.stdout.on('data',bytes=>serverOutput+=bytes);server.stderr.on('data',bytes=>serverOutput+=bytes);
 t.after(async()=>{if(server.exitCode===null){server.kill('SIGTERM');await once(server,'exit');}await fs.writeFile(path.join(data,'server-output.txt'),serverOutput);});
 const base='http://127.0.0.1:'+port;let ready=false;for(let i=0;i<200;i++){if(server.exitCode!==null)throw Error('隔离服务启动失败：'+serverOutput);try{ready=(await fetch(base+'/api/health')).ok;if(ready)break;}catch{}await delay(25);}assert.equal(ready,true);
 const health=await (await fetch(base+'/api/health')).json(),headers={[NATIVE_MEDIA_SESSION_HEADER]:nativeMediaSessionToken(nativeMediaSessionFromHealth(health))};assert.equal(health.nativeMediaSession.storedMedia,true);assert.equal((await fetch(base+'/api/projects/'+project.id+'/native-flow')).status,409);
 const before=await inventory(data),request=async query=>{const response=await fetch(base+'/api/projects/'+project.id+'/native-flow'+query,{headers});return{status:response.status,body:await response.json()};};
 await t.test('保存后的文字和组顺序可读，解析不开放执行',async()=>{const result=await request('?nodeId='+group.id);assert.equal(result.status,200);assert.equal(result.body.source,'saved-project');assert.equal(result.body.executionEnabled,false);assert.deepEqual(result.body.nodes[0].promptItems,['任务提交后新编辑']);});
 await t.test('任务快照保留提交时文字，全量两份生成结果进入输出接收器',async()=>{const result=await request('?jobId='+job.id+'&nodeId='+output.id);assert.equal(result.status,200);assert.equal(result.body.source,'job-snapshot');assert.equal(result.body.resultJob.projectRevision,0);assert.equal(result.body.resultJob.currentProjectRevision,7);assert.deepEqual(result.body.nodes[0].media.map(m=>m.assetId),[a.id,b.id]);const original=await request('?jobId='+job.id+'&nodeId='+prompt.id);assert.deepEqual(original.body.nodes[0].promptItems,['甲','乙']);});
 await t.test('循环任务默认不混合多轮，明确回合仅提取该轮',async()=>{const absent=await request('?jobId='+looped.id+'&nodeId='+output.id);assert.equal(absent.body.resultJob.completedOutputNodes,0);assert.deepEqual(absent.body.nodes[0].media,[]);const result=await request('?jobId='+looped.id+'&loopId='+loopId+'&roundIndex=1&nodeId='+output.id);assert.equal(result.status,200);assert.deepEqual(result.body.nodes[0].media.map(m=>m.assetId),[b.id]);});
 await t.test('未完整完成的步骤不作为有效结果',async()=>{const result=await request('?jobId='+incomplete.id+'&nodeId='+output.id);assert.equal(result.status,200);assert.deepEqual(result.body.nodes[0].media,[]);assert.equal(result.body.resultJob.completedOutputNodes,0);});
 await t.test('外项目、空结果、无效编号、无效回合和方法均拒绝',async()=>{for(const query of ['?jobId='+foreign.id,'?jobId='+empty.id,'?jobId=../outside','?nodeId=missing','?nodeId=','?jobId='+looped.id+'&roundIndex=1','?jobId='+looped.id+'&loopId='+loopId+'&roundIndex=01','?jobId='+looped.id+'&loopId='+loopId+'&roundIndex=99','?loopId='+loopId+'&roundIndex=1'])assert.equal((await request(query)).status,400,query);assert.equal((await request('?jobId=absent')).status,404);const post=await fetch(base+'/api/projects/'+project.id+'/native-flow',{method:'POST',headers:{'content-type':'application/json',...headers},body:'{}'});assert.equal(post.status,404);});
 await t.test('所有查询之后项目、任务、素材原字节及文件集合不变',async()=>{assert.deepEqual(await inventory(data),before);});
 await fs.writeFile(path.join(stage,'api-receipt.json'),JSON.stringify({data,port,scope:'loopback-only',readOnly:true,projectId:project.id,jobId:job.id,checks:6,executionEnabled:false},null,2)+'\n');
});
