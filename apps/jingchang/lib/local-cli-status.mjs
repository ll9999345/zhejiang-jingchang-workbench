import {projectDreamina} from './project-cli.mjs';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { localCliHelpTopics } from '../public/local-cli-core.js';

const definitions = [
  { id: 'codex', label: 'OpenAI Codex CLI', command: 'codex', envKeys: ['CODEX_BIN'] },
  { id: 'gemini-cli', label: 'Gemini / Antigravity CLI', commands: ['agy', 'gemini'], envKeys: ['ANTIGRAVITY_BIN', 'AGY_BIN', 'GEMINI_BIN'] },
  { id: 'jimeng', label: '即梦 CLI（dreamina）', command: 'dreamina', envKeys: ['JIMENG_BIN', 'DREAMINA_BIN'] },
];

const truthy = value => ['1', 'true', 'yes', 'on', 'wsl'].includes(String(value || '').trim().toLowerCase());

function commandCandidates(command, { platform, pathApi, pathext }) {
  if (platform !== 'win32') return [command];
  if (pathApi.extname(command)) return [command];
  return [command, ...pathext.map(extension => `${command}${extension}`)];
}

async function isRunnable(file, { platform, statFile, accessFile }) {
  try {
    const info = await statFile(file);
    if (!info.isFile()) return false;
    if (platform === 'win32') return true;
    await accessFile(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findExecutable(command, {
  env,
  platform,
  pathEnv,
  pathDelimiter,
  pathApi,
  pathext,
  statFile,
  accessFile,
}) {
  const dirs = String(pathEnv || '').split(pathDelimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of commandCandidates(command, { platform, pathApi, pathext })) {
      const candidate = pathApi.join(dir, name);
      if (await isRunnable(candidate, { platform, statFile, accessFile })) return candidate;
    }
  }
  return '';
}

async function resolveTool(definition, options) {
  const { env, platform, pathApi, pathext } = options;
  for (const key of definition.envKeys || []) {
    const configured = String(env[key] || '').trim().replace(/^(["'])(.*)\1$/, '$2');
    if (!configured) continue;
    const looksLikePath = pathApi.isAbsolute(configured) || configured.includes('/') || configured.includes('\\');
    if (looksLikePath) {
      const candidate = pathApi.isAbsolute(configured) ? configured : pathApi.resolve(configured);
      if (await isRunnable(candidate, options)) return { executable: candidate, variant: definition.id === 'gemini-cli' ? key === 'GEMINI_BIN' ? 'gemini' : 'antigravity' : definition.id };
    } else {
      const found = await findExecutable(configured, { ...options, pathext });
      if (found) return { executable: found, variant: definition.id === 'gemini-cli' ? key === 'GEMINI_BIN' ? 'gemini' : 'antigravity' : definition.id };
    }
  }
  for (const command of definition.commands || [definition.command]) {
    const found = await findExecutable(command, { ...options, pathext });
    if (found) return { executable: found, variant: definition.id === 'gemini-cli' ? command === 'agy' ? 'antigravity' : 'gemini' : definition.id };
  }
  if(definition.id==='jimeng'&&options.allowManaged){const managed=await projectDreamina({root:options.managedRoot,platform:options.platform,arch:options.arch});if(managed)return managed;}
  return { executable: '', variant: definition.id === 'gemini-cli' ? 'gemini' : definition.id };
}

function makeOptions({ env = process.env, platform = process.platform, pathEnv = env.PATH, statFile = stat, accessFile = access, managedRoot, allowManaged=env===process.env, arch=process.arch } = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const pathext = String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';').map(value => value.trim().toLowerCase()).filter(Boolean);
  return {
    env,
    platform,
    managedRoot,allowManaged,arch,
    pathEnv,
    pathDelimiter: platform === 'win32' ? ';' : ':',
    pathApi,
    pathext,
    statFile,
    accessFile,
  };
}

function basename(file, options) {
  return file ? options.pathApi.basename(file) : null;
}

async function statusForDefinition(definition, opts) {
  if (definition.id === 'jimeng' && truthy(opts.env.JIMENG_USE_WSL)) {
    const bridge = await findExecutable('wsl.exe', opts) || await findExecutable('wsl', opts);
    return {
      id: definition.id,
      name: definition.label,
      installed: null,
      executable: basename(bridge, opts),
      version: null,
      loggedIn: null,
      accountChecked: false,
      infoAvailable: false,
      message: bridge
        ? '已找到 WSL 入口；未扫描 WSL 内的 dreamina，也未查询登录状态或积分。'
        : '已配置 WSL 模式，但没有找到 WSL 入口；未查询登录状态或积分。',
    };
  }

  const { executable, variant,managed,capabilities } = await resolveTool(definition, opts);
  const infoAvailable = Boolean(executable) && !(opts.platform === 'win32' && /\.(cmd|bat)$/i.test(executable));
  return {
    id: definition.id,
    name: definition.label,
    installed: Boolean(executable),
    executable: basename(executable, opts),
    version: null,
    loggedIn: null,
    accountChecked: false,
    infoAvailable,
    variant,
    ...(managed?{projectManaged:managed,capabilities}:{}),
    helpTopics: localCliHelpTopics(definition.id, variant),
    message: executable && !infoAvailable
      ? `已找到 ${basename(executable, opts)}；此 Windows 脚本入口暂仅检查文件，不执行版本或帮助。`
      : managed
      ? `已校验项目内 dreamina ${managed.version}；未执行程序，登录和账户未检查。`
      : executable
      ? `已在本机路径中找到 ${basename(executable, opts)}；未执行 CLI、未读取登录信息或查询账户。`
      : `本机路径中未找到 ${definition.command || definition.commands.join(' / ')}；未执行安装或登录。`,
  };
}

export async function localCliStatuses(options = {}) {
  const opts = makeOptions(options);
  return Promise.all(definitions.map(definition => statusForDefinition(definition, opts)));
}

export async function localCliStatus(id, options = {}) {
  const definition = definitions.find(item => item.id === id);
  if (!definition) throw new Error('未知的本机 CLI');
  return statusForDefinition(definition, makeOptions(options));
}

// Private resolution used by the fixed-argument runner; do not expose full paths in APIs.
export async function resolveLocalCli(id, options = {}) {
  const definition = definitions.find(item => item.id === id);
  if (!definition) throw new Error('未知的本机 CLI');
  const opts = makeOptions(options);
  if (id === 'jimeng' && truthy(opts.env.JIMENG_USE_WSL)) return { ...definition, executable: '', unsupportedWsl: true, platform: opts.platform };
  return { ...definition, ...await resolveTool(definition, opts), platform: opts.platform };
}
