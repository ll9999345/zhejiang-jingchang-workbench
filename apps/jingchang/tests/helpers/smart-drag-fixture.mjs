import {nativeToFragment,normalizeNativeWorkflow} from '../../lib/native-canvas-core.mjs';
export function smartDragFixture(){
 const p=nativeToFragment(normalizeNativeWorkflow({format:'infinite-smart-canvas-workflow',version:1,nodes:[
  {id:'prompt',type:'smart-prompt',x:0,y:0,w:220,h:160,text:'自建本机提示词',promptSplitEnabled:false},
  {id:'image',type:'smart-image',x:700,y:0,w:220,h:160,images:[]},
  {id:'loop',type:'smart-loop',x:0,y:500,w:220,h:160,count:2,imageInput:true,showPrompt:false},
 ],connections:[]}),[],'Ctrl 拖动自建验收');p.groups=[];p.settings.nativeMediaVersion=2;
 const node=id=>p.nodes.find(n=>n.params.nativeCanvas.node.id===id),id=key=>node(key).id;
 return{p,node,id};
}
export function smartDragRequest(f,key,x,y,extra={}){return{mode:'drag',requestId:'owned-ctrl-'+key,revision:f.p.revision,primaryId:f.id(key),selectionIds:[f.id(key)],positions:[{id:f.id(key),x,y}],ctrlDrag:true,pointer:{x:x+20,y:y+20},...extra};}
