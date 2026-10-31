import {CHAT_AUDIO_MIME} from '../public/chat-audio-types.js';
import {CHAT_VIDEO_MIME} from '../public/chat-video-types.js';
import {userError} from './workspace.mjs';

const audioTypes = new Set(Object.values(CHAT_AUDIO_MIME));
const videoTypes = new Set(Object.values(CHAT_VIDEO_MIME));
const finishReasons = new Set(['STOP','MAX_TOKENS','SAFETY','RECITATION','LANGUAGE','OTHER','BLOCKLIST','PROHIBITED_CONTENT','SPII','MALFORMED_FUNCTION_CALL','UNEXPECTED_TOOL_CALL','FINISH_REASON_UNSPECIFIED']);
export const GEMINI_CHAT_MAX_BYTES = 18 * 1024 * 1024;
export const geminiChatModel = id => typeof id === 'string' && /^gemini[-\w.]{1,160}$/.test(id) && !id.includes('..') && !/-image(?:[-.]|$)|-tts(?:[-.]|$)/i.test(id);

export function geminiChatPart(part) {
  if (part?.type === 'text' && typeof part.text === 'string') return {text: part.text};
  if (part?.type === 'gemini_audio' && audioTypes.has(part.mimeType) && typeof part.data === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(part.data)) return {inlineData: {mimeType: part.mimeType, data: part.data}};
  if (part?.type === 'gemini_video' && videoTypes.has(part.mimeType) && typeof part.data === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(part.data)) return {inlineData: {mimeType: part.mimeType, data: part.data}};
  if (part?.type === 'image_url' && typeof part.image_url?.url === 'string') {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(part.image_url.url);
    if (match) return {inlineData: {mimeType: match[1], data: match[2]}};
    throw userError('Gemini 图片上下文格式无效');
  }
  throw userError('Gemini 对话包含尚不支持的媒体类型');
}

export function geminiChatBody(contents, systemPrompt, maxTokens) {
  if (!Array.isArray(contents) || !contents.length || contents.some(m => !['user','model'].includes(m?.role) || !Array.isArray(m.parts) || !m.parts.length)) throw userError('Gemini 对话上下文格式无效');
  if (typeof systemPrompt !== 'string' || systemPrompt.length > 16000 || !Number.isInteger(maxTokens) || maxTokens < 128 || maxTokens > 8192) throw userError('系统指令最多16000字，输出上限须为128–8192');
  const body = {contents, generationConfig: {maxOutputTokens: maxTokens}, ...(systemPrompt ? {systemInstruction: {parts: [{text: systemPrompt}]}} : {})};
  if (Buffer.byteLength(JSON.stringify(body)) > GEMINI_CHAT_MAX_BYTES) throw userError('Gemini 对话内容超过18MB，请减少原视频、音频、图片或历史消息');
  return body;
}

export function geminiChatReply(response) {
  if (response?.error || response?.promptFeedback?.blockReason) throw Object.assign(userError('Gemini 未接受本次对话内容；请检查平台返回记录，不会自动重发'), {uncertain: false});
  const candidate = response?.candidates?.[0], parts = candidate?.content?.parts;
  const text = Array.isArray(parts) ? parts.filter(p => !p?.thought && typeof p?.text === 'string').map(p => p.text).join('') : '';
  if (!text.trim() || text.length > 200_000) throw userError('Gemini 未返回有效文字回答；请检查平台记录，不会自动重发');
  const finishReason = finishReasons.has(candidate.finishReason) ? candidate.finishReason : 'UNKNOWN';
  return {text, finishReason, complete: finishReason === 'STOP'};
}
