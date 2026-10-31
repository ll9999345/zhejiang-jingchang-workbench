import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  DEFAULT_LOCAL_ENDPOINT,
  LocalProviderError,
  downloadOutput,
  inspectWorkflow,
  queryWorkflow,
  submitWorkflow,
  validateLocalEndpoint,
  uploadInputImage,
} from '../lib/providers.mjs';

const servers = new Set();

function startMock(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    servers.add(server);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, endpoint: `http://127.0.0.1:${address.port}` });
    });
  });
}

afterEach(async () => {
  await Promise.all([...servers].map(server => new Promise(resolve => server.close(resolve))));
  servers.clear();
});

const workflow = {
  '3': {
    class_type: 'KSampler',
    _meta: { title: '采样器' },
    inputs: {
      seed: 42,
      steps: 20,
      cfg: 7.5,
      denoise: true,
      sampler_name: 'euler',
      model: ['4', 0],
      positive: ['5', 0],
    },
  },
  '4': {
    class_type: 'SaveImage',
    inputs: { filename_prefix: 'jingchang', images: ['3', 0] },
  },
};

test('validateLocalEndpoint 只接受本机 loopback，并拒绝凭据与查询参数', () => {
  assert.equal(validateLocalEndpoint(DEFAULT_LOCAL_ENDPOINT).hostname, '127.0.0.1');
  assert.equal(validateLocalEndpoint('http://[::1]:8188').hostname, '[::1]');
  assert.throws(() => validateLocalEndpoint('https://example.com:8188'), /loopback/);
  assert.throws(() => validateLocalEndpoint('http://127.0.0.1:8188/?token=secret'), /查询参数/);
  assert.throws(() => validateLocalEndpoint('http://user:pass@127.0.0.1:8188'), /用户名或密码/);
});

test('inspectWorkflow 列出节点与可编辑标量，排除边数组', () => {
  const result = inspectWorkflow(workflow);
  assert.equal(result.nodeCount, 2);
  assert.deepEqual(result.nodes[0], {
    id: '3',
    class_type: 'KSampler',
    title: '采样器',
    inputs: [
      { name: 'seed', type: 'number', value: 42 },
      { name: 'steps', type: 'number', value: 20 },
      { name: 'cfg', type: 'number', value: 7.5 },
      { name: 'denoise', type: 'boolean', value: true },
      { name: 'sampler_name', type: 'string', value: 'euler' },
    ],
  });
  assert.throws(() => inspectWorkflow({ '1': { class_type: 'Broken', inputs: null } }), /格式无效/);
});

test('submitWorkflow 发出正确的 ComfyUI API 请求并返回 prompt_id', async () => {
  let request;
  const mock = await startMock(async (req, res) => {
    request = { method: req.method, path: req.url, body: JSON.parse(await new Promise((resolve, reject) => {
      let text = '';
      req.on('data', chunk => { text += chunk; });
      req.on('end', () => resolve(text));
      req.on('error', reject);
    })) };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ prompt_id: '11111111-1111-4111-8111-111111111111', number: 2, node_errors: {} }));
  });
  const result = await submitWorkflow(mock.endpoint, workflow, { clientId: 'local-test-client' });
  assert.equal(result.promptId, '11111111-1111-4111-8111-111111111111');
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/prompt');
  assert.deepEqual(request.body.prompt, workflow);
  assert.equal(request.body.client_id, 'local-test-client');
});

test('queryWorkflow 识别 pending、completed、failed 并规范化图片视频音频输出', async () => {
  const promptId = '22222222-2222-4222-8222-222222222222';
  let mode = 'pending';
  const mock = await startMock(async (req, res) => {
    assert.equal(req.url, `/history/${promptId}`);
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'pending') return res.end('{}');
    if (mode === 'failed') return res.end(JSON.stringify({ [promptId]: { status: { status_str: 'error', messages: [['execution_error', { node_id: '3' }]] }, outputs: {} } }));
    return res.end(JSON.stringify({ [promptId]: {
      status: { status_str: 'success', completed: true },
      outputs: {
        '4': { images: [{ filename: 'frame.png', subfolder: 'demo', type: 'output' }] },
        '5': { videos: [{ filename: 'clip.mp4', subfolder: '', type: 'output' }] },
        '6': { audio: [{ filename: 'voice.wav', subfolder: 'voice', type: 'output' }] },
      },
    } }));
  });
  assert.equal((await queryWorkflow(mock.endpoint, promptId)).status, 'pending');
  mode = 'completed';
  const completed = await queryWorkflow(mock.endpoint, promptId);
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.outputs.map(item => item.kind), ['image', 'video', 'audio']);
  assert.equal(completed.outputs[0].view.filename, 'frame.png');
  mode = 'failed';
  const failed = await queryWorkflow(mock.endpoint, promptId);
  assert.equal(failed.status, 'failed');
  assert.match(String(failed.error), /execution_error/);
});

