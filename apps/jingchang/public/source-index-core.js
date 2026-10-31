// Indices always address the full, ordered source, including mixed media.
export function sourceIndexFields(ref){
 if(ref.sourceIndex===undefined)return{};
 if(!ref.sourceNodeId||ref.assetId||ref.url||!Number.isSafeInteger(ref.sourceIndex)||ref.sourceIndex<0||ref.sourceIndex>999)throw Error('素材序号只可用于上游节点，须为0–999的整数');
 return{sourceIndex:ref.sourceIndex};
}
