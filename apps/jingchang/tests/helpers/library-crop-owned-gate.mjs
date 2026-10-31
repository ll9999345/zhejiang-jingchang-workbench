import {promises as fs} from 'node:fs';
import path from 'node:path';
const marker=process.env.JINGCHANG_CROP_TEST_GATE,root=process.env.JINGCHANG_DATA_DIR;
if(marker&&root){const original=fs.rename;let used=false;fs.rename=async function(source,target){const r=await original.call(this,source,target);if(!used&&path.dirname(target)===path.join(root,'jobs')){try{const j=JSON.parse(await fs.readFile(target,'utf8'));if(j.kind==='library-crop'&&j.items.some(i=>i.status==='ready')){used=true;await fs.writeFile(marker,JSON.stringify({id:j.id,pid:process.pid,assetId:j.items.find(i=>i.status==='ready').asset.id}));while(!await fs.stat(marker+'.release').then(()=>true).catch(()=>false))await new Promise(r=>setTimeout(r,20));}}catch{}}return r;};}
