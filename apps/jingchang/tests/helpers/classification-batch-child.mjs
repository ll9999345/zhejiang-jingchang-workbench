import {promises as fs} from 'node:fs';
import {assetClassificationService} from '../../lib/asset-classification.mjs';
import {classificationBatchService} from '../../lib/classification-batches.mjs';
const c=JSON.parse(await fs.readFile(process.env.JINGCHANG_BATCH_FIXTURE,'utf8'));
const u=new URL(c.platform.baseUrl);if(u.hostname!=='127.0.0.1')throw Error('Only loopback fixtures allowed');
const platforms={get:async()=>c.platform},sharedFolders={get:async(id,projectId)=>{if(id!==c.source.id||projectId!==c.projectId)throw Error('Wrong fixture scope');return c.source;}};
const classifier=assetClassificationService({data:c.data,platforms});await classifier.recover();const batches=classificationBatchService({data:c.data,platforms,sharedFolders,classifier});
process.on('message',async m=>{try{let value;if(m.method==='start')value=await batches.start(m.body);else if(m.method==='resume')value=await batches.resume(m.id,m.body);else if(m.method==='cancel')value=await batches.cancel(m.id,c.projectId);else value=await batches.get(m.id,c.projectId);process.send({serial:m.serial,value});}catch(e){process.send({serial:m.serial,error:{message:e.publicMessage||e.message,status:e.status}});}});
process.send({ready:true});
