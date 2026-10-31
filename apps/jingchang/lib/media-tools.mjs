import {panoramaOptions,panoramaSource} from './panorama-core.mjs';
import {VIDEO_SAMPLING_METHOD} from '../public/video-sampling.js';
import {Worker} from 'node:worker_threads';
import {normalizeEdits} from './image-edit-core.mjs';
import {splitGridLayout,composeGridLayout} from './grid-layout.mjs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { atomicJson, safeId, storeAsset, userError } from './workspace.mjs';

const runFile = promisify(execFile);
const MAX_PIXELS = 16_777_216;
const MAX_BYTES = 150 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 80 * 1024 * 1024;
const FORMATS = {
  'image/png': 'png_pipe', 'image/jpeg': 'jpeg_pipe', 'image/webp': 'webp_pipe',
  'image/gif': 'gif', 'image/avif': 'mov', 'image/bmp': 'bmp_pipe',
  'video/mp4': 'mov', 'video/quicktime': 'mov', 'video/webm': 'matroska,webm',
};
let active = 0;

async function command(name, args) {
  try {
    const { stdout } = await runFile(name, args, {
      timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024,
      encoding: 'utf8', windowsHide: true,
    });
    return stdout;
  } catch (error) {
    if (error.code === 'ENOENT') throw userError('本机未找到 FFmpeg 或 FFprobe，请先安装媒体处理工具', 503);
    if (error.killed || error.signal === 'SIGKILL') throw userError('媒体处理超时，请缩小素材或减少处理范围', 422);
    throw userError('媒体处理失败，请检查素材是否完整、格式是否正确', 422);
  }
}

async function limited(work) {
  if (active >= 2) throw userError('当前已有两项媒体处理，请稍后重试', 429);
  active++;
  try { return await work(); } finally { active--; }
}

async function packetDuration(file,input,rate) {
  // WebM recordings may omit duration metadata. Bound time, stdout bytes and
  // line length while scanning packet timestamps without decoding frames.
  return new Promise((resolve,reject)=>{
    const child=spawn('ffprobe',['-v','error',...input,'-select_streams','v:0','-show_packets','-show_entries','packet=pts_time,duration_time','-of','csv=p=0',file],{stdio:['ignore','pipe','ignore']});
    let rest='',bytes=0,last=0,failure=null;const [n,d]=String(rate||'0/1').split('/').map(Number),frame=n>0&&d>0?d/n:0;
    const stop=()=>{failure=userError('视频时长扫描超限，请先转换为带时长信息的 MP4',422);child.kill('SIGKILL');};
    const timer=setTimeout(stop,30000);timer.unref();
    const consume=line=>{const [p,l]=line.trim().split(','),pts=Number(p),length=Number(l);if(Number.isFinite(pts))last=Math.max(last,pts+(Number.isFinite(length)&&length>0?length:frame));if(last>21600)stop();};
    child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>16*1024*1024){stop();return;}rest+=chunk.toString();const lines=rest.split('\n');rest=lines.pop();if(rest.length>512){stop();return;}for(const line of lines)consume(line);});
    child.on('error',()=>{clearTimeout(timer);reject(userError('无法读取视频时长，请检查 FFprobe',422));});
    child.on('close',code=>{clearTimeout(timer);if(rest)consume(rest);if(failure||code!==0)reject(failure||userError('无法读取完整视频时长',422));else resolve(last);});
  });
}

