import {userError} from './workspace.mjs';
// Explicit subsets refer to the original producer's output array, never to a
// freshly numbered loop slice or receiver view.
export function nativeProducerIndices(item){
 const count=item?.expectedCount;
 if(!Number.isSafeInteger(count)||count<1||count>64)throw userError('待生成素材数量无效');
 const indices=item.producerIndices??Array.from({length:count},(_,i)=>i);
 if(!Array.isArray(indices)||indices.length!==count||new Set(indices).size!==count||indices.some(i=>!Number.isSafeInteger(i)||i<0||i>63))throw userError('待生成素材原始序号无效');
 return [...indices];
}
export function nativeProducerSubset(item,indices){
 const out={...item,expectedCount:indices.length};delete out.producerIndices;
 if(indices.some((i,index)=>i!==index))out.producerIndices=[...indices];
 nativeProducerIndices(out);return out;
}
export function nativeProducerSlots(items){
 return items.flatMap(item=>item.pending?nativeProducerIndices(item).map(index=>nativeProducerSubset(item,[index])):[item]);
}
