import {resolvedBackend} from './comfy-backends.mjs';
import {comfyMediaTypes} from '../public/comfy-media.js';
import { isIP } from 'node:net';

export const DEFAULT_LOCAL_ENDPOINT = 'http://127.0.0.1:8188';

const LOOPBACK_NAMES = new Set(['localhost']);
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const VIDEO_EXTENSIONS = new Set(['.avi', '.mkv', '.mov', '.mp4', '.m4v', '.webm', '.wmv']);
const AUDIO_EXTENSIONS = new Set(['.aac', '.flac', '.m4a', '.mp3', '.ogg', '.opus', '.wav', '.weba']);

export class LocalProviderError extends Error {
  constructor(message, code = 'provider_error', details = {}) {
    super(message);
    this.name = 'LocalProviderError';
    this.code = code;
    Object.assign(this, details);
  }
}

function hostnameWithoutBrackets(hostname) {
  return String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
}

function isLoopbackHostname(hostname) {
  const host = hostnameWithoutBrackets(hostname);
  if (LOOPBACK_NAMES.has(host)) return true;
  if (isIP(host) === 4) return host.split('.')[0] === '127';
  return isIP(host) === 6 && host === '::1';
}

/**
 * Validate and clone a ComfyUI endpoint.
 *
 * Only HTTP(S) endpoints whose hostname is an explicit loopback address are
 * accepted. Callers do not get to provide a custom redirect policy; every
 * request made by this module uses `redirect: "error"`.
 */
export function validateLocalEndpoint(endpoint = DEFAULT_LOCAL_ENDPOINT) {
  let url;
  try {
    url = endpoint instanceof URL ? new URL(endpoint.href) : new URL(String(endpoint));
  } catch {
    throw new LocalProviderError('ComfyUI 地址无效', 'invalid_endpoint');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new LocalProviderError('ComfyUI 地址必须使用 HTTP 或 HTTPS', 'invalid_endpoint');
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new LocalProviderError('ComfyUI 地址必须指向本机 loopback', 'non_loopback_endpoint');
  }
  if (url.username || url.password) {
    throw new LocalProviderError('ComfyUI 地址不得包含用户名或密码', 'invalid_endpoint');
  }
  if (url.search || url.hash) {
    throw new LocalProviderError('ComfyUI 地址不得包含查询参数或片段', 'invalid_endpoint');
  }
  return url;
}

export function validateComfyEndpoint(endpoint=DEFAULT_LOCAL_ENDPOINT){return resolvedBackend(endpoint)||validateLocalEndpoint(endpoint);}

function makeApiUrl(endpoint, pathname, searchParams) {
  const base = validateComfyEndpoint(endpoint);
  let basePath = base.pathname || '/';
  if (!basePath.endsWith('/')) basePath += '/';
  const url = new URL(String(pathname).replace(/^\/+/, ''), `${base.origin}${basePath}`);
  if (searchParams) {
    for (const [name, value] of Object.entries(searchParams)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value));
    }
  }
  return url;
}

async function fetchLocal(fetchImpl, url, init = {}) {
  if (typeof fetchImpl !== 'function') throw new LocalProviderError('当前 Node 环境没有可用 fetch', 'fetch_unavailable');
  let response;
  try {
    response = await fetchImpl(url, { ...init, redirect: 'error' });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new LocalProviderError('ComfyUI 请求失败或发生重定向，已拒绝连接', 'request_failed', { cause: error });
  }
  if (response.status >= 300 && response.status < 400) {
    throw new LocalProviderError('ComfyUI 返回了重定向，已拒绝连接', 'redirect_rejected', { status: response.status });
  }
  if (response.url) {
    try {
      const responseUrl = new URL(response.url);
      if (responseUrl.origin !== url.origin) {
        throw new LocalProviderError('ComfyUI 请求发生跨源重定向，已拒绝连接', 'redirect_rejected');
      }
    } catch (error) {
      if (error instanceof LocalProviderError) throw error;
    }
  }
  return response;
}

async function responseText(response) {
  try {
    return (await response.text()).slice(0, 2000);
  } catch {
    return '';
  }
}

