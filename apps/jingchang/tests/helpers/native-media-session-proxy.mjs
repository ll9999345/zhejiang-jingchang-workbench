import {spawn} from 'node:child_process';import http from 'node:http';import {once} from 'node:events';
export async function ownedMediaSessionProxy(native){
 const reservation=http.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
 const child=spawn('/Users/mjd-ppps/生视频/浙江文旅AI视频引擎V2/.venv/bin/python',['tests/helpers/prompt-native-proxy.py',new URL(native.base).port,String(port)],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 async function stop(){if(child.exitCode!==null||child.signalCode!==null)return;const exit=once(child,'exit');child.kill('SIGTERM');await Promise.race([exit,new Promise((_,reject)=>setTimeout(()=>reject(Error('Owned V2 proxy cleanup timeout')),10000).unref())]);}
 const base='http://127.0.0.1:'+port+'/canvas-module';
 for(let i=0;i<200;i++){if(child.exitCode!==null||child.signalCode!==null)throw Error('Owned proxy exited: '+output.slice(-600));try{if((await fetch(base+'/api/health')).ok)return{base,stop,child};}catch{}await new Promise(resolve=>setTimeout(resolve,30));}
 await stop();throw Error('Owned V2 proxy did not start');
}
