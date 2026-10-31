import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {MIAO_API_BASE, isLocalMiaoTarget} from '../public/miao-credential-core.js';
import {localMiaoCredentialService, normalizeMiaoCredential, resolveMiaoCredential} from '../lib/miao-credentials.mjs';

const KEY = 'synthetic-miao-only-test-key';
const target = {protocol: 'openai-compatible', baseUrl: MIAO_API_BASE};
const selected = {apiKey: '', credentialSource: 'miao-local', credentialConsent: true};
const reader = fileURLToPath(new URL('../lib/miao-keychain-reader.py', import.meta.url));
const python = fileURLToPath(new URL('../../../.venv/bin/python', import.meta.url));
const neverExec = () => { throw Error('unexpected credential subprocess'); };

test('本机模型服务配置只接受固定 HTTPS 根地址或 v1 的对话、图片和视频用途', () => {
  for (const baseUrl of ['https://miaoapi.xyz', 'https://miaoapi.xyz/', MIAO_API_BASE, MIAO_API_BASE + '/']) {
    for (const purpose of ['chat', 'image', 'video']) {
      assert.equal(isLocalMiaoTarget({...target, baseUrl}, {purpose}), true);
      assert.deepEqual(normalizeMiaoCredential(selected, {...target, baseUrl}, {purpose}),
        {credentialSource: 'miao-local', credentialConsent: true});
    }
  }
  for (const purpose of ['audio', 'models', '', null, 0]) {
    assert.equal(isLocalMiaoTarget(target, {purpose}), false);
    assert.throws(() => normalizeMiaoCredential(selected, target, {purpose}), /已登记的 HTTPS 模型服务地址/);
  }
  for (const protocol of ['gemini', 'ark', 'apimart', undefined]) {
    assert.equal(isLocalMiaoTarget({...target, protocol}), false);
  }
});

test('代理、伪域名、凭据、端口、查询、片段和非目标路径不能接收本机密钥', async () => {
  const executions = [];
  const service = localMiaoCredentialService({env: {MIAO_API_KEY: KEY}, platform: 'darwin',
    execFileImpl: (...args) => { executions.push(args); return {stdout: KEY}; }});
  for (const baseUrl of [
    'http://miaoapi.xyz/v1', 'https://miaoapi.xyz.evil.invalid/v1',
    'https://a:b@miaoapi.xyz/v1', 'https://miaoapi.xyz:443/v1', 'https://miaoapi.xyz:444/v1',
    'https://miaoapi.xyz/v1?x=1', 'https://miaoapi.xyz/v1?', 'https://miaoapi.xyz/v1#x',
    'https://miaoapi.xyz/v1#', 'https://miaoapi.xyz/v2', 'https://miaoapi.xyz/v1/chat/completions',
    'https://miaoapi.xyz//v1', 'https://miaoapi.xyz/%76%31', 'https://miaoapi.xyz./v1',
    'https://miaoapi.xyz/a/../v1', 'https://miaoapi.xyz/v1/..', 'https://miaoapi.xyz/v1/.',
    'https://miaoapi.xyz/%2e/v1',
    'https://miaoapi.xyz\\@evil.invalid/v1', ' https://miaoapi.xyz/v1', 'https://miaoapi.xyz/v1\n',
    'http://127.0.0.1:8188/v1', '', null, {},
  ]) {
    const bad = {...target, baseUrl};
    assert.equal(isLocalMiaoTarget(bad), false, String(baseUrl));
    assert.throws(() => normalizeMiaoCredential(selected, bad), /已登记的 HTTPS 模型服务地址/);
    await assert.rejects(service.resolve(bad), /已登记的 HTTPS 模型服务地址/);
  }
  assert.deepEqual(await service.resolve(target, {purpose: 'video'}), {apiKey: KEY, source: 'environment'});
  assert.equal(executions.length, 0);
});

