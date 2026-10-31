import http from 'node:http';
import {once} from 'node:events';
import {h3Workflow,h3Video} from './minimax-h3-fixture.mjs';
export function h3RunningHubGraph(){const g=structuredClone(h3Workflow);delete g['137'];for(const [kind,count]of [['image',9],['video',3],['audio',3]])for(let i=0;i<count;i++){const id=kind+'-'+i,field=kind==='image'?'image':kind==='video'?'video':'audio';g[id]={class_type:{image:'LoadImage',video:'LoadVideo',audio:'LoadAudio'}[kind],inputs:{[field]:'original-'+id}};let source=id;if(kind==='video'){source='components-'+i;g[source]={class_type:'GetVideoComponents',inputs:{video:[id,0]}};}g['136'].inputs[`ref_${kind}s.ref_${kind}_${i}`]=[source,0];}return g;}
export async function h3RunningHubMock(){
 const bytes=h3Video(),state={uploads:[],submissions:[],queries:[],discoveries:[],pending:false};
 const server=http.createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);const raw=Buffer.concat(chunks);let body;try{body=JSON.parse(raw);}catch{}res.setHeader('content-type','application/json');
  if(req.url==='/api/openapi/getJsonApiFormat'){state.discoveries.push(body.workflowId);return res.end(JSON.stringify({code:0,data:{prompt:JSON.stringify(h3RunningHubGraph())}}));}
  if(req.url==='/task/openapi/upload'){state.uploads.push(raw);return res.end(JSON.stringify({code:0,data:{fileName:'api/owned-'+state.uploads.length+'.media'}}));}
  if(req.url==='/task/openapi/create'){state.submissions.push(body);return res.end(JSON.stringify({code:0,data:{taskId:String(123456788+state.submissions.length)}}));}
  if(req.url==='/openapi/v2/query'){state.queries.push(body.taskId);return res.end(JSON.stringify({taskId:body.taskId,status:state.pending?'RUNNING':'SUCCESS',results:[{outputType:'mp4',url:endpoint+'/result.mp4'}]}));}
  if(req.url==='/result.mp4'){res.setHeader('content-type','video/mp4');return res.end(bytes);}res.statusCode=404;res.end('{}');
 });server.listen(0,'127.0.0.1');await once(server,'listening');const endpoint='http://127.0.0.1:'+server.address().port;return {state,endpoint,close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})};
}
