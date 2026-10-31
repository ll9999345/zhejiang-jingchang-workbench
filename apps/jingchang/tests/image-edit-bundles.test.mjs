import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Readable} from 'node:stream';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {projectBundleService} from '../lib/project-bundles.mjs';
import {editImage,readImageEdit} from '../lib/media-tools.mjs';
import {storeAsset,atomicJson,readJson,userError} from '../lib/workspace.mjs';
import {makeProject,makeNode} from '../lib/model.mjs';
const exec=promisify(execFile),magic=Buffer.from('JINGCHANG-PACK-1\n');
async function fixture(){const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-edit-bundle-')),activeJobs=new Map(),projects={load:async id=>{try{return await readJson(path.join(data,'projects',id,'project.json'));}catch(e){if(e.code==='ENOENT')throw userError('项目不存在',404);throw e;}},save:async p=>{await atomicJson(path.join(data,'projects',p.id,'project.json'),p);return p;}};return{data,activeJobs,projects,service:projectBundleService({data,activeJobs,projects})};}
async function seed(){const f=await fixture(),png=path.join(f.data,'source.png');await exec('ffmpeg',['-v','error','-f','lavfi','-i','testsrc=size=12x9:rate=1','-frames:v','1','-threads','1','-update','1',png]);const source=await storeAsset(f.data,await fs.readFile(png),{name:'编辑原图.png',type:'image/png'}),first=await editImage({data:f.data,assetId:source.id,operations:[{type:'expand',left:2,right:2},{type:'mask-rect',x:4,y:2,width:2,height:3}]}),second=await editImage({data:f.data,assetId:first.image.id,operations:[{type:'paint',size:2,color:'#ff0000',points:[[5.5,4.5]]}]}),unrelated=await editImage({data:f.data,assetId:source.id,operations:[]}),p=makeProject('可编辑成品迁移');p.nodes=[makeNode('image',100,100,{assetId:second.image.id})];p.assets=[second.image];await f.projects.save(p);return{...f,source,first,second,unrelated,p};}
async function bytes(file,fn){const raw=await fs.readFile(file),len=raw.readUInt32BE(magic.length),m=JSON.parse(raw.subarray(magic.length+4,magic.length+4+len));fn(m);const json=Buffer.from(JSON.stringify(m)),head=Buffer.alloc(4);head.writeUInt32BE(json.length);return Buffer.concat([magic,head,json,raw.subarray(magic.length+4+len)]);}
async function exportFile(s){const e=await s.service.exportBundle(s.p.id,0);return{e,file:await s.service.download(e.id)};}
async function counts(f){return Promise.all(['projects','assets','image-edits'].map(dir=>fs.readdir(path.join(f.data,dir)).then(x=>x.length).catch(()=>0)));}
test('editable backup gathers recursive source/output closure, remaps all IDs and replays in a blank workspace',async()=>{
 const s=await seed(),{e,file}=await exportFile(s),t=await fixture(),preview=await t.service.upload(createReadStream(file));assert.equal(e.formatVersion,2);assert.equal(preview.imageEdits,2);assert.equal(preview.assets,7);const p=await t.service.importBundle(preview.id);assert.notEqual(p.id,s.p.id);assert.equal(p.nodes.length,1);assert.equal(p.assets.length,7);
 const final=p.assets.find(a=>a.id===p.nodes[0].assetId),r2=await readImageEdit(t.data,final.editId),first=p.assets.find(a=>a.id===r2.sourceAssetId),r1=await readImageEdit(t.data,first.editId);assert.notEqual(r2.id,s.second.editId);assert.notEqual(r1.id,s.first.editId);assert.notEqual(r1.sourceAssetId,s.source.id);assert.equal(r2.outputs.image,final.id);assert.equal(r1.outputs.image,first.id);
 for(const [original,r] of [[s.first,r1],[s.second,r2]])for(const kind of ['image','mask','input']){const a=p.assets.find(a=>a.id===r.outputs[kind]);assert.equal(a.editId,r.id);assert.equal(a.sourceAssetId,r.sourceAssetId);assert.deepEqual(await fs.readFile(path.join(t.data,'assets',a.id)),await fs.readFile(path.join(s.data,'assets',original[kind].id)));}
 const replay=await editImage({data:t.data,assetId:r2.sourceAssetId,operations:r2.operations});assert.deepEqual(await fs.readFile(path.join(t.data,'assets',replay.image.id)),await fs.readFile(path.join(s.data,'assets',s.second.image.id)));assert.deepEqual(await s.projects.load(s.p.id),s.p);
 const again=await t.service.importBundle(preview.id);assert.equal(again.id,p.id);const exported=await t.service.exportBundle(p.id,0),third=await fixture(),inspection=await third.service.upload(createReadStream(await t.service.download(exported.id)));assert.equal(inspection.imageEdits,2);assert.equal(inspection.assets,7);assert.equal(t.activeJobs.size,0);assert.equal((await fs.readdir(path.join(s.data,'image-edits'))).length,3);
});
test('editable backup rejects malformed steps, missing/orphan outputs, cycles and inconsistent PNG dimensions before project creation',async()=>{
 const s=await seed(),{file}=await exportFile(s),t=await fixture();
 const mutations=[m=>m.imageEdits.pop(),m=>{m.imageEdits[0].version=9;},m=>{m.imageEdits[0].sourceAssetId='missing';},m=>{m.imageEdits[0].operations=[{type:'run-code'}];},m=>{m.assets.find(a=>a.editId).editId='unknown';},m=>{m.imageEdits[0].outputs.mask=m.imageEdits[0].outputs.image;},m=>{m.imageEdits.push(m.imageEdits[0]);},m=>{m.version=1;},m=>{m.imageEdits[0].operations[0].apiKey='synthetic-not-written';}];
 for(const mutate of mutations)await assert.rejects(t.service.upload(Readable.from([await bytes(file,mutate)])));
 // Consistent manifest dimensions still must match actual PNG headers.
 await assert.rejects(t.service.upload(Readable.from([await bytes(file,m=>{const r=m.imageEdits.find(r=>r.id===s.second.editId);r.operations.push({type:'expand',right:1});r.width++;for(const a of m.assets)if(a.editId===r.id)a.width++;})])),/PNG实际尺寸/);
 await assert.rejects(t.service.upload(Readable.from([await bytes(file,m=>{for(const r of m.imageEdits){r.sourceWidth=16;r.sourceHeight=9;r.width=16;r.height=9;r.operations=[];r.sourceAssetId=m.imageEdits.find(other=>other.id!==r.id).outputs.image;for(const a of m.assets)if(a.editId===r.id){a.sourceAssetId=r.sourceAssetId;a.width=16;a.height=9;}}})])),/循环/);
 assert.deepEqual(await counts(t),[0,0,0]);
});
test('missing source records and source files prevent silently flattening a full export',async()=>{
 const s=await seed();const meta=await readJson(path.join(s.data,'assets',s.second.image.id+'.json'));await atomicJson(path.join(s.data,'assets',meta.id+'.json'),{...meta,editId:'missing-edit'});await assert.rejects(s.service.exportBundle(s.p.id,0),/缺少图片编辑记录/);await atomicJson(path.join(s.data,'assets',meta.id+'.json'),meta);
 const record=await readImageEdit(s.data,s.first.editId);await atomicJson(path.join(s.data,'image-edits',record.id+'.json'),{...record,sourceAssetId:'missing-source'});await assert.rejects(s.service.exportBundle(s.p.id,0),/缺少或无法读取/);assert.deepEqual(await s.projects.load(s.p.id),s.p);
});
test('interrupted editable import reuses its plan and preserves unrelated records',async()=>{
 const s=await seed(),{file}=await exportFile(s),t=await fixture(),preview=await t.service.upload(createReadStream(file)),save=t.projects.save;await atomicJson(path.join(t.data,'image-edits','unrelated.json'),{name:'其他编辑记录',preserve:true});let fail=true;t.projects.save=async p=>{if(fail){fail=false;throw Error('simulated before project save');}return save(p);};await assert.rejects(t.service.importBundle(preview.id),/simulated/);const first=await fs.readdir(path.join(t.data,'image-edits')),snap=await Promise.all(first.map(name=>fs.readFile(path.join(t.data,'image-edits',name))));const p=await t.service.importBundle(preview.id);assert.equal((await fs.readdir(path.join(t.data,'image-edits'))).length,3);for(let i=0;i<first.length;i++)assert.deepEqual(await fs.readFile(path.join(t.data,'image-edits',first[i])),snap[i]);assert.equal((await t.service.importBundle(preview.id)).id,p.id);assert.equal((await fs.readdir(path.join(t.data,'projects'))).length,1);
});

test('editable import refuses to overwrite a conflicting record during retry',async()=>{
 const s=await seed(),{file}=await exportFile(s),t=await fixture(),preview=await t.service.upload(createReadStream(file));t.projects.save=async()=>{throw Error('pause before save');};await assert.rejects(t.service.importBundle(preview.id),/pause before save/);
 const names=await fs.readdir(path.join(t.data,'image-edits')),recordFile=path.join(t.data,'image-edits',names[0]),record=await readJson(recordFile);await atomicJson(recordFile,{...record,externalChange:'preserve this change'});const before=await fs.readFile(recordFile);await assert.rejects(t.service.importBundle(preview.id),/编号被占用/);assert.deepEqual(await fs.readFile(recordFile),before);assert.equal((await counts(t))[0],0);
});
