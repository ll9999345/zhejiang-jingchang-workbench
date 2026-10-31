import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {normalizeAssetClassification} from '../lib/asset-classification.mjs';

async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return server.address().port;}
async function close(server){if(!server.listening)return;await new Promise(resolve=>server.close(resolve));}
async function reservePort(){const server=http.createServer();const port=await listen(server);await close(server);return port;}

test('classification results are normalized to bounded dimensions, labels, and tags',()=>{
  const result=normalizeAssetClassification({summary:'  海边  ',categories:{environment:['室外','室外','#城市'],style:'电影感，写实'},tags:['海岸','海岸','日落']},{providerId:'provider-1',model:'vision-test'});
  assert.equal(result.summary,'海边');
  assert.deepEqual(result.categories,{environment:['室外','城市'],style:['电影感','写实']});
  assert.deepEqual(result.flat.map(item=>[item.dimension,item.label,item.tag]),[['environment','环境','室外'],['environment','环境','城市'],['style','风格','电影感'],['style','风格','写实'],['tags','标签','海岸'],['tags','标签','日落']]);
  assert.equal(result.providerId,'provider-1');assert.equal(result.model,'vision-test');
  assert.throws(()=>normalizeAssetClassification({categories:{},tags:[]}),/没有返回可用/);
});

