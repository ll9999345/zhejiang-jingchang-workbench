import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createCanvas} from '@napi-rs/canvas';
import {directImageService} from '../lib/direct-images.mjs';
import {conversationService} from '../lib/conversations.mjs';
import {platformService} from '../lib/api-platforms.mjs';
import {makeProject, makeNode} from '../lib/model.mjs';
import {atomicJson, readJson, records, storeAsset} from '../lib/workspace.mjs';
import {MIAO_API_BASE, isLocalMiaoTarget} from '../public/miao-credential-core.js';

// Every transport and credential below is synthetic. No keychain or network.
const SECRET = 'synthetic-managed-miao-secret-not-real';
const MANUAL_SECRET = 'synthetic-manual-miao-secret-not-real';
const PNG = createCanvas(4, 3).toBuffer('image/png');
const chosen = {apiKey: '', credentialSource: 'miao-local', credentialConsent: true};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function assertNoSecret(directory) {
  for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await assertNoSecret(file);
    else {
      const bytes = await fs.readFile(file);
      for (const secret of [SECRET, MANUAL_SECRET]) {
        assert.equal(bytes.includes(Buffer.from(secret)), false, 'secret found in ' + file);
      }
    }
  }
}

async function fixture(t, {baseUrl = MIAO_API_BASE, protocol = 'openai-compatible', reply = '本地协议测试回答'} = {}) {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'jc-miao-managed-test-'));
  const activeJobs = new Map(), calls = {resolve: [], image: [], chat: []};
  const platforms = platformService(data);
  const models = protocol === 'gemini'
    ? [{id: 'gemini-test-chat', category: 'chat', referenceSupport: true},
      {id: 'gemini-test-image', category: 'image', referenceSupport: true}]
    : [{id: 'owned-chat-model', category: 'chat', referenceSupport: true},
      {id: 'owned-image-model', category: 'image', referenceSupport: true}];
  const saved = await platforms.save({revision: 0, platform: {
    name: '仅本地协议测试', protocol, baseUrl, models,
  }});
  const platform = saved.platforms[0];
  const project = makeProject('喵喵凭据隔离测试');
  const node = project.nodes[0]; node.title = '自制画面'; node.text = '画一朵几何云';
  await atomicJson(path.join(data, 'projects', project.id, 'project.json'), project);
  await atomicJson(path.join(data, 'projects', project.id, 'history', '0.json'), project);
  const projects = {load: async id => {
    assert.equal(id, project.id); return project;
  }, apply: async (_conversation, message) => message};
  const miaoCredentials = {resolve: async (target, options) => {
    assert.ok(isLocalMiaoTarget(target, options));
    calls.resolve.push({baseUrl: target.baseUrl, purpose: options.purpose});
    return {apiKey: SECRET, source: 'macos-keychain'};
  }};
  const imageGenerator = async options => {
    calls.image.push({baseUrl: options.baseUrl, apiKey: options.apiKey, model: options.model,
      prompt: options.prompt, size: options.size, quality: options.quality,
      references: options.references.map(reference => ({name: reference.name, mime: reference.mime,
        bytes: Buffer.from(reference.bytes)}))});
    return {images: [{bytes: PNG, mime: 'image/png'}], usage: {total_tokens: 1}};
  };
  const apiCall = async options => {
    calls.chat.push({baseUrl: options.baseUrl, apiKey: options.apiKey, path: options.path,
      method: options.method, body: structuredClone(options.body)});
    return {choices: [{message: {role: 'assistant', content: reply}, finish_reason: 'stop'}]};
  };
  const images = directImageService({data, activeJobs, platforms, miaoCredentials, imageGenerator});
  const conversations = conversationService({data, activeJobs, platforms, projects, miaoCredentials, apiCall});
  const conversation = await conversations.create({projectId: project.id, name: '自制对话测试'});
  const chatModel = platform.models.find(model => model.category === 'chat').id;
  const imageModel = platform.models.find(model => model.category === 'image').id;
  const authorization = model => ({origin: new URL(baseUrl).origin, model, budget: 1,
    currency: 'USD', requestLimit: 1, sendPrompt: true, sendReferences: false});
  const imageBody = (extra = {}) => ({...chosen, requestId: 'image-once', revision: project.revision,
    nodeId: node.id, platformId: platform.id, model: imageModel, includeUpstream: false,
    referenceIds: [], size: 'auto', quality: 'auto', authorization: authorization(imageModel), ...extra});
  const chatBody = (extra = {}) => ({...chosen, requestId: 'chat-once', revision: conversation.revision,
    platformId: platform.id, model: chatModel, text: '解释这段本地测试文本', assetIds: [],
    stream: false, maxTokens: 256, authorization: authorization(chatModel), ...extra});
  const jobFile = id => path.join(data, 'jobs', id + '.json');
  async function done(id) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const job = await readJson(jobFile(id));
      if (!activeJobs.has(id) && ['completed', 'failed', 'cancelled', 'incomplete'].includes(job.status)) return job;
      await sleep(5);
    }
    throw Error('synthetic credential integration timed out');
  }
  t.after(() => { for (const job of activeJobs.values()) job.controller.abort(); });
  async function rejected(kind, body) {
    await assert.rejects(kind === 'image' ? images.start(project, body) : conversations.send(conversation.id, body));
    assert.equal(calls.resolve.length, 0);
    assert.equal(calls.image.length + calls.chat.length, 0);
    assert.equal((await records(path.join(data, 'jobs'))).length, 0);
    const c = await conversations.get(conversation.id);
    assert.equal(c.revision, 0); assert.deepEqual(c.messages, []); assert.deepEqual(c.requests, []);
    await assertNoSecret(data);
  }
  return {data, activeJobs, platforms, platform, project, node, conversations, conversation, images,
    calls, authorization, imageBody, chatBody, done, rejected};
}

