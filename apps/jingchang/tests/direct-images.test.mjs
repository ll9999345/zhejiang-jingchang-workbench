import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { directImageService } from '../lib/direct-images.mjs';
import { platformService } from '../lib/api-platforms.mjs';
import { generateImage } from '../lib/image-api.mjs';
import { readJson, storeAsset } from '../lib/workspace.mjs';

const SYNTHETIC_KEY = 'synthetic-test-key';
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

function readRequest(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function jsonResponse(res, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    ...headers,
  });
  res.end(body);
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function startMock({ mode = 'success' } = {}) {
  const state = {
    mode,
    requests: [],
    modelRequests: [],
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      state.modelRequests.push({ authorization: req.headers.authorization || '' });
      jsonResponse(res, 200, {
        data: [
          { id: 'discovered-image', object: 'model' },
          { id: 'discovered-chat', object: 'model' },
          { id: 99, object: 'ignored-invalid-model' },
        ],
      });
      return;
    }
    if (req.method === 'POST' && ['/v1/images/generations', '/v1/images/edits'].includes(url.pathname)) {
      const body = await readRequest(req);
      state.requests.push({
        path: url.pathname,
        authorization: req.headers.authorization || '',
        contentType: req.headers['content-type'] || '',
        body,
      });
      if(state.generationGate)await state.generationGate;
      if (state.mode === '401') {
        jsonResponse(res, 401, { error: { message: 'invalid api key' } });
        return;
      }
      if (state.mode === 'html') {
        const html = Buffer.from('<!doctype html><html><body>login page</body></html>');
        res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': html.length });
        res.end(html);
        return;
      }
      jsonResponse(res, 200, {
        data: [{ b64_json: PNG.toString('base64') }],
        usage: { total_tokens: 3 },
      });
      return;
    }
    jsonResponse(res, 404, { error: 'unknown mock route' });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return { server, state, endpoint: `http://127.0.0.1:${address.port}` };
}

async function makeData() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'jingchang-direct-image-'));
}

function rgbaPng(width,height,rgba){
  const canvas=createCanvas(width,height),ctx=canvas.getContext('2d'),pixels=ctx.createImageData(width,height);
  pixels.data.set(rgba);ctx.putImageData(pixels,0,0);return canvas.toBuffer('image/png');
}

async function makeFixture(data, referenceAsset) {
  return {
    id: 'project-image-api',
    revision: 7,
    nodes: [
      { id: 'style', type: 'text', title: '风格', text: '江南水乡，柔和晨光。', assetId: null },
      { id: 'reference', type: 'image', title: '参考图', text: '', assetId: referenceAsset?.id || null },
      { id: 'target', type: 'image', title: '目标画面', text: '生成一张乌篷船穿过薄雾的画面。', assetId: null },
    ],
    edges: [
      { id: 'edge-style', source: 'style', target: 'target' },
      { id: 'edge-reference', source: 'reference', target: 'target' },
    ],
    assets: referenceAsset ? [referenceAsset] : [],
  };
}

async function saveLocalPlatform(platforms, endpoint, revision = 0) {
  return platforms.save({
    revision,
    platform: {
      name: '本地图片服务',
      protocol: 'openai-compatible',
      baseUrl: `${endpoint}/v1`,
      models: [
        { id: 'local-image', label: '本地图像模型', category: 'image', referenceSupport: true, maskSupport: true },
        { id: 'local-chat', label: '本地对话模型', category: 'chat', referenceSupport: false },
      ],
    },
  });
}

async function waitFor(read, { timeout = 5000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() <= deadline) {
    last = await read();
    if (last) return last;
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  throw new Error(`等待图片任务状态超时：${JSON.stringify(last)}`);
}

async function waitForJob(data, id, status) {
  return waitFor(async () => {
    try {
      const job = await readJson(path.join(data, 'jobs', `${id}.json`));
      return job.status === status ? job : null;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  });
}

async function findFiles(root) {
  const result = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await findFiles(full));
    else result.push(full);
  }
  return result;
}

async function assertNoSecret(root) {
  for (const file of await findFiles(root)) {
    const bytes = await fs.readFile(file);
    assert.equal(bytes.includes(Buffer.from(SYNTHETIC_KEY)), false, `密钥写入了 ${file}`);
  }
}

