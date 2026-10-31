export const nativeGraph={'1':{class_type:'SyntheticInput',inputs:{seed:10,strength:.5,text:'原图参数',enabled:true,mode:2,image:'original.png',slider:.5,hidden:42}},'2':{class_type:'SaveImage',inputs:{images:['1',0]}}};
export const nativeConfig={title:'本机原生字段样本',fields:[
 {id:'seed-field',node:'1',input:'seed',name:'原随机种子',type:'number',default:10,min:null,max:null,step:null,random_enabled:true},
 {id:'gain-field',node:'1',input:'strength',name:'固定浮点强度',type:'number',default:.5,min:0,max:1,step:.25,random_enabled:true},
 {id:'prompt-field',node:'1',input:'text',name:'文字',type:'textarea',default:'原模板文字'},
 {id:'switch-field',node:'1',input:'enabled',type:'boolean',default:false},
 {id:'select-field',node:'1',input:'mode',type:'dropdown',default:'2',options:['1','2','3']},
 {id:'media-field',node:'1',input:'image',type:'image',default:'original.png'},
 {id:'slider-field',node:'1',input:'slider',type:'slider',default:.5,min:0,max:1,step:.25,random_enabled:true}
]};
export const nativeRhConfig={nodeInfoList:[
 {nodeId:'1',fieldName:'seed',fieldType:'INT',fieldValue:'10',random_enabled:true,min:10,max:20,step:1},
 {nodeId:'1',fieldName:'strength',fieldType:'FLOAT',fieldValue:'.5',random_enabled:true,min:0,max:1,step:.25},
 {nodeId:'1',fieldName:'enabled',fieldType:'BOOLEAN',fieldValue:'true'},
 {nodeId:'1',fieldName:'mode',fieldType:'LIST',fieldValue:'2',fieldData:JSON.stringify([{index:1},{index:2},{index:3}])},
 {nodeId:'1',fieldName:'image',fieldType:'IMAGE',fieldValue:'api/original.png'},
 {nodeId:'1',fieldName:'slider',fieldType:'SLIDER',fieldValue:.5,random_enabled:true,min:0,max:1,step:.25}
]};
export const ordinaryComfy={id:'native-comfy',type:'comfy',x:0,y:0,comfyWorkflow:'foreign.json',comfyParams:{'seed-field':12,'gain-field':'.75','prompt-field':'原节点文字','switch-field':true,'select-field':'3','media-field':'foreign.png'},comfyRandomActive:{'seed-field':false,'gain-field':false},opaque:{preserve:true}};
export const ordinaryRh={id:'native-rh',type:'rh',x:0,y:0,rhParams:{'1::seed':{value:'12'},'1::strength':{value:'.75'},'1::enabled':{value:false},'1::mode':{value:'3'},'1::image':{value:'api/original.png'}},rhRandomActive:{'1::seed':false,'1::strength':true}};
