// Node loads the shared helper directly. Browsers receive it from app.js at
// the public root so older running servers need no new /public allowlist.
const nodeNativeCopyRemapper=typeof window==='undefined'?(await import('../public/native-copy-core.js')).remapNativeCopies:null;
import {
  isArkMultimodal,
  IMAGE_REFERENCE_LIMIT,
  CANVAS_LLM_IMAGE_LIMIT,
  CANVAS_LLM_AUDIO_LIMIT,
  CHAT_VIDEO_LIMIT,
  CANVAS_LLM_REFERENCE_LIMIT,
  studioImageReferenceLimit
} from '../public/reference-limits.js';
import {syncNativeConnections} from '../public/native-canvas-core.js';
import {minimaxReferences,minimaxTimelineOf} from '../public/minimax-h3-core.js';

const DEFAULT_COPY_OFFSET = 40;
const ALIGNMENTS = new Set(['left', 'top', 'right', 'bottom', 'hcenter', 'vcenter']);
const SAFE_ID = /^[a-zA-Z0-9_-]{1,100}$/;
const MEDIA_TYPES = new Set(['image', 'video', 'audio']);

function clone(value) {
  return structuredClone(value);
}

function newId() {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('当前运行环境缺少 crypto.randomUUID');
  }
  return globalThis.crypto.randomUUID();
}

function assertProject(project) {
  if (!project || typeof project !== 'object' || !Array.isArray(project.nodes)) {
    throw new TypeError('项目必须包含 nodes 数组');
  }
  if (project.edges !== undefined && !Array.isArray(project.edges)) {
    throw new TypeError('项目 edges 必须是数组');
  }
  validateGroups(project);
}

