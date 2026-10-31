import path from 'node:path';
import {promises as fs} from 'node:fs';
import {safeId,userError} from './workspace.mjs';
const formats={'image/png':'png_pipe','image/jpeg':'jpeg_pipe','image/webp':'webp_pipe','image/gif':'gif','image/avif':'mov','video/mp4':'mov','video/quicktime':'mov','video/webm':'matroska','audio/wav':'wav','audio/x-wav':'wav','audio/mpeg':'mp3','audio/flac':'flac','audio/ogg':'ogg','audio/mp4':'mov','audio/aac':'aac','audio/x-m4a':'mov','audio/webm':'matroska','audio/x-flac':'flac','audio/aiff':'aiff','audio/x-aiff':'aiff','audio/opus':'ogg','audio/mp3':'mp3'};
export async function renderSource(data,asset,command,signal){
 if(!asset||!safeId(asset.id))throw userError('镜头未关联有效素材');const root=await fs.realpath(data),directory=path.join(root,'assets'),file=path.join(directory,asset.id);
 try{if(await fs.realpath(directory)!==directory)throw Error();const st=await fs.lstat(file);if(!st.isFile()||st.size<1||st.size>150*1024*1024||await fs.realpath(file)!==file)throw Error();const metaFile=file+'.json',metaStat=await fs.lstat(metaFile);if(!metaStat.isFile()||metaStat.size>1024**2||await fs.realpath(metaFile)!==metaFile)throw Error();const meta=JSON.parse(await fs.readFile(metaFile,'utf8')); if(meta.id!==asset.id||meta.type!==asset.type||meta.size!==st.size)throw Error();}catch{throw userError('素材文件缺失、被替换或不是本地普通文件：'+asset.name);}
 const type=asset.type.split(';')[0],format=formats[type];if(!format)throw userError('当前合成不支持此素材格式：'+type);
 const input=['-protocol_whitelist','file,pipe','-format_whitelist',format==='matroska'?'matroska,webm':format,'-f',format,'-threads','1'];
 let info;try{info=JSON.parse(await command(process.env.FFPROBE_PATH||'ffprobe',['-v','error',...input,'-show_streams','-show_format','-of','json',file],signal));}catch{throw userError('素材无法解码：'+asset.name);}
 const visual=info.streams?.find(s=>s.codec_type==='video'),audio=info.streams?.find(s=>s.codec_type==='audio');let duration=Number(info.format?.duration||(type.startsWith('audio/')?audio?.duration:visual?.duration)||0);
 if(type.startsWith('image/')||type.startsWith('video/')){if(!visual||!Number.isInteger(visual.width)||!Number.isInteger(visual.height)||visual.width*visual.height>16777216)throw userError('画面格式或分辨率无效：'+asset.name);}
 if(type.startsWith('audio/')&&!audio)throw userError('素材中没有音频：'+asset.name);
 if(!type.startsWith('image/')&&(!Number.isFinite(duration)||duration<=0)){
  // Browser-recorded WebM often has no duration header. Scan packet timestamps
  // incrementally rather than guessing from byte size or retaining every packet.
  let rest='',last=0;const [n,d]=String(visual?.avg_frame_rate||'0/1').split('/').map(Number),frame=n>0&&d>0?d/n:0;
  const consume=line=>{const parts=line.trim().split(','),pts=Number(parts[0]),length=Number(parts[1]);if(Number.isFinite(pts))last=Math.max(last,pts+(Number.isFinite(length)&&length>0?length:type.startsWith('video/')?frame:0));};
  await command(process.env.FFPROBE_PATH||'ffprobe',['-v','error',...input,'-select_streams',type.startsWith('audio/')?'a:0':'v:0','-show_packets','-show_entries','packet=pts_time,duration_time','-of','csv=p=0',file],signal,{onStdout:bytes=>{rest+=bytes.toString();const lines=rest.split('\n');rest=lines.pop();for(const line of lines)consume(line);}});if(rest)consume(rest);duration=last;
 }
 if(!type.startsWith('image/')&&(!Number.isFinite(duration)||duration<=0||duration>86400))throw userError('无法确定媒体时长：'+asset.name);
 return{...asset,file,input,type,duration,hasAudio:!!audio,width:visual?.width,height:visual?.height};
}
