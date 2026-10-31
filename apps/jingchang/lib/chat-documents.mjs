import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createCanvas,loadImage} from '@napi-rs/canvas';
import {documentKind,documentMime,isDocument,DOCUMENT_LIMIT} from '../public/document-types.js';
import {atomicJson,safeId,storeAsset,userError,assertNoCredentials} from './workspace.mjs';

const run=promisify(execFile),parser=fileURLToPath(new URL('./document-reader.py',import.meta.url)),hash=x=>createHash('sha256').update(x).digest('hex'),hashPattern=/^[a-f0-9]{64}$/,locks=new Map();
const formats={'.png':'png_pipe','.jpg':'jpeg_pipe','.jpeg':'jpeg_pipe','.webp':'webp_pipe','.gif':'gif','.bmp':'bmp_pipe','.tif':'tiff_pipe','.tiff':'tiff_pipe'};
async function directory(data,name){const root=await fs.realpath(data),dir=path.join(root,name);await fs.mkdir(dir,{recursive:true});if(await fs.realpath(dir)!==dir)throw userError('文档目录不能是符号链接');return dir;}
async function localAsset(data,id){if(!safeId(id))throw userError('文档素材编号无效');const dir=await directory(data,'assets'),file=path.join(dir,id),metaFile=file+'.json';try{const [st,ms]=await Promise.all([fs.lstat(file),fs.lstat(metaFile)]);if(!st.isFile()||!ms.isFile()||ms.size>1024**2||!st.size||st.size>DOCUMENT_LIMIT)throw userError('文档或内嵌图片不是有效的本地文件，文档最多20MB');const meta=JSON.parse(await fs.readFile(metaFile,'utf8'));if(meta.id!==id||meta.size!==st.size)throw userError('文档素材记录与文件不一致');return {file,meta,bytes:await fs.readFile(file)};}catch(e){if(e.status)throw e;throw userError('找不到完整的文档或内嵌图片',404);}}
async function extract(file,kind,imageLimit){try{const args=[parser,Buffer.isBuffer(file)?'-':file,kind,String(imageLimit)],opts={timeout:15000,killSignal:'SIGKILL',maxBuffer:96*1024*1024,encoding:'utf8',windowsHide:true};const {stdout}=Buffer.isBuffer(file)?await new Promise((resolve,reject)=>{const child=execFile('python3',args,opts,(error,stdout)=>error?reject(error):resolve({stdout}));child.stdin.on('error',()=>{});child.stdin.end(file);}):await run('python3',args,opts);return JSON.parse(stdout);}catch(e){if(e.code==='ENOENT')throw userError('文档读取需要本机 Python 3，诊断页可检查是否可用',503);throw userError('文档无法安全读取：请检查格式、编码及压缩包大小；旧版 Word/Excel 请转存 DOCX/XLSX',422);}}
async function embeddedImage(data,entry){
 const demuxer=formats[path.extname(entry.name).toLowerCase()];if(!demuxer)return null;
 const dir=await directory(data,'document-imports'),file=path.join(dir,randomUUID()+'.image');await fs.writeFile(file,Buffer.from(entry.data,'base64'),{flag:'wx'});
 try{
  const opts={timeout:15000,killSignal:'SIGKILL',maxBuffer:16*1024*1024,windowsHide:true};
  const {stdout:info}=await run('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-f',demuxer,'-i',file,'-select_streams','v:0','-show_entries','stream=width,height','-of','json'],opts);
  const d=JSON.parse(info).streams?.[0];if(!d||d.width<1||d.height<1||d.width*d.height>16777216)return null;
  const factor=Math.min(1,1536/Math.max(d.width,d.height)),w=Math.max(1,Math.round(d.width*factor)),h=Math.max(1,Math.round(d.height*factor));
  const {stdout}=await run('ffmpeg',['-v','error','-nostdin','-protocol_whitelist','file,pipe','-threads','1','-f',demuxer,'-i',file,'-frames:v','1','-vf',`scale=${w}:${h}`,'-threads','1','-f','image2pipe','-c:v','png','pipe:1'],{...opts,encoding:'buffer'});
  const image=await loadImage(stdout),canvas=createCanvas(w,h),ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);ctx.drawImage(image,0,0,w,h);const bytes=canvas.toBuffer('image/jpeg',88),asset=await storeAsset(data,bytes,{name:entry.name+'.jpg',type:'image/jpeg',source:'document-preview'});return {assetId:asset.id,sha256:hash(bytes),name:entry.name};
 }catch(e){if(e.code==='ENOENT')throw userError('读取表格内图片需要本机 FFmpeg 与 FFprobe',503);return null;}
}
export function normalizeDocumentSample(s){
 if(!s||!safeId(s.id)||!safeId(s.assetId)||s.method!=='document-v1'||!hashPattern.test(s.sourceSha256)||!['text','docx','xlsx'].includes(s.kind)||typeof s.name!=='string'||!s.name||s.name.length>200||typeof s.text!=='string'||[...s.text].length>12000||s.textSha256!==hash(s.text)||typeof s.truncated!=='boolean'||typeof s.encoding!=='string'||s.encoding.length>40||!Number.isInteger(s.imageLimit)||s.imageLimit<0||s.imageLimit>20||!Number.isInteger(s.imageCount)||s.imageCount<0||s.imageCount>4096||!Number.isInteger(s.sheetCount)||s.sheetCount<0||s.sheetCount>4096||!Array.isArray(s.warnings)||s.warnings.length>32||s.warnings.some(x=>typeof x!=='string'||x.length>300)||!Array.isArray(s.images)||s.images.length>s.imageLimit||s.images.length>s.imageCount)throw userError('文档提取记录无效');
 if(s.kind!=='xlsx'&&(s.imageCount||s.sheetCount||s.images.length))throw userError('文档类型与提取记录不一致');
 const images=s.images.map(x=>{if(!x||!safeId(x.assetId)||!hashPattern.test(x.sha256)||typeof x.name!=='string'||x.name.length>200)throw userError('文档内嵌图片记录无效');return{assetId:x.assetId,sha256:x.sha256,name:x.name};});if(new Set(images.map(x=>x.assetId)).size!==images.length)throw userError('文档内嵌图片重复');
 return {id:s.id,assetId:s.assetId,method:s.method,sourceSha256:s.sourceSha256,name:s.name,kind:s.kind,text:s.text,textSha256:s.textSha256,truncated:s.truncated,encoding:s.encoding,imageLimit:s.imageLimit,imageCount:s.imageCount,sheetCount:s.sheetCount,warnings:[...s.warnings],images};
}
export function documentSamples(value=[]){if(!Array.isArray(value)||value.length>20||new Set(value.map(x=>x?.assetId)).size!==value.length)throw userError('文档提取记录重复或过多');return value.map(normalizeDocumentSample);}
export async function documentParts(data,record){const s=normalizeDocumentSample(record),source=await localAsset(data,s.assetId);if(!isDocument(source.meta)||documentKind(source.meta.name)!==s.kind||hash(source.bytes)!==s.sourceSha256)throw userError('文档原文件已变化，请重新导入或恢复原文件');const parts=[{type:'text',text:`参考文档：${s.name}\n${s.text||'（没有可提取的正文）'}${s.warnings.length?'\n提取提示：'+s.warnings.join('；'):''}\n本次包含 ${s.images.length} 张文档内嵌图片。`}];for(const image of s.images){const a=await localAsset(data,image.assetId);if(a.meta.type!=='image/jpeg'||hash(a.bytes)!==image.sha256)throw userError('文档预览图片已变化，请恢复原文件');parts.push({type:'text',text:`文档内嵌图片：${image.name}`},{type:'image_url',image_url:{url:'data:image/jpeg;base64,'+a.bytes.toString('base64'),detail:'auto'}});}return parts;}
export async function readDocumentSample(data,id){if(!safeId(id))throw userError('文档预览编号无效');try{const file=path.join(await directory(data,'chat-document-samples'),id+'.json'),st=await fs.lstat(file);if(!st.isFile()||st.size>128*1024)throw userError('文档预览记录无效');const s=normalizeDocumentSample(JSON.parse(await fs.readFile(file,'utf8')));if(s.id!==id)throw userError('文档预览编号不一致');return s;}catch(e){if(e.code==='ENOENT')throw userError('找不到文档预览，请重新选择附件');throw e;}}
export async function prepareDocument(data,assetId,imageLimit){
 const a=await localAsset(data,assetId);if(!isDocument(a.meta))throw userError('不支持此文档格式');const sourceSha256=hash(a.bytes),id=hash('document-v1:'+assetId+':'+sourceSha256+':'+imageLimit),key=data+':'+id;
 if(locks.has(key))return locks.get(key);
 const task=(async()=>{const dir=await directory(data,'chat-document-samples'),file=path.join(dir,id+'.json');if(await fs.access(file).then(()=>true,()=>false)){const s=await readDocumentSample(data,id);await documentParts(data,s);return s;}
  const result=await extract(a.file,documentKind(a.meta.name),imageLimit),images=[];
  for(const entry of result.images){const image=await embeddedImage(data,entry);if(image)images.push(image);else result.warnings.push('无法读取内嵌图片：'+entry.name.slice(0,200));}
  if(hash(await fs.readFile(a.file))!==sourceSha256)throw userError('文档在解析时发生变化，请重新导入');
  const s=normalizeDocumentSample({...result,id,assetId,sourceSha256,name:a.meta.name,method:'document-v1',imageLimit,images,textSha256:hash(result.text),warnings:result.warnings.slice(0,32)});assertNoCredentials(s);await atomicJson(file,s);return s;
 })();locks.set(key,task);try{return await task;}finally{locks.delete(key);}
}
export async function importChatDocument({data,bytes,name}){if(typeof name!=='string'||!name.trim()||name.length>200)throw userError('文档名称须为1至200字');const kind=documentKind(name);if(!kind)throw userError('支持文字、DOCX 和 XLSX；DOC/XLS 请另存新版，PDF 暂不支持');if(!bytes.length||bytes.length>DOCUMENT_LIMIT)throw userError('文档大小须为1字节至20MB');const extracted=await extract(bytes,kind,0);assertNoCredentials({text:extracted.text});return storeAsset(data,bytes,{name,type:documentMime(name),source:'chat-document'});}
export function validateBundleDocuments(conversations,assets,version){const byId=new Map(assets.map(a=>[a.id,a]));for(const c of conversations)for(const m of c.messages){const samples=documentSamples(m.documentSamples);if(samples.length&&version<10)throw userError('文档对话需要第10版备份格式');let remaining=20-m.assetIds.filter(id=>byId.get(id)?.type?.startsWith('image/')).length;for(const id of m.assetIds){const a=byId.get(id),s=samples.find(x=>x.assetId===id);if(isDocument(a)){if(!s||s.kind!==documentKind(a.name)||s.sourceSha256!==a.sha256||s.imageLimit!==remaining)throw userError('备份文档与预览不一致');for(const image of s.images){const a=byId.get(image.assetId);if(a?.type!=='image/jpeg'||a.sha256!==image.sha256)throw userError('备份缺少完整的文档内嵌图片');}remaining-=s.images.length;}else if(s)throw userError('文档预览不能绑定其他素材');}if(samples.some(s=>!m.assetIds.includes(s.assetId)))throw userError('文档预览与消息引用不匹配');}}
