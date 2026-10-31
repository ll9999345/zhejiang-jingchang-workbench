import {safeId,userError} from './workspace.mjs';
import {nativeProducerIndices} from './native-producer-slots.mjs';
import {checkedNativeInputReviews} from './native-input-review-proof.mjs';
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v,allowed,unsupported,location)=>{if(!plain(v))throw userError('原生执行留痕结构无效');for(const k of Object.keys(v))if(!allowed.includes(k))unsupported.push(location+'.'+k);};
function details(value,unsupported,location){
 if(!Array.isArray(value)||value.length>1000)throw userError('原生参考留痕数量无效');
 for(const [i,r]of value.entries()){
  const at=location+'['+i+']';keys(r,['assetId','url','type','name','kind','originNodeId','producerNodeId','sourceNodeId','pending','expectedCount','producerIndices'],unsupported,at);
  if(!['image','video','audio'].includes(r.kind)||[r.assetId,r.url,r.sourceNodeId].filter(v=>v!==undefined).length!==1)throw userError('原生参考留痕来源或类型无效');
  for(const k of ['assetId','originNodeId','producerNodeId','sourceNodeId'])if(r[k]!==undefined&&!safeId(r[k]))throw userError('原生参考留痕编号无效');
  if(r.pending===true){if(!r.sourceNodeId)throw userError('待生成参考留痕缺少生产者');nativeProducerIndices(r);}
  else if(r.pending!==undefined||r.producerIndices!==undefined||r.expectedCount!==undefined)throw userError('静态参考留痕不能含待生成序号');
 }
}
// Restrict the named execution records; unknown members stay unsupported.
export function checkNativeHistoryInput(parent,value,unsupported,location){
 if(parent==='nativeInputReviews'){
  if(!/^job:[\w-]+\.nativeInputReviews$/.test(location))throw userError('素材确认记录的位置无效');
  return structuredClone(checkedNativeInputReviews(value));
 }
 if(parent==='nativeInputReviewApplied'){
  if(!/^job:[\w-]+\.steps\[\d+\]\.nativeInputReviewApplied$/.test(location)||!Array.isArray(value)||value.length>1000)throw userError('素材确认执行留痕无效');
  for(const row of value)if(!plain(row)||Object.keys(row).some(key=>!['reviewId','detailIndex','sourceFingerprint'].includes(key))||!safeId(row.reviewId)||!Number.isSafeInteger(row.detailIndex)||row.detailIndex<0||row.detailIndex>999||typeof row.sourceFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(row.sourceFingerprint))throw userError('素材确认执行留痕无效');
  return structuredClone(value);
 }
 if(parent==='nativeReferences'){
  keys(value,['version','kinds','details'],unsupported,location);if(value.version!==1||!Array.isArray(value.kinds)||value.kinds.length>3||new Set(value.kinds).size!==value.kinds.length||value.kinds.some(k=>!['image','video','audio'].includes(k)))throw userError('原生参考留痕版本或类型无效');details(value.details,unsupported,location+'.details');
 }else if(parent==='resolvedReferences'){if(Array.isArray(value))details(value,unsupported,location);else if(!/\[\d+\]$/.test(location))throw userError('原生参考留痕数量无效');}
 else if(parent==='nativeUnit'){
  keys(value,['version','id','dependencies'],unsupported,location);if(value.version!==1||!safeId(value.id)||!Array.isArray(value.dependencies)||value.dependencies.length>1500||value.dependencies.some(id=>!safeId(id))||new Set(value.dependencies).size!==value.dependencies.length)throw userError('原生执行单元留痕无效');
 }else if(parent==='nativeFlow'){
  keys(value,['version','text','ownText'],unsupported,location);if(value.version!==1||typeof value.text!=='boolean'||typeof value.ownText!=='string'||value.ownText.length>200000)throw userError('原生输入文字留痕无效');
 }else if(parent==='nativeBackend'){
  const address=typeof value==='string'?value:value?.url;if(typeof value!=='string')keys(value,['id','name','url'],unsupported,location);let u;try{u=new URL(address);}catch{throw userError('原生执行后端留痕无效');}if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw userError('原生执行后端留痕无效');
 }else if(parent==='contexts'){
  if(!/\.nativeLoop\.contexts$/.test(location)){unsupported.push(location);return null;}
  if(!plain(value)||Object.keys(value).length>1500)throw userError('原生循环上下文留痕无效');
  const result={};for(const [id,ctx]of Object.entries(value)){if(!safeId(id))throw userError('原生循环上下文编号无效');keys(ctx,['index','total'],unsupported,location+'.'+id);if(!Number.isSafeInteger(ctx.index)||ctx.index<1||ctx.index>19899||ctx.total!==undefined&&(!Number.isSafeInteger(ctx.total)||ctx.total<1||ctx.total>19899))throw userError('原生循环计数留痕无效');result[id]=structuredClone(ctx);}return result;
 }
 return undefined;
}
