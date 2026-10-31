import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { generationService } from '../lib/generation.mjs';
import { readJson, storeAsset, atomicJson } from '../lib/workspace.mjs';

const servers = new Set();

function readRequest(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function jsonResponse(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
  });
  res.end(body);
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

/**
 * A local-only ComfyUI HTTP double. It implements only the three endpoints
 * used by generationService and records the exact submitted prompt graphs.
 */
async function startMockComfy({ mode = 'completed' } = {}) {
  const state = {
    mode,
    complete: false,
    submitted: [],
    uploaded: [],
    downloaded: [],
    payloads: new Map(),
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'POST' && url.pathname === '/upload/image') {
        const form = await new Response(await readRequest(req), { headers: { 'content-type': req.headers['content-type'] } }).formData();
        state.uploaded.push({ name: form.get('image').name, type: form.get('type'), overwrite: form.get('overwrite'), bytes: Buffer.from(await form.get('image').arrayBuffer()) });
        jsonResponse(res, 200, { name: `uploaded-${state.uploaded.length}.png`, subfolder: state.mode === 'unsafe-upload' ? '../outside' : 'reference', type: 'input' });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/prompt') {
        const payload = JSON.parse((await readRequest(req)).toString('utf8'));
        const promptId = `prompt-${state.submitted.length + 1}`;
        state.submitted.push({ promptId, payload, prompt: payload.prompt });
        jsonResponse(res, 200, { prompt_id: promptId });
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/history/')) {
        const promptId = decodeURIComponent(url.pathname.slice('/history/'.length));
        if (!state.submitted.some(item => item.promptId === promptId)) {
          jsonResponse(res, 200, {});
          return;
        }
        if (state.mode === 'pending-until-complete' && !state.complete) {
          jsonResponse(res, 200, {});
          return;
        }
        if (state.mode === 'failure') {
          jsonResponse(res, 200, {
            [promptId]: {
              status: { status_str: 'error', messages: [['execution_error', 'mock failure']] },
              outputs: {},
            },
          });
          return;
        }
        const filename = `generated-${promptId}.png`;
        state.payloads.set(filename, Buffer.from(`mock-image:${promptId}`));
        jsonResponse(res, 200, {
          [promptId]: {
            status: { status_str: 'success', completed: true },
            outputs: {
              '4': { images: [{ filename, subfolder: '', type: 'output' }] },
            },
          },
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/view') {
        const filename = url.searchParams.get('filename');
        const bytes = state.payloads.get(filename);
        if (!bytes) {
          res.writeHead(404);
          res.end('missing mock output');
          return;
        }
        state.downloaded.push({
          filename,
          subfolder: url.searchParams.get('subfolder'),
          type: url.searchParams.get('type'),
        });
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Length': bytes.length,
        });
        res.end(bytes);
        return;
      }
      jsonResponse(res, 404, { error: 'unknown mock route' });
    } catch (error) {
      jsonResponse(res, 500, { error: error.message });
    }
  });
  servers.add(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    server,
    state,
    endpoint: `http://127.0.0.1:${address.port}`,
  };
}

async function makeContext() {
  // Keep generated fixtures outside the project tree; the test deliberately
  // leaves this unique temporary directory intact and touches no user data.
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'jingchang-generation-'));
  const activeJobs = new Map();
  return {
    data,
    activeJobs,
    generation: generationService({ data, activeJobs }),
    project: { id: 'project-generation-test', revision: 3, nodes: [] },
  };
}

