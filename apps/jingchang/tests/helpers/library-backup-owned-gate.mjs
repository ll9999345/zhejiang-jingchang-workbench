// Isolated process-restart tests only. Never load this in the formal service.
import {promises as fs} from 'node:fs';
import path from 'node:path';
const gate=process.env.LIBRARY_BACKUP_TEST_GATE;
if(gate){
 const copy=fs.copyFile;let entered=false;
 fs.copyFile=async function(source,target,...rest){
  if(!entered&&String(source).includes(path.sep+'assets'+path.sep)&&String(target).includes(path.sep+'asset-catalog'+path.sep+'libraries'+path.sep)){
   entered=true;await fs.mkdir(gate,{recursive:true});await fs.writeFile(path.join(gate,'entered.json'),JSON.stringify({pid:process.pid,phase:'before-catalog-publication'}));
   for(;;){try{await fs.stat(path.join(gate,'release.json'));break;}catch(e){if(e.code!=='ENOENT')throw e;}await new Promise(r=>setTimeout(r,20));}
  }
  return copy.call(this,source,target,...rest);
 };
}
