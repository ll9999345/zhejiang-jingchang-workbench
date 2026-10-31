import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,createReadStream} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {makeProject} from '../lib/model.mjs';
import {atomicJson,readJson} from '../lib/workspace.mjs';
import {projectBundleService} from '../lib/project-bundles.mjs';
import {taskHistoryArchiveService,TASK_HISTORY_MAGIC} from '../lib/task-history-archive.mjs';
import {normalizeEditSettings} from '../public/editing-core.js';

// Real archive services in newly-created temporary workspaces only. No model,
// renderer, network, existing project, actual credential or cleanup is used.
async function fixture(){
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jingchang-history-subtitle-style-')),activeJobs=new Map();
 const projects={load:async id=>readJson(path.join(data,'projects',id,'project.json')),save:async p=>{await atomicJson(path.join(data,'projects',p.id,'project.json'),p);return p;}};
 const bundles=projectBundleService({data,projects,activeJobs});
 return{data,activeJobs,projects,service:taskHistoryArchiveService({data,projects,activeJobs,projectBundles:bundles})};
}
const names=(f,dir)=>fs.readdir(path.join(f.data,dir)).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
async function seed(style={font:'PingFang SC',outlineColor:'#123abc'}){
 const f=await fixture(),project=makeProject('字幕样式归档回归');project.revision=1;
 project.settings.edit=normalizeEditSettings({edit:{subtitle:style}});
 const previous=structuredClone(project);previous.revision=0;previous.settings.edit.subtitle.font='Source Han Sans SC';previous.settings.edit.subtitle.outlineColor='#203040';
 await f.projects.save(project);
 const files=[path.join(f.data,'projects',project.id,'project.json')];
 for(const [revision,snapshot]of [[0,previous],[1,project]]){const file=path.join(f.data,'projects',project.id,'history',revision+'-style.json');await atomicJson(file,snapshot);files.push(file);}
 const before=await Promise.all(files.map(file=>fs.readFile(file)));
 return{...f,project,previous,files,before};
}
async function preserved(source){for(const [index,file]of source.files.entries())assert.deepEqual(await fs.readFile(file),source.before[index],'source project/history bytes must remain unchanged');}
async function exported(source){const preview=await source.service.exportArchive(source.project.id,source.project.revision);assert.equal(preview.complete,true,JSON.stringify(preview.unsupported));assert.deepEqual(preview.unsupported,[]);return{preview,file:await source.service.download(preview.id)};}
async function rewrite(file,mutate){
 const bytes=await fs.readFile(file),offset=TASK_HISTORY_MAGIC.length+4,length=bytes.readUInt32BE(TASK_HISTORY_MAGIC.length),manifest=JSON.parse(bytes.subarray(offset,offset+length));mutate(manifest);
 const json=Buffer.from(JSON.stringify(manifest)),size=Buffer.alloc(4);size.writeUInt32BE(json.length);
 return Buffer.concat([TASK_HISTORY_MAGIC,size,json,createHash('sha256').update(json).digest(),bytes.subarray(offset+length+32)]);
}
async function noExecution(target){assert.equal(target.activeJobs.size,0);assert.deepEqual(await names(target,'jobs'),[]);}

