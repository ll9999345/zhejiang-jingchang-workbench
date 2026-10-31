import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {makeProject} from '../lib/model.mjs';
import {atomicJson} from '../lib/workspace.mjs';
import {localServer} from './helpers/library-backup-server.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGbcAAAAASUVORK5CYII=','base64');
const sha=b=>createHash('sha256').update(b).digest('hex');
async function fixture(){
 const source=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'jc-native-lib-http-source-'))),data=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'jc-native-lib-http-target-'))),p=makeProject('原版素材库 HTTP 验收'),other=makeProject('另一临时工程');
 await fs.mkdir(path.join(source,'data'));await fs.mkdir(path.join(source,'assets','library'),{recursive:true});
 await fs.writeFile(path.join(source,'assets','library','original.png'),png);
 const comfy={'1':{class_type:'EmptyLatentImage',inputs:{width:32,height:32,batch_size:1}},'2':{class_type:'SaveImage',inputs:{images:['1',0],filename_prefix:'local-only'}}},fragment={format:'infinite-canvas-workflow',version:1,nodes:[{id:'source-prompt',type:'text',x:0,y:0,text:'本机虚构文字'}],connections:[],resources:[]};
 await fs.writeFile(path.join(source,'assets','library','comfy.json'),JSON.stringify(comfy));await fs.writeFile(path.join(source,'assets','library','fragment.json'),JSON.stringify(fragment));
 const index={active_library_id:'first',libraries:[{id:'first',name:'原版资料',categories:[{id:'media',name:'测试图片',type:'image',items:[{id:'img',name:'原图',kind:'image',url:'/assets/library/original.png'}]},{id:'empty',name:'空分组',type:'image',items:[]},{id:'workflows',name:'流程',type:'workflow',items:[{id:'comfy',name:'本机 Comfy 模板',kind:'workflow',url:'/assets/library/comfy.json'},{id:'canvas',name:'画布片段',kind:'workflow',url:'/assets/library/fragment.json'}]}]},{id:'second',name:'第二原版库',categories:[]}],updated_at:1783212587156};
 await fs.writeFile(path.join(source,'data','asset_library.json'),JSON.stringify(index));await atomicJson(path.join(data,'projects',p.id,'project.json'),p);await atomicJson(path.join(data,'projects',other.id,'project.json'),other);
 return{source,data,p,other,index};
}
async function response(server,url,payload){const r=await fetch(server.base+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});return{status:r.status,value:await r.json()};}
test('真实本机HTTP：先检后迁、新库可读取/下载、重启读原记录、零任务且原工程不变',async t=>{
 const f=await fixture(),originalIndex=await fs.readFile(path.join(f.source,'data','asset_library.json'));let server=await localServer(f.data);t.after(()=>server.stop());
 const before=await server.api('/api/projects/'+f.p.id),initial=await server.api('/api/asset-catalog'),health=await server.api('/api/health');assert.equal(health.capabilities.nativeLibraryImport,true);
 const requestId=randomUUID(),checked=await server.api('/api/native-library-imports/preview','POST',{requestId,projectId:f.p.id,sourceDirectory:f.source});assert.equal(checked.canImport,true);assert.equal(checked.counts.media,1);assert.equal(checked.counts.workflows,1);assert.equal(checked.counts.fragments,1);assert.equal(checked.id,requestId);assert.deepEqual(await server.api('/api/asset-catalog'),initial);
 const importId=randomUUID(),body={requestId:importId,projectId:f.p.id,revision:initial.revision,confirmLocalImport:true},done=await server.api('/api/native-library-imports/'+checked.id+'/import','POST',body);assert.equal(done.status,'completed');
 const catalog=await server.api('/api/asset-catalog');assert.equal(catalog.libraries.length,initial.libraries.length+2);assert.equal(catalog.activeLibraryId,initial.activeLibraryId);assert.deepEqual(catalog.libraries[0],initial.libraries[0]);const added=catalog.libraries.filter(l=>done.libraryIds.includes(l.id));assert.deepEqual(added.map(l=>l.name),['原版资料','第二原版库']);assert.equal(added[0].folders[1].items.length,0);
 const assetItem=added[0].folders[0].items[0],detail=await server.api('/api/asset-catalog/items/'+assetItem.id),media=await fetch(server.base+'/media/'+detail.asset.id);assert.equal(media.status,200);assert.equal(sha(Buffer.from(await media.arrayBuffer())),sha(png));
 for(const item of added[0].folders[2].items){const r=await fetch(server.base+'/api/asset-catalog/items/'+item.id+'/download');assert.equal(r.status,200);assert.ok((await r.arrayBuffer()).byteLength>0);}
 assert.deepEqual(await server.api('/api/projects/'+f.p.id),before);assert.deepEqual(await server.api('/api/jobs?projectId='+f.p.id),[]);assert.deepEqual(await fs.readFile(path.join(f.source,'data','asset_library.json')),originalIndex);assert.deepEqual(await fs.readFile(path.join(f.source,'assets','library','original.png')),png);
 await server.stop();server=await localServer(f.data);const saved=await server.api('/api/native-library-imports/'+checked.id+'?projectId='+f.p.id);assert.equal(saved.status,'completed');assert.equal(saved.importRequestId,importId);assert.equal(saved.canImport,false);assert.equal((await server.api('/api/native-library-imports?projectId='+f.p.id)).items.length,1);
 const again=await server.api('/api/native-library-imports/'+checked.id+'/import','POST',body);assert.equal(again.alreadyPublished,true);assert.deepEqual(again.libraryIds,done.libraryIds);assert.equal((await server.api('/api/asset-catalog')).libraries.length,catalog.libraries.length);assert.deepEqual(await server.api('/api/projects/'+f.p.id),before);
});
test('真实HTTP：错误工程/未确认/旧修订/变化原件拒绝；按原编号重试不重复发布',async t=>{
 const f=await fixture(),server=await localServer(f.data);t.after(()=>server.stop());const initial=await server.api('/api/asset-catalog'),preview=await server.api('/api/native-library-imports/preview','POST',{requestId:randomUUID(),projectId:f.p.id,sourceDirectory:f.source}),url='/api/native-library-imports/'+preview.id+'/import',id=randomUUID(),body={requestId:id,projectId:f.p.id,revision:initial.revision,confirmLocalImport:true};
 const wrong=await response(server,url,{...body,projectId:f.other.id});assert.equal(wrong.status,409);assert.equal((await response(server,url,{...body,confirmLocalImport:false})).status,400);
 await server.api('/api/asset-catalog/libraries','POST',{name:'并发新增库',revision:initial.revision});const current=await server.api('/api/asset-catalog');assert.equal((await response(server,url,body)).status,409);const record=await server.api('/api/native-library-imports/'+preview.id+'?projectId='+f.p.id);assert.equal(record.importRequestId,id);
 const done=await server.api(url,'POST',{...body,revision:current.revision});assert.equal(done.status,'completed');assert.ok((await server.api('/api/asset-catalog')).libraries.some(l=>l.name==='并发新增库'));assert.equal((await response(server,url,{...body,requestId:randomUUID()})).status,409);
 const another=await server.api('/api/native-library-imports/preview','POST',{requestId:randomUUID(),projectId:f.p.id,sourceDirectory:f.source}),latest=await server.api('/api/asset-catalog');await fs.writeFile(path.join(f.source,'assets','library','original.png'),Buffer.concat([png,Buffer.from('changed')]));const changed=await response(server,'/api/native-library-imports/'+another.id+'/import',{...body,requestId:randomUUID(),revision:latest.revision});assert.equal(changed.status,409);assert.deepEqual(await server.api('/api/asset-catalog'),latest);assert.deepEqual(await server.api('/api/jobs?projectId='+f.p.id),[]);
 const notFound=await fetch(server.base+'/api/native-library-imports?projectId=unknown');assert.equal(notFound.status,404);
});
