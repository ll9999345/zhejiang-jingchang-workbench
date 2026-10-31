import {compileMinimaxH3} from './minimax-h3.mjs';
import {normalizeCloudRecipe} from './cloud-recipes.mjs';
import {applyRhWorkflowFields,pruneRhReferenceBranches,rhWorkflowLink} from './rh-workflow.mjs';
import {minimaxLimits,supportsMinimaxRhAsset} from '../public/minimax-h3-core.js';
import {userError} from './workspace.mjs';
function slotLoader(graph,referenceNodeId,kind,index){
 const key=`ref_${kind}s.ref_${kind}_${index}`,value=graph[referenceNodeId]?.inputs[key];if(!rhWorkflowLink(value))throw userError(`H3 RunningHub 工作流缺少${kind}第${index+1}个参考槽位`);
 const found=[],visited=new Set(),klass={image:'LoadImage',video:'LoadVideo',audio:'LoadAudio'}[kind];
 function walk(id){id=String(id);if(visited.has(id))return;visited.add(id);const node=graph[id];if(node.class_type===klass){const names=(kind==='video'?['file','video']:[kind==='image'?'image':'audio']).filter(name=>Object.hasOwn(node.inputs,name)&&typeof node.inputs[name]==='string');if(names.length!==1)throw userError('H3 RunningHub 素材输入字段不明确');found.push({nodeId:id,fieldName:names[0],nodeClass:klass});return;}for(const v of Object.values(node.inputs))if(rhWorkflowLink(v))walk(v[0]);}
 walk(value[0]);if(found.length!==1)throw userError('H3 RunningHub 参考槽位须连接一个明确的同类型载入节点');return {...found[0],key};
}
export function compileMinimaxRunningHub(input,rawRecipe,options={}){
 const recipe={...rawRecipe,...normalizeCloudRecipe(rawRecipe)};if(recipe.kind!=='workflow'||recipe.minimaxProfile!=='h3'||!recipe.workflowJson)throw userError('请选择保存了 H3 API 整图的 RunningHub 工作流');
 const h3=compileMinimaxH3({...input,engine:'runninghub'},recipe.workflowJson,{...options,referenceAllowed:supportsMinimaxRhAsset});if(h3.overrides[0].value.length>20000)throw userError('RunningHub H3 当前提示词最多20000字');
 const counts={image:0,video:0,audio:0},inputs=[],used=new Set(),assigned=new Set(),mediaFields=[];
 for(const b of h3.bindings){const kind={LoadImage:'image',LoadVideo:'video',LoadAudio:'audio'}[h3.graph[b.nodeId].class_type],slot=slotLoader(recipe.workflowJson,h3.contract.referenceNodeId,kind,counts[kind]++),key=slot.nodeId+':'+slot.fieldName;if(used.has(key))throw userError('H3 参考槽位共用素材字段，不能传入独立参考');used.add(key);assigned.add(slot.key);
  mediaFields.push({...slot,type:kind,label:`H3 ${kind} ${counts[kind]}`,fieldValue:'',source:b.assetId?'asset':'value',...(b.assetId?{assetId:b.assetId}:{})});if(b.sourceNodeId)inputs.push({nodeId:slot.nodeId,fieldName:slot.fieldName,sourceNodeId:b.sourceNodeId,...(b.sourceIndex!==undefined?{sourceIndex:b.sourceIndex}:{})});
 }
 const missing=[];for(const kind of Object.keys(minimaxLimits))for(let i=0;i<minimaxLimits[kind];i++){const key=`ref_${kind}s.ref_${kind}_${i}`;if(!Object.hasOwn(recipe.workflowJson[h3.contract.referenceNodeId].inputs,key)||assigned.has(key))continue;const slot=slotLoader(recipe.workflowJson,h3.contract.referenceNodeId,kind,i);if(recipe.fields.some(f=>f.nodeId===slot.nodeId&&f.fieldName===slot.fieldName&&f.required===true))throw userError('H3 RunningHub 缺少必选参考素材');missing.push(key);}
 const pruned=pruneRhReferenceBranches(recipe.workflowJson,h3.contract.referenceNodeId,missing),managed=new Set(h3.overrides.map(f=>f.nodeId+':'+f.name)),allSlots=new Set();
 for(const kind of Object.keys(minimaxLimits))for(let i=0;i<minimaxLimits[kind];i++){const key=`ref_${kind}s.ref_${kind}_${i}`;if(Object.hasOwn(recipe.workflowJson[h3.contract.referenceNodeId].inputs,key)){const f=slotLoader(recipe.workflowJson,h3.contract.referenceNodeId,kind,i);allSlots.add(f.nodeId+':'+f.fieldName);}}
 const kept=recipe.fields.filter(f=>!managed.has(f.nodeId+':'+f.fieldName)&&!allSlots.has(f.nodeId+':'+f.fieldName)&&!pruned.removed.includes(f.nodeId));
 const fields=[...kept,...h3.overrides.map(f=>({nodeId:f.nodeId,fieldName:f.name,fieldValue:f.value,type:typeof f.value==='number'?'number':'text',source:'value',label:'H3 '+f.name})),...mediaFields];
 const workflowJson=applyRhWorkflowFields(pruned.graph,fields),compiled={...recipe,fields,workflowJson};Object.assign(compiled,normalizeCloudRecipe(compiled));
 return {recipe:compiled,inputs,timeline:h3.timeline,segment:h3.segment,contract:h3.contract,removed:pruned.removed,sendAssets:mediaFields.length>0};
}
