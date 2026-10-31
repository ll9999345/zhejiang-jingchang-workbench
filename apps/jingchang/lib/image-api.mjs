import {GLB_MIME,GLB_LIMIT,inspectGlb} from '../public/glb-validation.js';
import {IMAGE_REFERENCE_LIMIT} from '../public/reference-limits.js';
import {consumeChatStream,chatReply} from './chat-stream.mjs';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { canUseAiPublicDns, resolvePublicAiDns } from './ai-public-dns.mjs';
import {canUseAiSystemProxy, createAiSystemProxyAgent} from './ai-system-proxy.mjs';

export const DEFAULT_API_BASE_URL = 'https://api.openai.com/v1';
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_JSON_BYTES = 48 * 1024 * 1024;
const MAX_IMAGE_DATA_URL_LENGTH = 20_971_520;

// Leave room for multipart headers and the non-media fields. This also allows
// callers to reject known oversized inputs before creating/submitting a job.
export function assertImageRequestSize(referenceBytes, prompt = '', model = '') {
  if (!Number.isSafeInteger(referenceBytes) || referenceBytes < 0 || referenceBytes + Buffer.byteLength(prompt) + Buffer.byteLength(model) + 65536 > MAX_JSON_BYTES) {
    fail('request_too_large', '参考图片合计过大，请减少图片或压缩后再提交。');
  }
}

const LOOPBACK_NAMES = new Set(['localhost']);
const ALLOWED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/**
 * Errors intentionally contain only a stable, local code and safe metadata.
 * In particular, an upstream response body and an API key are never retained.
 */
export class ImageApiError extends Error {
  constructor(code, message, { status, upstreamStatus, retryable = false, uncertain } = {}) {
    super(message);
    this.name = 'ImageApiError';
    this.code = code;
    this.publicMessage = message;
    this.retryable = Boolean(retryable);
    this.uncertain = uncertain === undefined ? code === 'network_uncertain' : Boolean(uncertain);
    if (Number.isInteger(status)) this.status = status;
    else this.status = ['invalid_base_url', 'insecure_base_url', 'private_base_url', 'private_destination', 'invalid_api_key', 'invalid_parameter', 'invalid_reference', 'invalid_references', 'request_too_large', 'bad_request', 'invalid_model_or_size'].includes(code) ? 400 : 502;
    if (Number.isInteger(upstreamStatus)) this.upstreamStatus = upstreamStatus;
  }
}

function fail(code, message, options) {
  throw new ImageApiError(code, message, options);
}

function normalizedHost(host) {
  return String(host ?? '')
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.$/, '');
}

function ipv4Parts(address) {
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return parts;
}

function isPrivateIpv4(address) {
  const parts = ipv4Parts(address);
  if (!parts) return false;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 0 && parts[2] === 0) ||
    (a === 192 && b === 0 && parts[2] === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && b >= 18 && b <= 19) ||
    (a === 198 && b === 51 && parts[2] === 100) ||
    (a === 203 && b === 0 && parts[2] === 113) ||
    a >= 224
  );
}

