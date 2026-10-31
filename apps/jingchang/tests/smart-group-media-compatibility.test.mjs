import './helpers/local-network-only.mjs';import test from 'node:test';import assert from 'node:assert/strict';import {promises as fs} from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';import {smartGroupMediaFixture} from './helpers/smart-group-media-fixture.mjs';import {nativeReferencePlan} from '../lib/native-flow-execution.mjs';import {configureNativeSmartGroupStoredMedia,nativeFlowPreview} from '../lib/native-flow.mjs';import {configureSmartGroupStoredMedia,nativeReferenceChoices} from '../public/native-flow-ui.js';import {localServer,persistFixture} from './helpers/library-backup-server.mjs';
test('候选关闭时保留旧字段选图；新旧第1格不同，发布前必须迁移而不能默默换图',()=>{
 const f=smartGroupMediaFixture(),ref={sourceNodeId:f.id('group'),sourceIndex:0},before=structuredClone(f.p);try{configureNativeSmartGroupStoredMedia(false);configureSmartGroupStoredMedia(false);assert.deepEqual(nativeReferencePlan(f.p,f.node('target'),[ref],{planning:true}).references,[{assetId:'right'}]);assert.match(nativeReferenceChoices(f.p,f.id('target')).find(c=>c.value==='node:'+f.id('group')).label,/2 份已有素材/);configureNativeSmartGroupStoredMedia(true);configureSmartGroupStoredMedia(true);assert.deepEqual(nativeReferencePlan(f.p,f.node('target'),[ref],{planning:true}).references,[{assetId:'own-a'}]);assert.deepEqual(f.p,before);}finally{configureNativeSmartGroupStoredMedia(true);configureSmartGroupStoredMedia(true);}
});
test('真实启动关闭候选时保留旧工程并拒绝新版；启用后新旧工程各用原规则且不改文件',async t=>{
 const stage=path.resolve('artifacts','smart-group-media-compatibility-'+Date.now()),data=path.join(stage,'data'),f=smartGroupMediaFixture(),legacy=structuredClone(f.p),oldEnv=process.env.JINGCHANG_SMART_GROUP_MEDIA_TEST;
 legacy.id=randomUUID();delete legacy.settings.nativeMediaVersion;
 await persistFixture({data,p:legacy});await persistFixture({data,p:f.p});
 const projectFiles=[legacy,f.p].map(p=>path.join(data,'projects',p.id,'project.json')),before=await Promise.all(projectFiles.map(p=>fs.readFile(p,'utf8')));let server;
 t.after(async()=>{await server?.stop();if(oldEnv===undefined)delete process.env.JINGCHANG_SMART_GROUP_MEDIA_TEST;else process.env.JINGCHANG_SMART_GROUP_MEDIA_TEST=oldEnv;});
 delete process.env.JINGCHANG_SMART_GROUP_MEDIA_TEST;server=await localServer(data);
 assert.equal((await server.api('/api/health')).capabilities.smartGroupStoredMedia,false);
 assert.deepEqual(await server.api('/api/projects/'+legacy.id),legacy);
 const flow=id=>'/api/projects/'+id+'/native-flow?nodeId='+f.id('group');
 assert.deepEqual((await server.api(flow(legacy.id))).nodes[0].media.map(m=>m.assetId),['right','left']);
 for(const url of ['/api/projects/'+f.p.id,flow(f.p.id)]){
  const r=await fetch(server.base+url,{headers:server.headers});assert.equal(r.status,409);assert.equal((await r.json()).code,'NATIVE_MEDIA_RULES_UNAVAILABLE');
 }
 const port=Number(new URL(server.base).port);await server.stop();process.env.JINGCHANG_SMART_GROUP_MEDIA_TEST='1';server=await localServer(data,{ownedPort:port});
 assert.equal((await server.api('/api/health')).capabilities.smartGroupStoredMedia,true);
 assert.deepEqual((await server.api(flow(legacy.id))).nodes[0].media.map(m=>m.assetId),['right','left']);
 assert.deepEqual((await server.api(flow(f.p.id))).nodes[0].media.map(m=>m.assetId),['own-a','own-b','left','right']);
 assert.deepEqual(await server.api('/api/projects/'+legacy.id),legacy);assert.deepEqual(await server.api('/api/projects/'+f.p.id),f.p);
 assert.deepEqual(await Promise.all(projectFiles.map(p=>fs.readFile(p,'utf8'))),before);assert.deepEqual(await server.api('/api/jobs'),[]);
 await fs.writeFile(path.join(stage,'result.json'),JSON.stringify({ok:true,defaultCandidateEnabled:false,ownedOptIn:true,actualSamePortRestart:true,projectsUnchanged:true,legacyFirst:'right',candidateFirst:'own-a',legacyStillFirstRightAfterEnable:true,modernProjectRefusedBeforeEnable:true,requiresSavedIndexMigration:true,releaseReady:false,paidCalls:0,thirdPartyUploads:0},null,2));
});
