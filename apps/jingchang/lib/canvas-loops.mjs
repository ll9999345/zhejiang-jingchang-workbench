import {normalizeLoop,loopDescendants} from './loop-core.mjs';
import {comfyMediaField} from '../public/comfy-media.js';
import {comfyRandomFields} from './workflow-random.mjs';
import {userError} from './workspace.mjs';
import {applyMinimaxLoopValues,minimaxTimelineOf,normalizeMinimaxTimeline,selectedMinimaxSegment} from '../public/minimax-h3-core.js';
import {captureMinimaxResultTarget} from './minimax-h3.mjs';
export async function planCanvasLoops(project,singlePlan,getTemplate){
 const loops=project.nodes.filter(n=>n.type==='loop').map(node=>{let config;try{config=normalizeLoop(node.params?.loop);}catch(e){throw userError(e.message);}const descendants=loopDescendants(project,node.id);if(project.nodes.some(n=>n.type==='loop'&&descendants.has(n.id)))throw userError('暂不支持嵌套循环，请将循环链分开');const body=project.nodes.filter(n=>descendants.has(n.id)&&(n.params?.workflowBinding||n.params?.cloudBinding||n.params?.imageBinding||n.params?.llmBinding||n.params?.studioBinding)).map(n=>n.id);if(!body.length)throw userError('循环节点下游没有已绑定的生成节点');return{node,config,body};});
 if(!loops.length)return singlePlan(project);
 const templates=new Map(),owner=new Map();for(const loop of loops)for(const id of loop.body){if(owner.has(id))throw userError('一个生成节点不能同时属于两个循环，请分开循环的下游连线');owner.set(id,loop.node.id);}
 for(const loop of loops)for(const field of loop.config.fieldValues||[]){
  const target=project.nodes.find(n=>n.id===field.targetNodeId),binding=target?.params?.workflowBinding;
  if(field.kind==='minimax'){
   if(!loop.body.includes(field.targetNodeId)||target?.type!=='video'||!(binding?.minimaxH3||target.params?.cloudBinding?.minimaxH3))throw userError('H3 逐轮参数只能指向本循环内已绑定的 H3 视频时间轴');
   if(field.name==='seed'&&binding?.incrementSeeds)throw userError('显式指定每轮种子时，请关闭目标节点的递增种子');
   for(const value of field.values)try{applyMinimaxLoopValues(minimaxTimelineOf(target),{[field.name]:value});}catch(e){throw userError(e.message);}
   continue;
  }
  if(!loop.body.includes(field.targetNodeId)||!binding)throw userError('逐轮参数只能指向本循环内已绑定ComfyUI的生成节点');if(!Array.isArray(binding.overrides)||!Array.isArray(binding.imageSources))throw userError('节点工作流参数无效');const template=await getTemplate(binding.workflowId);templates.set(binding.workflowId,template);const n=template.workflow[field.nodeId],original=n?.inputs?.[field.name];if(!n||!Object.hasOwn(n.inputs||{},field.name)||!['string','number','boolean'].includes(typeof original)||comfyMediaField(n.class_type,field.name,template.fields?.find(f=>f.nodeId===field.nodeId&&f.name===field.name)))throw userError('逐轮参数不能指向媒体输入或计算连线');if(field.values.some(v=>typeof v!==typeof original))throw userError('逐轮参数的每个值须与原工作流字段类型一致');const matches=f=>f?.nodeId===field.nodeId&&f?.name===field.name;if(matches(binding.promptField)||matches(binding.promptBatch)||binding.imageSources?.some(matches))throw userError('逐轮参数与已有上游文字、列表或媒体映射冲突');if(binding.incrementSeeds&&['seed','noise_seed'].includes(field.name))throw userError('显式指定每轮种子时，请关闭目标节点的递增种子');
 }
 const variant=(loop,round)=>{
  const p=structuredClone(project);
  for(const l of loops){
   const index=l===loop?round:0,n=p.nodes.find(n=>n.id===l.node.id);n.text=[l.node.text,l.config.mode==='list'?l.config.values[index]:''].filter(Boolean).join('\n\n');
   const h3Values=new Map();
   for(const f of l.config.fieldValues||[]){
    if(f.kind==='minimax'){if(!h3Values.has(f.targetNodeId))h3Values.set(f.targetNodeId,{});h3Values.get(f.targetNodeId)[f.name]=f.values[index];continue;}
    const b=p.nodes.find(n=>n.id===f.targetNodeId).params.workflowBinding;b.overrides=b.overrides.filter(x=>x.nodeId!==f.nodeId||x.name!==f.name);b.overrides.push({nodeId:f.nodeId,name:f.name,value:f.values[index]});const active=comfyRandomFields(templates.get(b.workflowId),b.randomFields);if(active.some(x=>x.nodeId===f.nodeId&&x.name===f.name))b.randomFields=active.filter(x=>x.nodeId!==f.nodeId||x.name!==f.name).map(({nodeId,name})=>({nodeId,name}));
   }
   for(const [id,values]of h3Values){const target=p.nodes.find(n=>n.id===id),b=target.params.workflowBinding?.minimaxH3?target.params.workflowBinding:target.params.cloudBinding;b.minimaxH3=applyMinimaxLoopValues(b.minimaxH3,values);}
  }
  return p;
 };
 const base=await singlePlan(variant(null,0)),byId=new Map(base.map(s=>[s.nodeId,s])),units=new Map();
 for(const step of base){const key=owner.get(step.nodeId)||step.nodeId;if(!units.has(key))units.set(key,{key,dependencies:new Set(),steps:[]});units.get(key).steps.push(step);}
 for(const step of base){const key=owner.get(step.nodeId)||step.nodeId,ancestors=new Set(),walk=id=>{for(const e of project.edges.filter(e=>e.target===id))if(!ancestors.has(e.source)){ancestors.add(e.source);walk(e.source);}};walk(step.nodeId);for(const id of ancestors)if(byId.has(id)){const dependency=owner.get(id)||id;if(dependency!==key)units.get(key).dependencies.add(dependency);}}
 const ordered=[],visiting=new Set(),done=new Set();function visit(key){if(visiting.has(key))throw userError('循环与外部生成节点存在交叉依赖');if(done.has(key))return;visiting.add(key);for(const id of units.get(key).dependencies)visit(id);visiting.delete(key);done.add(key);ordered.push(units.get(key));}for(const key of units.keys())visit(key);
 const estimated=ordered.reduce((total,u)=>total+u.steps.reduce((n,s)=>n+s.count,0)*(loops.find(l=>l.node.id===u.key)?.config.count||1),0);if(estimated>64)throw userError('循环展开后整张画布最多64次生成');
 const expanded=[];for(const unit of ordered){const loop=loops.find(l=>l.node.id===unit.key);if(!loop){expanded.push(...unit.steps);continue;}
  const consumesPrompt=s=>s.minimaxH3? s.minimaxH3.autoUpstream&&!selectedMinimaxSegment(s.minimaxH3).prompt.trim():s.promptField||s.kind==='canvas-llm'&&s.llm.includeUpstream||s.kind==='image-api'&&s.image.includeUpstream||s.kind==='studio'&&s.studio.includeUpstream||s.inputs?.some(f=>f.useText);
  if(loop.config.mode==='list'&&!unit.steps.some(consumesPrompt))throw userError('列表循环内至少一个节点须绑定上游文字字段；H3 请开启上游输入并留空当前片段提示词');
  for(let round=0;round<loop.config.count;round++){
   const planned=round===0?base:await singlePlan(variant(loop,round),new Map(loop.body.map(id=>[id,round])));
   if(loop.config.mode==='list'&&!planned.filter(s=>loop.body.includes(s.nodeId)).some(consumesPrompt))throw userError('部分循环轮次没有接收列表文字；请检查 H3 逐轮提示词与上游输入');
   for(const [index,original] of unit.steps.entries()){
    const step=structuredClone(planned.find(s=>s.nodeId===original.nodeId));
    if(step.minimaxResultTarget){const source=project.nodes.find(n=>n.id===step.nodeId);step.minimaxResultTarget=captureMinimaxResultTarget(source,normalizeMinimaxTimeline(minimaxTimelineOf(source)),{project,parents:new Set(step.minimaxResultTarget.dependencies.map(d=>d.nodeId))});}
    Object.assign(step,{executionId:`loop-${loops.indexOf(loop)}-${round}-${index}`,loopId:loop.node.id,loopTitle:loop.node.title,roundIndex:round,roundCount:loop.config.count,loopFields:(loop.config.fieldValues||[]).filter(f=>f.targetNodeId===step.nodeId).map(f=>({...f.kind?{kind:f.kind}:{nodeId:f.nodeId},name:f.name,value:f.values[round]})),...(index===0?{roundStart:loop.body}:{})});expanded.push(step);
   }
  }
 }
 return expanded;
}