test('保存平台并保留图片/对话分类，discover 只返回清洗后的模型', async t => {
  const mock = await startMock();
  t.after(() => closeServer(mock.server));
  const data = await makeData();
  const platforms = platformService(data);
  const saved = await saveLocalPlatform(platforms, mock.endpoint);

  assert.equal(saved.revision, 1);
  assert.deepEqual(saved.platforms[0].models.map(model => [model.id, model.category]), [
    ['local-image', 'image'],
    ['local-chat', 'chat'],
  ]);
  assert.equal(saved.platforms[0].models[0].maskSupport,true);
  assert.equal(saved.platforms[0].models[1].maskSupport,false);
  const platformId = saved.platforms[0].id;
  assert.equal((await platforms.get(platformId)).baseUrl, `${mock.endpoint}/v1`);

  const discovered = await platforms.discover({
    platformId,
    consent: true,
    apiKey: SYNTHETIC_KEY,
  });
  assert.deepEqual(discovered.models, [
    { id: 'discovered-image', object: 'model' },
    { id: 'discovered-chat', object: 'model' },
  ]);
  assert.equal(mock.state.modelRequests.length, 1);
  assert.equal(mock.state.modelRequests[0].authorization, `Bearer ${SYNTHETIC_KEY}`);
  await assertNoSecret(data);
});

test('读取上游文字和参考图，直接生成后回收 asset，requestId 重复不重复 POST', async t => {
  const mock = await startMock();
  t.after(() => closeServer(mock.server));
  const data = await makeData();
  const platforms = platformService(data);
  const savedPlatform = await saveLocalPlatform(platforms, mock.endpoint);
  const platformId = savedPlatform.platforms[0].id;
  const referenceAsset = await storeAsset(data, PNG, {
    name: '参考图.png',
    type: 'image/png',
    source: 'test',
  });
  const project = await makeFixture(data, referenceAsset);
  const activeJobs = new Map();
  const service = directImageService({ data, activeJobs, platforms });

  const context = await service.context(project, 'target');
  assert.match(context.prompt, /江南水乡/);
  assert.match(context.prompt, /乌篷船/);
  assert.deepEqual(context.candidates, [{
    id: referenceAsset.id,
    name: '参考图.png',
    type: 'image/png',
  }]);

  const requestBody = {
    requestId: 'image-request-1',
    revision: project.revision,
    nodeId: 'target',
    platformId,
    model: 'local-image',
    size: 'auto',
    quality: 'high',
    includeUpstream: true,
    referenceIds: [referenceAsset.id],
    apiKey: SYNTHETIC_KEY,
  };
  const started = await service.start(project, requestBody);
  const completed = await waitForJob(data, started.id, 'completed');

  assert.equal(mock.state.requests.length, 1);
  assert.equal(mock.state.requests[0].path, '/v1/images/edits');
  assert.match(mock.state.requests[0].contentType, /^multipart\/form-data; boundary=/);
  assert.equal(mock.state.requests[0].authorization, `Bearer ${SYNTHETIC_KEY}`);
  assert.match(mock.state.requests[0].body.toString('utf8'), /江南水乡/);
  assert.match(mock.state.requests[0].body.toString('utf8'), /name="image\[\]"; filename="[^"]+\.png"/);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.input.referenceIds[0], referenceAsset.id);
  assert.match(completed.input.prompt, /乌篷船/);
  assert.equal(completed.assets.length, 1);
  const output = completed.assets[0];
  assert.equal(output.source, 'image-api');
  assert.equal(output.type, 'image/png');
  assert.deepEqual(await fs.readFile(path.join(data, 'assets', output.id)), PNG);
  assert.deepEqual(await readJson(path.join(data, 'assets', `${output.id}.json`)), output);

  const repeated = await service.start(project, requestBody);
  assert.equal(repeated.id, started.id);
  assert.equal(mock.state.requests.length, 1);
  await assertNoSecret(data);
});

