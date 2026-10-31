// Test-only gate for one fixture descriptor. No production code or user files use it.
import {promises as fs} from 'node:fs';
const gate=process.env.JINGCHANG_SHARED_TEST_GATE;
if(gate){const state=JSON.parse(await fs.readFile(gate,'utf8')),original=fs.open;
 fs.open=async function(file,...args){const handle=await original.call(this,file,...args);if(file===state.sourcePath){const read=handle.read.bind(handle);handle.read=async function(buffer,offset,length,position,...extra){if(position>=65536){while(JSON.parse(await fs.readFile(gate,'utf8')).paused)await new Promise(r=>setTimeout(r,20));}return read(buffer,offset,length,position,...extra);};}return handle;};
}
