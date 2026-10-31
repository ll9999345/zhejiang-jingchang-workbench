// Deterministic local acceptance gate; never loaded by the production launcher.
import {promises as fs} from 'node:fs';
import path from 'node:path';
const gateFile=process.env.JINGCHANG_FRAGMENT_TEST_GATE,dataDir=process.env.JINGCHANG_DATA_DIR;
if(gateFile&&dataDir){
 const owned=await fs.realpath(dataDir),rename=fs.rename.bind(fs),read=fs.readFile.bind(fs),write=fs.writeFile.bind(fs);
 fs.rename=async function(source,target,...rest){
  let gate,match=false;
  try{
   gate=JSON.parse(await read(gateFile,'utf8'));
   if(gate.paused&&gate.file===target&&target.startsWith(path.join(owned,'projects')+path.sep)&&path.basename(target)==='project.json'&&path.dirname(source)===path.dirname(target)&&path.basename(source).startsWith('pending-')){
    const p=JSON.parse(await read(source,'utf8'));match=p.runs.filter(r=>r.kind==='canvas-fragment').length>gate.previousCount;
   }
  }catch{}
  if(!match)return rename(source,target,...rest);
  if(gate.phase==='after')await rename(source,target,...rest);
  gate.reached=true;await write(gateFile,JSON.stringify(gate));
  for(;;){let current;try{current=JSON.parse(await read(gateFile,'utf8'));}catch{}if(!current?.paused)break;await new Promise(r=>setTimeout(r,15));}
  if(gate.phase!=='after')return rename(source,target,...rest);
 };
}
