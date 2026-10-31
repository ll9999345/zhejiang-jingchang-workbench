import {promises as fs} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import http from 'node:http';

export async function directorTestServer(data,{live=false}={}){
 const reservation=http.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 const child=spawn(process.execPath,['server.mjs'],{cwd:process.cwd(),env:{...process.env,PORT:String(port),JINGCHANG_DATA_DIR:data,JINGCHANG_LLM_URL:'',JINGCHANG_LLM_MODEL:'',JINGCHANG_DIRECTOR_PYTHON:live?path.resolve('../浙江文旅AI视频引擎V2/.venv/bin/python'):process.execPath,JINGCHANG_DIRECTOR_HELPER:live?path.resolve('../浙江文旅AI视频引擎V2/scripts/canvas_deepseek.py'):path.resolve('tests/helpers/director-model-mock.mjs')},stdio:['ignore','pipe','pipe']});
 let log='';child.stdout.on('data',c=>log+=c);child.stderr.on('data',c=>log+=c);
 const base='http://127.0.0.1:'+port;
 for(let i=0;i<80;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));if(i===79)throw Error('isolated server startup failed: '+log);}
 async function request(route,method='GET',body,headers={}){const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};}
 return {base,request,stop:async()=>{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}},calls:async()=>{try{return JSON.parse(await fs.readFile(path.join(data,'director-mock-calls.json'),'utf8'));}catch{return [];}}};
}