function isPrivateIpv6(address) {
  const value = address.toLowerCase();
  const words = value.includes('.')
    ? value.replace(/(\d+\.\d+\.\d+\.\d+)$/, (_match, ipv4) => {
        const octets = ipv4Parts(ipv4);
        if (!octets) return ipv4;
        return `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
      })
    : value;
  const parts = words.split('::');
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts.length > 1 && parts[1] ? parts[1].split(':') : [];
  const groups = parts.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : words.split(':');
  if (groups.length !== 8 || groups.some((part) => !/^[\da-f]{1,4}$/.test(part))) return true;
  const numeric = groups.reduce((result, part) => (result << 16n) | BigInt(`0x${part}`), 0n);
  const inPrefix = (prefix, bits) => numeric >> BigInt(128 - bits) === prefix;

  // Only permit global unicast (2000::/3), then reject IANA special-purpose
  // blocks that fall inside it, plus deprecated site-local and old 6bone space.
  // The special-purpose ranges follow the IANA IPv6 registry.
  const globalUnicast = inPrefix(1n, 3);
  const specialPurpose = [
    ['2001::', 23],       // IETF protocol assignments, including Teredo
    ['2001:db8::', 32],   // documentation
    ['2002::', 16],       // 6to4
    ['2620:4f:8000::', 48], // AS112 service
    ['3ffe::', 16],       // deprecated 6bone
    ['3fff::', 20],       // documentation
    ['5f00::', 16],       // Segment Routing SIDs
  ].some(([prefix, bits]) => {
    const prefixWords = prefix.split('::')[0].split(':');
    const prefixValue = prefixWords.reduce((result, part) => (result << 16n) | BigInt(`0x${part || '0'}`), 0n)
      << BigInt(128 - prefixWords.length * 16);
    return numeric >> BigInt(128 - bits) === prefixValue >> BigInt(128 - bits);
  });
  return !globalUnicast || specialPurpose;
}

function isPrivateAddress(address) {
  const value = normalizedHost(address);
  const kind = isIP(value);
  return kind === 4 ? isPrivateIpv4(value) : kind === 6 ? isPrivateIpv6(value) : false;
}

function isLoopbackHost(host) {
  const value = normalizedHost(host);
  if (LOOPBACK_NAMES.has(value)) return true;
  const kind = isIP(value);
  if (kind === 4) {
    const parts = ipv4Parts(value);
    return Boolean(parts && value === '127.0.0.1');
  }
  if (kind === 6) return value === '::1';
  return false;
}

function isBlockedHostname(host) {
  const value = normalizedHost(host);
  return (
    value === 'metadata' ||
    value === 'metadata.google.internal' ||
    value === 'instance-data' ||
    value.endsWith('.internal') ||
    value.endsWith('.local') ||
    value.endsWith('.localhost')
  );
}

function parseBaseUrl(value) {
  if (typeof value !== 'string' && !(value instanceof URL)) {
    fail('invalid_base_url', '图像服务地址必须是 URL。');
  }
  let url;
  try {
    url = new URL(String(value));
  } catch {
    fail('invalid_base_url', '图像服务地址不是有效 URL。');
  }
  if (url.username || url.password || url.search || url.hash) {
    fail('invalid_base_url', '图像服务地址不能包含凭据、查询参数或片段。');
  }
  const host = normalizedHost(url.hostname);
  if (!host) fail('invalid_base_url', '图像服务地址缺少主机名。');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    fail('invalid_base_url', '图像服务地址只允许 HTTPS，或显式 loopback HTTP。');
  }
  if (url.protocol === 'http:' && !isLoopbackHost(host)) {
    fail('insecure_base_url', 'HTTP 图像服务地址必须是显式 loopback 地址。');
  }
  if (url.protocol === 'https:' && (isLoopbackHost(host) || isPrivateAddress(host) || isBlockedHostname(host))) {
    fail('private_base_url', 'HTTPS 图像服务地址不能指向本机、私网或元数据地址。');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${pathname}`;
}

/** Validate and normalize an OpenAI-compatible API base URL without doing I/O. */
export function validateApiBaseUrl(value = DEFAULT_API_BASE_URL) {
  return parseBaseUrl(value);
}

async function assertDnsSafe(url, { resolveDns, allowAiFallback = false, lookupImpl = lookup, publicResolver = resolvePublicAiDns, signal } = {}) {
  if (signal?.aborted) throw abortError();
  const host = normalizedHost(url.hostname);
  if (url.protocol === 'http:') {
    if (!isLoopbackHost(host)) fail('private_destination', 'HTTP 请求目标必须是 loopback。');
    return null;
  }
  if (isLoopbackHost(host) || isPrivateAddress(host) || isBlockedHostname(host)) {
    fail('private_destination', '请求目标解析到被禁止的本机、私网或元数据地址。');
  }
  if (!resolveDns || isIP(host)) return { address: host, family: isIP(host) };
  let records;
  try {
    records = await lookupImpl(host, { all: true, verbatim: true });
  } catch {
    if (signal?.aborted) throw abortError();
    fail('network_error', '无法解析图像服务地址。', { retryable: true });
  }
  if (signal?.aborted) throw abortError();
  // Some local proxies answer with 198.18/15 fake IPs. Only the two fixed API
  // origins may use the independent resolver; media downloads stay strict.
  if (allowAiFallback && canUseAiPublicDns(url, records)) {
    records = await publicResolver(url, records, { signal });
  }
  if (signal?.aborted) throw abortError();
  if (!Array.isArray(records) || records.length === 0 || Array.from(records).some((record) => !record || ![4, 6].includes(record.family) || typeof record.address !== 'string' || isIP(record.address) !== record.family || isPrivateAddress(record.address))) {
    fail('private_destination', '请求目标解析到被禁止的本机、私网或元数据地址。');
  }
  const record = records[0];
  return { address: record.address, family: record.family };
}

/** Server-only DNS preparation; resolver hooks are never HTTP request fields. */
export async function prepareApiDestination(baseUrl, { resolveDns = true, lookupImpl = lookup, publicResolver = resolvePublicAiDns, signal } = {}) {
  const normalized = validateApiBaseUrl(baseUrl);
  return assertDnsSafe(new URL(normalized), { resolveDns, allowAiFallback: true, lookupImpl, publicResolver, signal });
}

async function assertApiDestination(baseUrl, fetchImpl, signal, phase = 'query') {
  try {
    return await prepareApiDestination(baseUrl, { resolveDns: !fetchImpl, signal });
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') {
      // Preserve the caller's existing cancellation contract, including the
      // conservative uncertainty flag on a generation attempt.
      fail('aborted', '图像请求已取消。', { uncertain: phase === 'submit', retryable: phase === 'submit' });
    }
    throw error;
  }
}

async function assertDownloadDestination(rawUrl, baseUrl, fetchImpl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    fail('invalid_image_url', '上游返回的图片 URL 无效。');
  }
  if (url.username || url.password || url.hash) {
    fail('invalid_image_url', '上游返回的图片 URL 包含被禁止的凭据或片段。');
  }
  const base = new URL(baseUrl);
  const localBase = base.protocol === 'http:' && isLoopbackHost(base.hostname);
  if (localBase) {
    if (url.protocol !== 'http:' || !isLoopbackHost(url.hostname)) {
      fail('private_destination', '本机图像服务只允许下载 loopback HTTP 图片。');
    }
  } else if (url.protocol !== 'https:') {
    fail('invalid_image_url', '云端图像 URL 必须使用 HTTPS。');
  }
  const pinned = await assertDnsSafe(url, { resolveDns: !fetchImpl });
  return { url, pinned };
}