test('管理凭据通过图片真实服务准入，假 PNG 被保存，密钥只交给注入传输', async t => {
  const f = await fixture(t), before = structuredClone(f.project), body = f.imageBody();
  const job = await f.images.start(f.project, body), result = await f.done(job.id);
  assert.equal(result.status, 'completed', result.message);
  assert.deepEqual(f.calls.resolve, [{baseUrl: MIAO_API_BASE, purpose: 'image'}]);
  assert.equal(f.calls.image.length, 1);
  assert.equal(f.calls.image[0].apiKey, SECRET);
  assert.match(f.calls.image[0].prompt, /画一朵几何云/);
  assert.equal(result.requestCount, 1); assert.equal(result.assets.length, 1);
  assert.deepEqual(await fs.readFile(path.join(f.data, 'assets', result.assets[0].id)), PNG);
  assert.equal(body.apiKey, ''); assert.deepEqual(f.project, before);
  await assertNoSecret(f.data);
});

test('管理凭据通过对话真实服务准入，完整回答写入历史但凭据不会落盘', async t => {
  const f = await fixture(t), body = f.chatBody();
  const job = await f.conversations.send(f.conversation.id, body), result = await f.done(job.id);
  assert.equal(result.status, 'completed', result.message);
  assert.deepEqual(f.calls.resolve, [{baseUrl: MIAO_API_BASE, purpose: 'chat'}]);
  assert.equal(f.calls.chat.length, 1);
  const request = f.calls.chat[0];
  assert.equal(request.apiKey, SECRET); assert.equal(request.path, 'chat/completions');
  assert.equal(request.method, 'POST'); assert.equal(request.body.model, body.model);
  assert.equal(request.body.messages.at(-1).content, body.text);
  assert.equal(result.requestCount, 1); assert.equal(body.apiKey, '');
  const conversation = await f.conversations.get(f.conversation.id);
  assert.equal(conversation.messages.length, 2); assert.equal(conversation.requests.length, 1);
  assert.equal(conversation.messages[1].state, 'complete');
  assert.equal(conversation.messages[1].text, '本地协议测试回答');
  await assertNoSecret(f.data);
});

test('图片缺失或不匹配的服务、预算和发送授权先拒绝，尚不读取本机密钥', async t => {
  const f = await fixture(t), valid = f.imageBody().authorization;
  for (const authorization of [undefined, {...valid, budget: 0}, {...valid, budget: -1},
    {...valid, budget: NaN}, {...valid, budget: Infinity}, {...valid, origin: 'https://evil.invalid'},
    {...valid, model: 'other-model'}, {...valid, sendPrompt: false},
    {...valid, requestLimit: 2}, {...valid, currency: 'EUR'}]) {
    await f.rejected('image', f.imageBody({authorization}));
  }
});

test('对话缺失或不匹配的服务、预算和发送授权先拒绝，尚不读取本机密钥', async t => {
  const f = await fixture(t), valid = f.chatBody().authorization;
  for (const authorization of [undefined, {...valid, budget: 0}, {...valid, budget: -1},
    {...valid, budget: NaN}, {...valid, budget: Infinity}, {...valid, origin: 'https://evil.invalid'},
    {...valid, model: 'other-model'}, {...valid, sendPrompt: false},
    {...valid, requestLimit: 2}, {...valid, currency: 'EUR'}]) {
    await f.rejected('chat', f.chatBody({authorization}));
  }
});

