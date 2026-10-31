// Read-only integrity verification for local presentation evidence.
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const manifestPath=path.resolve(process.argv[2]||'docs/答辩资料/证据清单.json');
const base=path.dirname(manifestPath);
const issues=[],checks=[];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const safePath=relative=>{
 if(typeof relative!=='string'||!relative||path.isAbsolute(relative)||relative.includes('\\')||relative.split('/').some(x=>x==='..'||x==='.'||!x))throw Error('Invalid evidence path');
 const resolved=path.resolve(base,relative);
 if(!resolved.startsWith(base+path.sep))throw Error('Evidence escapes archive');
 return resolved;
};
const readRegular=async relative=>{
 const resolved=safePath(relative);
 let current=base;
 for(const part of relative.split('/')){
  current=path.join(current,part);
  const stat=await fs.lstat(current);
  if(stat.isSymbolicLink())throw Error('Evidence must not be a symbolic link');
 }
 const stat=await fs.lstat(resolved);
 if(!stat.isFile()||stat.size>32*1024*1024)throw Error('Evidence must be a bounded regular file');
 return fs.readFile(resolved);
};
let manifest;
try{
 const stat=await fs.lstat(manifestPath);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2*1024*1024)throw Error('Invalid evidence manifest');
 manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
 if(manifest.schemaVersion!==1||!Array.isArray(manifest.files)||!manifest.files.length||manifest.files.length>1000)throw Error('Invalid manifest schema');
 const paths=new Map();
 for(const file of manifest.files){
  try{
   if(paths.has(file.path)||!Number.isSafeInteger(file.bytes)||file.bytes<0||!/^[0-9a-f]{64}$/.test(file.sha256))throw Error('Invalid/duplicate manifest entry');
   paths.set(file.path,file);
   const bytes=await readRegular(file.path);
   if(bytes.length!==file.bytes||hash(bytes)!==file.sha256)throw Error('File length or SHA-256 differs');
   checks.push('bytes+sha256: '+file.path);
  }catch(error){issues.push({path:file.path||null,error:error.message});}
 }
 const index=JSON.parse((await readRegular('截图索引.json')).toString('utf8'));
 if(index.schemaVersion!==1||!Array.isArray(index.images)||index.images.length!==manifest.screenshotCount||index.count!==index.images.length)throw Error('Screenshot index count differs');
 const ids=new Set();
 for(const image of index.images){
  try{
   if(ids.has(image.id)||!image.title||!image.caption||!image.scene||!image.pptUse||!image.limits)throw Error('Incomplete screenshot caption');
   ids.add(image.id);
   const file=paths.get(image.imagePath),bytes=await readRegular(image.imagePath);
   if(!file||file.sha256!==image.sha256||hash(bytes)!==image.sha256)throw Error('Screenshot index digest differs');
   if(bytes.length<33||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes.toString('ascii',12,16)!=='IHDR')throw Error('Invalid PNG header');
   if(bytes.readUInt32BE(16)!==image.width||bytes.readUInt32BE(20)!==image.height)throw Error('PNG dimensions differ');
   if(!paths.has(image.evidencePath))throw Error('Screenshot evidence is not archived');
   checks.push('PNG+caption+evidence: '+image.id);
  }catch(error){issues.push({path:image.imagePath,error:error.message});}
 }
 for(const expected of manifest.resultAssertions||[]){
  try{
   if(!paths.has(expected.path))throw Error('Result is not in manifest');
   const bytes=await readRegular(expected.path);
   if(expected.type==='browser-groups'){
    const result=JSON.parse(bytes.toString('utf8'));
    if(result.passed!==true||!Array.isArray(result.checks)||result.checks.length!==expected.groups||['pageErrors','blocked','outsideOrigins'].some(key=>Array.isArray(result[key])&&result[key].length))throw Error('Browser result differs or contains failures');
   }else if(expected.type==='node-test-summary'){
    const log=bytes.toString('utf8');
    for(const [label,value] of Object.entries({tests:expected.passed,pass:expected.passed,fail:0,cancelled:0,skipped:0})){
     const found=[...log.matchAll(new RegExp('^(?:#|ℹ) '+label+' (\\d+)[ \\t]*$','gm'))];
     if(found.length!==1||Number(found[0][1])!==value)throw Error('Archived test summary differs: '+label);
    }
   }else throw Error('Unknown result assertion');
   checks.push('archived-result: '+expected.path);
  }catch(error){issues.push({path:expected.path,error:error.message});}
 }
}catch(error){issues.push({path:manifestPath,error:error.message});}
const result={passed:issues.length===0,verifiedAt:new Date().toISOString(),checkpoint:manifest?.checkpoint||null,files:manifest?.files?.length||0,screenshots:manifest?.screenshotCount||0,checks,issues,businessTestsRerun:false,newScreenshotsCaptured:false,networkRequests:0,paidCalls:0,thirdPartyUploads:0,purpose:'Integrity checks of archived evidence, not new product or provider acceptance'};
process.stdout.write(JSON.stringify(result,null,2)+'\n');
if(!result.passed)process.exitCode=1;
