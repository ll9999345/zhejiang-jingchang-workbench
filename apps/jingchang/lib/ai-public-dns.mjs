import {isIP} from 'node:net';
import {request as httpsRequest} from 'node:https';
import {userError} from './workspace.mjs';
import {createAiSystemProxyAgent} from './ai-system-proxy.mjs';

const PROVIDERS = new Set(['miaoapi.xyz', 'ark.cn-beijing.volces.com']);
const DOH_HOST = 'cloudflare-dns.com';
const DOH_ADDRESS = '1.1.1.1';
const TIMEOUT_MS = 5000;
const MAX_BYTES = 64 * 1024;
const MAX_ANSWERS = 32;
const MAX_ALIASES = 8;
const unavailable = () => userError('无法验证公开 DNS，已停止请求；不会回退或重试', 502);
const invalid = () => userError('公开 DNS 返回无效，已停止请求；不会回退或重试', 400);
const cancelled = () => userError('公开 DNS 检查已取消，未继续请求', 400);

function targetUrl(value) {
  try {
    if (!(value instanceof URL) && typeof value !== 'string') return null;
    return new URL(value instanceof URL ? value.href : value);
  } catch { return null; }
}

function fakeIpv4(record) {
  if (record?.family !== 4 || typeof record.address !== 'string' || isIP(record.address) !== 4) return false;
  const [a, b] = record.address.split('.').map(Number);
  return a === 198 && (b === 18 || b === 19);
}

export function canUseAiPublicDns(url, systemRecords) {
  const target = targetUrl(url);
  if (!(target && target.protocol === 'https:' && PROVIDERS.has(target.hostname) &&
      !target.port && !target.username && !target.password && !target.search && !target.hash &&
      Array.isArray(systemRecords) && systemRecords.length > 0)) return false;
  // for...of checks sparse slots as undefined; Array.every would skip them.
  for (const record of systemRecords) if (!fakeIpv4(record)) return false;
  return true;
}

function dnsName(value) {
  if (typeof value !== 'string' || !value || value.length > 254 || /\s/.test(value)) return null;
  const name = value.endsWith('.') ? value.slice(0, -1) : value;
  if (!name || name.length > 253 || name.split('.').some(label => label.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) return null;
  return name.toLowerCase();
}

function publicIpv4(address) {
  if (typeof address !== 'string' || isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  // Preliminary IPv4 checks only. The caller must still apply its complete
  // existing IANA/private-address guard to every returned record before pinning.
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 ||
    a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 0 || b === 168) ||
    a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) ||
    a === 203 && b === 0 && c === 113);
}

function checkedRecords(payload, hostname) {
  let serialized;
  try { serialized = JSON.stringify(payload); } catch { throw invalid(); }
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > MAX_BYTES ||
      !payload || typeof payload !== 'object' || Array.isArray(payload) ||
      payload.Status !== 0 || payload.TC !== false ||
      !Array.isArray(payload.Question) || payload.Question.length !== 1 ||
      payload.Question[0]?.type !== 1 || dnsName(payload.Question[0]?.name) !== hostname ||
      !Array.isArray(payload.Answer) || !payload.Answer.length || payload.Answer.length > MAX_ANSWERS) throw invalid();
  const aliases = new Map(), addresses = [];
  for (const answer of payload.Answer) {
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw invalid();
    const owner = dnsName(answer.name);
    if (!owner || answer.TTL !== undefined && (!Number.isSafeInteger(answer.TTL) || answer.TTL < 0 || answer.TTL > 0xffffffff)) throw invalid();
    if (answer.type === 1) {
      if (!publicIpv4(answer.data)) throw invalid();
      addresses.push({owner, address: answer.data});
    } else if (answer.type === 5) {
      const destination = dnsName(answer.data);
      if (!destination || aliases.has(owner) && aliases.get(owner) !== destination) throw invalid();
      aliases.set(owner, destination);
      if (aliases.size > MAX_ALIASES) throw invalid();
    } else throw invalid();
  }
  let terminal = hostname;
  const visited = new Set();
  while (aliases.has(terminal)) {
    if (visited.has(terminal)) throw invalid();
    visited.add(terminal); terminal = aliases.get(terminal);
  }
  if (!addresses.length || [...aliases.keys()].some(owner => !visited.has(owner)) ||
      addresses.some(record => record.owner !== terminal)) throw invalid();
  return addresses.map(({address}) => ({address, family: 4}));
}

