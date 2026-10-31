import {makeProject,makeNode,validateProject} from '../../lib/model.mjs';
import {createInputGroup} from '../../public/input-group-core.js';
export function membershipFixture(){
 let p=makeProject('输入组成员专项');p.nodes=[makeNode('text',60,60,{id:'text',text:'原提示词'}),makeNode('image',50,140,{id:'x',assetId:'asset-x'}),makeNode('image',150,140,{id:'y',assetId:'asset-y'}),makeNode('image',900,50,{id:'target',title:'原素材字段',params:{workflowBinding:{workflowId:'template',overrides:[],count:1,imageSources:[{nodeId:'1',name:'image',sourceNodeId:'a',sourceIndex:1}]}}})];p.assets=['x','y'].map(id=>({id:'asset-'+id,name:id+'.png',type:'image/png'}));p.edges=[];
 p=createInputGroup(p,['text','x','y'],{title:'A组',idFactory:()=> 'a'}).project;
 p=createInputGroup(p,[],{title:'B组',point:{x:400,y:0},idFactory:()=> 'b'}).project;
 p=createInputGroup(p,[],{kind:'promptGroup',title:'提示词组',point:{x:0,y:400},idFactory:()=> 'pg'}).project;
 for(const id of ['a','b','pg']){const n=p.nodes.find(n=>n.id===id);n.x=id==='b'?400:0;n.y=id==='pg'?400:0;n.params.nativeCanvas.node.w=300;n.params.nativeCanvas.node.h=300;}
 p.edges=[{id:'a-target',source:'a',target:'target'}];validateProject(p);return p;
}
