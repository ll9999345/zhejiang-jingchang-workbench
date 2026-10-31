import {promises as fs} from 'node:fs';
import path from 'node:path';
export async function jimengAccountFixture(dir){
 await fs.mkdir(dir,{recursive:true});const executable=path.join(dir,'dreamina-account-fixture.mjs');await fs.writeFile(executable,`#!${process.execPath}
import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';import path from 'node:path';
const dir=path.dirname(process.argv[1]),args=process.argv.slice(2);let mode='normal';try{mode=readFileSync(path.join(dir,'mode'),'utf8').trim();}catch{}
const device='test-device-material-private-123456789';const clean=args.map(v=>v.startsWith('--device_code=')?'--device_code=[hidden]':v);appendFileSync(path.join(dir,'calls.jsonl'),JSON.stringify({args:clean,deviceCodeMatched:args.includes('--device_code='+device),envKeys:Object.keys(process.env),cwd:process.cwd(),pid:process.pid})+'\\n');
if(mode==='hang'){process.on('SIGTERM',()=>{});setInterval(()=>{},1000);}
else if(mode==='tree'){const {spawn}=await import('node:child_process');const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});appendFileSync(path.join(dir,'child-pid'),String(child.pid));process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);}
else if(mode==='error'){process.stderr.write('SECRET-AUTH-TOKEN '+device);process.exit(2);}
else if(mode==='large'){process.stdout.write('x'.repeat(70000));}
else if(mode==='nonzero-credit'){console.log(JSON.stringify({total_credit:100}));process.exitCode=2;}
else{
 let reply;if(args[0]==='login'&&args[1]==='--headless')reply={code:0,data:{verification_uri:mode==='foreign'?'https://attacker.invalid/oauth/activate':'https://jimeng.jianying.com/oauth/activate',user_code:'SAMPLE-42',device_code:device,expires_in:600,interval:5},access_token:'SECRET-AUTH-TOKEN'};
 else if(args[0]==='login'&&args[1]==='checklogin'&&args.includes('--poll=0')&&args.includes('--device_code='+device))reply=mode==='denied'?{code:1,error:'access_denied'}:mode==='slow_down'?{code:0,status:'slow_down'}:mode==='pending'?{code:0,status:'authorization_pending'}:{code:0,data:{status:'authorized',access_token:'SECRET-AUTH-TOKEN',refresh_token:'SECRET-REFRESH-TOKEN'}};
 else if(args[0]==='text2image')reply={submit_id:'account-guard-task',gen_status:'processing'};
 else if(args[0]==='query_result'){const dir=args.find(v=>v.startsWith('--download_dir='))?.slice(15),out=path.join(dir,'result.png');writeFileSync(out,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5uoAAAAASUVORK5CYII=','base64'));reply={submit_id:'account-guard-task',gen_status:'success',images:[{file_path:out}]};}
 else if(args[0]==='user_credit')reply={code:0,data:{total_credit:12.5,credit_count:2,email:'do-not-copy@example.invalid',access_token:'SECRET-AUTH-TOKEN'}};
 else if(args[0]==='logout')reply={code:0,success:true};else{process.exit(3);}
 const text=JSON.stringify(reply);if(mode==='split'){const bytes=Buffer.from(text);for(const b of bytes){process.stdout.write(Buffer.from([b]));}}else console.log(text);
}
`);await fs.chmod(executable,0o755);return{executable,mode:v=>fs.writeFile(path.join(dir,'mode'),v),calls:async()=>{try{return(await fs.readFile(path.join(dir,'calls.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code==='ENOENT')return[];throw e;}}};
}
