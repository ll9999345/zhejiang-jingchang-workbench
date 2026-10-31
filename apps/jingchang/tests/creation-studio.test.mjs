import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { creationStudioService } from '../lib/creation-studio.mjs';
import { readJson, storeAsset } from '../lib/workspace.mjs';

const KEY = 'synthetic-creation-studio-key';
// Valid 1x1 PNG, used only as synthetic local fixture data.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3O8AAAAASUVORK5CYII=', 'base64');
// Minimal ISO BMFF header; this never leaves the localhost mock or test directory.
const MP4 = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function bodyBytes(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function json(res, status, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': bytes.length });
  res.end(bytes);
}

async function mockServer(t) {
  const state = { requests: [], queryCount: 0 };
  const server = http.createServer(async (req, res) => {
    const bytes = await bodyBytes(req);
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    state.requests.push({ method: req.method, pathname, authorization: req.headers.authorization || '', contentType: req.headers['content-type'] || '', bytes });

    if (req.method === 'POST' && pathname === '/v1/images/generations') {
      const request = JSON.parse(bytes.toString('utf8'));
      json(res, 200, { data: Array.from({ length: request.n }, () => ({ b64_json: PNG.toString('base64') })), usage: { total_tokens: 4 } });
      return;
    }
    if (req.method === 'POST' && pathname === '/v1/videos/uploads') {
      json(res, 200, { media_url: 'https://media.example.test/reference.png' });
      return;
    }
    if (req.method === 'POST' && pathname === '/v1/videos/generations') {
      json(res, 200, { job_id: 'studio_video_1', status: 'queued' });
      return;
    }
    if (req.method === 'GET' && pathname === '/v1/videos/jobs/studio_video_1') {
      state.queryCount += 1;
      json(res, 200, state.queryCount === 1
        ? { job_id: 'studio_video_1', status: 'running', progress: 0.25 }
        : { job_id: 'studio_video_1', status: 'completed', progress: 1 });
      return;
    }
    if (req.method === 'GET' && pathname === '/v1/videos/jobs/studio_video_1/content') {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': MP4.length });
      res.end(MP4);
      return;
    }
    json(res, 404, { error: 'unrecognized local mock route' });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(() => resolve())));
  return { state, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

async function fixture(t) {
  const mock = await mockServer(t);
  // Keep mkdtemp output intact for inspection if a test fails; deliberately no cleanup hook.
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'jingchang-creation-studio-'));
  const activeJobs = new Map();
  const service = creationStudioService({ data, activeJobs, pollInterval: 20 });
  return { ...mock, data, activeJobs, service };
}

async function makeStudio(service, baseUrl, { mode = 'video', name = '本地创作测试', prompt = '晨雾中的乌篷船', config = {}, references = [] } = {}) {
  const created = await service.create({ name, mode });
  return service.save(created.id, {
    ...created,
    revision: created.revision,
    prompt,
    references,
    config: { ...created.config, baseUrl, ...config },
  });
}

function authorization(baseUrl, model, { budget = 100, sendReferences = false } = {}) {
  return { origin: new URL(baseUrl).origin, model, requestLimit: 1, sendPrompt: true, sendReferences, budget, currency: 'CNY' };
}

async function waitForJob(data, id, predicate, timeout = 4000) {
  const end = Date.now() + timeout;
  let latest;
  while (Date.now() < end) {
    latest = await readJson(path.join(data, 'jobs', `${id}.json`)).catch(() => null);
    if (latest && predicate(latest)) return latest;
    await delay(10);
  }
  throw new Error(`等待创作任务状态超时：${JSON.stringify(latest)}`);
}

async function allFilePaths(root) {
  const found = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...await allFilePaths(absolute));
    else found.push(absolute);
  }
  return found;
}

