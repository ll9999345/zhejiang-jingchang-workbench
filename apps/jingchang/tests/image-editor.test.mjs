import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {once} from 'node:events';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {normalizeEdits,replayEdits,editPixels} from '../lib/image-edit-core.mjs';
import {editImage,readImageEdit,editorSource} from '../lib/media-tools.mjs';
import {storeAsset,readJson} from '../lib/workspace.mjs';
import {generationService} from '../lib/generation.mjs';
import {makeProject} from '../lib/model.mjs';
const exec=promisify(execFile),base=()=>new Uint8ClampedArray(Array.from({length:9*7},()=>[20,40,80,255]).flat()),stroke=(type,extra={})=>({type,size:3,opacity:1,hardness:1,points:[[4.5,3.5]],...(type==='paint'?{color:'#ff0000'}:{}),...extra});
const at=(pixels,width,x,y)=>[...pixels.subarray((y*width+x)*4,(y*width+x+1)*4)];
test('editor keeps independent paint, eraser, mask and expansion layers with deterministic undo',()=>{
 const raw=base(),operations=[stroke('paint'),stroke('mask'),{type:'expand',left:2,right:1,top:3,bottom:0}],state=replayEdits(9,7,raw,operations);
 assert.equal(state.width,12);assert.equal(state.height,10);assert.deepEqual(at(editPixels(state),12,6,6),[255,0,0,255]);assert.equal(state.mask[6*12+6],255);assert.equal(state.mask[0],255);assert.equal(state.mask[3*12+2],0);
 const undone=replayEdits(9,7,raw,operations.slice(0,-1));assert.deepEqual(at(editPixels(undone),9,4,3),[255,0,0,255]);assert.equal(editPixels(undone,'input')[(3*9+4)*4+3],0);assert.deepEqual(at(editPixels(undone,'mask'),9,4,3),[255,255,255,255]);
 const erased=replayEdits(9,7,raw,[stroke('paint'),stroke('erase')]);assert.deepEqual(editPixels(erased),raw);const unmasked=replayEdits(9,7,raw,[stroke('mask'),stroke('unmask')]);assert.ok(unmasked.mask.every(n=>n===0));
 const soft=replayEdits(9,7,raw,[stroke('mask',{size:5,hardness:0,opacity:.5})]);assert.ok(soft.mask.some(n=>n>0&&n<128));
 const rect=replayEdits(9,7,raw,[{type:'mask-rect',x:1,y:2,width:3,height:2},{type:'mask-invert'}]);assert.equal(rect.mask[2*9+1],0);assert.equal(rect.mask[0],255);assert.deepEqual(raw,base());
});
test('editor validates dimensions, command cost, coordinates and strips unrelated fields',()=>{
 for(const operations of [[{type:'shell'}],[stroke('paint',{color:'red'})],[stroke('mask',{size:0})],[stroke('mask',{points:[[Infinity,1]]})],[{type:'mask-rect',x:8,y:6,width:2,height:1}],[{type:'expand',left:9000}],Array(501).fill({type:'mask-clear'})])assert.throws(()=>normalizeEdits(9,7,operations));
 assert.throws(()=>normalizeEdits(8192,8192,[]),/像素/);assert.throws(()=>normalizeEdits(1000,1000,Array(500).fill(stroke('mask',{size:512}))),/复杂/);assert.deepEqual(normalizeEdits(9,7,[{type:'mask-clear',script:'ignored'}]).operations,[{type:'mask-clear'}]);
});
async function fixture(){const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-editor-')),raw=base(),file=path.join(data,'original.rgba'),png=path.join(data,'original.png');await fs.writeFile(file,raw);await exec('ffmpeg',['-v','error','-f','rawvideo','-pixel_format','rgba','-video_size','9x7','-i',file,'-frames:v','1','-threads','1','-update','1',png]);const bytes=await fs.readFile(png),asset=await storeAsset(data,bytes,{name:'原图.png',type:'image/png'});return{data,raw,bytes,asset};}
async function pixels(file){return(await exec('ffmpeg',['-v','error','-i',file,'-frames:v','1','-f','rawvideo','-pix_fmt','rgba','pipe:1'],{encoding:'buffer'})).stdout;}
test('real editor exports PNG image/gray mask/alpha input, preserves recipe and source bytes',async()=>{
 const f=await fixture(),operations=[stroke('paint'),{type:'mask-rect',x:3,y:2,width:3,height:3},{type:'expand',left:2,right:1,top:3,bottom:0}],expected=replayEdits(9,7,f.raw,operations),result=await editImage({data:f.data,assetId:f.asset.id,operations});
 for(const mode of ['image','mask','input']){const a=result[mode];assert.equal(a.width,12);assert.equal(a.height,10);assert.deepEqual(new Uint8ClampedArray(await pixels(path.join(f.data,'assets',a.id))),editPixels(expected,mode));assert.equal(a.editId,result.editId);assert.deepEqual(await readJson(path.join(f.data,'assets',a.id+'.json')),a);}
 const record=await readImageEdit(f.data,result.editId);assert.deepEqual(record.operations,normalizeEdits(9,7,operations).operations);assert.equal(record.sourceAssetId,f.asset.id);
 const resumed=await editImage({data:f.data,assetId:record.sourceAssetId,operations:[...record.operations,{type:'mask-clear'}]});assert.notEqual(resumed.editId,result.editId);assert.equal((await readImageEdit(f.data,result.editId)).operations.length,3);
 const preview=await editorSource({data:f.data,assetId:f.asset.id});assert.deepEqual(await pixels(preview),Buffer.from(f.raw));assert.deepEqual(await fs.readFile(path.join(f.data,'assets',f.asset.id)),f.bytes);
 const before=(await fs.readdir(path.join(f.data,'media-tools'))).length;await assert.rejects(editImage({data:f.data,assetId:f.asset.id,operations:[{type:'expand',left:9999}]}));assert.equal((await fs.readdir(path.join(f.data,'media-tools'))).length,before);await assert.rejects(readImageEdit(f.data,'../other'));
});
test('edited mask and alpha image map to ComfyUI uploads without changing channel semantics',async t=>{
 const f=await fixture(),result=await editImage({data:f.data,assetId:f.asset.id,operations:[stroke('mask')]}),uploads=[],prompts=[];
 const mock=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);res.setHeader('content-type','application/json');if(req.url==='/upload/image'){const form=await new Response(Buffer.concat(chunks),{headers:{'content-type':req.headers['content-type']}}).formData(),file=form.get('image');uploads.push({name:file.name,bytes:Buffer.from(await file.arrayBuffer())});return res.end(JSON.stringify({name:file.name,subfolder:'',type:'input'}));}if(req.url==='/prompt'){prompts.push(JSON.parse(Buffer.concat(chunks)));return res.end(JSON.stringify({prompt_id:'edited'}));}if(req.url.startsWith('/history/'))return res.end(JSON.stringify({edited:{status:{completed:true},outputs:{'3':{images:[{filename:'out.png',subfolder:'',type:'output'}]}}}}));if(req.url.startsWith('/view')){res.setHeader('content-type','image/png');return res.end(f.bytes);}res.statusCode=404;res.end('{}');});mock.listen(0,'127.0.0.1');await once(mock,'listening');t.after(()=>new Promise(r=>mock.close(r)));
 const generation=generationService({data:f.data,activeJobs:new Map()}),template=await generation.saveTemplate({name:'遮罩工作流',workflow:{'1':{class_type:'LoadImage',inputs:{image:'old.png'}},'2':{class_type:'LoadImageMask',inputs:{image:'old-mask.png',channel:'red'}},'3':{class_type:'LoadImageMask',inputs:{image:'old-alpha.png',channel:'alpha'}}}}),p=makeProject('遮罩'),assets=[result.image,result.mask,result.input];p.assets=assets;
 const job=await generation.start(p,{workflowId:template.id,overrides:[],mediaBindings:[{nodeId:'1',name:'image',assetId:result.image.id},{nodeId:'2',name:'image',assetId:result.mask.id},{nodeId:'3',name:'image',assetId:result.input.id}]},'http://127.0.0.1:'+mock.address().port);let saved;for(let i=0;i<200;i++){saved=await readJson(path.join(f.data,'jobs',job.id+'.json'));if(['completed','failed'].includes(saved.status))break;await new Promise(r=>setTimeout(r,20));}assert.equal(saved.status,'completed',saved.message);assert.equal(uploads.length,3);assert.equal(prompts.length,1);assert.equal(prompts[0].prompt['2'].inputs.channel,'red');assert.equal(prompts[0].prompt['3'].inputs.channel,'alpha');
 for(const a of assets){const bytes=await fs.readFile(path.join(f.data,'assets',a.id));assert.ok(uploads.some(u=>u.bytes.equals(bytes)));}
});
