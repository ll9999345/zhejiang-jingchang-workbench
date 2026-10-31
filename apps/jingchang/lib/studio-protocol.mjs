import {assertImageRequestSize} from './image-api.mjs';
import {IMAGE_REFERENCE_LIMIT} from '../public/reference-limits.js';
import { safeApiCall, parseImageData, MAX_JSON_BYTES } from './image-api.mjs';

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MEDIA_FIELDS = new Set(['image', 'video', 'audio']);
const MAX_UPLOAD_BYTES = MAX_JSON_BYTES;

export class StudioProtocolError extends Error {
  constructor(code, message, { uncertain = false } = {}) {
    super(message);
    this.name = 'StudioProtocolError';
    this.code = code;
    this.publicMessage = message;
    this.uncertain = Boolean(uncertain);
  }
}

function invalid(message) {
  throw new StudioProtocolError('invalid_studio_request', message);
}

function validBase(baseUrl, apiKey) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) invalid('请先配置有效的服务地址。');
  let host = '';
  try { host = new URL(baseUrl).hostname.toLowerCase(); } catch { /* the transport reports the URL error */ }
  if (typeof apiKey !== 'string' || (!apiKey.trim() && !['localhost', '127.0.0.1', '[::1]'].includes(host))) invalid('请先配置 API Key。');
}

function validPrompt(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 32_000) invalid('提示词无效。');
  return prompt.trim();
}

function validModel(model) {
  if (typeof model !== 'string' || !model.trim() || model.length > 256) invalid('模型名称无效。');
  return model.trim();
}

function validId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) {
    throw new StudioProtocolError('invalid_upstream_id', '上游任务编号无效。');
  }
  return id;
}

function uploadedMediaType(mime) {
  if (IMAGE_MIMES.has(mime)) return 'image';
  if (typeof mime === 'string' && mime.startsWith('video/')) return 'video';
  if (typeof mime === 'string' && mime.startsWith('audio/')) return 'audio';
  return null;
}

function mediaUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192) {
    throw new StudioProtocolError('invalid_upstream_response', '上游没有返回有效的媒体地址。', { uncertain: true });
  }
  let url;
  try { url = new URL(value); } catch {
    throw new StudioProtocolError('invalid_upstream_response', '上游没有返回有效的媒体地址。', { uncertain: true });
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new StudioProtocolError('invalid_upstream_response', '上游没有返回有效的媒体地址。', { uncertain: true });
  }
  return value;
}

function mediaReference(reference) {
  if (!reference || typeof reference !== 'object' || typeof reference.url !== 'string') {
    invalid('参考媒体信息无效。');
  }
  const type = MEDIA_FIELDS.has(reference.type) ? reference.type : uploadedMediaType(reference.type);
  if (!type) invalid('参考媒体类型无效。');
  return { url: mediaUrl(reference.url), type };
}

function operationOf(studio) {
  const operation = studio?.config?.operation ?? 'generate';
  if (!['generate', 'edit', 'extend'].includes(operation)) invalid('视频操作类型无效。');
  return operation;
}

function videoPayload(studio, references) {
  if (!studio || typeof studio !== 'object') invalid('创作参数无效。');
  const config = studio.config || {};
  const operation = operationOf(studio);
  const model = validModel(config.model);
  const prompt = validPrompt(studio.prompt);
  const refs = references.map(mediaReference);
  if (operation === 'generate') {
    const images = refs.filter(ref => ref.type === 'image');
    if (refs.length > 1 || refs.some(ref => ref.type !== 'image')) {
      invalid('视频生成暂只支持一张图片参考，不支持多图、视频或音频参考。');
    }
    if (!['480p', '720p', '1080p'].includes(config.resolution)) invalid('视频分辨率无效。');
    if (typeof config.duration !== 'number' || !Number.isFinite(config.duration) || config.duration <= 0 || config.duration > 60) invalid('视频时长无效。');
    if (typeof config.ratio !== 'string' || !/^\d{1,2}:\d{1,2}$/.test(config.ratio)) invalid('视频画面比例无效。');
    if (config.generateAudio !== undefined && typeof config.generateAudio !== 'boolean') invalid('视频声音设置无效。');
    const body = {
      model,
      prompt,
      resolution: config.resolution,
      duration: config.duration,
      aspect_ratio: config.ratio,
      audio: config.generateAudio ?? false,
    };
    if (images.length) body.image_url = images[0].url;
    return { path: 'videos/generations', body };
  }

  if (refs.length !== 1 || refs[0].type !== 'video') invalid('视频编辑和续写需要且只支持一个视频参考。');
  if (typeof config.duration !== 'number' || !Number.isFinite(config.duration) || config.duration <= 0 || config.duration > 60) invalid('视频时长无效。');
  return {
    path: operation === 'edit' ? 'videos/edits' : 'videos/extensions',
    body: { model, prompt, video: { url: refs[0].url }, duration: config.duration },
  };
}