async function ensureOk(response, operation) {
  if (response.ok) return;
  const detail = await responseText(response);
  const suffix = detail ? `：${detail.replace(/\s+/g, ' ').trim()}` : '';
  throw new LocalProviderError(`${operation}失败（HTTP ${response.status}）${suffix}`, 'http_error', { status: response.status });
}

async function jsonResponse(response, operation) {
  await ensureOk(response, operation);
  try {
    return await response.json();
  } catch (error) {
    throw new LocalProviderError(`${operation}返回的 JSON 无效`, 'invalid_json', { cause: error });
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const INPUT_IMAGE_TYPES = { 'image/png': /\.png$/i, 'image/jpeg': /\.jpe?g$/i, 'image/webp': /\.webp$/i };
function safeImagePathPart(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 180 &&
    value.trim() === value && value !== '.' && value !== '..' &&
    /^[\p{L}\p{N} ._()\-]+$/u.test(value);
}

export function validateInputImage({ bytes, mime, name } = {}) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw new LocalProviderError('输入图片必须是本地图片字节', 'invalid_input_image');
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new LocalProviderError('输入图片须为 1 字节至 10 MB', 'invalid_input_image');
  if (!Object.hasOwn(INPUT_IMAGE_TYPES, mime) || !safeImagePathPart(name) || !INPUT_IMAGE_TYPES[mime].test(name)) throw new LocalProviderError('输入图片只支持文件名安全的 PNG、JPEG 或 WebP', 'invalid_input_image');
  const b = Buffer.from(bytes);
  const signature = mime === 'image/png' ? b.length >= 8 && b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) :
    mime === 'image/jpeg' ? b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255 :
    b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP';
  if (!signature) throw new LocalProviderError('输入图片内容与 PNG、JPEG 或 WebP 格式不符', 'invalid_input_image');
  return { bytes: b, mime, name };
}

export function validateInputMedia(input={}) {
 if(input.mime?.startsWith('image/'))return validateInputImage(input);
 const {bytes,mime,name}=input,spec=comfyMediaTypes[mime];
 if(!spec||(!Buffer.isBuffer(bytes)&&!(bytes instanceof Uint8Array))||!bytes.length||bytes.length>spec.limit*1024*1024||!safeImagePathPart(name)||!name.toLowerCase().endsWith('.'+spec.extension))throw new LocalProviderError('输入音视频格式、文件名或大小无效（最大150MB）','invalid_input_media');
 const b=Buffer.from(bytes),riff=b.toString('ascii',0,4),ftyp=b.toString('ascii',4,8),signature=mime==='audio/wav'||mime==='audio/x-wav'?riff==='RIFF'&&b.toString('ascii',8,12)==='WAVE':mime==='audio/mpeg'?riff.startsWith('ID3')||b[0]===255&&(b[1]&224)===224:mime==='audio/flac'?riff==='fLaC':mime==='audio/ogg'?riff==='OggS':mime==='video/webm'?b.subarray(0,4).equals(Buffer.from('1a45dfa3','hex')):ftyp==='ftyp';
 if(b.length<12||!signature)throw new LocalProviderError('输入音视频内容与声明格式不匹配','invalid_input_media');
 return {bytes:b,mime,name};
}