// A signed object-storage URL follows the same public/loopback boundary as media downloads.
export const validateSignedDestination=(url,baseUrl)=>assertDownloadDestination(url,validateApiBaseUrl(baseUrl));

function fetchFunction(fetchImpl) {
  const fn = fetchImpl ?? globalThis.fetch;
  if (typeof fn !== 'function') fail('network_error', '当前 Node 环境没有可用的 fetch。');
  return fn;
}

function authHeaders(apiKey) {
  if (apiKey === undefined || apiKey === null || apiKey === '') return {};
  if (typeof apiKey !== 'string' || apiKey.length > 16_384) {
    fail('invalid_api_key', 'API key 参数无效。');
  }
  return { authorization: `Bearer ${apiKey}` };
}

function abortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

async function materializeRequestBody(url, init) {
  if (init.body === undefined || init.body === null) return { bytes: null, headers: new Headers(init.headers || {}) };
  if (init.body instanceof FormData) {
    const request = new Request(url, {
      method: init.method || 'GET',
      headers: init.headers || {},
      body: init.body,
    });
    const bytes = Buffer.from(await request.arrayBuffer());
    return { bytes, headers: new Headers(request.headers) };
  }
  const bytes = Buffer.isBuffer(init.body) ? Buffer.from(init.body) : Buffer.from(String(init.body));
  return { bytes, headers: new Headers(init.headers || {}) };
}

/** Keep Node's all-record lookup form pinned to the same single address. */
export function createPinnedLookup(pinned) {
  if (!pinned || isIP(pinned.address) !== pinned.family || ![4, 6].includes(pinned.family) || isPrivateAddress(pinned.address)) {
    fail('private_destination', '请求目标解析到被禁止的本机、私网或元数据地址。');
  }
  const address = pinned.address, family = pinned.family;
  return (_hostname, options, callback) => options?.all
    ? callback(null, [{ address, family }])
    : callback(null, address, family);
}

async function pinnedHttpsFetch(url, init, pinned) {
  const prepared = await materializeRequestBody(url, init);
  if (prepared.bytes && prepared.bytes.length > MAX_JSON_BYTES) {
    fail('request_too_large', '图像请求超过允许大小。');
  }
  if (prepared.bytes && !prepared.headers.has('content-length')) {
    prepared.headers.set('content-length', String(prepared.bytes.length));
  }
  const headers = Object.fromEntries(prepared.headers.entries());
  const signal = init.signal;
  if (signal?.aborted) throw abortError();
  // The existing complete DNS guard still runs before this transport. Other
  // origins, non-default ports and IPv6 keep the original pinned direct path.
  const hostname = normalizedHost(url.hostname), port = url.port || 443;
  const agent = canUseAiSystemProxy(hostname, port, pinned)
    ? await createAiSystemProxyAgent({hostname, port, ...pinned, signal}) : false;
  if (signal?.aborted) { if (agent) agent.destroy(); throw abortError(); }
  return new Promise((resolve, reject) => {
    let settled = false;
    const options = {
      protocol: 'https:',
      hostname,
      port,
      path: `${url.pathname || '/'}${url.search || ''}`,
      method: init.method || 'GET',
      headers,
      servername: hostname,
      rejectUnauthorized: true,
      agent,
      lookup: createPinnedLookup(pinned),
    };
    let req;
    try { req = httpsRequest(options, (response) => {
      const responseHeaders = {
        get(name) {
          const value = response.headers[String(name).toLowerCase()];
          return Array.isArray(value) ? value.join(', ') : value ?? null;
        },
      };
      const wrapped = {
        status: response.statusCode || 0,
        ok: (response.statusCode || 0) >= 200 && (response.statusCode || 0) < 300,
        headers: responseHeaders,
        body: response,
      };
      settled = true;
      resolve(wrapped);
      if (signal) signal.addEventListener('abort', () => response.destroy(abortError()), { once: true });
    }); } catch (error) { if (agent) agent.destroy(); reject(error); return; }
    const rejectRequest = (error) => {
      if (!settled) { settled = true; if (agent) agent.destroy(); reject(error); }
    };
    req.once('error', rejectRequest);
    if (signal) {
      signal.addEventListener('abort', () => req.destroy(abortError()), { once: true });
    }
    if (prepared.bytes) req.write(prepared.bytes);
    req.end();
  });
}

