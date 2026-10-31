import test from 'node:test';
import assert from 'node:assert/strict';
import {MIAO_API_BASE, isLocalMiaoTarget} from '../public/miao-credential-core.js';
import {ARK_API_BASE} from '../public/ark-credential-core.js';
import {studioServiceTarget, isLocalStudioServiceTarget} from '../public/studio-service-core.js';
import {normalizeStudioCredential, resolveStudioCredential} from '../lib/ark-credentials.mjs';
import {localMiaoCredentialService} from '../lib/miao-credentials.mjs';

const KEY = 'synthetic-studio-service-only-key';
const selected = {apiKey: '', credentialSource: 'miao-local', credentialConsent: true};
const studio = (mode = 'video', protocol = 'miao-video', baseUrl = MIAO_API_BASE) =>
  ({mode, config: {protocol, baseUrl}});
const neverResolve = () => {throw Error('unexpected credential service access');};

test('supported studio adapters project only the registered target and the exact image/video purpose', async () => {
  const cases = [['image', 'studio'], ['image', 'gemini'], ['video', 'studio'], ['video', 'miao-video']];
  for (const [mode, protocol] of cases) {
    const target = {...studio(mode, protocol), id: 'synthetic-private-project', prompt: 'synthetic-private-prompt'};
    target.config.apiKey = 'synthetic-discarded-config-key';
    const mapped = {protocol: 'openai-compatible', baseUrl: MIAO_API_BASE};
    assert.deepEqual(studioServiceTarget(target), mapped);
    assert.equal(isLocalStudioServiceTarget(target), true);
    assert.equal(isLocalMiaoTarget(mapped, {purpose: mode}), true);
    const calls = [];
    const miaoService = {resolve: async (...args) => {calls.push(args); return {apiKey: KEY, source: 'synthetic-service'};}};
    const credential = normalizeStudioCredential(selected, target);
    assert.deepEqual(credential, {credentialSource: 'miao-local', credentialConsent: true});
    assert.deepEqual(await resolveStudioCredential(credential, target, {resolve: neverResolve}, miaoService),
      {apiKey: KEY, source: 'synthetic-service'});
    assert.deepEqual(calls, [[mapped, {purpose: mode}]]);
    assert.doesNotMatch(JSON.stringify(calls), /synthetic-private|discarded-config-key/);
  }
});

test('video purpose uses the same strict registered root/v1 variants as image and chat', () => {
  for (const baseUrl of ['https://miaoapi.xyz', 'https://miaoapi.xyz/', MIAO_API_BASE, MIAO_API_BASE + '/']) {
    for (const purpose of ['chat', 'image', 'video']) {
      assert.equal(isLocalMiaoTarget({protocol: 'openai-compatible', baseUrl}, {purpose}), true);
    }
    for (const mode of ['image', 'video']) {
      const target = studio(mode, 'studio', baseUrl);
      assert.equal(isLocalStudioServiceTarget(target), true);
      assert.deepEqual(normalizeStudioCredential(selected, target),
        {credentialSource: 'miao-local', credentialConsent: true});
    }
  }
});

