import {promises as fs,createReadStream} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {assetCatalogService} from '../../lib/asset-catalog.mjs';
import {generationService} from '../../lib/generation.mjs';
import {streamAssetService} from '../../lib/stream-assets.mjs';
import {projectBundleService} from '../../lib/project-bundles.mjs';
import {libraryBackupService} from '../../lib/library-backups.mjs';
import {storeAsset,atomicJson,loadAsset,userError} from '../../lib/workspace.mjs';
import {makeProject,makeNode} from '../../lib/model.mjs';
import {normalizeAssetClassification} from '../../lib/asset-classification.mjs';

export const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jTuEAAAAASUVORK5CYII=','base64');
export async function terminal(service,id,projectId){
  const deadline=Date.now()+20000;
  while(Date.now()<deadline){const j=await service.get(id,projectId);if(!['queued','running'].includes(j.status))return j;await new Promise(r=>setTimeout(r,10));}
  throw Error('Fixture local file task did not finish');
}
export async function libraryFixture({populated=false,dir}={}){
  const data=dir||await fs.mkdtemp(path.join(os.tmpdir(),'jingchang-library-backup-'));await fs.mkdir(data,{recursive:true});
  const activeJobs=new Map(),p=makeProject('保留当前工程'),map=new Map([[p.id,p]]);
  const projects={load:async id=>{if(!map.has(id))throw userError('项目不存在',404);return structuredClone(map.get(id));},save:async value=>{map.set(value.id,structuredClone(value));return value;},exclusive:async(_id,fn)=>fn()};
  const generation=generationService({data,activeJobs}),streamAssets=streamAssetService({data,activeJobs,projects});
  let bundles;
  const catalog=assetCatalogService({data,activeJobs,projects,streamAssets,workflows:{template:generation.template,saveTemplate:generation.saveTemplate},bundles:{export:(...args)=>bundles.exportBundle(...args),download:(...args)=>bundles.download(...args),upload:(...args)=>bundles.upload(...args),import:(...args)=>bundles.importBundle(...args),package:(...args)=>bundles.libraryPackage(...args),insert:(...args)=>bundles.insertBundle(...args)}});
  bundles=projectBundleService({data,activeJobs,projects,assetCatalog:catalog});
  const service=libraryBackupService({data,activeJobs,projects,catalog,bundles});
  const fixture={data,p,map,activeJobs,projects,generation,catalog,bundles,service,streamAssets,createReadStream};
  if(populated){
    const image=await storeAsset(data,png,{name:'角色原件.png',type:'image/png',tags:['原创']});
    image.classification=normalizeAssetClassification({summary:'测试角色',categories:{subject:['角色']},tags:['手绘']},{providerId:'local-fixture',model:'local-fixture'});await atomicJson(path.join(data,'assets',image.id+'.json'),image);
    const wav=Buffer.alloc(48);wav.write('RIFF');wav.writeUInt32LE(40,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(4,40);
    const audio=await storeAsset(data,wav,{name:'提示音.wav',type:'audio/wav'}),mp4=Buffer.alloc(32);mp4.writeUInt32BE(24,0);mp4.write('ftypisom',4);
    const video=await storeAsset(data,mp4,{name:'协议测试.mp4',type:'video/mp4'});
    p.assets=[image,audio,video];p.nodes=[makeNode('image',100,100,{title:'保留的原节点',assetId:image.id})];map.set(p.id,p);
    const copy=await catalog.start({requestId:randomUUID(),projectId:p.id,libraryId:'default',folderId:'characters',assetIds:p.assets.map(a=>a.id),revision:0});const copied=await terminal(catalog,copy.id,p.id);
    if(copied.status!=='completed')throw Error(copied.message);
    let state=await catalog.read();fixture.mediaEntries=state.libraries[0].folders[0].items;
    const w=await generation.saveTemplate({name:'可编辑 API 工作流',workflow:{'1':{class_type:'LoadImage',inputs:{image:'fixture.png'}},'2':{class_type:'SaveImage',inputs:{images:['1',0],filename_prefix:'fixture'}}},fields:[{nodeId:'1',name:'image',label:'参考图片',control:'text',mediaKind:'image'}]});
    for(const kind of ['comfy','canvas','canvas-fragment']){
      state=await catalog.read();await catalog.addWorkflow({requestId:randomUUID(),kind,name:kind==='comfy'?'模板副本':kind==='canvas'?'完整工程快照':'可插入画布工作流',revision:state.revision,libraryId:'default',folderId:'workflows',workflowId:w.id,projectId:p.id,projectRevision:p.revision,...(kind==='canvas-fragment'?{nodeIds:[p.nodes[0].id]}:{})});
    }
    state=await catalog.read();await catalog.archiveItems({ids:[fixture.mediaEntries[0].id],archived:true,revision:state.revision});
    state=await catalog.read();await catalog.archiveFolder('default','scenes',{archived:true,revision:state.revision});
    state=await catalog.read();const made=await catalog.createLibrary({name:'保留空分组的归档库',revision:state.revision});await catalog.archiveLibrary(made.library.id,{archived:true,revision:made.catalog.revision});
    fixture.image=image;fixture.workflow=w;
  }
  fixture.reloadService=()=>libraryBackupService({data,activeJobs,projects,catalog,bundles});
  return fixture;
}
export async function backupFixture(f){
  const job=await f.service.start({requestId:randomUUID(),projectId:f.p.id,revision:(await f.catalog.read()).revision});
  const done=await terminal(f.service,job.id,f.p.id);if(done.status!=='completed')throw Error(done.message);
  return {job:done,file:await f.service.download(done.id)};
}
export const remappedMedia=async(f,catalog)=>Promise.all(catalog.libraries.flatMap(l=>l.folders.flatMap(g=>g.items.filter(i=>i.kind==='media'))).map(i=>loadAsset(f.data,i.assetId)));