async function request(fetchImpl, url, init, phase, pinned) {
  const fn = fetchFunction(fetchImpl);
  try {
    const response = !fetchImpl && url.protocol === 'https:' && pinned
      ? await pinnedHttpsFetch(url, { ...init, redirect: 'error' }, pinned)
      : await fn(url.toString(), { ...init, redirect: 'error' });
    if (!response || typeof response.status !== 'number') {
      fail('network_error', '上游没有返回有效 HTTP 响应。', { retryable: true });
    }
    if (response.status >= 300 && response.status < 400) {
      fail('redirect_rejected', '上游重定向已拒绝。');
    }
    return response;
  } catch (error) {
    if (error instanceof ImageApiError) throw error;
    if (init?.signal?.aborted || error?.name === 'AbortError') {
      fail('aborted', '图像请求已取消。', { uncertain: phase === 'submit', retryable: phase === 'submit' });
    }
    if (phase === 'submit') {
      fail('network_uncertain', '图像提交的网络结果不确定，请先核对上游任务再决定是否重试。', { retryable: true, uncertain: true });
    }
    fail('network_error', '图像服务网络请求失败。', { retryable: true });
  }
}

function header(response, name) {
  return response?.headers && typeof response.headers.get === 'function' ? response.headers.get(name) : null;
}

async function readBody(response, maxBytes) {
  const contentLength = Number(header(response, 'content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    fail('response_too_large', '上游响应超过允许大小。');
  }
  if (!response?.body) {
    if (typeof response?.arrayBuffer !== 'function') return Buffer.alloc(0);
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > maxBytes) fail('response_too_large', '上游响应超过允许大小。');
    return body;
  }
  const chunks = [];
  let total = 0;
  const push = (chunk) => {
    const value = Buffer.from(chunk);
    total += value.length;
    if (total > maxBytes) fail('response_too_large', '上游响应超过允许大小。');
    chunks.push(value);
  };
  if (typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        push(part.value);
      }
    } finally {
      reader.releaseLock?.();
    }
  } else if (response.body[Symbol.asyncIterator]) {
    for await (const chunk of response.body) push(chunk);
  } else {
    fail('network_error', '上游响应流不可读。', { retryable: true });
  }
  return Buffer.concat(chunks, total);
}

function htmlPayload(body, contentType) {
  if (String(contentType ?? '').toLowerCase().includes('text/html')) return true;
  const prefix = body.subarray(0, 512).toString('utf8').trimStart();
  return /^<(?:!doctype\s+html|html(?:\s|>)|head(?:\s|>)|body(?:\s|>))/i.test(prefix);
}

function httpError(response, body, phase) {
  const status = response.status;
  const uncertain = phase === 'download' || (phase === 'submit' && status >= 500);
  if (status === 401 || status === 403) {
    fail('auth_error', '图像服务认证或权限失败。', { status: 502, upstreamStatus: status, uncertain: false });
  }
  if (status === 429) {
    fail('rate_limited', '图像服务请求过于频繁。', { status: 502, upstreamStatus: status, retryable: false, uncertain: false });
  }
  if (status === 400) {
    const text = body.subarray(0, 8192).toString('utf8');
    if (/model|size|quality|dimension|unsupported|invalid/i.test(text)) {
      fail('invalid_model_or_size', '模型、尺寸或图像参数不受上游支持。', { status: 400, upstreamStatus: status, uncertain: false });
    }
    fail('bad_request', '图像服务拒绝了请求参数。', { status: 400, upstreamStatus: status, uncertain: false });
  }
  if (htmlPayload(body, header(response, 'content-type'))) {
    fail('upstream_html', phase === 'download' ? '图片下载服务返回了 HTML。' : '上游返回了 HTML，可能是代理或登录页。', { status: 502, upstreamStatus: status, uncertain });
  }
  fail('upstream_error', phase === 'download' ? '图片下载服务返回错误。' : '图像服务返回错误。', {
    status: 502,
    upstreamStatus: status,
    retryable: false,
    uncertain,
  });
}

async function jsonResponse(response, phase) {
  let body;
  try {
    body = await readBody(response, MAX_JSON_BYTES);
  } catch (error) {
    if (error instanceof ImageApiError) throw error;
    if (phase === 'submit') {
      fail('network_uncertain', '图像提交的网络结果不确定，请先核对上游任务再决定是否重试。', { retryable: true, uncertain: true });
    }
    fail('network_error', '图像服务网络请求失败。', { retryable: true, uncertain: false });
  }
  if (!response.ok) httpError(response, body, phase);
  if (htmlPayload(body, header(response, 'content-type'))) {
    fail('upstream_html', '上游返回了 HTML，可能是代理或登录页。');
  }
  let value;
  try {
    value = JSON.parse(body.toString('utf8'));
  } catch {
    fail('invalid_response', '上游返回的不是有效 JSON。');
  }
  return value;
}

