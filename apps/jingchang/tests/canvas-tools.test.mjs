import test from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, makeProject } from '../lib/model.mjs';
import {
  alignNodes,
  connectionError,
  connectionMediaMapping,
  copySelectedNodes,
  createGroup,
  moveNodes,
  setGroupCollapsed,
  setGroupColor,
  removeConnection,
  ungroup,
  validateGroups
} from '../lib/canvas-tools.mjs';

function fixture() {
  const project = makeProject('画布工具测试');
  const first = makeNode('image', 10, 20, { title: '首帧', assetId: 'asset-a', width: 100, height: 60 });
  const second = makeNode('video', 220, 140, { title: '镜头', assetId: 'asset-b', width: 80, height: 40 });
  const third = makeNode('audio', 500, 300, { title: '声音', assetId: 'asset-c', width: 50, height: 30 });
  project.nodes = [first, second, third];
  project.edges = [
    { id: 'edge-ab', source: first.id, target: second.id },
    { id: 'edge-bc', source: second.id, target: third.id },
    { id: 'edge-ac', source: first.id, target: third.id }
  ];
  return { project, first, second, third };
}

test('复制多选节点只复制选中节点间的边，并保留 assetId', () => {
  const { project, first, second, third } = fixture();
  const before = structuredClone(project);
  const next = copySelectedNodes(project, [first.id, second.id], { offsetX: 30, offsetY: -10 });

  assert.deepEqual(project, before);
  assert.equal(next.nodes.length, 5);
  const copies = next.nodes.filter((node) => !before.nodes.some((old) => old.id === node.id));
  assert.equal(copies.length, 2);
  assert.notEqual(copies[0].id, first.id);
  assert.notEqual(copies[1].id, second.id);
  assert.deepEqual(
    copies.map((node) => [node.assetId, node.x, node.y]),
    [['asset-a', 40, 10], ['asset-b', 250, 130]]
  );
  assert.equal(next.edges.length, 4);
  const copiedEdge = next.edges.find((edge) => edge.id !== 'edge-ab' && edge.id !== 'edge-bc' && edge.id !== 'edge-ac');
  assert.ok(copiedEdge);
  assert.ok(copies.some((node) => node.id === copiedEdge.source));
  assert.ok(copies.some((node) => node.id === copiedEdge.target));
  assert.notEqual(copiedEdge.source, third.id);
  assert.notEqual(copiedEdge.target, third.id);
});

test('创建分组支持缺省 groups，节点最多属于一个组，解组保留节点', () => {
  const { project, first, second, third } = fixture();
  const grouped = createGroup(project, [first.id, second.id], '第一组');
  assert.equal(project.groups, undefined);
  assert.equal(grouped.groups.length, 1);
  assert.deepEqual(grouped.groups[0].nodeIds, [first.id, second.id]);
  assert.equal(grouped.groups[0].title, '第一组');
  assert.equal(validateGroups(grouped), true);
  assert.throws(() => createGroup(grouped, [second.id, third.id], '冲突组'), /已属于分组/);

  const ungrouped = ungroup(grouped, grouped.groups[0].id);
  assert.deepEqual(ungrouped.groups, []);
  assert.equal(ungrouped.nodes.length, project.nodes.length);
  assert.equal(project.groups, undefined);
  assert.throws(() => createGroup(project, [], '空组'), /至少选择一个节点/);
});

test('拖动复制完整选区时可复制整组元数据，部分成员复制不会改动原组', () => {
  const { project, first, second, third } = fixture();
  const grouped = createGroup(project, [first.id, second.id], '镜头组');
  const copied = copySelectedNodes(grouped, [first.id, second.id], {
    offsetX: 50,
    offsetY: 25,
    copyGroups: true
  });

  assert.equal(copied.groups.length, 2);
  assert.equal(copied.groups[0].id, grouped.groups[0].id);
  assert.equal(copied.groups[1].title, '镜头组（副本）');
  assert.notEqual(copied.groups[1].id, copied.groups[0].id);
  assert.deepEqual(copied.groups[1].nodeIds, copied.nodes.slice(3, 5).map((node) => node.id));
  assert.equal(copied.edges.length, 4);
  assert.equal(copied.nodes[3].x, first.x + 50);
  assert.equal(copied.nodes[4].y, second.y + 25);
  assert.equal(grouped.groups.length, 1);

  const partial = copySelectedNodes(grouped, [first.id], { copyGroups: true });
  assert.equal(partial.groups.length, 1);
  assert.equal(partial.nodes.length, 4);
  assert.equal(partial.nodes[3].id === first.id, false);
  assert.ok(partial.nodes.some((node) => node.id === third.id));
});