async function defaultPinnedDoH(hostname, {signal} = {}) {
  const endpoint = new URL('https://' + DOH_HOST + '/dns-query');
  endpoint.searchParams.set('name', hostname);
  endpoint.searchParams.set('type', 'A');
  // Resolve no hostname at the proxy: the only CONNECT target is 1.1.1.1:443.
  const agent = await createAiSystemProxyAgent({hostname: DOH_HOST, port: 443,
    address: DOH_ADDRESS, family: 4, signal});
  if (signal?.aborted) { if (agent) agent.destroy(); throw cancelled(); }
  return new Promise((resolve, reject) => {
    let request, response, settled = false;
    const finish = (error, payload) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) {
        response?.destroy(); request?.destroy(); if (agent) agent.destroy(); reject(error);
      } else resolve(payload);
    };
    const abort = () => finish(cancelled());
    const timer = setTimeout(() => finish(unavailable()), TIMEOUT_MS);
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) return abort();
    try {
      request = httpsRequest(endpoint, {
        method: 'GET', headers: {accept: 'application/dns-json'},
        servername: DOH_HOST, rejectUnauthorized: true, agent,
        lookup: (name, options, callback) => {
          if (name !== DOH_HOST) return callback(unavailable());
          if (options?.all) return callback(null, [{address: DOH_ADDRESS, family: 4}]);
          callback(null, DOH_ADDRESS, 4);
        },
      }, incoming => {
        response = incoming;
        // https.request never follows redirects; every non-200 response stops.
        const mime = typeof incoming.headers['content-type'] === 'string' ?
          incoming.headers['content-type'].split(';')[0].trim().toLowerCase() : '';
        const encoding = incoming.headers['content-encoding'];
        const length = incoming.headers['content-length'];
        if (incoming.statusCode !== 200 || !['application/dns-json', 'application/json'].includes(mime) ||
            encoding && encoding !== 'identity' || length !== undefined &&
            (typeof length !== 'string' || !/^\d+$/.test(length) || Number(length) > MAX_BYTES)) return finish(unavailable());
        const chunks = []; let bytes = 0;
        incoming.on('data', chunk => {
          if (settled) return;
          const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += part.length;
          if (bytes > MAX_BYTES) return finish(unavailable());
          chunks.push(part);
        });
        incoming.on('aborted', () => finish(unavailable()));
        incoming.on('error', () => finish(unavailable()));
        incoming.on('end', () => {
          if (settled) return;
          if (incoming.complete === false) return finish(unavailable());
          try {
            const text = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks));
            finish(null, JSON.parse(text));
          } catch { finish(unavailable()); }
        });
      });
      request.on('error', () => finish(unavailable()));
      request.end();
    } catch { finish(unavailable()); }
  });
}

function boundedDoH(dohRequest, hostname, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const controller = new AbortController();
    const finish = (error, payload) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(payload);
    };
    const abort = () => { finish(cancelled()); controller.abort(); };
    const timer = setTimeout(() => { finish(unavailable()); controller.abort(); }, TIMEOUT_MS);
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) return abort();
    Promise.resolve().then(() => {
      if (controller.signal.aborted) throw cancelled();
      return dohRequest(hostname, {signal: controller.signal});
    }).then(payload => finish(null, payload), () => finish(signal?.aborted ? cancelled() : unavailable()));
  });
}

export async function resolvePublicAiDns(url, systemRecords, {dohRequest = defaultPinnedDoH, signal} = {}) {
  if (!canUseAiPublicDns(url, systemRecords)) return null;
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw invalid();
  if (signal?.aborted) throw cancelled();
  if (typeof dohRequest !== 'function') throw invalid();
  const hostname = targetUrl(url).hostname;
  const payload = await boundedDoH(dohRequest, hostname, signal);
  return checkedRecords(payload, hostname);
}
