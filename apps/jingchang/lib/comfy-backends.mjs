import {isIP} from 'node:net';
import {safeId,textValue,userError} from './workspace.mjs';
export function backendAddress(value){
 let u;try{u=new URL(value);}catch{throw userError('ComfyUI 地址无效');}
 if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw userError('ComfyUI 地址须为不含凭据或查询参数的 HTTP/HTTPS 地址');
 const host=u.hostname.replace(/^\[|\]$/g,''),octets=host.split('.').map(Number),local=host==='localhost'||host==='::1'||isIP(host)===4&&octets[0]===127;
 const lan=isIP(host)===4&&(octets[0]===10||octets[0]===172&&octets[1]>=16&&octets[1]<=31||octets[0]===192&&octets[1]===168);
 if(!local&&!lan)throw userError('ComfyUI 仅支持本机或明确的局域网IPv4地址，不支持公网、域名、链路本地或元数据地址');
 return {url:u.href.replace(/\/+$/,''),network:local?'local':'lan'};
}
export function backendState(config){const backends=config.comfyBackends?.length?config.comfyBackends:[{id:'default-local',name:'默认 ComfyUI',...backendAddress(config.comfyUrl||'http://127.0.0.1:8188')}];return{revision:config.revision||0,backends,activeId:config.activeComfyBackendId||backends[0].id};}
export function updateBackends(config,body){
 if(body.revision!==(config.revision||0))throw userError('设置已在另一窗口修改，请重新打开',409);
 if(!Array.isArray(body.backends)||body.backends.length<1||body.backends.length>16)throw userError('请保留1–16个ComfyUI后端');const old=backendState(config),ids=new Set(),urls=new Set();
 const backends=body.backends.map(b=>{if(!b||!safeId(b.id)||ids.has(b.id))throw userError('后端编号无效或重复');ids.add(b.id);const address=backendAddress(b.url);if(urls.has(address.url))throw userError('后端地址重复');urls.add(address.url);const previous=old.backends.find(x=>x.id===b.id&&x.url===address.url&&x.lanAuthorized===true);if(address.network==='lan'&&!previous&&!(Array.isArray(body.lanConsentUrls)&&body.lanConsentUrls.includes(address.url)))throw userError('请明确确认向该局域网地址发送工作流和所选素材');return{id:b.id,name:textValue(b.name,80,'后端名称'),...address,...(address.network==='lan'?{lanAuthorized:true}:{})};});
 if(!ids.has(body.activeId))throw userError('请选择存在的默认后端');return {...config,comfyBackends:backends,activeComfyBackendId:body.activeId,comfyUrl:backends.find(b=>b.id===body.activeId).url,revision:(config.revision||0)+1};
}
export function selectBackend(config,id){const state=backendState(config),b=state.backends.find(b=>b.id===(id||state.activeId));if(!b)throw userError('后端不存在，请重新选择');const address=backendAddress(b.url);if(address.network==='lan'&&b.lanAuthorized!==true)throw userError('局域网后端尚未授权');return{id:b.id,name:b.name,...address,...(address.network==='lan'?{lanAuthorized:true}:{})};}
export function selectCanvasBackends(config,body){
 const selected=selectBackend(config,body.backendId),ids=body.parallelBackendIds;
 if(ids===undefined)return selected;
 if(!Array.isArray(ids)||ids.length<1||ids.length>6||new Set(ids).size!==ids.length||ids.some(id=>!safeId(id)))throw userError('并行循环请选择1–6个不同的已保存后端');
 const parallelBackends=ids.map(id=>selectBackend(config,id));
 if(new Set(parallelBackends.map(backend=>backend.url)).size!==parallelBackends.length)throw userError('并行循环后端地址不能重复');
 return{...selected,parallelBackends};
}
// Plain strings preserve old loopback-only behavior. LAN requires an explicitly saved descriptor.
export function resolvedBackend(endpoint){if(endpoint&&typeof endpoint==='object'&&!(endpoint instanceof URL)){const address=backendAddress(endpoint.url);if(address.network==='lan'&&endpoint.lanAuthorized!==true)throw userError('局域网后端尚未授权');return new URL(address.url);}return null;}
export function updateLegacyComfy(config,url){const state=backendState(config),active=selectBackend(config);const address=backendAddress(url);if(state.backends.some(b=>b.id!==state.activeId&&b.url===address.url))throw userError('后端地址重复');if(address.url!==active.url&&address.network!=='local')throw userError('新增局域网地址请使用“管理ComfyUI后端”并确认发送范围');return{...config,comfyUrl:address.url,...(config.comfyBackends?{comfyBackends:state.backends.map(b=>b.id===state.activeId?{id:b.id,name:b.name,...address,...(address.network==='lan'?{lanAuthorized:true}:{})}:b)}:{})};}