test('Alt 拖动不复制连线，Alt+Shift 只保留复制节点的入边与组内连线', () => {
  const { project, first, second, third } = fixture();
  const outside = makeNode('image', 760, 420, { title: '外部下游' });
  project.nodes.push(outside);
  project.edges = [
    { id: 'internal', source: first.id, target: second.id },
    { id: 'incoming', source: third.id, target: first.id },
    { id: 'outgoing', source: second.id, target: outside.id }
  ];
  const grouped = createGroup(project, [first.id, second.id], '镜头组');

  const altOnly = copySelectedNodes(grouped, [first.id, second.id], {
    offsetX: 0,
    offsetY: 0,
    copyGroups: true,
    copyConnections: false
  });
  assert.equal(altOnly.nodes.length, 6);
  assert.equal(altOnly.groups.length, 2);
  assert.equal(altOnly.edges.length, 3);

  const altShift = copySelectedNodes(grouped, [first.id, second.id], {
    offsetX: 0,
    offsetY: 0,
    copyGroups: true,
    copyConnections: true,
    copyIncomingConnections: true
  });
  const copies = altShift.nodes.slice(4);
  const [copyFirst, copySecond] = copies;
  const added = altShift.edges.filter((edge) => !grouped.edges.some((old) => old.id === edge.id));
  assert.equal(added.length, 2);
  assert.ok(added.some((edge) => edge.source === copyFirst.id && edge.target === copySecond.id));
  assert.ok(added.some((edge) => edge.source === third.id && edge.target === copyFirst.id));
  assert.ok(!added.some((edge) => edge.source === copySecond.id && edge.target === outside.id));
  assert.equal(altShift.groups.length, 2);
  assert.equal(grouped.edges.length, 3);
});

test('分组支持严格校验的自定义颜色与可撤销式折叠状态', () => {
  const { project, first, second } = fixture();
  const grouped = createGroup(project, [first.id, second.id], '可折叠组');
  const groupId = grouped.groups[0].id;
  const before = structuredClone(grouped);
  const colored = setGroupColor(grouped, groupId, '#325AB4');
  assert.equal(colored.groups[0].color, '#325ab4');
  assert.deepEqual(grouped, before);
  const collapsed = setGroupCollapsed(colored, groupId, true);
  assert.equal(collapsed.groups[0].collapsed, true);
  assert.equal(setGroupCollapsed(collapsed, groupId, false).groups[0].collapsed, false);
  assert.deepEqual(colored.groups[0].collapsed, false);
  assert.throws(() => setGroupColor(grouped, groupId, 'red'), /六位十六进制/);
  assert.throws(() => setGroupCollapsed(grouped, groupId, 'true'), /布尔值/);
  assert.throws(() => validateGroups({ ...grouped, groups: [{ ...grouped.groups[0], color: 'url(javascript:alert(1))' }] }), /分组颜色无效/);
  assert.throws(() => validateGroups({ ...grouped, groups: [{ ...grouped.groups[0], collapsed: 1 }] }), /分组折叠状态无效/);
});