test('图片来源、同意、模型和版本错误先拒绝，不创建生成任务', async t => {
  const f = await fixture(t);
  for (const extra of [{credentialConsent: false}, {credentialConsent: 'true'},
    {credentialSource: 'ark-local'}, {credentialSource: 'deepseek-local'},
    {credentialSource: 'unknown'}, {apiKey: MANUAL_SECRET}, {model: 'unknown'},
    {revision: -1}, {nodeId: 'missing-node'}, {size: 'huge'}, {quality: 'invalid'}]) {
    await f.rejected('image', f.imageBody(extra));
  }
});

test('对话来源、同意、模型和输入错误先拒绝，不创建任务或历史消息', async t => {
  const f = await fixture(t);
  for (const extra of [{credentialConsent: false}, {credentialConsent: 'true'},
    {credentialSource: 'ark-local'}, {credentialSource: 'deepseek-local'},
    {credentialSource: 'unknown'}, {apiKey: MANUAL_SECRET}, {model: 'unknown'},
    {revision: -1}, {text: ''}, {stream: 'true'}, {maxTokens: 0}, {assetIds: ['missing-asset']}]) {
    await f.rejected('chat', f.chatBody(extra));
  }
});

test('图片目标为其他地址或 Gemini 协议时不能读取本机喵喵密钥', async t => {
  for (const options of [{baseUrl: 'https://other.invalid/v1'}, {baseUrl: 'http://127.0.0.1:8188/v1'},
    {protocol: 'gemini'}]) {
    const f = await fixture(t, options);
    await f.rejected('image', f.imageBody());
  }
});

test('对话目标为其他地址或 Gemini 协议时不能读取本机喵喵密钥', async t => {
  for (const options of [{baseUrl: 'https://other.invalid/v1'}, {baseUrl: 'http://127.0.0.1:8188/v1'},
    {protocol: 'gemini'}]) {
    const f = await fixture(t, options);
    await f.rejected('chat', f.chatBody());
  }
});

test('图片同编号并发及完成后重入均返回原任务，不再次取密钥或提交', async t => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([f.images.start(f.project, f.imageBody()), f.images.start(f.project, f.imageBody())]);
  assert.equal(a.id, b.id); assert.equal((await f.done(a.id)).status, 'completed');
  const original = await f.images.start(f.project, f.imageBody({credentialConsent: false, authorization: undefined}));
  assert.equal(original.id, a.id); assert.equal(f.calls.resolve.length, 1); assert.equal(f.calls.image.length, 1);
  assert.equal((await records(path.join(f.data, 'jobs'))).length, 1);
  await assertNoSecret(f.data);
});

test('对话同编号并发及完成后重入均返回原任务，不再次取密钥或提交', async t => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([f.conversations.send(f.conversation.id, f.chatBody()),
    f.conversations.send(f.conversation.id, f.chatBody())]);
  assert.equal(a.id, b.id); assert.equal((await f.done(a.id)).status, 'completed');
  const original = await f.conversations.send(f.conversation.id, f.chatBody({credentialConsent: false, authorization: undefined}));
  assert.equal(original.id, a.id); assert.equal(f.calls.resolve.length, 1); assert.equal(f.calls.chat.length, 1);
  assert.equal((await records(path.join(f.data, 'jobs'))).length, 1);
  assert.equal((await f.conversations.get(f.conversation.id)).messages.length, 2);
  await assertNoSecret(f.data);
});

test('手动 localhost 图片空密钥旧路径仍完成，不读取本机钥匙串', async t => {
  const f = await fixture(t, {baseUrl: 'http://127.0.0.1:8188/v1'});
  const body = f.imageBody({credentialSource: undefined, credentialConsent: false, apiKey: '', authorization: undefined});
  const job = await f.images.start(f.project, body), result = await f.done(job.id);
  assert.equal(result.status, 'completed', result.message);
  assert.equal(f.calls.resolve.length, 0); assert.equal(f.calls.image.length, 1);
  assert.equal(f.calls.image[0].apiKey, ''); assert.equal(result.authorization.scope, 'local');
  await assertNoSecret(f.data);
});

test('手动 localhost 对话空密钥旧路径保留正授权要求，不读取本机钥匙串', async t => {
  const f = await fixture(t, {baseUrl: 'http://127.0.0.1:8188/v1'});
  await f.rejected('chat', f.chatBody({credentialSource: undefined, apiKey: '', authorization: undefined}));
  const job = await f.conversations.send(f.conversation.id, f.chatBody({credentialSource: undefined, apiKey: ''}));
  const result = await f.done(job.id);
  assert.equal(result.status, 'completed', result.message);
  assert.equal(f.calls.resolve.length, 0); assert.equal(f.calls.chat.length, 1);
  assert.equal(f.calls.chat[0].apiKey, '');
  await assertNoSecret(f.data);
});

