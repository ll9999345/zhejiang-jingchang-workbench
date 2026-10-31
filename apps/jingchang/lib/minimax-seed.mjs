import {randomInt} from 'node:crypto';
import {normalizeMinimaxTimeline,selectedMinimaxSegment,minimaxParameters,minimaxGraphContract} from '../public/minimax-h3-core.js';
import {userError} from './workspace.mjs';

export const MINIMAX_RANDOM_SEED_MAX=4294967295;
export function minimaxRandomMode(input){return selectedMinimaxSegment(normalizeMinimaxTimeline(input)).seedMode==='random';}
// Draw only when admitting a new request. A saved seed reuses the original
// choice after interruption; neither planning nor polling draws again.
export function materializeMinimaxSeed(input,{seed,draw=()=>randomInt(MINIMAX_RANDOM_SEED_MAX)}={}){
 const timeline=normalizeMinimaxTimeline(input),segment=selectedMinimaxSegment(timeline);
 if(segment.seedMode!=='random')return{timeline,record:null};
 const value=seed??draw();
 if(!Number.isSafeInteger(value)||value<0||value>=MINIMAX_RANDOM_SEED_MAX)throw userError('H3 随机种子记录无效');
 segment.seed=value;delete segment.seedMode;
 return{timeline,record:{version:1,mode:'random',segmentId:segment.id,seed:value}};
}
export function minimaxSubmittedParameters(graph,referenceNodeId=''){
 const c=minimaxGraphContract(graph,referenceNodeId),get=f=>graph[f.nodeId].inputs[f.name],ratio=String(get(c.ratio)).match(/\d+:\d+/)?.[0];
 return minimaxParameters({prompt:get(c.prompt),duration:get(c.duration),aspectRatio:ratio,megapixels:get(c.megapixels),seed:get(c.seed)});
}
