import './helpers/local-network-only.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {canvasClipboardService} from '../lib/canvas-clipboard.mjs';
import {clipboardPastePage} from '../lib/clipboard-paste-index.mjs';
import {seedClipboardHistory,clipboardFixtureSignature} from './helpers/clipboard-history-fixture.mjs';
import {makeProject} from '../lib/model.mjs';
import {localServer,persistFixture} from './helpers/library-backup-server.mjs';
const root=path.resolve('artifacts/clipboard-history-scale-tests-'+Date.now());await fs.mkdir(root);
const service=data=>canvasClipboardService({data,projects:{load:async id=>({id,revision:1})}});
test('冷启动1200份大快照使用小摘要分页，原输入零读取且全量旧接口顺序/归属保持',async()=>{
 const data=path.join(root,'scale');await fs.mkdir(data);await seedClipboardHistory(data,'project-one',{count:1200,padding:65536,alternateProjectId:'project-two'});
 const original=fs.readFile;let inputs=0,inputBytes=0;fs.readFile=async function(file,...args){const bytes=await original.call(this,file,...args);if(path.basename(String(file))==='input.json'){inputs++;inputBytes+=Buffer.byteLength(bytes);}return bytes;};
 try{const s=service(data),started=performance.now(),page=await s.list('project-one',{limit:50,offset:0}),coldMs=performance.now()-started;assert.equal(page.total,600);assert.equal(page.items.length,50);assert.equal(page.nextOffset,50);assert.equal(page.items[0].id,'owned-history-01198');assert.equal(inputs,0);assert.equal(inputBytes,0);assert(!JSON.stringify(page).includes('ownedPadding'));
 const next=await s.list('project-one',{limit:50,offset:50});assert.equal(next.items[0].id,'owned-history-01098');assert(!next.items.some(n=>page.items.some(p=>p.id===n.id)));const all=await s.list('project-one');assert(Array.isArray(all));assert.deepEqual(all.slice(0,50),page.items);assert.equal(all.length,600);assert.equal(inputs,0);
 await fs.writeFile(path.join(root,'scale-result.json'),JSON.stringify({ok:true,records:1200,snapshotPaddingBytes:65536,ownedProjectRecords:600,coldPageMilliseconds:coldMs,originalInputReads:inputs,originalInputBytes:inputBytes,pageItems:50,payloadBytes:Buffer.byteLength(JSON.stringify(page)),scope:'本机合成压力记录，时间为本轮观察，不是性能SLA',paidCalls:0,thirdPartyUploads:0},null,2));
 }finally{fs.readFile=original;}
});
test('旧记录首次读取后复用内存摘要，GET不创建索引；结果/状态变化会失效重读',async()=>{
 const data=path.join(root,'legacy');await fs.mkdir(data);await seedClipboardHistory(data,'project-one',{count:2,summary:false});const id='owned-history-00000',dir=path.join(data,'clipboard-pastes',id),s=service(data);assert.equal((await s.list('project-one')).length,2);await assert.rejects(fs.stat(path.join(dir,'list-summary.json')),{code:'ENOENT'});
 const original=fs.readFile;let reads=0;fs.readFile=async function(file,...args){if(path.basename(String(file))==='input.json')reads++;return original.call(this,file,...args);};try{await s.list('project-one');assert.equal(reads,0);const result=JSON.parse(await original(path.join(dir,'result.json')));result.nodeIds.push('owned-second');await fs.writeFile(path.join(dir,'result.json'),JSON.stringify(result));assert.equal((await s.list('project-one')).find(n=>n.id===id).nodes,2);assert.equal(reads,1);}finally{fs.readFile=original;}
});
test('源快照篡改会使缓存失效并拒绝，不能用列表缓存绕过get/resume校验',async()=>{
 const data=path.join(root,'tamper');await fs.mkdir(data);await seedClipboardHistory(data,'project-one',{count:1});const s=service(data),id='owned-history-00000',file=path.join(data,'clipboard-pastes',id,'input.json');await s.list('project-one');const value=JSON.parse(await fs.readFile(file));value.input.sourceSnapshot.name+=' changed';await fs.writeFile(file,JSON.stringify(value));for(const op of [()=>s.list('project-one'),()=>service(data).list('project-one'),()=>s.get('project-one',id),()=>s.resume('project-one',id)])await assert.rejects(op,/原记录已变化/);assert.deepEqual(JSON.parse(await fs.readFile(file)),value);
});
test('损坏或符号链接的摘要回退原记录，源文件链接仍被拒绝',async()=>{
 const data=path.join(root,'cache');await fs.mkdir(data);await seedClipboardHistory(data,'project-one',{count:2});const first=path.join(data,'clipboard-pastes','owned-history-00000'),second=path.join(data,'clipboard-pastes','owned-history-00001');await fs.writeFile(path.join(first,'list-summary.json'),'not JSON');await fs.rename(path.join(second,'list-summary.json'),path.join(second,'old-summary.json'));await fs.symlink(path.join(second,'old-summary.json'),path.join(second,'list-summary.json'));assert.equal((await service(data).list('project-one')).length,2);
 const source=path.join(first,'input.json');await fs.rename(source,source+'.preserved');await fs.symlink(source+'.preserved',source);await assert.rejects(service(data).list('project-one'),/文件无效/);
});
test('分页限制拒绝负数、小数、过大页和非数字；末页及越界页保持准确总数',()=>{
 const rows=Array.from({length:51},(_,i)=>({id:String(i)}));assert.equal(clipboardPastePage(rows,{limit:50,offset:50}).items.length,1);assert.equal(clipboardPastePage(rows,{limit:50,offset:50}).nextOffset,null);assert.deepEqual(clipboardPastePage(rows,{offset:100}).items,[]);assert.equal(clipboardPastePage(rows,{offset:100}).total,51);
 for(const options of [{limit:0},{limit:101},{offset:-1},{offset:'1.5'},{offset:'NaN'},{offset:1000001},{limit:'1e2'},{limit:NaN}])assert.throws(()=>clipboardPastePage(rows,options),/范围无效/);
});
test('实际HTTP完成粘贴生成摘要，重启分页可读且读取/继续原记录不重复节点；旧接口仍为数组',async()=>{
 const data=path.join(root,'http');await fs.mkdir(data);let s=await localServer(data,{envOverrides:{JINGCHANG_NATIVE_MEDIA_MODE:'versioned'}});try{
 const source=await s.api('/api/projects','POST',{name:'真实摘要源'}),target=await s.api('/api/projects','POST',{name:'真实摘要目标'}),url='/api/projects/'+target.id+'/clipboard-pastes',body={requestId:'owned-http-index',revision:target.revision,sourceSnapshot:source,nodeIds:source.nodes.map(n=>n.id),placement:{x:700,y:900}};
 const saved=await s.api(url,'POST',body);assert.equal((await s.api(url)).length,1);const summary=JSON.parse(await fs.readFile(path.join(data,'clipboard-pastes',body.requestId,'list-summary.json')));assert.equal(summary.row.status,'completed');assert.equal(summary.row.canResume,false);assert(!JSON.stringify(summary).includes('sourceSnapshot'));const port=Number(new URL(s.base).port);await s.stop();s=await localServer(data,{ownedPort:port,envOverrides:{JINGCHANG_NATIVE_MEDIA_MODE:'versioned'}});
 const page=await s.api(url+'?limit=50&offset=0');assert.equal(page.total,1);assert.equal(page.items[0].id,body.requestId);assert.deepEqual((await s.api(url+'/'+body.requestId+'/resume','POST',{})).project,saved.project);assert.deepEqual((await s.api(url+'/'+body.requestId)).project,saved.project);
 for(const q of ['limit=101','offset=-1','limit=50&other=1','limit=1.2']){const r=await fetch(s.base+url+'?'+q,{headers:s.headers});assert.equal(r.status,400);}
 assert.equal((await s.api('/api/health')).capabilities.clipboardPastePaging,true);
 }finally{await s.stop();}
});
