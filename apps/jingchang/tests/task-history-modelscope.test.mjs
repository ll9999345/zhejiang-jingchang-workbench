import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {atomicJson,readJson,records,userError} from '../lib/workspace.mjs';
import {projectBundleService} from '../lib/project-bundles.mjs';
import {taskHistoryArchiveService} from '../lib/task-history-archive.mjs';
import {normalizeStudioBinding} from '../lib/canvas-studio.mjs';
import {captureNativeModelscopeHistoryFixture} from './helpers/native-modelscope-history-fixture.mjs';
async function fixture(){
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-history-modelscope-')),activeJobs=new Map(),projects={load:async id=>{try{return await readJson(path.join(data,'projects',id,'project.json'));}catch(e){if(e.code==='ENOENT')throw userError('项目不存在',404);throw e;}},save:async p=>{await atomicJson(path.join(data,'projects',p.id,'project.json'),p);return p;}};
 const projectBundles=projectBundleService({data,projects,activeJobs});return {data,projects,activeJobs,service:taskHistoryArchiveService({data,projects,activeJobs,projectBundles})};
}
test('真实本机ModelScope多份串联留痕可完整迁移，原尺寸/参考/逐份原编号及源设置深相等',async t=>{
 const captured=await captureNativeModelscopeHistoryFixture(t,{count:3}),source=await fixture();await source.projects.save(captured.project);
 for(const a of captured.assets){await fs.mkdir(path.join(source.data,'assets'),{recursive:true});await fs.writeFile(path.join(source.data,'assets',a.meta.id),Buffer.from(a.base64,'base64'));await atomicJson(path.join(source.data,'assets',a.meta.id+'.json'),a.meta);}
 for(const j of captured.jobs)await atomicJson(path.join(source.data,'jobs',j.id+'.json'),j);
 const out=await source.service.exportArchive(captured.project.id,captured.project.revision);assert.equal(out.complete,true,JSON.stringify(out.unsupported));
 const target=await fixture(),preview=await target.service.upload(createReadStream(await source.service.download(out.id))),archive=await target.service.importArchive(preview.id,{previewDigest:preview.previewDigest});
 for(const job of captured.jobs)assert.deepEqual(archive.manifest.jobs.find(j=>j.id===job.id),job);
 assert.deepEqual(archive.manifest.currentSnapshot,captured.project);
 assert.deepEqual(await records(path.join(target.data,'jobs')),[]);assert.equal(target.activeJobs.size,0);assert.equal(archive.canResume,false);assert.equal(archive.canApply,false);
 for(const asset of captured.assets){const restored=await target.service.archiveFile(archive.id,'asset-'+asset.meta.id,{projectId:archive.projectId});assert.deepEqual(await fs.readFile(restored.file),Buffer.from(asset.base64,'base64'));}
 const p=await target.projects.load(archive.projectId),original=captured.project.nodes.find(n=>n.params?.studioBinding?.config?.nativeModelscope),restored=p.nodes.find(n=>n.id===original.id);
 assert.deepEqual(restored.params.studioBinding.config,normalizeStudioBinding(original.params.studioBinding).config);for(const [key,value]of Object.entries(original.params.studioBinding.config))assert.deepEqual(restored.params.studioBinding.config[key],value);assert.deepEqual(restored.params.nativeCanvas.node,original.params.nativeCanvas.node);assert.deepEqual(restored.params.nativeCanvas.runSettings,original.params.nativeCanvas.runSettings);
 const again=await target.service.importArchive(preview.id);assert.equal(again.projectId,archive.projectId);assert.equal((await fs.readdir(path.join(target.data,'projects'))).length,1);
});
