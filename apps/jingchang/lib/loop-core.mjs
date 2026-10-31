export function normalizeLoop(value={mode:'repeat',count:2}){
 if(!value||typeof value!=='object'||!['repeat','list'].includes(value.mode))throw Error('循环方式须为重复或提示词列表');
 let config;if(value.mode==='repeat'){if(!Number.isInteger(value.count)||value.count<1||value.count>32)throw Error('循环次数须为1–32');config={mode:'repeat',count:value.count};}
 else{if(!Array.isArray(value.values)||!value.values.length||value.values.length>32||value.values.some(v=>typeof v!=='string'||!v.trim()||v.length>16000)||value.values.reduce((n,v)=>n+v.length,0)>128000)throw Error('循环列表须为1–32条文字，每条最多16000字、合计128000字');config={mode:'list',count:value.values.length,values:value.values.map(v=>v.trim())};}
 if(value.fieldValues!==undefined){if(!Array.isArray(value.fieldValues)||value.fieldValues.length>16)throw Error('每个循环最多16个逐轮参数');const used=new Set();let total=0;config.fieldValues=value.fieldValues.map(f=>{
  const h3=f?.kind==='minimax';
  if(!f||f.kind!==undefined&&!h3||typeof f.targetNodeId!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(f.targetNodeId)||typeof f.name!=='string'||!f.name||f.name.length>200)throw Error('逐轮参数的目标节点或字段无效');
  if(h3?(!['prompt','duration','aspectRatio','megapixels','seed'].includes(f.name)||f.nodeId!==undefined):typeof f.nodeId!=='string'||!f.nodeId||f.nodeId.length>100)throw Error('逐轮参数的目标节点或字段无效');
  const key=JSON.stringify([f.targetNodeId,h3?'minimax':f.nodeId,f.name]);if(used.has(key))throw Error('逐轮参数不能重复绑定同一字段');used.add(key);
  if(!Array.isArray(f.values)||f.values.length!==config.count)throw Error('每个逐轮参数的值数量必须与循环轮数一致');
  for(const v of f.values){if(!['string','number','boolean'].includes(typeof v)||typeof v==='number'&&!Number.isFinite(v)||typeof v==='string'&&v.length>32000)throw Error('逐轮参数须为文字、有限数字或开关值，文字最多32000字');if(typeof v==='string')total+=v.length;}
  return{targetNodeId:f.targetNodeId,...(h3?{kind:'minimax'}:{nodeId:f.nodeId}),name:f.name,values:[...f.values]};
 });if(total>256000)throw Error('逐轮参数文字合计最多256000字');}
 return config;
}
export function loopDescendants(project,id){const seen=new Set(),queue=[id];while(queue.length){const current=queue.shift();for(const e of project.edges.filter(e=>e.source===current))if(!seen.has(e.target)){seen.add(e.target);queue.push(e.target);}}return seen;}
