import test from 'node:test';
import assert from 'node:assert/strict';
import {canUseAiPublicDns, resolvePublicAiDns} from '../lib/ai-public-dns.mjs';

const TARGET = 'https://miaoapi.xyz/v1';
const FAKE = [{address: '198.18.0.1', family: 4}];
const A = (address = '172.67.137.232', name = 'miaoapi.xyz.') => ({name, type: 1, TTL: 60, data: address});
const CNAME = (name, destination) => ({name, type: 5, TTL: 60, data: destination});
const answer = (entries = [A()], hostname = 'miaoapi.xyz.') => ({Status: 0, TC: false,
  Question: [{name: hostname, type: 1}], Answer: entries});
const poison = 'synthetic-sensitive-data-never-to-be-exposed';

async function rejectPayload(payload) {
  let calls = 0;
  await assert.rejects(resolvePublicAiDns(TARGET, FAKE, {dohRequest: async () => { calls++; return payload; }}),
    error => error.status === 400 && error.message === '公开 DNS 返回无效，已停止请求；不会回退或重试' &&
      !JSON.stringify(error).includes(poison));
  assert.equal(calls, 1);
}

test('只有两个精确 HTTPS 默认端口域名且系统记录全为 198.18/15 IPv4 才能启用', () => {
  for (const url of [TARGET, 'https://miaoapi.xyz:443/v1', 'https://miaoapi.xyz/v1/models',
    'https://ark.cn-beijing.volces.com/api/v3', new URL(TARGET)]) {
    assert.equal(canUseAiPublicDns(url, FAKE), true);
    assert.equal(canUseAiPublicDns(url, [{address: '198.19.255.254', family: 4}]), true);
    assert.equal(canUseAiPublicDns(url, [...FAKE, {address: '198.19.0.9', family: 4}]), true);
  }
});

test('其它域名、协议、端口、凭据和未知目标绝不触发假 DoH', async () => {
  const urls = ['http://miaoapi.xyz/v1', 'https://other.invalid/v1', 'https://miaoapi.xyz.evil.invalid/v1',
    'https://miaoapi.xyz.:443/v1', 'https://ark.cn-shanghai.volces.com/api/v3',
    'https://miaoapi.xyz:444/v1', 'https://a:b@miaoapi.xyz/v1', 'https://miaoapi.xyz/v1#x',
    'https://127.0.0.1/v1', 'not a URL', {}, null, undefined];
  let calls = 0;
  for (const url of urls) {
    assert.equal(canUseAiPublicDns(url, FAKE), false);
    assert.equal(await resolvePublicAiDns(url, FAKE, {dohRequest: async () => { calls++; return answer(); }}), null);
  }
  assert.equal(calls, 0);
});

test('混合、私网非 fake、公网、未知或 lookup 失败记录均不触发补救', async () => {
  const cases = [undefined, null, [], Array(1), {}, [{address: '198.18.0.1'}], [{address: '198.18.0.1', family: 'IPv4'}],
    [{address: '198.18.0.1', family: 6}], [{address: '::ffff:198.18.0.1', family: 6}],
    [{address: '198.20.0.1', family: 4}], [{address: '198.17.0.1', family: 4}],
    [{address: '10.0.0.1', family: 4}], [{address: '127.0.0.1', family: 4}],
    [{address: '172.67.137.232', family: 4}], [...FAKE, {address: '104.21.62.178', family: 4}],
    [...FAKE, {address: '10.0.0.1', family: 4}], [...FAKE, null],
    [{address: '198.018.0.1', family: 4}], [{address: poison, family: 4}]];
  let calls = 0;
  for (const records of cases) {
    assert.equal(canUseAiPublicDns(TARGET, records), false);
    assert.equal(await resolvePublicAiDns(TARGET, records, {dohRequest: async () => { calls++; return answer(); }}), null);
  }
  assert.equal(calls, 0);
});

