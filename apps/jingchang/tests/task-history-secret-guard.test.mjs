import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,createReadStream} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {guardArchiveSecrets,receiptTree} from '../lib/task-history-schema.mjs';
import {taskHistoryArchiveService,TASK_HISTORY_MAGIC} from '../lib/task-history-archive.mjs';
import {projectBundleService} from '../lib/project-bundles.mjs';
import {makeProject} from '../lib/model.mjs';
import {atomicJson,readJson} from '../lib/workspace.mjs';

// All values are explicit fake markers. No provider, network or real key is
// involved; integration cases use new temporary workspaces and real archives.
const unsafe=[
 'https://example.invalid/image?key=NOT-A-REAL-KEY',
 '/api/file?token=NOT-A-REAL-TOKEN',
 '任务备注：查看 https://example.invalid/image?access_token=NOT-A-REAL-TOKEN',
 '备注：https://user:NOT-A-REAL-PASSWORD@example.invalid/file',
 '/file?page=2&api_key=NOT-A-REAL-KEY',
 '/file?page=2&amp;token=NOT-A-REAL-TOKEN',
 '/file?page=2&#38;key=NOT-A-REAL-KEY',
 '/file?t%6fken=NOT-A-REAL-TOKEN',
 '/file?%2574oken=NOT-A-REAL-TOKEN',
 '/file?X-Amz-Signature=NOT-A-REAL-SIGNATURE',
 '文字 /file?sig=NOT-A-REAL-SIGNATURE 结束',
 '/file?AUTH=NOT-A-REAL-TOKEN',
 '//synthetic-user:NOT-A-REAL-PASSWORD@example.invalid/media',
 '任务备注：//synthetic-user:NOT-A-REAL-PASSWORD@example.invalid/media',
 '/file#access_token=NOT-A-REAL-TOKEN'
];
for(const [index,value]of unsafe.entries())test('archive rejects credential-bearing embedded or relative link '+index,()=>{
 const record={outputText:value};assert.throws(()=>guardArchiveSecrets(record),/凭据|签名/);assert.throws(()=>receiptTree(record),/凭据|签名/);
 // An unknown field cannot hide a secret by being dropped from the receipt.
 assert.throws(()=>receiptTree({futureField:{content:value}}),/凭据|签名/);
});
test('ordinary URLs, prompts, workflow parameters and local provenance remain unchanged',()=>{
 for(const value of ['https://example.invalid/a?page=2&size=1024','参考 /api/file?id=asset-one','token是语言单位，保持这段原提示词','/Users/example/models/model.safetensors','file:///Users/example/source.png']){
  const record={outputText:value};assert.doesNotThrow(()=>guardArchiveSecrets(record));assert.deepEqual(receiptTree(record),record);
 }
 const graph={workflow:{'1':{class_type:'LoadImage',inputs:{image:'input/photo.png'}}}};assert.deepEqual(receiptTree(graph),graph);
});
async function fixture(){
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jingchang-history-secret-guard-')),activeJobs=new Map();
 const projects={load:async id=>readJson(path.join(data,'projects',id,'project.json')),save:async p=>{await atomicJson(path.join(data,'projects',p.id,'project.json'),p);return p;}};
 const bundles=projectBundleService({data,projects,activeJobs});return{data,activeJobs,projects,service:taskHistoryArchiveService({data,projects,activeJobs,projectBundles:bundles})};
}
const names=(f,dir)=>fs.readdir(path.join(f.data,dir)).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
async function seed(){const f=await fixture(),project=makeProject('isolated archive guard');await f.projects.save(project);const job={id:'guard-job',projectId:project.id,kind:'image-api',status:'completed',name:'isolated receipt',assets:[],outputText:'ordinary receipt'};await atomicJson(path.join(f.data,'jobs',job.id+'.json'),job);return{...f,project,job};}
test('public export rejects a hidden URL token before publishing an archive and preserves original files',async()=>{
 const f=await seed();f.job.outputText=unsafe[2];await atomicJson(path.join(f.data,'jobs',f.job.id+'.json'),f.job);
 const beforeProject=await fs.readFile(path.join(f.data,'projects',f.project.id,'project.json')),beforeJob=await fs.readFile(path.join(f.data,'jobs',f.job.id+'.json'));
 await assert.rejects(f.service.exportArchive(f.project.id,f.project.revision),/凭据|签名/);assert.deepEqual(await names(f,'task-history-archives/exports'),[]);assert.equal(f.activeJobs.size,0);
 assert.deepEqual(await fs.readFile(path.join(f.data,'projects',f.project.id,'project.json')),beforeProject);assert.deepEqual(await fs.readFile(path.join(f.data,'jobs',f.job.id+'.json')),beforeJob);
});
test('public upload rejects recomputed manifest containing a relative token without creating a project or task',async()=>{
 const source=await seed(),out=await source.service.exportArchive(source.project.id,source.project.revision),file=await source.service.download(out.id),bytes=await fs.readFile(file);
 const offset=TASK_HISTORY_MAGIC.length+4,length=bytes.readUInt32BE(TASK_HISTORY_MAGIC.length),manifest=JSON.parse(bytes.subarray(offset,offset+length));manifest.jobs[0].outputText=unsafe[1];
 const json=Buffer.from(JSON.stringify(manifest)),size=Buffer.alloc(4);size.writeUInt32BE(json.length);const invalid=Buffer.concat([TASK_HISTORY_MAGIC,size,json,createHash('sha256').update(json).digest(),bytes.subarray(offset+length+32)]);
 const target=await fixture();await assert.rejects(target.service.upload(Readable.from([invalid])),/凭据|签名/);assert.deepEqual(await names(target,'projects'),[]);assert.deepEqual(await names(target,'jobs'),[]);assert.deepEqual(await names(target,'task-history-archives/imports'),[]);assert.equal(target.activeJobs.size,0);
 const goodTarget=await fixture(),preview=await goodTarget.service.upload(createReadStream(file));assert.equal(preview.complete,true);assert.deepEqual(await names(goodTarget,'projects'),[]);assert.deepEqual(await names(goodTarget,'jobs'),[]);
});
