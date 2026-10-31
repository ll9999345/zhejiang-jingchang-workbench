import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {creationStudioService} from '../lib/creation-studio.mjs';
import {readJson} from '../lib/workspace.mjs';
import {makeProject,makeNode} from '../lib/model.mjs';
import {normalizeStudioBinding,studioStep,studioCredentials} from '../lib/canvas-studio.mjs';
import './helpers/local-network-only.mjs';
const refs=[{url:'asset://image-one',type:'image/png'},{url:'asset://video-one',type:'video/mp4'},{url:'asset://audio-one',type:'audio/mpeg'}];
test('real loopback APIMart multi request maps each media category, requires separate original-media consent, and saves one result',{timeout:20000},async t=>{
 const calls=[],video=Buffer.from('000000186674797069736f6d0000020069736f6d69736f32','hex'),server=http.createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;calls.push({path:req.url,method:req.method,body:raw?JSON.parse(raw):null});res.setHeader('content-type','application/json');if(req.url==='/v1/videos/generations')return res.end(JSON.stringify({code:200,data:[{task_id:'video-multi-one'}]}));if(req.url==='/v1/tasks/video-multi-one')return res.end(JSON.stringify({code:200,data:{id:'video-multi-one',status:'completed',result:{videos:[{url:[origin+'/video']}]}}}));if(req.url==='/video'){assert.equal(req.headers.authorization,undefined);res.setHeader('content-type','video/mp4');return res.end(video);}res.statusCode=404;res.end('{}');});server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jingchang-apimart-multi-')),activeJobs=new Map(),service=creationStudioService({data,activeJobs,pollInterval:5});let s=await service.create({mode:'video'});s=await service.save(s.id,{...s,prompt:'本机合成协议测试',references:refs,config:{...s.config,baseUrl:origin+'/v1',protocol:'apimart',model:'doubao-seedance-2.0',duration:5,apimartReferenceMode:'multimodal'}});
 const body={revision:s.revision,requestId:'multi-one',apiKey:'synthetic-local-vision',authorization:{origin,model:s.config.model,requestLimit:1,budget:1,currency:'CNY',sendPrompt:true,sendReferences:true}};await assert.rejects(service.start(s.id,structuredClone(body)),/单独确认/);assert.equal(calls.length,0);
 body.authorization.sendOriginalMedia=true;const job=await service.start(s.id,body);let result;for(let i=0;i<400;i++){result=await readJson(path.join(data,'jobs',job.id+'.json'));if(result.status==='completed'||result.status==='failed')break;await new Promise(r=>setTimeout(r,8));}assert.equal(result.status,'completed',result.message);assert.equal(result.authorization.sendOriginalMedia,true);assert.equal(result.assets.length,1);assert.deepEqual(calls[0].body.image_urls,['asset://image-one']);assert.deepEqual(calls[0].body.video_urls,['asset://video-one']);assert.deepEqual(calls[0].body.audio_urls,['asset://audio-one']);assert.equal(calls[0].body.image_with_roles,undefined);assert.equal(calls.filter(r=>r.method==='POST').length,1);
});
test('canvas multi step preserves typed URIs and requires original-media authorization before downstream execution',async()=>{
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jingchang-apimart-node-')),p=makeProject('本机画布APIMart'),n=makeNode('video',0,0,{text:'虚拟人物动作'});n.params.studioBinding=normalizeStudioBinding({mode:'video',config:{protocol:'apimart',baseUrl:'http://127.0.0.1:18888/v1',model:'doubao-seedance-2.0',duration:5,apimartReferenceMode:'multimodal'},referenceSources:refs});p.nodes=[n];p.edges=[];const step=await studioStep({data,project:p,node:n,binding:n.params.studioBinding,parents:[],text:n.text});assert.equal(step.sendOriginalMedia,true);assert.deepEqual(step.studio.referenceSources,refs);
 const item={nodeId:n.id,apiKey:'synthetic-node-key',authorization:{origin:'http://127.0.0.1:18888',model:'doubao-seedance-2.0',sendPrompt:true,sendReferences:true,requestLimit:1,budget:1,currency:'CNY'}};assert.throws(()=>studioCredentials([step],{studioCredentials:[item]}),/单独确认/);item.authorization.sendOriginalMedia=true;studioCredentials([step],{studioCredentials:[item]});assert.equal(step.authorization.sendOriginalMedia,true);
});
