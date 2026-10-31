import test from 'node:test';
import assert from 'node:assert/strict';
import { listUpstreamImageReferences, resolveImageContext } from '../lib/input-context.mjs';

function asset(id, type = 'image/png', size = 1024, name = id) {
  return { id, name, type, size };
}

function node(id, type, text = '', extra = {}) {
  return { id, type, title: id, text, assetId: null, ...extra };
}

function baseProject() {
  const target = node('target', 'image', '请生成目标画面', { assetId: 'target-old' });
  const branchB = node('scene-b', 'scene', '场景乙', { assetId: 'scene-image' });
  const branchA = node('text-a', 'text', '风格甲');
  const character = node('character', 'character', '角色甲', { assetId: 'character-image' });
  const video = node('video', 'video', '', { assetId: 'video-input' });
  const audio = node('audio', 'audio', '', { assetId: 'audio-input' });
  return {
    id: 'project',
    nodes: [target, branchB, branchA, character, video, audio],
    // The node array intentionally puts the target first. Topological output
    // must still put text-a before character/scene where dependencies require it.
    edges: [
      { id: 'e1', source: 'text-a', target: 'character' },
      { id: 'e2', source: 'character', target: 'scene-b' },
      { id: 'e3', source: 'scene-b', target: 'target' },
      { id: 'e4', source: 'video', target: 'target' },
      { id: 'e5', source: 'audio', target: 'target' },
      { id: 'duplicate', source: 'scene-b', target: 'target' },
    ],
    assets: [
      asset('target-old', 'image/png', 1024, '上一轮输出'),
      asset('scene-image', 'image/jpeg', 2048, '场景参考'),
      asset('character-image', 'image/webp', 4096, '角色参考'),
      asset('video-input', 'video/mp4', 1024, '视频输入'),
      asset('audio-input', 'audio/wav', 1024, '音频输入'),
      asset('free-image', 'image/png', 2048, '额外参考'),
    ],
  };
}

test('按拓扑前序和稳定节点顺序传递上游文字，目标文字最后追加', () => {
  const project = baseProject();
  const result = resolveImageContext(project, 'target', { autoReferences: false });

  assert.deepEqual(result.upstreamNodeIds, ['text-a', 'character', 'scene-b', 'video', 'audio']);
  assert.match(result.prompt, /风格甲/);
  assert.match(result.prompt, /角色甲/);
  assert.match(result.prompt, /场景乙/);
  assert.match(result.prompt, /当前节点：请生成目标画面$/);
  assert.ok(result.prompt.indexOf('风格甲') < result.prompt.indexOf('角色甲'));
  assert.ok(result.prompt.indexOf('角色甲') < result.prompt.indexOf('场景乙'));
  assert.deepEqual(result.referenceIds, []);
});

test('自动参考只取上游图片，显式选择才会带目标自身素材', () => {
  const project = baseProject();
  const automatic = resolveImageContext(project, 'target');
  assert.deepEqual(automatic.referenceIds, ['character-image', 'scene-image']);
  assert.ok(!automatic.referenceIds.includes('target-old'));
  assert.ok(!automatic.referenceIds.includes('video-input'));
  assert.ok(!automatic.referenceIds.includes('audio-input'));

  const explicit = resolveImageContext(project, 'target', {
    autoReferences: false,
    referenceIds: ['target-old', 'target-old', 'free-image'],
  });
  assert.deepEqual(explicit.referenceIds, ['target-old', 'free-image']);
});

test('候选列表按上游顺序去重并只返回图片 id/name/type', () => {
  const project = baseProject();
  project.nodes.find(n => n.id === 'scene-b').assetId = 'character-image';
  assert.deepEqual(listUpstreamImageReferences(project, 'target'), [
    { id: 'character-image', name: '角色参考', type: 'image/webp' },
  ]);
  assert.deepEqual(listUpstreamImageReferences(project, 'target', { includeUpstream: false }), []);
});

test('显式参考拒绝不存在、非图片和超过 10 MB 的素材，并限制最多20张', () => {
  const project = baseProject();
  project.assets.push(
    asset('large-image', 'image/png', 10 * 1024 * 1024 + 1),
    asset('fourth-image', 'image/png', 1024),
  );
  assert.throws(
    () => resolveImageContext(project, 'target', { autoReferences: false, referenceIds: ['missing'] }),
    /参考图片素材不存在/,
  );
  assert.throws(
    () => resolveImageContext(project, 'target', { autoReferences: false, referenceIds: ['video-input'] }),
    /必须是 PNG、JPEG 或 WebP 图片/,
  );
  assert.throws(
    () => resolveImageContext(project, 'target', { autoReferences: false, referenceIds: ['large-image'] }),
    /不得超过 10 MB/,
  );
  const ids=Array.from({length:21},(_,i)=>'capacity-'+i);
  project.assets.push(...ids.map(id=>asset(id,'image/png',1024)));
  assert.deepEqual(resolveImageContext(project,'target',{autoReferences:false,referenceIds:ids.slice(0,20)}).referenceIds,ids.slice(0,20));
  assert.throws(
    () => resolveImageContext(project, 'target', {
      autoReferences: false,
      referenceIds: Array.from({length:21},(_,i)=>'capacity-'+i),
    }),
    /最多 20 张.*取舍/,
  );
});

test('拒绝循环、边悬空、空提示词和超长提示词', () => {
  const project = baseProject();
  project.edges.push({ id: 'cycle', source: 'target', target: 'scene-b' });
  assert.throws(() => resolveImageContext(project, 'target'), /循环依赖/);

  const dangling = baseProject();
  dangling.edges.push({ id: 'dangling', source: 'scene-b', target: 'missing-node' });
  assert.throws(() => resolveImageContext(dangling, 'target'), /不存在的节点/);

  const empty = { nodes: [node('target', 'image')], edges: [], assets: [] };
  assert.throws(() => resolveImageContext(empty, 'target'), /提示词不能为空/);
  assert.equal(resolveImageContext(empty, 'target', { allowEmptyPrompt: true }).prompt, '');

  const long = { nodes: [node('target', 'image', '字'.repeat(32_001))], edges: [], assets: [] };
  assert.throws(() => resolveImageContext(long, 'target'), /不得超过 32000/);
});

test('不修改项目输入，且 includeUpstream=false 仍允许显式参考', () => {
  const project = baseProject();
  const before = structuredClone(project);
  const result = resolveImageContext(project, 'target', {
    includeUpstream: false,
    autoReferences: false,
    referenceIds: ['target-old'],
  });
  assert.deepEqual(result.upstreamNodeIds, []);
  assert.deepEqual(result.referenceIds, ['target-old']);
  assert.deepEqual(project, before);
});
