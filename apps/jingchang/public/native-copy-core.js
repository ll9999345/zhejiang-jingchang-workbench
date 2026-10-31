import {nativeMediaScopeText} from './native-media-scope-core.js';
import {validateNativeMediaMap} from './native-media-map-core.js';

// Synchronous SHA-256 for the same browser/Node copy operation. The server
// still independently checks every scope with node:crypto before execution.
const K=new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
const rotr=(x,n)=>(x>>>n)|(x<<(32-n));
export function nativeCopySha256(text){
 const input=new TextEncoder().encode(text),bytes=new Uint8Array(Math.ceil((input.length+9)/64)*64);bytes.set(input);bytes[input.length]=128;const view=new DataView(bytes.buffer),bits=input.length*8;view.setUint32(bytes.length-8,Math.floor(bits/0x100000000));view.setUint32(bytes.length-4,bits>>>0);const h=new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]),w=new Uint32Array(64);
 for(let offset=0;offset<bytes.length;offset+=64){for(let i=0;i<16;i++)w[i]=view.getUint32(offset+i*4);for(let i=16;i<64;i++){const a=w[i-15],b=w[i-2];w[i]=(w[i-16]+(rotr(a,7)^rotr(a,18)^(a>>>3))+w[i-7]+(rotr(b,17)^rotr(b,19)^(b>>>10)))>>>0;}let[a,b,c,d,e,f,g,k]=h;for(let i=0;i<64;i++){const t1=(k+(rotr(e,6)^rotr(e,11)^rotr(e,25))+((e&f)^(~e&g))+K[i]+w[i])>>>0,t2=((rotr(a,2)^rotr(a,13)^rotr(a,22))+((a&b)^(a&c)^(b&c)))>>>0;k=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;}for(const [i,v] of [a,b,c,d,e,f,g,k].entries())h[i]=(h[i]+v)>>>0;}
 return [...h].map(v=>v.toString(16).padStart(8,'0')).join('');
}
const scope=(p,n)=>nativeCopySha256(nativeMediaScopeText(p,n));
const transient=['jimengPending','pendingTasks','_runMetaTargetId','runStartedAt','runFinishedAt','runElapsedMs','runTimerHidden'];
const normalizeScope=(text,back,positions,rawBack=new Map())=>{
 const convert=(v,key='')=>typeof v==='string'?(key==='memberId'?(rawBack.get(v)||back.get(v)||v):(back.get(v)||v)):Array.isArray(v)?v.map(x=>convert(x,key)):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,convert(x,k)])):v;
 const value=convert(JSON.parse(text));for(const n of value.nodes){if(positions.has(n.id)&&Object.hasOwn(n,'x')){n.x=positions.get(n.id).x;n.y=positions.get(n.id).y;}}
 for(const key of ['nodes','assets','branches'])value[key].sort((a,b)=>a.id.localeCompare(b.id));value.edges.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));return JSON.stringify(value);
};