test('项目创建、读取、保存及旧 revision 冲突；配置中的密钥和额外字段不落盘', async t => {
  const { data, service, baseUrl } = await fixture(t);
  const created = await service.create({ name: '从空白开始', mode: 'image' });
  assert.equal(created.revision, 0);
  assert.equal((await service.get(created.id)).name, '从空白开始');

  const saved = await service.save(created.id, {
    ...created,
    revision: 0,
    name: '保存后的项目',
    prompt: '一张水墨江南图',
    config: { ...created.config, baseUrl, apiKey: KEY, secret: KEY, providerExtra: { token: KEY } },
    providerBlob: { authorization: KEY },
  });
  assert.equal(saved.revision, 1);
  assert.equal(saved.name, '保存后的项目');
  await assert.rejects(
    () => service.save(created.id, { ...created, revision: 0, name: '过期写入' }),
    error => error.status === 409,
  );

  const stored = await service.get(created.id);
  assert.equal(stored.config.apiKey, undefined);
  assert.equal(stored.config.secret, undefined);
  assert.equal(stored.providerBlob, undefined);
  for (const file of await allFilePaths(data)) {
    assert.equal((await fs.readFile(file)).includes(Buffer.from(KEY)), false, `凭据出现在 ${file}`);
  }
});

test('生成前拒绝预算或发送授权不匹配的请求，mock 上游没有收到 POST', async t => {
  const { service, baseUrl, state } = await fixture(t);
  const studio = await makeStudio(service, baseUrl, { config: { unitPrice: 3, duration: 5 } });
  const common = { requestId: 'approval_request_1', revision: studio.revision, apiKey: KEY };
  await assert.rejects(() => service.start(studio.id, {
    ...common,
    authorization: authorization(baseUrl, studio.config.model, { budget: 10 }),
  }), /预算小于/);
  await assert.rejects(() => service.start(studio.id, { ...common }), /请确认本次服务/);
  assert.equal(state.requests.length, 0);
  assert.deepEqual(await service.jobs(studio.id), []);
});

test('图片数量 2 和 4 被正确提交并将有效 PNG 保存到本地素材库；并发相同 requestId 只提交一次', async t => {
  const { data, service, baseUrl, state } = await fixture(t);
  for (const count of [2, 4]) {
    const studio = await makeStudio(service, baseUrl, { mode: 'image', config: { model: 'gpt-image-2', count } });
    const requestId = `image_count_${count}`;
    const body = { requestId, revision: studio.revision, apiKey: KEY, authorization: authorization(baseUrl, studio.config.model) };
    const [first, duplicate] = await Promise.all([
      service.start(studio.id, { ...body }),
      service.start(studio.id, { ...body }),
    ]);
    assert.equal(first.id, duplicate.id);
    const job = await waitForJob(data, first.id, value => ['completed', 'failed'].includes(value.status));
    assert.equal(job.status, 'completed', job.message);
    assert.equal(job.assets.length, count);
    assert.equal(job.requestCount, 1);
    assert.equal(job.assets.every(asset => asset.type === 'image/png' && asset.source === 'creation-studio'), true);
    for (const asset of job.assets) assert.deepEqual(await fs.readFile(path.join(data, 'assets', asset.id)), PNG);
    const submissions = state.requests.filter(request => request.pathname === '/v1/images/generations' && request.method === 'POST');
    assert.equal(submissions.length, count === 2 ? 1 : 2);
    const submitted = JSON.parse(submissions.at(-1).bytes.toString('utf8'));
    assert.equal(submitted.n, count);
    assert.equal(submissions.at(-1).authorization, `Bearer ${KEY}`);
  }
  for (const file of await allFilePaths(data)) {
    assert.equal((await fs.readFile(file)).includes(Buffer.from(KEY)), false, `凭据出现在 ${file}`);
  }
});