/** ComfyUI server.py /upload/image: never overwrite or automatically retry uploads. */
export async function uploadInputImage(endpoint = DEFAULT_LOCAL_ENDPOINT, image, options = {}) {
  return uploadInputMedia(endpoint,validateInputImage(image),options);
}
export async function uploadInputMedia(endpoint = DEFAULT_LOCAL_ENDPOINT, media, options = {}) {
  const url = makeApiUrl(endpoint, 'upload/image');
  const checked = validateInputMedia(media);
  const form = new FormData();
  form.append('image', new Blob([checked.bytes], { type: checked.mime }), checked.name);
  form.append('type', 'input');
  form.append('overwrite', 'false');
  const response = await fetchLocal(options.fetchImpl || globalThis.fetch, url, {
    method: 'POST', body: form, signal: options.signal,
  });
  const result = await jsonResponse(response, '上传本机输入素材');
  const subfolder = result?.subfolder;
  if (!safeImagePathPart(result?.name) || !(checked.mime.startsWith('image/')?INPUT_IMAGE_TYPES[checked.mime].test(result.name):result.name.toLowerCase().endsWith('.'+comfyMediaTypes[checked.mime].extension)) || result.type !== 'input' ||
    typeof subfolder !== 'string' || subfolder.length > 240 ||
    (subfolder !== '' && !subfolder.split('/').every(safeImagePathPart))) {
    throw new LocalProviderError('ComfyUI 返回的图片文件名、目录或类型不安全', 'invalid_upload_response');
  }
  return { name: result.name, subfolder, type: 'input' };
}

function workflowGraph(workflow) {
  if (!isPlainObject(workflow)) throw new LocalProviderError('ComfyUI 工作流必须是对象', 'invalid_workflow');
  if (isPlainObject(workflow.prompt)) return workflow.prompt;
  return workflow;
}

function validNode(node) {
  return isPlainObject(node) && typeof node.class_type === 'string' && node.class_type.trim() &&
    (node.inputs === undefined || isPlainObject(node.inputs));
}

function checkedWorkflow(workflow) {
  const graph = workflowGraph(workflow);
  const entries = Object.entries(graph);
  if (!entries.length) throw new LocalProviderError('ComfyUI 工作流不能为空', 'invalid_workflow');
  for (const [id, node] of entries) {
    if (!validNode(node)) throw new LocalProviderError(`ComfyUI 节点 ${id} 格式无效`, 'invalid_workflow');
  }
  return graph;
}

function editableInputs(inputs = {}) {
  return Object.entries(inputs)
    .filter(([, value]) => {
      if (typeof value === 'string' || typeof value === 'boolean') return true;
      return typeof value === 'number' && Number.isFinite(value);
    })
    .map(([name, value]) => ({ name, type: typeof value, value }));
}

/**
 * Summarize a ComfyUI API-format workflow without exposing edge arrays as
 * editable fields. The returned values are safe to render in a form and do
 * not mutate the caller's workflow.
 */
export function inspectWorkflow(workflow) {
  const graph = checkedWorkflow(workflow);
  const nodes = Object.entries(graph).map(([id, node]) => ({
    id,
    class_type: node.class_type,
    title: typeof node._meta?.title === 'string' ? node._meta.title : null,
    inputs: editableInputs(node.inputs),
  }));
  return { nodeCount: nodes.length, nodes };
}

function validatePromptId(promptId) {
  if (typeof promptId !== 'string' || !promptId || promptId.length > 200 || /[\u0000-\u001f\u007f/\\]/.test(promptId)) {
    throw new LocalProviderError('ComfyUI prompt_id 无效', 'invalid_prompt_id');
  }
  return promptId;
}

/**
 * Submit an API-format workflow to local ComfyUI.
 * Returns `{ promptId, prompt_id, number, nodeErrors, raw }`.
 */
export async function submitWorkflow(endpoint = DEFAULT_LOCAL_ENDPOINT, workflow, options = {}) {
  const graph = checkedWorkflow(workflow);
  const payload = { prompt: graph };
  if (typeof options.clientId === 'string' && options.clientId) payload.client_id = options.clientId;
  if (typeof options.promptId === 'string' && options.promptId) payload.prompt_id = validatePromptId(options.promptId);
  if (isPlainObject(options.extraData)) payload.extra_data = options.extraData;
  if (Number.isFinite(options.number)) payload.number = options.number;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const response = await fetchLocal(fetchImpl, makeApiUrl(endpoint, 'prompt'), {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
    signal: options.signal,
  });
  const result = await jsonResponse(response, '提交工作流');
  const promptId = result?.prompt_id;
  if (typeof promptId !== 'string' || !promptId) {
    throw new LocalProviderError('ComfyUI 没有返回 prompt_id', 'invalid_response');
  }
  return {
    promptId,
    prompt_id: promptId,
    number: result.number ?? null,
    nodeErrors: result.node_errors ?? {},
    raw: result,
  };
}

