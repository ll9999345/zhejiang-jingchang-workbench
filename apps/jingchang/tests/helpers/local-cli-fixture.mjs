import {promises as fs} from 'node:fs';
import path from 'node:path';
export async function localCliFixture(directory, names=['codex','gemini','agy','dreamina']) {
  await fs.mkdir(directory,{recursive:true});
  const source = `#!${process.execPath}
import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
const dir=path.dirname(process.argv[1]),args=process.argv.slice(2);
let mode='normal';try{mode=readFileSync(path.join(dir,'mode.txt'),'utf8').trim();}catch{}
appendFileSync(path.join(dir,'calls.jsonl'),JSON.stringify({args,executable:path.basename(process.argv[1]),envKeys:Object.keys(process.env),pid:process.pid,cwd:process.cwd()})+'\\n');
if(mode==='hang'){process.on('SIGTERM',()=>{});setInterval(()=>{},1000);}
else if(mode==='tree'){process.on('SIGTERM',()=>{});const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});writeFileSync(path.join(dir,'child-pid.txt'),String(child.pid));setInterval(()=>{},1000);}
else if(mode==='large'){process.stdout.write('x'.repeat(100000));setInterval(()=>{},1000);}
else if(mode==='error'){process.stderr.write('sk-synthetic-cli-secret-123456789');process.exitCode=3;}
else if(mode==='empty'){}
else if(mode==='secret'){process.stdout.write('\\x1b[31mHelp\\x1b[0m\\nOPENAI_API_KEY=synthetic-test-key\\nAuthorization: Bearer synthetic-bearer-token\\npassword="synthetic-password"\\nsk-synthetic-cli-secret-123456789\\neyJhbGciOiJub25lIn0.c3ludGhldGlj.c2lnbmF0dXJl\\n');}
else if(mode==='split'){const b=Buffer.from('中文帮助');process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),25);}
else {const version=args.length===1&&args[0]==='--version';process.stdout.write(version?'synthetic-cli 1.4.2\\n':'本机合成帮助：'+args.join(' ')+'\\n<img src=x onerror=alert(1)>');}
`;
  const files={};
  for(const name of names){const file=path.join(directory,name+'.mjs');await fs.writeFile(file,source);await fs.chmod(file,0o755);files[name]=file;}
  return {directory,files,env:{PATH:process.env.PATH,CODEX_BIN:files.codex,GEMINI_BIN:files.gemini,ANTIGRAVITY_BIN:files.agy,JIMENG_BIN:files.dreamina},mode:mode=>fs.writeFile(path.join(directory,'mode.txt'),mode),calls:async()=>{try{return (await fs.readFile(path.join(directory,'calls.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch(e){if(e.code==='ENOENT')return [];throw e;}}};
}