function upstreamId(payload) {
  const id = payload?.job_id ?? payload?.request_id ?? payload?.id;
  try { return validId(id); } catch {
    throw new StudioProtocolError('invalid_upstream_response', '上游已收到提交，但没有返回有效的任务编号；请先核对平台任务与账单。', { uncertain: true });
  }
}

function normalizeStatus(value) {
  const status = String(value ?? '').toLowerCase();
  if (['queued', 'pending', 'created', 'submitted'].includes(status)) return 'queued';
  if (['running', 'processing', 'in_progress'].includes(status)) return 'running';
  if (['completed', 'succeeded', 'success', 'done'].includes(status)) return 'completed';
  if (['failed', 'error', 'rejected'].includes(status)) return 'failed';
  if (['cancelled', 'canceled'].includes(status)) return 'cancelled';
  throw new StudioProtocolError('invalid_upstream_response', '上游返回了无法识别的任务状态。', { uncertain: true });
}

function progressValue(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(100, Math.max(0, value <= 1 ? value * 100 : value));
}

function sanitizedUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return undefined;
  const allowed = new Set(['total_tokens', 'input_tokens', 'output_tokens', 'prompt_tokens', 'completion_tokens', 'images_generated']);
  const result = Object.fromEntries(Object.entries(usage).filter(([key, value]) =>
    allowed.has(key) && typeof value === 'number' && Number.isFinite(value) && value >= 0,
  ));
  return Object.keys(result).length ? result : undefined;
}

function safeStatusMessage(status) {
  if (status === 'failed') return '上游视频任务失败。';
  if (status === 'cancelled') return '上游视频任务已取消。';
  return undefined;
}

export async function uploadReference({ baseUrl, apiKey, reference, signal } = {}) {
  validBase(baseUrl, apiKey);
  const mime = reference?.mime;
  const field = uploadedMediaType(mime);
  const bytes = Buffer.isBuffer(reference?.bytes) ? reference.bytes : Buffer.from(reference?.bytes ?? []);
  if (!field || bytes.length === 0 || bytes.length > MAX_UPLOAD_BYTES || (field === 'image' && bytes.length > 10 * 1024 * 1024)) {
    invalid('参考媒体格式或大小无效。');
  }
  const filename = typeof reference.name === 'string' && reference.name.trim()
    ? reference.name.replace(/[\\/\0\r\n]/g, '_').slice(0, 180)
    : `reference.${field === 'image' ? 'png' : field === 'video' ? 'mp4' : 'mp3'}`;
  const form = new FormData();
  form.append(field, new Blob([bytes], { type: mime }), filename);
  const payload = await safeApiCall({ baseUrl, path: 'videos/uploads', apiKey, method: 'POST', body: form, signal });
  return mediaUrl(payload?.media_url);
}

export async function submitVideo({ baseUrl, apiKey, studio, references = [], signal } = {}) {
  validBase(baseUrl, apiKey);
  if (!Array.isArray(references)) invalid('参考媒体列表无效。');
  const { path, body } = videoPayload(studio, references);
  const payload = await safeApiCall({ baseUrl, path, apiKey, method: 'POST', body, signal });
  return { upstreamId: upstreamId(payload), status: normalizeStatus(payload?.status ?? 'queued') };
}

export async function queryVideo({ baseUrl, apiKey, upstreamId: rawId, signal } = {}) {
  validBase(baseUrl, apiKey);
  const id = validId(rawId);
  const payload = await safeApiCall({ baseUrl, path: `videos/jobs/${id}`, apiKey, signal });
  const status = normalizeStatus(payload?.status);
  const progress = progressValue(payload?.progress);
  return {
    status,
    ...(progress === undefined ? {} : { progress }),
    ...(safeStatusMessage(status) ? { message: safeStatusMessage(status) } : {}),
  };
}

export async function downloadVideo({ baseUrl, apiKey, upstreamId: rawId, signal } = {}) {
  validBase(baseUrl, apiKey);
  const id = validId(rawId);
  const result = await safeApiCall({
    baseUrl, path: `videos/jobs/${id}/content`, apiKey, signal,
    responseType: 'bytes', maxBytes: 150 * 1024 * 1024,
  });
  return { bytes: result.bytes, mime: result.mime };
}

export async function cancelVideo({ baseUrl, apiKey, upstreamId: rawId, signal } = {}) {
  validBase(baseUrl, apiKey);
  const id = validId(rawId);
  await safeApiCall({ baseUrl, path: `videos/jobs/${id}`, apiKey, method: 'DELETE', signal, responseType: 'bytes', maxBytes: 1024 * 1024 });
  return { status: 'cancelled' };
}

