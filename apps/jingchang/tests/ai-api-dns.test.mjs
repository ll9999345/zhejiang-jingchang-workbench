import './helpers/local-network-only.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import childProcess from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {syncBuiltinESMExports} from 'node:module';
import {ImageApiError,prepareApiDestination,createPinnedLookup,safeApiCall} from '../lib/image-api.mjs';

const TARGETS=['https://miaoapi.xyz/v1','https://ark.cn-beijing.volces.com/api/v3'];
const FAKE=[{address:'198.18.0.1',family:4},{address:'198.19.255.254',family:4}];
const PUBLIC4={address:'1.1.1.1',family:4},PUBLIC6={address:'2606:4700:4700::1111',family:6};
const forbidden=error=>error instanceof ImageApiError&&error.code==='private_destination';
const aborted=error=>error.name==='AbortError';

function harness(systemRecords,options={}){
  const resolved=Object.hasOwn(options,'resolved')?options.resolved:[PUBLIC4,PUBLIC6],lookupFailure=options.lookupFailure;
  const calls={lookup:[],resolver:[]};
  return{calls,lookupImpl:async(...args)=>{calls.lookup.push(args);if(lookupFailure)throw lookupFailure;return systemRecords;},publicResolver:async(...args)=>{calls.resolver.push(args);return resolved;}};
}
function callbackResult(lookup,options){
  return new Promise((resolve,reject)=>lookup('host-not-looked-up.invalid',options,(error,...values)=>error?reject(error):resolve(values)));
}

test('正常公网 IPv4/IPv6 系统解析不走独立解析器，并要求 all/verbatim 后只选择一个地址',async()=>{
  for(const target of [...TARGETS,'https://unlisted-ai.example/v1']){
    const h=harness([PUBLIC4,PUBLIC6]);assert.deepEqual(await prepareApiDestination(target,h),PUBLIC4);
    assert.deepEqual(h.calls.lookup,[[new URL(target).hostname,{all:true,verbatim:true}]]);assert.equal(h.calls.resolver.length,0);
    const v6=harness([PUBLIC6,PUBLIC4]);assert.deepEqual(await prepareApiDestination(target,v6),PUBLIC6);assert.equal(v6.calls.resolver.length,0);
  }
});

