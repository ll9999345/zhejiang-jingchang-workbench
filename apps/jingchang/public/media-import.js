import {nativeMediaFetch as fetch} from './native-media-session.js';
import {MAX_STREAM_MEDIA_BYTES,fileMediaType,streamMediaType,transferSize} from './media-transfer-core.js';
export async function importMediaFile(file,{projectId,onProgress,requestId=crypto.randomUUID()}={}){
 const type=fileMediaType(file);if(!streamMediaType(type))throw Error('请选择常见图片、视频或音频文件');if(!file.size||file.size>MAX_STREAM_MEDIA_BYTES)throw Error('媒体大小须为1字节至4GB');
 onProgress?.('正在将 '+transferSize(file.size)+' 原文件保存到本机…');
 const query=new URLSearchParams({projectId,requestId,name:file.name});
 let result,polling=false;
 const receiptUrl='/api/asset-imports/'+encodeURIComponent(requestId)+'?projectId='+encodeURIComponent(projectId);
 const timer=setInterval(async()=>{if(polling)return;polling=true;try{const res=await fetch(receiptUrl);if(res.ok){const r=await res.json();if(r.status==='importing')onProgress?.('正在保存到本机：'+transferSize(r.bytesReceived)+' / '+transferSize(r.size));}}catch{}finally{polling=false;}},1000);
 try{const res=await fetch('/api/assets/stream?'+query,{method:'POST',headers:{'Content-Type':type,'X-Jingchang-File-Size':String(file.size)},body:file});result=await res.json();if(!res.ok)throw Error(result.error||'本机导入未完成');return result;}
 catch(e){
  // Read the original receipt after a lost reply; never automatically resend the file.
  try{const res=await fetch(receiptUrl);if(res.ok){const record=await res.json();if(record.status==='completed')return record.asset;}}catch{}
  throw Error((e.message||'本机导入未完成')+'；不会自动重新发送。');
 }finally{clearInterval(timer);}
}
