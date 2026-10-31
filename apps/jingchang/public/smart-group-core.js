import {syncNativeConnections} from './native-canvas-core.js';
import {smartDragTarget,canSmartDragConnect,smartLoopInsertion,connectSmartDragInput,insertSmartDragLoop} from './smart-drag-connections.js';

export const smartGroupType=n=>n?.params?.nativeCanvas?.node?.type||n?.type;
export const isSmartGroup=n=>smartGroupType(n)==='smart-group';
export function validateSmartGroupEditReceipt(project){
 const v=project?.settings?.smartGroupEditReceipt;if(v===undefined)return;
 const safe=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(id),hex=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s),keys=['version','requestId','requestHash','planHash','mode','revision','groupId','nodeIds'];
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k))||v.version!==1||!safe(v.requestId)||!safe(v.groupId)||!hex(v.requestHash)||!hex(v.planHash)||!['create','absorb','release','release-item','detach','arrange','move','resize','drag','thumb-drag'].includes(v.mode)||!Number.isSafeInteger(v.revision)||v.revision<0||!Array.isArray(v.nodeIds)||v.nodeIds.length>1500||v.nodeIds.some(id=>!safe(id))||new Set(v.nodeIds).size!==v.nodeIds.length)throw Error('智能组修改回执无效');
}
const raw=n=>n.params?.nativeCanvas?.node||n;
const reading=(a,b)=>Math.abs(a.y-b.y)>24?a.y-b.y:a.x-b.x;
export function smartGroupMembers(project,group){const seen=new Set([group.id]);return(group.params?.nativeCanvas?.members||[]).map(r=>project.nodes.find(n=>n.id===r.sourceNodeId)).filter(n=>n&&!isSmartGroup(n)&&!seen.has(n.id)&&seen.add(n.id));}
export function smartGroupDragTarget(project,primaryId,movedIds,rects={}){
 const primary=project.nodes.find(n=>n.id===primaryId);if(!primary)return null;
 const size=isSmartGroup(primary)?smartGroupLayout(project,primary):sizeOf(primary,rects),cx=primary.x+size.width/2,cy=primary.y+size.height/2,excluded=new Set([primaryId,...movedIds]);
 return project.nodes.filter(n=>isSmartGroup(n)&&!excluded.has(n.id)).filter(n=>{const r=smartGroupLayout(project,n);return cx>=n.x&&cx<=n.x+r.width&&cy>=n.y&&cy<=n.y+r.height;}).at(-1)||null;
}
const compact=n=>['smart-prompt','smart-loop'].includes(smartGroupType(n));
const cleanImage=image=>{const out={...structuredClone(image)};for(const key of ['runPrompt','runModelPrompt','runSettings','sourceNodeId','runAt','promptDraftHtml','promptDraftText'])delete out[key];return out;};
const sizeOf=(n,rects={})=>({width:rects[n.id]?.width||raw(n).w||288,height:rects[n.id]?.height||raw(n).h||270});
const dimensions=(n,w,h)=>{const v=raw(n);if(v===n){n.w=w;n.h=h;}else{v.w=w;v.h=h;}};
const position=(n,x,y)=>{n.x=x;n.y=y;if(raw(n)!==n){raw(n).x=x;raw(n).y=y;}};
const mediaSize=image=>{const width=Number(image?.natural_w||image?.width||image?.w||image?.layout_w||image?.preview_w||0),height=Number(image?.natural_h||image?.height||image?.h||image?.layout_h||image?.preview_h||0);return width>0&&height>0?{width,height}:{width:0,height:0};};
export function smartImageNaturalSize(item,scale=2){const natural=mediaSize(item),audio=item?.kind==='audio'||/\.(mp3|wav|m4a|aac|ogg|flac)(\?|$)/i.test(String(item?.url||''));if(audio)return{width:Math.round(288*scale),height:Math.round(150*scale)};if(natural.width){const fit=Math.min(260*scale/natural.width,220*scale/natural.height);return{width:Math.max(72,Math.round(natural.width*fit)),height:Math.max(72,Math.round(natural.height*fit))};}return{width:Math.round(260*scale),height:Math.round(180*scale)};}
export function smartGroupMediaEntries(project,group){
 const result=[],assets=new Map(project.assets.map(a=>[a.id,a]));
 for(const node of [group,...smartGroupMembers(project,group).filter(n=>smartGroupType(n)==='smart-image').sort(reading)]){
  for(const [index,item]of storedImages(project,node).entries()){
   const url=typeof item==='string'?item:item?.url;if(!url)continue;
   const mapped=node.params?.nativeCanvas?.resources.find(r=>r.url===url||r.archive===url||'./'+r.archive===url),asset=assets.get(mapped?.assetId)||project.assets.find(a=>url==='/media/'+a.id);
   result.push({sourceNodeId:node.id,index,item:typeof item==='string'?{url:item}:item,...(asset?{assetId:asset.id,asset}:{} )});
  }
 }
 return result;
}
function fittedGrid(count,w,h,maxRows){
 let best;
 for(let cols=1;cols<=count;cols++){
  const rows=Math.ceil(count/cols),visibleRows=Math.min(Math.max(1,maxRows),rows),availableW=w-(cols-1)*8,availableH=h-(visibleRows-1)*8;if(availableW<=0||availableH<=0)continue;
  const candidate=Math.floor(Math.min(availableW/cols,availableH/visibleRows)),thumb=Math.max(28,Math.min(100000,candidate)),score=[candidate>=28?1:0,thumb,thumb>=100000?cols:0,-(Math.max(0,w-cols*thumb-(cols-1)*8)+Math.max(0,h-visibleRows*thumb-(visibleRows-1)*8)*.35),-rows];
  if(!best||score.some((v,i)=>v!==best.score[i]&&score.slice(0,i).every((x,j)=>x===best.score[j])&&v>best.score[i]))best={cols,rows,visibleRows,thumb,score};
 }
 return best||{cols:Math.min(count,2),rows:Math.ceil(count/Math.min(count,2)),visibleRows:Math.min(4,Math.ceil(count/Math.min(count,2))),thumb:28};
}
export function smartGroupLayout(project,group){
 const images=smartGroupMediaEntries(project,group),members=smartGroupMembers(project,group).filter(compact),v=raw(group),count=images.length+members.length,explicit=Number(v.w)>=150&&Number(v.h)>=130;
 if(!images.length)return{width:Number(v.w)>=150?Math.round(v.w):340,height:Number(v.h)===220||!Number.isFinite(Number(v.h))?286:Math.max(130,Math.round(v.h)),cols:1,rows:1,thumb:96,images,members};
 const scale=images.length>1&&!Number.isFinite(Number(v.scale))?.8:Number.isFinite(Number(v.scale))&&Number(v.scale)>0?Number(v.scale):2,maxRows=members.length?count:4;
 if(count===1){
  if(explicit)return{width:Math.round(v.w),height:Math.round(v.h),cols:1,rows:1,thumb:Math.round(96*scale),images,members};
  const item=images[0].item,natural=mediaSize(item),audio=item.kind==='audio'||/\.(mp3|wav|m4a|aac|ogg|flac)(\?|$)/i.test(String(item.url||'')),fit=natural.width?Math.min(260*scale/natural.width,220*scale/natural.height):0;
  const width=fit?Math.max(72,Math.round(natural.width*fit)):Math.round((audio?288:260)*scale),height=fit?Math.max(72,Math.round(natural.height*fit)):Math.round((audio?150:180)*scale);
  return{width:Math.max(150,width+32),height:Math.max(130,height+60),cols:1,rows:1,thumb:Math.round(96*scale),images,members};
 }
 if(explicit)return{...fittedGrid(count,Math.max(72,v.w-32),Math.max(56,v.h-60),maxRows),width:Math.round(v.w),height:Math.round(v.h),images,members};
 const thumb=Math.round(224*scale),cols=Math.min(4,Math.max(2,Math.ceil(Math.sqrt(count)))),rows=Math.ceil(count/cols),visibleRows=Math.min(maxRows,rows);
 return{width:Math.max(150,cols*thumb+(cols-1)*8+32),height:Math.max(130,visibleRows*(thumb+8)-8+60),cols,rows,visibleRows,thumb,images,members};
}
export function arrangeSmartGroup(project,group,rects={}){
 const layout=smartGroupLayout(project,group),v=raw(group);
 if(layout.images.length){
  const thumb=Math.max(28,Math.round(layout.thumb)),gridW=layout.cols*thumb+Math.max(0,layout.cols-1)*8,originX=group.x+16+Math.max(0,Math.round((layout.width-32-gridW)/2));dimensions(group,layout.width,layout.height);
  [...layout.members].sort(reading).forEach((member,i)=>{const cell=layout.images.length+i;position(member,Math.round(originX+(cell%layout.cols)*(thumb+8)),Math.round(group.y+44+Math.floor(cell/layout.cols)*(thumb+8)));dimensions(member,thumb,thumb);raw(member).scale=1;});
 }else{
  const members=smartGroupMembers(project,group).sort(reading);if(!members.length)return;
  const cols=Math.max(1,Math.min(members.length,Math.round(Math.sqrt(members.length))||1)),rows=Math.ceil(members.length/cols),cw=Array(cols).fill(0),rh=Array(rows).fill(0),sizes=members.map(n=>{if(smartGroupType(n)==='smart-image'){delete raw(n).w;delete raw(n).h;}const s=sizeOf(n,rects);return{n,w:Math.max(40,s.width),h:Math.max(40,s.height)};});
  sizes.forEach((s,i)=>{cw[i%cols]=Math.max(cw[i%cols],s.w);rh[Math.floor(i/cols)]=Math.max(rh[Math.floor(i/cols)],s.h);});
  sizes.forEach((s,i)=>{const c=i%cols,row=Math.floor(i/cols);position(s.n,Math.round(group.x+18+cw.slice(0,c).reduce((a,b)=>a+b+16,0)+(cw[c]-s.w)/2),Math.round(group.y+62+rh.slice(0,row).reduce((a,b)=>a+b+16,0)+(rh[row]-s.h)/2));});
  dimensions(group,Math.max(150,cw.reduce((a,b)=>a+b,0)+(cols-1)*16+36),Math.max(130,rh.reduce((a,b)=>a+b,0)+(rows-1)*16+80));
 }
 if(v._memberZoom!==undefined)v._memberZoom=1;
}
function setMembers(project,group,ids){const native=group.params.nativeCanvas,nodes=new Map(project.nodes.map(n=>[n.id,n]));native.members=ids.filter(id=>nodes.has(id)).map(sourceNodeId=>({sourceNodeId}));native.node.items=native.members.map(r=>raw(nodes.get(r.sourceNodeId)).id);}
const resourceAliases=r=>[r.url,r.archive,'./'+r.archive];
function addResources(target,source){
 const refs=target.params.nativeCanvas.resources,aliases=new Map();
 for(const entry of source.params?.nativeCanvas?.resources||[]){
  let next=structuredClone(entry);
  const conflicts=value=>refs.some(r=>r.assetId!==entry.assetId&&resourceAliases(r).includes(value));
  if(resourceAliases(entry).some(conflicts)){
   let suffix=0;do{const tail=entry.assetId+(suffix?'-'+suffix:'');next={...next,url:'/media/'+tail,archive:'resources/'+tail};suffix++;}while(resourceAliases(next).some(conflicts));
   for(const alias of resourceAliases(entry))aliases.set(alias,next.url);
  }
  if(!refs.some(r=>r.url===next.url&&r.archive===next.archive&&r.assetId===next.assetId))refs.push(next);
 }
 target.params.nativeCanvas.missingResources=[...new Set([...target.params.nativeCanvas.missingResources,...(source.params?.nativeCanvas?.missingResources||[])])];
 if(source.params?.nativeCanvas?.header&&!target.params.nativeCanvas.header)target.params.nativeCanvas.header=structuredClone(source.params.nativeCanvas.header);
 return aliases;
}
function updateOwnMedia(project,group){const native=group.params.nativeCanvas;native.mediaAssetIds=[...new Set((native.node.images||[]).flatMap(item=>{const url=typeof item==='string'?item:item?.url,ref=native.resources.find(r=>r.url===url||r.archive===url||'./'+r.archive===url);return ref?[ref.assetId]:[];}))];}
function removeNode(project,node,target=null){
 if(target)addResources(target,node);else if(node.params?.nativeCanvas?.header||node.params?.nativeCanvas?.resources.length){const keeper=project.nodes.find(n=>n!==node&&n.params?.nativeCanvas);if(keeper)addResources(keeper,node);}
 project.nodes=project.nodes.filter(n=>n.id!==node.id);
 for(const g of project.nodes.filter(n=>n.params?.nativeCanvas&&['group','promptGroup','smart-group'].includes(smartGroupType(n)))){const native=g.params.nativeCanvas;native.members=native.members.filter(r=>r.sourceNodeId!==node.id);if(Array.isArray(native.node.items))native.node.items=native.members.map(r=>raw(project.nodes.find(n=>n.id===r.sourceNodeId)).id);}
 project.groups=(project.groups||[]).map(g=>({...g,nodeIds:g.nodeIds.filter(id=>id!==node.id)})).filter(g=>g.nodeIds.length);
}
function reroute(project,from,to){
 const sourceIds=new Map(project.nodes.map(n=>[n.id,raw(n).id]));
 project.edges=project.edges.map(edge=>{const next={...edge,source:edge.source===from?to:edge.source,target:edge.target===from?to:edge.target};if(edge.nativeCanvasConnection)next.nativeCanvasConnection={...edge.nativeCanvasConnection,from:sourceIds.get(next.source),to:sourceIds.get(next.target)};return next;}).filter((e,i,all)=>e.source!==e.target&&all.findIndex(x=>x.source===e.source&&x.target===e.target&&(x.nativeCanvasConnection?.kind||'flow')===(e.nativeCanvasConnection?.kind||'flow'))===i);
 for(const n of project.nodes){const v=raw(n);if(Array.isArray(v.inputNodeIds))v.inputNodeIds=[...new Set(v.inputNodeIds.map(id=>String(id)===String(sourceIds.get(from))?sourceIds.get(to):id).filter(id=>String(id)!==String(v.id)))];const native=n.params?.nativeCanvas;if(native){native.inputOrder=(native.inputOrder||[]).map(r=>({...r,sourceNodeId:r.sourceNodeId===from?to:r.sourceNodeId})).filter(r=>r.sourceNodeId!==n.id);if(Array.isArray(v.inputs))v.inputs=v.inputs.map(id=>String(id)===String(sourceIds.get(from))?sourceIds.get(to):id);}}
}
function storedImages(project,node){
 if(Array.isArray(raw(node).images)&&raw(node).images.length)return raw(node).images.map(image=>typeof image==='string'?{url:image}:structuredClone(image));
 if(node.params?.nativeCanvas?.mediaAssetIds.length)return node.params.nativeCanvas.mediaAssetIds.map(id=>{const asset=project.assets.find(a=>a.id===id),ref=node.params.nativeCanvas.resources.find(r=>r.assetId===id);return{url:ref?.url||'/media/'+id,name:asset?.name||id,type:asset?.type||''};});
 if(node.params?.nativeCanvas)return [];
 const asset=project.assets.find(a=>a.id===node.assetId);return asset?[{url:'/media/'+asset.id,name:asset.name,type:asset.type}]:[];
}
function ensureCommonResources(project,group,child,images){
 const aliases=addResources(group,child);
 images=images.map(image=>aliases.has(image.url)?{...image,url:aliases.get(image.url)}:image);
 for(const image of images){const a=project.assets.find(a=>image?.url==='/media/'+a.id);if(a&&!group.params.nativeCanvas.resources.some(r=>r.url===image.url&&r.assetId===a.id))group.params.nativeCanvas.resources.push({url:image.url,archive:'resources/'+a.id,assetId:a.id});}
 return images;
}
function admit(project,group,child,effects){
 if(!child||child===group)return;
 const v=raw(group),zoom=Number(v._memberZoom)>0?Number(v._memberZoom):1;
 if(isSmartGroup(child)){
  const images=storedImages(project,child).map(cleanImage),current=ensureCommonResources(project,group,group,storedImages(project,group));v.images=[...current,...ensureCommonResources(project,group,child,images)];if(images.length){delete v.w;delete v.h;}
  const ids=smartGroupMembers(project,child).map(n=>n.id).filter(id=>id!==group.id),prior=group.params.nativeCanvas.members.map(r=>r.sourceNodeId),existing=new Set(prior);setMembers(project,group,[...prior,...ids.filter(id=>!existing.has(id))]);for(const id of ids.filter(id=>!existing.has(id))){const m=project.nodes.find(n=>n.id===id),s=sizeOf(m);if(zoom!==1)dimensions(m,Math.max(40,Math.round(s.width*zoom)),Math.max(40,Math.round(s.height*zoom)));}
  reroute(project,child.id,group.id);removeNode(project,child,group);effects.removedNodeIds.push(child.id);effects.mergedGroupIds.push(child.id);return;
 }
 if(smartGroupType(child)==='smart-image'||!child.params?.nativeCanvas&&['image','video','audio'].includes(child.type)){
  const images=storedImages(project,child).map(cleanImage);if(!images.length){effects.unchangedNodeIds.push(child.id);return;}const current=ensureCommonResources(project,group,group,storedImages(project,group));v.images=[...current,...ensureCommonResources(project,group,child,images)];delete v.w;delete v.h;reroute(project,child.id,group.id);removeNode(project,child,group);effects.removedNodeIds.push(child.id);effects.absorbedNodeIds.push(child.id);return;
 }
 if(group.params.nativeCanvas.members.some(r=>r.sourceNodeId===child.id))return;
 setMembers(project,group,[...group.params.nativeCanvas.members.map(r=>r.sourceNodeId),child.id]);if(zoom!==1){const s=sizeOf(child);dimensions(child,Math.max(40,Math.round(s.width*zoom)),Math.max(40,Math.round(s.height*zoom)));}effects.addedMemberIds.push(child.id);
}
export function resizeSmartGroup(project,group,request,rects={}){
   const v=raw(group),s=smartGroupLayout(project,group),members=smartGroupMembers(project,group);if(s.images.length){dimensions(group,Math.max(150,Math.round(request.width)),Math.max(130,Math.round(request.height)));if(members.some(compact))arrangeSmartGroup(project,group,rects);}else{const start=Number(v._memberZoom)>0?Number(v._memberZoom):1,fit=members.length?Math.max(1,...members.map(n=>n.x+sizeOf(n,rects).width-group.x+16)):s.width,desired=start*request.width/fit,z=Math.max(.2,Math.min(4,desired)),ratio=z/start;v._memberZoom=z;let right=group.x,bottom=group.y;for(const n of members){const d=sizeOf(n,rects);position(n,group.x+(n.x-group.x)*ratio,group.y+(n.y-group.y)*ratio);dimensions(n,Math.max(40,Math.round(d.width*ratio)),Math.max(40,Math.round(d.height*ratio)));if(smartGroupType(n)==='smart-image')raw(n).scale=1;right=Math.max(right,n.x+raw(n).w);bottom=Math.max(bottom,n.y+raw(n).h);}dimensions(group,desired>4||!members.length?Math.max(150,Math.round(request.width)):Math.max(150,Math.round(right-group.x+16)),desired>4||!members.length?Math.max(130,Math.round(request.height)):Math.max(130,Math.round(bottom-group.y+16)));v.scale=1;}
}
export function editSmartGroupStructure(project,request,{idFactory,rects={},settle=true}={}){
 const next=structuredClone(project),effects={removedNodeIds:[],createdNodeIds:[],absorbedNodeIds:[],mergedGroupIds:[],addedMemberIds:[],releasedMemberIds:[],unchangedNodeIds:[]};let group=next.nodes.find(n=>n.id===request.groupId),selection=[];
 const newNode=(type,x,y,title,images=[])=>{const id=idFactory(),native={version:1,format:'infinite-smart-canvas-workflow',node:{id,type,x,y,title,images,items:[]},adaptation:'reference',inputOrder:[],resources:[],missingResources:[],members:[],mediaAssetIds:[],connectedGroup:false,connectedOutput:false,outgoingMedia:false},n={id,type:type==='smart-group'?'scene':'image',x,y,title,text:'',assetId:null,params:{nativeCanvas:native}};next.nodes.push(n);effects.createdNodeIds.push(id);return n;};
 if(request.mode==='thumb-drag'){
  if(!isSmartGroup(group))throw Error('请选择智能分组');
  const entry=smartGroupMediaEntries(next,group).find(r=>r.sourceNodeId===group.id&&r.index===request.index);if(!entry||entry.assetId!==request.assetId)throw Error('组内素材身份已变化，请重新拖动');
  const images=storedImages(next,group),image=cleanImage(images[request.index]),origin=group;if(!mediaSize(image).width&&request.naturalSize){image.natural_w=request.naturalSize.width;image.natural_h=request.naturalSize.height;}if(image.kind===undefined&&/^(audio|video)\//.test(entry.asset?.type||''))image.kind=entry.asset.type.split('/')[0];const size=smartImageNaturalSize(image);
  raw(origin).images=images.filter((_,index)=>index!==request.index);updateOwnMedia(next,origin);arrangeSmartGroup(next,origin,rects);
  const child=newNode('smart-image',request.x-Math.round(size.width/2),request.y-Math.round(size.height/2),'Image',[image]);raw(child).scale=2;dimensions(child,size.width,size.height);addResources(child,origin);delete child.params.nativeCanvas.header;updateOwnMedia(next,child);child.assetId=child.params.nativeCanvas.mediaAssetIds[0]||entry.assetId;child.params.nativeMediaVersion=2;
  const target=settle?smartGroupDragTarget(next,child.id,[child.id],rects):null;
  if(target){admit(next,target,child,effects);arrangeSmartGroup(next,target,rects);group=target;selection=[target.id];}else selection=[child.id];
 }else if(request.mode==='drag'){
  for(const item of request.positions){const n=next.nodes.find(n=>n.id===item.id);position(n,item.x,item.y);}
  const ids=request.positions.map(row=>row.id),target=smartGroupDragTarget(next,request.primaryId,ids,rects),primary=next.nodes.find(n=>n.id===request.primaryId),ctrl=request.ctrlDrag===true&&ids.length===1;
  const insertion=ctrl?smartLoopInsertion(next,primary.id,rects):null,auto=ctrl?smartDragTarget(next,primary.id,ids,request.pointer,rects):null;group=target||primary;
  if(insertion&&insertSmartDragLoop(next,primary.id,insertion,idFactory)){group=primary;selection=request.selectionIds||[primary.id];effects.connectionGesture={kind:'insert-loop',edgeId:insertion.edgeId};}
  else if(target){const list=ids.map(id=>next.nodes.find(n=>n.id===id));for(const child of list)admit(next,target,child,effects);if(effects.absorbedNodeIds.length||effects.mergedGroupIds.length||effects.addedMemberIds.length)arrangeSmartGroup(next,target,rects);selection=list.length===1&&next.nodes.some(n=>n.id===primary.id)?[primary.id]:[target.id];}
  else if(ctrl&&smartGroupType(primary)==='smart-image'&&auto&&smartGroupType(auto)==='smart-image'&&storedImages(next,auto).length>1&&storedImages(next,primary).length){
   const current=ensureCommonResources(next,auto,auto,storedImages(next,auto)).map(cleanImage),incoming=ensureCommonResources(next,auto,primary,storedImages(next,primary)).map(cleanImage);raw(auto).images=[...current,...incoming];auto.title=raw(auto).title='Group';if(!Number.isFinite(Number(raw(auto).scale))||Number(raw(auto).scale)===2)raw(auto).scale=.8;delete raw(auto).w;delete raw(auto).h;reroute(next,primary.id,auto.id);removeNode(next,primary,auto);updateOwnMedia(next,auto);effects.removedNodeIds.push(primary.id);effects.absorbedNodeIds.push(primary.id);effects.connectionGesture={kind:'merge-images',targetId:auto.id};group=auto;selection=[auto.id];
  }else if(ctrl&&canSmartDragConnect(primary,auto)&&connectSmartDragInput(next,primary,auto,idFactory)){
   for(const id of ids){const n=next.nodes.find(n=>n.id===id),origin=project.nodes.find(n=>n.id===id);position(n,origin.x,origin.y);}selection=[];effects.connectionGesture={kind:'connect',sourceId:primary.id,targetId:auto.id};
  }else selection=request.selectionIds||[primary.id];
  if(!target){for(const owner of next.nodes.filter(isSmartGroup)){const native=owner.params.nativeCanvas;if(native.members.some(row=>row.sourceNodeId===primary.id)){setMembers(next,owner,native.members.map(row=>row.sourceNodeId).filter(id=>id!==primary.id));effects.releasedMemberIds.push(primary.id);}}}
 }else if(request.mode==='create'){
  const members=request.nodeIds.map(id=>next.nodes.find(n=>n.id===id)).filter(n=>n&&!isSmartGroup(n));if(!members.length)throw Error('请选择要放入智能组的节点');const sizes=members.map(n=>({...sizeOf(n,rects),x:n.x,y:n.y})),x=Math.round(Math.min(...sizes.map(s=>s.x))-18),y=Math.round(Math.min(...sizes.map(s=>s.y))-44);group=newNode('smart-group',x,y,request.title||'智能分组');dimensions(group,Math.max(340,Math.round(Math.max(...sizes.map(s=>s.x+s.width))-x+18)),Math.max(220,Math.round(Math.max(...sizes.map(s=>s.y+s.height))-y+28)));for(const n of members)admit(next,group,n,effects);arrangeSmartGroup(next,group,rects);selection=[group.id];
 }else{
  if(!isSmartGroup(group))throw Error('请选择智能分组');
  if(request.mode==='absorb'){const list=request.nodeIds.map(id=>next.nodes.find(n=>n.id===id)).filter(n=>n&&n!==group);for(const child of list)admit(next,group,child,effects);if(effects.absorbedNodeIds.length||effects.mergedGroupIds.length||effects.addedMemberIds.length)arrangeSmartGroup(next,group,rects);selection=list.length===1&&next.nodes.some(n=>n.id===list[0].id)?[list[0].id]:[group.id];}
  else if(request.mode==='detach'){const selected=new Set(request.nodeIds),ids=smartGroupMembers(next,group).map(n=>n.id);effects.releasedMemberIds=ids.filter(id=>selected.has(id));setMembers(next,group,ids.filter(id=>!selected.has(id)));selection=effects.releasedMemberIds;}
  else if(request.mode==='arrange'){arrangeSmartGroup(next,group,rects);selection=[group.id];}
  else if(request.mode==='move'){const dx=request.x-group.x,dy=request.y-group.y;for(const n of [group,...smartGroupMembers(next,group)])position(n,n.x+dx,n.y+dy);selection=[group.id];}
  else if(request.mode==='resize'){
   resizeSmartGroup(next,group,request,rects);selection=[group.id];
  }else if(request.mode==='release'||request.mode==='release-item'){
   const images=storedImages(next,group),layout=smartGroupLayout(next,group),released=request.mode==='release'?images.map((item,index)=>({item,index})):images.map((item,index)=>({item,index})).filter(row=>row.index===request.index);if(request.mode==='release-item'&&!released.length)throw Error('组内素材序号已变化');
   for(const {item,index}of released.filter(row=>row.item?.url)){const cell=Math.max(28,Math.round(layout.thumb||96)),size=mediaSize(item),fit=size.width?Math.min(cell/size.width,cell/size.height):0,w=fit?Math.max(28,Math.round(size.width*fit)):cell,h=fit?Math.max(28,Math.round(size.height*fit)):cell,n=newNode('smart-image',Math.round(group.x+16+(index%Math.max(1,layout.cols))*(cell+8)+Math.max(0,(cell-w)/2)),Math.round(group.y+16+Math.floor(index/Math.max(1,layout.cols))*(cell+8)+Math.max(0,(cell-h)/2)),'Image',[cleanImage(item)]);dimensions(n,w,h);raw(n).scale=2;addResources(n,group);delete n.params.nativeCanvas.header;updateOwnMedia(next,n);n.assetId=n.params.nativeCanvas.mediaAssetIds[0]||null;selection.push(n.id);}
   if(request.mode==='release'){const nativeId=raw(group).id;effects.releasedMemberIds=smartGroupMembers(next,group).map(n=>n.id);selection.push(...effects.releasedMemberIds);next.edges=next.edges.filter(e=>e.source!==group.id&&e.target!==group.id);for(const n of next.nodes){const v=raw(n);if(Array.isArray(v.inputNodeIds))v.inputNodeIds=v.inputNodeIds.filter(id=>String(id)!==String(nativeId));if(n.params?.nativeCanvas){n.params.nativeCanvas.inputOrder=n.params.nativeCanvas.inputOrder.filter(r=>r.sourceNodeId!==group.id);if(Array.isArray(v.inputs))v.inputs=v.inputs.filter(id=>String(id)!==String(nativeId));}}removeNode(next,group);effects.removedNodeIds.push(group.id);}
   else{raw(group).images=images.filter((_,index)=>index!==request.index);delete raw(group).w;delete raw(group).h;}
  }else throw Error('智能组操作无效');
 }
 for(const n of next.nodes.filter(isSmartGroup)){const old=project.nodes.find(x=>x.id===n.id);if(!old||JSON.stringify(raw(old).images)!==JSON.stringify(raw(n).images))updateOwnMedia(next,n);}
 // Project assets and messages are never removed by an editor operation.
 syncNativeConnections(next);return{project:next,groupId:group?.id,selection:selection.filter(id=>next.nodes.some(n=>n.id===id)),effects};
}