test('image classification requires consent, makes one mock request, stores no key, and powers smart-class filtering',async t=>{
  const data=await fs.mkdtemp(path.join(os.tmpdir(),'jingchang-classification-'));
  const key='sk-test-classification-secret';
  const state={calls:[]};
  const upstream=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const payload=JSON.parse(Buffer.concat(chunks).toString());state.calls.push({payload,authorization:req.headers.authorization});
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({summary:`海边日落 ${key}`,categories:{environment:['室外','海边'],style:['电影感']},tags:['海岸','夕阳']})}}]}));
  });
  const upstreamPort=await listen(upstream),appPort=await reservePort();
  const child=spawn(process.execPath,['server.mjs'],{cwd:process.cwd(),env:{...process.env,PORT:String(appPort),JINGCHANG_DATA_DIR:data,JINGCHANG_LLM_URL:'',JINGCHANG_LLM_MODEL:''},stdio:['ignore','pipe','pipe']});
  t.after(async()=>{child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));await close(upstream);await fs.rm(data,{recursive:true,force:true});});
  await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw new Error('test server exited');}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('test server startup timeout')),30000).unref())]);
  const base=`http://127.0.0.1:${appPort}`;
  const upload=await fetch(base+'/api/assets?name=海岸.png',{method:'POST',headers:{'content-type':'image/png'},body:Buffer.from('89504e470d0a1a0a01020304','hex')});assert.equal(upload.status,201);const asset=await upload.json();
  const configured=await fetch(base+'/api/platforms',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({revision:0,platform:{name:'本机模拟视觉模型',protocol:'openai-compatible',baseUrl:`http://127.0.0.1:${upstreamPort}/v1`,models:[{id:'vision-model',label:'视觉模型',category:'chat',referenceSupport:true}]}})});assert.equal(configured.status,200,await configured.clone().text());const platform=await configured.json(),platformId=platform.platforms[0].id;

  const extensionOrigin='chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  const catalogResponse=await fetch(base+'/api/chrome-import/classification-models',{headers:{Origin:extensionOrigin}});assert.equal(catalogResponse.status,200);assert.equal(catalogResponse.headers.get('access-control-allow-origin'),extensionOrigin);
  const catalog=await catalogResponse.json();assert.deepEqual(catalog.models.map(({platformId:id,modelId})=>[id,modelId]),[[platformId,'vision-model']]);assert.ok(!JSON.stringify(catalog).includes(key));
  const catalogPreflight=await fetch(base+'/api/chrome-import/classification-models',{method:'OPTIONS',headers:{Origin:extensionOrigin,'Access-Control-Request-Method':'GET'}});assert.equal(catalogPreflight.status,204);assert.equal(catalogPreflight.headers.get('access-control-allow-methods'),'GET, OPTIONS');
  const classifyPreflight=await fetch(`${base}/api/assets/${asset.id}/classify`,{method:'OPTIONS',headers:{Origin:extensionOrigin,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type','Access-Control-Request-Private-Network':'true'}});assert.equal(classifyPreflight.status,204);assert.equal(classifyPreflight.headers.get('access-control-allow-private-network'),'true');
  const deniedCatalog=await fetch(base+'/api/chrome-import/classification-models',{headers:{Origin:'https://untrusted.example'}});assert.equal(deniedCatalog.status,403);
  const deniedPlatforms=await fetch(base+'/api/platforms',{headers:{Origin:extensionOrigin}});assert.equal(deniedPlatforms.status,403);

  const requestId='classification-request-1',auth={origin:`http://127.0.0.1:${upstreamPort}`,model:'vision-model',sendImage:true,requestLimit:1,budget:0,currency:'CNY',consent:true};
  const denied=await fetch(`${base}/api/assets/${asset.id}/classify`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestId,platformId,model:'vision-model',apiKey:key,consent:false,authorization:{...auth,consent:false}})});assert.equal(denied.status,400);assert.equal(state.calls.length,0);
  const submitted={requestId,platformId,model:'vision-model',apiKey:key,prompt:'突出文旅用途',consent:true,authorization:auth};
  const response=await fetch(`${base}/api/assets/${asset.id}/classify`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(submitted)});assert.equal(response.status,200);const classified=await response.json();
  assert.equal(state.calls.length,1);assert.equal(state.calls[0].authorization,`Bearer ${key}`);assert.ok(state.calls[0].payload.messages[0].content.some(part=>part.type==='image_url'&&part.image_url.url.startsWith('data:image/png;base64,')));assert.match(state.calls[0].payload.messages[0].content[0].text,/突出文旅用途/);
  assert.equal(classified.classification.summary,'海边日落 [已隐藏密钥]');assert.deepEqual(classified.classification.categories.environment,['室外','海边']);
  const repeated=await fetch(`${base}/api/assets/${asset.id}/classify`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(submitted)});assert.equal(repeated.status,200);assert.equal(state.calls.length,1);
  const secondUpload=await fetch(base+'/api/assets?name=扩展分类.png',{method:'POST',headers:{'content-type':'image/png'},body:Buffer.from('89504e470d0a1a0a05060708','hex')});assert.equal(secondUpload.status,201);const secondAsset=await secondUpload.json();
  const extensionSubmission=await fetch(`${base}/api/assets/${secondAsset.id}/classify`,{method:'POST',headers:{Origin:extensionOrigin,'content-type':'application/json'},body:JSON.stringify({...submitted,requestId:'extension-classification-request'})});assert.equal(extensionSubmission.status,200);assert.equal(extensionSubmission.headers.get('access-control-allow-origin'),extensionOrigin);assert.equal(state.calls.length,2);
  const facets=await (await fetch(`${base}/api/assets/page?scope=global&type=image&smartClass=environment%3A%3A%E6%B5%B7%E8%BE%B9`)).json();assert.equal(facets.total,2);assert.ok(facets.items.some(item=>item.id===asset.id));assert.ok(facets.items.some(item=>item.id===secondAsset.id));assert.ok(facets.smartClasses.some(item=>item.id==='environment::海边'));
  const files=await fs.readdir(path.join(data,'assets'));const saved=await fs.readFile(path.join(data,'assets',asset.id+'.json'),'utf8');const settings=await fs.readFile(path.join(data,'api-platforms.json'),'utf8');
  assert.ok(files.includes(asset.id));assert.ok(!saved.includes(key));assert.ok(!settings.includes(key));assert.ok(!await fs.readFile(path.join(data,'assets',asset.id),'utf8').then(x=>x.includes(key)));
});