test('启用本机代理时，生产 DNS 回退和 API 各做一次公开 IP CONNECT，TLS 完成后 API 认证头保持原值', {concurrency:false},async t=>{
  const calls=[],connections=[],key='synthetic-secret-not-a-real-key',selected={address:'9.9.9.9',family:4};
  let proxyReads=0;
  const lookupMock=t.mock.method(dns,'lookup',async()=>structuredClone(FAKE));
  const proxyMock=t.mock.method(childProcess,'execFile',(command,args,_options,callback)=>{
    assert.equal(command,'/usr/sbin/scutil');assert.deepEqual(args,['--proxy']);proxyReads++;
    queueMicrotask(()=>callback(null,'HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7897\n'));return new EventEmitter();
  });
  const tcpMock=t.mock.method(net,'connect',options=>{
    assert.deepEqual(options,{host:'127.0.0.1',port:7897});
    const socket=new EventEmitter();socket.destroyed=false;socket.writes=[];socket.pause=()=>socket;
    socket.destroy=error=>{if(socket.destroyed)return socket;socket.destroyed=true;queueMicrotask(()=>{if(error)socket.emit('error',error);socket.emit('close');});return socket;};
    socket.write=bytes=>{socket.writes.push(String(bytes));queueMicrotask(()=>{if(!socket.destroyed)socket.emit('data',Buffer.from('HTTP/1.1 200 Connection established\r\n\r\n'));});return true;};
    connections.push({options,socket,tls:null});queueMicrotask(()=>socket.emit('connect'));return socket;
  });
  const tlsMock=t.mock.method(tls,'connect',options=>{
    const entry=connections.find(row=>row.socket===options.socket);assert.ok(entry);entry.tls=options;
    const socket=new EventEmitter();socket.authorized=true;socket.destroyed=false;
    socket.destroy=error=>{if(socket.destroyed)return socket;socket.destroyed=true;queueMicrotask(()=>{if(error)socket.emit('error',error);socket.emit('close');});return socket;};
    entry.secure=socket;queueMicrotask(()=>socket.emit('secureConnect'));return socket;
  });
  const requestMock=t.mock.method(https,'request',(...args)=>{
    const isDoh=args[0] instanceof URL,url=isDoh?args[0]:null,options=isDoh?args[1]:args[0],callback=isDoh?args[2]:args[1],host=url?.hostname||options.hostname;
    const entry=connections.at(-1);assert.ok(entry.secure.authorized);assert.ok(options.agent instanceof https.Agent);
    assert.equal(options.agent.createConnection({host,servername:host,port:443}),entry.secure);
    const req=new EventEmitter();req.destroyed=false;req.destroy=()=>{req.destroyed=true;return req;};req.write=()=>{throw Error('GET must not write a body');};
    calls.push({isDoh,host,options});
    req.end=()=>{queueMicrotask(()=>{
      const payload=isDoh?{Status:0,TC:false,Question:[{name:url.searchParams.get('name'),type:1}],Answer:[{name:url.searchParams.get('name'),type:1,TTL:60,data:selected.address}]}:{data:[{id:'synthetic-model',object:'model'}]};
      const bytes=Buffer.from(JSON.stringify(payload)),incoming=Readable.from([bytes]);incoming.statusCode=200;incoming.complete=true;incoming.headers={'content-type':isDoh?'application/dns-json':'application/json','content-length':String(bytes.length)};callback(incoming);
    });return req;};return req;
  });
  syncBuiltinESMExports();
  try{
    for(const baseUrl of TARGETS)assert.deepEqual(await safeApiCall({baseUrl,path:'models',apiKey:key,method:'GET'}),{data:[{id:'synthetic-model',object:'model'}]});
    assert.equal(proxyReads,4);assert.equal(calls.length,4);assert.equal(connections.length,4);
    for(let index=0;index<connections.length;index++){
      const entry=connections[index],call=calls[index],address=call.isDoh?'1.1.1.1':selected.address;
      assert.deepEqual(entry.socket.writes,[`CONNECT ${address}:443 HTTP/1.1\r\nHost: ${address}:443\r\n\r\n`]);
      assert.ok(!entry.socket.writes.join('').includes(key));assert.ok(!entry.socket.writes.join('').includes(call.host));
      assert.equal(entry.tls.host,call.host);assert.equal(entry.tls.servername,call.host);assert.equal(entry.tls.rejectUnauthorized,true);assert.equal(entry.tls.minVersion,'TLSv1.2');
      assert.equal(call.options.servername,call.host);assert.equal(call.options.rejectUnauthorized,true);
      assert.deepEqual(call.isDoh?call.options.headers:{authorization:call.options.headers.authorization},call.isDoh?{accept:'application/dns-json'}:{authorization:'Bearer '+key});
    }
  }finally{
    for(const entry of connections)entry.secure?.destroy();
    requestMock.mock.restore();tlsMock.mock.restore();tcpMock.mock.restore();lookupMock.mock.restore();proxyMock.mock.restore();syncBuiltinESMExports();
  }
});

test('两个固定 HTTPS 目标全部命中 198.18/15 时允许一次独立解析，仍只钉住首个合法公网 IP',async()=>{
  for(const target of TARGETS){
    const system=structuredClone(FAKE),before=structuredClone(system),h=harness(system),selected=await prepareApiDestination(target,h);assert.deepEqual(selected,PUBLIC4);
    assert.equal(h.calls.lookup.length,1);assert.equal(h.calls.resolver.length,1);assert.ok(h.calls.resolver[0][0] instanceof URL);assert.equal(h.calls.resolver[0][0].href,new URL(target).href);assert.equal(h.calls.resolver[0][1],system);assert.deepEqual(system,before);
    const pinned=createPinnedLookup(selected);assert.deepEqual(await callbackResult(pinned,{all:true}),[[PUBLIC4]]);assert.equal(h.calls.resolver.length,1);
  }
});

test('独立解析器只收到 URL、原系统地址记录和 signal，不收到认证、请求头或请求体',async()=>{
  const controller=new AbortController(),h=harness(structuredClone(FAKE));
  assert.deepEqual(await prepareApiDestination(TARGETS[0],{...h,signal:controller.signal}),PUBLIC4);
  const args=h.calls.resolver[0];assert.equal(args.length,3);assert.ok(args[0] instanceof URL);assert.equal(args[0].username,'');assert.equal(args[0].password,'');assert.equal(args[0].search,'');assert.equal(args[0].hash,'');assert.deepEqual(Object.keys(args[2]),['signal']);assert.equal(args[2].signal,controller.signal);
  assert.ok(args[1].every(record=>Object.keys(record).sort().join(',')==='address,family'));
  for(const value of [...Object.keys(args[2]),...args[1].flatMap(Object.keys)])assert.ok(!/auth|key|body|header/i.test(value));
});