test('移动多个节点支持对象和数值两种位移参数，且不修改输入', () => {
  const { project, first, second, third } = fixture();
  const before = structuredClone(project);
  const moved = moveNodes(project, [first.id, second.id], { dx: 5, dy: -8 });
  assert.deepEqual(project, before);
  assert.deepEqual([moved.nodes[0].x, moved.nodes[0].y], [15, 12]);
  assert.deepEqual([moved.nodes[1].x, moved.nodes[1].y], [225, 132]);
  assert.deepEqual([moved.nodes[2].x, moved.nodes[2].y], [500, 300]);
  const movedAgain = moveNodes(moved, [third.id], 10, 20);
  assert.deepEqual([movedAgain.nodes[2].x, movedAgain.nodes[2].y], [510, 320]);
});

test('按 bounding box 对齐六种方式，并保留未选节点', () => {
  const { project, first, second, third } = fixture();
  const selected = [first.id, second.id];
  const cases = [
    ['left', (a, b) => assert.equal(b.x, a.x)],
    ['top', (a, b) => assert.equal(b.y, a.y)],
    ['right', (a, b) => assert.equal(b.x + b.width, a.x + a.width)],
    ['bottom', (a, b) => assert.equal(b.y + b.height, a.y + a.height)],
    ['hcenter', (a, b) => assert.equal(b.x + b.width / 2, a.x + a.width / 2)],
    ['vcenter', (a, b) => assert.equal(b.y + b.height / 2, a.y + a.height / 2)]
  ];

  for (const [alignment, check] of cases) {
    const next = alignNodes(project, selected, alignment);
    const a = next.nodes.find((node) => node.id === first.id);
    const b = next.nodes.find((node) => node.id === second.id);
    check(a, b);
    assert.deepEqual(next.nodes.find((node) => node.id === third.id), third);
  }
  assert.throws(() => alignNodes(project, selected, 'center'), /不支持/);
});

test('验证悬空、重复和跨组节点引用', () => {
  const { project, first, second } = fixture();
  assert.throws(() => validateGroups({ ...project, groups: [{ id: 'g', title: '坏组', nodeIds: ['missing'] }] }), /不存在的节点/);
  assert.throws(() => validateGroups({
    ...project,
    groups: [
      { id: 'g1', title: '一组', nodeIds: [first.id] },
      { id: 'g2', title: '二组', nodeIds: [first.id, second.id] }
    ]
  }), /多个分组/);
  assert.throws(() => validateGroups({
    ...project,
    groups: [{ id: 'g', title: '重复节点', nodeIds: [first.id, first.id] }]
  }), /节点重复/);
  assert.throws(() => validateGroups({
    ...project,
    groups: [{ id: 'bad.id', title: '非法 ID', nodeIds: [first.id] }]
  }), /分组 ID 无效/);
  assert.throws(() => validateGroups({
    ...project,
    groups: [{ id: 'g', title: 'x'.repeat(121), nodeIds: [first.id] }]
  }), /分组标题无效/);
  assert.throws(() => validateGroups({
    ...project,
    groups: [{ id: 'g', title: '空组', nodeIds: [] }]
  }), /分组 nodeIds 无效/);
});

test('复制混合工作流重映射内部输入，保留外部引用且不修改原节点', () => {
  const { project, first, second, third } = fixture();
  second.params.workflowBinding={workflowId:'w',imageSources:[{nodeId:'1',name:'image',sourceNodeId:first.id},{nodeId:'2',name:'image',sourceNodeId:third.id}]};
  first.params.cloudBinding={recipeId:'r',recipeRevision:3,inputs:[{nodeId:'1',fieldName:'image',sourceNodeId:second.id},{nodeId:'2',fieldName:'text',useText:true}]};
  const before=structuredClone(project),next=copySelectedNodes(project,[first.id,second.id]);
  const [a,b]=next.nodes.slice(3);
  assert.equal(b.params.workflowBinding.imageSources[0].sourceNodeId,a.id);
  assert.equal(b.params.workflowBinding.imageSources[1].sourceNodeId,third.id);
  assert.equal(a.params.cloudBinding.inputs[0].sourceNodeId,b.id);
  assert.equal(a.params.cloudBinding.inputs[1].useText,true);
  assert.deepEqual(project,before);
});