// Only files already imported into our asset directory can become decoder inputs.
// Explicit demuxers also prevent a mislabeled playlist from opening other files.
async function localSource(data, assetId, kind) {
  if (!safeId(assetId)) throw userError('素材编号无效');
  const root = await fs.realpath(data);
  const assets = path.join(root, 'assets');
  let meta, file;
  try {
    if (await fs.realpath(assets) !== assets) throw userError('素材目录不能是符号链接');
    const metaPath = path.join(assets, `${assetId}.json`);
    const metaStat = await fs.lstat(metaPath);
    if (!metaStat.isFile() || metaStat.size > 1024**2) throw userError('素材记录无效');
    meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    file = path.join(assets, assetId);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BYTES || await fs.realpath(file) !== file) throw userError('只支持本地素材库中的普通媒体文件');
  } catch (error) {
    if (error.status) throw error;
    throw userError('找不到有效的本地素材', 404);
  }
  const type = typeof meta.type === 'string' ? meta.type.split(';')[0] : '';
  if (meta.id !== assetId || !type.startsWith(`${kind}/`) || !FORMATS[type]) throw userError(kind === 'video' ? '请选择本地视频素材' : '请选择本地图片素材');
  const input = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', FORMATS[type], '-f', FORMATS[type] === 'matroska,webm' ? 'matroska' : FORMATS[type], '-threads', '1', '-max_pixels', String(MAX_PIXELS)];
  const info = JSON.parse(await command('ffprobe', [
    '-v', 'error', '-max_alloc', '67108864', ...input,
    '-probesize', '5000000', '-analyzeduration', '5000000',
    '-select_streams', 'v:0', '-show_entries', 'stream=width,height,duration,avg_frame_rate:format=duration', '-of', 'json', file,
  ]));
  const stream = info.streams?.[0];
  const width = stream?.width, height = stream?.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > 8192 || height > 8192 || width * height > MAX_PIXELS) throw userError('素材尺寸无效或过大，最多支持 1677 万像素、单边 8192 像素');
  let duration = Number(info.format?.duration ?? stream.duration);
  if(kind==='video'&&(!Number.isFinite(duration)||duration<=0))duration=await packetDuration(file,input,stream.avg_frame_rate);
  if (kind === 'video' && (!Number.isFinite(duration) || duration <= 0 || duration > 21_600)) throw userError('无法确定视频时长，或视频超过 6 小时');
  return { root, meta, file, input, width, height, duration };
}

async function outputDirectory(root) {
  const base = path.join(root, 'media-tools');
  await fs.mkdir(base, { recursive: true });
  if (await fs.realpath(base) !== base) throw userError('媒体处理目录不能是符号链接');
  const directory = path.join(base, randomUUID());
  await fs.mkdir(directory);
  return directory;
}

async function saveOutput(data, file, options, details) {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile() || stat.size < 24 || stat.size > MAX_OUTPUT_BYTES) throw userError('处理结果为空或过大', 422);
  const bytes = await fs.readFile(file);
  if (!bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || bytes.readUInt32BE(16) !== details.width || bytes.readUInt32BE(20) !== details.height) throw userError('处理结果的图片尺寸不符合预期', 422);
  const meta = { ...await storeAsset(data, bytes, { ...options, type: 'image/png', source: 'media-tools', category: '处理素材' }), ...details };
  await atomicJson(path.join(data, 'assets', `${meta.id}.json`), meta);
  return meta;
}

function encoderInput(source) {
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-max_alloc', '67108864', '-filter_threads', '1', ...source.input, '-noautorotate'];
}
function pngOutput(file) {
  return ['-map', '0:v:0', '-frames:v', '1', '-an', '-sn', '-dn', '-threads', '1', '-c:v', 'png', '-f', 'image2', '-update', '1', file];
}

export async function extractVideoFrames({ data, assetId, times }) {
  if (!Array.isArray(times) || times.length < 1 || times.length > 12 || times.some(time => typeof time !== 'number' || !Number.isFinite(time) || time < 0)) throw userError('抽帧时间须为 1–12 个有限的非负秒数');
  return limited(async () => {
    const source = await localSource(data, assetId, 'video');
    if (times.some(time => time >= source.duration)) throw userError(`抽帧时间必须小于视频时长 ${source.duration} 秒`);
    const directory = await outputDirectory(source.root);
    const assets = [];
    for (const [index, time] of times.entries()) {
      const file = path.join(directory, `frame-${index + 1}.png`);
      await command('ffmpeg', [...encoderInput(source), '-ss', String(time), '-i', source.file, ...pngOutput(file)]);
      // A valid time after the final presentation timestamp has no next frame.
      // Retain the final decoded frame from a bounded tail, without buffering it all.
      if (!await fs.stat(file).catch(() => null)) {
        await command('ffmpeg', [...encoderInput(source), '-sseof', String(-Math.min(10, source.duration)), '-i', source.file,
          '-t', '10', '-map', '0:v:0', '-an', '-sn', '-dn', '-threads', '1', '-fps_mode', 'passthrough',
          '-c:v', 'png', '-f', 'image2', '-update', '1', file]);
      }
      assets.push(await saveOutput(source.root, file, { name: `视频抽帧-${time}秒-${index + 1}.png` }, {
        width: source.width, height: source.height, sourceAssetId: assetId, operation: 'extract-frame', frameTime: time,
      }));
    }
    return { assets, duration: source.duration };
  });
}

