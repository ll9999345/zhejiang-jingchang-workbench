import {normalizeMinimaxTimeline,normalizeMinimaxRefs,minimaxParameters} from '../public/minimax-h3-core.js';
import {normalizeLtxTimeline} from '../public/ltx-director-core.js';
import {normalizeCloudRecipe} from './cloud-recipes.mjs';
import {safeId,userError} from './workspace.mjs';
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v),hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const bad=()=>{throw userError('导演任务留痕结构或范围无效');};
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
function object(value,names,unknown,at){if(!plain(value))bad();const out={};for(const[key,v]of Object.entries(value)){if(!names.includes(key)){unknown.push(at+'.'+key);continue;}out[key]=structuredClone(v);}return out;}
function list(value,max,fn){if(!Array.isArray(value)||value.length>max)bad();return value.map(fn);}
const refKeys=['kind','assetId','sourceNodeId','sourceIndex'];
function refs(value,unknown,at){const out=list(value,15,(r,i)=>object(r,refKeys,unknown,at+'['+i+']'));normalizeMinimaxRefs(out);return out;}
function parameters(value,unknown,at){const out=object(value,['prompt','duration','aspectRatio','megapixels','seed'],unknown,at);minimaxParameters(out);return out;}
function h3(value,unknown,at){
 const out=object(value,['version','engine','referenceNodeId','selectedSegmentId','segments','refs','materials','autoUpstream','fallbackByKind','playhead','muted','timelineZoom'],unknown,at);
 if(out.refs!==undefined)out.refs=refs(out.refs,unknown,at+'.refs');
 if(out.materials!==undefined)out.materials=list(out.materials,1000,(r,i)=>object(r,['assetId','segmentId'],unknown,at+'.materials['+i+']'));
 out.segments=list(out.segments,64,(s,i)=>{const loc=at+'.segments['+i+']',n=object(s,['id','start','duration','prompt','aspectRatio','megapixels','seed','seedMode','refs','trimIn','trimOut','resultAssetId','resultAssetIds','resultVariants'],unknown,loc);if(n.refs!==undefined)n.refs=refs(n.refs,unknown,loc+'.refs');if(n.resultVariants!==undefined)n.resultVariants=list(n.resultVariants,100,(r,j)=>{const entry=object(r,['assetId','loopId','roundIndex','parameters'],unknown,loc+'.resultVariants['+j+']');entry.parameters=parameters(entry.parameters,unknown,loc+'.resultVariants['+j+'].parameters');return entry;});return n;});
 for(const key of ['autoUpstream','fallbackByKind','muted'])if(out[key]!==undefined&&typeof out[key]!=='boolean')bad();normalizeMinimaxTimeline(out);return out;
}
function ltx(value,unknown,at){
 const out=object(value,['nodeId','frameRate','durationFrames','displayMode','width','height','resizeMethod','divisibleBy','compression','epsilon','useCustomAudio','globalPrompt','includeUpstream','segments','audioSegments'],unknown,at);
 for(const track of ['segments','audioSegments'])out[track]=list(out[track],track==='segments'?64:16,(s,i)=>object(s,['id','type','start','length','prompt','assetId','sourceNodeId','sourceIndex','guideStrength','trimStart'],unknown,at+'.'+track+'['+i+']'));
 normalizeLtxTimeline(out);return out;
}
function detail(value,unknown,at){
 const out=object(value,['assetId','sourceNodeId','producerNodeId','originNodeId','kind','name','pending','expectedCount','producerIndex','slot'],unknown,at);
 if(!['image','video','audio'].includes(out.kind))bad();for(const key of ['assetId','sourceNodeId','producerNodeId','originNodeId'])if(out[key]!==undefined&&!safeId(out[key]))bad();
 if(out.pending===true){if(!out.sourceNodeId||out.assetId!==undefined||out.producerNodeId!==undefined)bad();if(out.expectedCount!==undefined&&!integer(out.expectedCount,1,64))bad();if(out.producerIndex!==undefined&&!integer(out.producerIndex,0,63))bad();}
 else if(out.pending!==undefined||!safeId(out.assetId)||out.sourceNodeId!==undefined||out.expectedCount!==undefined||out.producerIndex!==undefined)bad();
 if(out.name!==undefined&&(typeof out.name!=='string'||out.name.length>1000))bad();if(out.slot!==undefined&&(typeof out.slot!=='string'||!/^(segments|audioSegments):[\w-]{1,100}$/.test(out.slot)))bad();return out;
}
const details=(value,unknown,at)=>list(value,10000,(r,i)=>detail(r,unknown,at+'['+i+']'));
function ledger(value,unknown,at){
 const out=object(value,['version','kind','details','automatic'],unknown,at);if(!['h3','ltx','enhance'].includes(out.kind)||![1,2].includes(out.version))bad();out.details=details(out.details,unknown,at+'.details');
 if(out.version===2&&out.kind!=='h3'||out.version===2&&!out.automatic||out.version===1&&out.automatic!==undefined)bad();
 if(out.automatic!==undefined){const a=object(out.automatic,['policy','candidates','details','duplicates','excluded'],unknown,at+'.automatic');if(!['smart','ordinary'].includes(a.policy)||!integer(a.duplicates,0,1000000)||!integer(a.excluded,0,1000000))bad();a.candidates=details(a.candidates,unknown,at+'.automatic.candidates');a.details=details(a.details,unknown,at+'.automatic.details');out.automatic=a;}
 return out;
}
function dependencies(value,unknown,at){return list(value,1500,(v,i)=>{const n=object(v,['nodeId','sha256'],unknown,at+'['+i+']');if(!safeId(n.nodeId)||!hex(n.sha256))bad();return n;});}
function target(value,unknown,at,guard){
 const out=object(value,['nodeId','segmentId','signature','engine','recipeId','recipeRevision','workflowId','resultAssetId','resultState','refs','autoUpstream','fallbackByKind','referenceNodeId','nodeText','dependencies'],unknown,at);
 if(!safeId(out.nodeId)||!safeId(out.segmentId)||typeof out.signature!=='string'||out.signature.length>200000||typeof out.refs!=='string'||out.refs.length>200000)bad();
 for(const key of ['workflowId','recipeId'])if(out[key]!==undefined&&!safeId(out[key]))bad();if(out.recipeRevision!==undefined&&!integer(out.recipeRevision,0,Number.MAX_SAFE_INTEGER))bad();if(out.engine!==undefined&&!['comfyui','runninghub'].includes(out.engine))bad();if(out.resultAssetId!==null&&out.resultAssetId!==undefined&&!safeId(out.resultAssetId))bad();if(out.resultState!==undefined&&!hex(out.resultState))bad();
 if(out.referenceNodeId!==undefined&&out.referenceNodeId!==''&&!safeId(out.referenceNodeId))bad();for(const key of ['autoUpstream','fallbackByKind'])if(out[key]!==undefined&&typeof out[key]!=='boolean')bad();if(out.nodeText!==undefined&&(typeof out.nodeText!=='string'||out.nodeText.length>32000))bad();
 if(out.dependencies!==undefined)out.dependencies=dependencies(out.dependencies,unknown,at+'.dependencies');
 let signature,referenceList;try{signature=JSON.parse(out.signature);referenceList=JSON.parse(out.refs);}catch{bad();}guard(signature);guard(referenceList);
 const sig=object(signature,['id','start','duration','prompt','aspectRatio','megapixels','seed','seedMode','refs'],unknown,at+'.signature');if(sig.refs!==undefined)refs(sig.refs,unknown,at+'.signature.refs');normalizeMinimaxTimeline({version:1,segments:[sig],selectedSegmentId:sig.id});refs(referenceList,unknown,at+'.refs');return out;
}
function cloudRecipe(value,unknown,at){
 const out=object(value,['id','projectId','revision','createdAt','updatedAt','name','kind','targetId','baseUrl','fields','workflowJson','minimaxProfile','catalogVersion','outputType'],unknown,at);
 for(const key of ['id','projectId'])if(out[key]!==undefined&&!safeId(out[key]))bad();if(out.revision!==undefined&&!integer(out.revision,0,Number.MAX_SAFE_INTEGER))bad();
 out.fields=list(out.fields,200,(v,i)=>object(v,['nodeId','fieldName','fieldValue','type','label','options','source','randomEnabled','randomActive','min','max','step','required','nodeClass','assetId','receiptId'],unknown,at+'.fields['+i+']'));
 if(out.workflowJson!==undefined){if(!plain(out.workflowJson))bad();for(const [id,node]of Object.entries(out.workflowJson)){object(node,['class_type','inputs','_meta'],unknown,at+'.workflowJson.'+id);if(node._meta!==undefined)object(node._meta,['title'],unknown,at+'.workflowJson.'+id+'._meta');}}
 normalizeCloudRecipe(out);return out;
}
function outputState(value,unknown,at,guard,full=true){
 const out=object(value,full?['id','type','assetId','text','paramsSha256','dependencies','edges','nativeBranchLayout']:['id','type','assetId','text','paramsSha256'],unknown,at);
 if(!safeId(out.id)||!['text','script','image','video','audio','character','scene','loop'].includes(out.type)||out.assetId!==null&&!safeId(out.assetId)||typeof out.text!=='string'||out.text.length>200000||!hex(out.paramsSha256))bad();
 if(full){out.dependencies=list(out.dependencies,1500,(n,i)=>outputState(n,unknown,at+'.dependencies['+i+']',guard,false));out.edges=list(out.edges,10000,(edge,i)=>{if(typeof edge!=='string'||edge.length>200000)bad();let parsed;try{parsed=JSON.parse(edge);}catch{bad();}guard(parsed);const e=object(parsed,['id','source','target','sourcePort','targetPort','nativeCanvasConnection'],unknown,at+'.edges['+i+']');if(!safeId(e.id)||!safeId(e.source)||!safeId(e.target))bad();if(e.nativeCanvasConnection!==undefined)object(e.nativeCanvasConnection,['from','to','kind'],unknown,at+'.edges['+i+'].nativeCanvasConnection');return edge;});
  if(out.nativeBranchLayout!==undefined)out.nativeBranchLayout=list(out.nativeBranchLayout,1500,(n,i)=>{const v=object(n,['id','x','y'],unknown,at+'.nativeBranchLayout['+i+']');if(!safeId(v.id)||!Number.isFinite(v.x)||!Number.isFinite(v.y))bad();return v;});
 }return out;
}
export function checkDirectorHistoryInput(parent,value,unknown,at,guard){
 try{
  if(['recipe','minimaxRecipe'].includes(parent))return cloudRecipe(value,unknown,at);
  if(parent==='minimaxParents')return list(value,1500,id=>{if(!safeId(id))bad();return id;});
  if(parent==='minimaxH3')return h3(value,unknown,at);
  if(parent==='ltxDirector')return ltx(value,unknown,at);
  if(parent==='nativeDirectorInputs')return ledger(value,unknown,at);
  if(parent==='resolvedDirectorInputs')return details(value,unknown,at);
  if(parent==='minimaxParameters')return parameters(value,unknown,at);
  if(parent==='minimaxUpstreamRefs'){const out=list(value,1500,(r,i)=>object(r,refKeys,unknown,at+'['+i+']'));for(const r of out){if(!['image','video','audio'].includes(r.kind)||!!r.assetId===!!r.sourceNodeId||!safeId(r.assetId||r.sourceNodeId)||r.sourceIndex!==undefined&&(!r.sourceNodeId||!integer(r.sourceIndex,0,999)))bad();}return out;}
  if(parent==='minimaxSeed'){const out=object(value,['version','mode','segmentId','seed'],unknown,at);if(out.version!==1||out.mode!=='random'||!safeId(out.segmentId)||!integer(out.seed,0,4294967294))bad();return out;}
  if(parent==='minimaxResultTarget')return target(value,unknown,at,guard);
  if(parent==='minimaxAttachments')return list(value,10000,(r,i)=>{const n=object(r,['nodeId','segmentId','resultAssetId','resultState','dependencies'],unknown,at+'['+i+']');if(!safeId(n.nodeId)||!safeId(n.segmentId)||n.resultAssetId!==null&&!safeId(n.resultAssetId)||!hex(n.resultState))bad();if(n.dependencies!==undefined)n.dependencies=dependencies(n.dependencies,unknown,at+'['+i+'].dependencies');return n;});
  if(parent==='nativeOutputAttachments')return list(value,1500,(r,i)=>{const n=object(r,['nodeId','assetIds','state'],unknown,at+'['+i+']');if(!safeId(n.nodeId)||!Array.isArray(n.assetIds)||n.assetIds.length>1000||n.assetIds.some(id=>!safeId(id))||new Set(n.assetIds).size!==n.assetIds.length)bad();n.state=outputState(n.state,unknown,at+'['+i+'].state',guard);if(n.state.id!==n.nodeId)bad();return n;});
  if(['minimaxSegmentId','segmentId'].includes(parent)){if(!safeId(value))bad();return value;}
  if(parent==='paramsSha256'){if(!hex(value))bad();return value;}
 }catch(error){if(error.status)throw error;throw userError('导演任务留痕无效：'+error.message);}
}
