// Isolated-test preload: official Ark URLs are routed to one owned loopback
// fixture. Production never imports this file and cannot enable it by HTTP.
import './local-network-only.mjs';
import http from 'node:http';
import https from 'node:https';
import dnsPromises from 'node:dns/promises';
import {syncBuiltinESMExports} from 'node:module';

const fixture = new URL(process.env.JINGCHANG_ARK_TEST_MOCK || '');
if (fixture.protocol !== 'http:' || fixture.hostname !== '127.0.0.1' || fixture.username || fixture.password ||
    process.env.ARK_API_KEY !== 'synthetic-ark-credentials-browser-key') throw Error('Owned Ark fixture configuration required');
const hostname = 'ark.cn-beijing.volces.com', originalLookup = dnsPromises.lookup;
dnsPromises.lookup = async (host, options) => host === hostname ? [{address:'93.184.216.34',family:4}] : originalLookup(host, options);
const originalRequest = https.request;
https.request = function(options, ...args) {
  if (options?.hostname === hostname) {
    if (options.protocol !== 'https:' || !(/^\/api\/v3\/(?:models|contents\/generations\/tasks(?:\/[-\w]+)?)$/.test(options.path) || options.path === '/owned-output.mp4')) throw Error('Unexpected owned Ark fixture path');
    const local = {...options,protocol:'http:',hostname:fixture.hostname,port:Number(fixture.port),path:options.path};
    delete local.servername;delete local.lookup;
    return http.request(local, ...args);
  }
  return originalRequest.call(this,options,...args);
};
syncBuiltinESMExports();
