import {scanReadOnlyLoraReceipts} from './lora-receipt-store.mjs';
import {ltxReferences} from '../public/ltx-director-core.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readJson, records, safeId } from './workspace.mjs';
import {subtitleFont} from './render-subtitles.mjs';
import {localCliStatuses} from './local-cli-status.mjs';
const run=promisify(execFile);
export async function diagnostics({root,data,projects}){
  const checks=[];
  for(const name of ['ffmpeg','ffprobe','python3']){try{await run(name,[name==='python3'?'--version':'-version'],{timeout:3000,maxBuffer:20000});checks.push({name,status:'ok',message:'本机可用'});}catch{checks.push({name,status:'missing',message:name==='python3'?'本机未找到，文档读取需要 Python 3':'本机未找到，视频合成需要此工具'});}}
  try{const font=await subtitleFont();checks.push({name:'中文字幕绘制',status:'ok',message:'本机可用 · '+font});}catch(e){checks.push({name:'中文字幕绘制',status:'missing',message:e.message});}
  for(const cli of await localCliStatuses())checks.push({name:cli.name,status:cli.installed===true?'ok':cli.installed===false?'missing':'unknown',message:cli.message});
  const assets=await records(path.join(data,'assets')),missing=[];
  for(const a of assets){if(!safeId(a.id))continue;try{const st=await fs.stat(path.join(data,'assets',a.id));if(st.size!==a.size)missing.push({id:a.id,name:a.name,issue:'文件大小与索引不一致'});}catch{missing.push({id:a.id,name:a.name,issue:'媒体文件缺失'});}}
  const references=[];
  for(const a of assets)if(a.enhancement)for(const id of new Set([a.enhancement.sourceAssetId,a.enhancement.originalAssetId]))if(!assets.some(x=>x.id===id&&x.type.startsWith('image/')))references.push({assetId:a.id,sourceAssetId:id,issue:'增强结果缺少原图索引'});
  for(const item of projects){const p=await readJson(path.join(data,'projects',item.id,'project.json'));for(const id of new Set([...p.nodes.map(n=>n.assetId),...p.nodes.flatMap(n=>(n.params?.llmBinding?.referenceSources||[]).map(r=>r.assetId)),...p.nodes.flatMap(n=>ltxReferences(n.params?.workflowBinding?.ltxDirector).map(s=>s.assetId)),...p.shots.flatMap(s=>[s.assetId,s.audioId]),...(p.settings.edit?.music||[]).map(t=>t.assetId)].filter(Boolean)))if(!assets.some(a=>a.id===id))references.push({projectId:p.id,assetId:id,issue:'项目引用缺少全局素材索引'});}
  const conversations=await records(path.join(data,'conversations'));for(const c of conversations)for(const m of c.messages||[])for(const id of new Set([...(m.assetIds||[]),...(m.usedReferenceIds||[]),...(m.videoSamples||[]).flatMap(s=>(s.frames||[]).map(f=>f.assetId)),...(m.documentSamples||[]).flatMap(s=>(s.images||[]).map(f=>f.assetId))]))if(!assets.some(a=>a.id===id))references.push({projectId:c.projectId,assetId:id,issue:'对话引用缺少原素材、视频抽样或文档内嵌图片索引'});
  const jobs=await records(path.join(data,'jobs'));
  const readOnlyLoras=await scanReadOnlyLoraReceipts(data);references.push(...readOnlyLoras.issues);const loraRecords=[...jobs,...readOnlyLoras.records];const cloudRecipes=await records(path.join(data,'cloud-workflows'));for(const r of cloudRecipes)for(const f of r.fields||[])if(f.source==='lora'){const a=assets.find(a=>a.id===f.assetId),j=loraRecords.find(j=>j.id===f.receiptId);if(!a||a.type!=='application/x-safetensors')references.push({projectId:r.projectId,assetId:f.assetId,issue:'云工作流缺少 LoRA 本机文件索引'});if(!j||j.status!=='completed'||j.kind!=='lora-upload'||j.assetId!==f.assetId||j.projectId!==r.projectId||j.baseUrl!==r.baseUrl||j.sha256!==a?.lora?.sha256)references.push({projectId:r.projectId,assetId:f.assetId,issue:'云工作流缺少匹配的 LoRA 成功上传记录'});}
  const {version}=await readJson(path.join(root,'package.json'));
  return {version,checkedAt:new Date().toISOString(),checks,counts:{projects:projects.length,assets:assets.length,jobs:jobs.length},missingAssets:missing,missingReferences:references,paths:{project:root,data,projects:path.join(data,'projects'),assets:path.join(data,'assets'),assetCatalog:path.join(data,'asset-catalog','catalog.json'),assetLibraryFiles:path.join(data,'asset-catalog','libraries'),jobs:path.join(data,'jobs'),workflows:path.join(data,'workflows'),platforms:path.join(data,'api-platforms.json'),conversations:path.join(data,'conversations'),videoSamples:path.join(data,'chat-video-samples'),documentSamples:path.join(data,'chat-document-samples')},notes:['诊断只检查本机，不调用生成接口，也不删除或修复文件。','CLI 检查仅查找本机可执行文件，不执行 CLI，也不读取登录信息或查询账户积分。','配置只保存平台和模型信息。API Key 仅用于本次请求，不写入文件。']};
}
