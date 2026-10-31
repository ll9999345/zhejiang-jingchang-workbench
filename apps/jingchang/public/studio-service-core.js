import {isLocalMiaoTarget} from './miao-credential-core.js';
export const STUDIO_SERVICE_BUILD = '2026.10.09-service.1';
const registeredImageContracts = new Set(['gpt-image-2', 'gpt-image-1',
  'gpt-image-1.5', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']);

// The adapter name is not a credential destination. Bind credentials only to
// the fixed registered origin, never to arbitrary custom studio destinations.
export function studioServiceTarget(studio) {
  const c = studio?.config || {};
  if (!['studio', 'gemini', 'miao-video'].includes(c.protocol)) return null;
  if (c.protocol === 'gemini' && studio?.mode !== 'image') return null;
  return {protocol: 'openai-compatible', baseUrl: c.baseUrl};
}

export function isLocalStudioServiceTarget(studio) {
  const purpose = studio?.mode;
  return ['image', 'video'].includes(purpose) &&
    isLocalMiaoTarget(studioServiceTarget(studio), {purpose});
}

export function studioModelContract(choice) {
  if (!choice) return {supported: false, note: '请先选择已登记的模型'};
  if (choice.category === 'image' && choice.platformProtocol === 'gemini') {
    return /-image(?:[-.]|$)/i.test(choice.id) ?
      {supported: true, protocol: 'gemini', note: 'Gemini 原生图片接口'} :
      {supported: false, note: '图片输出接口待核实'};
  }
  if (choice.category === 'image' && choice.platformProtocol === 'openai-compatible' &&
      /^(?:gpt-image-|dall-e-)/i.test(choice.id) &&
      (!isLocalMiaoTarget({protocol: choice.platformProtocol, baseUrl: choice.baseUrl}, {purpose: 'image'}) ||
        registeredImageContracts.has(choice.id))) {
    return {supported: true, protocol: 'studio', note: '兼容图片接口'};
  }
  return {supported: false, note: '已发现型号，生成接口待核实'};
}

export function applyStudioModelChoice(config, choice) {
  const contract = studioModelContract(choice);
  if (!contract.supported) throw Error(contract.note);
  const next = {...config, model: choice.id, platformId: choice.platformId,
    baseUrl: choice.baseUrl, protocol: contract.protocol};
  delete next.nativeModelscope;
  if (contract.protocol === 'studio' && choice.category === 'image') {
    next.imageAsync = false;
    if (![1, 2, 4].includes(Number(next.count))) next.count = 1;
  }
  if (contract.protocol === 'gemini') Object.assign(next,
    {imageAsync: false, count: 1, quality: 'auto', transparent: false});
  return next;
}
