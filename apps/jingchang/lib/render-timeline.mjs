import {promises as fs} from 'node:fs';
import path from 'node:path';
import {subtitleImage} from './render-subtitles.mjs';

// The image sequence is generated locally. One FFmpeg input handles all cues,
// including gaps and overlapping lines, instead of opening a process/input per cue.
export async function prepareCaptionTrack(plan,dir,signal){
 if(!plan.edit.burnSubtitles||!plan.captions.length)return null;
 const totalFrames=plan.shots.reduce((n,t)=>n+t.frames,0),events=new Map(),active=new Map(),cache=new Map(),parts=[];
 const event=frame=>{if(!events.has(frame))events.set(frame,{start:[],end:[]});return events.get(frame);};
 event(0);event(totalFrames);
 plan.captions.forEach((cue,i)=>{const start=Math.max(0,Math.ceil(cue.start*plan.fps-1e-7)),end=Math.min(totalFrames,Math.ceil(cue.end*plan.fps-1e-7));if(end<=start)return;event(start).start.push([i,cue.text]);event(end).end.push(i);});
 const frames=[...events.keys()].sort((a,b)=>a-b);
 for(let i=0;i<frames.length-1;i++){
  signal?.throwIfAborted();const frame=frames[i],e=events.get(frame);e.end.forEach(id=>active.delete(id));e.start.forEach(([id,text])=>active.set(id,text));const text=[...active.values()].join('\n');
  if(!cache.has(text)){const file=path.join(dir,`caption-${cache.size}.png`);await subtitleImage(text,plan.width,plan.height,plan.edit.subtitle,file);cache.set(text,file);}
  parts.push({file:cache.get(text),duration:(frames[i+1]-frame)/plan.fps});
 }
 const line=file=>`file '${file.replace(/'/g,"'\\''")}'\noption framerate ${plan.fps}`;
 const file=path.join(dir,'captions.ffconcat');await fs.writeFile(file,'ffconcat version 1.0\n'+parts.map(p=>line(p.file)+`\nduration ${p.duration}`).join('\n')+'\n'+line(parts.at(-1).file)+'\n',{flag:'wx'});
 return file;
}

// Match the footage workbench: a crossfade starts at the shot boundary and
// holds the previous final frame during the overlap. Narration/film length stay fixed.
export async function composeVideoTransitions(plan,clips,dir,ffmpeg,signal){
 const {mode,seconds}=plan.edit.transition;
 const effective=clips.length>1?Math.min(seconds,...plan.shots.map(t=>t.duration/2)):0;
 if(mode==='cut'||effective<=0)return{file:null,effective:0};
 const args=[],filters=[];for(const file of clips)args.push('-protocol_whitelist','file,pipe','-f','matroska','-i',file);
 if(mode==='fade'){
  const labels=plan.shots.map((t,i)=>{let chain=`[${i}:v:0]setpts=PTS-STARTPTS`;if(i)chain+=`,fade=t=in:d=${effective}`;if(i<clips.length-1)chain+=`,fade=t=out:st=${t.duration-effective}:d=${effective}`;filters.push(chain+`[fade${i}]`);return`[fade${i}]`;});
  filters.push(labels.join('')+`concat=n=${clips.length}:v=1:a=0,format=yuv420p[video]`);
 }else{
  clips.forEach((_,i)=>filters.push(`[${i}:v:0]format=yuv444p,setpts=PTS-STARTPTS,fps=${plan.fps},settb=AVTB[v${i}]`));
  let current='v0';for(let i=1;i<clips.length;i++){filters.push(`[${current}]tpad=stop_mode=clone:stop_duration=${effective},fps=${plan.fps},settb=AVTB[p${i}]`);filters.push(`[p${i}][v${i}]xfade=transition=fade:duration=${effective}:offset=${plan.shots[i].start}[x${i}]`);current='x'+i;}
  filters.push(`[${current}]format=yuv420p[video]`);
 }
 const file=path.join(dir,'transitions.mkv');await ffmpeg([...args,'-filter_complex',filters.join(';'),'-map','[video]','-an','-t',String(plan.duration),'-r',String(plan.fps),'-c:v','libx264','-preset','fast','-crf','21','-pix_fmt','yuv420p','-threads','2',file],signal);
 return{file,effective};
}