// Legacy sampler retained to reproduce old snapshots. New requests use the
// sequential JPEG sampler below; historical records are never re-sampled.
export async function sampleVideoUniformForChat({data,assetId}) {
  return limited(async()=>{
    const source=await localSource(data,assetId,'video'),directory=await outputDirectory(source.root),frames=[];
    const end=Math.max(0,source.duration-Math.min(.25,source.duration/6));
    for(let i=0;i<6;i++){
      const time=end*i/5,file=path.join(directory,`chat-frame-${i+1}.png`);
      const args=encoderInput(source).filter(x=>x!=='-noautorotate');
      await command('ffmpeg',[...args,'-ss',String(time),'-i',source.file,'-vf',"scale=w='min(768,iw)':h='min(768,ih)':force_original_aspect_ratio=decrease,setsar=1",...pngOutput(file)]);
      if(!await fs.stat(file).catch(()=>null)){
        await command('ffmpeg',[...args,'-sseof',String(-Math.min(10,source.duration)),'-i',source.file,'-t','10','-vf',"scale=w='min(768,iw)':h='min(768,ih)':force_original_aspect_ratio=decrease,setsar=1",'-map','0:v:0','-an','-sn','-dn','-threads','1','-fps_mode','passthrough','-c:v','png','-f','image2','-update','1',file]);
      }
      const handle=await fs.open(file,'r');let header;try{header=Buffer.alloc(24);await handle.read(header,0,24,0);}finally{await handle.close();}
      const width=header.readUInt32BE(16),height=header.readUInt32BE(20);
      if(width<1||height<1||width>768||height>768)throw userError('视频抽样尺寸无效',422);
      const asset=await saveOutput(source.root,file,{name:`视频参考-${(time).toFixed(3)}秒.png`},{width,height,sourceAssetId:assetId,operation:'chat-video-frame',frameTime:time});
      frames.push({assetId:asset.id,time});
    }
    return {duration:source.duration,frames};
  });
}

// Matches the reference project's fps=1 and width-limited JPEG extraction.
// Existing uniform snapshots are never rewritten by this new default.
export async function sampleVideoForChat({data,assetId}) {
 return limited(async()=>{
  const source=await localSource(data,assetId,'video'),directory=await outputDirectory(source.root),args=encoderInput(source).filter(x=>x!=='-noautorotate');
  const output=['-map','0:v:0','-frames:v','6','-an','-sn','-dn','-threads','1','-pix_fmt','yuvj420p','-c:v','mjpeg','-f','image2','-frame_pts','1',path.join(directory,'head-frame-%012d.jpg')];
  // Explicit full-range JPEG also works with newer FFmpeg builds whose default
  // YUV range would otherwise be rejected by the MJPEG encoder.
  await command('ffmpeg',[...args,'-i',source.file,'-vf',"fps=1,scale='min(768,iw)':-2",...output]);
  let names=(await fs.readdir(directory)).filter(n=>/^head-frame-\d{12}\.jpg$/.test(n)).sort(),fallback;
  if(!names.length){
   // Very short clips can round to zero frames at 1 fps. Keep them usable while
   // labelling this explicit first-frame fallback; never upload raw video.
   await command('ffmpeg',[...args,'-i',source.file,'-vf',"scale='min(768,iw)':-2",'-map','0:v:0','-frames:v','1','-an','-sn','-dn','-threads','1','-pix_fmt','yuvj420p','-c:v','mjpeg','-f','image2','-update','1',path.join(directory,'head-frame-000000000000.jpg')]);
   names=['head-frame-000000000000.jpg'];fallback='first-frame';
  }
  if(names.length>6)throw userError('视频抽样数量无效',422);
  const frames=[];
  for(const name of names){
   const time=Number(name.slice(11,-4)),file=path.join(directory,name),st=await fs.stat(file).catch(()=>null);if(!st?.isFile()||st.size<24||st.size>10*1024*1024)throw userError('视频抽样为空或超过10MB',422);
   const info=JSON.parse(await command('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-f','jpeg_pipe','-show_entries','stream=width,height','-of','json',file])),d=info.streams?.[0];
   if(!d||!Number.isInteger(d.width)||!Number.isInteger(d.height)||d.width<1||d.width>768||d.height<1||d.height>8192||d.width*d.height>MAX_PIXELS||!Number.isFinite(time)||time<0||time>=source.duration)throw userError('视频抽样尺寸或时间无效',422);
   const bytes=await fs.readFile(file);if(bytes[0]!==255||bytes[1]!==216||bytes[2]!==255)throw userError('视频抽样不是有效JPEG',422);
   const meta={...await storeAsset(source.root,bytes,{name:`视频参考-约${time}秒.jpg`,type:'image/jpeg',source:'media-tools',category:'处理素材'}),width:d.width,height:d.height,sourceAssetId:assetId,operation:'chat-video-frame',frameTime:time,samplingMethod:VIDEO_SAMPLING_METHOD};
   await atomicJson(path.join(source.root,'assets',meta.id+'.json'),meta);frames.push({assetId:meta.id,time});
  }
  return {duration:source.duration,frames,...(fallback?{fallback}:{})};
 });
}