test('本机来源必须显式同意且不能同时提供本次密钥', () => {
  for (const credentialConsent of [false, 'true', 1, undefined]) {
    assert.throws(() => normalizeMiaoCredential({...selected, credentialConsent}, target), /明确选择/);
  }
  assert.throws(() => normalizeMiaoCredential({...selected, apiKey: KEY}, target), /同时/);
  for (const apiKey of [false, 0, null, [], {}]) {
    assert.throws(() => normalizeMiaoCredential({...selected, apiKey}, target), /同时/);
  }
  assert.throws(() => normalizeMiaoCredential({...selected, credentialSource: 'ark-local'}, target), /来源/);
  assert.throws(() => normalizeMiaoCredential({...selected, credentialSource: 'invented'}, target), /来源/);
  const before = structuredClone(selected);
  normalizeMiaoCredential(selected, target);
  assert.deepEqual(selected, before);
});

test('未选择本机来源时保持手动密钥与本地测试空密钥行为', async () => {
  const service = {resolve: neverExec};
  assert.deepEqual(normalizeMiaoCredential({apiKey: ' ' + KEY + ' '}, target),
    {credentialSource: 'manual', apiKey: KEY});
  assert.deepEqual(await resolveMiaoCredential({apiKey: KEY}, target, service),
    {apiKey: KEY, source: 'manual'});
  for (const baseUrl of ['http://127.0.0.1:8188/v1', 'http://localhost:8188/v1', 'http://[::1]:8188/v1']) {
    const local = {...target, baseUrl};
    assert.deepEqual(normalizeMiaoCredential({apiKey: ''}, local), {credentialSource: 'manual', apiKey: ''});
    assert.deepEqual(await resolveMiaoCredential({apiKey: ''}, local, service), {apiKey: '', source: 'manual'});
    assert.throws(() => normalizeMiaoCredential({apiKey: ''}, local, {allowEmptyLocal: false}), /有效/);
  }
  for (const apiKey of ['', KEY + '\n', KEY + '\r', 'x'.repeat(4097), undefined, 1]) {
    assert.throws(() => normalizeMiaoCredential({apiKey}, target), /有效/);
  }
  assert.deepEqual(normalizeMiaoCredential({apiKey: KEY}, {...target, baseUrl: 'https://other.invalid/v1'}),
    {credentialSource: 'manual', apiKey: KEY});
});

test('状态只通过隔离 Python 的 metadata 操作查询，不请求密码且不返回属性', async () => {
  const executions = [], output = {stdout: '{"configured":true}', stderr: KEY};
  const service = localMiaoCredentialService({env: {}, platform: 'darwin', execFileImpl: async (...args) => {
    executions.push(args); return output;
  }});
  assert.equal(executions.length, 0);
  const status = await service.status();
  assert.deepEqual(status, {configured: true, source: 'macos-keychain', checkedWithoutReadingSecret: true});
  assert.deepEqual(executions[0], [python, ['-I', '-B', reader, 'metadata'],
    {timeout: 2500, maxBuffer: 8192, encoding: 'utf8'}]);
  assert.equal(executions[0][1].includes('-w'), false);
  assert.equal(executions[0][1].includes('-g'), false);
  assert.equal(JSON.stringify(status).includes(KEY), false);
  assert.equal(JSON.stringify(status).includes('director-text'), false);
  assert.deepEqual(output, {stdout: '', stderr: ''});
});

test('只识别 MIAO_API_KEY 或 MIAOAPI_API_KEY，环境优先并不改写它', async () => {
  for (const name of ['MIAO_API_KEY', 'MIAOAPI_API_KEY']) {
    const env = {[name]: ' ' + KEY + ' '};
    const service = localMiaoCredentialService({env, platform: 'darwin', execFileImpl: neverExec});
    assert.equal((await service.status()).source, 'environment');
    assert.deepEqual(await service.resolve(target), {apiKey: KEY, source: 'environment'});
    assert.deepEqual(env, {[name]: ' ' + KEY + ' '});
    assert.equal(JSON.stringify(await service.status()).includes(KEY), false);
  }
  const service = localMiaoCredentialService({env: {MIAO_API_KEY: KEY, MIAOAPI_API_KEY: KEY + '-second'},
    platform: 'darwin', execFileImpl: neverExec});
  assert.equal((await service.resolve(target)).apiKey, KEY);
  const unrelated = localMiaoCredentialService({env: {ARK_API_KEY: KEY, DEEPSEEK_API_KEY: KEY, OPENAI_API_KEY: KEY},
    platform: 'linux', execFileImpl: neverExec});
  assert.deepEqual(await unrelated.status(), {configured: false, source: null, status: 'missing', checkedWithoutReadingSecret: true});
  await assert.rejects(unrelated.resolve(target), /未找到/);
});

