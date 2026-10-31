import './helpers/local-network-only.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {parseLocalHttpsProxy,readLocalHttpsProxy,canUseAiSystemProxy,createAiSystemProxyAgent} from '../lib/ai-system-proxy.mjs';

const DEST={hostname:'miaoapi.xyz',port:443,address:'9.9.9.9',family:4};
const LOCAL={host:'127.0.0.1',port:7897};
const CONFIG='HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7897\n';
const hasCode=code=>error=>error.code===code;
const aborted=error=>error.name==='AbortError';

class FakeSocket extends EventEmitter {
  constructor(){super();this.destroyed=false;this.writes=[];this.paused=false;}
  write(bytes){this.writes.push(String(bytes));return true;}
  pause(){this.paused=true;return this;}
  destroy(error){if(this.destroyed)return this;this.destroyed=true;this.destroyError=error;queueMicrotask(()=>{if(error)this.emit('error',error);this.emit('close');});return this;}
}
class FakeAgent {constructor(options){this.options=options;this.destroyed=false;}destroy(){this.destroyed=true;}}
function transport({header='HTTP/1.1 200 Connection established\r\n\r\n',authorized=true,stage='ready',readError,proxy=LOCAL}={}){
  const state={reads:0,tcpCalls:[],tlsCalls:[],tcp:null,secure:null};
  const hooks={
    readProxy:async({signal})=>{state.reads++;state.signal=signal;if(readError)throw readError;if(stage==='read')return new Promise(()=>{});return proxy;},
    connectTcp:options=>{
      state.tcpCalls.push(options);state.tcp=new FakeSocket();
      queueMicrotask(()=>{
        if(state.tcp.destroyed||stage==='tcp')return;
        state.tcp.emit('connect');
        if(stage==='header')return;
        if(stage==='tcp-error')return state.tcp.emit('error',Error('do not expose proxy detail'));
        for(const part of Array.isArray(header)?header:[header])state.tcp.emit('data',Buffer.from(part));
      });return state.tcp;
    },
    connectTls:options=>{
      state.tlsCalls.push(options);state.secure=new FakeSocket();state.secure.authorized=authorized;
      queueMicrotask(()=>{if(!state.secure.destroyed&&stage!=='tls')state.secure.emit('secureConnect');});return state.secure;
    },AgentClass:FakeAgent,timeoutMs:50,
  };return{state,hooks};
}

test('只读取已启用的 macOS loopback HTTPS 代理，不使用远端、认证或不合法配置',()=>{
  assert.deepEqual(parseLocalHttpsProxy(CONFIG),LOCAL);
  assert.deepEqual(parseLocalHttpsProxy(CONFIG.replace('127.0.0.1','localhost')),LOCAL);
  assert.deepEqual(parseLocalHttpsProxy(CONFIG.replace('127.0.0.1','::1')),{host:'::1',port:7897});
  assert.equal(parseLocalHttpsProxy('HTTPSEnable : 0\nHTTPSProxy : remote.example\n'),null);
  assert.equal(parseLocalHttpsProxy('ProxyAutoConfigEnable : 1\n'),null);
  for(const config of [CONFIG.replace('127.0.0.1','10.0.0.1'),CONFIG.replace('127.0.0.1','proxy.example'),CONFIG.replace('127.0.0.1','user@127.0.0.1'),CONFIG.replace('7897','0'),CONFIG.replace('7897','65536'),CONFIG.replace('7897','443/path'),CONFIG+'HTTPSPort : 7897\n',CONFIG.replace('HTTPSEnable : 1','HTTPSEnable : 2'),'x'.repeat(8193),null])assert.throws(()=>parseLocalHttpsProxy(config),hasCode('AI_PROXY_CONFIG_INVALID'));
  for(const field of ['HTTPSUser','HTTPSUsername','HTTPSPassword','HTTPSAuthentication','HTTPSAuth','ProxyAuthorization'])assert.throws(()=>parseLocalHttpsProxy(CONFIG+field+' : synthetic-secret\n'),error=>error.code==='AI_PROXY_AUTH_REJECTED'&&!error.message.includes('synthetic-secret'));
});

