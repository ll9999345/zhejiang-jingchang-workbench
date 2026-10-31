import {assertNoCredentials,safeId,userError} from './workspace.mjs';
import {validateNativeUrls} from '../public/native-canvas-core.js';
const plain=x=>x&&typeof x==='object'&&!Array.isArray(x);
export const rhWorkflowLink=value=>Array.isArray(value)&&value.length===2&&['string','number'].includes(typeof value[0])&&Number.isSafeInteger(value[1])&&value[1]>=0;
function guard(value,depth=0){
 if(depth>30)throw userError('RunningHub 工作流嵌套过深');
 if(value===null||typeof value==='boolean')return;
 if(typeof value==='number'){if(!Number.isFinite(value))throw userError('RunningHub 工作流数字无效');return;}
 if(typeof value==='string'){if(value.length>100000)throw userError('RunningHub 工作流字段过长');return;}
 if(!value||typeof value!=='object')throw userError('RunningHub 工作流包含非 JSON 字段');
 for(const [key,child]of Object.entries(value)){if(['__proto__','constructor','prototype'].includes(key))throw userError('RunningHub 工作流字段无效');guard(child,depth+1);}
}
export function normalizeRhWorkflow(input){
 if(!plain(input)||Object.keys(input).length<1||Object.keys(input).length>1000)throw userError('RunningHub API 工作流须包含1–1000个节点');
 guard(input);assertNoCredentials(input);try{validateNativeUrls(input);}catch(e){throw userError(e.message);}if(Buffer.byteLength(JSON.stringify(input))>2*1024*1024)throw userError('RunningHub API 工作流最多2MiB');
 const graph=structuredClone(input);
 for(const [id,node]of Object.entries(graph)){
  if(!safeId(id)||!plain(node)||typeof node.class_type!=='string'||!node.class_type.trim()||node.class_type.length>200||!plain(node.inputs)||Object.keys(node.inputs).length>200)throw userError('RunningHub 工作流节点或 inputs 无效');
  for(const [name,value]of Object.entries(node.inputs)){if(!/^[-\w. ]{1,100}$/.test(name))throw userError('RunningHub 工作流输入名无效');if(rhWorkflowLink(value)&&!Object.hasOwn(graph,String(value[0])))throw userError('RunningHub 工作流连线指向不存在的节点');}
 }
 return graph;
}
export function applyRhWorkflowFields(input,fields){
 const graph=normalizeRhWorkflow(input);
 for(const f of fields){const node=graph[f.nodeId];if(!node||!Object.hasOwn(node.inputs,f.fieldName)||rhWorkflowLink(node.inputs[f.fieldName]))throw userError('RunningHub 整图字段须指向现有普通输入，不能替换连线');node.inputs[f.fieldName]=f.fieldValue;}
 return normalizeRhWorkflow(graph);
}
// Remove only private ancestors of disconnected H3 reference slots. Shared
// branches remain when another output or model input still depends on them.
export function pruneRhReferenceBranches(input,referenceNodeId,keys){
 const graph=normalizeRhWorkflow(input),ref=graph[referenceNodeId];if(!ref)throw userError('H3 参考节点不存在');const candidates=new Set();
 function collect(id){id=String(id);if(candidates.has(id))return;candidates.add(id);for(const v of Object.values(graph[id]?.inputs||{}))if(rhWorkflowLink(v))collect(v[0]);}
 for(const key of keys){const v=ref.inputs[key];if(rhWorkflowLink(v))collect(v[0]);delete ref.inputs[key];}
 const needed=new Set();function keep(id){id=String(id);if(needed.has(id))return;needed.add(id);for(const v of Object.values(graph[id]?.inputs||{}))if(rhWorkflowLink(v))keep(v[0]);}
 for(const [id,n]of Object.entries(graph))if(!candidates.has(id))for(const v of Object.values(n.inputs))if(rhWorkflowLink(v))keep(v[0]);
 const removed=[...candidates].filter(id=>!needed.has(id));for(const id of removed)delete graph[id];return {graph:normalizeRhWorkflow(graph),removed};
}