test('只把允许的 hostname 交给一次假 DoH，返回全部 A 地址和 family4', async () => {
  const calls = [];
  const records = await resolvePublicAiDns(TARGET + '/models', FAKE, {dohRequest: async (...args) => {
    calls.push(args); return answer([A(), A('104.21.62.178')]);
  }});
  assert.deepEqual(records, [{address: '172.67.137.232', family: 4}, {address: '104.21.62.178', family: 4}]);
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'miaoapi.xyz');
  assert.deepEqual(Object.keys(calls[0][1]), ['signal']);
  assert.ok(calls[0][1].signal instanceof AbortSignal);
  assert.equal(JSON.stringify(calls).includes(poison), false);
});

test('API URL 只要带查询参数即不适用公开 DNS 补救，不发送查询内容', async () => {
  let calls = 0;
  for (const url of [TARGET + '?owned=1', TARGET + '?api_key=' + poison,
    'https://ark.cn-beijing.volces.com/api/v3?owned=1']) {
    assert.equal(canUseAiPublicDns(url, FAKE), false);
    assert.equal(await resolvePublicAiDns(url, FAKE, {dohRequest: async () => { calls++; return answer(); }}), null);
  }
  assert.equal(calls, 0);
});

test('Ark 使用同样限定规则且不改动系统记录', async () => {
  const source = structuredClone(FAKE), seen = [];
  const records = await resolvePublicAiDns('https://ark.cn-beijing.volces.com/api/v3', source,
    {dohRequest: async hostname => { seen.push(hostname); return answer([A('1.1.1.2', hostname + '.')], hostname + '.'); }});
  assert.deepEqual(records, [{address: '1.1.1.2', family: 4}]);
  assert.deepEqual(seen, ['ark.cn-beijing.volces.com']); assert.deepEqual(source, FAKE);
});

test('Question 必须精确对应 hostname 和 A 类型，Status/TC 必须确认成功且未截断', async () => {
  for (const payload of [null, [], {}, {...answer(), Status: '0'}, {...answer(), Status: 2},
    {...answer(), TC: true}, {...answer(), TC: undefined}, {...answer(), TC: 'false'},
    {...answer(), Question: []}, {...answer(), Question: [{name: 'other.invalid.', type: 1}]},
    {...answer(), Question: [{name: 'miaoapi.xyz.', type: 28}]},
    {...answer(), Question: [{name: ' miaoapi.xyz.', type: 1}]},
    {...answer(), Question: [answer().Question[0], answer().Question[0]]}]) await rejectPayload(payload);
});

test('答案为空、过多、非 A/CNAME、坏地址或无合法 owner 时拒绝全部结果', async () => {
  for (const entries of [[], [null], ['value'], [A(poison)], [A('2001:db8::1')],
    [{...A(), name: undefined}], [{...A(), name: 'miaoapi.xyz..'}], [{...A(), type: 28}],
    [{...A(), TTL: -1}], [{...A(), TTL: 0.5}], [{...A(), TTL: 0x100000000}],
    Array.from({length: 33}, () => A())]) await rejectPayload(answer(entries));
  await rejectPayload({...answer(), Answer: poison});
});

test('公开查询不能返回任何私网、fake、回环或保留 IPv4；一项坏答案使整批失败', async () => {
  for (const address of ['0.0.0.0', '10.0.0.1', '127.0.0.1', '169.254.1.1', '172.16.0.1',
    '192.168.0.1', '100.64.0.1', '198.18.0.1', '198.19.255.1', '198.51.100.1',
    '203.0.113.1', '224.0.0.1', '255.255.255.255']) await rejectPayload(answer([A(), A(address)]));
});

test('合法 CNAME 链可以解析，但只接受沿 Question 链到达的终端 A', async () => {
  const result = await resolvePublicAiDns(TARGET, FAKE, {dohRequest: async () => answer([
    CNAME('miaoapi.xyz.', 'edge.provider.invalid.'), CNAME('edge.provider.invalid.', 'terminal.provider.invalid.'),
    A('172.67.137.232', 'terminal.provider.invalid.'), A('104.21.62.178', 'terminal.provider.invalid.'),
  ])});
  assert.deepEqual(result, [{address: '172.67.137.232', family: 4}, {address: '104.21.62.178', family: 4}]);
});