// Inspect an original video locally without extracting frames or uploading it.
export async function inspectVideoForChat({data,assetId}) {
 return limited(async()=>{
  const source=await localSource(data,assetId,'video');
  const audio=JSON.parse(await command('ffprobe',['-v','error',...source.input,'-select_streams','a:0','-show_entries','stream=codec_type','-of','json',source.file]));
  return {duration:source.duration,width:source.width,height:source.height,hasAudio:audio.streams?.some(s=>s.codec_type==='audio')===true};
 });
}

export async function cropImage({ data, assetId, x, y, width, height }) {
  if (![x, y, width, height].every(Number.isSafeInteger) || x < 0 || y < 0 || width <= 0 || height <= 0 || width * height > MAX_PIXELS) throw userError('裁剪坐标和尺寸须为整数，坐标不能为负，尺寸必须为正且不超过 1677 万像素');
  return limited(async () => {
    const source = await localSource(data, assetId, 'image');
    if (x + width > source.width || y + height > source.height) throw userError(`裁剪区域超出原图 ${source.width} × ${source.height} 像素边界`);
    const directory = await outputDirectory(source.root);
    const file = path.join(directory, 'crop.png');
    await command('ffmpeg', [...encoderInput(source), '-i', source.file, '-vf', `format=rgba,crop=${width}:${height}:${x}:${y}:exact=1`, ...pngOutput(file)]);
    return saveOutput(source.root, file, { name: `图片裁剪-${width}x${height}.png` }, {
      width, height, sourceAssetId: assetId, operation: 'crop', crop: { x, y, width, height },
    });
  });
}

function gridValidation(fn, options) { try { return fn(options); } catch(error) { throw userError(error.message); } }
export async function splitImageGrid({data,assetId,rows=3,columns=3,margin=0,gap=0,indices}) {
  // Validate basic dimensions before decoding; exact dimensions come from FFprobe.
  gridValidation(splitGridLayout,{width:8192,height:8192,rows,columns,margin:0,gap:0});
  if(indices!==undefined&&(!Array.isArray(indices)||!indices.length||indices.length>64||new Set(indices).size!==indices.length||indices.some(i=>!Number.isSafeInteger(i)||i<0||i>=rows*columns)))throw userError('请选择有效且不重复的宫格编号');
  return limited(async()=>{
    const source=await localSource(data,assetId,'image'),tiles=gridValidation(splitGridLayout,{width:source.width,height:source.height,rows,columns,margin,gap});
    const chosen=indices===undefined?tiles:tiles.filter(t=>indices.includes(t.index)),directory=await outputDirectory(source.root),assets=[];
    for(const tile of chosen){const file=path.join(directory,`tile-${tile.index+1}.png`);await command('ffmpeg',[...encoderInput(source),'-i',source.file,'-vf',`format=rgba,crop=${tile.width}:${tile.height}:${tile.x}:${tile.y}:exact=1`,...pngOutput(file)]);assets.push(await saveOutput(source.root,file,{name:`宫格-${tile.row+1}行${tile.column+1}列.png`},{width:tile.width,height:tile.height,sourceAssetId:assetId,operation:'grid-split',grid:{rows,columns,margin,gap,...tile}}));}
    return{assets,width:source.width,height:source.height,rows,columns};
  });
}

