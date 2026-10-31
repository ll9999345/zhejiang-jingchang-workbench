import path from 'node:path';
import {localMiaoCredentialService,normalizeMiaoCredential,resolveMiaoCredential} from './miao-credentials.mjs';
import { randomUUID } from 'node:crypto';
import { atomicJson, readJson, textValue, userError, safeId } from './workspace.mjs';
import { validateApiBaseUrl, listImageModels } from './image-api.mjs';
import { listGeminiModels } from './extended-protocols.mjs';

export function platformService(data,{miaoCredentials=localMiaoCredentialService(),openAIModelLister=listImageModels}={}){
  const file=path.join(data,'api-platforms.json');let lock=Promise.resolve();
  const list=()=>readJson(file,{revision:0,platforms:[]});
  function mutate(fn){const task=lock.catch(()=>{}).then(fn);lock=task;return task;}
  async function save(body){return mutate(async()=>{
    const previous=await list();if(body.revision!==previous.revision)throw userError('平台配置已在另一窗口更新，请重新打开后保存',409);
    const p=body.platform;if(!p||!['openai-compatible','gemini'].includes(p.protocol))throw userError('当前平台协议无效');
    const baseUrl=validateApiBaseUrl(p.baseUrl);
    if(!Array.isArray(p.models)||p.models.length>300)throw userError('模型列表格式无效，最多 300 个');
    const ids=new Set();const models=p.models.map(m=>{const id=textValue(m.id,200,'模型标识');if(ids.has(id))throw userError('模型标识重复');ids.add(id);if(!['image','chat','video'].includes(m.category))throw userError('请指定图片、对话或视频分类');if(p.protocol==='gemini'&&m.category==='video')throw userError('Gemini 原生协议当前不支持视频生成分类');if(p.protocol==='gemini'&&(!/^gemini[-\w.]{1,160}$/.test(id)||id.includes('..')))throw userError('Gemini 模型标识格式无效');if(p.protocol==='gemini'&&m.category==='image'&&!/-image(?:[-.]|$)/i.test(id))throw userError('Gemini 图片模型名称须包含 -image');if(p.protocol==='gemini'&&m.category==='chat'&&(/-image(?:[-.]|$)|-tts(?:[-.]|$)/i.test(id)))throw userError('Gemini 图片或语音合成模型不能归入对话分类');const referenceSupport=m.referenceSupport===true,audioSupport=p.protocol==='gemini'&&m.category==='chat'&&m.audioSupport===true,videoSupport=p.protocol==='gemini'&&m.category==='chat'&&m.videoSupport===true;return{id,label:String(m.label||id).slice(0,120),category:m.category,referenceSupport,audioSupport,videoSupport,maskSupport:p.protocol==='openai-compatible'&&m.category==='image'&&referenceSupport&&m.maskSupport===true};});
    const entry={id:p.id||randomUUID(),name:textValue(p.name,80,'平台名称'),protocol:p.protocol,baseUrl,models,updatedAt:new Date().toISOString()};
    if(!safeId(entry.id))throw userError('平台编号无效');if(p.id&&!previous.platforms.some(x=>x.id===p.id))throw userError('平台不存在',404);
    const platforms=previous.platforms.filter(x=>x.id!==entry.id);platforms.push(entry);if(platforms.length>50)throw userError('平台数量最多50个');
    const next={revision:previous.revision+1,platforms};await atomicJson(file,next);return next;
  });}
  async function get(id){const record=await list(),platform=record.platforms.find(p=>p.id===id);if(!platform)throw userError('请先在 API 设置中保存平台',404);return platform;}
  async function discover(body){
    const p=await get(body.platformId);
    if(body.consent!==true)throw userError('请确认向此平台发送本次模型列表请求');
    const credential=normalizeMiaoCredential({...body,apiKey:body.apiKey||''},p);
    const resolved=await resolveMiaoCredential(credential,p,miaoCredentials);
    try{
      const result=p.protocol==='gemini'?await listGeminiModels({baseUrl:p.baseUrl,apiKey:resolved.apiKey,signal:AbortSignal.timeout(30000)}):await openAIModelLister({baseUrl:p.baseUrl,apiKey:resolved.apiKey,signal:AbortSignal.timeout(30000)});
      // A provider can echo credentials in a successful model list. Such IDs
      // must never reach the browser or be saved as selectable model metadata.
      const containsSecret=value=>typeof value==='string'?!!resolved.apiKey&&value.includes(resolved.apiKey):!!value&&typeof value==='object'&&Object.entries(value).some(([name,item])=>containsSecret(name)||containsSecret(item));
      const original=Array.isArray(result)?result:result.models;
      const models=original.filter(model=>!containsSecret(model));
      let note=!Array.isArray(result)&&typeof result.note==='string'?result.note:'';
      if(resolved.apiKey)note=note.replaceAll(resolved.apiKey,'[已隐藏]');
      if(models.length!==original.length)note+=(note?'；':'')+'已过滤上游返回的敏感模型字段';
      return {models,...(note?{note}:{}),...(!Array.isArray(result)&&result.partial?{partial:true}:{})};
    }finally{resolved.apiKey='';body.apiKey='';}
  }
  return {list,save,get,discover};
}