function extensionOf(fileName) {
  const match = /\.[^./\\?#]+$/.exec(String(fileName || '').toLowerCase());
  return match ? match[0] : '';
}

function inferKind(key, fileName = '') {
  const name = String(key).toLowerCase();
  if (name === 'audio' || name === 'audios') return 'audio';
  if (name === 'video' || name === 'videos' || name === 'gifs') return 'video';
  const extension = extensionOf(fileName);
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  return 'image';
}

function inferMime(fileName, kind) {
  const extension = extensionOf(fileName);
  const known = {
    '.avif': 'image/avif', '.bmp': 'image/bmp', '.gif': 'image/gif', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg',
    '.png': 'image/png', '.webp': 'image/webp', '.aac': 'audio/aac', '.flac': 'audio/flac', '.m4a': 'audio/mp4',
    '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/opus', '.wav': 'audio/wav', '.weba': 'audio/webm',
    '.avi': 'video/x-msvideo', '.m4v': 'video/x-m4v', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.wmv': 'video/x-ms-wmv',
  };
  return known[extension] || `${kind}/*`;
}

function outputDescriptor(nodeId, key, item) {
  const value = typeof item === 'string' ? { filename: item } : item;
  if (!isPlainObject(value) || typeof value.filename !== 'string' || !value.filename.trim()) return null;
  const kind = inferKind(key, value.filename);
  const subfolder = typeof value.subfolder === 'string' ? value.subfolder : '';
  const type = typeof value.type === 'string' && value.type ? value.type : 'output';
  return {
    nodeId: String(nodeId),
    kind,
    fileName: value.filename,
    filename: value.filename,
    subfolder,
    type,
    mime: typeof value.mime === 'string' ? value.mime : inferMime(value.filename, kind),
    mimeType: typeof value.mimeType === 'string' ? value.mimeType : inferMime(value.filename, kind),
    view: { filename: value.filename, subfolder, type },
  };
}

function listOutputs(outputs) {
  if (!isPlainObject(outputs)) return [];
  const result = [];
  for (const [nodeId, nodeOutput] of Object.entries(outputs)) {
    if (!isPlainObject(nodeOutput)) continue;
    for (const [key, value] of Object.entries(nodeOutput)) {
      if (!['image', 'images', 'video', 'videos', 'gif', 'gifs', 'audio', 'audios', 'file', 'files'].includes(key.toLowerCase())) continue;
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) {
        const descriptor = outputDescriptor(nodeId, key, item);
        if (descriptor) result.push(descriptor);
      }
    }
  }
  return result;
}

function historyRecord(payload, promptId) {
  if (!isPlainObject(payload)) return null;
  if (isPlainObject(payload[promptId])) return payload[promptId];
  if (isPlainObject(payload.history) && isPlainObject(payload.history[promptId])) return payload.history[promptId];
  if (payload.prompt_id === promptId) return payload;
  return null;
}

function historyStatus(record) {
  const status = isPlainObject(record?.status) ? record.status : {};
  const raw = String(status.status_str ?? status.status ?? status.state ?? '').toLowerCase();
  if (/(error|fail|cancel)/.test(raw) || status.success === false) return 'failed';
  if (status.completed === true || /^(success|complete|completed|done|finished)$/.test(raw)) return 'completed';
  return 'pending';
}

function historyError(record) {
  const status = record?.status;
  if (!status) return null;
  const messages = Array.isArray(status.messages) ? status.messages : [];
  const text = messages.map(item => {
    if (Array.isArray(item)) return item.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
    return typeof item === 'string' ? item : JSON.stringify(item);
  }).join('\n').trim();
  return text || status.status_str || status.error || null;
}

/**
 * Read one ComfyUI history entry. An absent entry is treated as pending,
 * matching ComfyUI's queue-before-history behavior.
 */
