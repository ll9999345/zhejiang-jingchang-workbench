import {parseFragment} from 'parse5';
import {createHash} from 'node:crypto';
import {userError,assertNoCredentials} from './workspace.mjs';
import {nativePromptItems} from '../public/native-prompt-core.js';
import {nativeLoopSettings,nativeLoopLocalPromptFields} from '../public/native-loop-core.js';
import {cascadeReferenceResolver,stripCascadeRefs,uniqueCascadeRefs} from './native-cascade-media.mjs';

const raw=node=>node.params?.nativeCanvas?.node||{};
const type=node=>raw(node).type||node.type;
const hash=url=>createHash('sha256').update(url).digest('hex');
const clean=text=>String(text).replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
const blocks=new Set(['div','p','li','section','article','header','footer','blockquote']);
const token=attrs=>({type:'image',url:attrs['data-url']||'',kind:attrs['data-kind']||'image',name:attrs['data-name']||(attrs['data-kind']==='audio'?'音频':'图片'),nodeId:attrs['data-node-id']||'',imageIndex:Number(attrs['data-image-index']||0)});

function htmlParts(html){
 if(html.length>200000)throw userError('智能串联富文本超过20万字');
 const parts=[],tree=parseFragment(html);
 function visit(node){
  if(node.nodeName==='#text'){if(node.value)parts.push({type:'text',text:node.value});return;}
  const attrs=Object.fromEntries((node.attrs||[]).map(attr=>[attr.name,attr.value]));
  if((attrs.class||'').split(/\s+/).includes('mention-image-token')){parts.push(token(attrs));return;}
  if(node.tagName==='br'){parts.push({type:'text',text:'\n'});return;}
  const block=blocks.has(node.tagName),previous=parts.at(-1);
  if(block&&previous?.text&&!previous.text.endsWith('\n'))parts.push({type:'text',text:'\n'});
  for(const child of node.childNodes||[])visit(child);
  if(block)parts.push({type:'text',text:'\n'});
 }
 for(const child of tree.childNodes)visit(child);
 return parts;
}
function recoveredParts(text,refs){
 const items=(Array.isArray(refs)?refs:[]).filter(ref=>ref?.url&&ref?.name).sort((a,b)=>String(b.name).length-String(a.name).length);
 if(!text||!items.length||!text.includes('@'))return null;
 const parts=[];let chunk='';
 for(let index=0;index<text.length;){
  const hit=text[index]==='@'?items.find(ref=>text.slice(index+1,index+1+String(ref.name).length)===String(ref.name)):null;
  if(hit){if(chunk)parts.push({type:'text',text:chunk});chunk='';parts.push({type:'image',url:hit.url,kind:hit.kind||'image',name:hit.name,nodeId:hit.nodeId||'',imageIndex:Number(hit.imageIndex??'')});index+=1+String(hit.name).length;}
  else chunk+=text[index++];
 }
 if(chunk)parts.push({type:'text',text:chunk});return parts;
}
export function nativeCascadePromptParts(node){
 const value=raw(node),html=String(value.promptDraftHtml||'');
 if(html){
  if(html.includes('mention-image-token'))return htmlParts(html);
  const rebuilt=recoveredParts(String(value.runPrompt||value.promptDraftText||''),value.runPromptRefs);
  return rebuilt||htmlParts(html);
 }
 if(typeof value.runPrompt==='string')return recoveredParts(value.runPrompt,value.runPromptRefs)||[{type:'text',text:value.runPrompt}];
 return[];
}