test('遮罩重绘转换本机黑白遮罩为带 alpha 的 PNG 并以单次 JSON 编辑请求提交', async t => {
  const mock = await startMock();
  t.after(() => closeServer(mock.server));
  const data = await makeData();
  const platforms = platformService(data);
  const savedPlatform = await saveLocalPlatform(platforms, mock.endpoint);
  const baseBytes=rgbaPng(2,1,[40,90,180,255, 220,120,30,255]);
  const maskBytes=rgbaPng(2,1,[0,0,0,255, 255,255,255,255]);
  const referenceAsset=await storeAsset(data,baseBytes,{name:'底图.png',type:'image/png',source:'test'});
  const storedMask=await storeAsset(data,maskBytes,{name:'黑白遮罩.png',type:'image/png',source:'image-edit'});
  const maskAsset={...storedMask,width:2,height:1,sourceAssetId:referenceAsset.id,operation:'image-edit',editOutput:'mask'};
  await fs.writeFile(path.join(data,'assets',`${maskAsset.id}.json`),JSON.stringify(maskAsset));
  const project=await makeFixture(data,referenceAsset);
  project.assets.push(maskAsset);
  const service=directImageService({data,activeJobs:new Map(),platforms});
  const requestBody={requestId:'mask-edit-request',revision:project.revision,nodeId:'target',
    platformId:savedPlatform.platforms[0].id,model:'local-image',includeUpstream:true,
    referenceIds:[referenceAsset.id],maskAssetId:maskAsset.id,apiKey:SYNTHETIC_KEY};

  const started=await service.start(project,requestBody),completed=await waitForJob(data,started.id,'completed');
  assert.equal(mock.state.requests.length,1);
  const request=mock.state.requests[0];
  assert.equal(request.path,'/v1/images/edits');
  assert.equal(request.contentType,'application/json');
  assert.equal(request.authorization,`Bearer ${SYNTHETIC_KEY}`);
  const body=JSON.parse(request.body.toString('utf8'));
  assert.equal(body.n,1);
  assert.equal(body.images.length,1);
  assert.match(body.images[0].image_url,/^data:image\/png;base64,/);
  assert.match(body.mask.image_url,/^data:image\/png;base64,/);
  const base=await loadImage(Buffer.from(body.images[0].image_url.split(',')[1],'base64'));
  assert.deepEqual([base.width,base.height],[2,1]);
  const mask=await loadImage(Buffer.from(body.mask.image_url.split(',')[1],'base64'));
  const maskCanvas=createCanvas(mask.width,mask.height),maskContext=maskCanvas.getContext('2d');
  maskContext.drawImage(mask,0,0);const pixels=maskContext.getImageData(0,0,2,1).data;
  assert.equal(pixels[3],255,'黑色的保留区域应保持不透明');
  assert.equal(pixels[7],0,'白色的重绘区域应转换成透明 alpha');
  assert.equal(completed.input.maskAssetId,maskAsset.id);
  assert.equal(completed.authorization.maskIncluded,true);
  assert.equal(completed.assets.length,1);
  const detached=structuredClone(project);detached.assets=detached.assets.filter(asset=>asset.id!==maskAsset.id);
  await assert.rejects(service.start(detached,{...requestBody,requestId:'detached-mask-request'}),/不属于当前项目/);
  assert.equal(mock.state.requests.length,1);
  await assertNoSecret(data);
});

test('云端遮罩未获本次明确授权时，在创建任务或发送请求前拒绝',async t=>{
  const mock=await startMock();t.after(()=>closeServer(mock.server));
  const data=await makeData(),platforms=platformService(data);
  const saved=await platforms.save({revision:0,platform:{name:'云端图片平台',protocol:'openai-compatible',baseUrl:'https://api.example.com/v1',models:[{id:'cloud-image',label:'云图片',category:'image',referenceSupport:true,maskSupport:true}]}});
  const referenceAsset=await storeAsset(data,rgbaPng(2,1,[10,20,30,255,40,50,60,255]),{name:'底图.png',type:'image/png'});
  const storedMask=await storeAsset(data,rgbaPng(2,1,[0,0,0,255,255,255,255,255]),{name:'遮罩.png',type:'image/png'});
  const maskAsset={...storedMask,width:2,height:1,sourceAssetId:referenceAsset.id,operation:'image-edit',editOutput:'mask'};
  await fs.writeFile(path.join(data,'assets',`${maskAsset.id}.json`),JSON.stringify(maskAsset));
  const project=await makeFixture(data,referenceAsset);project.assets.push(maskAsset);
  const service=directImageService({data,activeJobs:new Map(),platforms});
  await assert.rejects(service.start(project,{requestId:'cloud-mask-no-consent',revision:project.revision,nodeId:'target',platformId:saved.platforms[0].id,model:'cloud-image',referenceIds:[referenceAsset.id],maskAssetId:maskAsset.id,apiKey:SYNTHETIC_KEY,authorization:{origin:'https://api.example.com',model:'cloud-image',requestLimit:1,budget:1,currency:'USD',sendPrompt:true,sendReferences:true}}),/文字\/参考图\/遮罩发送范围/);
  assert.equal(mock.state.requests.length,0);
  assert.equal((await fs.readdir(path.join(data,'jobs'))).filter(name=>name.endsWith('.json')).length,0);
  await assertNoSecret(data);
});

