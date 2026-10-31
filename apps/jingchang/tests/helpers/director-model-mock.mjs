// Local protocol fixture only. This file never contacts a model service.
import {promises as fs} from 'node:fs';
import path from 'node:path';
const data=process.env.JINGCHANG_DATA_DIR,parts=[];for await(const part of process.stdin)parts.push(part);
const body=JSON.parse(Buffer.concat(parts)),revision='f'.repeat(64);
let state={};try{state=JSON.parse(await fs.readFile(path.join(data,'director-mock-state.json'),'utf8'));}catch{}
const miao=body.provider==='miaoapi';
const status={configured:true,provider:miao?'miaoapi':'deepseek',origin:miao?'https://miaoapi.xyz':'https://api.deepseek.com',model:miao?'gpt-5.4-mini':'deepseek-flash',label:miao?'喵喵 API · gpt-5.4-mini':'DeepSeek V4.1 Flash',remote:true,textOnly:true,pricing:{input_per_million:miao?.525:.30,output_per_million:miao?3.15:1.20},profileRevision:revision,sourceLabel:'本地模拟认证',...state};
let result;
if(body.operation==='status')result=status;
else{
 const file=path.join(data,'director-mock-calls.json');let calls=[];try{calls=JSON.parse(await fs.readFile(file,'utf8'));}catch{}calls.push(body);await fs.writeFile(file,JSON.stringify(calls));
 let content='电影感改写后的测试提示词';
 if(body.jsonOutput){const context=JSON.parse(body.messages.at(-1).content),shot=context.project.shots[0];content=JSON.stringify({summary:'缩短开头，保留原画面与配音',actions:shot?[{tool:'edit_shots',args:{shots:[{id:shot.id,duration:3,dialogue:'更简洁的测试字幕'}]}}]:[{tool:'add_node',args:{type:'script',title:'测试剧本',text:'虚构山水短片剧本'}}]});}
 result={content,model:status.model,provider:status.provider,finish_reason:JSON.stringify(body.messages).includes('[simulate-incomplete]')?'length':'stop',usage:{prompt_tokens:200,completion_tokens:80,total_tokens:280},estimatedMaximumUSD:.01};
}
process.stdout.write(JSON.stringify({ok:true,result}));