test('假地址与正常地址混合或假地址 family 错误时，不允许回退并拒绝整个解析结果',async()=>{
  for(const records of [[FAKE[0],PUBLIC4],[PUBLIC4,FAKE[0]],[FAKE[0],PUBLIC6],[{address:FAKE[0].address,family:6}]]){
    const h=harness(records);await assert.rejects(prepareApiDestination(TARGETS[0],h),forbidden);assert.equal(h.calls.resolver.length,0);
  }
});

test('未知域名、相似域名和非默认端口上的假地址不触发独立解析',async()=>{
  for(const target of ['https://unlisted-ai.example/v1','https://miaoapi.xyz.evil.invalid/v1','https://ark.cn-beijing.volces.com.evil.invalid/api/v3','https://miaoapi.xyz:8443/v1','https://ark.cn-beijing.volces.com:8443/api/v3']){
    const h=harness(structuredClone(FAKE));await assert.rejects(prepareApiDestination(target,h),forbidden);assert.equal(h.calls.lookup.length,1);assert.equal(h.calls.resolver.length,0);
  }
});

test('公共目标 HTTP 在解析前拒绝，显式本机 HTTP 保持原有直连且无 DNS 回退',async()=>{
  for(const target of ['http://miaoapi.xyz/v1','http://ark.cn-beijing.volces.com/api/v3']){
    const h=harness(FAKE);await assert.rejects(prepareApiDestination(target,h),error=>error instanceof ImageApiError&&error.code==='insecure_base_url');assert.equal(h.calls.lookup.length,0);assert.equal(h.calls.resolver.length,0);
  }
  const h=harness(FAKE);assert.equal(await prepareApiDestination('http://127.0.0.1:8188/v1',h),null);assert.equal(h.calls.lookup.length,0);assert.equal(h.calls.resolver.length,0);
});

test('系统 DNS 失败不能变成公共回退，也不自动再次解析',async()=>{
  for(const target of TARGETS){
    const h=harness(FAKE,{lookupFailure:Error('synthetic system lookup failure')});await assert.rejects(prepareApiDestination(target,h),error=>error instanceof ImageApiError&&error.code==='network_error'&&/无法解析/.test(error.message));assert.equal(h.calls.lookup.length,1);assert.equal(h.calls.resolver.length,0);
  }
});

test('198.18/15 之外的合法 IPv4 不触发假地址回退',async()=>{
  for(const address of ['198.17.255.255','198.20.0.0']){
    const record={address,family:4},h=harness([record]);assert.deepEqual(await prepareApiDestination(TARGETS[0],h),record);assert.equal(h.calls.resolver.length,0);
  }
});

test('公共回退返回私网、元数据、保留地址、非法 IP、family 混杂或空结果时全部拒绝',async()=>{
  const results=[
    [{address:'10.0.0.1',family:4}],[{address:'127.0.0.1',family:4}],[{address:'169.254.169.254',family:4}],
    [{address:'192.168.1.1',family:4}],[{address:'198.18.0.2',family:4}],[{address:'203.0.113.1',family:4}],
    [{address:'::1',family:6}],[{address:'fd00::1',family:6}],[{address:'2001:db8::1',family:6}],
    [{address:'not-an-ip',family:4}],[{address:'999.1.1.1',family:4}],[{address:PUBLIC4.address,family:6}],
    [{address:PUBLIC6.address,family:4}],[{address:PUBLIC4.address,family:'4'}],
    [PUBLIC4,{address:'10.0.0.1',family:4}],[PUBLIC4,{address:PUBLIC6.address,family:4}],[PUBLIC4,null],
    [PUBLIC4,,],Array(1),[],null,undefined,{},
  ];
  for(const resolved of results){
    const h=harness(structuredClone(FAKE),{resolved});await assert.rejects(prepareApiDestination(TARGETS[0],h),forbidden,JSON.stringify(resolved));assert.equal(h.calls.lookup.length,1);assert.equal(h.calls.resolver.length,1);
  }
});

test('原系统记录空或不合法时拒绝，不借公共解析器补救',async()=>{
  for(const records of [[],null,undefined,{},[null],Array(1),[PUBLIC4,,],[{address:'not-an-ip',family:4}],[PUBLIC4,{address:PUBLIC6.address,family:4}]]){
    const h=harness(records);await assert.rejects(prepareApiDestination(TARGETS[0],h),forbidden);assert.equal(h.calls.resolver.length,0);
  }
});

