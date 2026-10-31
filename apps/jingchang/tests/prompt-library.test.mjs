import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {promptLibraryService} from '../lib/prompt-library.mjs';
import {promptVariables,renderPromptVariables} from '../public/prompt-variables.js';

async function fixture(){const data=await fs.mkdtemp(path.join(os.tmpdir(),'jingchang-prompt-library-'));return{data,service:promptLibraryService({data})};}

test('提示词编辑会追加不可变版本，并拒绝过期 revision',async()=>{
 const {service}=await fixture(),created=await service.create({title:'角色',category:'角色',text:'{{hero}}在雨中'});
 assert.equal(created.revision,1);assert.equal(created.versions.length,1);
 const updated=await service.update(created.id,{revision:1,title:'主角',category:'设定',text:'{{hero}}走进旧城'});
 assert.equal(updated.revision,2);assert.equal(updated.versions.length,2);
 assert.equal(updated.versions[0].text,'{{hero}}在雨中');assert.equal(updated.versions[1].text,'{{hero}}走进旧城');
 const listed=(await service.list())[0],detail=await service.get(created.id);assert.equal(listed.versionsCount,2);assert.equal('versions' in listed,false);assert.equal('versions' in detail,false);
 await assert.rejects(service.update(created.id,{revision:1,title:'旧页面',text:'不可覆盖',category:''}),{status:409});
 assert.equal((await service.get(created.id)).text,'{{hero}}走进旧城');
});

test('恢复历史版本会创建新版本，且校验当前 revision',async()=>{
 const {service}=await fixture(),one=await service.create({title:'一',text:'最初',category:''}),two=await service.update(one.id,{revision:1,title:'二',text:'后来',category:''});
 const restored=await service.restore(one.id,{revision:1,currentRevision:two.revision});
 assert.equal(restored.revision,3);assert.equal(restored.title,'一');assert.equal(restored.text,'最初');
 assert.equal(restored.versions.length,3);assert.equal(restored.versions[2].restoredFrom,1);
 await assert.rejects(service.restore(one.id,{revision:2,currentRevision:2}),{status:409});
 await assert.rejects(service.restore(one.id,{revision:99,currentRevision:3}),{status:404});
});

test('旧格式提示词可读取为版本一，编辑时保留其原始快照',async()=>{
 const {data,service}=await fixture(),dir=path.join(data,'prompts'),id='legacy-prompt';await fs.mkdir(dir,{recursive:true});
 await fs.writeFile(path.join(dir,id+'.json'),JSON.stringify({id,title:'旧模板',text:'保留内容',category:'镜头',createdAt:'2026-01-01T00:00:00.000Z'}));
 const legacy=await service.get(id);assert.equal(legacy.revision,1);assert.equal((await service.versions(id))[0].text,'保留内容');
 const updated=await service.update(id,{revision:1,title:'新版',text:'新内容',category:'镜头'});
 assert.equal(updated.versions.length,2);assert.equal(updated.versions[0].text,'保留内容');
});

test('变量解析去重、逐项替换，并验证错误占位符与填写长度',()=>{
 assert.deepEqual(promptVariables('{{hero}}，{{scene}}，再次出现{{hero}}'),['hero','scene']);
 assert.equal(renderPromptVariables('{{hero}}进入{{scene}}，{{hero}}回头',{hero:'林岚',scene:'旧城'}),'林岚进入旧城，林岚回头');
 assert.throws(()=>promptVariables('{{主角}}'),/英文字母/u);
 assert.throws(()=>promptVariables('{{hero'),/括号不完整/u);
 assert.throws(()=>renderPromptVariables('{{hero}}',{}),/请填写变量/u);
 assert.throws(()=>renderPromptVariables('{{hero}}',{hero:'a'.repeat(2001)}),/不超过 2000 字/u);
});
