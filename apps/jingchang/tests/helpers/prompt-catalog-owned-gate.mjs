// Preload only in an owned, isolated test server. Pauses the third import
// publication so the test can kill that exact process before catalog commit.
import {promises as fs} from 'node:fs';import path from 'node:path';
const gateFile=process.env.PROMPT_CATALOG_TEST_GATE;
if(gateFile){const gate=JSON.parse(await fs.readFile(gateFile,'utf8')),directory=path.join(await fs.realpath(gate.data),'prompts'),original=fs.link;let count=0;fs.link=async function(source,destination,...rest){if(path.dirname(destination)===directory&&destination.endsWith('.json')&&++count===3){await fs.writeFile(gate.ready,'third-publication-paused',{flag:'wx'});for(;;){try{await fs.stat(gate.release);break;}catch(e){if(e.code!=='ENOENT')throw e;}await new Promise(r=>setTimeout(r,30));}}return original.call(this,source,destination,...rest);};}
