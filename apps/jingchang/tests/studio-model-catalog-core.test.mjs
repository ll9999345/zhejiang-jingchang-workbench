import test from 'node:test';
import assert from 'node:assert/strict';
import {inferStudioModelCategory, studioModelChoices, studioModelChoiceKey,
  findStudioModelChoice} from '../public/studio-model-catalog-core.js';

const platform = (id, models = []) => ({id, baseUrl: 'https://example.test/' + id + '/v1',
  protocol: 'openai-compatible', models});

test('explicit provider category wins over model-family guesses', () => {
  for (const category of ['image', 'chat', 'video']) {
    assert.equal(inferStudioModelCategory({id: 'seedance-2.0', category}), category);
  }
});

test('Gemini generateContent metadata distinguishes image models and chat models', () => {
  assert.equal(inferStudioModelCategory({name: 'models/gemini-test-image',
    supportedGenerationMethods: ['generateContent']}), 'image');
  assert.equal(inferStudioModelCategory({id: 'gemini-test-image-preview',
    supportedGenerationMethods: ['generateContent']}), 'image');
  assert.equal(inferStudioModelCategory({id: 'gemini-2.5-flash',
    supportedGenerationMethods: ['generateContent']}), 'chat');
  assert.equal(inferStudioModelCategory({id: 'gemini-embedding',
    supportedGenerationMethods: ['embedContent']}), null);
});

test('ordinary Gemini, MiniMax M2 and unknown names are not forced into a category', () => {
  for (const id of ['gemini-2.5-flash', 'gemini-test-image', 'minimax-m2', 'MiniMax-M2.1',
    'minimax-h3-preview', 'minimax-h30', 'unknown', 'private-video-model', 'waning-model']) {
    assert.equal(inferStudioModelCategory({id}), null, id);
  }
});

test('recognizable video-family IDs and exact MiniMax H3 carry conservative name hints', () => {
  for (const id of ['seedance-2.0', 'doubao-seedance-2-0-260128', 'vendor/veo3.1',
    'sora-2', 'kling-v2.6', 'minimax-hailuo-02', 'wan2.2', 'Wan-2.6', 'MiniMax-H3']) {
    assert.equal(inferStudioModelCategory(id), 'video', id);
  }
});

test('specific image-family IDs may be inferred without classifying every unknown as image', () => {
  for (const id of ['gpt-image-2', 'dall-e-3', 'Qwen-Image-Edit', 'seedream-4.5', 'flux.1', 'imagen-4']) {
    assert.equal(inferStudioModelCategory(id), 'image', id);
  }
  assert.equal(inferStudioModelCategory('image-to-text-private'), null);
});

test('saved video models are visible without performing discovery', () => {
  const choices = studioModelChoices([platform('a', [{id: 'seedance-2.0', category: 'video'},
    {id: 'gpt-image-2', category: 'image'}, {id: 'chat-model', category: 'chat'}])], 'video');
  assert.equal(choices.length, 1);
  assert.deepEqual(choices[0], {id: 'seedance-2.0', label: 'seedance-2.0', display: 'seedance-2.0',
    baseUrl: 'https://example.test/a/v1', platformId: 'a', platformProtocol: 'openai-compatible',
    source: 'saved', category: 'video', categorySource: 'saved'});
});

test('discovery merges by platform and excludes unknown or other-mode entries', () => {
  const choices = studioModelChoices([platform('a')], 'video', {discoveredByPlatform: {
    a: [{id: 'seedance-2.0-mini'}, {id: 'unknown'}, {id: 'gpt-image-2'},
      {id: 'custom-video', category: 'video'}],
    absent: [{id: 'seedance-2.0-fast'}],
  }});
  assert.deepEqual(choices.map(choice => [choice.id, choice.source, choice.categorySource]), [
    ['seedance-2.0-mini', 'discovered', 'name-inference'],
    ['custom-video', 'discovered', 'provider'],
  ]);
});

test('saved metadata wins over duplicate discovery, including a conflicting category', () => {
  const platforms = [platform('a', [{id: 'seedance-2.0', label: '已保存名称', category: 'video'},
    {id: 'seedance-private', category: 'image'}])];
  const discoveredByPlatform = {a: [{id: 'seedance-2.0', label: '服务旧名称', category: 'video'},
    {id: 'seedance-2.0', category: 'video'}, {id: 'seedance-private', category: 'video'}]};
  const choices = studioModelChoices(platforms, 'video', {discoveredByPlatform});
  assert.equal(choices.length, 1);
  assert.equal(choices[0].display, '已保存名称');
  assert.equal(choices[0].source, 'saved');
  assert.equal(studioModelChoices(platforms, 'image', {discoveredByPlatform})[0].source, 'saved');
});

test('the same exact model ID on two platforms retains two destinations', () => {
  const choices = studioModelChoices([platform('a', [{id: 'seedance-2.0', category: 'video'}]),
    platform('b', [{id: 'seedance-2.0', category: 'video'}])], 'video');
  assert.equal(choices.length, 2);
  assert.notEqual(studioModelChoiceKey(choices[0]), studioModelChoiceKey(choices[1]));
  assert.notEqual(choices[0].baseUrl, choices[1].baseUrl);
  for (const choice of choices) assert.equal(findStudioModelChoice(choices, studioModelChoiceKey(choice)), choice);
});