function normalizeNodeIds(project, nodeIds) {
  if (!Array.isArray(nodeIds)) throw new TypeError('nodeIds 必须是数组');
  const known = new Set(project.nodes.map((node) => node.id));
  const seen = new Set();
  const result = [];
  for (const id of nodeIds) {
    if (typeof id !== 'string' || !id) throw new TypeError('节点 ID 无效');
    if (!known.has(id)) throw new Error(`节点不存在：${id}`);
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

function finiteNumber(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} 必须是有限数字`);
  return value;
}

function copyOffset(options = {}) {
  if (!options || typeof options !== 'object') throw new TypeError('复制选项必须是对象');
  const nested = options.offset && typeof options.offset === 'object' ? options.offset : {};
  const x = options.offsetX ?? options.dx ?? nested.x ?? DEFAULT_COPY_OFFSET;
  const y = options.offsetY ?? options.dy ?? nested.y ?? DEFAULT_COPY_OFFSET;
  return { x: finiteNumber(x, 'offsetX'), y: finiteNumber(y, 'offsetY') };
}

function deltaValues(dxOrOptions, maybeDy) {
  if (dxOrOptions && typeof dxOrOptions === 'object') {
    return {
      x: finiteNumber(dxOrOptions.dx ?? dxOrOptions.x ?? 0, 'dx'),
      y: finiteNumber(dxOrOptions.dy ?? dxOrOptions.y ?? 0, 'dy')
    };
  }
  return {
    x: finiteNumber(dxOrOptions ?? 0, 'dx'),
    y: finiteNumber(maybeDy ?? 0, 'dy')
  };
}

function groupArgs(nodeIdsOrOptions, maybeTitle) {
  if (nodeIdsOrOptions && !Array.isArray(nodeIdsOrOptions) && typeof nodeIdsOrOptions === 'object') {
    return {
      nodeIds: nodeIdsOrOptions.nodeIds,
      title: nodeIdsOrOptions.title
    };
  }
  return { nodeIds: nodeIdsOrOptions, title: maybeTitle };
}

function groupTitle(title) {
  if (title === undefined) return '未命名分组';
  if (typeof title !== 'string') throw new TypeError('分组标题必须是字符串');
  const value = title.trim();
  if (!value) throw new Error('分组标题不能为空');
  return value;
}

/**
 * Validate the optional project.groups collection.
 *
 * The validator is deliberately independent from model.mjs so it can be used
 * by both the browser and the Node server before either side saves a project.
 * It returns true for a valid project and throws for malformed or dangling
 * group references.
 */
export function validateGroups(project) {
  if (!project || typeof project !== 'object' || !Array.isArray(project.nodes)) {
    throw new TypeError('项目必须包含 nodes 数组');
  }
  if (project.groups === undefined) return true;
  if (!Array.isArray(project.groups)) throw new TypeError('project.groups 必须是数组');
  if (project.groups.length > 1500) throw new Error('项目超过当前分组容量');

  const nodeIds = new Set(project.nodes.map((node) => node.id));
  const groupIds = new Set();
  const memberships = new Map();

  for (const group of project.groups) {
    if (!group || typeof group !== 'object' || typeof group.id !== 'string' || !SAFE_ID.test(group.id)) {
      throw new Error('分组 ID 无效');
    }
    if (groupIds.has(group.id)) throw new Error(`分组 ID 重复：${group.id}`);
    groupIds.add(group.id);
    if (typeof group.title !== 'string' || !group.title.trim() || group.title.length > 120) {
      throw new Error(`分组标题无效：${group.id}`);
    }
    if (group.color !== undefined && (typeof group.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(group.color))) {
      throw new Error(`分组颜色无效：${group.id}`);
    }
    if (group.collapsed !== undefined && typeof group.collapsed !== 'boolean') {
      throw new Error(`分组折叠状态无效：${group.id}`);
    }
    if (!Array.isArray(group.nodeIds) || group.nodeIds.length === 0) {
      throw new Error(`分组 nodeIds 无效：${group.id}`);
    }

    const members = new Set();
    for (const nodeId of group.nodeIds) {
      if (typeof nodeId !== 'string' || !nodeIds.has(nodeId)) {
        throw new Error(`分组引用了不存在的节点：${nodeId}`);
      }
      if (members.has(nodeId)) throw new Error(`分组内节点重复：${nodeId}`);
      members.add(nodeId);
      const previous = memberships.get(nodeId);
      if (previous) {
        throw new Error(`节点不能同时属于多个分组：${nodeId}（${previous}、${group.id}）`);
      }
      memberships.set(nodeId, group.id);
    }
  }
  return true;
}

/**
 * Copy selected nodes and, by default, only internal edges. Callers may also
 * preserve incoming edges when duplicating a node/group with Alt+Shift.
 * The input project is never mutated. Asset IDs and all other node fields are
 * preserved; copied nodes receive fresh IDs and the requested position offset.
 */
export function copySelectedNodes(project, nodeIds, options = {}) {
  assertProject(project);
  const selected = normalizeNodeIds(project, nodeIds);
  const { x: offsetX, y: offsetY } = copyOffset(options);
  const copyGroups = options.copyGroups === true;
  const copyConnections = options.copyConnections !== false;
  const copyIncomingConnections = options.copyIncomingConnections === true;
  const next = clone(project);
  const byId = new Map(project.nodes.map((node) => [node.id, node]));
  const idMap = new Map();

  const copied = selected.map((oldId) => {
    const node = clone(byId.get(oldId));
    node.id = newId();
    node.x = finiteNumber(node.x, '节点 x') + offsetX;
    node.y = finiteNumber(node.y, '节点 y') + offsetY;
    idMap.set(oldId, node.id);
    return node;
  });
  // Internal dynamic references must follow copied upstream nodes, not originals.
  for (const node of copied) {
    for(const s of minimaxTimelineOf(node)?.segments||[])for(const r of s.resultVariants||[])if(idMap.has(r.loopId))r.loopId=idMap.get(r.loopId);
    for (const field of node.params?.loop?.fieldValues || []) {
      if (idMap.has(field.targetNodeId)) field.targetNodeId = idMap.get(field.targetNodeId);
    }
    for (const field of [...(node.params?.workflowBinding?.imageSources || []), ...(node.params?.workflowBinding?.ltxDirector?.segments || []), ...(node.params?.workflowBinding?.ltxDirector?.audioSegments || []), ...minimaxReferences(minimaxTimelineOf(node)), ...(node.params?.cloudBinding?.inputs || []), ...(node.params?.imageBinding?.referenceSources || []), ...(node.params?.llmBinding?.referenceSources || []), ...(node.params?.studioBinding?.referenceSources || []), ...(node.params?.nativeCanvas?.members || []), ...(node.params?.nativeCanvas?.inputOrder || [])]) {
      if (idMap.has(field.sourceNodeId)) field.sourceNodeId = idMap.get(field.sourceNodeId);
    }
  }
  next.nodes.push(...copied);

  const edges = Array.isArray(project.edges) ? project.edges : [];
  const selectedSet = new Set(selected);
  const copiedEdges = copyConnections
    ? edges
        .filter((edge) => selectedSet.has(edge.target)
          && (copyIncomingConnections || selectedSet.has(edge.source)))
        .map((edge) => ({
          ...clone(edge),
          id: newId(),
          source: idMap.get(edge.source) || edge.source,
          target: idMap.get(edge.target)
        }))
    : [];
  next.edges = [...edges, ...copiedEdges];
  if (copyGroups) {
    const selectedSet = new Set(selected);
    const copiedGroups = (project.groups || [])
      .filter((group) => group.nodeIds.every((nodeId) => selectedSet.has(nodeId)))
      .map((group) => ({
        ...clone(group),
        id: newId(),
        title: `${group.title}（副本）`.slice(0, 120),
        nodeIds: group.nodeIds.map((nodeId) => idMap.get(nodeId)),
        collapsed: false
      }));
    if (copiedGroups.length) next.groups = [...(next.groups || []), ...copiedGroups];
  }
  syncNativeConnections(next);
  if(options.nativeIdentity===true){const remap=options.nativeRemap||nodeNativeCopyRemapper;if(typeof remap!=='function')throw Error('复制工具尚未加载，请刷新后重试');remap(project,next,idMap,{offsetX,offsetY,copyConnections,copyIncomingConnections});}
  validateGroups(next);
  return next;
}

function detachNativeInputs(node,removed){
  const native=node?.params?.nativeCanvas;
  if(!native)return;
  const dropped=native.inputOrder.filter(ref=>removed.has(ref.sourceNodeId)).map(ref=>ref.index);
  if(Array.isArray(native.node.inputs))for(const index of [...new Set(dropped)].sort((a,b)=>b-a))native.node.inputs.splice(index,1);
  native.inputOrder=native.inputOrder.filter(ref=>!removed.has(ref.sourceNodeId)).map(ref=>({...ref,index:ref.index-dropped.filter(index=>index<ref.index).length}));
}

/** Remove selected canvas nodes without leaving references to absent nodes. */
export function removeSelectedNodes(project,nodeIds){
  assertProject(project);
  const removed=new Set(normalizeNodeIds(project,nodeIds)),next=clone(project);
  next.nodes=next.nodes.filter(n=>!removed.has(n.id));
  next.edges=(next.edges||[]).filter(e=>!removed.has(e.source)&&!removed.has(e.target));
  next.groups=(next.groups||[]).map(g=>({...g,nodeIds:g.nodeIds.filter(id=>!removed.has(id))})).filter(g=>g.nodeIds.length);
  for(const n of next.nodes){
    detachNativeInputs(n,removed);
    if(n.params?.nativeCanvas)n.params.nativeCanvas.members=n.params.nativeCanvas.members.filter(ref=>!removed.has(ref.sourceNodeId));
    for(const binding of [n.params?.imageBinding,n.params?.llmBinding,n.params?.studioBinding])if(Array.isArray(binding?.referenceSources))binding.referenceSources=binding.referenceSources.filter(ref=>!removed.has(ref.sourceNodeId));
    if(n.params?.workflowBinding){const b=n.params.workflowBinding;if(Array.isArray(b.imageSources))b.imageSources=b.imageSources.filter(ref=>!removed.has(ref.sourceNodeId));for(const name of ['segments','audioSegments'])if(Array.isArray(b.ltxDirector?.[name]))b.ltxDirector[name]=b.ltxDirector[name].filter(ref=>!removed.has(ref.sourceNodeId));}
    if(Array.isArray(n.params?.cloudBinding?.inputs))n.params.cloudBinding.inputs=n.params.cloudBinding.inputs.filter(ref=>!removed.has(ref.sourceNodeId));
    if(Array.isArray(n.params?.loop?.fieldValues))n.params.loop.fieldValues=n.params.loop.fieldValues.filter(ref=>!removed.has(ref.targetNodeId));
  }
  syncNativeConnections(next);validateGroups(next);return next;
}

/**
 * Create an exclusive group. Existing memberships are left untouched; trying
 * to group a node that already belongs to another group is rejected so the
 * caller can explicitly ungroup it first.
 *
 * Accepted forms:
 *   createGroup(project, ['node-a'], '第一组')
 *   createGroup(project, {nodeIds: ['node-a'], title: '第一组'})
 */
export function createGroup(project, nodeIdsOrOptions, maybeTitle) {
  assertProject(project);
  const { nodeIds, title } = groupArgs(nodeIdsOrOptions, maybeTitle);
  const selected = normalizeNodeIds(project, nodeIds || []);
  if (selected.length === 0) throw new Error('至少选择一个节点才能创建分组');
  const memberships = new Map();
  for (const group of project.groups || []) {
    for (const nodeId of group.nodeIds) memberships.set(nodeId, group.id);
  }
  const conflict = selected.find((nodeId) => memberships.has(nodeId));
  if (conflict) throw new Error(`节点已属于分组：${conflict}（${memberships.get(conflict)}）`);

  const next = clone(project);
  next.groups = [...(next.groups || []), { id: newId(), title: groupTitle(title), nodeIds: selected, color: '#78905b', collapsed: false }];
  validateGroups(next);
  return next;
}

/** Remove one group while retaining all of its nodes. */
export function ungroup(project, groupId) {
  assertProject(project);
  if (typeof groupId !== 'string' || !groupId) throw new TypeError('groupId 无效');
  if (!(project.groups || []).some((group) => group.id === groupId)) {
    throw new Error(`分组不存在：${groupId}`);
  }
  const next = clone(project);
  next.groups = next.groups.filter((group) => group.id !== groupId);
  validateGroups(next);
  return next;
}

/** Set whether a group is shown as a compact header on the canvas. */
export function setGroupCollapsed(project, groupId, collapsed) {
  assertProject(project);
  if (typeof collapsed !== 'boolean') throw new TypeError('collapsed 必须是布尔值');
  const group = (project.groups || []).find((item) => item.id === groupId);
  if (!group) throw new Error(`分组不存在：${groupId}`);
  const next = clone(project);
  next.groups.find((item) => item.id === groupId).collapsed = collapsed;
  validateGroups(next);
  return next;
}

/** Set a group border/accent color using a strict six-digit RGB value. */
export function setGroupColor(project, groupId, color) {
  assertProject(project);
  if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error('分组颜色必须是六位十六进制颜色');
  const group = (project.groups || []).find((item) => item.id === groupId);
  if (!group) throw new Error(`分组不存在：${groupId}`);
  const next = clone(project);
  next.groups.find((item) => item.id === groupId).color = color.toLowerCase();
  validateGroups(next);
  return next;
}

/** Move every selected node by the same delta. */
export function moveNodes(project, nodeIds, dxOrOptions = 0, maybeDy = 0) {
  assertProject(project);
  const selected = new Set(normalizeNodeIds(project, nodeIds));
  const { x: dx, y: dy } = deltaValues(dxOrOptions, maybeDy);
  const next = clone(project);
  for (const node of next.nodes) {
    if (!selected.has(node.id)) continue;
    node.x = finiteNumber(node.x, '节点 x') + dx;
    node.y = finiteNumber(node.y, '节点 y') + dy;
  }
  validateGroups(next);
  return next;
}

function dimension(node, key) {
  const direct = node[key];
  if (Number.isFinite(direct) && direct >= 0) return direct;
  const short = key === 'width' ? node.w : node.h;
  if (Number.isFinite(short) && short >= 0) return short;
  const nested = node.size?.[key];
  return Number.isFinite(nested) && nested >= 0 ? nested : 0;
}

/** Align selected nodes by their bounding box, using x/y as the top-left. */
export function alignNodes(project, nodeIds, alignment) {
  assertProject(project);
  if (!ALIGNMENTS.has(alignment)) throw new Error(`不支持的对齐方式：${alignment}`);
  const selected = normalizeNodeIds(project, nodeIds);
  const next = clone(project);
  if (selected.length < 2) return next;
  const nodes = next.nodes.filter((node) => selected.includes(node.id));
  const left = Math.min(...nodes.map((node) => finiteNumber(node.x, '节点 x')));
  const top = Math.min(...nodes.map((node) => finiteNumber(node.y, '节点 y')));
  const right = Math.max(...nodes.map((node) => finiteNumber(node.x, '节点 x') + dimension(node, 'width')));
  const bottom = Math.max(...nodes.map((node) => finiteNumber(node.y, '节点 y') + dimension(node, 'height')));
  const hcenter = (left + right) / 2;
  const vcenter = (top + bottom) / 2;

  for (const node of nodes) {
    const width = dimension(node, 'width');
    const height = dimension(node, 'height');
    if (alignment === 'left') node.x = left;
    else if (alignment === 'right') node.x = right - width;
    else if (alignment === 'top') node.y = top;
    else if (alignment === 'bottom') node.y = bottom - height;
    else if (alignment === 'hcenter') node.x = hcenter - width / 2;
    else if (alignment === 'vcenter') node.y = vcenter - height / 2;
  }
  validateGroups(next);
  return next;
}

export const alignments = Object.freeze([...ALIGNMENTS]);

/** Return a user-readable error before inserting an edge; no mutation. */
function referenceKind(project, reference) {
  if (reference?.sourceNodeId) return project.nodes.find((node) => node.id === reference.sourceNodeId)?.type || null;
  if (reference?.assetId) return project.assets?.find((asset) => asset.id === reference.assetId)?.type?.split('/')[0] || null;
  if (reference?.url) return 'image';
  return null;
}

function referencesOf(binding) {
  return Array.isArray(binding?.referenceSources) ? binding.referenceSources : [];
}

function connectionReferenceMapping(project, source, target) {
  if (!MEDIA_TYPES.has(source.type)) return null;
  const params = target.params || {};

  if (params.imageBinding) {
    const binding = params.imageBinding;
    const model = binding.platform?.models?.find((item) => item.id === binding.model);
    if (source.type !== 'image') return { error: '图片接口参考只能接收图片节点' };
    if (model?.referenceSupport !== true) return { error: '当前图片模型未开启参考图输入，不能把媒体节点连作参考' };
    const references = referencesOf(binding);
    if (references.some((reference) => reference.sourceNodeId === source.id)) return null;
    if (references.length >= IMAGE_REFERENCE_LIMIT) return { error: `图片接口最多接收 ${IMAGE_REFERENCE_LIMIT} 张参考图` };
    return { bindingKey: 'imageBinding', reference: { sourceNodeId: source.id } };
  }

  if (params.llmBinding) {
    const binding = params.llmBinding;
    const model = binding.platform?.models?.find((item) => item.id === binding.model);
    if (source.type === 'audio') {
      if (binding.platform?.protocol !== 'gemini' || model?.audioSupport !== true) return { error: '音频连线要求 Gemini 原生对话模型，并明确开启音频理解' };
    } else if (source.type === 'video' && binding.videoInputMode === 'native') {
      if (binding.platform?.protocol !== 'gemini' || model?.videoSupport !== true) return { error: '原视频连线要求 Gemini 原生对话模型，并明确开启原视频理解' };
    } else if (model?.referenceSupport !== true) return { error: '当前对话模型未开启多模态输入，不能把媒体节点连作参考' };
    const references = referencesOf(binding);
    if (references.some((reference) => reference.sourceNodeId === source.id)) return null;
    const counts = references.reduce((result, reference) => {
      const kind = referenceKind(project, reference);
      if (kind === 'image') result.image++;
      if (kind === 'video') result.video++;
      if (kind === 'audio') result.audio++;
      return result;
    }, { image: 0, video: 0, audio: 0 });
    if (references.length >= CANVAS_LLM_REFERENCE_LIMIT) return { error: `语言模型最多接收 ${CANVAS_LLM_REFERENCE_LIMIT} 项媒体参考` };
    if (source.type === 'image' && counts.image >= CANVAS_LLM_IMAGE_LIMIT) return { error: `语言模型最多接收 ${CANVAS_LLM_IMAGE_LIMIT} 张图片参考` };
    if (source.type === 'video' && counts.video >= CHAT_VIDEO_LIMIT) return { error: `语言模型最多接收 ${CHAT_VIDEO_LIMIT} 段视频参考` };
    if (source.type === 'audio' && counts.audio >= CANVAS_LLM_AUDIO_LIMIT) return { error: `语言模型最多接收 ${CANVAS_LLM_AUDIO_LIMIT} 份音频参考` };
    return { bindingKey: 'llmBinding', reference: { sourceNodeId: source.id } };
  }

  if (params.studioBinding) {
    const binding = params.studioBinding;
    const config = binding.config || {};
    if (binding.mode !== target.type) return { error: '创作接口模式与目标节点类型不一致，请先修复绑定' };
    let acceptedTypes, max;
    if (binding.mode === 'image') {
      acceptedTypes = ['image'];
      max = config.protocol === 'modelscope' ? 3 : studioImageReferenceLimit(binding);
    } else if (config.protocol === 'ark') {
      if ((config.operation || 'generate') !== 'generate') return { error: '方舟画布绑定当前只支持文生视频或图片首尾帧' };
      acceptedTypes = isArkMultimodal(binding) ? ['image','audio'] : ['image'];
      max = isArkMultimodal(binding) ? source.type==='audio'?3:9 : 2;
      if (isArkMultimodal(binding) && referencesOf(binding).length>=15) return {error:'方舟多素材参考合计最多15项'};
    } else if (config.protocol === 'apimart') {
      return { error: 'APIMart 视频首尾帧需要公网图片网址，不能自动映射本地画布节点' };
    } else if ((config.operation || 'generate') === 'generate') {
      acceptedTypes = ['image'];
      max = 1;
    } else {
      acceptedTypes = ['video'];
      max = 1;
    }
    if (!acceptedTypes.includes(source.type)) {
      return { error: `${binding.mode === 'image' ? '图片' : '当前视频操作'}参考仅接受${acceptedTypes.map((type) => ({ image: '图片', video: '视频', audio:'音频' }[type])).join('或')}节点` };
    }
    const references = referencesOf(binding);
    if (references.some((reference) => reference.sourceNodeId === source.id)) return null;
    const count = references.filter((reference) => isArkMultimodal(binding)?(reference.url?reference.type?.split('/')[0]||'image':referenceKind(project,reference))===source.type:acceptedTypes.includes(referenceKind(project, reference))).length;
    if (count >= max) return { error: `${binding.mode === 'image' ? '图片' : '当前视频操作'}最多接收 ${max} 项参考` };
    return { bindingKey: 'studioBinding', reference: { sourceNodeId: source.id } };
  }

  // ComfyUI and RunningHub expose custom media fields. Their precise type and
  // destination are configured in the node's field mapper, so do not guess.
  return null;
}

/** Return the direct media binding update implied by a new typed connection. */
export function connectionMediaMapping(project, sourceId, targetId) {
  const source = project.nodes.find((node) => node.id === sourceId);
  const target = project.nodes.find((node) => node.id === targetId);
  if (!source || !target) return null;
  const mapping = connectionReferenceMapping(project, source, target);
  return mapping?.bindingKey ? { targetId, bindingKey: mapping.bindingKey, reference: structuredClone(mapping.reference) } : null;
}

/** Remove a connection and the dynamic input mappings that depend on it. */
export function removeConnection(project, edgeId) {
  const edge = project.edges?.find((item) => item.id === edgeId);
  if (!edge) throw new Error('连接不存在');
  const next = clone(project);
  next.edges = next.edges.filter((item) => item.id !== edgeId);
  const target = next.nodes.find((node) => node.id === edge.target);
  for (const binding of [target?.params?.imageBinding, target?.params?.llmBinding, target?.params?.studioBinding]) {
    if (Array.isArray(binding?.referenceSources)) {
      binding.referenceSources = binding.referenceSources.filter((reference) => reference.sourceNodeId !== edge.source);
    }
  }
  const workflowSources = target?.params?.workflowBinding?.imageSources;
  if (Array.isArray(workflowSources)) {
    target.params.workflowBinding.imageSources = workflowSources.filter((reference) => reference.sourceNodeId !== edge.source);
  }
  const cloudInputs = target?.params?.cloudBinding?.inputs;
  if (Array.isArray(cloudInputs)) {
    target.params.cloudBinding.inputs = cloudInputs.filter((input) => input.sourceNodeId !== edge.source);
  }
  detachNativeInputs(target,new Set([edge.source]));
  syncNativeConnections(next);
  return next;
}

export function connectionError(project, source, target) {
  const ids=new Set(project.nodes.map(n=>n.id));
  if(!ids.has(source)||!ids.has(target))return '连接节点已不存在';
  if(source===target)return '节点不能连接自己';
  if(project.edges.some(e=>e.source===source&&e.target===target))return '这两个节点已经连接';
  const from=project.nodes.find(n=>n.id===source),to=project.nodes.find(n=>n.id===target);
  if(from.type==='loop'&&to.type==='loop')return '暂不支持嵌套循环，请将循环链分开';
  const mapping=connectionReferenceMapping(project,from,to);if(mapping?.error)return mapping.error;
  const outgoing=new Map();for(const e of project.edges){if(!outgoing.has(e.source))outgoing.set(e.source,[]);outgoing.get(e.source).push(e.target);}
  const seen=new Set(),queue=[target];while(queue.length){const id=queue.pop();if(id===source)return '这条连接会形成循环依赖';if(seen.has(id))continue;seen.add(id);queue.push(...(outgoing.get(id)||[]));}
  return null;
}
