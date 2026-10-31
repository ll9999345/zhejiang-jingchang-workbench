const groups=new Set(['group','promptGroup','smart-group']);
const typeOf=node=>node?.params?.nativeCanvas?.node.type||node?.type;
export function nativeExecutionDependencies(project,id){
 const node=project.nodes.find(n=>n.id===id);if(!node)throw Object.assign(Error('执行依赖节点不存在'),{status:400});
 const members=groups.has(typeOf(node))?(node.params.nativeCanvas.members||[]).map(ref=>ref.sourceNodeId).filter(id=>{
  const member=project.nodes.find(n=>n.id===id),type=typeOf(member);
  return typeOf(node)==='smart-group'?type!=='smart-group':typeOf(node)==='group'?['image','prompt','text','script'].includes(type)||!member.params?.nativeCanvas&&['image','video','audio'].includes(member.type):true;
 }):[];
 return[...new Set([...project.edges.filter(e=>e.target===id).map(e=>e.source),...members])];
}
export function nativeExecutionAncestors(project,id){const found=new Set(),visit=id=>{for(const parent of nativeExecutionDependencies(project,id))if(!found.has(parent)){found.add(parent);visit(parent);}};visit(id);return found;}
