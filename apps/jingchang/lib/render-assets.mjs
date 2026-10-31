import path from 'node:path';
import {promises as fs,constants} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {atomicJson,loadAsset,userError} from './workspace.mjs';
import {streamAssetService} from './stream-assets.mjs';

const mark=stat=>`${stat.dev}/${stat.ino}/${stat.size}/${stat.mtimeMs}/${stat.ctimeMs}`;
function renderImporter(data,activeJobs,job){return streamAssetService({data,activeJobs,projects:{load:async projectId=>{
 if(projectId!==job.projectId)throw userError('成片导入不属于当前项目',403);return{id:projectId};
}}});}
export async function validateRenderAsset({data,activeJobs,job}){
 const receipt=await renderImporter(data,activeJobs,job).get(job.renderAssetImport.requestId,job.projectId);
 if(receipt.status!=='completed'||receipt.asset.id!==job.assetId)throw userError('成片素材与原导入收据不一致，未加入画布',409);
 return loadAsset(data,job.assetId);
}
// Publish through the existing streaming importer, without loading a completed
// movie into RAM. Its durable receipt closes the copy/job-save crash window.
export async function importRenderAsset({data,activeJobs,job,persist}){
 const root=await fs.realpath(data),output=path.join(root,'renders',job.id,job.result.attempt,'final.mp4'),stat=await fs.lstat(output);
 if(!stat.isFile()||stat.isSymbolicLink()||await fs.realpath(output)!==output)throw userError('成片文件不可用；原文件保留');
 if(job.renderAssetImport&&job.renderAssetImport.sourceMark!==mark(stat))throw userError('成片在导入后发生变化，原导入记录和素材保留',409);
 const importer=renderImporter(data,activeJobs,job);
 let receipt=null;
 if(job.renderAssetImport){
  try{receipt=await importer.get(job.renderAssetImport.requestId,job.projectId);}catch(e){if(e.code!=='ENOENT')throw e;}
  if(receipt&&receipt.status==='importing')throw userError('成片仍在本机导入，请等待原记录',409);
 }
 if(receipt?.status!=='completed'){
  // A stopped local copy can be tried explicitly again. Retain the earlier
  // attempt, and never copy twice after a successful durable receipt.
  if(!job.renderAssetImport||receipt){
   job.renderAssetImport={version:1,sourceMark:mark(stat),size:stat.size,requestId:randomUUID(),
    previousRequestIds:job.renderAssetImport?[...(job.renderAssetImport.previousRequestIds||[]),job.renderAssetImport.requestId]:[]};
   await persist(job);
  }
  const handle=await fs.open(output,constants.O_RDONLY|constants.O_NOFOLLOW);let stream;
  try{
   if(mark(await handle.stat())!==mark(stat)||await fs.realpath(output)!==output)throw userError('成片在打开期间发生变化，未导入；原件保留',409);
   stream=handle.createReadStream({autoClose:false});
   const asset=await importer.importFile(stream,{requestId:job.renderAssetImport.requestId,projectId:job.projectId,
    name:job.snapshot.name.slice(0,100)+'-成片.mp4',type:'video/mp4',size:stat.size});
   if(mark(await handle.stat())!==mark(stat))throw userError('成片在读取期间发生变化，未加入画布；导入副本保留',409);
   receipt={asset};
  }finally{stream?.destroy();await handle.close();}
 }
 const after=await fs.lstat(output);
 if(await fs.realpath(output)!==output||mark(after)!==job.renderAssetImport.sourceMark)throw userError('成片在复制期间发生变化，未加入画布；原件和导入副本保留',409);
 const asset={...await loadAsset(data,receipt.asset.id),source:'local-render',renderJobId:job.id};
 await atomicJson(path.join(root,'assets',asset.id+'.json'),asset);
 return asset;
}
