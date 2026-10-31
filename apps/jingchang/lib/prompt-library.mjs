import {promptRecommendations} from './prompt-annotations.mjs';
import {withPromptWriteLock} from './prompt-write-lock.mjs';
import {originalPromptPresets} from '../public/prompt-catalog-core.js';
import {promises as fs,constants} from 'node:fs';
import {guardArchiveSecrets} from './task-history-schema.mjs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomicJson,readJson,records,textValue,userError,safeId} from './workspace.mjs';

const MAX_VERSIONS=200;
const snapshotOf=p=>({revision:p.revision,title:p.title,text:p.text,category:p.category||'',negative:p.negative||'',scene:p.scene||'',...(p.recommendations!==undefined?{recommendations:promptRecommendations(p.recommendations)}:{}),createdAt:p.updatedAt||p.createdAt||new Date(0).toISOString()});
function withLegacyVersion(p){
 const revision=Number.isInteger(p.revision)&&p.revision>0?p.revision:1;
 const versions=Array.isArray(p.versions)&&p.versions.length?p.versions:[{...snapshotOf({...p,revision}),revision}];
 return {...p,revision,versions};
}
function promptInput(body,previous={}){
 if(!body||typeof body!=='object'||Array.isArray(body))throw userError('提示词内容无效');
 const optional=(key,max)=>{const value=Object.hasOwn(body,key)?body[key]:previous[key]||'';if(typeof value!=='string'||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))throw userError('提示词附加文字无效或超限');return value;};const fields={title:textValue(body.title,120,'名称'),text:textValue(body.text,20000,'提示词'),category:typeof body.category==='string'?body.category.slice(0,120):'',negative:optional('negative',20000),scene:optional('scene',500),...(Object.hasOwn(body,'recommendations')||previous.recommendations!==undefined?{recommendations:promptRecommendations(Object.hasOwn(body,'recommendations')?body.recommendations:previous.recommendations)}:{})};guardArchiveSecrets(fields);return fields;
}

