// Test only: pause the exact owned media descriptor named by the test receipt.
import {promises as fs} from 'node:fs';
import path from 'node:path';
const gate=process.env.JINGCHANG_SHARED_TEST_GATE,owned=process.env.JINGCHANG_DATA_DIR;
if(gate&&owned){const original=fs.open,assets=path.join(await fs.realpath(owned),'assets')+path.sep;
 fs.open=async function(file,...args){const handle=await original.call(this,file,...args);if(typeof file==='string'&&file.startsWith(assets)){const state=JSON.parse(await fs.readFile(gate,'utf8'));if(file===state.sourcePath){const read=handle.read.bind(handle);handle.read=async function(buffer,offset,length,position,...extra){if(position>=65536){while(JSON.parse(await fs.readFile(gate,'utf8')).paused)await new Promise(r=>setTimeout(r,20));}return read(buffer,offset,length,position,...extra);};}}return handle;};
}
