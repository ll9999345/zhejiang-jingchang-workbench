import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  ImageApiError,
  generateImage,
  listImageModels,
  validateApiBaseUrl,
} from '../lib/image-api.mjs';

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

function readRequest(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res, status, value, contentType = 'application/json') {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': body.length });
  res.end(body);
}

const tinyPng = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const tinyJpeg = Buffer.from('ffd8ffe00000ffd9', 'hex');
const tinyWebp = Buffer.from('524946460000000057454250', 'hex');

afterEach(async () => {
  await Promise.all([...servers].map(server => new Promise(resolve => server.close(resolve))));
  servers.clear();
});

test('validateApiBaseUrl 只允许 HTTPS 公网或明确 loopback HTTP', () => {
  assert.equal(validateApiBaseUrl('https://api.example.com/v1/'), 'https://api.example.com/v1');
  assert.equal(validateApiBaseUrl('http://127.0.0.1:8188/'), 'http://127.0.0.1:8188');
  assert.equal(validateApiBaseUrl('http://localhost:8188/v1/'), 'http://localhost:8188/v1');
  assert.equal(validateApiBaseUrl('http://[::1]:8188'), 'http://[::1]:8188');
  assert.throws(() => validateApiBaseUrl('http://example.com/v1'), /loopback/);
  assert.throws(() => validateApiBaseUrl('http://127.0.0.2:8188'), /loopback/);
  assert.throws(() => validateApiBaseUrl('http://localhost.localdomain:8188'), /loopback/);
  assert.throws(() => validateApiBaseUrl('https://127.0.0.1:8188'), /私网|本机/);
  assert.throws(() => validateApiBaseUrl('https://192.168.1.1:8188'), /私网|本机/);
  assert.throws(() => validateApiBaseUrl('https://[::ffff:7f00:1]:8188'), /私网|本机/);
  assert.throws(() => validateApiBaseUrl('http://user:secret@127.0.0.1:8188'), /凭据/);
  assert.throws(() => validateApiBaseUrl('http://127.0.0.1:8188/?key=secret'), /查询参数/);
});

test('validateApiBaseUrl 只接受全球单播 IPv6 并拒绝特殊用途前缀', () => {
  assert.equal(validateApiBaseUrl('https://[2606:4700:4700::1111]/v1'), 'https://[2606:4700:4700::1111]/v1');
  for (const address of [
    '64:ff9b::a9fe:a9fe',       // NAT64 carrying 169.254.169.254
    '64:ff9b:1::a9fe:a9fe',     // local-use NAT64
    'fec0::1',                  // deprecated site-local
    '2002:a9fe:a9fe::1',        // 6to4 carrying a private IPv4 address
    '2001:0:4136:e378:8000:63bf:3fff:fdd2', // Teredo
    '2001:db8::1',              // documentation
    '3fff::1',                  // documentation
    'ff02::1',                  // multicast
    'fc00::1',                  // unique-local
    '::ffff:169.254.169.254',   // IPv4-mapped
  ]) {
    assert.throws(() => validateApiBaseUrl(`https://[${address}]/v1`), /私网|本机/);
  }
});

test('listImageModels 发送 Bearer key 并只返回清理后的模型字段', async () => {
  let request;
  const mock = await startMock(async (req, res) => {
    request = { method: req.method, path: req.url, auth: req.headers.authorization };
    json(res, 200, {
      data: [
        { id: 'gpt-image-2', object: 'model', owned_by: 'openai', created: 123, secret: 'discard' },
        { object: 'not-a-model', secret: 'discard' },
      ],
    });
  });
  const result = await listImageModels({ baseUrl: `${mock.endpoint}/v1`, apiKey: 'key-kept-in-memory' });
  assert.deepEqual(request, { method: 'GET', path: '/v1/models', auth: 'Bearer key-kept-in-memory' });
  assert.deepEqual(result.models, [{ id: 'gpt-image-2', object: 'model', owned_by: 'openai', created: 123 }]);
  assert.deepEqual(result.data, result.models);
  assert.doesNotMatch(JSON.stringify(result), /key-kept-in-memory|discard/);
});

test('generateImage 发送 JSON、固定 n=1、保留自定义 size，并解析 b64_json', async () => {
  let request;
  const mock = await startMock(async (req, res) => {
    const body = await readRequest(req);
    request = { method: req.method, path: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
    json(res, 200, {
      data: [{ b64_json: tinyPng.toString('base64'), url: 'https://ignored.example/image.png' }],
      usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8, note: 'discard' },
    });
  });
  const result = await generateImage({
    baseUrl: `${mock.endpoint}/v1`,
    apiKey: 'generate-secret',
    model: 'gpt-image-2',
    prompt: '杭州西湖晨雾',
    size: '1536x1024',
    quality: 'high',
  });
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/v1/images/generations');
  assert.equal(request.auth, 'Bearer generate-secret');
  assert.deepEqual(request.body, { model: 'gpt-image-2', prompt: '杭州西湖晨雾', n: 1, size: '1536x1024', quality: 'high' });
  assert.equal(result.model, 'gpt-image-2');
  assert.equal(result.n, 1);
  assert.equal(result.images.length, 1);
  assert.deepEqual(result.images[0], { bytes: tinyPng, mime: 'image/png', fileName: 'image-1.png', source: 'b64_json' });
  assert.deepEqual(result.usage, { input_tokens: 3, output_tokens: 5, total_tokens: 8 });
  assert.doesNotMatch(JSON.stringify(result), /generate-secret|discard/);
});