test('scutil 固定命令、1 秒和 8KB 上限，命令失败不暴露输出，也不回退',async()=>{
  let calls=0;
  assert.deepEqual(await readLocalHttpsProxy({platform:'darwin',execFileImpl:(command,args,options,callback)=>{
    calls++;assert.equal(command,'/usr/sbin/scutil');assert.deepEqual(args,['--proxy']);assert.equal(options.timeout,1000);assert.equal(options.maxBuffer,8192);assert.equal(options.encoding,'utf8');callback(null,CONFIG);
  }}),LOCAL);assert.equal(calls,1);
  assert.equal(await readLocalHttpsProxy({platform:'linux',execFileImpl:()=>{throw Error('should not run');}}),null);
  await assert.rejects(readLocalHttpsProxy({platform:'darwin',execFileImpl:(_c,_a,_o,callback)=>callback(Error('secret-token'),CONFIG)}),error=>error.code==='AI_PROXY_CONFIG_UNAVAILABLE'&&!error.message.includes('secret-token'));
  await assert.rejects(readLocalHttpsProxy({platform:'darwin',execFileImpl:()=>{throw Error('secret-token');}}),hasCode('AI_PROXY_CONFIG_UNAVAILABLE'));
  const controller=new AbortController();controller.abort();
  await assert.rejects(readLocalHttpsProxy({signal:controller.signal,platform:'darwin',execFileImpl:()=>{throw Error('should not run');}}),aborted);
});

test('任何私网/fake IP/IPv6/未知域/其他端口在读取代理前被拒绝，测试 hook 也不能绕过',async()=>{
  const invalid=[...['0.0.0.1','10.1.1.1','127.0.0.1','100.64.0.1','169.254.169.254','172.16.0.1','192.0.2.1','192.168.0.1','198.18.0.1','198.19.255.254','198.51.100.1','203.0.113.1','224.0.0.1','255.255.255.255','not-an-ip','::1'].map(address=>({...DEST,address})),{...DEST,family:6},{...DEST,family:'4'},{...DEST,hostname:'miaoapi.xyz.evil.invalid'},{...DEST,hostname:'example.com'},{...DEST,hostname:'MIAOAPI.XYZ'},{...DEST,port:8443},{...DEST,signal:{}}];
  for(const destination of invalid){let reads=0;await assert.rejects(createAiSystemProxyAgent(destination,{readProxy:()=>{reads++;return LOCAL;}}),hasCode('AI_PROXY_DESTINATION_REJECTED'));assert.equal(reads,0);}
  assert.equal(canUseAiSystemProxy(DEST.hostname,443,{family:4}),true);
  assert.equal(canUseAiSystemProxy(DEST.hostname,443,{family:6}),false);
  for(const hostname of ['miaoapi.xyz','ark.cn-beijing.volces.com','cloudflare-dns.com']){
    const {state,hooks}=transport({proxy:null});assert.equal(await createAiSystemProxyAgent({...DEST,hostname},hooks),false);assert.equal(state.tcpCalls.length,0);
  }
});

test('CONNECT 只有公开 IP:443，TLS 固定真实域并强制验证证书，Agent 不复用也不改目的地',async()=>{
  const {state,hooks}=transport({header:['HTTP/1.1 200 Connection',' established\r\nX-Proxy: local\r\n\r\n']});
  const agent=await createAiSystemProxyAgent(DEST,hooks);
  assert.equal(state.reads,1);assert.deepEqual(state.tcpCalls,[LOCAL]);
  assert.deepEqual(state.tcp.writes,['CONNECT 9.9.9.9:443 HTTP/1.1\r\nHost: 9.9.9.9:443\r\n\r\n']);
  assert.ok(!state.tcp.writes[0].includes(DEST.hostname));assert.ok(!/authorization|Bearer|\/v1|api.key/i.test(state.tcp.writes[0]));
  assert.equal(state.tcp.paused,true);assert.equal(state.tlsCalls.length,1);
  assert.deepEqual(state.tlsCalls[0],{socket:state.tcp,host:DEST.hostname,servername:DEST.hostname,rejectUnauthorized:true,minVersion:'TLSv1.2',ALPNProtocols:['http/1.1']});
  assert.deepEqual(agent.options,{keepAlive:false,maxSockets:1});
  const options={host:DEST.hostname,servername:DEST.hostname,port:443};
  assert.equal(agent.createConnection(options),state.secure);
  assert.throws(()=>agent.createConnection(options),hasCode('AI_PROXY_DESTINATION_REJECTED'));assert.equal(state.secure.destroyed,true);
  const other=transport(),agent2=await createAiSystemProxyAgent(DEST,other.hooks);
  assert.throws(()=>agent2.createConnection({...options,host:'ark.cn-beijing.volces.com'}),hasCode('AI_PROXY_DESTINATION_REJECTED'));agent2.destroy();assert.equal(other.state.tcp.destroyed,true);
});

