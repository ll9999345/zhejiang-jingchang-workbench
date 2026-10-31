import {apimartMaterialService} from '../../lib/apimart-materials.mjs';
const service=apimartMaterialService({data:process.env.APIMART_TEST_DATA,projects:{load:async id=>{if(id!=='project-one')throw Error('Wrong local fixture');return{id,assets:[]};}}});
process.on('message',async m=>{try{let value;if(m.method==='start'){if(new URL(m.body.endpoint).hostname!=='127.0.0.1')throw Error('Loopback fixture only');value=await service.start(m.body);}else if(m.method==='query')value=await service.query(m.id,m.body);else value=await service.get(m.id,'project-one');process.send({serial:m.serial,value});}catch(e){process.send({serial:m.serial,error:{message:e.publicMessage||e.message,status:e.status}});}});
process.send({ready:true});