test('连线预检拒绝自身、重复、缺失节点及跨多跳环路',()=>{
  const {project,first,second,third}=fixture(),before=structuredClone(project);
  assert.match(connectionError(project,first.id,first.id),/自己/);
  assert.match(connectionError(project,first.id,second.id),/已经连接/);
  assert.match(connectionError(project,third.id,first.id),/循环/);
  assert.match(connectionError(project,'missing',first.id),/不存在/);
  assert.deepEqual(project,before);
  project.edges=project.edges.filter(e=>e.id!=='edge-ac');
  assert.equal(connectionError(project,first.id,third.id),null);
});

test('直连图片接口会自动映射图片参考，并拒绝视频或音频输入', () => {
  const project = makeProject('图片端口');
  const image = makeNode('image', 0, 0);
  const video = makeNode('video', 0, 0);
  const audio = makeNode('audio', 0, 0);
  const target = makeNode('image', 0, 0);
  target.params.imageBinding = {
    platform: { models: [{ id: 'image-model', category: 'image', referenceSupport: true }] },
    model: 'image-model', referenceSources: []
  };
  project.nodes = [image, video, audio, target];
  const before = structuredClone(project);
  assert.deepEqual(connectionMediaMapping(project, image.id, target.id), {
    targetId: target.id, bindingKey: 'imageBinding', reference: { sourceNodeId: image.id }
  });
  assert.match(connectionError(project, video.id, target.id), /只能接收图片/);
  assert.match(connectionError(project, audio.id, target.id), /只能接收图片/);
  assert.deepEqual(project, before, 'preflight must not change bindings or edges');
});

test('语言模型端口自动接收图片/视频参考并执行分类型数量限制', () => {
  const project = makeProject('多模态端口');
  const images = Array.from({ length: 9 }, (_, i) => makeNode('image', i, 0));
  const videos = Array.from({ length: 4 }, (_, i) => makeNode('video', i, 0));
  const audio = makeNode('audio', 0, 0);
  const target = makeNode('text', 0, 0);
  target.params.llmBinding = {
    platform: { models: [{ id: 'chat-model', category: 'chat', referenceSupport: true }] },
    model: 'chat-model', referenceSources: []
  };
  project.nodes = [...images, ...videos, audio, target];
  assert.deepEqual(connectionMediaMapping(project, images[0].id, target.id), {
    targetId: target.id, bindingKey: 'llmBinding', reference: { sourceNodeId: images[0].id }
  });
  assert.deepEqual(connectionMediaMapping(project, videos[0].id, target.id), {
    targetId: target.id, bindingKey: 'llmBinding', reference: { sourceNodeId: videos[0].id }
  });
  assert.match(connectionError(project, audio.id, target.id), /要求 Gemini/);
  target.params.llmBinding.referenceSources = images.slice(0, 8).map((node) => ({ sourceNodeId: node.id }));
  assert.match(connectionError(project, images[8].id, target.id), /最多接收 8 张图片/);
  target.params.llmBinding.referenceSources = [
    ...images.slice(0, 8).map((node) => ({ sourceNodeId: node.id })),
    ...videos.slice(0, 3).map((node) => ({ sourceNodeId: node.id }))
  ];
  assert.match(connectionError(project, videos[3].id, target.id), /最多接收 3 段视频/);
});

