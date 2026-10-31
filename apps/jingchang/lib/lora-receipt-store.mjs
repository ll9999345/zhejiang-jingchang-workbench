import {promises as fs,constants} from 'node:fs';
import path from 'node:path';
import {readJson,safeId,userError,assertNoCredentials} from './workspace.mjs';
async function readOnlyFile(data,key){
 if(!safeId(key))throw userError('LoRA 收据编号无效');
 const root=await fs.realpath(data),directory=path.join(root,'lora-receipts'),file=path.join(directory,key+'.json');
 if(await fs.realpath(directory)!==directory)throw userError('只读 LoRA 收据目录不能是符号链接');
 const st=await fs.lstat(file);if(!st.isFile()||st.isSymbolicLink()||st.size>1024*1024)throw userError('只读 LoRA 收据文件无效');
 const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);let raw;try{raw=JSON.parse(await handle.readFile('utf8'));}finally{await handle.close();}
 assertNoCredentials(raw);if(raw.id!==key||raw.kind!=='lora-upload'||raw.status!=='completed'||!safeId(raw.projectId))throw userError('只读 LoRA 收据身份无效');return raw;
}
export async function loadLoraReceipt(data,key){
 if(!safeId(key))throw userError('LoRA 收据编号无效');
 try{return {record:await readJson(path.join(data,'jobs',key+'.json')),readOnly:false};}catch(e){if(e.code!=='ENOENT')throw e;}
 return {record:await readOnlyFile(data,key),readOnly:true};
}
export async function readOnlyLoraReceipts(data){
 const root=await fs.realpath(data),directory=path.join(root,'lora-receipts');let names;
 try{if(await fs.realpath(directory)!==directory)throw userError('只读 LoRA 收据目录不能是符号链接');names=await fs.readdir(directory);}catch(e){if(e.code==='ENOENT')return [];throw e;}
 return Promise.all(names.filter(x=>/^[\w-]+\.json$/.test(x)).map(x=>readOnlyFile(root,x.slice(0,-5))));
}
// Listing is diagnostic: one damaged receipt must not hide unrelated projects.
// Direct load/resolve remains strict and never uses a damaged record.
export async function scanReadOnlyLoraReceipts(data){
 const root=await fs.realpath(data),directory=path.join(root,'lora-receipts');let names;
 try{if(await fs.realpath(directory)!==directory)throw userError('只读 LoRA 收据目录不能是符号链接');names=await fs.readdir(directory);}catch(e){if(e.code==='ENOENT')return {records:[],issues:[]};return {records:[],issues:[{issue:'只读 LoRA 收据目录不可安全读取'}]};}
 const keys=names.filter(x=>/^[\w-]+\.json$/.test(x)).map(x=>x.slice(0,-5)),results=await Promise.allSettled(keys.map(key=>readOnlyFile(root,key))),records=[],issues=[];
 for(const [i,result]of results.entries())if(result.status==='fulfilled')records.push(result.value);else issues.push({receiptId:keys[i],issue:'只读 LoRA 收据损坏或不安全；未用于生成'});
 return {records,issues};
}