function endpoint(baseUrl, path) {
  return new URL(path.replace(/^\/+/, ''), `${baseUrl.replace(/\/+$/, '')}/`);
}

function safeNumeric(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function sanitizeUsage(value, depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 2) return null;
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 48)) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key)) continue;
    const number = safeNumeric(item);
    if (number !== null) {
      output[key] = number;
    } else if (item && typeof item === 'object' && !Array.isArray(item)) {
      const nested = sanitizeUsage(item, depth + 1);
      if (nested && Object.keys(nested).length > 0) output[key] = nested;
    }
  }
  return Object.keys(output).length > 0 ? output : null;
}

function sanitizeModel(value) {
  if (typeof value === 'string' && value.length > 0 && value.length <= 512) return { id: value };
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 512) {
    return null;
  }
  const output = { id: value.id };
  if (typeof value.object === 'string' && value.object.length <= 64) output.object = value.object;
  if (typeof value.owned_by === 'string' && value.owned_by.length <= 256) output.owned_by = value.owned_by;
  const created = safeNumeric(value.created);
  if (created !== null) output.created = created;
  return output;
}

/** List sanitized model metadata from the compatible /models endpoint. */
export async function listImageModels({ baseUrl = DEFAULT_API_BASE_URL, apiKey, signal, fetchImpl } = {}) {
  const normalized = validateApiBaseUrl(baseUrl);
  const pinned = await assertApiDestination(normalized, fetchImpl, signal);
  const url = endpoint(normalized, 'models');
  const response = await request(fetchImpl, url, {
    method: 'GET',
    headers: authHeaders(apiKey),
    signal,
  }, 'models', pinned);
  const payload = await jsonResponse(response, 'models');
  const entries = Array.isArray(payload) ? payload : payload && Array.isArray(payload.data) ? payload.data : null;
  if (!entries) fail('invalid_response', '模型列表响应缺少 data 数组。');
  const models = entries.map(sanitizeModel).filter(Boolean);
  return { models, data: models };
}

function imageMime(value) {
  const mime = typeof value === 'string' ? value.toLowerCase().split(';', 1)[0].trim() : '';
  return mime === 'image/jpg' ? 'image/jpeg' : mime;
}

function detectImageMime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

function asBytes(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return null;
}

function safeName(value, fallback) {
  const text = typeof value === 'string' ? value.split(/[\\/]/).pop() : '';
  const safe = text.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160);
  return safe || fallback;
}

function extension(mime) {
  return mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
}

function normalizedReferences(references) {
  if (references === undefined || references === null) return [];
  if (!Array.isArray(references) || references.length > IMAGE_REFERENCE_LIMIT) {
    fail('invalid_references', '图片编辑最多接受 20 张参考图。');
  }
  return references.map((reference, index) => {
    if (!reference || typeof reference !== 'object') fail('invalid_reference', '参考图参数无效。');
    const bytes = asBytes(reference.bytes);
    if (!bytes || bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
      fail('invalid_reference', '参考图必须是非空且不超过 32MB 的图片字节。');
    }
    const mime = imageMime(reference.mime);
    if (!ALLOWED_IMAGE_MIMES.has(mime)) fail('invalid_reference', '参考图只支持 PNG、JPEG 或 WebP。');
    const detected = detectImageMime(bytes);
    if (detected !== mime) fail('invalid_reference', '参考图内容与 MIME 类型不匹配。');
    const fallback = `reference-${index + 1}.${extension(mime)}`;
    return { bytes: Buffer.from(bytes), mime, name: safeName(reference.name, fallback) };
  });
}

function textOption(value, name, maxLength) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    fail('invalid_parameter', `${name} 参数无效。`);
  }
  return value;
}

function generationOptions(options) {
  if (!options || typeof options !== 'object') fail('invalid_parameter', '图像生成参数无效。');
  const baseUrl = validateApiBaseUrl(options.baseUrl ?? DEFAULT_API_BASE_URL);
  const model = textOption(options.model, 'model', 512);
  const prompt = textOption(options.prompt, 'prompt', 2_000_000);
  if (!model || !prompt) fail('invalid_parameter', 'model 和 prompt 不能为空。');
  const size = textOption(options.size, 'size', 256);
  const quality = textOption(options.quality, 'quality', 128);
  const references = normalizedReferences(options.references);
  const mask = normalizedMask(options.mask);
  if (mask && references.length !== 1) fail('invalid_mask', '使用遮罩时必须且只能选择一张底图。');
  const totalInputBytes = references.reduce((total, reference) => total + reference.bytes.length, 0) + (mask?.bytes.length || 0);
  assertImageRequestSize(totalInputBytes, prompt, model);
  return { baseUrl, model, prompt, size, quality, references, mask };
}

