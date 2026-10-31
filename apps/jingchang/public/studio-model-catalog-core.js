import {modelDisplayName} from './model-service-labels.js';

const categories = new Set(['image', 'chat', 'video']);
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/;
const validId = value => typeof value === 'string' && value.length > 0 &&
  value.length <= 200 && value.trim().length > 0 && !controlCharacters.test(value);
const modelId = model => typeof model === 'string' ? model :
  model && typeof model === 'object' ? model.id ?? model.name : null;

function categoryEvidence(model) {
  if (model && typeof model === 'object' && categories.has(model.category)) {
    return {category: model.category, categorySource: 'provider'};
  }
  const id = modelId(model);
  if (!validId(id)) return null;
  const familyId = id.replace(/^models\//, '');
  if (/^gemini-/i.test(familyId) && Array.isArray(model?.supportedGenerationMethods) &&
      model.supportedGenerationMethods.includes('generateContent')) {
    return {category: /-image(?:[-.]|$)/i.test(familyId) ? 'image' : 'chat',
      categorySource: 'generation-methods'};
  }
  // Names are catalog hints only. They do not establish a transport contract,
  // provider authorization, supported parameters or a successful generation.
  if (/^minimax-h3(?:-max)?$/i.test(id) ||
      /(?:^|[\/_.:-])(?:seedance|veo|sora|kling|hailuo|wan)(?=$|[-_.:/]|\d)/i.test(id)) {
    return {category: 'video', categorySource: 'name-inference'};
  }
  if (/(?:^|[\/_.:-])(?:gpt[-_]image|dall[-_]e|qwen[-_]image)(?=$|[-_.:/]|\d)/i.test(id) ||
      /^gemini-\d+(?:\.\d+)?-(?:flash|pro)(?:[-\w.]+)?-image(?:[-.]|$)/i.test(familyId) ||
      /(?:^|[\/_.:-])(?:seedream|flux|imagen)(?=$|[-_.:/]|\d)/i.test(id)) {
    return {category: 'image', categorySource: 'name-inference'};
  }
  return null;
}

export function inferStudioModelCategory(model) {
  return categoryEvidence(model)?.category ?? null;
}

function choiceFor(platform, model, source) {
  const id = modelId(model);
  if (!validId(id)) return null;
  // Saved classifications are explicit user metadata. Do not reinterpret an
  // unclassified saved entry based only on a suggestive display name.
  const evidence = source === 'saved' ?
    categories.has(model?.category) ? {category: model.category, categorySource: 'saved'} : null :
    categoryEvidence(model);
  if (!evidence) return null;
  const label = typeof model?.label === 'string' && !controlCharacters.test(model.label) ? model.label : undefined;
  const display = modelDisplayName({id, ...(label !== undefined ? {label} : {})});
  // Copy an allowlist, never arbitrary owner, credential or provider metadata.
  return {id, label: display, display, baseUrl: platform.baseUrl,
    platformId: platform.id, platformProtocol: platform.protocol,
    source, ...evidence};
}

export function studioModelChoiceKey(choice) {
  if (!validId(choice?.platformId) || !validId(choice?.id)) return '';
  return encodeURIComponent(JSON.stringify([choice.platformId, choice.id]))
    .replace(/[!'()*]/g, value => '%' + value.charCodeAt(0).toString(16).toUpperCase());
}

export function findStudioModelChoice(choices, key) {
  if (!Array.isArray(choices) || typeof key !== 'string' || !key) return null;
  return choices.find(choice => studioModelChoiceKey(choice) === key) ?? null;
}

export function studioModelChoices(platforms, mode, {discoveredByPlatform = {}} = {}) {
  if (!Array.isArray(platforms) || !categories.has(mode)) return [];
  const validPlatforms = platforms.filter(platform => validId(platform?.id) &&
    typeof platform.baseUrl === 'string' && platform.baseUrl.length > 0 &&
    !controlCharacters.test(platform.baseUrl) &&
    typeof platform.protocol === 'string' && platform.protocol.length > 0 &&
    !controlCharacters.test(platform.protocol));
  const choices = new Map();
  function add(platform, entries, source) {
    if (!Array.isArray(entries)) return;
    for (const model of entries) {
      const choice = choiceFor(platform, model, source);
      if (!choice) continue;
      const key = studioModelChoiceKey(choice);
      if (!choices.has(key)) choices.set(key, choice);
    }
  }
  // Deduplicate before filtering by mode. A saved image classification must
  // also win over a conflicting discovered video classification for that ID.
  for (const platform of validPlatforms) add(platform, platform.models, 'saved');
  for (const platform of validPlatforms) {
    const entries = discoveredByPlatform &&
      Object.prototype.hasOwnProperty.call(discoveredByPlatform, platform.id) ?
      discoveredByPlatform[platform.id] : [];
    add(platform, entries, 'discovered');
  }
  return [...choices.values()].filter(choice => choice.category === mode);
}