export async function queryWorkflow(endpoint = DEFAULT_LOCAL_ENDPOINT, promptId, options = {}) {
  const id = validatePromptId(promptId);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const response = await fetchLocal(fetchImpl, makeApiUrl(endpoint, `history/${encodeURIComponent(id)}`), {
    method: 'GET',
    signal: options.signal,
  });
  const payload = await jsonResponse(response, '查询工作流历史');
  const record = historyRecord(payload, id);
  if (!record) return { promptId: id, prompt_id: id, status: 'pending', outputs: [], raw: payload };
  const status = historyStatus(record);
  return {
    promptId: id,
    prompt_id: id,
    status,
    outputs: listOutputs(record.outputs),
    error: status === 'failed' ? historyError(record) : null,
    raw: record,
  };
}

function contentDispositionFileName(value) {
  if (!value) return null;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(value);
  if (encoded) {
    try { return decodeURIComponent(encoded[1].replace(/^"|"$/g, '')); } catch { return encoded[1]; }
  }
  const plain = /filename="?([^";]+)"?/i.exec(value);
  return plain ? plain[1] : null;
}

async function consumeBody(response, onChunk, collect, metadata) {
  const chunks = [];
  let size = 0;
  const push = async chunk => {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (typeof onChunk === 'function') await onChunk(bytes, { ...metadata, size });
    if (collect) chunks.push(bytes);
  };
  if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of response.body) await push(chunk);
  } else if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        await push(next.value);
      }
    } finally {
      reader.releaseLock?.();
    }
  } else {
    await push(await response.arrayBuffer());
  }
  return { bytes: collect ? Buffer.concat(chunks) : undefined, size };
}

/**
 * Download one descriptor returned by queryWorkflow. With `onChunk`, data is
 * streamed to the caller; by default callback mode avoids retaining the whole
 * file. Set `collect: true` to receive both callback chunks and `bytes`.
 */
export async function downloadOutput(endpoint = DEFAULT_LOCAL_ENDPOINT, output, options = {}) {
  if (!isPlainObject(output) || typeof (output.filename || output.fileName) !== 'string') {
    throw new LocalProviderError('生成文件描述无效', 'invalid_output');
  }
  const filename = output.filename || output.fileName;
  const subfolder = typeof output.subfolder === 'string' ? output.subfolder : '';
  const type = typeof output.type === 'string' && output.type ? output.type : 'output';
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const response = await fetchLocal(fetchImpl, makeApiUrl(endpoint, 'view', { filename, subfolder, type }), {
    method: 'GET',
    signal: options.signal,
  });
  await ensureOk(response, '下载生成文件');
  const headerMime = response.headers?.get?.('content-type')?.split(';', 1)[0]?.trim();
  const mime = headerMime || output.mime || output.mimeType || inferMime(filename, output.kind || inferKind('', filename));
  const fileName = contentDispositionFileName(response.headers?.get?.('content-disposition')) || filename;
  const metadata = { fileName, filename: fileName, mime, mimeType: mime };
  const collect = options.collect === true || typeof options.onChunk !== 'function';
  const consumed = await consumeBody(response, options.onChunk, collect, metadata);
  return { ...metadata, bytes: consumed.bytes, size: consumed.size };
}

export async function inspectComfyBackend(endpoint,options={}){const response=await fetchLocal(options.fetchImpl||globalThis.fetch,makeApiUrl(endpoint,'system_stats'),{method:'GET',signal:options.signal||AbortSignal.timeout(5000)});await ensureOk(response,'检查ComfyUI连接');let size=0,chunks=[];for await(const chunk of response.body){size+=chunk.length;if(size>1024*1024)throw new LocalProviderError('后端状态响应过大','invalid_response');chunks.push(chunk);}let result;try{result=JSON.parse(Buffer.concat(chunks));}catch{throw new LocalProviderError('后端未返回有效状态JSON','invalid_response');}if(!result||!isPlainObject(result.system)||!Array.isArray(result.devices))throw new LocalProviderError('地址未返回ComfyUI系统状态','invalid_response');return{connected:true,version:typeof result.system.comfyui_version==='string'?result.system.comfyui_version.slice(0,80):null,deviceCount:result.devices.length};}
