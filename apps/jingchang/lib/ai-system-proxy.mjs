/** Restricted one-shot transport over an already enabled local macOS proxy.
 * CONNECT contains only the validated public IPv4:443. API headers/body never
 * enter this module; they are sent by https.request after authenticated TLS.
 */
import {execFile} from 'node:child_process';
import {connect as netConnect, isIP} from 'node:net';
import {connect as tlsConnect} from 'node:tls';
import {Agent as HttpsAgent} from 'node:https';

const HOSTS = new Set(['miaoapi.xyz', 'ark.cn-beijing.volces.com', 'cloudflare-dns.com']);
const HEADER_LIMIT = 8192;
const CONNECT_TIMEOUT = 5000;

function failure(code = 'AI_PROXY_CONNECTION_FAILED') {
  const error = new Error('安全 HTTPS 代理连接未完成，已停止；不会回退或重试');
  error.code = code;
  return error;
}

function abortFailure() {
  const error = new Error('安全 HTTPS 代理连接已取消');
  error.name = 'AbortError'; error.code = 'ABORT_ERR';
  return error;
}

function public4(address) {
  if (typeof address !== 'string' || isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 ||
    a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 0 || b === 168) ||
    a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) ||
    a === 203 && b === 0 && c === 113);
}

export function canUseAiSystemProxy(hostname, port, pinned) {
  return HOSTS.has(hostname) && (port === 443 || port === '443') && pinned?.family === 4;
}

export function parseLocalHttpsProxy(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > HEADER_LIMIT) throw failure('AI_PROXY_CONFIG_INVALID');
  const keys = ['HTTPSEnable', 'HTTPSProxy', 'HTTPSPort'];
  const values = {};
  for (const key of keys) {
    const matches = [...text.matchAll(new RegExp('^\\s*' + key + '\\s*:\\s*([^\\r\\n]*)$', 'gm'))];
    if (matches.length > 1) throw failure('AI_PROXY_CONFIG_INVALID');
    values[key] = matches[0]?.[1].trim();
  }
  if (values.HTTPSEnable === undefined || values.HTTPSEnable === '0') return null;
  if (values.HTTPSEnable !== '1') throw failure('AI_PROXY_CONFIG_INVALID');
  // Do not use proxy authentication or remote/PAC proxy endpoints.
  if (/^\s*(?:HTTPS(?:User|Username|Password|Authentication|Auth)|ProxyAuthorization)\s*:/mi.test(text)) throw failure('AI_PROXY_AUTH_REJECTED');
  const host = values.HTTPSProxy === 'localhost' ? '127.0.0.1' : values.HTTPSProxy;
  if (!['127.0.0.1', '::1'].includes(host) || !/^\d{1,5}$/.test(values.HTTPSPort || '')) throw failure('AI_PROXY_CONFIG_INVALID');
  const port = Number(values.HTTPSPort);
  if (port < 1 || port > 65535) throw failure('AI_PROXY_CONFIG_INVALID');
  return Object.freeze({host, port});
}

/** Internal test hooks substitute the command, never disable destination guards. */
export async function readLocalHttpsProxy({signal, platform = process.platform, execFileImpl = execFile} = {}) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw failure('AI_PROXY_CONFIG_INVALID');
  if (signal?.aborted) throw abortFailure();
  if (platform !== 'darwin') return null;
  const output = await new Promise((resolve, reject) => {
    try {
      execFileImpl('/usr/sbin/scutil', ['--proxy'], {encoding: 'utf8', timeout: 1000,
        maxBuffer: HEADER_LIMIT, signal}, (error, stdout) => {
        if (error) reject(signal?.aborted ? abortFailure() : failure('AI_PROXY_CONFIG_UNAVAILABLE'));
        else resolve(stdout);
      });
    } catch { reject(signal?.aborted ? abortFailure() : failure('AI_PROXY_CONFIG_UNAVAILABLE')); }
  });
  if (signal?.aborted) throw abortFailure();
  return parseLocalHttpsProxy(output);
}

function checkProxy(proxy) {
  if (!proxy || typeof proxy !== 'object' || Array.isArray(proxy) ||
      Object.keys(proxy).sort().join(',') !== 'host,port' ||
      !['127.0.0.1', '::1'].includes(proxy.host) || !Number.isInteger(proxy.port) ||
      proxy.port < 1 || proxy.port > 65535) throw failure('AI_PROXY_CONFIG_INVALID');
}

function validConnectHeader(bytes) {
  const lines = bytes.toString('latin1').split('\r\n');
  if (!/^HTTP\/1\.[01] 200(?:[ \t][\x20-\x7e]*)?$/.test(lines.shift() || '')) return false;
  const fields = new Map();
  for (const line of lines) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+:[ \t]*[\x20-\x7e\t]*$/.test(line)) return false;
    const colon = line.indexOf(':'), key = line.slice(0, colon).toLowerCase(), value = line.slice(colon + 1).trim();
    if (fields.has(key)) return false;
    fields.set(key, value);
  }
  return !fields.has('proxy-authenticate') && !fields.has('location') &&
    !fields.has('transfer-encoding') && (!fields.has('content-length') || fields.get('content-length') === '0');
}