export function promptLibraryService({data}){
 const dir=path.join(data,'prompts'),presets=new Map(originalPromptPresets().map(p=>[p.id,p]));
 async function directory(){const root=await fs.realpath(data);await fs.mkdir(path.join(root,'prompts'),{recursive:true});if(await fs.realpath(dir)!==path.join(root,'prompts'))throw userError('提示词目录不是普通目录');return path.join(root,'prompts');}
 async function stored(id){let h;try{const file=path.join(await directory(),id+'.json');if(!(await fs.lstat(file)).isFile())throw userError('提示词不是普通文件');if(await fs.realpath(file)!==file)throw userError('提示词不能是符号链接');h=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);const stat=await h.stat();if(!stat.isFile()||stat.size>40*1024**2)throw userError('提示词记录无效或超过40MiB');return JSON.parse(await h.readFile('utf8'));}finally{await h?.close();}}
 async function registry(){const file=path.join(await fs.realpath(data),'prompt-catalog.json');try{if(await fs.realpath(file)!==file)throw userError('提示词目录记录不是普通文件');const st=await fs.lstat(file);if(!st.isFile()||st.size>12*1024**2)throw userError('提示词目录记录无效');return await readJson(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
 async function committed(p,known){if(!p.catalogImportId)return true;const c=known===undefined?await registry():known;return c?.imports?.[p.catalogImportId]?.itemIds?.includes(p.id)===true;}
 async function read(id,{includePending=false}={}){
  if(!safeId(id))throw userError('提示词编号无效');
  try{const p=await stored(id);if(p.id!==id)throw userError('提示词记录编号不一致');if(!includePending&&!await committed(p))throw userError('这条提示词正在恢复，尚未启用',409);return withLegacyVersion(p);}
  catch(error){if(error.code==='ENOENT'){if(presets.has(id))return structuredClone(presets.get(id));throw userError('提示词不存在',404);}throw error;}
 }
 const summary=async(p,known)=>{const {versions,...current}=p,state=known===undefined?await registry():known,location=state?.overrides?.[p.id]||p.catalogOrigin,categoryLabel=state?.libraries?.find(l=>l.id===location?.libraryId)?.categories.find(c=>c.id===location?.categoryId)?.name||p.category||'';return {...current,versionsCount:versions.length,categoryLabel,...(location?{catalogLocation:location}:{})};};
 async function get(id){return summary(await read(id));}
 async function list({includeArchived=false}={}){const directoryPath=await directory(),files=(await fs.readdir(directoryPath)).filter(f=>/^[\w-]+\.json$/.test(f));const pending=await Promise.all(files.map(f=>read(f.slice(0,-5),{includePending:true}))),rows=[];const state=await registry();for(const p of pending)if(await committed(p,state)){const loc=state?.overrides?.[p.id]||p.catalogOrigin;if(!includeArchived&&(loc?.archived||state?.libraries?.find(l=>l.id===loc?.libraryId)?.archived))continue;rows.push(p);}return (await Promise.all(rows.map(p=>summary(withLegacyVersion(p),state)))).sort((a,b)=>String(b.updatedAt||b.createdAt||'').localeCompare(String(a.updatedAt||a.createdAt||'')));}
 async function create(body,{id:chosenId,origin,creation}={}){return withPromptWriteLock(data,chosenId||'new',async()=>{
  const now=new Date().toISOString(),fields=promptInput(body),id=chosenId||randomUUID();if(!safeId(id))throw userError('提示词编号无效');if(chosenId){try{const previous=await stored(id);if(!creation||JSON.stringify(previous.catalogCreation)!==JSON.stringify(creation))throw userError('此提示词编号已用于其他内容',409);return previous;}catch(e){if(e.code!=='ENOENT')throw e;}}
  const p={id,...fields,...(origin?{catalogOrigin:origin}:{}),...(creation?{catalogCreation:creation}:{}),revision:1,createdAt:now,updatedAt:now,versions:[{revision:1,...fields,createdAt:now}]};
  await directory();await atomicJson(path.join(dir,id+'.json'),p);return p;
 });}
 async function update(id,body){return withPromptWriteLock(data,id,async()=>{
  const p=await read(id);
  if(!Number.isInteger(body?.revision)||body.revision!==p.revision)throw userError('提示词已在其他位置更新，请重新读取后再保存',409);
  if(p.versions.length>=MAX_VERSIONS)throw userError(`单条提示词最多保留 ${MAX_VERSIONS} 个版本；为保护历史记录，暂不能继续修改`,409);
  const fields=promptInput(body,p),revision=p.revision+1,now=new Date().toISOString(),next={...p,...fields,revision,updatedAt:now,versions:[...p.versions,{revision,...fields,createdAt:now}]};
  await atomicJson(path.join(dir,id+'.json'),next);return next;
 });}
 async function versions(id){const p=await read(id);return p.versions.slice().sort((a,b)=>b.revision-a.revision);}
 async function restore(id,body){return withPromptWriteLock(data,id,async()=>{
  const p=await read(id);
  if(!Number.isInteger(body?.currentRevision)||body.currentRevision!==p.revision)throw userError('提示词已在其他位置更新，请刷新版本列表后再恢复',409);
  if(p.versions.length>=MAX_VERSIONS)throw userError(`单条提示词最多保留 ${MAX_VERSIONS} 个版本；为保护历史记录，暂不能继续恢复`,409);
  const target=p.versions.find(v=>v.revision===body.revision);
  if(!target)throw userError('要恢复的提示词版本不存在',404);
  const revision=p.revision+1,now=new Date().toISOString(),fields={title:target.title,text:target.text,category:target.category||'',negative:target.negative||'',scene:target.scene||'',...(target.recommendations!==undefined||p.recommendations!==undefined?{recommendations:promptRecommendations(target.recommendations||{})}:{})};
  const next={...p,...fields,revision,updatedAt:now,versions:[...p.versions,{revision,...fields,createdAt:now,restoredFrom:target.revision}]};
  await atomicJson(path.join(dir,id+'.json'),next);return next;
 });}
 async function install(record,{id:targetId,origin,importId,digest}){return withPromptWriteLock(data,targetId,async()=>{if(!safeId(targetId)||!safeId(importId)||typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest))throw userError('提示词恢复映射无效');const next={...record,id:targetId,catalogOrigin:origin,catalogImportId:importId,catalogSourceDigest:digest};try{const old=await stored(targetId);if(JSON.stringify(old)!==JSON.stringify(next))throw userError('恢复位置已有其他内容，原记录保留',409);return old;}catch(e){if(e.code!=='ENOENT')throw e;}await directory();const file=path.join(await directory(),targetId+'.json'),temporary=file+'.pending-'+randomUUID(),handle=await fs.open(temporary,'wx',0o600);try{await handle.writeFile(JSON.stringify(next));await handle.sync();}finally{await handle.close();}await fs.link(temporary,file);return next;});}
 return {list,get,create,update,versions,restore,read,install};
}