test('choice keys preserve case and special characters and are safe as option values', () => {
  const modelId = `Exact/Model:Rev='A'&<value>"`;
  const choices = studioModelChoices([platform('a', [{id: modelId, category: 'video'},
    {id: modelId.toLowerCase(), category: 'video'}])], 'video');
  const key = studioModelChoiceKey(choices[0]);
  assert.doesNotMatch(key, /[<>"'\s]/);
  assert.deepEqual(JSON.parse(decodeURIComponent(key)), ['a', modelId]);
  assert.equal(findStudioModelChoice(choices, key)?.id, modelId);
  assert.notEqual(key, studioModelChoiceKey(choices[1]));
});

test('invalid keys never select a fallback or a different platform model', () => {
  const choices = studioModelChoices([platform('a', [{id: 'seedance-2.0', category: 'video'}])], 'video');
  for (const key of ['', null, 'seedance-2.0', '%not-json', '%5B%22b%22%2C%22seedance-2.0%22%5D']) {
    assert.equal(findStudioModelChoice(choices, key), null);
  }
  assert.equal(studioModelChoiceKey({id: 'seedance-2.0'}), '');
  assert.equal(findStudioModelChoice(null, 'anything'), null);
});

test('model IDs longer than 200 characters or containing controls are not offered', () => {
  const invalidIds = ['', ' ', 'x'.repeat(201), 'video\nmodel', 'video\0model', 'video\u007fmodel',
    'video\u0085model', 12, null];
  const choices = studioModelChoices([platform('a', [
    ...invalidIds.map(id => ({id, category: 'video'})), {id: 'x'.repeat(200), category: 'video'},
  ])], 'video', {discoveredByPlatform: {a: invalidIds}});
  assert.equal(choices.length, 1);
  assert.equal(choices[0].id.length, 200);
  for (const id of invalidIds) assert.equal(studioModelChoiceKey({platformId: 'a', id}), '');
});

test('arbitrary owner and credential metadata does not escape the output allowlist', () => {
  const platforms = [{...platform('a'), owner: {token: 'synthetic-owner-only'}, apiKey: 'synthetic-platform-only'}];
  const choices = studioModelChoices(platforms, 'video', {discoveredByPlatform: {a: [{
    id: 'seedance-2.0', owned_by: 'synthetic-owner-only', apiKey: 'synthetic-model-only',
    arbitrary: {secret: 'synthetic-arbitrary-only'}, available: true, generationSucceeded: true,
  }]}});
  assert.equal(choices.length, 1);
  assert.deepEqual(Object.keys(choices[0]).sort(), ['baseUrl', 'category', 'categorySource', 'display',
    'id', 'label', 'platformId', 'platformProtocol', 'source'].sort());
  assert.doesNotMatch(JSON.stringify(choices), /synthetic-|available|generationSucceeded|owned_by|apiKey/);
});

test('display cleanup preserves the exact selectable provider ID and base URL', () => {
  const id = 'Seedance-2.0-Custom';
  const choices = studioModelChoices([{...platform('a'), protocol: 'provider-specific',
    baseUrl: 'https://example.test/Actual/API/v3', models: [{id, label: id + ' · MiaoAPI', category: 'video'}]}], 'video');
  assert.equal(choices[0].display, id);
  assert.equal(choices[0].id, id);
  assert.equal(choices[0].baseUrl, 'https://example.test/Actual/API/v3');
  assert.equal(choices[0].platformProtocol, 'provider-specific');
  assert.equal(Object.hasOwn(choices[0], 'protocol'), false);
});

test('Gemini discovery retains evidence and exact resource IDs without transport mapping', () => {
  const platforms = [{...platform('gemini'), protocol: 'gemini'}];
  const discoveredByPlatform = {gemini: [{name: 'models/gemini-test-image',
    supportedGenerationMethods: ['generateContent']} ]};
  const choices = studioModelChoices(platforms, 'image', {discoveredByPlatform});
  assert.equal(choices[0].id, 'models/gemini-test-image');
  assert.equal(choices[0].categorySource, 'generation-methods');
  assert.equal(choices[0].platformProtocol, 'gemini');
});

test('saved entries without explicit categories are not reclassified or mutated', () => {
  const platforms = [platform('a', [{id: 'seedance-2.0'}, {id: 'gemini-test-image'}])];
  const discoveredByPlatform = {a: [{id: 'seedance-2.0', category: 'video'}]};
  const before = structuredClone({platforms, discoveredByPlatform});
  assert.deepEqual(studioModelChoices(platforms, 'image', {discoveredByPlatform}), []);
  assert.equal(studioModelChoices(platforms, 'video', {discoveredByPlatform})[0].source, 'discovered');
  assert.deepEqual({platforms, discoveredByPlatform}, before);
});

test('malformed collections and inherited discovery entries do not produce choices', () => {
  assert.deepEqual(studioModelChoices(null, 'video'), []);
  assert.deepEqual(studioModelChoices([platform('a')], 'unknown'), []);
  assert.deepEqual(studioModelChoices([null, {id: 'missing-platform-fields'},
    platform('a', null)], 'video', {discoveredByPlatform: {a: {models: ['seedance-2.0']}}}), []);
  const inherited = Object.create({a: ['seedance-2.0']});
  assert.deepEqual(studioModelChoices([platform('a')], 'video', {discoveredByPlatform: inherited}), []);
});
