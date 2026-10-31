import path from 'node:path';
import {promises as fs} from 'node:fs';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {atomicJson,readJson,records,safeId,userError,textValue,assertNoCredentials,loadAsset} from './workspace.mjs';
import {validateApiBaseUrl,validateSignedDestination} from './image-api.mjs';
import {inspectArkLocalReference} from './ark-references.mjs';

export const ARK_ASSET_ENDPOINT='https://ark.cn-beijing.volcengineapi.com';
const version='2024-01-01',region='cn-beijing',service='ark';
const actions=new Set(['CreateAssetGroup','CreateAsset','ListAssetGroups','ListAssets','GetAsset']);
const stamp=()=>new Date().toISOString(),sha=x=>createHash('sha256').update(x).digest('hex');
const run=promisify(execFile),mediaTypes={Image:'image/png',Video:'video/mp4',Audio:'audio/wav'};
const id=(x,label='编号')=>{if(!safeId(x))throw userError(label+'无效');return x;};
const cloudId=(x,label='平台编号')=>{if(typeof x!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(x))throw userError(label+'无效');return x;};
const cloudProject=x=>textValue(x||'default',64,'火山项目名称');
export function arkAssetEndpoint(value=ARK_ASSET_ENDPOINT){
 const base=validateApiBaseUrl(value),u=new URL(base);
 if(u.pathname!=='/'||!(base===ARK_ASSET_ENDPOINT||(u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname))))throw userError('素材库仅支持火山北京官方地址或显式本机模拟服务，不能使用视频生成地址或代理');
 return base;
}
function publicMediaUrl(value,endpoint){const base=validateApiBaseUrl(value),u=new URL(base);if(endpoint&&new URL(endpoint).protocol==='http:'&&u.origin===new URL(endpoint).origin)return base;if(u.protocol!=='https:')throw userError('素材入库需要公网 HTTPS 地址，不接受本机、Base64、查询参数或登录信息');return base;}
function credentials(b){
 const ak=b.accessKeyId,sk=b.secretAccessKey;
 if(typeof ak!=='string'||!/^[A-Za-z0-9_-]{8,256}$/.test(ak)||typeof sk!=='string'||sk.length<8||sk.length>512||/\s/.test(sk))throw userError('请填写本次 AK 与 SK；素材库不能使用视频 API Key');
 return {ak,sk};
}
function noSecrets(value,{ak,sk}){assertNoCredentials(value);const s=JSON.stringify(value);if(s.includes(ak)||s.includes(sk))throw userError('素材信息含本次凭据，已阻止保存和发送');return value;}
// Ark OpenAPI V4: sign the exact UTF-8 JSON bytes and fixed query, without SDK retries.
export function signArkAssetRequest({endpoint=ARK_ASSET_ENDPOINT,action,body,accessKeyId,secretAccessKey,date=new Date()}){
 if(!actions.has(action))throw userError('不支持的素材库操作');const base=arkAssetEndpoint(endpoint),{ak,sk}=credentials({accessKeyId,secretAccessKey});
 const encoded=JSON.stringify(body),xDate=date.toISOString().replace(/[-:]|\.\d{3}/g,''),short=xDate.slice(0,8),hash=sha(encoded),host=new URL(base).host;
 const query=`Action=${action}&Version=${version}`,signed='content-type;host;x-content-sha256;x-date';
 const canonical=['POST','/',query,`content-type:application/json\nhost:${host}\nx-content-sha256:${hash}\nx-date:${xDate}\n`,signed,hash].join('\n');
 const scope=`${short}/${region}/${service}/request`,toSign=['HMAC-SHA256',xDate,scope,sha(canonical)].join('\n');
 let signing=Buffer.from(sk);for(const s of [short,region,service,'request'])signing=createHmac('sha256',signing).update(s).digest();
 const signature=createHmac('sha256',signing).update(toSign).digest('hex');
 return {url:new URL(base+'/?'+query),body:encoded,headers:{'Content-Type':'application/json','Host':host,'X-Date':xDate,'X-Content-Sha256':hash,'Authorization':`HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${signed}, Signature=${signature}`}};
}
const upstreamError=(uncertain=false,status=502)=>Object.assign(userError(uncertain?'素材库提交结果不明确，请查询原平台记录；不会自动再次入库':'素材库请求未成功，请核对权限、项目名称、素材格式和平台控制台',status),{uncertain});
export async function callArkAsset({endpoint,action,body,accessKeyId,secretAccessKey,signal,timeoutMs=30000}){
 const request=signArkAssetRequest({endpoint,action,body,accessKeyId,secretAccessKey}),destination=await validateSignedDestination(endpoint,endpoint),writing=action.startsWith('Create');
 const combined=signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs);
 return new Promise((resolve,reject)=>{
  const options={method:'POST',headers:{...request.headers,'Content-Length':Buffer.byteLength(request.body)},signal:combined,...(destination.pinned?{family:destination.pinned.family,autoSelectFamily:false,lookup:(_host,_options,cb)=>cb(null,destination.pinned.address,destination.pinned.family)}:{})};
  const req=(request.url.protocol==='https:'?httpsRequest:httpRequest)(request.url,options,res=>{
   let size=0;const chunks=[];res.on('data',b=>{size+=b.length;if(size>2*1024*1024)res.destroy(upstreamError(writing));else chunks.push(b);});
   res.once('error',()=>reject(upstreamError(writing)));res.once('end',()=>{
    if(res.statusCode<200||res.statusCode>=300)return reject(upstreamError(writing&&(res.statusCode>=500||res.statusCode<400)));
    let parsed;try{parsed=JSON.parse(Buffer.concat(chunks));}catch{return reject(upstreamError(writing));}
    if(parsed?.ResponseMetadata?.Error)return reject(upstreamError(false));
    if(!parsed?.Result||typeof parsed.Result!=='object'||Array.isArray(parsed.Result))return reject(upstreamError(writing));
    resolve(parsed.Result);
   });
  });req.once('error',()=>reject(upstreamError(writing)));req.end(request.body);
 });
}
export async function inspectArkAssetSource(data,assetId,signal){
 const meta=await loadAsset(data,id(assetId,'本机素材编号'));
 if(meta.id!==assetId)throw userError('本机素材记录编号不一致');
 if(!meta.type.startsWith('video/'))return (await inspectArkLocalReference(data,{assetId:meta.id,type:meta.type},signal)).input;
 if(!['video/mp4','video/quicktime'].includes(meta.type))throw userError('素材库本机视频检查支持 MP4/MOV');
 const root=await fs.realpath(data),dir=path.join(root,'assets'),file=path.join(dir,meta.id);let bytes;
 try{const st=await fs.lstat(file),mt=await fs.lstat(file+'.json');if(await fs.realpath(dir)!==dir||await fs.realpath(file)!==file||await fs.realpath(file+'.json')!==file+'.json'||!st.isFile()||!mt.isFile()||mt.size>1024**2||st.size!==meta.size||st.size<1||st.size>150*1024*1024)throw Error();bytes=await fs.readFile(file);}catch{throw userError('本机视频缺失、被替换、为符号链接或超过150 MB');}
 const args=['-protocol_whitelist','file,pipe','-format_whitelist','mov,mp4,m4a,3gp,3g2,mj2','-f','mov','-threads','1','-max_alloc','67108864'];let info;
 try{info=JSON.parse((await run(process.env.FFPROBE_PATH||'ffprobe',['-v','error',...args,'-show_streams','-show_format','-of','json',file],{timeout:10000,maxBuffer:512*1024,signal})).stdout);}catch{throw userError('本机视频无法读取，请检查文件与 FFprobe');}
 const videos=info.streams?.filter(s=>s.codec_type==='video'&&!s.disposition?.attached_pic)||[],v=videos[0],duration=Number(info.format?.duration||v?.duration),[num,den]=String(v?.avg_frame_rate||'0/1').split('/').map(Number),fps=num/den,w=v?.width,h=v?.height;
 if(videos.length!==1||!Number.isFinite(duration)||duration<2||duration>30||w<300||h<300||w>6000||h>6000||w/h<.4||w/h>2.5||w*h<407696||w*h>8295044||!Number.isFinite(fps)||fps<24||fps>60)throw userError('入库视频须为单视频轨 MP4/MOV、2–30秒、24–60帧，宽高300–6000、比例0.4–2.5、总像素407696–8295044');
 try{await run(process.env.FFMPEG_PATH||'ffmpeg',['-v','error','-nostdin',...args,'-i',file,'-t','30','-f','null','pipe:1'],{timeout:45000,maxBuffer:128*1024,signal});}catch{throw userError('本机视频解码失败，请重新导入完整文件');}
 const sourceSha256=sha(bytes);if(sha(await fs.readFile(file))!==sourceSha256)throw userError('本机视频在检查期间变化，请重新预览');
 return {assetId:meta.id,type:meta.type,name:meta.name,size:bytes.length,sourceSha256,duration,fps,width:w,height:h,hasAudio:info.streams.some(s=>s.codec_type==='audio'),verified:true};
}
function normalizeRemote(item,kind,scope){
 const result={id:cloudId(item.Id),name:textValue(item.Name,64,'平台名称'),cloudProject:cloudProject(item.ProjectName||scope.cloudProject),endpoint:scope.endpoint,kind};
 if(result.cloudProject!==scope.cloudProject)throw userError('平台返回的项目与查询项目不一致');
 if(kind==='ark-group'){if(item.GroupType!=='AIGC')throw userError('当前仅接入 AIGC 虚拟素材组，真人认证需在平台完成');result.status='Created';}
 else{if(!mediaTypes[item.AssetType]||!['Active','Processing','Failed'].includes(item.Status))throw userError('平台返回的素材类型或状态无效');Object.assign(result,{cloudId:result.id,groupId:cloudId(item.GroupId),type:mediaTypes[item.AssetType],status:item.Status});}
 return result;
}
export function arkMaterialRecord(value){
 if(!['ark-group','ark-material'].includes(value?.kind)||!['submitting','uncertain','Created','Active','Processing','Failed'].includes(value.status))throw userError('火山素材记录格式无效');
 const r={id:id(value.id),kind:value.kind,status:value.status,endpoint:arkAssetEndpoint(value.endpoint),cloudProject:cloudProject(value.cloudProject),name:textValue(value.name,64,'素材名称'),createdAt:textValue(value.createdAt,40,'创建时间'),updatedAt:textValue(value.updatedAt,40,'更新时间'),requestId:id(value.requestId),requestCount:value.requestCount===1?1:0};
 if(value.cloudId)r.cloudId=cloudId(value.cloudId);if(value.groupId)r.groupId=cloudId(value.groupId);
 if(r.kind==='ark-material'){if(!mediaTypes[value.assetType])throw userError('素材类型无效');r.assetType=value.assetType;r.type=value.type||mediaTypes[value.assetType];if(!['image/png','image/jpeg','image/webp','video/mp4','video/quicktime','audio/wav','audio/x-wav','audio/mpeg'].includes(r.type)||r.type.split('/')[0]!==mediaTypes[r.assetType].split('/')[0])throw userError('素材类型与记录不一致');if(value.sourceUrl)r.sourceUrl=publicMediaUrl(value.sourceUrl,r.endpoint);}
 if(value.localSource){const s=value.localSource;if(!safeId(s.assetId)||!/^[a-f0-9]{64}$/.test(s.sourceSha256)||!Number.isSafeInteger(s.size)||s.size<1)throw userError('本机素材关联无效');r.localSource={assetId:s.assetId,sourceSha256:s.sourceSha256,size:s.size,type:String(s.type),verified:true};for(const key of ['duration','fps','width','height'])if(Number.isFinite(s[key])&&s[key]>0)r.localSource[key]=s[key];if(typeof s.hasAudio==='boolean')r.localSource.hasAudio=s.hasAudio;}
 if(value.publicMediaId)r.publicMediaId=id(value.publicMediaId,'公网上传记录编号');
 if(value.restored===true)r.restored=true;if(value.checkedAt)r.checkedAt=textValue(value.checkedAt,40,'检查时间');
 if(r.status==='Active'&&!r.cloudId||r.status==='Created'&&!r.cloudId)throw userError('成功记录缺少原平台编号');assertNoCredentials(r);return r;
}
export function arkAssetService({data,projects,activeJobs,publicMedia,timeoutMs=30000}){
 const locks=new Map(),selections=new Map(),file=x=>path.join(data,'ark-materials',id(x)+'.json');
 async function locked(key,fn){const old=locks.get(key)||Promise.resolve(),task=old.catch(()=>{}).then(fn);locks.set(key,task);try{return await task;}finally{if(locks.get(key)===task)locks.delete(key);}}
 async function get(key,projectId){const raw=await readJson(file(key));if(raw.projectId!==projectId)throw userError('素材记录不属于当前项目');const r=arkMaterialRecord(raw);if(r.status==='submitting'&&!activeJobs.has(r.id))r.status='uncertain';return {...r,projectId};}
 async function list(projectId){await projects.load(id(projectId,'项目编号'));const rows=(await records(path.join(data,'ark-materials'))).filter(r=>r.projectId===projectId);return Promise.all(rows.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(r=>get(r.id,projectId)));}
 async function preview(b){
  const p=await projects.load(id(b.projectId,'项目编号')),kind=b.kind==='ark-group'?'ark-group':'ark-material',plan={projectId:p.id,kind,endpoint:arkAssetEndpoint(b.endpoint),cloudProject:cloudProject(b.cloudProject),name:textValue(b.name,64,'素材名称')};
  if(kind==='ark-group')plan.description=String(b.description||'').slice(0,300);
  else{plan.groupId=cloudId(b.groupId,'素材组编号');if(!mediaTypes[b.assetType])throw userError('请选择图片、视频或音频');plan.assetType=b.assetType;plan.type=mediaTypes[b.assetType];plan.sourceUrl=publicMediaUrl(b.sourceUrl,plan.endpoint);if(b.localAssetId){if(!p.assets.some(a=>a.id===b.localAssetId)&&!b.publicMediaId)throw userError('本机素材须先加入当前项目，或选择本项目的公网上传记录');plan.localSource=await inspectArkAssetSource(data,b.localAssetId);if(plan.localSource.type.split('/')[0]!==plan.type.split('/')[0])throw userError('本机素材与入库类型不一致');plan.type=plan.localSource.type;}}
  if(b.publicMediaId){
   if(kind!=='ark-material'||!publicMedia)throw userError('当前操作不支持公网上传记录');
   const uploaded=await publicMedia.reference(id(b.publicMediaId),p.id);
   if(uploaded.url!==plan.sourceUrl||uploaded.source.assetId!==b.localAssetId||uploaded.source.sourceSha256!==plan.localSource?.sourceSha256)throw userError('上传记录、入库地址与本机素材内容不一致，请重新选择');
   plan.publicMediaId=uploaded.id;
  }
  assertNoCredentials(plan);return {...plan,fingerprint:sha(JSON.stringify(plan)),publicFileUnverified:kind==='ark-material',sendOriginalMedia:kind==='ark-material'&&plan.assetType!=='Image'};
 }
 function consent(b,scope,action){const c=b.consent;if(!c||c.endpoint!==scope.endpoint||c.cloudProject!==scope.cloudProject||c.action!==action||c.requestLimit!==1||c.sendCredentials!==true)throw userError('请确认本次素材库操作、北京地址、火山项目和单次请求');}
 async function create(b){return locked('create-'+id(b.requestId),async()=>{
  const old=(await list(b.projectId)).find(r=>r.requestId===b.requestId);if(old)return old;
  const plan=await preview(b),keys=credentials(b),action=plan.kind==='ark-group'?'CreateAssetGroup':'CreateAsset';noSecrets({plan,requestId:b.requestId},keys);consent(b,plan,action);
  if(b.fingerprint!==plan.fingerprint||b.consent.fingerprint!==plan.fingerprint)throw userError('素材信息或本机内容已变化，请重新预览确认');
  if(b.consent.consoleAuthorizationAccepted!==true)throw userError('请先在火山控制台完成素材库授权函，再确认入库');
  if(plan.kind==='ark-material'&&(b.consent.sendPublicUrl!==true||(plan.sendOriginalMedia&&b.consent.sendOriginalMedia!==true)))throw userError('请确认平台将读取这个公网文件，包括原有声音');
  if(plan.sourceUrl)await validateSignedDestination(plan.sourceUrl,plan.endpoint);
  const r={...plan,id:randomUUID(),requestId:b.requestId,createdAt:stamp(),updatedAt:stamp(),requestCount:1,status:'submitting'};delete r.fingerprint;delete r.publicFileUnverified;delete r.sendOriginalMedia;delete r.description;
  const normalized=arkMaterialRecord(r),controller=new AbortController();await atomicJson(file(r.id),{...normalized,projectId:plan.projectId});activeJobs.set(r.id,{kind:r.kind,projectId:plan.projectId,controller});
  try{const body=plan.kind==='ark-group'?{Name:plan.name,Description:plan.description,GroupType:'AIGC',ProjectName:plan.cloudProject}:{GroupId:plan.groupId,URL:plan.sourceUrl,Name:plan.name,AssetType:plan.assetType,ProjectName:plan.cloudProject};
   const result=await callArkAsset({endpoint:plan.endpoint,action,body,accessKeyId:keys.ak,secretAccessKey:keys.sk,signal:controller.signal,timeoutMs});const remote=cloudId(result.Id);noSecrets({remote},keys);r.cloudId=remote;r.status=plan.kind==='ark-group'?'Created':'Processing';
  }catch(e){r.status=e.uncertain===false?'Failed':'uncertain';}
  finally{keys.ak=keys.sk='';b.accessKeyId=b.secretAccessKey='';activeJobs.delete(r.id);r.updatedAt=stamp();await atomicJson(file(r.id),{...arkMaterialRecord(r),projectId:plan.projectId});}
  return get(r.id,plan.projectId);
 });}
 async function refresh(key,b){return locked('refresh-'+id(key),async()=>{
  const r=await get(key,id(b.projectId)),keys=credentials(b);noSecrets(r,keys);if(r.kind!=='ark-material'||!r.cloudId)throw userError('没有原平台素材编号；请在平台核对，不会重新入库');consent(b,r,'GetAsset');
  try{const raw=await callArkAsset({endpoint:r.endpoint,action:'GetAsset',body:{Id:r.cloudId,ProjectName:r.cloudProject},accessKeyId:keys.ak,secretAccessKey:keys.sk,timeoutMs}),remote=normalizeRemote(raw,'ark-material',r);noSecrets(remote,keys);if(remote.cloudId!==r.cloudId||remote.groupId!==r.groupId||remote.type.split('/')[0]!==r.type.split('/')[0])throw userError('平台返回的素材编号、素材组或类型不一致');r.status=remote.status;r.checkedAt=stamp();r.updatedAt=stamp();r.restored=false;await atomicJson(file(r.id),{...arkMaterialRecord(r),projectId:r.projectId});return r;}
  finally{keys.ak=keys.sk='';b.accessKeyId=b.secretAccessKey='';}
 });}
 async function browse(b){
  await projects.load(id(b.projectId));const scope={endpoint:arkAssetEndpoint(b.endpoint),cloudProject:cloudProject(b.cloudProject)},action=b.action,keys=credentials(b);if(!['ListAssetGroups','ListAssets'].includes(action))throw userError('请选择素材组或素材列表');consent(b,scope,action);
  const page=b.pageNumber||1,maxPage=action==='ListAssetGroups'?500:1000;if(!Number.isInteger(page)||page<1||page>maxPage)throw userError(`当前页码最多${maxPage}页；更深分页尚未接入`);const filter={GroupType:'AIGC'};if(b.groupId)filter.GroupIds=[cloudId(b.groupId)];if(b.search)filter.Name=textValue(b.search,64,'搜索名称');noSecrets({scope,filter},keys);
  try{const raw=await callArkAsset({...scope,action,body:{Filter:filter,ProjectName:scope.cloudProject,PageNumber:page,PageSize:20},accessKeyId:keys.ak,secretAccessKey:keys.sk,timeoutMs});if(!Array.isArray(raw.Items)||raw.Items.length>20)throw userError('平台素材列表格式无效');
   const items=raw.Items.map(item=>{const remote=noSecrets(normalizeRemote(item,action==='ListAssets'?'ark-material':'ark-group',scope),keys),selectionId=randomUUID();selections.set(selectionId,{projectId:b.projectId,remote,expires:Date.now()+300000});const timer=setTimeout(()=>selections.delete(selectionId),300000);timer.unref();return{...remote,selectionId};});
   return {items,pageNumber:page,totalCount:Number.isSafeInteger(raw.TotalCount)&&raw.TotalCount>=0?raw.TotalCount:null,...scope};
  }finally{keys.ak=keys.sk='';b.accessKeyId=b.secretAccessKey='';}
 }
 async function remember(b){return locked('remember-'+id(b.selectionId),async()=>{
  const selection=selections.get(b.selectionId);if(!selection||selection.projectId!==b.projectId||Date.now()>selection.expires)throw userError('平台查询结果已过期或项目不匹配，请重新查询');await projects.load(id(b.projectId));const remote=selection.remote;
  const existing=(await list(b.projectId)).find(r=>r.kind===remote.kind&&r.endpoint===remote.endpoint&&r.cloudProject===remote.cloudProject&&r.cloudId===remote.id);if(existing){if(existing.kind==='ark-material'&&(existing.groupId!==remote.groupId||existing.type.split('/')[0]!==remote.type.split('/')[0]))throw userError('平台素材组或类型与保存记录不一致');existing.status=remote.status;existing.name=remote.name;existing.checkedAt=stamp();existing.updatedAt=stamp();existing.restored=false;await atomicJson(file(existing.id),{...arkMaterialRecord(existing),projectId:b.projectId});return existing;}
  const r={...remote,id:randomUUID(),cloudId:remote.id,assetType:Object.keys(mediaTypes).find(k=>mediaTypes[k]===remote.type),requestId:randomUUID(),requestCount:0,createdAt:stamp(),updatedAt:stamp(),checkedAt:stamp()};await atomicJson(file(r.id),{...arkMaterialRecord(r),projectId:b.projectId});return get(r.id,b.projectId);
 });}
 return {list,get,preview,create,refresh,browse,remember};
}
