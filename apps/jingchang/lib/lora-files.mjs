import {promises as fs,createReadStream} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {atomicJson,loadAsset,textValue,userError} from './workspace.mjs';

export const LORA_MIME='application/x-safetensors',MAX_LORA_BYTES=2*1024**3,MAX_LORA_HEADER=16*1024**2;
// Container validation only: no model code or tensor values are executed.
const bits={BOOL:8,U8:8,I8:8,F8_E5M2:8,F8_E4M3:8,F8_E8M0:8,F8_E4M3FNUZ:8,F8_E5M2FNUZ:8,I16:16,U16:16,F16:16,BF16:16,I32:32,U32:32,F32:32,I64:64,U64:64,F64:64,C64:64,F4:4,F6_E2M3:6,F6_E3M2:6};
const bad=()=>{throw userError('不是完整的 safetensors 文件，或超出本机支持的格式范围');};
function strictJson(text){
 let p=0;const ws=()=>{while(/[\t\n\r ]/.test(text[p]||'!'))p++;};
 function string(){const start=p++;while(p<text.length){const c=text[p++];if(c==='"')return JSON.parse(text.slice(start,p));if(c==='\\')p++;}bad();}
 function value(depth=0){if(depth>20)bad();ws();if(text[p]==='"')return string();if(text[p]==='{'){p++;ws();const keys=new Set();if(text[p]==='}'){p++;return;}for(;;){ws();if(text[p]!=='"')bad();const key=string();if(keys.has(key))bad();keys.add(key);ws();if(text[p++]!==':')bad();value(depth+1);ws();const c=text[p++];if(c==='}')return;if(c!==',')bad();}}
  else if(text[p]==='['){p++;ws();if(text[p]===']'){p++;return;}for(;;){value(depth+1);ws();const c=text[p++];if(c===']')return;if(c!==',')bad();}}
  else{const start=p;while(p<text.length&&!/[\s,}\]]/.test(text[p]))p++;if(p===start)bad();JSON.parse(text.slice(start,p));}}
 try{value();ws();if(p!==text.length)bad();return JSON.parse(text);}catch{bad();}
}
export function validateLoraHeader(header,dataLength){
 let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(header);}catch{bad();}if(!text.startsWith('{'))bad();const doc=strictJson(text);if(!doc||Array.isArray(doc))bad();
 const ranges=[];for(const [name,t] of Object.entries(doc)){if(name==='__metadata__'){if(!t||Array.isArray(t)||typeof t!=='object'||Object.values(t).some(v=>typeof v!=='string'))bad();continue;}
  if(!t||typeof t!=='object'||Array.isArray(t)||!Object.hasOwn(bits,t.dtype)||!Array.isArray(t.shape)||t.shape.length>32||t.shape.some(n=>!Number.isSafeInteger(n)||n<0)||!Array.isArray(t.data_offsets)||t.data_offsets.length!==2||t.data_offsets.some(n=>!Number.isSafeInteger(n)||n<0))bad();
  const [start,end]=t.data_offsets,nbits=t.shape.reduce((n,d)=>n*BigInt(d),BigInt(bits[t.dtype]));if(end<start||end>dataLength||nbits%8n||nbits/8n!==BigInt(end-start))bad();ranges.push([start,end]);if(ranges.length>100000)bad();
 }
 if(!ranges.length)bad();ranges.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);let end=0;for(const r of ranges){if(r[0]!==end)bad();end=r[1];}if(end!==dataLength)bad();return{tensorCount:ranges.length,headerBytes:header.length};
}
export async function inspectLoraFile(file,{start=0,size,hash=true}={}){
 const st=await fs.lstat(file);if(!st.isFile()||st.isSymbolicLink())throw userError('LoRA 文件必须是本机普通文件');size??=st.size;
 if(!Number.isSafeInteger(size)||size<10||size>MAX_LORA_BYTES||!Number.isSafeInteger(start)||start<0||start+size>st.size)bad();
 const h=await fs.open(file,'r');let info;try{const len=Buffer.alloc(8);if((await h.read(len,0,8,start)).bytesRead!==8)bad();const n=len.readBigUInt64LE();if(n<2n||n>BigInt(MAX_LORA_HEADER)||n>BigInt(size-8))bad();const header=Buffer.alloc(Number(n));if((await h.read(header,0,header.length,start+8)).bytesRead!==header.length)bad();info=validateLoraHeader(header,size-8-header.length);}finally{await h.close();}
 if(hash){const md5=createHash('md5'),sha=createHash('sha256');let count=0;for await(const chunk of createReadStream(file,{start,end:start+size-1})){md5.update(chunk);sha.update(chunk);count+=chunk.length;}if(count!==size)bad();Object.assign(info,{md5Hex:md5.digest('hex'),sha256:sha.digest('hex')});}
 return{...info,size};
}
export function loraMetadata(a){if(a?.type!==LORA_MIME)return{};const l=a.lora;if(!l||!/^[a-f0-9]{32}$/.test(l.md5Hex)||!/^[a-f0-9]{64}$/.test(l.sha256)||!Number.isSafeInteger(l.tensorCount)||l.tensorCount<1||l.tensorCount>100000||!Number.isSafeInteger(l.headerBytes)||l.headerBytes<2||l.headerBytes>MAX_LORA_HEADER)throw userError('LoRA 文件校验记录无效');return{lora:{md5Hex:l.md5Hex,sha256:l.sha256,tensorCount:l.tensorCount,headerBytes:l.headerBytes}};}
export async function verifyLoraAsset(data,id){const a=await loadAsset(data,id);if(a.type!==LORA_MIME)throw userError('请选择已校验的 LoRA 文件');loraMetadata(a);const file=path.join(await fs.realpath(data),'assets',id);if(await fs.realpath(file)!==file)throw userError('LoRA 文件路径无效');const info=await inspectLoraFile(file);if(info.size!==a.size||Object.keys(a.lora).some(k=>info[k]!==a.lora[k]))throw userError('LoRA 文件与导入时不一致，请重新导入');return a;}
export async function importLoraFile(data,stream,{name,size}){
 name=textValue(name,200,'文件名称');if(!/\.safetensors$/i.test(name)||/[\/\\\x00-\x1f]/.test(name))throw userError('请选择 .safetensors 文件');if(!Number.isSafeInteger(size)||size<10||size>MAX_LORA_BYTES)throw userError('LoRA 文件须小于或等于 2 GiB');
 const disk=await fs.statfs(data);if(disk.bavail*disk.bsize<size+64*1024**2)throw userError('本机可用空间不足以保存 LoRA 文件并保留64MiB余量，请选择较小文件或处理空间后再试',507);
 const id=randomUUID(),folder=path.join(data,'lora-imports');await fs.mkdir(folder,{recursive:true});const pending=path.join(folder,id+'.incoming'),h=await fs.open(pending,'wx');let total=0;
 try{for await(const chunk of stream){total+=chunk.length;if(total>size)throw userError('导入文件长度超出声明大小');let offset=0;while(offset<chunk.length){const n=(await h.write(chunk,offset,chunk.length-offset)).bytesWritten;if(!n)throw userError('文件写入中断');offset+=n;}}}finally{await h.close();}
 if(total!==size)throw userError('LoRA 文件导入不完整，原文件请保留后重新导入');const {size:actual,...lora}=await inspectLoraFile(pending),meta={id,name,type:LORA_MIME,size:actual,lora,category:'LoRA',tags:[],source:'lora-import',createdAt:new Date().toISOString(),url:'/media/'+id};
 await fs.mkdir(path.join(data,'assets'),{recursive:true});await fs.rename(pending,path.join(data,'assets',id));await atomicJson(path.join(data,'assets',id+'.json'),meta);return meta;
}
