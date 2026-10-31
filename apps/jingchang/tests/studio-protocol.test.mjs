import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  cancelVideo,
  downloadVideo,
  generateStudioImages,
  queryVideo,
  queryImageTask,
  submitVideo,
  submitImageTask,
  uploadReference,
} from '../lib/studio-protocol.mjs';

const KEY = 'studio-mock-secret';
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const VIDEO = Buffer.from('mock-video-content');

function json(res, status, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': bytes.length });
  res.end(bytes);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function mockServer(t, { mode = 'normal' } = {}) {
  const state = { requests: [], mode, imageTaskPolls: 0 };
  const server = http.createServer(async (req, res) => {
    const bytes = await readBody(req);
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    state.requests.push({ method: req.method, path, auth: req.headers.authorization, contentType: req.headers['content-type'] || '', bytes });
    if (state.mode === 'uncertain' && req.method === 'POST') {
      req.socket.destroy();
      return;
    }
    if (req.method === 'POST' && path === '/v1/videos/uploads') {
      json(res, 200, { media_url: 'https://media.example.test/uploaded' });
      return;
    }
    if (req.method === 'POST' && path === '/v1/images/generations/async') {
      json(res, 200, { task_id: 'image_task_1', status: 'queued', poll_url: 'http://169.254.169.254/latest/meta-data' });
      return;
    }
    if (req.method === 'GET' && path === '/v1/images/tasks/image_task_1') {
      state.imageTaskPolls += 1;
      json(res, 200, state.imageTaskPolls === 1
        ? { task_id: 'image_task_1', status: 'running', poll_url: 'http://169.254.169.254/ignore-this' }
        : { task_id: 'image_task_1', status: 'succeeded', data: [{ b64_json: PNG.toString('base64') }] });
      return;
    }
    if (req.method === 'POST' && ['/v1/videos/generations', '/v1/videos/edits', '/v1/videos/extensions'].includes(path)) {
      json(res, 200, { job_id: path.endsWith('generations') ? 'gen_1' : path.endsWith('edits') ? 'edit_1' : 'extend_1', status: 'queued' });
      return;
    }
    if (req.method === 'GET' && path === '/v1/videos/jobs/job_1') {
      json(res, 200, { id: 'job_1', status: 'running', progress: 0.42 });
      return;
    }
    if (req.method === 'DELETE' && path === '/v1/videos/jobs/job_1') {
      json(res, 200, { id: 'job_1', status: 'cancelled' });
      return;
    }
    if (req.method === 'GET' && path === '/v1/videos/jobs/job_1/content') {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': VIDEO.length });
      res.end(VIDEO);
      return;
    }
    if (req.method === 'POST' && path === '/v1/images/generations') {
      json(res, 200, { data: [{ b64_json: PNG.toString('base64') }, { b64_json: PNG.toString('base64') }], usage: { total_tokens: 12, echoed: KEY } });
      return;
    }
    if (req.method === 'POST' && path === '/v1/images/edits') {
      json(res, 200, { data: [{ b64_json: PNG.toString('base64') }] });
      return;
    }
    if (path === '/v1/videos/jobs/job_fail') {
      json(res, 200, { id: 'job_fail', status: 'failed', error: `upstream leaked ${KEY}` });
      return;
    }
    if (path === '/v1/videos/jobs/a%2Fb') {
      json(res, 200, { status: 'running' });
      return;
    }
    json(res, 404, { error: `unknown ${KEY}` });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(() => resolve())));
  return { state, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

function videoStudio(operation = 'generate') {
  return {
    mode: 'video',
    prompt: '江南薄雾中的乌篷船',
    config: { model: 'video-model', operation, resolution: '720p', ratio: '16:9', duration: 5, generateAudio: true },
  };
}

test('上传参考媒体使用文档字段，并覆盖视频生成、编辑、续写请求体', async t => {
  const mock = await mockServer(t);
  const url = await uploadReference({ baseUrl: mock.baseUrl, apiKey: KEY, reference: { bytes: PNG, mime: 'image/png', name: 'ref.png' } });
  assert.equal(url, 'https://media.example.test/uploaded');
  const upload = mock.state.requests[0];
  assert.equal(upload.path, '/v1/videos/uploads');
  assert.match(upload.contentType, /^multipart\/form-data; boundary=/);
  assert.match(upload.bytes.toString(), /name="image"/);
  assert.equal(upload.auth, `Bearer ${KEY}`);

  const imageRef = [{ url, type: 'image/png' }];
  assert.deepEqual(await submitVideo({ baseUrl: mock.baseUrl, apiKey: KEY, studio: videoStudio(), references: imageRef }), { upstreamId: 'gen_1', status: 'queued' });
  const gen = mock.state.requests[1];
  assert.equal(gen.path, '/v1/videos/generations');
  assert.deepEqual(JSON.parse(gen.bytes), {
    model: 'video-model', prompt: '江南薄雾中的乌篷船', resolution: '720p', duration: 5,
    aspect_ratio: '16:9', audio: true, image_url: url,
  });

  const videoRef = [{ url: 'https://media.example.test/clip.mp4', type: 'video/mp4' }];
  assert.equal((await submitVideo({ baseUrl: mock.baseUrl, apiKey: KEY, studio: videoStudio('edit'), references: videoRef })).upstreamId, 'edit_1');
  const edit = JSON.parse(mock.state.requests[2].bytes);
  assert.equal(mock.state.requests[2].path, '/v1/videos/edits');
  assert.deepEqual(edit, { model: 'video-model', prompt: '江南薄雾中的乌篷船', video: { url: videoRef[0].url }, duration: 5 });

  assert.equal((await submitVideo({ baseUrl: mock.baseUrl, apiKey: KEY, studio: videoStudio('extend'), references: videoRef })).upstreamId, 'extend_1');
  assert.equal(mock.state.requests[3].path, '/v1/videos/extensions');
  assert.equal(mock.state.requests.every(request => request.auth === `Bearer ${KEY}`), true);
});

test('查询状态、下载视频、显式取消，并隐藏上游失败细节', async t => {
  const mock = await mockServer(t);
  assert.deepEqual(await queryVideo({ baseUrl: mock.baseUrl, apiKey: KEY, upstreamId: 'job_1' }), { status: 'running', progress: 42 });
  const downloaded = await downloadVideo({ baseUrl: mock.baseUrl, apiKey: KEY, upstreamId: 'job_1' });
  assert.deepEqual(downloaded, { bytes: VIDEO, mime: 'video/mp4' });
  assert.deepEqual(await cancelVideo({ baseUrl: mock.baseUrl, apiKey: KEY, upstreamId: 'job_1' }), { status: 'cancelled' });
  const failed = await queryVideo({ baseUrl: mock.baseUrl, apiKey: KEY, upstreamId: 'job_fail' });
  assert.deepEqual(failed, { status: 'failed', message: '上游视频任务失败。' });
  assert.equal(JSON.stringify(failed).includes(KEY), false);
  await assert.rejects(() => queryVideo({ baseUrl: mock.baseUrl, apiKey: KEY, upstreamId: '../job_1' }), error => error.code === 'invalid_upstream_id');
  assert.equal(mock.state.requests.some(request => request.path.includes('..')), false);
});

test('图片生成参数、2 张结果解析和多图编辑 multipart 字段正确', async t => {
  const mock = await mockServer(t);
  const generated = await generateStudioImages({
    baseUrl: mock.baseUrl, apiKey: KEY,
    studio: { prompt: '水墨山水', config: { model: 'image-model', size: '1024x1024', quality: 'high', count: 2, transparent: true } },
  });
  assert.equal(generated.images.length, 2);
  assert.deepEqual(generated.usage, { total_tokens: 12 });
  assert.equal(JSON.stringify(generated).includes(KEY), false);
  const gen = mock.state.requests[0];
  assert.equal(gen.path, '/v1/images/generations');
  assert.deepEqual(JSON.parse(gen.bytes), {
    model: 'image-model', prompt: '水墨山水', size: '1024x1024', quality: 'high', n: 2, background: 'transparent',
  });

  const edited = await generateStudioImages({
    baseUrl: mock.baseUrl, apiKey: KEY,
    studio: { prompt: '将参考图改为蓝调', config: { model: 'image-model', count: 1 } },
    references: [
      { bytes: PNG, mime: 'image/png', name: 'a.png' },
      { bytes: PNG, mime: 'image/png', name: 'b.png' },
    ],
  });
  assert.equal(edited.images.length, 1);
  const edit = mock.state.requests[1];
  assert.equal(edit.path, '/v1/images/edits');
  assert.match(edit.contentType, /^multipart\/form-data; boundary=/);
  const multipart = edit.bytes.toString();
  assert.equal((multipart.match(/name="image\[\]"/g) || []).length, 2);
  for (const field of ['name="model"', 'name="prompt"', 'name="size"', 'name="quality"', 'name="n"', 'name="background"']) assert.ok(multipart.includes(field));
});

test('明确拒绝无证据支持的参考类型、格式与路径参数', async t => {
  const mock = await mockServer(t);
  await assert.rejects(() => submitVideo({
    baseUrl: mock.baseUrl, apiKey: KEY, studio: videoStudio(),
    references: [{ url: 'https://media.example.test/a', type: 'image' }, { url: 'https://media.example.test/b', type: 'image' }],
  }), /暂只支持一张图片参考/);
  await assert.rejects(() => submitVideo({
    baseUrl: mock.baseUrl, apiKey: KEY, studio: videoStudio(), references: [{ url: 'https://media.example.test/a', type: 'audio' }],
  }), /暂只支持一张图片参考/);
  await assert.rejects(() => generateStudioImages({
    baseUrl: mock.baseUrl, apiKey: KEY, studio: { prompt: 'test', config: { model: 'image-model', count: 3 } },
  }), /只能是 1、2 或 4/);
  await assert.rejects(() => uploadReference({ baseUrl: mock.baseUrl, apiKey: KEY, reference: { bytes: PNG, mime: 'image/gif', name: 'bad.gif' } }), /格式或大小无效/);
  assert.equal(mock.state.requests.length, 0);
});

test('提交连接中断时保留 uncertain 结果，错误和公开结果不回显 Key', async t => {
  const mock = await mockServer(t, { mode: 'uncertain' });
  await assert.rejects(() => submitVideo({ baseUrl: mock.baseUrl, apiKey: KEY, studio: videoStudio() }), error => {
    assert.equal(error.uncertain, true);
    assert.equal(String(error.message).includes(KEY), false);
    assert.equal(String(error.message).includes('upstream'), false);
    return true;
  });
  assert.equal(mock.state.requests[0].auth, `Bearer ${KEY}`);
});

test('图片异步任务只提交已核实字段，并按固定任务路径轮询解析结果', async t => {
  const mock = await mockServer(t);
  const studio = {
    mode: 'image', prompt: '淡墨山水',
    config: { imageAsync: true, model: 'image-model', size: '1024x1024', quality: 'auto', count: 1, transparent: false },
  };
  const submitted = await submitImageTask({ baseUrl: mock.baseUrl, apiKey: '', studio });
  assert.deepEqual(submitted, { upstreamId: 'image_task_1', status: 'queued' });
  assert.deepEqual(JSON.parse(mock.state.requests[0].bytes), { model: 'image-model', prompt: '淡墨山水', size: '1024x1024' });
  assert.equal(mock.state.requests[0].auth, undefined);
  assert.deepEqual(await queryImageTask({ baseUrl: mock.baseUrl, apiKey: '', upstreamId: submitted.upstreamId }), { status: 'running' });
  const completed = await queryImageTask({ baseUrl: mock.baseUrl, apiKey: '', upstreamId: submitted.upstreamId });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.images.length, 1);
  assert.deepEqual(mock.state.requests.map(request => request.path), [
    '/v1/images/generations/async', '/v1/images/tasks/image_task_1', '/v1/images/tasks/image_task_1',
  ]);
  assert.equal(mock.state.requests.some(request => request.path.includes('169.254.169.254')), false);

  await assert.rejects(() => submitImageTask({ baseUrl: mock.baseUrl, apiKey: '', studio: { ...studio, config: { ...studio.config, count: 2 } } }), /只支持单张/);
  await assert.rejects(() => submitImageTask({ baseUrl: mock.baseUrl, apiKey: '', studio, references: [{ bytes: PNG, mime: 'image/png' }] }), /纯文字输入/);
  await assert.rejects(() => submitImageTask({ baseUrl: mock.baseUrl, apiKey: '', studio: { ...studio, config: { ...studio.config, transparent: true } } }), /只支持单张/);
  assert.equal(mock.state.requests.length, 3);
});
