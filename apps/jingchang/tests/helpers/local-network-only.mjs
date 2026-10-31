// Preload only in isolated browser-test servers. A mistaken UI default must
// never turn a synthetic fixture into a request to a real provider.
import http from 'node:http';
import https from 'node:https';
import {syncBuiltinESMExports} from 'node:module';
const local=hostname=>['127.0.0.1','localhost','[::1]','::1'].includes(hostname);
const assertLocal=value=>{const url=new URL(typeof value==='string'||value instanceof URL?value:value.url);if(!local(url.hostname)||!['http:','https:'].includes(url.protocol))throw Error('Browser test permits loopback network only');};
const realFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{assertLocal(input);return realFetch(input,init);};
for(const [mod,protocol] of [[http,'http:'],[https,'https:']]){const request=mod.request;mod.request=function(input,...args){if(typeof input==='string'||input instanceof URL)assertLocal(input);else assertLocal(protocol+'//'+(input.hostname||input.host||'localhost'));const opts=args[0];if(opts&&typeof opts==='object'&&(opts.hostname||opts.host))assertLocal(protocol+'//'+(opts.hostname||opts.host));return request.call(this,input,...args);};}
syncBuiltinESMExports();
