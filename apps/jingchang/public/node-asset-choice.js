export function acceptsNodeAsset(node,asset){
 const type=String(asset?.type||'');
 if(['image','character'].includes(node?.type))return type.startsWith('image/');
 if(node?.type==='scene')return type.startsWith('image/')||type==='model/gltf-binary';
 if(node?.type==='video')return type.startsWith('video/');
 if(node?.type==='audio')return type.startsWith('audio/');
 return !!asset&&type!=='application/x-safetensors';
}
export function nodeAssetChoices(node,project,library=[]){
 const assets=new Map();
 for(const asset of [...(project?.assets||[]),...library])if(acceptsNodeAsset(node,asset)&&!assets.has(asset.id))assets.set(asset.id,asset);
 // Keep a legacy binding visible, even if its type no longer matches the node.
 const bound=(project?.assets||[]).find(a=>a.id===node?.assetId);
 if(bound&&!assets.has(bound.id))assets.set(bound.id,bound);
 return [...assets.values()];
}
export function nodeAssetHint(node,project,library=[]){
 const choices=nodeAssetChoices(node,project,library),bound=choices.find(a=>a.id===node?.assetId);
 if(bound)return '已关联 '+bound.name+'；点击缩略图可查看原图。';
 if(!['image','character','scene'].includes(node?.type))return choices.length?'选择现有素材，或导入本机文件。':'暂无可关联素材，先导入或生成。';
 const ancestors=new Set(),pending=(project?.edges||[]).filter(e=>e.target===node.id).map(e=>e.source);
 while(pending.length){const id=pending.pop();if(id===node.id||ancestors.has(id))continue;ancestors.add(id);for(const edge of project?.edges||[])if(edge.target===id)pending.push(edge.source);}
 const upstream=(project?.nodes||[]).filter(n=>ancestors.has(n.id));
 const textOnly=upstream.length&&upstream.every(n=>['text','script','character','scene'].includes(n.type)&&!(project.assets||[]).some(a=>a.id===n.assetId&&/^(image|video|audio)\//.test(a.type)));
 return (choices.length?'当前节点暂无图片，可选择已有图片，或导入、生成。':'暂无图片，导入或生成。')+(textOnly?' 上游只有文字，会作为提示词，不是图片素材。':'')+' 选择模型只设置生成方式。';
}
export function canAutoBindImageResult(job,project){
 if(job?.kind!=='image-api'||job.status!=='completed'||job.applied||job.projectId!==project?.id||!job.target)return false;
 const node=(project.nodes||[]).find(n=>n.id===job.target.id);
 return !!node&&node.assetId===job.target.assetId&&node.text===job.target.text&&(!job.input?.model||node.params?.model===job.input.model)&&(!job.input?.platformId||node.params?.apiPlatformId===job.input.platformId);
}