for(const [label,style]of [
 ['系统默认字体与默认描边',{font:'',outlineColor:'#000000'}],
 ['英文字体与自定义描边',{font:'PingFang SC',outlineColor:'#123abc'}],
 ['中文字体与自定义描边',{font:'苹方',outlineColor:'#A0B1C2'}]
])test(label+'经实际导出、检查、导入、读取保留当前与旧修订',async()=>{
 const source=await seed(style),out=await exported(source),target=await fixture();
 const preview=await target.service.upload(createReadStream(out.file,{highWaterMark:17}));assert.equal(preview.complete,true);assert.equal(preview.revisions,2);
 assert.equal((await target.service.readPreview(preview.id)).previewDigest,preview.previewDigest);
 assert.deepEqual(await names(target,'projects'),[]);await noExecution(target);
 const record=await target.service.importArchive(preview.id,{previewDigest:preview.previewDigest}),read=await target.service.readArchive(record.id,{projectId:record.projectId});
 const current=await target.projects.load(record.projectId);assert.notEqual(current.id,source.project.id);assert.deepEqual(current.settings,source.project.settings);
 assert.deepEqual(read.manifest.currentBundle.project.settings,source.project.settings);assert.deepEqual(read.manifest.currentSnapshot.settings,source.project.settings);
 assert.deepEqual(read.manifest.revisions.find(r=>r.snapshot.revision===0).snapshot.settings,source.previous.settings);
 assert.deepEqual(read.manifest.revisions.find(r=>r.snapshot.revision===1).snapshot.settings,source.project.settings);
 assert.equal(read.readOnly,true);assert.equal(read.canResume,false);assert.equal(read.canApply,false);await noExecution(target);
 const again=await target.service.importArchive(preview.id,{previewDigest:preview.previewDigest});assert.equal(again.projectId,record.projectId);assert.equal((await names(target,'projects')).length,1);
 await preserved(source);
});

for(const [label,mutate]of [
 ['工程包字体改变',m=>{m.currentBundle.project.settings.edit.subtitle.font='Noto Sans SC';}],
 ['工程包描边改变',m=>{m.currentBundle.project.settings.edit.subtitle.outlineColor='#aabbcc';}],
 ['工程包字体缺失',m=>{delete m.currentBundle.project.settings.edit.subtitle.font;}],
 ['工程包描边缺失',m=>{delete m.currentBundle.project.settings.edit.subtitle.outlineColor;}],
 ['快照字体缺失',m=>{delete m.currentSnapshot.settings.edit.subtitle.font;}],
 ['快照描边改变',m=>{m.currentSnapshot.settings.edit.subtitle.outlineColor='#abcdef';}]
])test(label+'即使重算档案摘要也因设置不一致拒绝',async()=>{
 const source=await seed(),out=await exported(source),target=await fixture(),bad=await rewrite(out.file,mutate);
 await assert.rejects(target.service.upload(Readable.from([bad])),/不对应.*settings/);
 assert.deepEqual(await names(target,'projects'),[]);await noExecution(target);await preserved(source);
 // The rejection is about the mismatched style, not a globally broken reader.
 assert.equal((await target.service.upload(createReadStream(out.file))).complete,true);
});

test('已导入只读收据两侧同时改字体仍被原清单摘要拒绝且不改变当前工程',async()=>{
 const source=await seed(),out=await exported(source),target=await fixture(),preview=await target.service.upload(createReadStream(out.file));
 const record=await target.service.importArchive(preview.id),file=path.join(target.data,'task-history-archives','records',record.id,'record.json'),tampered=await readJson(file);
 for(const p of [tampered.manifest.currentBundle.project,tampered.manifest.currentSnapshot])p.settings.edit.subtitle.font='Noto Sans SC';
 await atomicJson(file,tampered);
 await assert.rejects(target.service.readArchive(record.id),/清单SHA256校验失败/);
 assert.deepEqual((await target.projects.load(record.projectId)).settings,source.project.settings);await noExecution(target);await preserved(source);
});

for(const field of ['font','outlineColor'])test('新增允许字段 '+field+' 中的假凭据仍在公开档案入口拒绝',async()=>{
 const source=await seed(),out=await exported(source),target=await fixture();
 const bad=await rewrite(out.file,m=>{m.currentBundle.project.settings.edit.subtitle[field]='https://example.invalid/file?key=NOT-A-REAL-KEY';});
 await assert.rejects(target.service.upload(Readable.from([bad])),/秘密|密钥|认证|凭据|签名/);
 assert.deepEqual(await names(target,'projects'),[]);await noExecution(target);await preserved(source);
});
