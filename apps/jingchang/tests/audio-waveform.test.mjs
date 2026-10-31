import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { audioWaveformService, decodeWaveformPixels } from '../lib/audio-waveform.mjs';
import { storeAsset } from '../lib/workspace.mjs';
import { wav } from './helpers/ltx-fixture.mjs';

test('音频波形从本机素材生成有界峰值并缓存', async t => {
  const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-audio-waveform-'));
  t.after(()=>fs.rm(data,{recursive:true,force:true}));
  const asset=await storeAsset(data,wav(),{name:'waveform.wav',type:'audio/wav'});
  const service=audioWaveformService({data});
  const [first, concurrent]=await Promise.all([service.preview(asset.id),service.preview(asset.id)]);
  assert.equal(first,concurrent);
  assert.equal(first.width,640);
  assert.equal(first.peaks.length,640);
  assert.ok(first.peaks.some(peak=>peak>.1));
  assert.ok(first.peaks.every(peak=>peak>=0&&peak<=1));
  assert.ok(Math.abs(first.duration-4)<.02);
  assert.equal(await service.preview(asset.id),first);
});

test('波形像素解码拒绝截断数据并将非黑色振幅转换成归一化峰值',()=>{
  const width=3,height=4,bytes=Buffer.alloc(width*height*4);
  for(let y=0;y<height;y++){const i=(y*width+1)*4;bytes[i]=80;bytes[i+3]=255;}
  assert.deepEqual(decodeWaveformPixels(bytes,width,height),[0,.75,0]);
  assert.throws(()=>decodeWaveformPixels(Buffer.alloc(1),width,height),/无法读取音频波形/);
});

test('音频波形入口拒绝图片素材与无效编号',async t=>{
  const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-audio-waveform-invalid-'));
  t.after(()=>fs.rm(data,{recursive:true,force:true}));
  const service=audioWaveformService({data});
  await assert.rejects(service.preview('../bad'),/素材编号无效/);
  await assert.rejects(service.preview('missing-asset'),/ENOENT/);
  const image=await storeAsset(data,Buffer.from('fake'),{name:'not-image.png',type:'image/png'});
  await assert.rejects(service.preview(image.id),/只有音频素材/);
});