test('无关 A、无关 CNAME、CNAME 循环、冲突和过长链均不能被接受', async () => {
  const tooManyAliases = Array.from({length: 9}, (_, index) => CNAME(index ? 'n' + index + '.invalid.' :
    'miaoapi.xyz.', 'n' + (index + 1) + '.invalid.'));
  for (const entries of [[A('172.67.137.232', 'other.invalid.')],
    [A(), CNAME('other.invalid.', 'edge.invalid.')],
    [CNAME('miaoapi.xyz.', 'edge.invalid.'), A()],
    [CNAME('miaoapi.xyz.', 'miaoapi.xyz.'), A()],
    [CNAME('miaoapi.xyz.', 'edge.invalid.'), CNAME('edge.invalid.', 'miaoapi.xyz.'), A()],
    [CNAME('miaoapi.xyz.', 'a.invalid.'), CNAME('miaoapi.xyz.', 'b.invalid.'), A('1.1.1.2', 'a.invalid.')],
    [CNAME('miaoapi.xyz.', poison + '@invalid'), A()],
    [CNAME('miaoapi.xyz.', 'edge.invalid.')],
    [...tooManyAliases, A('1.1.1.2', 'n9.invalid.')]]) await rejectPayload(answer(entries));
});

test('超过 64KB 或不可序列化的结构拒绝，不返回原始正文', async () => {
  await rejectPayload({...answer(), Comment: 'x'.repeat(64 * 1024)});
  const circular = answer(); circular.owned = circular;
  await rejectPayload(circular);
});

test('假 DoH 的网络/TLS/解析异常只有固定错误，一次失败无回退无重试', async () => {
  for (const cause of [Error(poison), Object.assign(Error(poison), {status: 403, stdout: poison}),
    Object.assign(Error(poison), {code: 'CERT_HAS_EXPIRED'})]) {
    let calls = 0;
    await assert.rejects(resolvePublicAiDns(TARGET, FAKE, {dohRequest: async () => { calls++; throw cause; }}),
      error => error.status === 502 && error.message === '无法验证公开 DNS，已停止请求；不会回退或重试' &&
        !JSON.stringify(error).includes(poison));
    assert.equal(calls, 1);
  }
});

test('预先取消或在请求微任务前取消不调用假 DoH', async () => {
  let calls = 0;
  const controller = new AbortController(); controller.abort(poison);
  await assert.rejects(resolvePublicAiDns(TARGET, FAKE, {signal: controller.signal,
    dohRequest: async () => { calls++; return answer(); }}), error => error.status === 400 && /已取消/.test(error.message));
  assert.equal(calls, 0);
  const late = new AbortController();
  const promise = resolvePublicAiDns(TARGET, FAKE, {signal: late.signal,
    dohRequest: async () => { calls++; return answer(); }});
  late.abort(poison);
  await assert.rejects(promise, error => error.status === 400 && /已取消/.test(error.message));
  assert.equal(calls, 0);
});

test('请求中取消立即结束并给传输取消信号，不等响应或重新查询', async () => {
  const controller = new AbortController(); let calls = 0, transportSignal;
  const promise = resolvePublicAiDns(TARGET, FAKE, {signal: controller.signal, dohRequest: async (_hostname, options) => {
    calls++; transportSignal = options.signal; return new Promise(() => {});
  }});
  await Promise.resolve(); await Promise.resolve(); controller.abort(poison);
  await assert.rejects(promise, error => error.status === 400 && /已取消/.test(error.message) && !error.message.includes(poison));
  assert.equal(calls, 1); assert.equal(transportSignal.aborted, true);
});

test('五秒总时限终止不响应的假 DoH并取消传输', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let calls = 0, transportSignal;
  const promise = resolvePublicAiDns(TARGET, FAKE, {dohRequest: async (_hostname, options) => {
    calls++; transportSignal = options.signal; return new Promise(() => {});
  }});
  await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(4999); assert.equal(transportSignal.aborted, false);
  t.mock.timers.tick(1);
  await assert.rejects(promise, error => error.status === 502 && /无法验证/.test(error.message));
  assert.equal(calls, 1); assert.equal(transportSignal.aborted, true);
});
