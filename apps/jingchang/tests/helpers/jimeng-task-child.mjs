import {promises as fs} from 'node:fs';
import path from 'node:path';
import {jimengTaskService} from '../../lib/jimeng-cli-tasks.mjs';
import {streamAssetService} from '../../lib/stream-assets.mjs';
const [data,executable]=process.argv.slice(2),projects={load:async id=>{const p=JSON.parse(await fs.readFile(path.join(data,'test-project.json'),'utf8'));if(p.id!==id)throw Error('project');return p;}},activeJobs=new Map(),streamAssets=streamAssetService({data,projects,activeJobs}),service=jimengTaskService({data,projects,streamAssets,activeJobs,env:{PATH:process.env.PATH,JIMENG_BIN:executable},timeoutMs:3000});
process.on('message',async m=>{try{const r=m.action==='start'?await service.start(m.body):m.action==='query'?await service.query(m.id,m.body):await service.get(m.id,m.projectId);process.send({ok:true,r});}catch(e){process.send({ok:false,status:e.status,message:e.message});}});process.send({ready:true});
