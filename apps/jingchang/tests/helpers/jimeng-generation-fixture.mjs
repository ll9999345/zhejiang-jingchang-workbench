import {promises as fs} from 'node:fs';
import path from 'node:path';
export async function jimengFixture(directory){
 await fs.mkdir(directory,{recursive:true});const file=path.join(directory,'dreamina-fixture.mjs');
 await fs.writeFile(file,`#!${process.execPath}
import {readFileSync,appendFileSync,writeFileSync} from 'node:fs';import path from 'node:path';
const base=path.dirname(process.argv[1]),args=process.argv.slice(2),command=args[0],flag=k=>args.find(x=>x.startsWith('--'+k+'='))?.slice(k.length+3);let mode='normal';try{mode=readFileSync(path.join(base,'mode'),'utf8').trim();}catch{}
appendFileSync(path.join(base,'calls.jsonl'),JSON.stringify({args,cwd:process.cwd(),pid:process.pid,envKeys:Object.keys(process.env)})+'\\n');
if(command!=='query_result'&&args.some(a=>a.startsWith('--download_dir'))){process.stderr.write('unknown flag: --download_dir');process.exit(2);}
if(mode==='no-id'){process.on('SIGTERM',()=>{});setInterval(()=>{},1000);}
else if(mode==='failed')console.log(JSON.stringify({gen_status:'fail',message:'sk-synthetic-not-to-persist-123456'}));
else if(mode==='echo-input'){console.log(JSON.stringify({submit_id:'echo-task',gen_status:'success',images:[{file_path:flag('images')?.split(',')[0]}]}));}
else if(command==='query_result'){
 const id=flag('submit_id');let kind='image';try{kind=readFileSync(path.join(base,id+'.kind'),'utf8');}catch{}if(mode==='pending')console.log(JSON.stringify({submit_id:id,gen_status:'processing'}));
 else{const dir=flag('download_dir'),out=mode==='outside'?path.join(base,'outside.png'):path.join(dir,'result.'+(kind==='video'?'mp4':'png'));writeFileSync(out,kind==='video'?readFileSync(path.join(base,'fixture.mp4')):Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5uoAAAAASUVORK5CYII=','base64'));console.log(JSON.stringify({submit_id:mode==='wrong-id'?'wrong-task':id,gen_status:'success',[kind==='video'?'videos':'images']:[{file_path:out}]}));}

}else{const taskId='task-'+path.basename(path.dirname(process.cwd()));writeFileSync(path.join(base,taskId+'.kind'),command.includes('video')?'video':'image');console.log(JSON.stringify({submit_id:taskId,gen_status:'pending'}));if(mode==='hang-id'){process.on('SIGTERM',()=>{});setInterval(()=>{},1000);}}
`);await fs.chmod(file,0o755);
 return{file,mode:v=>fs.writeFile(path.join(directory,'mode'),v),calls:async()=>{try{return(await fs.readFile(path.join(directory,'calls.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code==='ENOENT')return[];throw e;}}};
}