export async function composeImageGrid({data,assetIds,columns=3,tileWidth=512,tileHeight=512,margin=0,gap=0,fit='contain',background='#00000000'}) {
  if(!Array.isArray(assetIds)||!assetIds.length||assetIds.length>64||assetIds.some(id=>!safeId(id)))throw userError('请选择 1–64 张本地图片');
  const layout=gridValidation(composeGridLayout,{count:assetIds.length,columns,tileWidth,tileHeight,margin,gap,fit,background});
  return limited(async()=>{
    const sources=[];let pixels=0;
    for(const id of assetIds){const source=await localSource(data,id,'image');pixels+=source.width*source.height;if(pixels>67_108_864)throw userError('本次输入图片总像素超过6710万，请分批拼接');sources.push(source);}
    const directory=await outputDirectory(sources[0].root),file=path.join(directory,'composed.png'),color='0x'+background.slice(1);
    const filters=[`color=c=${color}:s=${layout.width}x${layout.height}:r=1,format=rgba,trim=end_frame=1[base]`];
    const args=['-hide_banner','-loglevel','error','-nostdin','-n','-max_alloc','67108864','-filter_complex_threads','1'];
    for(const [i,source] of sources.entries()){
      args.push(...source.input,'-noautorotate','-i',source.file);
      const sizing=fit==='stretch'?`scale=${tileWidth}:${tileHeight}`:fit==='cover'?`scale=${tileWidth}:${tileHeight}:force_original_aspect_ratio=increase,crop=${tileWidth}:${tileHeight}:exact=1`:`scale=${tileWidth}:${tileHeight}:force_original_aspect_ratio=decrease,pad=${tileWidth}:${tileHeight}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`;
      filters.push(`[${i}:v:0]format=rgba,${sizing},setsar=1,trim=end_frame=1,setpts=PTS-STARTPTS[cell${i}]`);
      const t=layout.tiles[i];filters.push(`[${i===0?'base':'stage'+(i-1)}][cell${i}]overlay=x=${t.x}:y=${t.y}:format=auto:shortest=1[stage${i}]`);
    }
    args.push('-filter_complex',filters.join(';'),'-map',`[stage${sources.length-1}]`,'-frames:v','1','-an','-sn','-dn','-threads','1','-pix_fmt','rgba','-c:v','png','-f','image2','-update','1',file);
    await command('ffmpeg',args);
    return saveOutput(sources[0].root,file,{name:`拼图-${layout.rows}行${columns}列.png`},{width:layout.width,height:layout.height,sourceAssetIds:[...assetIds],operation:'grid-compose',grid:{rows:layout.rows,columns,tileWidth,tileHeight,margin,gap,fit,background}});
  });
}

