import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {clipboardPasteIndex} from '../../lib/clipboard-paste-index.mjs';
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const clipboardFixtureSignature=input=>createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex');
export async function seedClipboardHistory(data,projectId,{count=55,padding=0,summary=true,alternateProjectId}={}){
 const index=clipboardPasteIndex({read:async(dir,name,optional)=>{try{return JSON.parse(await fs.readFile(path.join(dir,name),'utf8'));}catch(e){if(optional&&e.code==='ENOENT')return null;throw e;}}});
 for(let i=0;i<count;i++){
  const id='owned-history-'+String(i).padStart(5,'0'),dir=path.join(data,'clipboard-pastes',id);await fs.mkdir(dir,{recursive:true});
  const input={requestId:id,projectId:alternateProjectId&&i%2?alternateProjectId:projectId,revision:0,sourceSnapshot:{id:'owned-source',name:'自建历史 '+String(i).padStart(5,'0'),nodes:[],ownedPadding:'x'.repeat(padding)},nodeIds:['owned-node'],placement:{x:100,y:200}};
  await fs.writeFile(path.join(dir,'input.json'),JSON.stringify({signature:clipboardFixtureSignature(input),input,createdAt:new Date(Date.UTC(2026,0,1,0,0,i)).toISOString()}));await fs.writeFile(path.join(dir,'result.json'),JSON.stringify({nodeIds:['owned-inserted'],edgeIds:[],groupIds:[],assetIds:[],projectRevision:1}));
  if(summary)await index.publish(dir,id);
 }
}
