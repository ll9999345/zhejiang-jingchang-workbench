import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {splitGridLayout,composeGridLayout} from '../lib/grid-layout.mjs';
import {splitImageGrid,composeImageGrid} from '../lib/media-tools.mjs';
import {storeAsset,readJson} from '../lib/workspace.mjs';
const exec=promisify(execFile);
async function makeImage(data,width,height,pixel,name='source'){
 const raw=Buffer.alloc(width*height*4);for(let y=0;y<height;y++)for(let x=0;x<width;x++)raw.set(pixel(x,y),(y*width+x)*4);
 const file=path.join(data,name+'.rgba'),png=path.join(data,name+'.png');await fs.writeFile(file,raw);await exec('ffmpeg',['-v','error','-nostdin','-f','rawvideo','-pixel_format','rgba','-video_size',`${width}x${height}`,'-i',file,'-frames:v','1','-threads','1','-update','1',png]);const bytes=await fs.readFile(png);return{asset:await storeAsset(data,bytes,{name:name+'.png',type:'image/png'}),raw,bytes};
}
async function pixels(data,asset){return(await exec('ffmpeg',['-v','error','-i',path.join(data,'assets',asset.id),'-frames:v','1','-f','rawvideo','-pix_fmt','rgba','pipe:1'],{encoding:'buffer',maxBuffer:32*1024*1024})).stdout;}
test('split grid partitions every odd-size pixel once and excludes explicit margins and gaps',()=>{
 const tiles=splitGridLayout({width:101,height:79,rows:3,columns:4}),seen=new Uint8Array(101*79);
 for(const t of tiles)for(let y=t.y;y<t.y+t.height;y++)for(let x=t.x;x<t.x+t.width;x++)seen[y*101+x]++;
 assert.ok(seen.every(v=>v===1));const cut=splitGridLayout({width:101,height:79,rows:3,columns:4,margin:2,gap:3});assert.equal(cut[0].x,2);assert.equal(cut.at(-1).x+cut.at(-1).width,99);assert.equal(cut.at(-1).y+cut.at(-1).height,77);
 for(const args of [{rows:0},{rows:9},{columns:1.5},{gap:-1},{margin:99}])assert.throws(()=>splitGridLayout({width:101,height:79,...args}));
 assert.throws(()=>composeGridLayout({count:64,columns:1}),/最多8行/);assert.throws(()=>composeGridLayout({count:4,tileWidth:4096,tileHeight:4096}),/总计/);assert.throws(()=>composeGridLayout({count:1,background:'red;movie=file'}),/颜色/);
});

test('real grid split preserves exact RGBA pixels and selected row order',async()=>{
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jingchang-grid-split-'));
 const source=await makeImage(data,101,79,(x,y)=>[x*2,y*3,(x+y)%256,(x+y)%2?128:255]);
 const args={data,assetId:source.asset.id,rows:3,columns:4,margin:2,gap:3,indices:[11,0,5]},result=await splitImageGrid(args);
 assert.deepEqual(result.assets.map(a=>a.grid.index),[0,5,11]);
 for(const asset of result.assets){const t=asset.grid,actual=await pixels(data,asset);for(let row=0;row<t.height;row++)assert.deepEqual(actual.subarray(row*t.width*4,(row+1)*t.width*4),source.raw.subarray(((row+t.y)*101+t.x)*4,((row+t.y)*101+t.x+t.width)*4));assert.equal(asset.sourceAssetId,source.asset.id);assert.deepEqual(await readJson(path.join(data,'assets',asset.id+'.json')),asset);}
 assert.deepEqual(await fs.readFile(path.join(data,'assets',source.asset.id)),source.bytes);
 for(const indices of [[],[0,0],[12],[-1],['1']])await assert.rejects(splitImageGrid({...args,indices}),/编号/);
 await assert.rejects(splitImageGrid({...args,assetId:'../source.png'}),/编号/);
});

test('real compose respects order, odd dimensions, blank cells, fit modes and alpha',async()=>{
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jingchang-grid-compose-'));
 const red=await makeImage(data,9,5,()=>[255,0,0,255],'red'),blue=await makeImage(data,5,9,()=>[0,0,255,255],'blue'),transparent=await makeImage(data,3,3,()=>[0,255,0,128],'alpha');
 const options={data,assetIds:[red.asset.id,blue.asset.id,red.asset.id],columns:2,tileWidth:9,tileHeight:9,margin:1,gap:2,fit:'contain',background:'#ffffff'};
 const composed=await composeImageGrid(options),raw=await pixels(data,composed),at=(x,y)=>[...raw.subarray((y*22+x)*4,(y*22+x+1)*4)];assert.equal(composed.width,22);assert.equal(composed.height,22);
 assert.deepEqual(at(0,0),[255,255,255,255]);assert.deepEqual(at(1,1),[255,255,255,255]);assert.deepEqual(at(5,5),[255,0,0,255]);assert.deepEqual(at(16,5),[0,0,255,255]);assert.deepEqual(at(5,16),[255,0,0,255]);assert.deepEqual(at(16,16),[255,255,255,255]);assert.deepEqual(composed.sourceAssetIds,options.assetIds);
 for(const fit of ['cover','stretch']){const a=await composeImageGrid({...options,assetIds:[red.asset.id],columns:1,tileWidth:7,tileHeight:5,margin:0,gap:0,fit,background:'#00000000'});assert.equal(a.width,7);assert.equal(a.height,5);const bytes=await pixels(data,a);for(let i=0;i<bytes.length;i+=4)assert.deepEqual([...bytes.subarray(i,i+4)],[255,0,0,255]);}
 const alpha=await composeImageGrid({...options,assetIds:[transparent.asset.id],columns:1,tileWidth:3,tileHeight:3,margin:1,gap:0,background:'#00000000'}),alphaRaw=await pixels(data,alpha);assert.equal(alpha.width,5);assert.equal(alpha.height,5);assert.equal(alphaRaw[3],0);assert.deepEqual([...alphaRaw.subarray((2*5+2)*4,(2*5+3)*4)],[0,255,0,128]);
 const onWhite=await composeImageGrid({...options,assetIds:[transparent.asset.id],columns:1,tileWidth:3,tileHeight:3,margin:0,gap:0});const whiteRaw=await pixels(data,onWhite);assert.ok(Math.abs(whiteRaw[0]-127)<=1);assert.equal(whiteRaw[1],255);assert.ok(Math.abs(whiteRaw[2]-127)<=1);assert.equal(whiteRaw[3],255);
 assert.deepEqual(await fs.readFile(path.join(data,'assets',red.asset.id)),red.bytes);assert.deepEqual(await fs.readFile(path.join(data,'assets',blue.asset.id)),blue.bytes);
 const count=(await fs.readdir(path.join(data,'media-tools'))).length;await assert.rejects(composeImageGrid({...options,assetIds:[red.asset.id,'missing']}),/找不到/);assert.equal((await fs.readdir(path.join(data,'media-tools'))).length,count);
});