test('Gemini 音频端口必须明确启用，可映射/复制/断开，但不接受第二份音频', () => {
  const project = makeProject('音频端口'), audio = makeNode('audio', 0, 0), second = makeNode('audio', 0, 100), target = makeNode('script', 400, 0);
  project.nodes = [audio, second, target];
  target.params.llmBinding = {platform: {protocol: 'gemini', models: [{id: 'gemini-test', category: 'chat', audioSupport: false}]}, model: 'gemini-test', referenceSources: []};
  assert.match(connectionError(project, audio.id, target.id), /明确开启/);
  target.params.llmBinding.platform.models[0].audioSupport = true;
  assert.equal(connectionError(project, audio.id, target.id), null);
  assert.deepEqual(connectionMediaMapping(project, audio.id, target.id), {targetId: target.id, bindingKey: 'llmBinding', reference: {sourceNodeId: audio.id}});
  target.params.llmBinding.referenceSources = [{sourceNodeId: audio.id}];
  project.edges = [{id: 'audio-edge', source: audio.id, target: target.id}];
  assert.match(connectionError(project, second.id, target.id), /最多接收 1 份音频/);
  const copied = copySelectedNodes(project, [audio.id, target.id]), copiedTarget = copied.nodes.find(n => n.id !== target.id && n.params.llmBinding);
  assert.notEqual(copiedTarget.params.llmBinding.referenceSources[0].sourceNodeId, audio.id);
  assert.deepEqual(removeConnection(project, 'audio-edge').nodes.find(n => n.id === target.id).params.llmBinding.referenceSources, []);
  assert.equal(target.params.llmBinding.referenceSources.length, 1, 'preflight and disconnect retain original project');
});

test('创作端口按视频操作校验素材类型，循环节点不允许嵌套', () => {
  const project = makeProject('创作端口');
  const image = makeNode('image', 0, 0), video = makeNode('video', 0, 0);
  const target = makeNode('video', 0, 0);
  target.params.studioBinding = { mode: 'video', config: { protocol: 'studio', operation: 'generate' }, referenceSources: [] };
  project.nodes = [image, video, target];
  assert.deepEqual(connectionMediaMapping(project, image.id, target.id), {
    targetId: target.id, bindingKey: 'studioBinding', reference: { sourceNodeId: image.id }
  });
  assert.match(connectionError(project, video.id, target.id), /仅接受图片节点/);
  target.params.studioBinding.config.operation = 'edit';
  assert.deepEqual(connectionMediaMapping(project, video.id, target.id), {
    targetId: target.id, bindingKey: 'studioBinding', reference: { sourceNodeId: video.id }
  });
  assert.match(connectionError(project, image.id, target.id), /仅接受视频节点/);
  const loopA = makeNode('loop', 0, 0), loopB = makeNode('loop', 0, 0);
  project.nodes = [loopA, loopB];
  assert.match(connectionError(project, loopA.id, loopB.id), /不支持嵌套循环/);
});

test('断开连线会清除依赖它的动态媒体映射并保留固定素材', () => {
  const project = makeProject('断开输入');
  const source = makeNode('image', 0, 0), target = makeNode('image', 0, 0);
  target.params = {
    imageBinding: { referenceSources: [{ sourceNodeId: source.id }, { assetId: 'fixed-image' }] },
    llmBinding: { referenceSources: [{ sourceNodeId: source.id }, { assetId: 'fixed-chat-image' }] },
    studioBinding: { referenceSources: [{ sourceNodeId: source.id }, { assetId: 'fixed-studio-image' }] },
    workflowBinding: { imageSources: [{ sourceNodeId: source.id }, { assetId: 'fixed-workflow-image' }] },
    cloudBinding: { inputs: [{ sourceNodeId: source.id }, { useText: true }] }
  };
  project.nodes = [source, target];
  project.edges = [{ id: 'input-edge', source: source.id, target: target.id }];
  const next = removeConnection(project, 'input-edge');
  assert.equal(next.edges.length, 0);
  assert.deepEqual(next.nodes[1].params.imageBinding.referenceSources, [{ assetId: 'fixed-image' }]);
  assert.deepEqual(next.nodes[1].params.llmBinding.referenceSources, [{ assetId: 'fixed-chat-image' }]);
  assert.deepEqual(next.nodes[1].params.studioBinding.referenceSources, [{ assetId: 'fixed-studio-image' }]);
  assert.deepEqual(next.nodes[1].params.workflowBinding.imageSources, [{ assetId: 'fixed-workflow-image' }]);
  assert.deepEqual(next.nodes[1].params.cloudBinding.inputs, [{ useText: true }]);
  assert.equal(project.edges.length, 1, 'removal should preserve the input object');
  assert.equal(project.nodes[1].params.imageBinding.referenceSources[0].sourceNodeId, source.id);
});
