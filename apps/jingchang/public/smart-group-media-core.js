const type=node=>node?.params?.nativeCanvas?.node?.type||node?.type;

// Smart Canvas keeps its own stored grid first. Its original smart-image
// members follow reading order with a 24-world-unit row tolerance. Existing
// Jingchang member types keep their original slots, including pending inputs;
// moving them behind static images could change an already confirmed range.
export function smartGroupMediaMembers(members){
 const seen=new Set(),valid=members.filter(node=>node&&type(node)!=='smart-group'&&!seen.has(node.id)&&seen.add(node.id));
 const original=valid.filter(node=>type(node)==='smart-image').slice().sort((a,b)=>Math.abs(a.y-b.y)>24?a.y-b.y:a.x-b.x);
 let index=0;return valid.map(node=>type(node)==='smart-image'?original[index++]:node);
}
