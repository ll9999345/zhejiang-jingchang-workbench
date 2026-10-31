import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {once} from 'node:events';
import assert from 'node:assert/strict';
export async function localServer(data,{gate,log,cropGate}={}){
 const reservation=http.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 const args=['--import','./tests/helpers/local-network-only.mjs',...(cropGate?['--import','./tests/helpers/library-crop-owned-gate.mjs']:[]),...(gate?['--import','./tests/helpers/library-backup-owned-gate.mjs']:[]),'server.mjs'];
 const child=spawn(process.execPath,args,{cwd:process.cwd(),env:{...process.env,PORT:String(port),JINGCHANG_DATA_DIR:data,JINGCHANG_LLM_URL:'',JINGCHANG_LLM_MODEL:'',...(gate?{LIBRARY_BACKUP_TEST_GATE:gate}:{}),...(cropGate?{JINGCHANG_CROP_TEST_GATE:cropGate}:{})},stdio:['ignore','pipe','pipe']});
 let output='';const collect=b=>{output+=b.toString();if(log)void fs.appendFile(log,b);};child.stdout.on('data',collect);child.stderr.on('data',collect);
 const base='http://127.0.0.1:'+port;
 async function api(url,method='GET',body){const r=await fetch(base+url,{method,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})}),value=await r.json();assert.ok(r.ok,value.error||r.status);return value;}
 async function stop(){if(child.exitCode!==null||child.signalCode!==null)return;const closing=once(child,'exit');child.kill('SIGTERM');await Promise.race([closing,new Promise((_,reject)=>setTimeout(()=>reject(Error('Owned isolated server did not stop')),10000).unref())]);}
 const deadline=Date.now()+25000;
 while(Date.now()<deadline){if(child.exitCode!==null||child.signalCode!==null)throw Error('Isolated server exited: '+output.slice(-1000));try{const health=await api('/api/health');if(health.ok)return {child,base,api,stop,output:()=>output};}catch{}await new Promise(r=>setTimeout(r,50));}
 await stop();throw Error('Isolated startup timed out: '+output.slice(-1000));
}
export async function waitFile(file){const deadline=Date.now()+20000;while(Date.now()<deadline){try{await fs.stat(file);return;}catch(e){if(e.code!=='ENOENT')throw e;}await new Promise(r=>setTimeout(r,20));}throw Error('Isolated gate did not arrive');}
export async function persistFixture(f){await fs.mkdir(path.join(f.data,'projects',f.p.id),{recursive:true});await fs.writeFile(path.join(f.data,'projects',f.p.id,'project.json'),JSON.stringify(f.p));}
