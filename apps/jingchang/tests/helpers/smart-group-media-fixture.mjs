import {nativeToFragment,normalizeNativeWorkflow} from '../../lib/native-canvas-core.mjs';
export function smartGroupMediaFixture(assets){
 const values=assets||['own-a','own-b','left','right','unused'].map(id=>({id,name:id+'.png',type:'image/png',size:1})),map=new Map(values.map(a=>[a.id,a]));
 const resource=id=>({url:'/source/'+id,archive:'resources/'+id,portableUrl:'/media/'+id,asset:map.get(id)}),item=id=>({url:'/source/'+id,name:id,sourceMark:'keep-'+id});
 const document=normalizeNativeWorkflow({format:'infinite-smart-canvas-workflow',version:1,nodes:[{id:'group',type:'smart-group',x:0,y:0,w:720,h:520,title:'智能组原图',images:[item('own-a'),item('own-b')],items:['right','words','left']},{id:'right',type:'smart-image',x:500,y:3,images:[item('right')]},{id:'words',type:'smart-prompt',x:200,y:400,text:'完整组内提示词',promptSplitEnabled:false},{id:'left',type:'smart-image',x:100,y:20,images:[item('left')]},{id:'target',type:'comfy',x:1000,y:40,text:'下游处理'}],connections:[{from:'group',to:'target'}]});
 const p=nativeToFragment(document,values.map(a=>resource(a.id)),'智能组自身素材专项'),node=raw=>p.nodes.find(n=>n.params.nativeCanvas.node.id===raw),id=raw=>node(raw).id;
 return{p,node,id,document,assets:values};
}