test('other hosts, raw ports, credentials, queries, fragments and paths never reach either credential service', async () => {
  const calls = [];
  const service = {resolve: async (...args) => {calls.push(args); return {apiKey: KEY};}};
  const invalidUrls = [
    'http://miaoapi.xyz/v1', 'https://other.invalid/v1', 'https://miaoapi.xyz.evil.invalid/v1',
    'https://a:b@miaoapi.xyz/v1', 'https://miaoapi.xyz:443/v1', 'https://miaoapi.xyz:444/v1',
    MIAO_API_BASE + '?x=1', MIAO_API_BASE + '?', MIAO_API_BASE + '#x', MIAO_API_BASE + '#',
    'https://miaoapi.xyz/v2', MIAO_API_BASE + '/models', MIAO_API_BASE + '/videos/generations',
    'https://miaoapi.xyz//v1', 'https://miaoapi.xyz/%76%31', 'https://miaoapi.xyz./v1',
    'https://miaoapi.xyz/a/../v1', 'https://miaoapi.xyz/v1/..', 'https://miaoapi.xyz/v1/.',
    'https://miaoapi.xyz/%2e/v1', 'https://miaoapi.xyz\\@evil.invalid/v1',
    ' ' + MIAO_API_BASE, MIAO_API_BASE + '\n', 'http://127.0.0.1:8188/v1', '', null, {},
  ];
  for (const mode of ['image', 'video']) {
    for (const baseUrl of invalidUrls) {
      const target = studio(mode, 'studio', baseUrl);
      assert.equal(isLocalStudioServiceTarget(target), false, String(baseUrl));
      assert.throws(() => normalizeStudioCredential(selected, target), /已登记/);
      await assert.rejects(resolveStudioCredential(selected, target, service, service), /已登记/);
    }
  }
  assert.equal(calls.length, 0);
});

test('unsupported purposes and adapter protocols do not inherit local-service credentials', async () => {
  const service = {resolve: neverResolve};
  for (const mode of ['chat', 'audio', 'models', '', undefined, null]) {
    const target = {mode, config: {protocol: 'studio', baseUrl: MIAO_API_BASE}};
    assert.equal(isLocalStudioServiceTarget(target), false);
    assert.throws(() => normalizeStudioCredential(selected, target), /已登记/);
    await assert.rejects(resolveStudioCredential(selected, target, service, service), /已登记/);
  }
  for (const protocol of ['ark', 'apimart', 'modelscope', 'midjourney', 'openai-compatible', '', undefined]) {
    const target = {mode: 'video', config: {protocol, baseUrl: MIAO_API_BASE}};
    assert.equal(isLocalStudioServiceTarget(target), false);
    assert.throws(() => normalizeStudioCredential(selected, target), /已登记/);
    await assert.rejects(resolveStudioCredential(selected, target, service, service), /已登记/);
  }
});

test('Gemini adapter is eligible only in image mode and never changes the credential destination', async () => {
  assert.equal(isLocalStudioServiceTarget(studio('image', 'gemini')), true);
  const invalid = studio('video', 'gemini');
  assert.equal(studioServiceTarget(invalid), null);
  assert.equal(isLocalStudioServiceTarget(invalid), false);
  assert.throws(() => normalizeStudioCredential(selected, invalid), /已登记/);
  await assert.rejects(resolveStudioCredential(selected, invalid, {resolve: neverResolve}, {resolve: neverResolve}), /已登记/);
  assert.equal(isLocalStudioServiceTarget(studio('image', 'gemini', 'https://generativelanguage.googleapis.com/v1beta')), false);
});

test('local source requires explicit true consent and excludes every nonempty manual-key value', async () => {
  const target = studio();
  const service = {resolve: neverResolve};
  for (const credentialConsent of [false, 'true', 1, null, undefined]) {
    const credential = {...selected, credentialConsent};
    assert.throws(() => normalizeStudioCredential(credential, target), /明确选择/);
    await assert.rejects(resolveStudioCredential(credential, target, service, service), /明确选择/);
  }
  for (const apiKey of [KEY, ' ', false, 0, null, [], {}]) {
    const credential = {...selected, apiKey};
    assert.throws(() => normalizeStudioCredential(credential, target), /同时/);
    await assert.rejects(resolveStudioCredential(credential, target, service, service), /同时/);
  }
  const before = structuredClone(selected);
  normalizeStudioCredential(selected, target);
  assert.deepEqual(selected, before);
});

test('resolution rechecks a target changed after normalization and has no implicit credential fallback', async () => {
  const credential = normalizeStudioCredential(selected, studio());
  await assert.rejects(resolveStudioCredential(credential, studio('video', 'miao-video', 'https://other.invalid/v1'),
    {resolve: neverResolve}, {resolve: neverResolve}), /已登记/);
  await assert.rejects(resolveStudioCredential(credential, studio(), {resolve: neverResolve}, null), /服务不可用/);
});

