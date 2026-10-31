import {promises as fs,constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const VERIFIED_DREAMINA={version:'1.4.20',platform:'darwin',arch:'x64',sha256:'63a36d52203ab5d93a3f52bc45dbfa80b84b8ede1f9044d0042f617d9d0f3607',sourceUrl:'https://lf3-static.bytednsdoc.com/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp/dreamina_cli_beta/dreamina_cli_darwin_amd64'};
export const dreaminaContract={profile:'dreamina-1.4.20',image5ProResolutions:['1.5k','2k','4k'],generationDownloadDirectory:false,multiframeMinimumTotalSeconds:2};
// No PATH/shell/HOME changes. Existing explicit settings and PATH programs win.
export async function projectDreamina({root=projectRoot,platform=process.platform,arch=process.arch}={}){
 if(platform!==VERIFIED_DREAMINA.platform||arch!==VERIFIED_DREAMINA.arch)return null;
 const base=path.join(path.resolve(root),'.tools','dreamina'),recordFile=path.join(base,'managed.json');let m;
 try{if(await fs.realpath(base)!==base||await fs.realpath(recordFile)!==recordFile)return null;const stat=await fs.lstat(recordFile);if(!stat.isFile()||stat.size>16384)return null;m=JSON.parse(await fs.readFile(recordFile,'utf8'));}catch{return null;}
 if(!m||Object.keys(m).sort().join(',')!=='arch,binary,installedAt,platform,sha256,size,sourceUrl,version'||m.version!==VERIFIED_DREAMINA.version||m.platform!==platform||m.arch!==arch||m.sha256!==VERIFIED_DREAMINA.sha256||m.sourceUrl!==VERIFIED_DREAMINA.sourceUrl||m.binary!=='1.4.20/darwin-amd64/dreamina'||typeof m.installedAt!=='string'||!Number.isFinite(Date.parse(m.installedAt))||!Number.isSafeInteger(m.size)||m.size<1)return null;
 const executable=path.join(base,m.binary);try{if(await fs.realpath(executable)!==executable)return null;const h=await fs.open(executable,constants.O_RDONLY|constants.O_NOFOLLOW);try{const st=await h.stat();if(!st.isFile()||st.size!==m.size)return null;const digest=createHash('sha256');for await(const b of h.createReadStream({autoClose:false}))digest.update(b);if(digest.digest('hex')!==m.sha256)return null;}finally{await h.close();}await fs.access(executable,constants.X_OK);}catch{return null;}
 return{executable,variant:'jimeng',managed:{version:m.version,sha256:m.sha256,scope:'project'},capabilities:{...dreaminaContract,image5ProResolutions:[...dreaminaContract.image5ProResolutions]}};
}