test('独立解析器自身失败只执行一次，不隐藏失败或回退到原假地址',async()=>{
  const h=harness(FAKE),failure=Error('synthetic resolver failure');let resolverCalls=0;
  await assert.rejects(prepareApiDestination(TARGETS[0],{...h,publicResolver:async()=>{resolverCalls++;throw failure;}}),error=>error===failure);
  assert.equal(resolverCalls,1);assert.equal(h.calls.lookup.length,1);
});

test('预先取消在系统解析前停止，不调用任何解析器',async()=>{
  const controller=new AbortController();controller.abort();const h=harness(FAKE);
  await assert.rejects(prepareApiDestination(TARGETS[0],{...h,signal:controller.signal}),aborted);assert.equal(h.calls.lookup.length,0);assert.equal(h.calls.resolver.length,0);
});

test('系统解析中途取消在回退前停止，包括系统解析失败后的取消',async()=>{
  for(const rejectLookup of [false,true]){
    const controller=new AbortController();let lookups=0,resolvers=0;
    await assert.rejects(prepareApiDestination(TARGETS[0],{signal:controller.signal,lookupImpl:async()=>{lookups++;controller.abort();if(rejectLookup)throw Error('synthetic aborted lookup');return FAKE;},publicResolver:async()=>{resolvers++;return[PUBLIC4];}}),aborted);
    assert.equal(lookups,1);assert.equal(resolvers,0);
  }
});

test('公共解析中途取消后丢弃已返回 IP，不继续建立钉住地址',async()=>{
  const controller=new AbortController(),h=harness(FAKE);let resolvers=0;
  await assert.rejects(prepareApiDestination(TARGETS[0],{...h,signal:controller.signal,publicResolver:async(_url,_records,{signal})=>{resolvers++;assert.equal(signal,controller.signal);controller.abort();return[PUBLIC4];}}),aborted);
  assert.equal(h.calls.lookup.length,1);assert.equal(resolvers,1);
});

test('createPinnedLookup 的 normal/all 回调始终只有选定 IP，输入或旧返回值变动不改钉住结果',async()=>{
  for(const original of [PUBLIC4,PUBLIC6]){
    const selected={...original},lookup=createPinnedLookup(selected);selected.address='8.8.8.8';selected.family=4;
    assert.deepEqual(await callbackResult(lookup,{}),[original.address,original.family]);assert.deepEqual(await callbackResult(lookup,4),[original.address,original.family]);
    const all=await callbackResult(lookup,{all:true});assert.deepEqual(all,[[original]]);all[0][0].address='9.9.9.9';all[0].push({address:'8.8.8.8',family:4});
    assert.deepEqual(await callbackResult(lookup,{all:true}),[[original]]);assert.deepEqual(await callbackResult(lookup,{all:false}),[original.address,original.family]);
  }
});

test('createPinnedLookup 拒绝私网、假 IP、非法地址、错误 family 和空输入',()=>{
  for(const pinned of [null,undefined,{}, {address:'not-an-ip',family:4},{address:PUBLIC4.address,family:6},{address:PUBLIC4.address,family:'4'},
    {address:'10.0.0.1',family:4},{address:'127.0.0.1',family:4},{address:'169.254.169.254',family:4},{address:'198.18.0.1',family:4},{address:'::1',family:6},{address:'2001:db8::1',family:6}])assert.throws(()=>createPinnedLookup(pinned),forbidden);
});

