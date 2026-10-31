import path from 'node:path';
import {promises as fs, createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {CHAT_VIDEO_MIME, CHAT_NATIVE_VIDEO_MAX_BYTES, NATIVE_VIDEO_METHOD} from '../public/chat-video-types.js';
import {atomicJson, safeId, userError} from './workspace.mjs';
import {inspectVideoForChat} from './media-tools.mjs';

const hashes = /^[a-f0-9]{64}$/;
const locks = new Map(), inspections = new Map();
const digestBytes = bytes => createHash('sha256').update(bytes).digest('hex');
async function digestFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function normalizeNativeVideo(value) {
  if (!value || !safeId(value.id) || !safeId(value.assetId) || value.method !== NATIVE_VIDEO_METHOD || !hashes.test(value.sourceSha256) || !CHAT_VIDEO_MIME[value.sourceType] || value.mimeType !== CHAT_VIDEO_MIME[value.sourceType] || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > CHAT_NATIVE_VIDEO_MAX_BYTES || !Number.isFinite(value.duration) || value.duration <= 0 || value.duration > 21600 || !Number.isInteger(value.width) || !Number.isInteger(value.height) || value.width < 1 || value.height < 1 || value.width > 8192 || value.height > 8192 || value.width * value.height > 16777216 || typeof value.hasAudio !== 'boolean') throw userError('原视频预览记录无效');
  return {id: value.id, assetId: value.assetId, method: value.method, sourceSha256: value.sourceSha256, sourceType: value.sourceType, mimeType: value.mimeType, size: value.size, duration: value.duration, width: value.width, height: value.height, hasAudio: value.hasAudio};
}

export function nativeVideos(value = []) {
  if (!Array.isArray(value) || value.length > 3) throw userError('原视频预览记录无效');
  const result = value.map(normalizeNativeVideo);
  if (new Set(result.map(v => v.assetId)).size !== result.length) throw userError('原视频预览重复');
  return result;
}

async function directory(data) {
  const root = await fs.realpath(data), dir = path.join(root, 'chat-native-videos');
  await fs.mkdir(dir, {recursive: true});
  if (await fs.realpath(dir) !== dir) throw userError('原视频预览目录不能是符号链接');
  return dir;
}

export async function readNativeVideo(data, id) {
  if (!safeId(id)) throw userError('原视频预览编号无效');
  const file = path.join(await directory(data), id + '.json');
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > 65536) throw userError('原视频预览记录无效');
    const value = normalizeNativeVideo(JSON.parse(await fs.readFile(file, 'utf8')));
    if (value.id !== id) throw userError('原视频预览编号不一致');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') throw userError('找不到原视频预览，请重新准备后再发送');
    if (error.status) throw error;
    throw userError('原视频预览记录无法读取');
  }
}

async function inspect(data, source, sourceSha256) {
  // Cache only metadata for exact local bytes, never media content or secrets.
  const key = source.root + ':' + source.meta.id + ':' + sourceSha256;
  if (!inspections.has(key)) {
    if (inspections.size >= 128) inspections.delete(inspections.keys().next().value);
    const task = inspectVideoForChat({data, assetId: source.meta.id});
    inspections.set(key, task);
    task.catch(() => inspections.delete(key));
  }
  return inspections.get(key);
}

export async function nativeVideoParts(data, value, source) {
  const video = normalizeNativeVideo(value);
  if (source.meta.id !== video.assetId || source.meta.type !== video.sourceType || source.meta.size !== video.size) throw userError('原视频预览与文件记录不一致');
  const bytes = await fs.readFile(source.file);
  if (bytes.length !== video.size || digestBytes(bytes) !== video.sourceSha256) throw userError('原视频文件已变化，请恢复原文件或重新导入');
  const info = await inspect(data, source, video.sourceSha256);
  if (info.width !== video.width || info.height !== video.height || Math.abs(info.duration - video.duration) > 0.001 || info.hasAudio !== video.hasAudio) throw userError('原视频预览的时长、尺寸或声音记录与文件不一致');
  return [
    {type: 'text', text: `以下为原始参考视频。时长 ${video.duration.toFixed(3)} 秒，${video.width}×${video.height}；${video.hasAudio ? '文件含音轨，按模型实际能力理解画面与声音' : '文件没有音轨，不要推断声音或对话'}。不要推断文件中不存在的事件。`},
    {type: 'gemini_video', mimeType: video.mimeType, data: bytes.toString('base64')},
  ];
}

export async function prepareNativeVideo(data, source) {
  if (!CHAT_VIDEO_MIME[source.meta.type]) throw userError('原视频输入只支持 MP4、WebM 和 MOV');
  if (source.meta.size > CHAT_NATIVE_VIDEO_MAX_BYTES) throw userError('原视频输入每份不能超过10MB；可改用抽样画面或先在本地压缩视频');
  const sourceSha256 = await digestFile(source.file);
  const id = createHash('sha256').update([NATIVE_VIDEO_METHOD, source.meta.id, sourceSha256, source.meta.type, source.meta.size].join(':')).digest('hex');
  const key = source.root + ':native:' + id;
  if (locks.has(key)) return locks.get(key);
  const task = (async () => {
    const file = path.join(await directory(data), id + '.json');
    if (await fs.lstat(file).catch(error => {if (error.code === 'ENOENT') return null; throw error;})) {
      const existing = await readNativeVideo(data, id);
      await nativeVideoParts(data, existing, source);
      return existing;
    }
    const info = await inspect(data, source, sourceSha256);
    if (await digestFile(source.file) !== sourceSha256) throw userError('视频在准备预览时发生变化，请重新导入');
    const video = normalizeNativeVideo({id, assetId: source.meta.id, method: NATIVE_VIDEO_METHOD, sourceSha256, sourceType: source.meta.type, mimeType: CHAT_VIDEO_MIME[source.meta.type], size: source.meta.size, ...info});
    await atomicJson(file, video);
    return video;
  })();
  locks.set(key, task);
  try {return await task;} finally {locks.delete(key);}
}

export function validateBundleNativeVideos(conversations, assets, version) {
  const byId = new Map(assets.map(a => [a.id, a]));
  for (const conversation of conversations) for (const message of conversation.messages) {
    const videos = nativeVideos(message.nativeVideos);
    if (videos.length && version < 13) throw userError('原视频对话需要第13版备份格式');
    if (videos.length && (message.role !== 'user' || ['image','agent'].includes(message.mode))) throw userError('原视频只能属于文字对话的用户消息');
    for (const video of videos) {
      const asset = byId.get(video.assetId);
      if (!message.assetIds.includes(video.assetId) || !asset || asset.type !== video.sourceType || asset.size !== video.size || asset.sha256 !== video.sourceSha256) throw userError('备份原视频文件与预览记录不一致');
    }
  }
}