export function remapNativeCopies(project,next,idMap,{offsetX=0,offsetY=0,copyConnections=true,copyIncomingConnections=false}={}){
 const originals=new Map(project.nodes.map(n=>[n.id,n])),back=new Map([...idMap].map(([a,b])=>[b,a])),rawMap=new Map(),rawCounts=new Map();
 for(const n of project.nodes){const id=n.params?.nativeCanvas?.node.id;if(id!==undefined)rawCounts.set(String(id),(rawCounts.get(String(id))||0)+1);}
 for(const [oldId,newId]of idMap){const raw=originals.get(oldId)?.params?.nativeCanvas?.node;if(raw&&rawCounts.get(String(raw.id))===1)rawMap.set(String(raw.id),newId);}
 const rewriteRaw=id=>rawMap.get(String(id))||id;
 const copiedRawId=id=>back.has(id)?id:idMap.get(id)||next.nodes.find(n=>n.id===id)?.params?.nativeCanvas?.node.id;
 for(const [oldId,newId]of idMap){const old=originals.get(oldId),n=next.nodes.find(n=>n.id===newId),v=n.params?.nativeCanvas,raw=v?.node;if(!raw)continue;
  raw.id=newId;raw.x=n.x;raw.y=n.y;
  if(v.format==='infinite-smart-canvas-workflow'){raw.running=false;raw.pending=0;raw.queued=false;for(const key of transient)delete raw[key];}
  if(Array.isArray(raw.items))raw.items=v.members.map(r=>copiedRawId(r.sourceNodeId)).filter(id=>id!==undefined);
  const allowed=id=>copyConnections&&(rawMap.has(String(id))||copyIncomingConnections);
  if(Array.isArray(raw.inputNodeIds))raw.inputNodeIds=raw.inputNodeIds.filter(allowed).map(rewriteRaw);
  if(raw.sourceNodeId)raw.sourceNodeId=allowed(raw.sourceNodeId)?rewriteRaw(raw.sourceNodeId):'';
  for(const key of ['historyFor'])if(raw[key]&&rawMap.has(String(raw[key])))raw[key]=rewriteRaw(raw[key]);
  for(const key of ['runInputRefs','runPromptRefs'])if(Array.isArray(raw[key]))raw[key]=raw[key].filter(r=>allowed(r.sourceNodeId)).map(r=>({...r,sourceNodeId:rewriteRaw(r.sourceNodeId)}));
  const keep=(v.inputOrder||[]).filter(r=>next.edges.some(e=>e.source===r.sourceNodeId&&e.target===newId));if(Array.isArray(raw.inputs)){raw.inputs=keep.map(r=>raw.inputs[r.index]);v.inputOrder=keep.map((r,index)=>({...r,index}));}
  else v.inputOrder=keep;
  for(const ref of v.inputOrder||[])if(ref.itemType==='group-media'){
   const sourceId=back.get(ref.sourceNodeId)||ref.sourceNodeId,group=originals.get(sourceId);if(!idMap.has(sourceId))continue;
   const candidates=(group?.params?.nativeCanvas?.members||[]).map(r=>originals.get(r.sourceNodeId)).filter(member=>member&&String(member.params?.nativeCanvas?.node.id??member.id)===ref.memberId);
   if(candidates.length!==1)throw Object.assign(Error('原分组的选图来源不唯一，请重新选择素材后再复制'),{status:409});
   const memberId=idMap.get(candidates[0].id)||candidates[0].id;ref.memberId=String(copiedRawId(memberId)??memberId);
  }
  if(Array.isArray(raw.inputs))for(const r of v.inputOrder||[]){const source=copiedRawId(r.sourceNodeId);if(source===undefined)continue;raw.inputs[r.index]=r.itemType==='generated'?`${source}:generated:${r.itemIndex}:${r.itemUrl}`:r.itemType==='group-media'?`${source}:${r.memberId}`:r.itemType==='group-prompts'?`${source}:prompts`:source;}
  if(n.params.nativeMediaMap){const m=n.params.nativeMediaMap;m.loopId=idMap.get(m.loopId)||m.loopId;for(const f of m.fields){f.sourceNodeId=idMap.get(f.sourceNodeId)||f.sourceNodeId;for(const r of f.rounds)r.selection.sourceNodeId=idMap.get(r.selection.sourceNodeId)||r.selection.sourceNodeId;}}
 }
 return refreshNativeCopyProofs(project,next,idMap);
}

export function refreshNativeCopyProofs(project,next,idMap){
 const originals=new Map(project.nodes.map(n=>[n.id,n])),back=new Map([...idMap].map(([a,b])=>[b,a]));
 const positions=new Map([...idMap.keys()].map(id=>[id,{x:originals.get(id).x,y:originals.get(id).y}])),rawBack=new Map([...idMap].map(([a,b])=>[b,String(originals.get(a)?.params?.nativeCanvas?.node.id??a)])),empty=new Map();
 // Refresh only a valid original proof whose dependency/material shape remains
 // equivalent after undoing this copy's identity and geometric translation.
 for(const [oldId,newId]of idMap){const old=originals.get(oldId),n=next.nodes.find(n=>n.id===newId);if(!old.params?.nativeMediaMap)continue;
  try{validateNativeMediaMap(old,project);if(scope(project,old)!==old.params.nativeMediaMap.scopeHash)continue;const before=normalizeScope(nativeMediaScopeText(project,old),empty,new Map()),after=normalizeScope(nativeMediaScopeText(next,n),back,positions,rawBack);if(before===after)n.params.nativeMediaMap.scopeHash=scope(next,n);}catch{ /* Invalid/incomplete maps stay invalid; copying never confirms a new choice. */ }
 }
 return next;
}
