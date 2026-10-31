import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isLocalMiaoTarget} from '../public/miao-credential-core.js';
import {userError} from './workspace.mjs';
import {workspaceRoot} from './runtime-config.mjs';

const runFile = promisify(execFile);
const keychainReader = fileURLToPath(new URL('./miao-keychain-reader.py', import.meta.url));
const validKey = value => typeof value === 'string' && !!value.trim() &&
  value.trim().length <= 4096 && !/\s/.test(value.trim());

function discardOutput(result) {
  // Child stdout is a private pipe, never forwarded to a terminal or logger.
  for (const field of ['stdout', 'stderr']) {
    if (Buffer.isBuffer(result?.[field])) result[field].fill(0);
    try { if (result && typeof result === 'object') result[field] = ''; } catch {}
  }
}

function requireLocalTarget(platform, purpose) {
  if (!isLocalMiaoTarget(platform, {purpose})) throw userError('本机模型服务配置只用于已登记的 HTTPS 模型服务地址');
}

export function normalizeMiaoCredential(body, platform, {allowEmptyLocal = true, purpose = 'chat'} = {}) {
  const source = body?.credentialSource ?? 'manual';
  if (!['manual', 'miao-local'].includes(source)) throw userError('密钥来源无效');
  if (source === 'miao-local') {
    requireLocalTarget(platform, purpose);
    if (body.credentialConsent !== true) throw userError('请明确选择使用本机已有模型服务配置');
    if (body.apiKey !== undefined && body.apiKey !== '') throw userError('本机配置与本次填写的密钥不能同时使用');
    return {credentialSource: source, credentialConsent: true};
  }
  const value = body?.apiKey;
  let loopback = false;
  try { loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(platform.baseUrl).hostname); } catch {}
  if (typeof value !== 'string' || value.length > 4096 || /[\r\n]/.test(value) ||
      (!value.trim() && !(allowEmptyLocal && loopback))) throw userError('请填写有效的本次 API Key');
  return {credentialSource: 'manual', apiKey: value.trim()};
}

export function localMiaoCredentialService({env = process.env, platform = process.platform, execFileImpl = runFile} = {}) {
  const environmentKey = () => [env.MIAO_API_KEY, env.MIAOAPI_API_KEY].find(validKey);
  async function bridge(operation) {
    const configured = env.JINGCHANG_DIRECTOR_PYTHON;
    const python = configured === undefined || configured === '' ? path.resolve(workspaceRoot(env),'../../.venv/bin/python') : configured;
    if (typeof python !== 'string' || !path.isAbsolute(python) || /[\r\n\0]/.test(python)) {
      throw Object.assign(new Error('invalid credential runtime'), {code: 'ENOENT'});
    }
    // No request body can choose an executable, helper, service or account.
    // -I disables Python environment/path injection; -B avoids writing pycache.
    return execFileImpl(python, ['-I', '-B', keychainReader, operation],
      {timeout: 2500, maxBuffer: 8192, encoding: operation === 'resolve' ? 'buffer' : 'utf8'});
  }
  // The bridge passes NULL for passwordLength/passwordData for metadata only.
  async function status() {
    if (environmentKey()) return {configured: true, source: 'environment', checkedWithoutReadingSecret: true};
    if (platform !== 'darwin') return {configured: false, source: null, status: 'missing', checkedWithoutReadingSecret: true};
    let result;
    try {
      result = await bridge('metadata');
      const metadata = JSON.parse(result.stdout);
      if (!metadata || metadata.configured !== true || Object.keys(metadata).length !== 1) throw new Error('invalid credential metadata');
      return {configured: true, source: 'macos-keychain', checkedWithoutReadingSecret: true};
    } catch (error) {
      discardOutput(error);
      return {configured: false, source: null, status: error?.code === 44 ? 'missing' : 'unavailable', checkedWithoutReadingSecret: true};
    } finally { discardOutput(result); }
  }
  async function resolve(target, {purpose = 'chat'} = {}) {
    requireLocalTarget(target, purpose);
    const fromEnvironment = environmentKey();
    if (fromEnvironment) return {apiKey: fromEnvironment.trim(), source: 'environment'};
    if (platform !== 'darwin') throw userError('未找到本机模型服务配置；可改为本次填写密钥');
    let value = '', result;
    try {
      result = await bridge('resolve');
      value = Buffer.isBuffer(result.stdout) ? result.stdout.toString('utf8').trim() :
        typeof result.stdout === 'string' ? result.stdout.trim() : '';
    } catch (error) {
      discardOutput(error);
      // Captured subprocess errors may contain a secret; expose fixed text only.
      if (error?.code === 'ENOENT') throw userError('本机模型服务读取环境不可用；请检查已有 Python 配置，或改为本次填写密钥');
      throw userError('无法读取本机模型服务配置；请检查钥匙串访问，或改为本次填写密钥');
    } finally { discardOutput(result); }
    if (!validKey(value)) throw userError('本机模型服务配置无效；请检查配置或改为本次填写密钥');
    return {apiKey: value, source: 'macos-keychain'};
  }
  return {status, resolve};
}

export async function resolveMiaoCredential(credential, platform, service, {purpose = 'chat'} = {}) {
  const normalized = normalizeMiaoCredential(credential, platform, {purpose});
  if (normalized.credentialSource === 'miao-local') {
    if (typeof service?.resolve !== 'function') throw userError('本机模型服务配置服务不可用；可改为本次填写密钥');
    return service.resolve(platform, {purpose});
  }
  return {apiKey: normalized.apiKey, source: 'manual'};
}