test('手动云端图片和对话使用本次指定密钥，不隐式改读本机来源', async t => {
  const f = await fixture(t);
  const image = await f.images.start(f.project, f.imageBody({credentialSource: 'manual', apiKey: MANUAL_SECRET}));
  assert.equal((await f.done(image.id)).status, 'completed');
  const chat = await f.conversations.send(f.conversation.id, f.chatBody({credentialSource: 'manual', apiKey: MANUAL_SECRET}));
  assert.equal((await f.done(chat.id)).status, 'completed');
  assert.equal(f.calls.resolve.length, 0);
  assert.equal(f.calls.image[0].apiKey, MANUAL_SECRET); assert.equal(f.calls.chat[0].apiKey, MANUAL_SECRET);
  await assertNoSecret(f.data);
});

test('本机密钥若出现在模型返回文字中，任务和会话历史保存前会隐藏', async t => {
  const f = await fixture(t, {reply: '模拟上游误回显 ' + SECRET + ' 结束'});
  const job = await f.conversations.send(f.conversation.id, f.chatBody()), result = await f.done(job.id);
  assert.equal(result.status, 'completed');
  assert.equal(result.outputText, '模拟上游误回显 [已隐藏密钥] 结束');
  await assertNoSecret(f.data);
});

test('图片参考素材缺失或类型错误先拒绝，授权不能越过输入校验', async t => {
  const f = await fixture(t);
  await f.rejected('image', f.imageBody({referenceIds: ['missing-image'],
    authorization: {...f.imageBody().authorization, sendReferences: true}}));
  const audio = await storeAsset(f.data, Buffer.from('owned-audio-fixture'), {name: '自制占位音频.wav', type: 'audio/wav'});
  f.project.assets.push(audio);
  await f.rejected('image', f.imageBody({referenceIds: [audio.id],
    authorization: {...f.imageBody().authorization, sendReferences: true}}));
});

test('伪 PNG 素材即使有充分发送授权，也在解析密钥前被实际字节校验拒绝', async t => {
  const f = await fixture(t);
  const forged = await storeAsset(f.data, Buffer.from('synthetic bytes are not a PNG'),
    {name: '伪PNG测试.png', type: 'image/png'});
  f.project.assets.push(forged);
  await f.rejected('image', f.imageBody({referenceIds: [forged.id],
    authorization: {...f.imageBody().authorization, sendReferences: true}}));
});

test('参考图上下文合法但发送范围未确认时，两个服务均不解析密钥', async t => {
  const f = await fixture(t);
  const image = await storeAsset(f.data, PNG, {name: '自制参考.png', type: 'image/png'});
  f.project.assets.push(image);
  f.project.nodes.push(makeNode('image', 20, 20, {title: '自制参考', assetId: image.id}));
  await f.rejected('image', f.imageBody({referenceIds: [image.id]}));
  await f.rejected('chat', f.chatBody({assetIds: [image.id]}));
});

test('管理图片接入把合法自制参考按既有顺序交给注入生成器', async t => {
  const f = await fixture(t), references = [];
  for (const name of ['参考A.png', '参考B.png']) {
    const image = await storeAsset(f.data, PNG, {name, type: 'image/png'});
    f.project.assets.push(image); references.push(image);
  }
  const ids = [references[1].id, references[0].id];
  const job = await f.images.start(f.project, f.imageBody({referenceIds: ids,
    authorization: {...f.imageBody().authorization, sendReferences: true}}));
  const result = await f.done(job.id);
  assert.equal(result.status, 'completed', result.message);
  assert.deepEqual(result.input.referenceIds, ids);
  assert.deepEqual(f.calls.image[0].references.map(reference => reference.name), ['参考B.png', '参考A.png']);
  assert.equal(f.calls.resolve.length, 1);
  await assertNoSecret(f.data);
});

test('管理对话接入把已授权自制参考转为合法多模态上下文', async t => {
  const f = await fixture(t);
  const image = await storeAsset(f.data, PNG, {name: '自制多模态参考.png', type: 'image/png'});
  const job = await f.conversations.send(f.conversation.id, f.chatBody({assetIds: [image.id],
    authorization: {...f.chatBody().authorization, sendReferences: true}}));
  const result = await f.done(job.id);
  assert.equal(result.status, 'completed', result.message);
  const content = f.calls.chat[0].body.messages.at(-1).content;
  assert.equal(content[0].type, 'text'); assert.equal(content[1].type, 'image_url');
  assert.equal(content[1].image_url.url, 'data:image/png;base64,' + PNG.toString('base64'));
  assert.equal(f.calls.resolve.length, 1);
  await assertNoSecret(f.data);
});