export function nativeCascadePromptText(project,nodeId,{context={}}={}){
 const nodes=new Map(project.nodes.map(node=>[node.id,node]));
 const inputs=node=>[...new Set(project.edges.filter(edge=>edge.target===node.id&&(edge.nativeCanvasConnection?.kind||'flow')==='input').map(edge=>edge.source))].map(id=>nodes.get(id));
 const members=node=>[...new Set((node.params.nativeCanvas.members||[]).map(ref=>ref.sourceNodeId))].map(id=>nodes.get(id)).filter(member=>member&&member.id!==node.id&&type(member)!=='smart-group');
 const visiting=new Set();
 function items(node){
  if(type(node)==='smart-prompt')return nativePromptItems(node);
  if(type(node)==='smart-loop'){const text=loopText(node);return text?[text]:[];}
  if(type(node)==='smart-group')return members(node).flatMap(items);
  return[];
 }
 function loopText(node){
  const s=nativeLoopSettings(node);if(!s.showPrompt||visiting.has(node.id))return'';
  visiting.add(node.id);
  try{
   const ctx=context.loopContexts?.[node.id]||context,index=Math.max(1,Number(ctx.index||s.start)),total=Math.max(1,Number(ctx.total||s.count));
   const upstream=inputs(node).flatMap(items).map(text=>text.trim()).filter(Boolean),locals=nativeLoopLocalPromptFields(s);
   const selected=upstream[(index-1)%upstream.length]||'',local=locals[(index-1)%locals.length]||'';
   const defaultLocal=['现在生成第《计数》张卖点图片','Generate selling-point image 《计数》'].includes(local);
   return[selected,selected&&defaultLocal?'':local].filter(Boolean).join('\n\n')
    .replaceAll('《计数》',String(index)).replaceAll('[计数]',String(index)).replaceAll('[Counter]',String(index))
    .replaceAll('《总数》',String(total)).replaceAll('[总数]',String(total))
    .replaceAll('《进度》',index+'/'+total).replaceAll('[进度]',index+'/'+total).trim();
  }finally{visiting.delete(node.id);}
 }
 function nodeText(node){
  if(type(node)==='smart-prompt')return nativePromptItems(node).join('\n\n');
  if(type(node)==='smart-loop')return loopText(node);
  if(type(node)==='smart-group')return members(node).map(nodeText).filter(Boolean).join('\n\n');
  return'';
 }
 const node=nodes.get(nodeId);if(!node)throw userError('智能串联提示词节点不存在');
 const direct=inputs(node).filter(input=>['smart-prompt','smart-loop','smart-group'].includes(type(input)));
 const relays=(context.relayPromptNodeIds||[]).map(id=>nodes.get(id));if(relays.some(node=>!node))throw userError('智能串联中继提示词节点不存在');
 const seen=new Set(),texts=[...direct,...relays].map(nodeText).filter(text=>{const key=text.trim();if(!key||seen.has(key))return false;seen.add(key);return true;});
 return{inputPrompt:texts.join('\n\n'),groupPrompt:type(node)==='smart-group'?nodeText(node):''};
}

// Composes the same direct-input/edge-relay scope as the pinned source.
// Imported HTML is parsed inertly; no browser, script or URL is executed.
export function buildNativeCascadePrompt(project,nodeId,{referenceRefs=[],context={},rhFallbackPrompt='',labels={mapHeader:'下面是参考图编号：',userNeed:'用户需求：'}}={}){
 assertNoCredentials(project);const node=project.nodes.find(node=>node.id===nodeId);if(!node)throw userError('智能串联请求节点不存在');
 const parts=nativeCascadePromptParts(node),original=clean(parts.map(part=>part.type==='text'?part.text:'@'+(part.name||'图片')).join(''));
 const resolver=cascadeReferenceResolver(project,{round:{...context,index:context.index||null,forceWorkflow:context.forceWorkflow===true}});
 const refs=uniqueCascadeRefs(resolver.filterBlockedRefs(nodeId,referenceRefs),{limit:20}),blocked=new Set(Array.isArray(raw(node).blockedInputRefs)?raw(node).blockedInputRefs:[]);
 const indexByUrl=new Map(refs.map((ref,index)=>[ref.identity,index+1]));
 let body='',mentioned=false;
 for(const part of parts){
  if(part.type==='text'){body+=part.text;continue;}
  if(!part.url)continue;mentioned=true;
  const key=part.nodeId&&Number.isFinite(part.imageIndex)?part.nodeId+'|'+part.imageIndex:'url|'+part.url;
  if(blocked.has(key)){body+='@'+part.name;continue;}
  const identity=hash(part.url);
  if(!indexByUrl.has(identity)){
   if(refs.length>=20){body+='@'+part.name;continue;}
   const ref=resolver.referenceForItem(nodeId,{url:part.url,name:part.name},part.imageIndex);
   if(!ref)continue;refs.push(ref);indexByUrl.set(identity,refs.length);
  }
  body+='图'+indexByUrl.get(identity);
 }
 const text=nativeCascadePromptText(project,nodeId,{context});body=[text.groupPrompt,text.inputPrompt,clean(body)].filter(Boolean).join('\n\n');
 if(!body&&node.params?.cloudBinding)body=String(rhFallbackPrompt||'').trim();
 const prompt=mentioned&&refs.length?labels.mapHeader+'\n'+refs.map((ref,index)=>'图'+(index+1)+'：'+(ref.name||'图片'+(index+1))).join('\n')+'\n\n'+labels.userNeed+'\n'+body:body;
 if(prompt.length>32000)throw userError('智能串联组合提示词超过32000字');
 return{prompt,displayPrompt:original||body,mentioned,referenceRefs:stripCascadeRefs(refs),roles:refs.map((ref,index)=>({assetId:ref.assetId,kind:ref.kind,role:'image_'+(index+1)}))};
}
