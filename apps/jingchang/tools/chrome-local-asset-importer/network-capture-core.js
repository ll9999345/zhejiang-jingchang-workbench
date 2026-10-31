const VIDEO_EXTENSIONS=new Map([
  ['mp4','video/mp4'],['webm','video/webm'],['mov','video/quicktime'],['m4v','video/mp4'],['flv','video/x-flv']
]);
const VIDEO_TYPES=new Map([
  ['video/mp4','mp4'],['video/webm','webm'],['video/quicktime','mov'],['video/x-flv','flv']
]);
const STREAM_TYPES=new Map([
  ['m3u8','HLS'],['mpd','DASH']
]);

function responseMime(responseHeaders=[]){
  const header=responseHeaders.find(item=>String(item?.name||'').toLowerCase()==='content-type');
  return String(header?.value||'').split(';',1)[0].trim().toLowerCase();
}

function filenameFromPath(pathname){
  const raw=pathname.split('/').filter(Boolean).at(-1)||'';
  try{return decodeURIComponent(raw).replace(/[\u0000-\u001f<>:"/\\|?*]/g,'_').slice(0,160);}catch{return raw.replace(/[\u0000-\u001f<>:"/\\|?*]/g,'_').slice(0,160);}
}

export function classifyNetworkResponse(details){
  if(!details||!Number.isInteger(details.statusCode)||details.statusCode<200||details.statusCode>=300)return null;
  let url;try{url=new URL(details.url);}catch{return null;}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return null;
  const extension=url.pathname.toLowerCase().split('.').at(-1)||'';
  const streamType=STREAM_TYPES.get(extension)||'';
  const contentType=responseMime(details.responseHeaders||[]);
  let mediaExtension=VIDEO_EXTENSIONS.get(extension)?extension:VIDEO_TYPES.get(contentType)||'';
  if(!streamType&&!mediaExtension)return null;
  if(!streamType&&contentType&&!VIDEO_TYPES.has(contentType)&&!['application/octet-stream','binary/octet-stream'].includes(contentType))return null;
  if(streamType&&contentType.startsWith('text/html'))return null;
  url.hash='';
  let name=filenameFromPath(url.pathname);
  if(!name)name=streamType?`网页${streamType}清单`:`网页视频.${mediaExtension}`;
  else if(!streamType&&!VIDEO_EXTENSIONS.has(extension))name+=`.${mediaExtension}`;
  return {
    url:url.href,
    kind:'video',
    name,
    source:'network',
    unsupported:!!streamType,
    stream:!!streamType,
    streamType,
    contentType:contentType||VIDEO_EXTENSIONS.get(mediaExtension)||'',
    initiatorOrigin:''
  };
}

function origin(value){try{return new URL(value).origin;}catch{return '';}}

export function shouldCaptureRequest(capture,details,now=Date.now()){
  if(!capture||!details||!Number.isInteger(details.tabId)||details.tabId!==capture.tabId)return false;
  if(!Number.isFinite(capture.expiresAt)||now>=capture.expiresAt)return false;
  const initiator=origin(details.initiator||'');
  if(!initiator||!Array.isArray(capture.initiators)||!capture.initiators.includes(initiator))return false;
  const requestOrigin=origin(details.url||'');
  return !!requestOrigin&&Array.isArray(capture.allowedOrigins)&&capture.allowedOrigins.includes(requestOrigin);
}
