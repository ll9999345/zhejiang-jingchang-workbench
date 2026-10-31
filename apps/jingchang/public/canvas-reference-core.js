import {ltxReferences} from './ltx-director-core.js';
import {minimaxReferences,minimaxTimelineOf,minimaxAssetIds} from './minimax-h3-core.js';
export function canvasNodeReferences(node){
 const p=node.params||{},bindings=[p.imageBinding,p.llmBinding,p.studioBinding];
 return [
  ...(p.workflowBinding?.imageSources||[]).map(value=>({value,key:'sourceNodeId'})),
  ...ltxReferences(p.workflowBinding?.ltxDirector).map(value=>({value,key:'sourceNodeId'})),
  ...minimaxReferences(minimaxTimelineOf(node)).map(value=>({value,key:'sourceNodeId'})),
  ...(p.cloudBinding?.inputs||[]).map(value=>({value,key:'sourceNodeId'})),
  ...bindings.flatMap(b=>(b?.referenceSources||[]).map(value=>({value,key:'sourceNodeId'}))),
  ...(p.nativeCanvas?.inputOrder||[]).map(value=>({value,key:'sourceNodeId'})),
  ...(p.nativeCanvas?.members||[]).map(value=>({value,key:'sourceNodeId'})),
  ...(p.nativeMediaMap?[{value:p.nativeMediaMap,key:'loopId'},...p.nativeMediaMap.fields.flatMap(field=>[{value:field,key:'sourceNodeId'},...field.rounds.map(r=>({value:r.selection,key:'sourceNodeId'}))])]:[]),
  ...(p.loop?.fieldValues||[]).map(value=>({value,key:'targetNodeId'}))
 ];
}
export function canvasNodeAssetIds(node){
 const p=node.params||{},ids=[node.assetId,...(p.promptAssetIds||[]),...(p.nativeCanvas?.resources||[]).map(r=>r.assetId),...(p.nativeCanvas?.mediaAssetIds||[]),...minimaxAssetIds(minimaxTimelineOf(node)),...canvasNodeReferences(node).map(r=>r.value.assetId)];return [...new Set(ids.filter(Boolean))];
}