test('generateImage 编辑使用 image[] 发送 1–3 张参考图，且固定 n=1', async () => {
  let request;
  const mock = await startMock(async (req, res) => {
    const body = await readRequest(req);
    request = { method: req.method, path: req.url, contentType: req.headers['content-type'], body: body.toString('latin1') };
    json(res, 200, { data: [{ b64_json: tinyJpeg.toString('base64') }] });
  });
  const result = await generateImage({
    baseUrl: `${mock.endpoint}/v1`,
    apiKey: 'edit-secret',
    model: 'gpt-image-2',
    prompt: '保留人物姿态，替换背景',
    size: '1024x1024',
    references: [
      { bytes: tinyPng, mime: 'image/png', name: '../first.png' },
      { bytes: tinyWebp, mime: 'image/webp', name: 'second.webp' },
    ],
  });
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/v1/images/edits');
  assert.match(request.contentType, /^multipart\/form-data; boundary=/);
  assert.match(request.body, /name="model"/);
  assert.match(request.body, /name="n"\r?\n\r?\n1/);
  assert.match(request.body, /name="image\[\]"; filename="first\.png"/);
  assert.match(request.body, /name="image\[\]"; filename="second\.webp"/);
  assert.equal(result.images[0].mime, 'image/jpeg');
});

test('遮罩编辑使用 OpenAI JSON data URL 格式，且拒绝多底图或非 PNG 遮罩', async () => {
  let request, requestCount=0;
  const mock = await startMock(async (req, res) => {
    requestCount++;
    const body = await readRequest(req);
    request = { path: req.url, contentType: req.headers['content-type'], body: JSON.parse(body) };
    json(res, 200, { data: [{ b64_json: tinyPng.toString('base64') }] });
  });
  await generateImage({
    baseUrl: `${mock.endpoint}/v1`,
    apiKey: 'mask-secret',
    model: 'gpt-image-2',
    prompt: '只重绘遮罩区域',
    size: '1024x1024',
    references: [{ bytes: tinyJpeg, mime: 'image/jpeg', name: 'base.jpg' }],
    mask: { bytes: tinyPng, mime: 'image/png', name: 'mask.png' },
  });
  assert.equal(request.path, '/v1/images/edits');
  assert.equal(request.contentType, 'application/json');
  assert.deepEqual(request.body, {
    model: 'gpt-image-2', prompt: '只重绘遮罩区域', n: 1,
    images: [{ image_url: `data:image/jpeg;base64,${tinyJpeg.toString('base64')}` }],
    mask: { image_url: `data:image/png;base64,${tinyPng.toString('base64')}` },
    size: '1024x1024',
  });
  await assert.rejects(generateImage({
    baseUrl: `${mock.endpoint}/v1`, model: 'gpt-image-2', prompt: '不应提交',
    references: [{ bytes: tinyPng, mime: 'image/png' }, { bytes: tinyPng, mime: 'image/png' }],
    mask: { bytes: tinyPng, mime: 'image/png' },
  }), error => error instanceof ImageApiError && error.code === 'invalid_mask');
  await assert.rejects(generateImage({
    baseUrl: `${mock.endpoint}/v1`, model: 'gpt-image-2', prompt: '不应提交',
    references: [{ bytes: tinyPng, mime: 'image/png' }],
    mask: { bytes: tinyJpeg, mime: 'image/jpeg' },
  }), error => error instanceof ImageApiError && error.code === 'invalid_mask');
  assert.equal(requestCount, 1);
});

test('遮罩 JSON 编辑遵守单张图片 data URL 上游长度上限且拒绝前不发请求', async () => {
  let requestCount=0;
  const mock=await startMock(async (_req,res)=>{requestCount++;json(res,200,{data:[{b64_json:tinyPng.toString('base64')}]});});
  const oversized=Buffer.alloc(16*1024*1024);tinyPng.subarray(0,8).copy(oversized);
  await assert.rejects(generateImage({baseUrl:`${mock.endpoint}/v1`,model:'gpt-image-2',prompt:'测试上限',references:[{bytes:tinyPng,mime:'image/png'}],mask:{bytes:oversized,mime:'image/png'}}),/data URL 长度限制/);
  assert.equal(requestCount,0);
});