function decodeBase64(value) {
  if (typeof value !== 'string') fail('invalid_image', '上游没有返回有效图片数据。');
  const compact = value.replace(/\s/g, '');
  if (compact.length > MAX_JSON_BYTES || compact.length % 4 === 1 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
    fail('invalid_image', '上游返回的图片编码无效。');
  }
  const bytes = Buffer.from(compact, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) fail('invalid_image', '上游图片超过允许大小或为空。');
  return bytes;
}

function jsonRequestBody({ model, prompt, size, quality }) {
  const body = { model, prompt, n: 1 };
  if (size !== undefined) body.size = size;
  if (quality !== undefined) body.quality = quality;
  const encoded = JSON.stringify(body);
  if (Buffer.byteLength(encoded) > MAX_JSON_BYTES) fail('request_too_large', '图像请求超过允许大小。');
  return { body, encoded };
}

function formRequestBody({ model, prompt, size, quality, references }) {
  const form = new FormData();
  form.append('model', model);
  form.append('prompt', prompt);
  form.append('n', '1');
  if (size !== undefined) form.append('size', size);
  if (quality !== undefined) form.append('quality', quality);
  for (const reference of references) {
    form.append('image[]', new Blob([reference.bytes], { type: reference.mime }), reference.name);
  }
  return form;
}

function normalizedMask(mask) {
  if (mask === undefined || mask === null) return null;
  if (!mask || typeof mask !== 'object') fail('invalid_mask', '图片遮罩参数无效。');
  const bytes = asBytes(mask.bytes);
  if (!bytes || bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) fail('invalid_mask', '图片遮罩必须是非空且不超过 32MB 的 PNG。');
  if (imageMime(mask.mime) !== 'image/png' || detectImageMime(bytes) !== 'image/png') fail('invalid_mask', '图片遮罩只支持有效的 PNG。');
  return { bytes: Buffer.from(bytes), mime: 'image/png', name: safeName(mask.name, 'mask.png') };
}

function jsonEditRequestBody({ model, prompt, size, quality, references, mask }) {
  const dataUrl = image => {
    const value=`data:${image.mime};base64,${image.bytes.toString('base64')}`;
    if(value.length>MAX_IMAGE_DATA_URL_LENGTH)fail('request_too_large','单张遮罩编辑图片超过接口的 data URL 长度限制，请压缩后再试。');
    return value;
  };
  const body = {
    model,
    prompt,
    n: 1,
    images: references.map(image => ({ image_url: dataUrl(image) })),
    mask: { image_url: dataUrl(mask) },
  };
  if (size !== undefined) body.size = size;
  if (quality !== undefined) body.quality = quality;
  const encoded = JSON.stringify(body);
  if (Buffer.byteLength(encoded) > MAX_JSON_BYTES) fail('request_too_large', '图像请求超过允许大小。');
  return encoded;
}

function fileNameFromUrl(rawUrl, mime, index) {
  try {
    const pathname = new URL(rawUrl).pathname;
    const leaf = pathname.split('/').pop();
    if (leaf) return safeName(leaf, `image-${index}.${extension(mime)}`);
  } catch {
    // URL validation happens before this helper; keep a safe fallback here.
  }
  return `image-${index}.${extension(mime)}`;
}

async function downloadImage(rawUrl, { baseUrl, fetchImpl, signal, index }) {
  const destination = await assertDownloadDestination(rawUrl, baseUrl, fetchImpl);
  const response = await request(fetchImpl, destination.url, { method: 'GET', signal }, 'download', destination.pinned);
  let body;
  try {
    body = await readBody(response, MAX_IMAGE_BYTES);
  } catch (error) {
    if (error instanceof ImageApiError) throw error;
    fail('network_error', '图片下载网络请求失败。', { retryable: true, uncertain: false });
  }
  if (!response.ok) httpError(response, body, 'download');
  if (htmlPayload(body, header(response, 'content-type'))) {
    fail('upstream_html', '图片 URL 返回了 HTML，可能是失效的登录或代理页面。');
  }
  const mime = detectImageMime(body);
  if (!mime) fail('invalid_image', '下载结果不是受支持的 PNG、JPEG 或 WebP。');
  return { bytes: body, mime, fileName: fileNameFromUrl(rawUrl, mime, index), source: 'url' };
}

async function responseImages(payload, { baseUrl, model, fetchImpl, signal, maxImages = 1 }) {
  if (!payload || !Array.isArray(payload.data) || payload.data.length === 0) {
    fail('invalid_response', '图像响应缺少 data 图片数组。');
  }
  const images = [];
  for (const [offset, item] of payload.data.slice(0, maxImages).entries()) {
    if (!item || typeof item !== 'object') fail('invalid_image', '上游图片条目无效。');
    if (typeof item.b64_json === 'string') {
      const bytes = decodeBase64(item.b64_json);
      const mime = detectImageMime(bytes);
      if (!mime) fail('invalid_image', 'Base64 结果不是受支持的 PNG、JPEG 或 WebP。');
      images.push({ bytes, mime, fileName: `image-${offset + 1}.${extension(mime)}`, source: 'b64_json' });
      continue;
    }
    if (typeof item.url === 'string') {
      images.push(await downloadImage(item.url, { baseUrl, fetchImpl, signal, index: offset + 1 }));
      continue;
    }
    fail('invalid_image', '上游图片条目缺少 b64_json 或 URL。');
  }
  return images;
}