test('缺失、超时、权限失败和非 macOS 只返回状态，错误附带输出不会泄露', async () => {
  for (const [code, expected] of [[44, 'missing'], ['ETIMEDOUT', 'unavailable'], [36, 'unavailable']]) {
    const service = localMiaoCredentialService({env: {}, platform: 'darwin', execFileImpl: async () => {
      throw Object.assign(Error(KEY), {code, stdout: KEY, stderr: KEY});
    }});
    const status = await service.status();
    assert.deepEqual(status, {configured: false, source: null, status: expected, checkedWithoutReadingSecret: true});
    assert.equal(JSON.stringify(status).includes(KEY), false);
    await assert.rejects(service.resolve(target), error => !error.message.includes(KEY) &&
      !JSON.stringify(error).includes(KEY) && /无法读取/.test(error.message));
  }
  const service = localMiaoCredentialService({env: {}, platform: 'win32', execFileImpl: neverExec});
  assert.equal((await service.status()).status, 'missing');
  await assert.rejects(service.resolve(target), /未找到/);
});

test('显式解析才通过私有 Python 管道取用，擦除捕获 Buffer 且不创建更新或缓存', async () => {
  const env = {}, executions = [], outputs = [], buffers = [];
  const service = localMiaoCredentialService({env, platform: 'darwin', execFileImpl: async (...args) => {
    const buffer = Buffer.from(KEY + '\n'), result = {stdout: buffer, stderr: Buffer.from(KEY)};
    executions.push(args); outputs.push(result); buffers.push(buffer); return result;
  }});
  const before = structuredClone(target);
  assert.equal(executions.length, 0);
  assert.deepEqual(await service.resolve(target, {purpose: 'image'}), {apiKey: KEY, source: 'macos-keychain'});
  assert.deepEqual(await service.resolve(target), {apiKey: KEY, source: 'macos-keychain'});
  assert.equal(executions.length, 2);
  for (const execution of executions) {
    assert.equal(execution[0], python);
    assert.deepEqual(execution[1], ['-I', '-B', reader, 'resolve']);
    assert.equal(execution[2].timeout, 2500);
    assert.equal(execution[2].encoding, 'buffer');
    assert.equal(execution[1].includes('-w'), false);
    assert.equal(execution[1].includes('-g'), false);
    assert.equal(execution[1].some(arg => /add|delete|update/.test(arg)), false);
  }
  assert.ok(buffers.every(buffer => buffer.every(byte => byte === 0)));
  assert.ok(outputs.every(output => output.stdout === '' && output.stderr === ''));
  assert.deepEqual(env, {});
  assert.deepEqual(target, before);
});

test('解析拒绝空、超长、多行或空白内嵌值，并不在错误中返回原始输出', async () => {
  for (const output of ['', KEY + '\nextra', KEY + ' extra', 'x'.repeat(4097), null]) {
    const service = localMiaoCredentialService({env: {}, platform: 'darwin', execFileImpl: async () => ({stdout: output})});
    await assert.rejects(service.resolve(target), error => /配置无效/.test(error.message) &&
      !error.message.includes(KEY));
  }
});

test('统一解析器再次检查同意、来源、地址和用途再请求本机服务', async () => {
  const calls = [];
  const service = {resolve: async (...args) => { calls.push(args); return {apiKey: KEY, source: 'macos-keychain'}; }};
  assert.deepEqual(await resolveMiaoCredential(selected, target, service, {purpose: 'image'}),
    {apiKey: KEY, source: 'macos-keychain'});
  assert.deepEqual(calls, [[target, {purpose: 'image'}]]);
  await assert.rejects(resolveMiaoCredential({...selected, credentialConsent: false}, target, service), /明确选择/);
  await assert.rejects(resolveMiaoCredential({...selected, apiKey: KEY}, target, service), /同时/);
  await assert.rejects(resolveMiaoCredential({...selected, credentialSource: 'deepseek-local'}, target, service), /来源/);
  await assert.rejects(resolveMiaoCredential(selected, {...target, baseUrl: 'https://evil.invalid/v1'}, service), /已登记的 HTTPS 模型服务地址/);
  assert.deepEqual(await resolveMiaoCredential(selected, target, service, {purpose: 'video'}),
    {apiKey: KEY, source: 'macos-keychain'});
  await assert.rejects(resolveMiaoCredential(selected, target, null), /服务不可用/);
  assert.deepEqual(calls[1], [target, {purpose: 'video'}]);
  assert.equal(calls.length, 2);
});