test('HTTPS 平台在缺少鉴权或预算时请求前拒绝，不触碰外网', async t => {
  const mock = await startMock();
  t.after(() => closeServer(mock.server));
  const data = await makeData();
  const platforms = platformService(data);
  await platforms.save({
    revision: 0,
    platform: {
      name: '云端示例',
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      models: [{ id: 'cloud-image', label: '云端图像', category: 'image', referenceSupport: false }],
    },
  });
  const project = await makeFixture(data, null);
  const platformId = (await platforms.list()).platforms[0].id;
  const activeJobs = new Map();
  const service = directImageService({ data, activeJobs, platforms });
  const base = {
    requestId: 'cloud-request-1',
    revision: project.revision,
    nodeId: 'target',
    platformId,
    model: 'cloud-image',
    apiKey: SYNTHETIC_KEY,
  };

  await assert.rejects(service.start(project, base), /调用云平台前需确认/);
  await assert.rejects(service.start(project, {
    ...base,
    requestId: 'cloud-request-2',
    authorization: {
      origin: 'https://api.example.com',
      model: 'cloud-image',
      requestLimit: 1,
      sendPrompt: true,
      currency: 'USD',
    },
  }), /调用云平台前需确认/);
  assert.equal(mock.state.requests.length, 0);
  const files = await findFiles(data);
  assert.equal(files.some(file => path.basename(path.dirname(file)) === 'jobs' && file.endsWith('.json')), false);
  await assertNoSecret(data);
});

test('image-api 对 HTTP 401 和 HTML 响应返回安全、可识别的失败消息', async t => {
  const mock = await startMock({ mode: '401' });
  t.after(() => closeServer(mock.server));
  await assert.rejects(
    generateImage({
      baseUrl: `${mock.endpoint}/v1`,
      apiKey: SYNTHETIC_KEY,
      model: 'local-image',
      prompt: '测试图片',
      size: 'auto',
      quality: 'auto',
    }),
    error => error.code === 'auth_error' && error.status === 502 && error.upstreamStatus === 401 && /认证或权限失败/.test(error.message),
  );

  mock.state.mode = 'html';
  await assert.rejects(
    generateImage({
      baseUrl: `${mock.endpoint}/v1`,
      apiKey: SYNTHETIC_KEY,
      model: 'local-image',
      prompt: '测试图片',
      size: 'auto',
      quality: 'auto',
    }),
    error => error.code === 'upstream_html' && error.status === 502 && /HTML/.test(error.message),
  );
  assert.equal(mock.state.requests.length, 2);
});

test('并发重复提交只创建一个任务，其他请求在生成期间被拒绝', async t => {
  const mock = await startMock();
  let release;
  mock.state.generationGate = new Promise(resolve => { release = resolve; });
  t.after(() => { release(); return closeServer(mock.server); });
  const data = await makeData();
  const platforms = platformService(data);
  const saved = await saveLocalPlatform(platforms, mock.endpoint);
  const project = await makeFixture(data, null);
  const service = directImageService({data, activeJobs:new Map(), platforms});
  const body = {requestId:'concurrent-request', revision:project.revision,
    nodeId:'target', platformId:saved.platforms[0].id, model:'local-image',
    apiKey:SYNTHETIC_KEY};
  // A rejected admission must also release the lock for later valid requests.
  await assert.rejects(service.start(project, {...body, requestId:''}), /请求编号/);
  const jobs = await Promise.all(Array.from({length:12}, () => service.start(project, {...body})));
  assert.equal(new Set(jobs.map(job => job.id)).size, 1);
  await assert.rejects(service.start(project, {...body,requestId:'other-request'}), /已有图片生成任务/);
  await waitFor(() => mock.state.requests.length === 1);
  assert.equal((await fs.readdir(path.join(data,'jobs'))).filter(name => name.endsWith('.json')).length, 1);
  release();
  await waitForJob(data,jobs[0].id,'completed');
  assert.equal(mock.state.requests.length, 1);
  await assertNoSecret(data);
});
