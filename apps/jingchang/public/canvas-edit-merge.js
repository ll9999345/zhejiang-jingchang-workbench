const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const copy=v=>v===undefined?undefined:structuredClone(v);
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
function recordKey(values){
 for(const key of ['id','sourceNodeId'])if(values.every(list=>Array.isArray(list)&&list.every(v=>object(v)&&typeof v[key]==='string')&&new Set(list.map(v=>v[key])).size===list.length))return key;
 return null;
}

// A saved membership correction and a later local text/asset edit can coexist.
// Conflicts retain the later local value and are left dirty for user review;
// this helper never writes a project or submits a generation request.
export function mergeCanvasEdit(base,local,saved){
 if(base?.id!==local?.id||base?.id!==saved?.id)throw Error('不能合并不同画布的编辑');
 if(local.revision>saved.revision)return{project:copy(local),dirty:true,conflicts:['较新的画布版本'],newerLocal:true};
 const conflicts=[];
 function merge(a,b,c,path,depth){
  if(depth>80)throw Error('画布编辑层级过深');
  if(equal(b,a))return copy(c);if(equal(c,a)||equal(b,c))return copy(b);
  if(object(a)&&object(b)&&object(c)){
   const result={};for(const key of new Set([...Object.keys(a),...Object.keys(b),...Object.keys(c)])){const v=merge(a[key],b[key],c[key],path+'.'+key,depth+1);if(v!==undefined)Object.defineProperty(result,key,{value:v,enumerable:true,writable:true,configurable:true});}return result;
  }
  if(Array.isArray(a)&&Array.isArray(b)&&Array.isArray(c)){
   const key=recordKey([a,b,c]);if(key){const am=new Map(a.map(v=>[v[key],v])),bm=new Map(b.map(v=>[v[key],v])),cm=new Map(c.map(v=>[v[key],v]));
    const localIds=b.map(v=>v[key]),baseCommon=a.map(v=>v[key]).filter(id=>bm.has(id)),localCommon=localIds.filter(id=>am.has(id)),reordered=!equal(baseCommon,localCommon);
    const order=[...new Set(reordered?[...localIds,...c.map(v=>v[key])]:[...c.map(v=>v[key]),...localIds])],result=[];
    for(const id of order){const v=merge(am.get(id),bm.get(id),cm.get(id),path+'['+id+']',depth+1);if(v!==undefined)result.push(v);}return result;
   }
  }
  conflicts.push(path);return copy(b);
 }
 const project=merge(base,local,saved,'画布',0);project.id=saved.id;project.createdAt=saved.createdAt;project.revision=saved.revision;project.updatedAt=saved.updatedAt;
 return{project,conflicts,dirty:!equal(project,saved),newerLocal:false};
}