test('URL 图片下载不带 API key，拒绝重定向并校验魔数', async () => {
  let downloadRequest;
  const imageServer = await startMock((req, res) => {
    downloadRequest = { path: req.url, auth: req.headers.authorization };
    res.writeHead(200, { 'Content-Type': 'image/webp', 'Content-Length': tinyWebp.length });
    res.end(tinyWebp);
  });
  const apiServer = await startMock((req, res) => {
    json(res, 200, { data: [{ url: `${imageServer.endpoint}/generated.webp?sig=one-time` }] });
  });
  const result = await generateImage({
    baseUrl: `${apiServer.endpoint}/v1`,
    apiKey: 'download-secret',
    model: 'local-image-model',
    prompt: '湖畔',
  });
  assert.deepEqual(downloadRequest, { path: '/generated.webp?sig=one-time', auth: undefined });
  assert.equal(result.images[0].mime, 'image/webp');
  assert.equal(result.images[0].fileName, 'generated.webp');
  assert.equal(result.images[0].source, 'url');
});

test('HTML、明确 HTTP 错误和提交网络失败均返回安全且可路由的错误', async () => {
  const html = await startMock((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html>login</html>');
  });
  await assert.rejects(
    listImageModels({ baseUrl: `${html.endpoint}/v1`, apiKey: 'html-secret' }),
    error => {
      assert.ok(error instanceof ImageApiError);
      assert.equal(error.code, 'upstream_html');
      assert.equal(error.status, 502);
      assert.equal(error.publicMessage, error.message);
      assert.equal(error.uncertain, false);
      assert.doesNotMatch(error.message, /html-secret|login/);
      return true;
    },
  );

  const rejected = await startMock((req, res) => json(res, 429, { error: { message: 'retry later' } }));
  await assert.rejects(
    generateImage({ baseUrl: `${rejected.endpoint}/v1`, apiKey: 'rate-secret', model: 'm', prompt: 'p' }),
    error => {
      assert.equal(error.code, 'rate_limited');
      assert.equal(error.status, 502);
      assert.equal(error.upstreamStatus, 429);
      assert.equal(error.uncertain, false);
      return true;
    },
  );

  await assert.rejects(
    generateImage({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'network-secret',
      model: 'm',
      prompt: 'p',
      fetchImpl: async () => { throw new Error('socket closed'); },
    }),
    error => {
      assert.equal(error.code, 'network_uncertain');
      assert.equal(error.status, 502);
      assert.equal(error.uncertain, true);
      assert.equal(error.publicMessage, error.message);
      assert.doesNotMatch(error.message, /network-secret|socket closed/);
      return true;
    },
  );
});

test('云端响应的图片 URL 不能指向内网地址', async () => {
  await assert.rejects(
    generateImage({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'private-url-secret',
      model: 'm',
      prompt: 'p',
      fetchImpl: async (url, init) => {
        if (url.endsWith('/images/generations')) {
          return new Response(JSON.stringify({ data: [{ url: 'http://192.168.1.1/private.png' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        throw new Error(`unexpected ${init?.method}`);
      },
    }),
    error => {
      assert.equal(error.code, 'invalid_image_url');
      return true;
    },
  );
});

test('提交信号取消时保留 network uncertain 标记，不暴露上游错误', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    generateImage({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'cancel-secret',
      model: 'm',
      prompt: 'p',
      signal: controller.signal,
      fetchImpl: async (_url, init) => {
        if (init.signal?.aborted) {
          const error = new Error('aborted by caller');
          error.name = 'AbortError';
          throw error;
        }
        throw new Error('unexpected call');
      },
    }),
    error => {
      assert.equal(error.code, 'aborted');
      assert.equal(error.status, 502);
      assert.equal(error.uncertain, true);
      assert.equal(error.publicMessage, error.message);
      assert.doesNotMatch(error.message, /cancel-secret|aborted by caller/);
      return true;
    },
  );
});

test('提交后 5xx、无效响应和图片下载失败均标记 uncertain；明确拒绝状态保持确定', async () => {
  let mode = '500';
  let endpoint;
  const mock = await startMock(async (req, res) => {
    if (req.url === '/broken.png') {
      json(res, 503, { error: 'download unavailable' });
      return;
    }
    if (mode === 'invalid-json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{bad json');
      return;
    }
    if (mode === 'html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>proxy</html>');
      return;
    }
    if (mode === 'invalid-image') {
      json(res, 200, { data: [{ b64_json: Buffer.from('not an image').toString('base64') }] });
      return;
    }
    if (mode === 'download-failure') {
      json(res, 200, { data: [{ url: `${endpoint}/broken.png` }] });
      return;
    }
    json(res, Number(mode), { error: 'rejected' });
  });
  endpoint = mock.endpoint;

  for (const uncertainMode of ['500', 'invalid-json', 'html', 'invalid-image', 'download-failure']) {
    mode = uncertainMode;
    await assert.rejects(
      generateImage({ baseUrl: `${mock.endpoint}/v1`, model: 'm', prompt: 'p' }),
      error => {
        assert.equal(error.uncertain, true, `${uncertainMode} must preserve billing uncertainty`);
        return true;
      },
    );
  }

  for (const certainStatus of [400, 401, 403, 429]) {
    mode = String(certainStatus);
    await assert.rejects(
      generateImage({ baseUrl: `${mock.endpoint}/v1`, model: 'm', prompt: 'p' }),
      error => {
        assert.equal(error.upstreamStatus, certainStatus);
        assert.equal(error.uncertain, false, `${certainStatus} is an explicit rejection`);
        return true;
      },
    );
  }
});