export async function editorSource({data,assetId}) {
 return limited(async()=>{const source=await localSource(data,assetId,'image'),directory=await outputDirectory(source.root),file=path.join(directory,'preview.png');await command('ffmpeg',[...encoderInput(source),'-i',source.file,...pngOutput(file)]);return file;});
}
export async function imageDimensions({data,assetId}) {
 return limited(async()=>{const source=await localSource(data,assetId,'image');return {width:source.width,height:source.height};});
}
export async function readImageEdit(data,id){
 if(!safeId(id))throw userError('编辑记录编号无效');const root=await fs.realpath(data),dir=path.join(root,'image-edits'),file=path.join(dir,id+'.json');try{if(await fs.realpath(dir)!==dir||!(await fs.lstat(file)).isFile())throw Error();const st=await fs.stat(file);if(st.size>4*1024*1024)throw Error();const record=JSON.parse(await fs.readFile(file,'utf8'));if(record.id!==id||!safeId(record.sourceAssetId))throw Error();return record;}catch{throw userError('编辑记录不存在或不可读取',404);}
}
export async function editImage({data,assetId,operations}) {
 return limited(async()=>{const source=await localSource(data,assetId,'image');let normalized;try{normalized=normalizeEdits(source.width,source.height,operations);}catch(e){throw userError(e.message);}
  const edits=path.join(source.root,'image-edits');await fs.mkdir(edits,{recursive:true});if(await fs.realpath(edits)!==edits)throw userError('编辑记录目录不能是符号链接');
  const directory=await outputDirectory(source.root);await command('ffmpeg',[...encoderInput(source),'-i',source.file,'-map','0:v:0','-frames:v','1','-threads','1','-f','rawvideo','-pix_fmt','rgba',path.join(directory,'source.rgba')]);
  await new Promise((resolve,reject)=>{const worker=new Worker(new URL('./image-edit-worker.mjs',import.meta.url),{workerData:{width:source.width,height:source.height,operations:normalized.operations,directory}}),timer=setTimeout(()=>{worker.terminate();reject(userError('图片编辑处理超时，请分段编辑',422));},30000);worker.once('message',m=>{clearTimeout(timer);m.error?reject(userError(m.error)):resolve(m);});worker.once('error',()=>{clearTimeout(timer);reject(userError('图片编辑处理失败',422));});worker.once('exit',code=>{clearTimeout(timer);if(code)reject(userError('图片编辑进程已停止',422));});});
  const id=randomUUID(),result={},names={image:'编辑结果',mask:'黑白遮罩',input:'透明重绘输入'};
  for(const mode of ['image','mask','input']){const file=path.join(directory,mode+'.png');await command('ffmpeg',['-v','error','-nostdin','-n','-threads','1','-f','rawvideo','-pixel_format','rgba','-video_size',`${normalized.width}x${normalized.height}`,'-i',path.join(directory,mode+'.rgba'),'-frames:v','1','-threads','1','-c:v','png','-f','image2','-update','1',file]);result[mode]=await saveOutput(source.root,file,{name:names[mode]+'.png'},{width:normalized.width,height:normalized.height,sourceAssetId:assetId,operation:'image-edit',editId:id,editOutput:mode});}
  const record={id,version:1,sourceAssetId:assetId,sourceWidth:source.width,sourceHeight:source.height,width:normalized.width,height:normalized.height,operations:normalized.operations,outputs:Object.fromEntries(Object.entries(result).map(([k,a])=>[k,a.id])),createdAt:new Date().toISOString()};await atomicJson(path.join(edits,id+'.json'),record);return{...result,editId:id};
 });
}

export async function capturePanorama({data,assetId,...params}){
 let options;try{options=panoramaOptions(params);}catch(e){throw userError(e.message);}
 return limited(async()=>{const source=await localSource(data,assetId,'image');try{panoramaSource(source.width,source.height);}catch(e){throw userError(e.message);}
  const directory=await outputDirectory(source.root);await command('ffmpeg',[...encoderInput(source),'-i',source.file,'-map','0:v:0','-frames:v','1','-threads','1','-f','rawvideo','-pix_fmt','rgba',path.join(directory,'source.rgba')]);
  await new Promise((resolve,reject)=>{const worker=new Worker(new URL('./panorama-worker.mjs',import.meta.url),{workerData:{directory,width:source.width,height:source.height,options}}),timer=setTimeout(()=>{worker.terminate();reject(userError('全景截图处理超时，请降低输出尺寸',422));},30000);worker.once('message',m=>{clearTimeout(timer);m.error?reject(userError(m.error)):resolve();});worker.once('error',()=>{clearTimeout(timer);reject(userError('全景截图处理失败',422));});worker.once('exit',code=>{clearTimeout(timer);if(code)reject(userError('全景截图处理进程已停止',422));});});
  const file=path.join(directory,'view.png');await command('ffmpeg',['-v','error','-nostdin','-n','-f','rawvideo','-pixel_format','rgba','-video_size',`${options.width}x${options.height}`,'-i',path.join(directory,'view.rgba'),'-frames:v','1','-threads','1','-c:v','png','-f','image2','-update','1',file]);
  return saveOutput(source.root,file,{name:`全景视角-${options.yaw}度.png`},{width:options.width,height:options.height,operation:'panorama',sourceAssetId:assetId,sourceWidth:source.width,sourceHeight:source.height,panorama:options});
 });
}
