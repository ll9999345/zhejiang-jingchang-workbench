import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {isLocalArkTarget} from '../public/ark-credential-core.js';
import {isLocalStudioServiceTarget,studioServiceTarget} from '../public/studio-service-core.js';
import {normalizeMiaoCredential,resolveMiaoCredential} from './miao-credentials.mjs';
import {userError} from './workspace.mjs';

const runFile = promisify(execFile);
const serviceName = 'ARK_API_KEY';
const validKey = value => typeof value === 'string' && !!value.trim() &&
  value.trim().length <= 4096 && !/[\r\n]/.test(value.trim());

export function normalizeStudioCredential(body, studio, {allowEmptyLocal = true} = {}) {
  const source = body?.credentialSource ?? 'manual';
  if (source === 'miao-local') {
    if (!isLocalStudioServiceTarget(studio)) throw userError('本机模型服务配置只用于已登记的 HTTPS 模型服务地址');
    return normalizeMiaoCredential(body, studioServiceTarget(studio), {purpose: studio.mode});
  }
  if (!['manual', 'ark-local'].includes(source)) throw userError('密钥来源无效');
  if (source === 'ark-local') {
    if (!isLocalArkTarget(studio)) throw userError('本机火山配置只用于火山北京官方视频接口');
    if (body.credentialConsent !== true) throw userError('请明确选择使用本机已有火山配置');
    if (body.apiKey) throw userError('本机配置与本次填写的密钥不能同时使用');
    return {credentialSource: source, credentialConsent: true};
  }
  const value = body?.apiKey;
  let loopback = false;
  try { loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(studio.config.baseUrl).hostname); } catch {}
  if (typeof value !== 'string' || value.length > 4096 || /[\r\n]/.test(value) ||
      (!value.trim() && !(allowEmptyLocal && loopback))) throw userError('请填写有效的本次 API Key');
  return {credentialSource: 'manual', apiKey: value.trim()};
}

export function localArkCredentialService({env = process.env, platform = process.platform, execFileImpl = runFile} = {}) {
  // Metadata lookup deliberately omits -w/-g. Captured attributes are discarded.
  async function status() {
    if (validKey(env.ARK_API_KEY)) return {configured: true, source: 'environment', checkedWithoutReadingSecret: true};
    if (platform !== 'darwin') return {configured: false, source: null, status: 'missing', checkedWithoutReadingSecret: true};
    try {
      await execFileImpl('/usr/bin/security', ['find-generic-password', '-s', serviceName],
        {timeout: 2500, maxBuffer: 8192, encoding: 'utf8'});
      return {configured: true, source: 'macos-keychain', checkedWithoutReadingSecret: true};
    } catch (error) {
      return {configured: false, source: null, status: error?.code === 44 ? 'missing' : 'unavailable', checkedWithoutReadingSecret: true};
    }
  }
  async function resolve(studio) {
    if (!isLocalArkTarget(studio)) throw userError('本机火山配置只用于火山北京官方视频接口');
    if (validKey(env.ARK_API_KEY)) return {apiKey: env.ARK_API_KEY.trim(), source: 'environment'};
    if (platform !== 'darwin') throw userError('未找到本机火山配置；可改为本次填写密钥');
    let value = '';
    try {
      const result = await execFileImpl('/usr/bin/security', ['find-generic-password', '-s', serviceName, '-w'],
        {timeout: 2500, maxBuffer: 8192, encoding: 'utf8'});
      value = typeof result.stdout === 'string' ? result.stdout.trim() : '';
    } catch {
      // Subprocess errors can include captured secret output; never expose them.
      throw userError('无法读取本机火山配置；请检查钥匙串访问，或改为本次填写密钥');
    }
    if (!validKey(value)) throw userError('本机火山配置无效；请检查配置或改为本次填写密钥');
    return {apiKey: value, source: 'macos-keychain'};
  }
  return {status, resolve};
}

export async function resolveStudioCredential(credential, studio, service, miaoService) {
  if (credential.credentialSource === 'ark-local') return service.resolve(studio);
  if (credential.credentialSource === 'miao-local') {
    if (!isLocalStudioServiceTarget(studio)) throw userError('本机模型服务配置只用于已登记的 HTTPS 模型服务地址');
    return resolveMiaoCredential(credential, studioServiceTarget(studio), miaoService, {purpose: studio.mode});
  }
  return {apiKey: credential.apiKey, source: 'manual'};
}