test('代理错误、重定向、认证要求、异常或超限头不连接 TLS、不再次连接，也不直连',async()=>{
  const headers=['HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n','HTTP/1.1 302 Found\r\nLocation: https://evil.invalid\r\n\r\n','HTTP/1.1 200 OK\r\nLocation: https://evil.invalid\r\n\r\n','HTTP/1.1 200 OK\r\nProxy-Authenticate: Basic\r\n\r\n','HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n','HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\n','HTTP/1.1 200 OK\r\nX-A: x\r\nX-A: y\r\n\r\n','HTTP/1.1 200 OK\n\n','HTTP/1.1 200 OK\r\n\r\nextra','HTTP/1.1 200 OK\r\nX-Big: '+'x'.repeat(8192)+'\r\n\r\n'];
  for(const header of headers){const {state,hooks}=transport({header});await assert.rejects(createAiSystemProxyAgent(DEST,hooks),error=>['AI_PROXY_CONNECT_REJECTED','AI_PROXY_HEADER_LIMIT','AI_PROXY_TIMEOUT'].includes(error.code));assert.equal(state.reads,1);assert.equal(state.tcpCalls.length,1);assert.equal(state.tlsCalls.length,0);assert.equal(state.tcp.destroyed,true);}
  for(const proxy of [{host:'proxy.example',port:7897},{...LOCAL,username:'secret'},false]){const {state,hooks}=transport({proxy});await assert.rejects(createAiSystemProxyAgent(DEST,hooks),hasCode('AI_PROXY_CONFIG_INVALID'));assert.equal(state.tcpCalls.length,0);}
  const failed=transport({readError:Error('synthetic-sensitive-config')});await assert.rejects(createAiSystemProxyAgent(DEST,failed.hooks),error=>error.code==='AI_PROXY_CONFIG_UNAVAILABLE'&&!error.message.includes('synthetic-sensitive-config'));assert.equal(failed.state.reads,1);assert.equal(failed.state.tcpCalls.length,0);
  const broken=transport({stage:'tcp-error'});await assert.rejects(createAiSystemProxyAgent(DEST,broken.hooks),hasCode('AI_PROXY_CONNECTION_FAILED'));assert.equal(broken.state.tcpCalls.length,1);assert.equal(broken.state.tlsCalls.length,0);
  const invalidTls=transport({authorized:false});await assert.rejects(createAiSystemProxyAgent(DEST,invalidTls.hooks),hasCode('AI_PROXY_TLS_REJECTED'));assert.equal(invalidTls.state.secure.destroyed,true);
});

test('取消和总超时覆盖配置读取、TCP、CONNECT 和 TLS，已交接连接取消仍关闭',async()=>{
  for(const stage of ['read','tcp','header','tls']){
    const controller=new AbortController(),{state,hooks}=transport({stage});
    const pending=createAiSystemProxyAgent({...DEST,signal:controller.signal},hooks);setTimeout(()=>controller.abort(),5);
    await assert.rejects(pending,aborted);assert.equal(state.signal.aborted,true);assert.ok(!state.tcp||state.tcp.destroyed);assert.ok(!state.secure||state.secure.destroyed);assert.ok(state.tcpCalls.length<=1);
    const timed=transport({stage});await assert.rejects(createAiSystemProxyAgent(DEST,{...timed.hooks,timeoutMs:10}),hasCode('AI_PROXY_TIMEOUT'));assert.equal(timed.state.signal.aborted,true);assert.ok(!timed.state.tcp||timed.state.tcp.destroyed);assert.ok(!timed.state.secure||timed.state.secure.destroyed);
  }
  const controller=new AbortController(),done=transport();await createAiSystemProxyAgent({...DEST,signal:controller.signal},done.hooks);controller.abort();assert.equal(done.state.secure.destroyed,true);assert.equal(done.state.secure.destroyError.name,'AbortError');
  let reads=0;const cancelled=new AbortController();cancelled.abort();await assert.rejects(createAiSystemProxyAgent({...DEST,signal:cancelled.signal},{readProxy:()=>{reads++;return LOCAL;}}),aborted);assert.equal(reads,0);
});
