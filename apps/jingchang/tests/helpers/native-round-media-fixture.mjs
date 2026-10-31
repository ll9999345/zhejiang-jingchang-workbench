import {smartGroupMediaFixture} from './smart-group-media-fixture.mjs';
import {nativeToFragment,normalizeNativeWorkflow} from '../../lib/native-canvas-core.mjs';
import {nativeLoopSettings} from '../../public/native-loop-core.js';
import {applyNativeLoopSettings} from '../../public/native-loop.js';
export function nativeRoundMediaFixture({start=2,batch=2,count=2,producerCount=5,receiver=false}={}){
 const f=smartGroupMediaFixture(),extra=nativeToFragment(normalizeNativeWorkflow({format:'infinite-smart-canvas-workflow',version:1,nodes:[{id:'rounds',type:'smart-loop',x:750,y:400,count,loopStart:start,imageInput:true,imageBatchSize:batch,showPrompt:true},...(receiver?[{id:'receiver',type:'output',x:650,y:400,images:[]}]:[])],connections:[]}),[],'逐轮来源'),loop=extra.nodes.find(n=>n.params.nativeCanvas.node.id==='rounds'),output=extra.nodes.find(n=>n.params.nativeCanvas.node.id==='receiver');
 f.p.nodes.push(...extra.nodes);applyNativeLoopSettings(loop,{...nativeLoopSettings(loop),enabled:true,count,start,imageInput:true,imageBatchSize:batch});
 const producer=f.node('left');producer.params.nativeCanvas.adaptation='configured';producer.params.nativeCanvas.node.runSettings={engine:'comfy'};producer.params.workflowBinding={workflowId:'owned-producer',overrides:[],imageSources:[],count:producerCount};
 f.p.edges=[{id:'producer-rounds',source:producer.id,target:loop.id},{id:'rounds-target',source:loop.id,target:f.id('target')}];
 if(output)f.p.edges.push({id:'producer-receiver',source:producer.id,target:output.id},{id:'receiver-target',source:output.id,target:f.id('target')});
 return{...f,loop,producer,receiver:output};
}

export function nativeRoundGroupedFixture(){
 const f=nativeRoundMediaFixture({start:1,batch:2,count:2,producerCount:4}),group=f.node('group'),target=f.node('target');delete f.p.settings.nativeMediaVersion;group.params.nativeCanvas.members=[{sourceNodeId:f.loop.id}];group.params.nativeCanvas.node.items=['rounds'];f.p.edges=f.p.edges.filter(e=>e.target!==target.id);f.p.edges.push({id:'group-target',source:group.id,target:target.id});target.params.nativeCanvas.adaptation='configured';target.params.workflowBinding={workflowId:'owned-target',count:1,overrides:[],imageSources:[{nodeId:'load',name:'image',sourceNodeId:group.id,sourceIndex:0}]};return f;
}
