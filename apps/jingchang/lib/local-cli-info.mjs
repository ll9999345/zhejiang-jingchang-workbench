import {offlineCliInfo} from './cli-info-sandbox.mjs';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { resolveLocalCli } from './local-cli-status.mjs';
import { localCliHelpTopics } from '../public/local-cli-core.js';
import { userError } from './workspace.mjs';

const OUTPUT_LIMIT = 64 * 1024;
const environmentKeys = ['PATH', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'PATHEXT', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP'];
function infoEnvironment(env) {
  const result = { NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb', COLUMNS: '100' };
  for (const key of environmentKeys) if (typeof env[key] === 'string') result[key] = env[key];
  return result;
}
export function cleanCliInfo(text) {
  return stripVTControlCharacters(String(text))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[已隐藏密钥]')
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [已隐藏密钥]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[已隐藏令牌]')
    .replace(/((?:[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|authorization)\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1[已隐藏凭据]').trim();
}

function runInfo(executable, args, { cwd, env, platform, signal, timeoutMs, outputLimit }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(userError('已停止查看本机工具信息', 499));
    let child, timeout, escalation, error, total = 0, finished = false;
    const stdout = [], stderr = [];
    const terminate = e => {
      if (finished || error) return;
      error = e;
      const kill = action => {
        try { if (platform !== 'win32' && child?.pid) process.kill(-child.pid, action); else child?.kill(action); } catch {}
      };
      kill('SIGTERM');
      escalation = setTimeout(() => kill('SIGKILL'), 500);
      escalation.unref();
    };
    const abort = () => terminate(userError('已停止查看本机工具信息', 499));
    const finish = (e, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout); if(!e)clearTimeout(escalation);
      signal?.removeEventListener('abort', abort);
      if (e) reject(e); else resolve(result);
    };
    try {
      child = spawn(executable, args, { cwd, env: infoEnvironment(env), shell: false, windowsHide: true, detached: platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { return finish(userError('本机工具无法启动，请核对程序安装和路径', 502)); }
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    timeout = setTimeout(() => terminate(userError('本机工具信息读取超时，已停止等待；不会自动重试', 504)), timeoutMs);
    timeout.unref();
    const collect = parts => chunk => {
      total += chunk.length;
      if (total > outputLimit) return terminate(userError('本机工具返回的信息超过64KB，已停止读取', 502));
      if (!error) parts.push(chunk);
    };
    child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
    child.once('error', () => finish(userError('本机工具无法启动，请核对程序安装和路径', 502)));
    child.once('close', (code) => {
      if (error) return finish(error);
      if (code !== 0) return finish(userError('此版本未成功返回所选信息，请先查看总览帮助或核对安装；不会自动重试', 502));
      const text = cleanCliInfo(Buffer.concat(stdout).toString('utf8') || Buffer.concat(stderr).toString('utf8'));
      if (!text) return finish(userError('本机工具没有返回版本或帮助信息', 502));
      finish(null, text);
    });
  });
}

export function localCliInfoService({ env = process.env, platform = process.platform, timeoutMs, outputLimit = OUTPUT_LIMIT, workingDirectory, resolveTool = resolveLocalCli } = {}) {
  let busy = false, directory;
  async function read(id, action, payload, { signal } = {}) {
    if (!['codex','gemini-cli','jimeng'].includes(id)) throw userError('未知的本机工具');
    if (!['version', 'help'].includes(action)) throw userError('只支持查看本机工具版本和帮助');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.consent !== true) throw userError('请确认本次仅执行版本或帮助查看');
    const keys = action === 'help' ? ['consent', 'command'] : ['consent'];
    if (Object.keys(payload).some(key => !keys.includes(key))) throw userError('本机工具信息请求含不支持的字段');
    const command = payload.command === undefined ? '' : payload.command;
    if (typeof command !== 'string' || command.length > 80 || command !== command.trim()) throw userError('帮助主题无效');
    if (busy) throw userError('已有本机工具信息正在读取，请等待完成后再试', 409);
    busy = true;
    try {
      const tool = await resolveTool(id, { env, platform });
      if (tool.unsupportedWsl) throw userError('WSL 内的即梦版本和帮助尚未接入；本机状态仍可检查', 501);
      if (!tool.executable) throw userError('本机未找到对应程序，请在完成安装后刷新；工作台不会自动安装', 404);
      if (platform === 'win32' && /\.(cmd|bat)$/i.test(tool.executable)) throw userError('此 Windows 脚本入口暂不执行，请配置原生可执行文件后重试', 501);
      if (action === 'help' && !localCliHelpTopics(id, tool.variant).some(topic => topic.command === command)) throw userError('不允许的本机工具帮助主题');
      const args = action === 'version' ? ['--version'] : [...(command ? [command] : []), id === 'jimeng' ? '-h' : '--help'];
      directory ||= workingDirectory ? Promise.resolve(workingDirectory) : fs.mkdtemp(path.join(os.tmpdir(), 'jingchang-cli-info-'));
      const cwd=await directory,callDirectory=await fs.mkdtemp(path.join(cwd,'read-'));
      const invocation=id==='jimeng'&&tool.managed?await offlineCliInfo(tool.executable,args,{cwd:callDirectory,home:env.HOME||os.homedir(),platform}):{executable:tool.executable,arguments:args,offline:false};
      const text = await runInfo(invocation.executable, invocation.arguments, { cwd:invocation.offline?callDirectory:cwd, env, platform, signal, timeoutMs: timeoutMs ?? (action === 'version' ? 10000 : 20000), outputLimit });
      let version=text.split(/\r?\n/)[0].slice(0,300);if(action==='version'&&id==='jimeng'){try{const p=JSON.parse(text);if(typeof p.version==='string'&&/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(p.version))version=p.version;}catch{}}

      return { success: true, id, name: tool.label, executable: path[platform === 'win32' ? 'win32' : 'posix'].basename(tool.executable), variant: tool.variant, action, command, arguments: args, text, ...(action === 'version' ? { version } : {}), offline:invocation.offline,loggedIn: null, accountChecked: false, checkedAt: new Date().toISOString() };
    } finally { busy = false; }
  }
  return { read };
}
