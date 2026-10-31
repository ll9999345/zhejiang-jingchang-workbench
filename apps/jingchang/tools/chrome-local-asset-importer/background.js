import {classifyNetworkResponse,shouldCaptureRequest} from './network-capture-core.js';

const CAPTURE_MS=60_000;
const MAX_CANDIDATES=120;
let capture=null;
let capturePort=null;
let listenersRegistered=false;

function send(port,message){try{port?.postMessage(message);}catch{}}

function stopCapture(reason='stopped'){
  const previous=capture;
  capture=null;
  if(listenersRegistered){
    try{chrome.webRequest.onHeadersReceived.removeListener(onHeadersReceived);}catch{}
    listenersRegistered=false;
  }
  if(previous)send(previous.port,{type:'capture-stopped',reason});
}

function onHeadersReceived(details){
  const current=capture;
  if(!shouldCaptureRequest(current,details))return;
  if(!['media','xmlhttprequest','other'].includes(details.type))return;
  const candidate=classifyNetworkResponse(details);if(!candidate)return;
  const initiatorOrigin=new URL(details.initiator).origin;
  candidate.initiatorOrigin=initiatorOrigin;
  if(current.seen.has(candidate.url))return;
  if(current.items>=MAX_CANDIDATES){stopCapture('limit');return;}
  current.seen.add(candidate.url);current.items++;
  send(current.port,{type:'candidate',item:candidate});
}

async function startCapture(port,message){
  stopCapture('replaced');
  const tabId=message?.tabId;
  const allowedOrigins=[...new Set(Array.isArray(message?.allowedOrigins)?message.allowedOrigins.filter(value=>typeof value==='string'&&/^https?:\/\//.test(value)):[])].slice(0,12);
  const initiators=[...new Set(Array.isArray(message?.initiators)?message.initiators.filter(value=>typeof value==='string'&&/^https?:\/\//.test(value)):[])].slice(0,12);
  if(!Number.isInteger(tabId)||tabId<0||!allowedOrigins.length||!initiators.length){send(port,{type:'capture-error',message:'当前页面没有可监听的网页来源'});return;}
  let granted=false;
  try{granted=await chrome.permissions.contains({permissions:['webRequest'],origins:allowedOrigins.map(value=>value+'/*')});}catch{}
  if(!granted){send(port,{type:'capture-error',message:'尚未获得网络请求监听权限'});return;}
  capture={tabId,allowedOrigins,initiators,expiresAt:Date.now()+CAPTURE_MS,items:0,seen:new Set(),port};
  capturePort=port;
  try{
    chrome.webRequest.onHeadersReceived.addListener(onHeadersReceived,{urls:['http://*/*','https://*/*'],types:['media','xmlhttprequest','other']},['responseHeaders']);
    listenersRegistered=true;
  }catch{
    capture=null;capturePort=null;
    send(port,{type:'capture-error',message:'Chrome 当前无法监听网页网络请求'});return;
  }
  send(port,{type:'capture-started',expiresAt:capture.expiresAt});
}

chrome.runtime.onConnect.addListener(port=>{
  if(port.name!=='network-capture'){port.disconnect();return;}
  port.onMessage.addListener(message=>{
    if(message?.type==='start')void startCapture(port,message);
    else if(message?.type==='stop'&&capturePort===port)stopCapture('user');
  });
  port.onDisconnect.addListener(()=>{if(capturePort===port){stopCapture('panel-closed');capturePort=null;}});
});

