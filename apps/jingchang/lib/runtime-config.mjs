import path from 'node:path';
import {promises as fs} from 'node:fs';
import {fileURLToPath} from 'node:url';

export const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modes = new Set(['legacy', 'versioned']);
export function workspaceRoot(env = process.env, fallback = runtimeRoot) {
  const value = env.JINGCHANG_WORKSPACE_ROOT ?? fallback;
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw Error('镜场工作区必须是本机绝对路径');
  return path.resolve(value);
}
export function validateRuntimeConfig(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'nativeMediaMode,version' || value.version !== 1 || !modes.has(value.nativeMediaMode)) throw Error('镜场运行配置无效，未启动或迁移数据');
  return {...value};
}
export async function nativeMediaRuntime({root = runtimeRoot, env = process.env} = {}) {
  const file = path.join(root, 'runtime-config.json');
  let config;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > 4096) throw Error('镜场运行配置必须是普通小文件');
    config = validateRuntimeConfig(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const explicit = env.JINGCHANG_NATIVE_MEDIA_MODE;
  if (explicit !== undefined && !modes.has(explicit)) throw Error('镜场素材规则只支持 legacy 或 versioned');
  const test = env.JINGCHANG_SMART_GROUP_MEDIA_TEST;
  if (test !== undefined && !['0', '1'].includes(test)) throw Error('镜场验收开关无效');
  const mode = explicit ?? (test === undefined ? config?.nativeMediaMode ?? 'legacy' : test === '1' ? 'versioned' : 'legacy');
  return {mode, storedMedia: mode === 'versioned'};
}
