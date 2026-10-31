import {promises as fs} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {validateProject} from './model.mjs';
import {normalizeEditSettings,shotTimings,editingSrt,editingCaptions} from '../public/editing-core.js';
import {renderSource} from './render-inputs.mjs';
import {subtitleFont} from './render-subtitles.mjs';
import {prepareCaptionTrack,composeVideoTransitions} from './render-timeline.mjs';
import {userError,safeId} from './workspace.mjs';
export function command(executable,args,signal,{onStdout}={}){return new Promise((resolve,reject)=>{let out='';const child=spawn(executable,args,{stdio:['ignore','pipe','pipe'],signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(600000)])});child.stdout.on('data',b=>{if(onStdout)onStdout(b);else if(out.length<500000)out+=b;});child.stderr.resume();child.on('error',e=>reject(userError(e.code==='ENOENT'?'本机未找到 FFmpeg 或 FFprobe':'媒体处理已停止或超时')));child.on('close',code=>code===0?resolve(out):reject(userError('媒体处理失败，请检查素材格式或本机 FFmpeg 是否可用')));});}
const dimensions={'16:9':[1280,720],'9:16':[720,1280],'1:1':[720,720],'4:3':[960,720]};
const prefix=['-hide_banner','-loglevel','error','-nostdin','-n','-filter_complex_threads','1','-filter_threads','1'];
const encoding=['-c:v','libx264','-preset','fast','-crf','21','-pix_fmt','yuv420p','-threads','2'];
const ffmpeg=(args,signal)=>command(process.env.FFMPEG_PATH||'ffmpeg',[...prefix,...args],signal);
export async function renderPlan(project,data,signal){
 try{validateProject(project);}catch(e){throw userError(e.message);}if(!project.shots.length||project.shots.length>100)throw userError('一次合成需要1–100个镜头');const edit=normalizeEditSettings(project.settings),[width,height]=dimensions[project.settings.ratio],fps=project.settings.fps,cache=new Map();
 const source=async(id,category)=>{const asset=project.assets.find(a=>a.id===id);if(!asset||!category.includes(asset.type.split('/')[0]))throw userError('镜头或音轨没有关联正确类型的项目素材');if(!cache.has(id))cache.set(id,await renderSource(data,asset,command,signal));return cache.get(id);};
 const shots=[];for(const timing of shotTimings(project)){signal?.throwIfAborted();const visual=await source(timing.shot.assetId,['image','video']),voice=timing.shot.audioId?await source(timing.shot.audioId,['audio']):null,e=timing.edit;let sourceEnd=null;
  if(visual.type.startsWith('video/')){sourceEnd=e.sourceEnd??visual.duration;if(e.sourceStart>=visual.duration||sourceEnd>visual.duration+.02||sourceEnd<=e.sourceStart)throw userError(timing.shot.title+'：画面入点或出点超出素材时长');if(e.endMode==='strict'&&timing.duration>sourceEnd-e.sourceStart+1/fps)throw userError(timing.shot.title+'：所选视频片段短于镜头时长');}
  else if(e.sourceStart||e.sourceEnd!==null)throw userError(timing.shot.title+'：静态图片不使用视频入点/出点');
  if(voice&&e.voiceStart>=voice.duration)throw userError(timing.shot.title+'：配音入点超出音频时长');if(e.fadeIn+e.fadeOut>timing.duration+.0001)throw userError(timing.shot.title+'：声音淡入淡出合计超过镜头时长');
  shots.push({...timing,visual,voice,sourceEnd});
 }
 const duration=shots.at(-1).end,music=[];for(const t of edit.music){const audio=await source(t.assetId,['audio']);if(t.sourceStart>=audio.duration)throw userError('背景音频入点超出素材时长');if(t.start>=duration||t.start+t.duration>duration+1/fps)throw userError('背景音频片段超出成片范围');if(t.fadeIn+t.fadeOut>t.duration)throw userError('背景音淡入淡出合计超过片段时长');music.push({...t,audio});}
 const captions=editingCaptions(project);if(edit.burnSubtitles&&captions.length)await subtitleFont(captions.map(c=>c.text).join('\n'),edit.subtitle.font);
 const duckMusic=edit.duckMusic&&music.some(t=>t.volume>0)&&shots.some(t=>t.voice&&t.edit.voiceVolume>0&&t.edit.voiceOffset<t.duration);
 return{revision:project.revision,width,height,fps,duration,shots,edit,music,captions,duckMusic};
}
export function publicRenderPlan(plan){return{revision:plan.revision,width:plan.width,height:plan.height,fps:plan.fps,duration:plan.duration,burnSubtitles:plan.edit.burnSubtitles,subtitleCount:plan.captions.length,duckMusic:plan.duckMusic,transition:plan.edit.transition,music:plan.music.map(({audio,...t})=>({...t,name:audio.name})),shots:plan.shots.map(t=>({id:t.shot.id,title:t.shot.title,duration:t.duration,start:t.start,frames:t.frames,edit:t.edit,sourceDuration:t.visual.duration,sourceEnd:t.sourceEnd,hasOriginalAudio:t.visual.hasAudio,voice:t.voice?.name||null,subtitle:t.shot.dialogue||''}))};}
export async function renderProject(p,data,job,onProgress,signal,prepared){
 if(!safeId(job.id))throw userError('导出任务编号无效');const plan=prepared||await renderPlan(p,data,signal),{width:w,height:h,fps,duration}=plan,renders=path.join(await fs.realpath(data),'renders');await fs.mkdir(renders,{recursive:true});if(await fs.realpath(renders)!==renders)throw userError('导出目录不能是符号链接');const base=path.join(renders,job.id);await fs.mkdir(base,{recursive:true});if(await fs.realpath(base)!==base)throw userError('导出目录不能是符号链接');
 const dir=path.join(base,'attempt-'+randomUUID());await fs.mkdir(dir);const clips=[];
 // Pre-render the timed caption sequence before encoding any clips. Overlay it
 // after transitions, so a subtitle doesn't fade or move with its source shot.
 const captionTrack=await prepareCaptionTrack(plan,dir,signal);
 for(const [i,t] of plan.shots.entries()){
  signal?.throwIfAborted();const s=t.shot,e=t.edit,visual=t.visual,isImage=visual.type.startsWith('image/'),range=isImage?t.duration:t.sourceEnd-e.sourceStart,loop=!isImage&&e.endMode==='loop'&&t.duration>range+1/fps;
  let sourceFile=visual.file,sourceInput=visual.input,sourceStart=e.sourceStart;
  if(loop){sourceFile=path.join(dir,`range-${i}.mkv`);await ffmpeg([...visual.input,'-ss',String(e.sourceStart),'-i',visual.file,'-t',String(range),'-map','0:v:0','-map','0:a:0?',...encoding,'-r',String(fps),'-c:a','pcm_s16le',sourceFile],signal);sourceInput=['-protocol_whitelist','file,pipe','-f','matroska','-threads','1'];sourceStart=0;}
  const args=[...sourceInput,...(isImage||loop?['-stream_loop','-1']:[]),...(!isImage?['-ss',String(sourceStart)]:[]),'-i',sourceFile],filters=[];let inputCount=1,voiceIndex;
  if(t.voice){voiceIndex=inputCount++;args.push(...t.voice.input,'-ss',String(e.voiceStart),'-i',t.voice.file);}
  const sizing=e.fit==='cover'?`scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`:`scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`;
  filters.push(`[0:v:0]trim=duration=${isImage||loop?t.duration:range},setpts=PTS-STARTPTS,${sizing},setsar=1,fps=${fps},tpad=stop_mode=clone:stop_duration=${t.duration},trim=duration=${t.duration},format=yuv420p[vbase]`);
  const sounds=['silence'];filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${t.duration}[silence]`);
  if(visual.hasAudio&&(e.sourceAudio==='keep'||e.sourceAudio==='auto'&&!t.voice)){filters.push(`[0:a:0]atrim=duration=${loop?t.duration:range},asetpts=PTS-STARTPTS,volume=${e.sourceVolume},apad,atrim=duration=${t.duration}[original]`);sounds.push('original');}
  if(voiceIndex!==undefined&&e.voiceOffset<t.duration){filters.push(`[${voiceIndex}:a:0]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=${t.duration-e.voiceOffset},volume=${e.voiceVolume},adelay=${Math.round(e.voiceOffset*1000)}:all=1,apad,atrim=duration=${t.duration}[voice]`);if(plan.duckMusic){filters.push('[voice]asplit=2[voiceMix][voiceDetector]');sounds.push('voiceMix');filters.push(`[voiceDetector]anull${e.fadeIn?`,afade=t=in:d=${e.fadeIn}`:''}${e.fadeOut?`,afade=t=out:st=${t.duration-e.fadeOut}:d=${e.fadeOut}`:''}[duckvoice]`);}else sounds.push('voice');}
  else if(plan.duckMusic)filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${t.duration}[duckvoice]`);
  filters.push(sounds.map(n=>'['+n+']').join('')+`amix=inputs=${sounds.length}:duration=first:dropout_transition=0:normalize=0${e.fadeIn?`,afade=t=in:d=${e.fadeIn}`:''}${e.fadeOut?`,afade=t=out:st=${t.duration-e.fadeOut}:d=${e.fadeOut}`:''},alimiter=limit=0.95:level=0:latency=1[aout]`);
  const clip=path.join(dir,'clip-'+i+'.mkv');args.push('-filter_complex',filters.join(';'),'-map','[vbase]','-map','[aout]',...(plan.duckMusic?['-map','[duckvoice]']:[]),'-t',String(t.duration),'-frames:v',String(t.frames),...encoding,'-c:a','pcm_s16le','-ar','48000','-ac','2',clip);await ffmpeg(args,signal);clips.push(clip);await onProgress(Math.round((i+1)/(plan.shots.length+2)*100),`已合成镜头 ${i+1}/${plan.shots.length}`);
 }
 const list=path.join(dir,'concat.txt');await fs.writeFile(list,clips.map(file=>`file '${file.replace(/'/g,"'\\''")}'`).join('\n'),{flag:'wx'});const joined=path.join(dir,'joined.mkv');await ffmpeg(['-protocol_whitelist','file,pipe','-f','concat','-safe','0','-i',list,'-map','0','-c','copy',joined],signal);
 const transition=await composeVideoTransitions(plan,clips,dir,ffmpeg,signal);
 const args=['-protocol_whitelist','file,pipe','-f','matroska','-i',joined],mix=['[0:a:0]apad,atrim=duration='+duration+'[main]'],tracks=['main'],musicTracks=[];let inputCount=1,videoIndex=0;
 if(transition.file){videoIndex=inputCount++;args.push('-protocol_whitelist','file,pipe','-f','matroska','-i',transition.file);}
 for(const [i,t] of plan.music.entries()){
  signal?.throwIfAborted();let file=t.audio.file,input=t.audio.input,start=t.sourceStart;
  if(t.loop&&t.duration>t.audio.duration-t.sourceStart){file=path.join(dir,'music-'+i+'.wav');await ffmpeg([...t.audio.input,'-ss',String(t.sourceStart),'-i',t.audio.file,'-map','0:a:0','-c:a','pcm_s16le','-ar','48000','-ac','2',file],signal);input=['-protocol_whitelist','file,pipe','-f','wav'];start=0;}
  const index=inputCount++;args.push(...input,...(t.loop?['-stream_loop','-1']:[]),'-ss',String(start),'-i',file);const n='music'+i;mix.push(`[${index}:a:0]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=${t.duration},apad,atrim=duration=${t.duration},volume=${t.volume}${t.fadeIn?`,afade=t=in:d=${t.fadeIn}`:''}${t.fadeOut?`,afade=t=out:st=${t.duration-t.fadeOut}:d=${t.fadeOut}`:''},adelay=${Math.round(t.start*1000)}:all=1,apad,atrim=duration=${duration}[${n}]`);musicTracks.push(n);
 }
 if(plan.duckMusic){mix.push(musicTracks.map(n=>'['+n+']').join('')+`amix=inputs=${musicTracks.length}:duration=longest:dropout_transition=0:normalize=0[bgm]`);mix.push('[0:a:1]aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration='+duration+'[detector]');mix.push('[bgm][detector]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=350:makeup=1[ducked]');tracks.push('ducked');}else tracks.push(...musicTracks);
 mix.push(tracks.map(n=>'['+n+']').join('')+`amix=inputs=${tracks.length}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=0:latency=1[finalaudio]`);
 let videoMap=videoIndex+':v:0';if(captionTrack){const index=inputCount++;args.push('-protocol_whitelist','file,pipe','-f','concat','-safe','0','-i',captionTrack);mix.push(`[${index}:v:0]fps=${fps},format=rgba[captiontrack]`);mix.push(`[${videoMap}][captiontrack]overlay=shortest=1:eof_action=repeat,format=yuv420p[finalvideo]`);videoMap='[finalvideo]';}
 const final=path.join(dir,'final.mp4');await onProgress(92,'正在处理字幕、配乐与成片');await ffmpeg([...args,'-filter_complex',mix.join(';'),'-map',videoMap,'-map','[finalaudio]','-t',String(duration),...(captionTrack?encoding:['-c:v','copy']),'-c:a','aac','-b:a','192k','-ar','48000','-ac','2','-movflags','+faststart',final],signal);
 const info=JSON.parse(await command(process.env.FFPROBE_PATH||'ffprobe',['-v','error','-show_streams','-show_format','-of','json',final],signal)),actual=Number(info.format.duration);if(!info.streams.some(s=>s.codec_type==='video')||!info.streams.some(s=>s.codec_type==='audio')||!Number.isFinite(actual)||Math.abs(actual-duration)>.12)throw userError('成片时长或音视频轨道校验失败，保留中间文件以便检查');
 signal?.throwIfAborted();const srt=editingSrt(p);if(srt)await fs.writeFile(path.join(dir,'subtitles.srt'),srt,{flag:'wx'});
 return{url:`/renders/${job.id}/${path.basename(dir)}/final.mp4`,subtitleUrl:srt?`/renders/${job.id}/${path.basename(dir)}/subtitles.srt`:null,duration,width:w,height:h,fps,subtitlesBurned:!!captionTrack,subtitleCount:plan.captions.length,duckMusic:plan.duckMusic,transition:{...plan.edit.transition,effectiveSeconds:transition.effective},musicTracks:plan.music.length,attempt:path.basename(dir),projectRevision:p.revision};
}