async function acceptedSubmissionResult(response, buildResult) {
  try {
    return await buildResult();
  } catch (error) {
    if (response.status >= 200 && response.status < 300) {
      if (error instanceof ImageApiError) {
        error.uncertain = true;
        throw error;
      }
      fail('invalid_response', '上游已响应，但图片结果无法确认。', { uncertain: true });
    }
    throw error;
  }
}

/**
 * Generate one image, or edit one image from 1–3 references. The adapter
 * deliberately fixes n=1 so callers cannot accidentally create an unbounded
 * paid batch. API keys exist only in this invocation's request headers.
 */
export async function generateImage({
  baseUrl = DEFAULT_API_BASE_URL,
  apiKey,
  model,
  prompt,
  size,
  quality,
  references,
  mask,
  signal,
  fetchImpl,
} = {}) {
  const options = generationOptions({ baseUrl, apiKey, model, prompt, size, quality, references, mask });
  const pinned = await assertApiDestination(options.baseUrl, fetchImpl, signal, 'submit');
  const headers = authHeaders(apiKey);
  let body;
  let requestHeaders = headers;
  let path = 'images/generations';
  if (options.references.length > 0) {
    path = 'images/edits';
    if (options.mask) {
      // The documented image-edit JSON shape carries the source and mask as data URLs.
      body = jsonEditRequestBody(options);
      requestHeaders = { ...headers, 'content-type': 'application/json' };
    } else {
      body = formRequestBody(options);
    }
  } else {
    const encoded = jsonRequestBody(options);
    body = encoded.encoded;
    requestHeaders = { ...headers, 'content-type': 'application/json' };
  }
  const response = await request(fetchImpl, endpoint(options.baseUrl, path), {
    method: 'POST',
    headers: requestHeaders,
    body,
    signal,
  }, 'submit', pinned);
  const { payload, images } = await acceptedSubmissionResult(response, async () => {
    const payload = await jsonResponse(response, 'submit');
    const images = await responseImages(payload, {
      baseUrl: options.baseUrl,
      model: options.model,
      fetchImpl,
      signal,
    });
    return { payload, images };
  });
  return {
    model: options.model,
    n: 1,
    images,
    usage: sanitizeUsage(payload.usage),
  };
}