test('运行时只能来自服务器选定的绝对路径，缺失或拒绝时没有 CLI 或其它来源回退', async () => {
  const executions = [];
  const service = localMiaoCredentialService({env: {JINGCHANG_DIRECTOR_PYTHON: '/owned/runtime/python'},
    platform: 'darwin', execFileImpl: async (...args) => {
      executions.push(args); return {stdout: args[1].at(-1) === 'metadata' ? '{"configured":true}' : KEY};
    }});
  assert.equal((await service.status()).configured, true);
  assert.equal((await service.resolve(target)).apiKey, KEY);
  assert.ok(executions.every(args => args[0] === '/owned/runtime/python'));
  for (const runtime of ['python3', 'relative/python', '/invalid\npython', 123]) {
    const invalid = localMiaoCredentialService({env: {JINGCHANG_DIRECTOR_PYTHON: runtime},
      platform: 'darwin', execFileImpl: neverExec});
    assert.equal((await invalid.status()).status, 'unavailable');
    await assert.rejects(invalid.resolve(target), /读取环境不可用/);
  }
  const attempts = [];
  const absent = localMiaoCredentialService({env: {}, platform: 'darwin', execFileImpl: async (...args) => {
    attempts.push(args); throw Object.assign(Error(KEY), {code: 'ENOENT', stdout: KEY, stderr: KEY});
  }});
  assert.equal((await absent.status()).status, 'unavailable');
  await assert.rejects(absent.resolve(target), error => /读取环境不可用/.test(error.message) && !error.message.includes(KEY));
  assert.equal(attempts.length, 2);
  assert.ok(attempts.every(args => args[0] === python && !args[1].includes('-w')));
});

test('元数据响应多带字段或原始输出时，状态不可用且捕获输出被丢弃', async () => {
  for (const stdout of [KEY, '{"configured":false}', JSON.stringify({configured: true, key: KEY}), '', null]) {
    const output = {stdout, stderr: KEY};
    const service = localMiaoCredentialService({env: {}, platform: 'darwin', execFileImpl: async () => output});
    const status = await service.status();
    assert.equal(status.configured, false); assert.equal(status.status, 'unavailable');
    assert.equal(JSON.stringify(status).includes(KEY), false);
    assert.deepEqual(output, {stdout: '', stderr: ''});
  }
});

test('桥接失败的捕获 Buffer 被擦除，公开异常没有原始 stdout 或 stderr', async () => {
  const stdout = Buffer.from(KEY), stderr = Buffer.from(KEY);
  const captured = Object.assign(Error(KEY), {code: 36, stdout, stderr});
  const service = localMiaoCredentialService({env: {}, platform: 'darwin', execFileImpl: async () => { throw captured; }});
  await assert.rejects(service.resolve(target), error => /无法读取/.test(error.message) &&
    !error.message.includes(KEY) && !JSON.stringify(error).includes(KEY));
  assert.ok(stdout.every(byte => byte === 0)); assert.ok(stderr.every(byte => byte === 0));
  assert.equal(captured.stdout, ''); assert.equal(captured.stderr, '');
});

