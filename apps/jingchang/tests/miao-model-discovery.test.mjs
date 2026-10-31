import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {platformService} from '../lib/api-platforms.mjs';
import {MIAO_API_BASE, isLocalMiaoTarget} from '../public/miao-credential-core.js';

const SECRET = 'synthetic-discovery-miao-secret';
const safeModels = [{id: 'owned-chat-model', object: 'model', owned_by: 'test-provider', created: 1},
  {id: 'owned-image-model', object: 'model'}];
const reflectedModels = [...safeModels,
  {id: 'prefix-' + SECRET + '-suffix', object: 'model'},
  {id: 'reflected-object', object: 'model-' + SECRET},
  {id: 'reflected-owner', object: 'model', owned_by: 'provider-' + SECRET}];

async function fixture({baseUrl = MIAO_API_BASE, protocol = 'openai-compatible',
  listed = {models: safeModels}} = {}) {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'jc-miao-discovery-test-'));
  const calls = {resolve: [], listing: []};
  const miaoCredentials = {resolve: async (platform, options) => {
    assert.ok(isLocalMiaoTarget(platform, options));
    calls.resolve.push({baseUrl: platform.baseUrl, purpose: options.purpose});
    return {apiKey: SECRET, source: 'macos-keychain'};
  }};
  const openAIModelLister = async options => {
    calls.listing.push({baseUrl: options.baseUrl, apiKey: options.apiKey, signal: options.signal});
    return structuredClone(listed);
  };
  const service = platformService(data, {miaoCredentials, openAIModelLister});
  const saved = await service.save({revision: 0, platform: {
    name: '模型列表隔离测试', protocol, baseUrl,
    models: [{id: protocol === 'gemini' ? 'gemini-test-chat' : 'owned-chat-model', category: 'chat'}],
  }});
  const platform = saved.platforms[0], file = path.join(data, 'api-platforms.json');
  const before = await fs.readFile(file);
  const body = extra => ({platformId: platform.id, consent: true,
    credentialSource: 'miao-local', credentialConsent: true, apiKey: '', ...extra});
  async function unchanged() {
    assert.deepEqual(await fs.readFile(file), before);
    assert.equal((await fs.readFile(file)).includes(Buffer.from(SECRET)), false);
    assert.deepEqual((await service.list()).platforms.map(p => p.id), [platform.id]);
    assert.deepEqual(await fs.readdir(data), ['api-platforms.json']);
  }
  async function rejected(extra) {
    await assert.rejects(service.discover(body(extra)));
    assert.equal(calls.resolve.length, 0);
    assert.equal(calls.listing.length, 0);
    await unchanged();
  }
  return {data, service, platform, calls, body, unchanged, rejected};
}

test('拉取模型必须明确同意发送请求和本机来源，拒绝时尚未解析或请求', async () => {
  const f = await fixture();
  for (const extra of [{consent: undefined}, {consent: false}, {consent: 'true'}, {consent: 1},
    {credentialConsent: undefined}, {credentialConsent: false}, {credentialConsent: 'true'},
    {credentialSource: 'ark-local'}, {credentialSource: 'deepseek-local'},
    {credentialSource: 'unknown'}, {apiKey: SECRET}]) {
    await f.rejected(extra);
  }
});

test('托管密钥不能随模型列表请求发往其他域名、本地地址或 Gemini 协议', async () => {
  for (const options of [{baseUrl: 'https://other.invalid/v1'},
    {baseUrl: 'https://miaoapi.xyz.evil.invalid/v1'},
    {baseUrl: 'http://127.0.0.1:8188/v1'}, {protocol: 'gemini'}]) {
    const f = await fixture(options);
    await f.rejected({});
  }
});

test('正常托管模型列表只向固定地址取一次密钥，回显 id/object/owned_by 的模型整项过滤', async () => {
  const f = await fixture({listed: {models: reflectedModels, partial: true,
    note: '上游说明：' + SECRET + '，再次出现 ' + SECRET + '。'}});
  const body = f.body(), result = await f.service.discover(body);
  assert.deepEqual(result.models, safeModels);
  assert.equal(result.partial, true);
  assert.equal(typeof result.note, 'string');
  assert.match(result.note, /上游说明/);
  assert.equal(result.note.includes(SECRET), false);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.deepEqual(f.calls.resolve, [{baseUrl: MIAO_API_BASE, purpose: 'chat'}]);
  assert.equal(f.calls.listing.length, 1);
  assert.equal(f.calls.listing[0].baseUrl, MIAO_API_BASE);
  assert.equal(f.calls.listing[0].apiKey, SECRET);
  assert.ok(f.calls.listing[0].signal instanceof AbortSignal);
  assert.equal(body.apiKey, '');
  await f.unchanged();
});

test('数组形态的模型列表同样过滤回显项，保留干净模型元数据', async () => {
  const f = await fixture({listed: reflectedModels});
  const result = await f.service.discover(f.body());
  assert.deepEqual(result.models, safeModels);
  assert.match(result.note, /过滤.*敏感/);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(f.calls.resolve.length, 1); assert.equal(f.calls.listing.length, 1);
  await f.unchanged();
});

test('省略来源的旧 localhost 空密钥路径保留正常模型，不查钥匙串且不误过滤空串', async () => {
  const f = await fixture({baseUrl: 'http://127.0.0.1:8188/v1',
    listed: {models: safeModels, note: '本地列表返回成功'}});
  const body = {platformId: f.platform.id, consent: true};
  const result = await f.service.discover(body);
  assert.deepEqual(result.models, safeModels);
  assert.equal(result.note, '本地列表返回成功');
  assert.equal(f.calls.resolve.length, 0); assert.equal(f.calls.listing.length, 1);
  assert.equal(f.calls.listing[0].apiKey, '');
  assert.equal(body.apiKey, '');
  await f.unchanged();
});

test('手动密钥模型列表也过滤回显，但不能隐式解析本机来源', async () => {
  const f = await fixture({listed: {models: reflectedModels, note: '回显 ' + SECRET}});
  const body = f.body({credentialSource: 'manual', credentialConsent: false, apiKey: SECRET});
  const result = await f.service.discover(body);
  assert.deepEqual(result.models, safeModels);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(f.calls.resolve.length, 0); assert.equal(f.calls.listing.length, 1);
  assert.equal(f.calls.listing[0].apiKey, SECRET);
  assert.equal(body.apiKey, '');
  await f.unchanged();
});
