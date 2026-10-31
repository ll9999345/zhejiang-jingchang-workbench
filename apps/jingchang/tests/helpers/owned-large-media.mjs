import {promises as fs,createReadStream} from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
export async function ownedLargeVideo(dir,size){
 await fs.mkdir(dir,{recursive:true});const tiny=path.join(dir,'owned-small.mp4'),file=path.join(dir,'owned-large.mp4');
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:size=320x240:rate=24','-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t','1','-c:v','libx264','-preset','ultrafast','-c:a','aac','-pix_fmt','yuv420p','-movflags','+faststart',tiny]);
 const bytes=await fs.readFile(tiny);if(size<bytes.length+8||size-bytes.length>0xffffffff)throw Error('owned fixture size invalid');
 const handle=await fs.open(file,'wx');try{await handle.writeFile(bytes);const free=Buffer.alloc(8);free.writeUInt32BE(size-bytes.length);free.write('free',4);await handle.write(free,0,8,bytes.length);await handle.truncate(size);}finally{await handle.close();}
 return {file,size,tiny};
}
export async function fileSha(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
