import {IMAGE_REFERENCE_LIMIT} from '../public/reference-limits.js';
import {cameraNodeText} from '../public/camera-angle-core.js';
const CONTEXT_NODE_TYPES = new Set(['text', 'script', 'character', 'scene']);
const IMAGE_NODE_TYPES = new Set(['image', 'character', 'scene']);
const IMAGE_ASSET_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_IMAGE_REFERENCES = IMAGE_REFERENCE_LIMIT;
const MAX_IMAGE_REFERENCE_BYTES = 10 * 1024 * 1024;
const MAX_PROMPT_LENGTH = 32_000;

const labels = {
  text: '文本',
  script: '剧本',
  character: '角色',
  scene: '场景',
};

function fail(message) {
  throw new Error(message);
}

function requireProject(project) {
  if (!project || typeof project !== 'object') fail('项目数据无效');
  if (!Array.isArray(project.nodes)) fail('项目 nodes 必须是数组');
  if (!Array.isArray(project.edges)) fail('项目 edges 必须是数组');
  if (!Array.isArray(project.assets)) fail('项目 assets 必须是数组');
}

function graphFor(project, nodeId) {
  requireProject(project);
  if (typeof nodeId !== 'string' || !nodeId) fail('目标节点不存在');

  const nodeById = new Map();
  const order = new Map();
  for (const [index, node] of project.nodes.entries()) {
    if (!node || typeof node.id !== 'string' || !node.id) fail('节点数据无效');
    if (nodeById.has(node.id)) fail('节点 ID 重复');
    nodeById.set(node.id, node);
    order.set(node.id, index);
  }
  if (!nodeById.has(nodeId)) fail('目标节点不存在');

  const outgoing = new Map(project.nodes.map(node => [node.id, []]));
  const incoming = new Map(project.nodes.map(node => [node.id, []]));
  const edgeKeys = new Set();
  for (const edge of project.edges) {
    if (!edge || typeof edge.source !== 'string' || typeof edge.target !== 'string') {
      fail('连接数据无效');
    }
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) {
      fail('连接指向不存在的节点');
    }
    const key = `${edge.source}\u0000${edge.target}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    outgoing.get(edge.source).push(edge.target);
    incoming.get(edge.target).push(edge.source);
  }

  // Kahn's algorithm with the original node order as a stable tie breaker.
  const indegree = new Map(project.nodes.map(node => [node.id, incoming.get(node.id).length]));
  const ready = project.nodes.filter(node => indegree.get(node.id) === 0).map(node => node.id);
  const topological = [];
  while (ready.length) {
    ready.sort((a, b) => order.get(a) - order.get(b));
    const current = ready.shift();
    topological.push(current);
    for (const target of outgoing.get(current)) {
      const next = indegree.get(target) - 1;
      indegree.set(target, next);
      if (next === 0) ready.push(target);
    }
  }
  if (topological.length !== project.nodes.length) fail('工作流不能形成循环依赖');

  const ancestorIds = new Set();
  const pending = [nodeId];
  while (pending.length) {
    const current = pending.pop();
    for (const source of incoming.get(current)) {
      if (ancestorIds.has(source)) continue;
      ancestorIds.add(source);
      pending.push(source);
    }
  }
  return {
    nodeById,
    ancestors: topological.filter(id => ancestorIds.has(id)),
  };
}

function assetsById(project) {
  const result = new Map();
  for (const asset of project.assets) {
    if (!asset || typeof asset.id !== 'string' || !asset.id) fail('素材数据无效');
    if (result.has(asset.id)) fail('素材 ID 重复');
    result.set(asset.id, asset);
  }
  return result;
}

function validateExplicitAsset(assetId, asset) {
  if (!asset) fail(`参考图片素材不存在：${assetId}`);
  if (!IMAGE_ASSET_TYPES.has(asset.type)) {
    fail(`参考素材必须是 PNG、JPEG 或 WebP 图片：${assetId}`);
  }
  if (!Number.isFinite(asset.size)) fail(`参考图片大小不可确认：${assetId}`);
  if (asset.size < 0 || asset.size > MAX_IMAGE_REFERENCE_BYTES) {
    fail(`参考图片不得超过 10 MB：${assetId}`);
  }
}

function isUsableAutomaticAsset(asset) {
  return Boolean(
    asset &&
    IMAGE_ASSET_TYPES.has(asset.type) &&
    Number.isFinite(asset.size) &&
    asset.size >= 0 &&
    asset.size <= MAX_IMAGE_REFERENCE_BYTES,
  );
}

function automaticAsset(node, assetMap) {
  if (!IMAGE_NODE_TYPES.has(node.type) || !node.assetId) return null;
  if (typeof node.assetId !== 'string') fail(`节点素材引用无效：${node.id}`);
  const asset = assetMap.get(node.assetId);
  if (!asset) fail(`节点引用的素材不存在：${node.assetId}`);
  // Video/audio assets are deliberately ignored here; they are never recast
  // as image references. Explicit referenceIds still receive strict errors.
  return isUsableAutomaticAsset(asset) ? asset : null;
}

function referenceIdsFor(project, nodeIds, explicitIds, autoReferences) {
  const assetMap = assetsById(project);
  if (!Array.isArray(explicitIds)) fail('referenceIds 必须是数组');

  const explicit = [];
  const explicitSeen = new Set();
  for (const assetId of explicitIds) {
    if (typeof assetId !== 'string' || !assetId) fail('参考图片编号无效');
    if (explicitSeen.has(assetId)) continue;
    explicitSeen.add(assetId);
    const asset = assetMap.get(assetId);
    validateExplicitAsset(assetId, asset);
    explicit.push(assetId);
  }

  const result = [];
  const seen = new Set();
  if (autoReferences) {
    for (const nodeId of nodeIds) {
      const asset = automaticAsset(project.nodes.find(node => node.id === nodeId), assetMap);
      if (!asset || seen.has(asset.id)) continue;
      seen.add(asset.id);
      result.push(asset.id);
    }
  }
  for (const assetId of explicit) {
    if (seen.has(assetId)) continue;
    seen.add(assetId);
    result.push(assetId);
  }
  if (result.length > MAX_IMAGE_REFERENCES) {
    fail('参考图片最多 20 张，请由界面取舍后重试');
  }
  return result;
}

function contextLine(node, text, target = false) {
  if (target) return `当前节点：${text}`;
  const title = typeof node.title === 'string' && node.title.trim()
    ? node.title.trim()
    : (labels[node.type] || '上游节点');
  return `${title}：${text}`;
}

function makePrompt(nodeById, ancestorIds, targetId, allowEmptyPrompt) {
  const chunks = [];
  for (const id of ancestorIds) {
    const node = nodeById.get(id);
    if (!CONTEXT_NODE_TYPES.has(node.type) || typeof node.text !== 'string') continue;
    const text = node.text.trim();
    if (text) chunks.push(contextLine(node, text));
  }
  const target = nodeById.get(targetId);
  if (cameraNodeText(target)) {
    chunks.push(contextLine(target, cameraNodeText(target), true));
  }
  const prompt = chunks.join('\n\n').trim();
  if (!prompt && !allowEmptyPrompt) fail('图像提示词不能为空');
  if (prompt.length > MAX_PROMPT_LENGTH) fail('图像提示词不得超过 32000 个字符');
  return prompt;
}

function graphAndAncestors(project, nodeId, includeUpstream) {
  if (typeof includeUpstream !== 'boolean') fail('includeUpstream 必须是布尔值');
  const graph = graphFor(project, nodeId);
  return { ...graph, ancestorIds: includeUpstream ? graph.ancestors : [] };
}

/**
 * Resolve the text and image inputs that an image node should receive.
 * Upstream text is ordered topologically; ties retain project node order.
 * `autoReferences: false` keeps that text context but requires the UI to
 * choose every reference through `referenceIds`.
 */
export function resolveImageContext(
  project,
  nodeId,
  {
    includeUpstream = true,
    referenceIds = [],
    autoReferences = true,
    allowEmptyPrompt = false,
  } = {},
) {
  if (typeof autoReferences !== 'boolean') fail('autoReferences 必须是布尔值');
  if (typeof allowEmptyPrompt !== 'boolean') fail('allowEmptyPrompt 必须是布尔值');
  const { nodeById, ancestorIds } = graphAndAncestors(project, nodeId, includeUpstream);
  return {
    prompt: makePrompt(nodeById, ancestorIds, nodeId, allowEmptyPrompt),
    referenceIds: referenceIdsFor(project, ancestorIds, referenceIds, autoReferences),
    upstreamNodeIds: ancestorIds,
  };
}

/**
 * Return the unique, valid image assets attached to upstream image, character,
 * or scene nodes. The UI can show these candidates and pass a selected subset
 * as `referenceIds` with `autoReferences: false`.
 */
export function listUpstreamImageReferences(project, nodeId, { includeUpstream = true } = {}) {
  const { nodeById, ancestorIds } = graphAndAncestors(project, nodeId, includeUpstream);
  const assetMap = assetsById(project);
  const result = [];
  const seen = new Set();
  for (const id of ancestorIds) {
    const asset = automaticAsset(nodeById.get(id), assetMap);
    if (!asset || seen.has(asset.id)) continue;
    seen.add(asset.id);
    result.push({ id: asset.id, name: String(asset.name || asset.id), type: asset.type });
  }
  return result;
}

export const inputContextLimits = Object.freeze({
  maxImageReferences: MAX_IMAGE_REFERENCES,
  maxImageReferenceBytes: MAX_IMAGE_REFERENCE_BYTES,
  maxPromptLength: MAX_PROMPT_LENGTH,
});
