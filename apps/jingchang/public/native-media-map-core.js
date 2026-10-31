const safe=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(id);
export function nativeMediaReferenceDescriptors(node){
 const out=[],p=node.params||{},add=(ref,label,path,collection=false)=>{if(ref?.sourceNodeId)out.push({ref,label,path,collection});};
 const h3=(t,path)=>{for(const [i,r]of (t?.refs||[]).entries())add(r,'H3参考',[...path,'refs',i]);for(const [i,s]of (t?.segments||[]).entries())for(const [j,r]of (s.refs||[]).entries())add(r,'H3片段参考',[...path,'segments',i,'refs',j]);};
 h3(p.minimaxH3,['minimaxH3']);
 for(const [key,label]of [['workflowBinding','工作流'],['cloudBinding','云工作流']]){const b=p[key];for(const [i,r]of (b?.imageSources||[]).entries())add(r,label+'图片字段',[key,'imageSources',i]);for(const [i,r]of (b?.inputs||[]).entries())add(r,label+'素材字段',[key,'inputs',i]);h3(b?.minimaxH3,[key,'minimaxH3']);for(const track of ['segments','audioSegments'])for(const [i,r]of (b?.ltxDirector?.[track]||[]).entries())if(r.type!=='text')add(r,'LTX片段',[key,'ltxDirector',track,i]);}
 for(const key of ['imageBinding','llmBinding','studioBinding'])for(const [i,r]of (p[key]?.referenceSources||[]).entries())add(r,'参考素材',[key,'referenceSources',i],key!=='studioBinding'||r.sourceIndex===undefined);
 return out;
}
export const nativeMediaPathKey=path=>JSON.stringify(path);
export function validateNativeMediaMap(node,project){
 const map=node.params?.nativeMediaMap;if(map===undefined)return;
 const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k)),bad=()=>{throw Error('逐轮选图记录无效，请保留工程并重新检查');},ids=new Set(project.nodes.map(n=>n.id));
 if(!exact(map,['version','loopId','scopeHash','fields'])||map.version!==1||!safe(map.loopId)||!/^[a-f0-9]{64}$/.test(map.scopeHash)||!Array.isArray(map.fields)||!map.fields.length||map.fields.length>1000||node.params?.nativeMediaVersion!==2)bad();
 const loop=project.nodes.find(n=>n.id===map.loopId);if(loop&&!['loop','smart-loop'].includes(loop.params?.nativeCanvas?.node.type))bad();
 const seen=new Set();
 for(const field of map.fields){
  if(!exact(field,['path','sourceNodeId','sourceIndex','originalSourceIndex','rounds'])||!Array.isArray(field.path)||field.path.length>8||!safe(field.sourceNodeId)||![field.sourceIndex,field.originalSourceIndex].every(i=>Number.isSafeInteger(i)&&i>=0&&i<=999)||!Array.isArray(field.rounds)||!field.rounds.length||field.rounds.length>100)bad();
  const key=nativeMediaPathKey(field.path),pattern=field.path.map(v=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=999?'#':typeof v==='string'?v:'!').join('.');if(seen.has(key)||!(/^(workflowBinding\.imageSources\.#|cloudBinding\.inputs\.#|studioBinding\.referenceSources\.#|(minimaxH3|workflowBinding\.minimaxH3|cloudBinding\.minimaxH3)\.(refs\.#|segments\.#\.refs\.#)|workflowBinding\.ltxDirector\.(segments|audioSegments)\.#)$/.test(pattern)))bad();seen.add(key);const rounds=new Set();
  for(const r of field.rounds){if(!exact(r,['roundIndex','index','sourceIndex','selection'])||!Number.isSafeInteger(r.roundIndex)||r.roundIndex<0||r.roundIndex>99||rounds.has(r.roundIndex)||!Number.isSafeInteger(r.index)||r.index<1||r.index>19899||!Number.isSafeInteger(r.sourceIndex)||r.sourceIndex<0||r.sourceIndex>999||!exact(r.selection,['sourceNodeId','sourceIndex','assetId','kind'])||!safe(r.selection.sourceNodeId)||!Number.isSafeInteger(r.selection.sourceIndex)||r.selection.sourceIndex<0||r.selection.sourceIndex>999||r.selection.assetId!==undefined&&!safe(r.selection.assetId)||r.selection.kind!==undefined&&!['image','video','audio'].includes(r.selection.kind))bad();rounds.add(r.roundIndex);}
 }
}