// Shared transport for the independent creation studio. Relative API paths only;
// authenticated requests stay on the configured origin with DNS pinning.
export async function safeApiCall({baseUrl, path, apiKey, method='GET', body, signal, responseType='json', maxBytes=MAX_JSON_BYTES, modelScopeMode, authMode='bearer', runningHubAppId, onDelta}) {
  const base=validateApiBaseUrl(baseUrl);
  if(!['bearer','gemini'].includes(authMode))fail('invalid_parameter','接口鉴权方式无效。');
  const geminiPath=authMode==='gemini'&&/^models\/gemini[-\w.]{1,160}:generateContent$/.test(path);
  const rhModelPath=/^openapi\/v2\/(?:[-\w.]+\/)*[-\w.]+$/.test(path);
  const mjQueryPath=method==='GET'&&/^midjourney\/(?:[A-Za-z0-9_.-]|%3A){1,720}$/.test(path);
  if(typeof path!=='string'||!path||path.startsWith('/')||path.includes('..')||/[?#\\]/.test(path)||(!/^[-\w/]+$/.test(path)&&!geminiPath&&!rhModelPath&&!mjQueryPath))fail('invalid_parameter','接口路径无效。');
  if(!['GET','POST','DELETE'].includes(method))fail('invalid_parameter','接口方法无效。');
  if(responseType==='chat-stream'&&(path!=='chat/completions'||method!=='POST'))fail('invalid_parameter','流式模式只用于对话接口');
  const pinned=await assertApiDestination(base, undefined, signal, method==='POST'?'submit':'query');
  const headers=authHeaders(apiKey);
  if(authMode==='gemini'){delete headers.Authorization;delete headers.authorization;headers['x-goog-api-key']=String(apiKey||'').trim();}
  if(modelScopeMode!==undefined){
    if(!['submit','query'].includes(modelScopeMode))fail('invalid_parameter','ModelScope 请求模式无效');
    headers[modelScopeMode==='submit'?'X-ModelScope-Async-Mode':'X-ModelScope-Task-Type']=modelScopeMode==='submit'?'true':'image_generation';
  }
  let encoded=body;
  if(body!==undefined&&!(body instanceof FormData)){encoded=JSON.stringify(body);headers['content-type']='application/json';}
  if(typeof encoded==='string'&&Buffer.byteLength(encoded)>MAX_JSON_BYTES)fail('request_too_large','生成请求超过允许大小。');
  const phase=method==='POST'?'submit':'query';
  const url=endpoint(base,path);
  if(runningHubAppId!==undefined){
    if(path!=='api/webapp/apiCallDemo'||method!=='GET'||!/^\d{1,30}$/.test(runningHubAppId))fail('invalid_parameter','应用查询参数无效');
    url.searchParams.set('webappId',runningHubAppId);url.searchParams.set('apiKey',apiKey||'');
  }
  const response=await request(undefined,url,{method,headers,body:encoded,signal},phase,pinned);
  return acceptedSubmissionResult(response,async()=>{
    if(responseType==='chat-stream'){
      if(!response.ok)return jsonResponse(response,phase);
      try{
        if(String(header(response,'content-type')||'').split(';')[0].trim()==='text/event-stream')return await consumeChatStream(response,{onDelta,signal});
        const result=chatReply(await jsonResponse(response,phase));await onDelta?.(result.text);return result;
      }catch(error){throw new ImageApiError('invalid_chat_stream',error.publicMessage||'对话流已中断，已接收片段会保留；不会自动重发',{uncertain:true});}
    }
    if(responseType==='json')return jsonResponse(response,phase);
    const bytes=await readBody(response,Math.min(maxBytes,150*1024*1024));
    if(!response.ok)httpError(response,bytes,phase);
    return {bytes,mime:String(header(response,'content-type')||'application/octet-stream').split(';')[0]};
  });
}
export async function parseImageData(payload,{baseUrl,signal,maxImages=1}={}) {
  if(![1,2,4].includes(maxImages))fail('invalid_parameter','图片数量无效。');
  return responseImages(payload,{baseUrl,signal,maxImages});
}
export async function downloadApiGlb(rawUrl,{baseUrl,signal,apiKey}){
 const destination=await assertDownloadDestination(rawUrl,baseUrl);const response=await request(undefined,destination.url,{method:'GET',signal},'download',destination.pinned);const bytes=await readBody(response,GLB_LIMIT);if(!response.ok)httpError(response,bytes,'download');try{inspectGlb(bytes);}catch(e){fail('invalid_model3d',e.message);}if(apiKey&&bytes.includes(Buffer.from(apiKey)))fail('invalid_model3d','三维结果包含本次密钥，已阻止保存');return {bytes,mime:GLB_MIME};
}

export async function downloadApiVideo(rawUrl,{baseUrl,signal}){
  const destination=await assertDownloadDestination(rawUrl,baseUrl);
  const response=await request(undefined,destination.url,{method:'GET',signal},'download',destination.pinned);
  const bytes=await readBody(response,150*1024*1024);
  if(!response.ok)httpError(response,bytes,'download');
  if(bytes.length<12||bytes.toString('ascii',4,8)!=='ftyp')fail('invalid_video','返回内容不是有效的 MP4/MOV 视频');
  return {bytes,mime:'video/mp4'};
}

export async function downloadApiAudio(rawUrl,{baseUrl,signal}){
  const destination=await assertDownloadDestination(rawUrl,baseUrl);
  const response=await request(undefined,destination.url,{method:'GET',signal},'download',destination.pinned);
  const bytes=await readBody(response,32*1024*1024);
  if(!response.ok)httpError(response,bytes,'download');
  const mime=bytes.length>=12&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WAVE'?'audio/wav':bytes.toString('ascii',0,4)==='fLaC'?'audio/flac':bytes.toString('ascii',0,3)==='ID3'||bytes.length>=2&&bytes[0]===255&&(bytes[1]&224)===224?'audio/mpeg':null;
  if(!mime)fail('invalid_audio','返回内容不是有效的 WAV、FLAC 或 MP3 音频');
  return {bytes,mime};
}

// RunningHub text outputs may be returned inline or as a result URL. Treat a
// linked result as plain text only after the normal public/loopback destination
// checks, a strict byte limit, an explicit text-like content type and UTF-8
// validation. The caller still escapes text before displaying it.
export async function downloadApiText(rawUrl,{baseUrl,signal,maxBytes=4*1024*1024}={}){
  const destination=await assertDownloadDestination(rawUrl,baseUrl);
  const response=await request(undefined,destination.url,{method:'GET',signal},'download',destination.pinned);
  const bytes=await readBody(response,Math.min(maxBytes,4*1024*1024));
  if(!response.ok)httpError(response,bytes,'download');
  const mime=String(header(response,'content-type')||'').split(';')[0].trim().toLowerCase();
  if(!['text/plain','text/markdown','application/json','application/octet-stream'].includes(mime))fail('invalid_text','RunningHub 文字结果链接返回的不是纯文字。');
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('invalid_text','RunningHub 文字结果不是有效的 UTF-8 文本。');}
  if(!text.trim()||text.length>200_000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))fail('invalid_text','RunningHub 文字结果为空、过长或包含无效控制字符。');
  return {bytes:Buffer.from(text,'utf8'),mime:'text/plain',fileName:'result.txt',text};
}