/** Only fixed host:443 and public IPv4 may open this transport.
 * Canonical callers still validate ALL DNS records before selecting this IP.
 */
export function createAiSystemProxyAgent({hostname, port = 443, address, family = 4, signal} = {},
  {readProxy = readLocalHttpsProxy, connectTcp = netConnect, connectTls = tlsConnect,
    AgentClass = HttpsAgent, timeoutMs = CONNECT_TIMEOUT} = {}) {
  if (!canUseAiSystemProxy(hostname, port, {family}) || !public4(address) ||
      signal !== undefined && !(signal instanceof AbortSignal)) return Promise.reject(failure('AI_PROXY_DESTINATION_REJECTED'));
  if (signal?.aborted) return Promise.reject(abortFailure());
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > CONNECT_TIMEOUT) return Promise.reject(failure('AI_PROXY_CONFIG_INVALID'));
  return new Promise((resolve, reject) => {
    let settled = false, succeeded = false, tcp, secure, agent, header = Buffer.alloc(0);
    const controller = new AbortController();
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) {
        signal?.removeEventListener('abort', abort); controller.abort();
        secure?.destroy(); tcp?.destroy(); reject(error);
      } else {
        succeeded = Boolean(value);
        if (!value) signal?.removeEventListener('abort', abort);
        resolve(value);
      }
    };
    const abort = () => {
      if (settled && succeeded) { secure?.destroy(abortFailure()); return; }
      finish(abortFailure());
    };
    const timer = setTimeout(() => finish(failure('AI_PROXY_TIMEOUT')), timeoutMs);
    signal?.addEventListener('abort', abort, {once: true});
    const onError = () => finish(failure());
    const onPrematureClose = () => finish(failure('AI_PROXY_CONNECT_CLOSED'));
    const onData = chunk => {
      if (settled) return;
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (header.length + part.length > HEADER_LIMIT) return finish(failure('AI_PROXY_HEADER_LIMIT'));
      header = Buffer.concat([header, part]);
      const end = header.indexOf('\r\n\r\n');
      if (end < 0) return;
      // Reject body/smuggled bytes; HTTPS has not started its ClientHello yet.
      if (end + 4 !== header.length || !validConnectHeader(header.subarray(0, end))) return finish(failure('AI_PROXY_CONNECT_REJECTED'));
      tcp.pause(); tcp.removeListener('data', onData);
      tcp.removeListener('end', onPrematureClose); tcp.removeListener('close', onPrematureClose);
      try {
        secure = connectTls({socket: tcp, host: hostname, servername: hostname,
          rejectUnauthorized: true, minVersion: 'TLSv1.2', ALPNProtocols: ['http/1.1']});
        secure.once('error', onError);
        secure.once('close', () => { signal?.removeEventListener('abort', abort); onPrematureClose(); });
        secure.once('secureConnect', () => {
          if (settled) return secure.destroy();
          if (secure.authorized !== true) return finish(failure('AI_PROXY_TLS_REJECTED'));
          agent = new AgentClass({keepAlive: false, maxSockets: 1});
          let consumed = false;
          agent.createConnection = options => {
            if (consumed || options.servername !== hostname || options.host !== hostname || Number(options.port) !== 443) {
              secure.destroy(); throw failure('AI_PROXY_DESTINATION_REJECTED');
            }
            consumed = true; return secure;
          };
          const destroy = agent.destroy.bind(agent);
          agent.destroy = () => { secure.destroy(); tcp.destroy(); destroy(); };
          finish(null, agent);
        });
      } catch { finish(failure('AI_PROXY_TLS_REJECTED')); }
    };
    Promise.resolve().then(() => readProxy({signal: controller.signal})).then(proxy => {
      if (settled) return;
      if (proxy === null) return finish(null, false);
      try {
        checkProxy(proxy);
        tcp = connectTcp({host: proxy.host, port: proxy.port});
        tcp.once('error', onError); tcp.once('end', onPrematureClose); tcp.once('close', onPrematureClose);
        tcp.on('data', onData);
        tcp.once('connect', () => {
          if (!settled) tcp.write(`CONNECT ${address}:443 HTTP/1.1\r\nHost: ${address}:443\r\n\r\n`);
        });
      } catch { finish(failure('AI_PROXY_CONFIG_INVALID')); }
    }, () => finish(signal?.aborted ? abortFailure() : failure('AI_PROXY_CONFIG_UNAVAILABLE')));
  });
}