test('Python 桥接在假 Security 框架中验证非交互、metadata 无密码、释放与失败不回显', async () => {
  // This imports the bridge but injects every framework call. The real macOS
  // loader is replaced with a failing stub before any lookup is performed.
  const code = String.raw`
import ctypes, importlib.util, io, sys
spec = importlib.util.spec_from_file_location('private_miao_reader', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
def forbid_live():
    raise AssertionError('live Security framework must not load')
module._frameworks = forbid_live
secret = b'synthetic-python-bridge-key'

class Security:
    def __init__(self, value=secret, status=0, interaction=0):
        self.value, self.status, self.interaction = value, status, interaction
        self.calls, self.freed = [], 0
        self.storage = ctypes.create_string_buffer(value)
    def SecKeychainSetUserInteractionAllowed(self, allowed):
        assert allowed is False
        self.calls.append(('noninteractive', allowed))
        return self.interaction
    def SecKeychainFindGenericPassword(self, keychains, slen, service, alen, account, length, data, item):
        assert self.calls == [('noninteractive', False)]
        assert keychains is None
        assert service == b'cn.zhejiang-tourism.workbench.miaoapi' and slen == len(service)
        assert account == b'director-text' and alen == len(account)
        self.calls.append(('find', length, data))
        if self.status:
            return self.status
        item._obj.value = 23
        if length is not None:
            assert data is not None
            length._obj.value = len(self.value)
            data._obj.value = ctypes.addressof(self.storage)
        else:
            assert data is None
        return 0
    def SecKeychainItemFreeContent(self, attributes, data):
        assert attributes is None
        assert ctypes.string_at(data, len(self.value)) == b'\0' * len(self.value)
        self.freed += 1
        return 0

class Core:
    def __init__(self):
        self.released = []
    def CFRelease(self, item):
        assert item.value == 23
        self.released.append(item.value)

security, core = Security(), Core()
assert module.read_keychain('metadata', (security, core)) == {'configured': True}
assert security.calls[1][1:] == (None, None)
assert security.freed == 0 and core.released == [23]
security, core = Security(), Core()
payload = module.read_keychain('resolve', (security, core))
assert isinstance(payload, bytearray) and payload == secret
assert security.freed == 1 and core.released == [23]
payload[:] = b'\0' * len(payload)

for operation in ('metadata', 'resolve'):
    security, core = Security(status=-25300), Core()
    try:
        module.read_keychain(operation, (security, core))
        raise AssertionError('missing entry must fail')
    except module.BridgeError as error:
        assert error.code == 44
    assert security.freed == 0 and core.released == []
    security, core = Security(interaction=-1), Core()
    try:
        module.read_keychain(operation, (security, core))
        raise AssertionError('interaction control failure must fail')
    except module.BridgeError:
        pass
    assert security.calls == [('noninteractive', False)]

security, core = Security(value=b'invalid white space'), Core()
try:
    module.read_keychain('resolve', (security, core))
    raise AssertionError('invalid key must fail')
except module.BridgeError:
    pass
assert security.freed == 1 and core.released == [23]

class Output:
    def __init__(self):
        self.buffer = io.BytesIO()
        self.text = ''
    def write(self, value):
        self.text += value

saved_stdout, saved_stderr = sys.stdout, sys.stderr
output, errors = Output(), io.StringIO()
returned = bytearray(secret)
module.read_keychain = lambda operation: returned
try:
    sys.stdout, sys.stderr = output, errors
    assert module.main(['resolve']) == 0
    assert output.buffer.getvalue() == secret + b'\n'
    assert returned == b'\0' * len(secret)
    assert errors.getvalue() == ''
finally:
    sys.stdout, sys.stderr = saved_stdout, saved_stderr
output, errors = Output(), io.StringIO()
def failed(operation):
    raise RuntimeError(secret.decode())
module.read_keychain = failed
try:
    sys.stdout, sys.stderr = output, errors
    assert module.main(['resolve']) == 36
    assert module.main(['metadata', 'other-service']) == 64
    assert secret.decode() not in errors.getvalue()
    assert output.buffer.getvalue() == b'' and output.text == ''
finally:
    sys.stdout, sys.stderr = saved_stdout, saved_stderr
print('fake-framework-checks-passed')
`;
  const result = await promisify(execFile)(process.env.JINGCHANG_TEST_PYTHON || python, ['-I', '-B', '-c', code, reader],
    {timeout: 5000, maxBuffer: 8192, encoding: 'utf8'});
  assert.equal(result.stdout.trim(), 'fake-framework-checks-passed');
  assert.equal(result.stderr, '');
});