test('视频参考上传、generation、jobs 查询和 content 下载形成完整本地链路', async t => {
  const { data, service, baseUrl, state } = await fixture(t);
  const reference = await storeAsset(data, PNG, { name: 'local-reference.png', type: 'image/png', source: 'test-fixture' });
  const studio = await makeStudio(service, baseUrl, {
    config: { model: 'seedance-2.0', duration: 4 },
    references: [{ assetId: reference.id }],
  });
  const queued = await service.start(studio.id, {
    requestId: 'video_local_chain', revision: studio.revision, apiKey: KEY,
    authorization: authorization(baseUrl, studio.config.model, { sendReferences: true }),
  });
  const job = await waitForJob(data, queued.id, value => ['completed', 'failed'].includes(value.status));
  assert.equal(job.status, 'completed', job.message);
  assert.equal(job.upstreamId, 'studio_video_1');
  assert.equal(job.assets.length, 1);
  assert.equal(job.assets[0].type, 'video/mp4');
  assert.deepEqual(await fs.readFile(path.join(data, 'assets', job.assets[0].id)), MP4);
  assert.deepEqual(state.requests.map(request => `${request.method} ${request.pathname}`), [
    'POST /v1/videos/uploads',
    'POST /v1/videos/generations',
    'GET /v1/videos/jobs/studio_video_1',
    'GET /v1/videos/jobs/studio_video_1',
    'GET /v1/videos/jobs/studio_video_1/content',
  ]);
  assert.equal(state.requests.every(request => request.authorization === `Bearer ${KEY}`), true);
});

test('停止本机查询后可用原 upstreamId 恢复，恢复不会再次 POST generation', async t => {
  const { data, service, baseUrl, state } = await fixture(t);
  const studio = await makeStudio(service, baseUrl);
  const queued = await service.start(studio.id, {
    requestId: 'video_resume_original', revision: studio.revision, apiKey: KEY,
    authorization: authorization(baseUrl, studio.config.model),
  });
  await waitForJob(data, queued.id, value => value.upstreamId === 'studio_video_1' && value.status === 'running');
  await service.cancel(studio.id, queued.id);
  const stopped = await waitForJob(data, queued.id, value => value.status === 'cancelled');
  assert.equal(stopped.upstreamId, 'studio_video_1');
  assert.equal(stopped.uncertain, true);

  const resumed = await service.resume(studio.id, queued.id, { apiKey: KEY });
  assert.equal(resumed.upstreamId, 'studio_video_1');
  const complete = await waitForJob(data, queued.id, value => ['completed', 'failed'].includes(value.status));
  assert.equal(complete.status, 'completed', complete.message);
  assert.equal(complete.upstreamId, 'studio_video_1');
  assert.equal(state.requests.filter(request => request.method === 'POST' && request.pathname === '/v1/videos/generations').length, 1);
  // Cancellation may race with an in-flight read; extra GETs are safe, repeated POSTs are not.
  assert.ok(state.requests.filter(request => request.method === 'GET' && request.pathname === '/v1/videos/jobs/studio_video_1').length >= 2);
  assert.equal(state.requests.filter(request => request.method === 'GET' && request.pathname.endsWith('/content')).length, 1);
  for (const file of await allFilePaths(data)) {
    assert.equal((await fs.readFile(file)).includes(Buffer.from(KEY)), false, `凭据出现在 ${file}`);
  }
});

test('视频生成遇到多个参考时明确拒绝，不上传任一素材', async t => {
  const { data, service, baseUrl, state } = await fixture(t);
  const first = await storeAsset(data, PNG, { name: 'reference-a.png', type: 'image/png', source: 'test-fixture' });
  const second = await storeAsset(data, PNG, { name: 'reference-b.png', type: 'image/png', source: 'test-fixture' });
  const studio = await makeStudio(service, baseUrl, { references: [{ assetId: first.id }, { assetId: second.id }] });
  await assert.rejects(() => service.start(studio.id, {
    requestId: 'reject_unverified_multi_reference', revision: studio.revision, apiKey: KEY,
    authorization: authorization(baseUrl, studio.config.model, { sendReferences: true }),
  }), /多参考生成的字段契约尚未核实/);
  assert.equal(state.requests.length, 0);
  assert.deepEqual(await service.jobs(studio.id), []);
});



test('图片任务不误用视频取消接口', async t => {
  const { data, service, baseUrl, state } = await fixture(t);
  const studio = await makeStudio(service, baseUrl, {mode:'image'});
  const job = await service.start(studio.id, {revision:studio.revision, requestId:'cancel-image-guard', apiKey:KEY, authorization:authorization(baseUrl,studio.config.model)});
  await waitForJob(data, job.id, j => j.status === 'completed');
  const count = state.requests.length;
  await assert.rejects(service.cancel(studio.id, job.id, {cancelUpstream:true,apiKey:KEY}), /仅支持停止本机查询/);
  assert.equal(state.requests.length,count);
});
