import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,createReadStream} from 'node:fs';
import {Readable} from 'node:stream';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {makeProject,validateProject} from '../lib/model.mjs';
import {storeAsset,atomicJson,readJson} from '../lib/workspace.mjs';
import {projectBundleService} from '../lib/project-bundles.mjs';
import {renderPlan,renderProject,publicRenderPlan} from '../lib/render.mjs';
import {parseSubtitleSrt,editingSrt,normalizeEditSettings,editingCaptions} from '../public/editing-core.js';

const ff=args=>execFileSync('ffmpeg',['-v','error','-nostdin','-threads','1',...args],{maxBuffer:32*1024*1024});
const out=process.env.JINGCHANG_EDIT_FIDELITY_EVIDENCE||await fs.mkdtemp(path.join(os.tmpdir(),'jc-fidelity-'));
await fs.mkdir(out,{recursive:true});
const color=name=>ff(['-f','lavfi','-i',`color=${name}:size=240x160:rate=24:duration=3`,'-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=3','-c:v','libx264','-threads','2','-c:a','aac','-pix_fmt','yuv420p','-f','mp4','-movflags','frag_keyframe+empty_moov','pipe:1']);
async function fixture(label){
 const data=path.join(out,label);await fs.mkdir(data,{recursive:true});const p=makeProject('本机实际剪辑验收 · 合成色块'),assets={};
 for(const [key,bytes,type] of [['red',color('red'),'video/mp4'],['blue',color('blue'),'video/mp4'],['voice',ff(['-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=1.5','-f','wav','pipe:1']),'audio/wav'],['music',ff(['-f','lavfi','-i','sine=frequency=220:sample_rate=48000:duration=1','-f','wav','pipe:1']),'audio/wav']])assets[key]=await storeAsset(data,bytes,{name:key,type});
 p.assets=Object.values(assets);const shot=(id,key,duration,edit={},extra={})=>({id,title:id,description:'合成测试素材',duration,assetId:assets[key].id,dialogue:'',edit,...extra});return{data,p,assets,shot};
}
const frame=(file,time)=>ff(['-ss',String(time),'-i',file,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1']);
const pixel=(b,x=640,y=400)=>[...b.subarray((y*1280+x)*3,(y*1280+x)*3+3)];
const whites=b=>{let count=0;for(let y=36;y<160;y++)for(let x=100;x<1180;x++)if(pixel(b,x,y).every(v=>v>210))count++;return count;};
const pcm=file=>{const b=ff(['-i',file,'-vn','-ac','1','-ar','48000','-f','f32le','pipe:1']);return new Float32Array(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));};
function energy(samples,start,end,freq){const a=Math.round(start*48000),b=Math.round(end*48000);let re=0,im=0;for(let i=a;i<b;i++){re+=samples[i]*Math.cos(2*Math.PI*freq*i/48000);im+=samples[i]*Math.sin(2*Math.PI*freq*i/48000);}return 2*Math.hypot(re,im)/(b-a);}

test('逐句字幕保留空隙、重叠与毫秒时间，移动镜头后一起移动，错误时间拒绝保存',()=>{
 const p=makeProject(),cues=parseSubtitleSrt('\uFEFF1\r\n00:00:00,200 --> 00:00:00,750\r\n第一句\r\n\r\n2\r\n00:00:00,500 --> 00:00:01,000\r\n并行的字幕',2);
 p.shots=[{id:'a',description:'',duration:2,dialogue:'不能覆盖细分字幕',edit:{subtitleCues:cues}},{id:'b',description:'',duration:1,dialogue:'整镜字幕'}];validateProject(p);
 assert.equal(editingCaptions(p).length,3);assert.match(editingSrt(p),/00:00:00,200 --> 00:00:00,750/);assert.doesNotMatch(editingSrt(p),/不能覆盖/);
 p.shots.reverse();assert.match(editingSrt(p),/00:00:01,200 --> 00:00:01,750/);
 for(const srt of ['00:00:00,700 --> 00:00:00,200\n倒序','00:00:00,200 --> 00:00:03,000\n越界','00:99:00,000 --> 00:99:01,000\n坏时间'])assert.throws(()=>parseSubtitleSrt(srt,2));
 assert.throws(()=>normalizeEditSettings({edit:{transition:{mode:'unknown'}}}));assert.throws(()=>normalizeEditSettings({edit:{duckMusic:'true'}}));
});

test('真实成片包含两镜叠化及逐句顶部中文字幕，字幕空隙不残留，转场不缩短旁白时间',async()=>{
 const f=await fixture('timed-captions'),{p,shot}=f;
 p.shots=[shot('first','red',2,{sourceAudio:'mute',subtitleCues:[{start:.2,end:.75,text:'真实测试 · 第一段中文字幕'},{start:1.1,end:1.7,text:'第二段，按自己的时间显示'}]}),shot('second','blue',2,{sourceAudio:'mute',subtitleCues:[{start:.1,end:.9,text:'转场之后，字幕保持清晰'}]})];
 p.settings.edit={burnSubtitles:true,subtitle:{position:'top',bottom:36,fontSize:36,outlineColor:'#205040',backgroundOpacity:0},transition:{mode:'crossfade',seconds:.4}};
 const plan=await renderPlan(p,f.data),pub=publicRenderPlan(plan);assert.equal(pub.subtitleCount,3);assert.equal(pub.transition.mode,'crossfade');assert.ok(!JSON.stringify(pub).includes(f.data));
 const r=await renderProject(p,f.data,{id:'crossfade'},async()=>{}),file=path.join(f.data,r.url);
 const visible=whites(frame(file,.4)),gap=whites(frame(file,.9)),after=whites(frame(file,2.2));assert.ok(visible>300);assert.equal(gap,0);assert.ok(after>300);
 const blend=pixel(frame(file,2.2));assert.ok(blend[0]>60&&blend[2]>60&&blend[0]<230&&blend[2]<230,'boundary is blended: '+blend);assert.ok(pixel(frame(file,3.6))[2]>230);
 assert.equal(r.duration,4);assert.equal(r.subtitleCount,3);assert.equal(r.transition.effectiveSeconds,.4);assert.equal(r.subtitlesBurned,true);assert.match(await fs.readFile(path.join(f.data,r.subtitleUrl),'utf8'),/00:00:02,100 --> 00:00:02,900/);
 ff(['-i',file,'-f','null','-']);await fs.writeFile(path.join(out,'captions-metrics.json'),JSON.stringify({file,visiblePixels:visible,gapPixels:gap,afterPixels:after,blend,duration:r.duration,subtitleCount:r.subtitleCount},null,2),{flag:'wx'});
 // A fade is a separate, usable option, with the same four-second timeline.
 p.settings.edit.transition.mode='fade';p.settings.edit.burnSubtitles=false;const faded=await renderProject(p,f.data,{id:'fade'},async()=>{}),fadeFile=path.join(f.data,faded.url);
 const before=pixel(frame(fadeFile,1.92)),next=pixel(frame(fadeFile,2.04));assert.ok(before[0]<100&&next[2]<100);assert.equal(faded.duration,4);
 console.log('Local caption and transition evidence:',file);
});

test('真实音频测量：配乐随独立旁白降低、停顿后恢复，原视频声音不触发压低',async()=>{
 const f=await fixture('voice-ducking'),{p,assets,shot}=f;
 p.shots=[shot('talk','red',6,{sourceStart:0,sourceEnd:3,endMode:'loop',sourceAudio:'keep',sourceVolume:.3,voiceOffset:1,voiceVolume:1},{audioId:assets.voice.id})];
 p.settings.edit={duckMusic:true,music:[{id:'music',assetId:assets.music.id,start:0,duration:6,volume:.5,loop:true}]};
 const r=await renderProject(p,f.data,{id:'ducked'},async()=>{}),file=path.join(f.data,r.url),s=pcm(file);
 const before=energy(s,.3,.7,220),during=energy(s,1.5,2,220),after=energy(s,4,4.5,220),originalBefore=energy(s,.3,.7,440),originalDuring=energy(s,1.5,2,440);
 assert.ok(before>.03);assert.ok(during<before*.4,JSON.stringify({before,during}));assert.ok(after>before*.8);assert.ok(originalDuring>originalBefore*.8);assert.ok(energy(s,1.5,2,880)>.05);assert.ok(energy(s,.3,.7,880)<.002);assert.equal(r.duckMusic,true);
 p.settings.edit.duckMusic=false;const fixed=await renderProject(p,f.data,{id:'fixed'},async()=>{}),fixedFile=path.join(f.data,fixed.url),fsamples=pcm(fixedFile),fixedBefore=energy(fsamples,.3,.7,220),fixedDuring=energy(fsamples,1.5,2,220);assert.ok(fixedDuring>fixedBefore*.8);assert.equal(fixed.duckMusic,false);
 await fs.writeFile(path.join(out,'ducking-metrics.json'),JSON.stringify({file,fixedFile,before,during,after,attenuationDb:20*Math.log10(during/before),originalBefore,originalDuring,fixedBefore,fixedDuring,duration:r.duration},null,2),{flag:'wx'});
 console.log('Local ducking evidence:',file);
});

test('第37版完整备份保留字幕转场避让，可在空白工作区导出，伪装旧版时明确拒绝',async()=>{
 const f=await fixture('backup-migration'),{p,assets,shot}=f;
 p.shots=[shot('one','red',.5,{subtitleCues:[{start:.05,end:.45,text:'备份中的细分字幕'}]},{audioId:assets.voice.id}),shot('two','blue',.5)];
 p.settings.edit={burnSubtitles:true,duckMusic:true,transition:{mode:'crossfade',seconds:.2},subtitle:{position:'top',outlineColor:'#106040'},music:[{id:'music',assetId:assets.music.id,duration:1,volume:.2,loop:true}]};
 const source=projectBundleService({data:f.data,projects:{load:async()=>p},activeJobs:new Map()}),pack=await source.exportBundle(p.id,p.revision),file=await source.download(pack.id),bytes=await fs.readFile(file),magic=Buffer.from('JINGCHANG-PACK-1\n'),size=bytes.readUInt32BE(magic.length),manifest=JSON.parse(bytes.subarray(magic.length+4,magic.length+4+size));
 assert.equal(manifest.version,37);
 const data=path.join(out,'restored-workspace');await fs.mkdir(data,{recursive:true});const projects={load:async id=>readJson(path.join(data,'projects',id,'project.json')),save:async p=>{await atomicJson(path.join(data,'projects',p.id,'project.json'),p);return p;}},target=projectBundleService({data,projects,activeJobs:new Map()});
 const preview=await target.upload(createReadStream(file)),restored=await target.importBundle(preview.id);assert.deepEqual(restored.shots[0].edit.subtitleCues,p.shots[0].edit.subtitleCues);assert.deepEqual(restored.settings.edit.transition,p.settings.edit.transition);assert.equal(restored.settings.edit.duckMusic,true);assert.notEqual(restored.settings.edit.music[0].assetId,assets.music.id);
 const result=await renderProject(restored,data,{id:'restored'},async()=>{});assert.equal(result.duration,1);assert.equal(result.subtitleCount,1);assert.equal(result.duckMusic,true);assert.equal(result.transition.mode,'crossfade');assert.ok((await fs.stat(path.join(data,result.url))).size>1000);
 manifest.version=36;const header=Buffer.from(JSON.stringify(manifest)),length=Buffer.alloc(4);length.writeUInt32BE(header.length);const downgraded=Buffer.concat([magic,length,header,bytes.subarray(magic.length+4+size)]);await assert.rejects(()=>target.upload(Readable.from([downgraded])),/第37版/);
 await fs.writeFile(path.join(out,'backup-migration-receipt.json'),JSON.stringify({passed:true,version:37,oldVersionRefused:true,subtitleCues:restored.shots[0].edit.subtitleCues,render:result,data},null,2),{flag:'wx'});
});
