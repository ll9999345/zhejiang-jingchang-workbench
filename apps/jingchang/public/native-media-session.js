import {NATIVE_MEDIA_SESSION_HEADER,nativeMediaSessionToken,nativeMediaSessionFromHealth,nativeMediaSessionError,nativeMediaRecoveryOperation,projectUsesModernNativeMedia} from './native-media-session-core.js';

export function createNativeMediaSession({fetchImpl=globalThis.fetch.bind(globalThis),onMismatch=()=>{}}={}){
 let initial,initialPromise,locked,requiresResponseHeader=false;
 function lock(error){if(!locked){locked=error;onMismatch(error);}return locked;}
 function observe(health){
  let next;try{next=nativeMediaSessionToken(nativeMediaSessionFromHealth(health));}catch(error){throw lock(error);}
  if(initial&&(initial!==next||requiresResponseHeader&&health?.nativeMediaSession?.version!==1))throw lock(nativeMediaSessionError());
  if(!initial)initial=next;
  requiresResponseHeader=requiresResponseHeader||health?.nativeMediaSession?.version===1;
 }
 async function healthCheck(){
  const response=await fetchImpl('/api/health',{cache:'no-store'});
  if(!response.ok)throw Error('无法核对服务版本，请保留当前页面后重试。');
  const health=await response.json();observe(health);return health;
 }
 async function ready(){if(initial)return;if(!initialPromise)initialPromise=healthCheck().finally(()=>{initialPromise=null;});await initialPromise;}
 function checkResponse({header,status,body}){
  if(header&&header!==initial||requiresResponseHeader&&!header)throw lock(nativeMediaSessionError());
  if(status===409&&body?.code?.startsWith('NATIVE_MEDIA_'))throw lock(nativeMediaSessionError(body.error,body.code));
 }
 async function prepareUpload(headers={}){if(locked)throw locked;await ready();await healthCheck();const value=new Headers(headers);value.set(NATIVE_MEDIA_SESSION_HEADER,initial);return value;}
 async function sessionFetch(url,options={}){
  const parsed=new URL(typeof url==='string'?url:url.url,'http://jingchang.local'),pathname=parsed.pathname,method=String(options.method||'GET').toUpperCase(),recovery=nativeMediaRecoveryOperation(pathname,method);
  if(pathname==='/api/health'&&method==='GET'){
   const response=await fetchImpl(url,{...options,cache:'no-store'});if(response.ok)observe(await response.clone().json());return response;
  }
  if(locked&&!recovery)throw locked;
  if(!recovery){
   await ready();
   if(initial==='1;smart=0'&&method==='PUT'&&/^\/api\/projects\/[^/]+$/.test(pathname)&&typeof options.body==='string'){
    let project;try{project=JSON.parse(options.body);}catch{}
    if(projectUsesModernNativeMedia(project))throw lock(nativeMediaSessionError('当前服务未启用该工程的素材规则。请下载草稿并使用匹配版本，不会自动转换或覆盖原工程。','NATIVE_MEDIA_RULES_UNAVAILABLE'));
   }
   if(!['GET','HEAD'].includes(method))await healthCheck();
  }
  const headers=new Headers(options.headers);if(initial)headers.set(NATIVE_MEDIA_SESSION_HEADER,initial);
  const response=await fetchImpl(url,{...options,headers});
  if(!recovery){
   let body;if(response.status===409)try{body=await response.clone().json();}catch{}
   checkResponse({header:response.headers.get(NATIVE_MEDIA_SESSION_HEADER),status:response.status,body});
   if(response.ok&&initial==='1;smart=0'&&method==='GET'&&/^\/api\/projects\/[^/]+$/.test(pathname)){
    const project=await response.clone().json();if(projectUsesModernNativeMedia(project))throw lock(nativeMediaSessionError('该工程包含当前服务未启用的素材规则，请保留工程并使用匹配版本。','NATIVE_MEDIA_RULES_UNAVAILABLE'));
   }
  }
  return response;
 }
 return {fetch:sessionFetch,prepareUpload,checkResponse,get locked(){return locked;},get token(){return initial;}};
}

let sharedPageSession,sharedMismatchHandler;
export function getNativeMediaPageSession({onMismatch}={}){
 if(onMismatch)sharedMismatchHandler=onMismatch;
 sharedPageSession??=createNativeMediaSession({fetchImpl:(...args)=>globalThis.fetch(...args),onMismatch:error=>sharedMismatchHandler?sharedMismatchHandler(error):showNativeMediaUpdateNotice(error)});
 return sharedPageSession;
}
// Only local API requests join the page session. Media downloads and external
// resources keep their original fetch behavior and receive no compatibility header.
export function nativeMediaFetch(url,options){
 const ownApi=typeof url==='string'&&(url.startsWith('/api/')||typeof location!=='undefined'&&(()=>{try{const u=new URL(url,location.href);return u.origin===location.origin&&u.pathname.startsWith('/api/');}catch{return false;}})());
 return ownApi?getNativeMediaPageSession().fetch(url,options):globalThis.fetch(url,options);
}

export function showNativeMediaUpdateNotice(error,{getDraft=()=>undefined}={}){
 if(document.querySelector('#native-media-update-notice'))return;
 const notice=document.createElement('dialog');notice.id='native-media-update-notice';notice.setAttribute('role','alertdialog');notice.setAttribute('aria-labelledby','native-media-update-title');
 Object.assign(notice.style,{position:'fixed',left:'12px',right:'12px',top:'auto',bottom:'12px',width:'calc(100% - 24px)',boxSizing:'border-box',maxWidth:'660px',margin:'auto',padding:'18px',border:'1px solid #98adbd',borderRadius:'18px',background:'#14252c',color:'#f0ffff',boxShadow:'0 8px 32px #0008',font:'15px/1.6 system-ui',maxHeight:'min(70vh,420px)',overflow:'auto'});
 const title=document.createElement('strong');title.id='native-media-update-title';title.textContent='页面需要更新';
 const message=document.createElement('p');message.textContent=error.message;
 const hint=document.createElement('p');hint.textContent='当前页面和未保存内容仍保留，不会自动刷新或重新提交。任务记录和停止操作仍可用。';
 const actions=document.createElement('div');Object.assign(actions.style,{display:'flex',gap:'10px',flexWrap:'wrap'});
 if(getDraft()!==undefined){const download=document.createElement('button');download.type='button';download.textContent='下载本地草稿';download.onclick=()=>{const draft=getDraft();if(draft===undefined)return;const url=URL.createObjectURL(new Blob([JSON.stringify({format:'jingchang-local-draft',version:1,...draft},null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='镜场-未保存草稿.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);};actions.append(download);}
 const keep=document.createElement('button');keep.type='button';keep.textContent='保留页面继续查看';keep.onclick=()=>notice.close();actions.append(keep);
 const refresh=document.createElement('button');refresh.type='button';refresh.textContent='刷新页面';refresh.onclick=()=>location.reload();actions.append(refresh);
 for(const b of actions.children)Object.assign(b.style,{minHeight:'44px',border:'1px solid #8bc8bd',borderRadius:'10px',background:'#254540',color:'#fff',padding:'8px 14px',font:'inherit',cursor:'pointer'});
 notice.append(title,message,hint,actions);document.body.append(notice);notice.showModal();
}