function imageBody(studio) {
  const config = studio?.config || {};
  const model = validModel(config.model);
  const prompt = validPrompt(studio?.prompt);
  const count = config.count ?? 1;
  if (![1, 2, 4].includes(count)) invalid('一次生成数量只能是 1、2 或 4。');
  const body = {
    model,
    prompt,
    size: typeof config.size === 'string' && config.size ? config.size : '1024x1024',
    quality: typeof config.quality === 'string' && config.quality ? config.quality : 'auto',
    n: count,
    background: config.transparent ? 'transparent' : 'auto',
  };
  if (body.size.length > 64 || body.quality.length > 64) invalid('图片尺寸或质量参数无效。');
  return body;
}

export async function generateStudioImages({ baseUrl, apiKey, studio, references = [], signal } = {}) {
  validBase(baseUrl, apiKey);
  if (!Array.isArray(references) || references.length > IMAGE_REFERENCE_LIMIT) invalid('图片参考最多支持 20 张。');
  const body = imageBody(studio);
  assertImageRequestSize(references.reduce((sum,r)=>sum+(r?.bytes?.length||0),0),body.prompt,body.model);
  let path = 'images/generations';
  let requestBody = body;
  if (references.length) {
    path = 'images/edits';
    const form = new FormData();
    for (const reference of references) {
      const bytes = Buffer.isBuffer(reference?.bytes) ? reference.bytes : Buffer.from(reference?.bytes ?? []);
      if (!IMAGE_MIMES.has(reference?.mime) || bytes.length === 0 || bytes.length > 10 * 1024 * 1024) invalid('图片参考必须是 10 MB 以内的 PNG、JPEG 或 WebP。');
      const name = typeof reference.name === 'string' && reference.name.trim()
        ? reference.name.replace(/[\\/\0\r\n]/g, '_').slice(0, 180)
        : 'reference.png';
      form.append('image[]', new Blob([bytes], { type: reference.mime }), name);
    }
    for (const [key, value] of Object.entries(body)) form.append(key, String(value));
    requestBody = form;
  }
  const payload = await safeApiCall({ baseUrl, path, apiKey, method: 'POST', body: requestBody, signal });
  let images;
  try {
    images = await parseImageData(payload, { baseUrl, signal, maxImages: body.n });
  } catch {
    throw new StudioProtocolError('invalid_image_result', '上游已接受图片请求，但结果无法安全解析；请先核对平台任务与账单。', { uncertain: true });
  }
  const usage = sanitizedUsage(payload?.usage);
  return {
    images,
    ...(usage ? { usage } : {}),
  };
}

export async function submitImageTask({ baseUrl, apiKey, studio, references = [], signal } = {}) {
  validBase(baseUrl, apiKey);
  if (studio?.mode !== 'image' || studio?.config?.imageAsync !== true) invalid('请先启用图片异步生成模式。');
  if (!Array.isArray(references) || references.length !== 0) invalid('图片异步生成当前只支持纯文字输入。');
  const config = studio.config;
  if ((config.count ?? 1) !== 1 || config.transparent === true || (config.quality !== undefined && config.quality !== 'auto')) {
    invalid('图片异步生成当前只支持单张、非透明、默认质量参数。');
  }
  const body = imageBody(studio);
  assertImageRequestSize(references.reduce((sum,r)=>sum+(r?.bytes?.length||0),0),body.prompt,body.model);
  const payload = await safeApiCall({
    baseUrl, path: 'images/generations/async', apiKey, method: 'POST',
    body: { model: body.model, prompt: body.prompt, size: body.size }, signal,
  });
  return { upstreamId: upstreamId({ id: payload?.task_id }), status: normalizeStatus(payload?.status ?? 'queued') };
}

export async function queryImageTask({ baseUrl, apiKey, upstreamId: rawId, signal } = {}) {
  validBase(baseUrl, apiKey);
  const id = validId(rawId);
  const payload = await safeApiCall({ baseUrl, path: `images/tasks/${id}`, apiKey, signal });
  const status = normalizeStatus(payload?.status);
  const progress = progressValue(payload?.progress);
  if (status === 'failed' || status === 'cancelled') {
    return { status, ...(status === 'failed' ? { message: '上游图片任务失败。' } : { message: '上游图片任务已取消。' }) };
  }
  if (status !== 'completed') return { status, ...(progress === undefined ? {} : { progress }) };
  let images;
  try {
    images = await parseImageData(payload, { baseUrl, signal, maxImages: 1 });
  } catch {
    throw new StudioProtocolError('invalid_image_result', '上游图片任务已完成，但结果无法安全解析；请先核对平台任务与账单。', { uncertain: true });
  }
  return { status: 'completed', progress: 100, images };
}