test('downloadOutput 使用 /view 参数并支持回调流式接收或返回 bytes', async () => {
  let query;
  const payload = Buffer.from('local-comfy-output');
  const mock = await startMock((req, res) => {
    query = new URL(req.url, 'http://127.0.0.1').searchParams;
    res.writeHead(200, { 'Content-Type': 'video/mp4' });
    res.end(payload);
  });
  const chunks = [];
  const streamed = await downloadOutput(mock.endpoint, {
    filename: 'clip.mp4', subfolder: 'take one', type: 'output', kind: 'video',
  }, { onChunk: chunk => chunks.push(chunk) });
  assert.equal(streamed.fileName, 'clip.mp4');
  assert.equal(streamed.mime, 'video/mp4');
  assert.equal(streamed.bytes, undefined);
  assert.deepEqual(Buffer.concat(chunks), payload);
  assert.equal(query.get('filename'), 'clip.mp4');
  assert.equal(query.get('subfolder'), 'take one');
  assert.equal(query.get('type'), 'output');
  const buffered = await downloadOutput(mock.endpoint, { filename: 'clip.mp4', kind: 'video' });
  assert.deepEqual(buffered.bytes, payload);
});

test('fetch 发生重定向时被拒绝', async () => {
  const mock = await startMock((req, res) => {
    res.writeHead(302, { Location: 'http://example.com/prompt' });
    res.end();
  });
  await assert.rejects(submitWorkflow(mock.endpoint, workflow), error => {
    assert.ok(error instanceof LocalProviderError);
    return /重定向|请求失败/.test(error.message);
  });
});

const INPUT_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
test('uploadInputImage sends actual multipart bytes with input type and no overwrite', async () => {
  let received;
  const mock = await startMock(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': req.headers['content-type'] } }).formData();
    received = { path: req.url, method: req.method, type: form.get('type'), overwrite: form.get('overwrite'), image: form.get('image') };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ name: 'input (1).png', subfolder: 'project/reference', type: 'input' }));
  });
  assert.deepEqual(await uploadInputImage(mock.endpoint, { bytes: INPUT_PNG, mime: 'image/png', name: 'input.png' }), { name: 'input (1).png', subfolder: 'project/reference', type: 'input' });
  assert.equal(received.path, '/upload/image');
  assert.equal(received.method, 'POST');
  assert.equal(received.type, 'input');
  assert.equal(received.overwrite, 'false');
  assert.equal(received.image.name, 'input.png');
  assert.equal(received.image.type, 'image/png');
  assert.deepEqual(Buffer.from(await received.image.arrayBuffer()), INPUT_PNG);
});

test('uploadInputImage rejects unsupported content before network and unsafe response paths', async () => {
  let requests = 0, result = { name: 'result.png', subfolder: '', type: 'input' };
  const mock = await startMock(async (req, res) => {
    for await (const chunk of req) void chunk;
    requests++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  });
  const image = { bytes: INPUT_PNG, mime: 'image/png', name: 'input.png' };
  for (const invalid of [{ name: '../input.png' }, { name: 'image [output].png' }, { name: 'x%2finput.png' }, { mime: '__proto__' }, { mime: 'image/gif' }, { bytes: Buffer.from('not png') }, { bytes: Buffer.alloc(10 * 1024 * 1024 + 1) }]) {
    await assert.rejects(uploadInputImage(mock.endpoint, { ...image, ...invalid }), /图片/);
  }
  await assert.rejects(uploadInputImage('http://192.168.1.2:8188', image), /loopback/);
  assert.equal(requests, 0);
  for (const invalid of [{ name: '../result.png' }, { subfolder: '../outside' }, { subfolder: '/absolute' }, { subfolder: 'a//b' }, { subfolder: 'a\\b' }, { subfolder: 'a/%2e%2e' }, { name: 'x [output].png' }, { type: 'output' }]) {
    result = { name: 'result.png', subfolder: '', type: 'input', ...invalid };
    await assert.rejects(uploadInputImage(mock.endpoint, image), /不安全/);
  }
  const redirect = await startMock((req, res) => { req.resume(); res.writeHead(302, { Location: `${mock.endpoint}/upload/image` }); res.end(); });
  const before = requests;
  await assert.rejects(uploadInputImage(redirect.endpoint, image), /重定向|请求失败/);
  assert.equal(requests, before, 'upload redirects must never be followed');
});
