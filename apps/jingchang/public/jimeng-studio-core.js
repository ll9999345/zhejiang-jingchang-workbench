import {normalizeJimengRequest,JIMENG_COMMANDS} from './jimeng-cli-core.js';
import {normalizeJimengResultQueries} from './jimeng-query-scope.js';
export const isJimengStudio=studio=>studio?.config?.protocol==='jimeng';
export const JIMENG_STUDIO_ORIGIN='local-dreamina-login';
export function jimengStudioDefaults(mode){return{protocol:'jimeng',baseUrl:'',model:mode==='video'?'seedance2.0':'5.0',resolution:'720p',imageResolution:'2k',ratio:'16:9',duration:5,count:1,quality:'auto',size:'1024x1024',transparent:false,imageAsync:true,generateAudio:false,operation:'generate',loras:{},unitPrice:0,currency:'credits',jimeng:{command:mode==='video'?'text2video':'text2image',resultQueries:{requestLimit:3,budget:0,currency:'credits',intervalSeconds:10}}};}
function roles(command,references){return references.map((ref,i)=>({assetId:ref.assetId||ref.id||'pending-'+i,role:command==='frames2video'?i?'last':'first':command==='multiframe2video'?'frame':command==='multimodal2video'?(ref.type||'image/png').split('/')[0]:'image'}));}
export function jimengStudioRequest(studio,references){
 const c=studio.config,command=c.jimeng?.command;
 return normalizeJimengRequest({command,prompt:command==='image_upscale'?'':studio.prompt,model:c.model,resolution:studio.mode==='image'?c.imageResolution:c.resolution,ratio:c.ratio,duration:studio.mode==='video'?c.duration:0,generateNum:c.count,references:roles(command,references)});
}
export function normalizeJimengStudioConfig(config,mode){
 const c={...jimengStudioDefaults(mode),...config};
 if(c.baseUrl||c.platformId||c.nativeModelscope||c.transparent||c.generateAudio||c.operation!=='generate'||Object.keys(c.loras||{}).length)throw Error('即梦使用本机登录；请明确清除其它服务地址、LoRA、透明背景或声音/操作设置后切换');
 if(!c.jimeng||Object.keys(c.jimeng).some(key=>!['command','resultQueries'].includes(key))||!JIMENG_COMMANDS.includes(c.jimeng.command)||c.jimeng.command.includes('video')!==(mode==='video'))throw Error('即梦命令与图片/视频模式不匹配');
 const command=c.jimeng.command,amount=['image2image','image_upscale','image2video'].includes(command)?1:command==='frames2video'?2:command==='multiframe2video'?(c.duration===1?3:2):command==='multimodal2video'?1:0;
 const refs=Array.from({length:amount},(_,i)=>({assetId:'config-'+i,type:'image/png'}));
 const request=jimengStudioRequest({mode,config:c,prompt:'参数核对'},refs);
 const resultQueries=normalizeJimengResultQueries(c.jimeng.resultQueries);
 if(!['credits','CNY','USD'].includes(c.currency)||!Number.isFinite(c.unitPrice)||c.unitPrice<0||c.unitPrice>1e6)throw Error('即梦参考单价或预算单位无效');
 return{...jimengStudioDefaults(mode),model:request.model,ratio:request.ratio,duration:mode==='video'?request.duration:5,count:request.generateNum,imageResolution:mode==='image'?request.resolution:'2k',resolution:mode==='video'?request.resolution:'720p',currency:c.currency,unitPrice:c.unitPrice,jimeng:{command,resultQueries}};
}
export function jimengStudioAuthorization(studio,{budget,consent=false,sendOriginalMedia=false}={}){
 const c=studio.config;
 return{origin:JIMENG_STUDIO_ORIGIN,model:c.model,requestLimit:1,useLocalLogin:consent,sendPrompt:c.jimeng.command!=='image_upscale',sendReferences:studio.references.length>0,sendOriginalMedia,budget,currency:c.currency,resultQueries:normalizeJimengResultQueries(c.jimeng.resultQueries),resultQueriesConsent:consent};
}