test('无本机 HTTPS 代理时，生产 safeApiCall 的 DNS 回退和 HTTPS 保持原直连、原域名及 TLS，并只连接单个公网 IP', {concurrency:false},async t=>{
  const calls=[],dnsCalls=[],key='synthetic-production-transport-only',selected={address:'9.9.9.9',family:4};
  const lookupMock=t.mock.method(dns,'lookup',async(host,options)=>{dnsCalls.push({host,options});assert.ok(TARGETS.some(target=>new URL(target).hostname===host));return structuredClone(FAKE);});
  const proxyMock=t.mock.method(childProcess,'execFile',(command,args,_options,callback)=>{assert.equal(command,'/usr/sbin/scutil');assert.deepEqual(args,['--proxy']);queueMicrotask(()=>callback(null,'HTTPSEnable : 0\n'));return new EventEmitter();});
  const requestMock=t.mock.method(https,'request',(...args)=>{
    const isDoh=args[0] instanceof URL;
    const url=isDoh?args[0]:null,options=isDoh?args[1]:args[0],callback=isDoh?args[2]:args[1],host=url?.hostname||options.hostname;
    assert.ok(isDoh?host==='cloudflare-dns.com':TARGETS.some(target=>new URL(target).hostname===host),'fake transport rejects every unexpected host');
    const entry={isDoh,url:url?.href||null,host,options,writes:[],allLookup:null,normalLookup:null};calls.push(entry);
    // Simulate both Node lookup callback modes without allowing a real socket.
    options.lookup(host,{all:true},(error,...values)=>{assert.equal(error,null);entry.allLookup=values;});
    options.lookup(host,{family:4},(error,...values)=>{assert.equal(error,null);entry.normalLookup=values;});
    const req=new EventEmitter();req.destroyed=false;req.write=bytes=>{entry.writes.push(Buffer.from(bytes));return true;};
    req.destroy=error=>{if(req.destroyed)return req;req.destroyed=true;if(error)queueMicrotask(()=>req.emit('error',error));return req;};
    req.end=bytes=>{
      if(bytes!==undefined)req.write(bytes);
      queueMicrotask(()=>{
        if(req.destroyed)return;
        const original=isDoh?url.searchParams.get('name'):host;
        const payload=isDoh?{Status:0,TC:false,Question:[{name:original,type:1}],Answer:[{name:original,type:1,TTL:60,data:selected.address},{name:original,type:1,TTL:60,data:'8.8.8.8'}]}:{data:[{id:'self-created-model',object:'model'}]};
        const bytes=Buffer.from(JSON.stringify(payload)),incoming=Readable.from([bytes]);incoming.statusCode=200;incoming.complete=true;incoming.headers={'content-type':isDoh?'application/dns-json':'application/json','content-length':String(bytes.length)};callback(incoming);
      });
      return req;
    };
    return req;
  });
  // Update the production modules' named imports to the fake functions, then
  // restore and re-sync even if an assertion or production request fails.
  syncBuiltinESMExports();
  try{
    for(const baseUrl of TARGETS){
      assert.deepEqual(await safeApiCall({baseUrl,path:'models',apiKey:key,method:'GET'}),{data:[{id:'self-created-model',object:'model'}]});
    }
    assert.equal(dnsCalls.length,2);assert.ok(dnsCalls.every(call=>call.options.all===true&&call.options.verbatim===true));assert.equal(calls.length,4);
    const doh=calls.filter(call=>call.isDoh),api=calls.filter(call=>!call.isDoh);assert.equal(doh.length,2);assert.equal(api.length,2);
    for(const entry of doh){
      const url=new URL(entry.url);assert.equal(url.origin,'https://cloudflare-dns.com');assert.equal(url.pathname,'/dns-query');assert.equal(url.searchParams.get('type'),'A');assert.deepEqual([...url.searchParams.keys()].sort(),['name','type']);assert.ok(TARGETS.some(target=>new URL(target).hostname===url.searchParams.get('name')));
      assert.equal(entry.options.agent,false);assert.equal(entry.options.rejectUnauthorized,true);assert.equal(entry.options.servername,'cloudflare-dns.com');assert.equal(entry.options.method,'GET');assert.deepEqual(entry.options.headers,{accept:'application/dns-json'});assert.equal(entry.writes.length,0);
      assert.deepEqual(entry.allLookup,[[{address:'1.1.1.1',family:4}]]);assert.deepEqual(entry.normalLookup,['1.1.1.1',4]);assert.ok(!JSON.stringify({url:entry.url,headers:entry.options.headers,writes:entry.writes}).includes(key));
    }
    for(let index=0;index<api.length;index++){
      const entry=api[index],target=new URL(TARGETS[index]);assert.equal(entry.options.protocol,'https:');assert.equal(entry.options.hostname,target.hostname);assert.equal(entry.options.servername,target.hostname);assert.equal(Number(entry.options.port),443);assert.equal(entry.options.path,target.pathname+'/models');assert.equal(entry.options.method,'GET');assert.equal(entry.options.agent,false);assert.equal(entry.options.rejectUnauthorized,true);assert.equal(entry.options.headers.authorization,'Bearer '+key);assert.equal(entry.writes.length,0);
      assert.deepEqual(entry.allLookup,[[selected]]);assert.deepEqual(entry.normalLookup,[selected.address,selected.family]);
    }
  }finally{requestMock.mock.restore();lookupMock.mock.restore();proxyMock.mock.restore();syncBuiltinESMExports();}
});
