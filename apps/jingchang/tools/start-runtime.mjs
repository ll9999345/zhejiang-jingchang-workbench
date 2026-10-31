import {promises as fs} from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {runtimeLaunchPlan} from './runtime-releases.mjs';

export async function readRuntimeSelection(workspace) {
  const file = path.join(workspace, 'runtime-selection.json');
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > 4096) throw Error('版本选择文件无效');
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
export async function startWorkspaceRuntime({workspace, port = 4768, dataDir, env = process.env, startupTimeout = 25000, handoffId} = {}) {
  try {
    const lease = JSON.parse(await fs.readFile(path.join(workspace, '.runtime-handoff.lock'), 'utf8'));
    if (!handoffId || lease.id !== handoffId) throw Error('镜场正在切换版本，请等待当前切换结束');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const selection = await readRuntimeSelection(workspace);
  const plan = await runtimeLaunchPlan({workspace, selection, port, dataDir, env});
  const probe = net.createServer();
  await new Promise((resolve, reject) => {probe.once('error', reject); probe.listen({port, host: '127.0.0.1', exclusive: true}, resolve);});
  await new Promise(resolve => probe.close(resolve));
  await fs.mkdir(plan.data, {recursive: true});
  const log = await fs.open(path.join(plan.data, 'server.log'), 'a', 0o600), instance = randomUUID();
  let child, spawnError;
  try {
    child = spawn(process.execPath, plan.args, {cwd: plan.directory, env: {...plan.env, JINGCHANG_RUNTIME_INSTANCE: instance}, detached: true, stdio: ['ignore', log.fd, log.fd]});
    child.on('error', error => {spawnError = error;});
  } finally { await log.close(); }
  try {
    const deadline = Date.now() + startupTimeout;
    while (Date.now() < deadline) {
      if (spawnError || child.exitCode !== null || child.signalCode !== null) throw Error('所选版本未能启动；请查看本机启动日志');
      let health;
      try { const response = await fetch(`http://127.0.0.1:${port}/api/health`, {signal: AbortSignal.timeout(1500)}); if (response.ok) health = await response.json(); } catch {}
      if (health?.runtimeInstance === instance && (!plan.appVersion || health.version === plan.appVersion)) {
        const pending = path.join(plan.data, 'server.pid.' + instance + '.pending');
        await fs.writeFile(pending, String(child.pid), {flag: 'wx', mode: 0o600});
        await fs.rename(pending, path.join(plan.data, 'server.pid'));
        child.unref();
        return {pid: child.pid, instance, port, version: health.version, storedMedia: health.capabilities.smartGroupStoredMedia};
      }
      await new Promise(resolve => setTimeout(resolve, 75));
    }
    throw Error('所选版本启动未得到确认；未自动切换其他版本');
  } catch (error) {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit'); child.kill('SIGTERM');
      await Promise.race([stopped, new Promise(resolve => setTimeout(resolve, 2000).unref())]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await Promise.race([stopped, new Promise((_, reject) => setTimeout(() => reject(Error('本次启动进程尚未退出，请检查端口')), 5000).unref())]);
      }
    }
    throw error;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const result = await startWorkspaceRuntime({workspace});
    console.log(`镜场 ${result.version} 已启动，端口 ${result.port}。`);
  } catch (error) { console.error(error.code === 'EADDRINUSE' ? '镜场端口已被使用，未停止或替换已有服务。' : error.message); process.exitCode = 1; }
}