test('synthetic environment-backed service remains bound to the original image/video purpose', async () => {
  const env = {MIAO_API_KEY: KEY};
  const service = localMiaoCredentialService({env, platform: 'linux', execFileImpl: neverResolve});
  for (const mode of ['image', 'video']) {
    assert.deepEqual(await resolveStudioCredential(normalizeStudioCredential(selected, studio(mode, 'studio')),
      studio(mode, 'studio'), {resolve: neverResolve}, service), {apiKey: KEY, source: 'environment'});
  }
  assert.deepEqual(env, {MIAO_API_KEY: KEY});
});

test('private-reader failures expose fixed errors and erase captured secret bytes for studio video', async () => {
  for (const code of [36, 'ENOENT']) {
    const stdout = Buffer.from(KEY), stderr = Buffer.from(KEY);
    const captured = Object.assign(Error(KEY), {code, stdout, stderr});
    const service = localMiaoCredentialService({env: {}, platform: 'darwin', execFileImpl: async () => {throw captured;}});
    await assert.rejects(resolveStudioCredential(selected, studio(), {resolve: neverResolve}, service), error => {
      assert.match(error.message, code === 'ENOENT' ? /读取环境不可用/ : /无法读取/);
      assert.equal(error.message.includes(KEY), false);
      assert.equal(error.stack.includes(KEY), false);
      assert.equal(JSON.stringify(error).includes(KEY), false);
      return true;
    });
    assert.ok(stdout.every(byte => byte === 0));
    assert.ok(stderr.every(byte => byte === 0));
    assert.equal(captured.stdout, '');
    assert.equal(captured.stderr, '');
  }
});

test('Ark local source still uses its own official video service and cannot cross into the model service', async () => {
  const target = studio('video', 'ark', ARK_API_BASE);
  const credential = normalizeStudioCredential({apiKey: '', credentialSource: 'ark-local', credentialConsent: true}, target);
  const calls = [];
  const arkService = {resolve: async value => {calls.push(value); return {apiKey: KEY, source: 'synthetic-ark'};}};
  assert.deepEqual(await resolveStudioCredential(credential, target, arkService, {resolve: neverResolve}),
    {apiKey: KEY, source: 'synthetic-ark'});
  assert.deepEqual(calls, [target]);
  assert.throws(() => normalizeStudioCredential(selected, target), /已登记/);
  assert.throws(() => normalizeStudioCredential({credentialSource: 'ark-local', credentialConsent: true}, studio()), /官方视频接口/);
});

test('manual credentials and loopback empty credentials remain explicit and never invoke local services', async () => {
  const target = studio('video', 'studio', 'https://custom.invalid/v1');
  const credential = normalizeStudioCredential({apiKey: ' ' + KEY + ' '}, target);
  assert.deepEqual(credential, {credentialSource: 'manual', apiKey: KEY});
  assert.deepEqual(await resolveStudioCredential(credential, target, {resolve: neverResolve}, {resolve: neverResolve}),
    {apiKey: KEY, source: 'manual'});
  for (const baseUrl of ['http://127.0.0.1:8188/v1', 'http://localhost:8188/v1', 'http://[::1]:8188/v1']) {
    const local = studio('video', 'studio', baseUrl);
    assert.deepEqual(normalizeStudioCredential({apiKey: ''}, local), {credentialSource: 'manual', apiKey: ''});
    assert.throws(() => normalizeStudioCredential({apiKey: ''}, local, {allowEmptyLocal: false}), /有效/);
  }
  assert.throws(() => normalizeStudioCredential({apiKey: ''}, target), /有效/);
  assert.throws(() => normalizeStudioCredential({apiKey: KEY + '\n'}, target), /有效/);
  assert.throws(() => normalizeStudioCredential({credentialSource: 'invented', apiKey: KEY}, target), /来源/);
});