async function jobRecord(data, id) {
  try {
    return await readJson(path.join(data, 'jobs', `${id}.json`));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function waitFor(read, { timeout = 5000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() <= deadline) {
    last = await read();
    if (last) return last;
    await delay(interval);
  }
  throw new Error(`等待本地 mock 生成状态超时；最后值：${JSON.stringify(last)}`);
}

async function waitForStatus(data, id, status) {
  return waitFor(async () => {
    const job = await jobRecord(data, id);
    return job?.status === status ? job : null;
  });
}

const apiWorkflow = {
  prompt: {
    '3': {
      class_type: 'KSampler',
      _meta: { title: '采样器' },
      inputs: {
        seed: 42,
        steps: 20,
        cfg: 7.5,
        denoise: true,
        positive: ['1', 0],
      },
    },
    '4': {
      class_type: 'SaveImage',
      inputs: { filename_prefix: 'jingchang', images: ['3', 0] },
    },
  },
};

test('generationService 导入 API 工作流、覆盖标量、批次递增 seed 并保存图片资产', async t => {
  const mock = await startMockComfy();
  t.after(() => closeServer(mock.server));
  const { data, generation, project } = await makeContext();

  const template = await generation.saveTemplate({ name: '本地批量图', workflow: apiWorkflow });
  assert.equal(template.inspection.nodeCount, 2);
  assert.equal(template.workflow['3'].inputs.seed, 42);
  assert.equal(template.workflow['3'].inputs.steps, 20);
  assert.equal((await generation.template(template.id)).workflow['4'].class_type, 'SaveImage');

  const started = await generation.start(project, {
    workflowId: template.id,
    count: 2,
    incrementSeeds: true,
    overrides: [
      { nodeId: '3', name: 'steps', value: 24 },
      { nodeId: '3', name: 'denoise', value: false },
      { nodeId: '4', name: 'filename_prefix', value: 'batch' },
    ],
  }, mock.endpoint);
  const completed = await waitForStatus(data, started.id, 'completed');

  assert.equal(completed.progress, 100);
  assert.equal(completed.items.length, 2);
  assert.ok(completed.items.every(item => item.status === 'completed'));
  assert.equal(completed.assets.length, 2);
  assert.deepEqual(mock.state.submitted.map(item => item.prompt['3'].inputs.seed), [42, 43]);
  assert.deepEqual(mock.state.submitted.map(item => item.prompt['3'].inputs.steps), [24, 24]);
  assert.deepEqual(mock.state.submitted.map(item => item.prompt['3'].inputs.denoise), [false, false]);
  assert.deepEqual(mock.state.submitted.map(item => item.prompt['4'].inputs.filename_prefix), ['batch', 'batch']);
  assert.equal(mock.state.downloaded.length, 2);
  assert.ok(mock.state.downloaded.every(item => item.type === 'output'));

  for (const asset of completed.assets) {
    assert.equal(asset.type, 'image/png');
    assert.equal(asset.source, 'comfy');
    assert.deepEqual(
      await fs.readFile(path.join(data, 'assets', asset.id)),
      mock.state.payloads.get(asset.name),
    );
    assert.deepEqual(await readJson(path.join(data, 'assets', `${asset.id}.json`)), asset);
  }
  // Overrides and seed increments operate on per-submission clones.
  assert.equal(template.workflow['3'].inputs.steps, 20);
  assert.equal(template.workflow['3'].inputs.denoise, true);
});

test('generationService 拒绝布局 JSON、凭据字段和标量类型错误', async t => {
  const mock = await startMockComfy();
  t.after(() => closeServer(mock.server));
  const { generation, project } = await makeContext();

  await assert.rejects(
    generation.saveTemplate({ name: '布局文件', workflow: { nodes: [], links: [] } }),
    /API 格式 JSON/,
  );
  await assert.rejects(
    generation.saveTemplate({
      name: '带密钥',
      workflow: { '1': { class_type: 'Load', inputs: { api_key: 'secret-value' } } },
    }),
    /含密钥字段/,
  );

  const template = await generation.saveTemplate({ name: '合法模板', workflow: apiWorkflow });
  await assert.rejects(
    generation.start(project, {
      workflowId: template.id,
      overrides: [{ nodeId: '3', name: 'steps', value: '24' }],
    }, mock.endpoint),
    /类型不匹配/,
  );
  await assert.rejects(
    generation.start(project, {
      workflowId: template.id,
      overrides: [{ nodeId: '3', name: 'missing_input', value: 24 }],
    }, mock.endpoint),
    /参数不存在/,
  );
  assert.equal(mock.state.submitted.length, 0);
});

test('取消后恢复只查询已有 prompt_id，重复启动不会重复提交', async t => {
  const mock = await startMockComfy({ mode: 'pending-until-complete' });
  t.after(() => closeServer(mock.server));
  const { data, activeJobs, generation, project } = await makeContext();
  const template = await generation.saveTemplate({ name: '可恢复任务', workflow: apiWorkflow });
  const body = { workflowId: template.id, overrides: [], count: 1 };
  const started = await generation.start(project, body, mock.endpoint);

  const submitted = await waitFor(async () => {
    const job = await jobRecord(data, started.id);
    return job?.items?.[0]?.promptId ? job : null;
  });
  assert.equal(mock.state.submitted.length, 1);
  await assert.rejects(
    generation.start(project, body, mock.endpoint),
    error => error.status === 409 && /已有生成任务/.test(error.message),
  );

  const running = activeJobs.get(started.id);
  assert.ok(running?.controller, '生成任务应暴露可取消的 AbortController');
  running.controller.abort();
  const cancelled = await waitForStatus(data, started.id, 'cancelled');
  assert.equal(cancelled.items[0].promptId, submitted.items[0].promptId);
  assert.equal(cancelled.items[0].status, 'pending');

  mock.state.complete = true;
  await generation.resume(started.id);
  assert.equal(mock.state.submitted.length, 1, '恢复前后只能有一次 /prompt 提交');
  const completed = await waitForStatus(data, started.id, 'completed');
  assert.equal(completed.items[0].promptId, cancelled.items[0].promptId);
  assert.equal(completed.assets.length, 1);
  assert.equal(mock.state.submitted.length, 1);
});

test('ComfyUI 输出失败会持久化 failed 状态且不保存资产', async t => {
  const mock = await startMockComfy({ mode: 'failure' });
  t.after(() => closeServer(mock.server));
  const { data, generation, project } = await makeContext();
  const template = await generation.saveTemplate({ name: '失败任务', workflow: apiWorkflow });

  const started = await generation.start(project, {
    workflowId: template.id,
    overrides: [],
  }, mock.endpoint);
  const failed = await waitForStatus(data, started.id, 'failed');

  assert.equal(mock.state.submitted.length, 1);
  assert.equal(failed.items[0].status, 'failed');
  assert.equal(failed.assets.length, 0);
  assert.match(failed.message, /ComfyUI 执行失败/);
});

const INPUT_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
async function imageContext() {
  const context = await makeContext();
  const asset = await storeAsset(context.data, INPUT_PNG, { name: '项目输入.png', type: 'image/png' });
  context.project.assets = [asset];
  const template = await context.generation.saveTemplate({ name: '图片绑定', workflow: {
    ...apiWorkflow.prompt,
    '10': { class_type: 'LoadImage', inputs: { image: 'original.png' } },
    '11': { class_type: 'LoadImageMask', inputs: { image: 'original.png', channel: 'alpha' } },
  } });
  return { ...context, asset, template, body: { workflowId: template.id, overrides: [], imageBindings: [{ nodeId: '10', name: 'image', assetId: asset.id }, { nodeId: '11', name: 'image', assetId: asset.id }] } };
}

test('image bindings upload once per asset before all batches and persist reusable mapping', async t => {
  const mock = await startMockComfy();
  t.after(() => closeServer(mock.server));
  const { data, generation, project, body, asset, template } = await imageContext();
  const started = await generation.start(project, { ...body, count: 2 }, mock.endpoint);
  const completed = await waitForStatus(data, started.id, 'completed');
  assert.equal(mock.state.uploaded.length, 1);
  assert.deepEqual(mock.state.uploaded[0].bytes, INPUT_PNG);
  assert.equal(mock.state.uploaded[0].overwrite, 'false');
  assert.equal(mock.state.submitted.length, 2);
  for (const submitted of mock.state.submitted) {
    assert.equal(submitted.prompt['10'].inputs.image, 'reference/uploaded-1.png');
    assert.equal(submitted.prompt['11'].inputs.image, 'reference/uploaded-1.png');
  }
  assert.equal(completed.inputPrepared, true);
  assert.equal(completed.inputMappings.length, 2);
  assert.equal(completed.inputMappings[0].assetId, asset.id);
  assert.equal(completed.inputMappings[0].name, 'image');
  assert.equal(template.workflow['10'].inputs.image, 'original.png');
});

test('image binding resume never reuploads or resubmits the original prompt', async t => {
  const mock = await startMockComfy({ mode: 'pending-until-complete' });
  t.after(() => closeServer(mock.server));
  const { data, activeJobs, generation, project, body } = await imageContext();
  const started = await generation.start(project, body, mock.endpoint);
  await waitFor(async () => (await jobRecord(data, started.id))?.items?.[0]?.promptId);
  activeJobs.get(started.id).controller.abort();
  await waitForStatus(data, started.id, 'cancelled');
  mock.state.complete = true;
  const restored = generationService({ data, activeJobs: new Map() });
  await restored.resume(started.id);
  const completed = await waitForStatus(data, started.id, 'completed');
  assert.equal(completed.inputPrepared, true);
  assert.equal(mock.state.uploaded.length, 1);
  assert.equal(mock.state.submitted.length, 1);
});

test('all bindings are preflighted before any upload including project ownership and content', async t => {
  const mock = await startMockComfy();
  t.after(() => closeServer(mock.server));
  const { data, generation, project, body, asset } = await imageContext();
  const outsider = await storeAsset(data, INPUT_PNG, { name: '其他项目.png', type: 'image/png' });
  const bad = await storeAsset(data, Buffer.from('fake png'), { name: '伪装.png', type: 'image/png' });
  project.assets.push(bad);
  const first = body.imageBindings[0], second = body.imageBindings[1];
  for (const binding of [{ ...second, assetId: outsider.id }, { ...second, assetId: bad.id }, { ...second, assetId: '../outside' }, { ...second, nodeId: '4' }, { ...second, name: 'channel' }, first]) {
    await assert.rejects(generation.start(project, { ...body, imageBindings: [first, binding] }, mock.endpoint));
  }
  await assert.rejects(generation.start(project, { ...body, overrides: [{ nodeId: '10', name: 'image', value: 'manual.png' }] }, mock.endpoint), /重复|覆盖/);
  const metaFile = path.join(data, 'assets', `${asset.id}.json`);
  await atomicJson(metaFile, { ...asset, size: asset.size + 1 });
  await assert.rejects(generation.start(project, body, mock.endpoint), /素材记录/);
  assert.equal(mock.state.uploaded.length, 0);
  assert.equal(mock.state.submitted.length, 0);
});

test('unsafe upload response fails without prompt submission and cannot be automatically resumed', async t => {
  const mock = await startMockComfy({ mode: 'unsafe-upload' });
  t.after(() => closeServer(mock.server));
  const { data, generation, project, body } = await imageContext();
  const started = await generation.start(project, body, mock.endpoint);
  const failed = await waitForStatus(data, started.id, 'failed');
  assert.equal(failed.inputPrepared, false);
  assert.equal(mock.state.uploaded.length, 1);
  assert.equal(mock.state.submitted.length, 0);
  await assert.rejects(generation.resume(started.id), /不支持/);
});
