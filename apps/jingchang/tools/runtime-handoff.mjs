import {promises as fs, createReadStream} from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash, randomUUID} from 'node:crypto';
import {runtimeLaunchPlan} from './runtime-releases.mjs';
import {startWorkspaceRuntime} from './start-runtime.mjs';

const run = promisify(execFile), wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const commandEnv = {...process.env, LC_ALL: 'en_US.UTF-8'};
const active = new Set(['queued', 'running', 'preparing', 'pending', 'submitting', 'awaiting_input', 'awaiting-confirmation', 'copying', 'cropping', 'executing', 'importing', 'in_progress', 'inserting', 'receiving', 'saving', 'sending', 'stopping', 'submitted', 'uploading']);
const operational = name => name === 'server.pid' || name === 'server.log';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function readOptional(file) {try {return await fs.readFile(file);} catch (error) {if (error.code === 'ENOENT') return null; throw error;}}
export async function listenerPids(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('切换端口无效');
  try {
    const {stdout} = await run('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-Fp'], {env: commandEnv});
    return [...new Set(stdout.split('\n').filter(s => /^p\d+$/.test(s)).map(s => Number(s.slice(1))))];
  } catch (error) {if (error.code === 1 && !error.stdout) return []; throw error;}
}
export async function inspectOwnedServer({pid, port, cwd, entry}) {
  if (!Number.isSafeInteger(pid) || pid < 2 || !path.isAbsolute(cwd) || !path.isAbsolute(entry) || path.basename(entry) !== 'server.mjs') throw Error('待切换进程描述无效');
  cwd = await fs.realpath(cwd); entry = await fs.realpath(entry);
  const listeners = await listenerPids(port);
  if (listeners.length !== 1 || listeners[0] !== pid) throw Error('端口进程与已核实进程不一致，未停止');
  const [{stdout: command}, {stdout: startedAt}, {stdout: files}] = await Promise.all([
    run('ps', ['-ww', '-p', String(pid), '-o', 'command='], {env: commandEnv}),
    run('ps', ['-p', String(pid), '-o', 'lstart='], {env: commandEnv}),
    run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {env: commandEnv}),
  ]);
  const actualCwd = files.split('\n').find(s => s.startsWith('n'))?.slice(1), text = command.trim();
  const entries = [entry, ...(path.dirname(entry) === cwd ? ['server.mjs'] : [])];
  if (actualCwd !== cwd || !entries.some(file => [process.execPath + ' ' + file, 'node ' + file].includes(text)) || !startedAt.trim()) throw Error('进程工作目录或启动命令不匹配，未停止');
  return {pid, port, cwd, entry, startedAt: startedAt.trim(), commandHash: digest(text)};
}
async function assertIdentity(expected) {
  const now = await inspectOwnedServer(expected);
  if (JSON.stringify(now) !== JSON.stringify(expected)) throw Error('原进程身份发生变化，未停止');
}
export async function workspaceDataState(data) {
  const files = {}, activeRecords = [];
  async function visit(directory) {
    for (const item of (await fs.readdir(directory, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, item.name), rel = path.relative(data, file).split(path.sep).join('/');
      if (item.isDirectory()) {await visit(file); continue;}
      if (!item.isFile()) throw Error('数据目录存在非普通文件，需先核对再切换');
      if (operational(rel)) continue;
      const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); files[rel] = hash.digest('hex');
      // Read only task-bearing metadata, never config, credentials, project text
      // or media. Status checks do not refresh or resume any remote task.
      if (rel.endsWith('.json') && !/^(?:projects|assets|templates|workflows|prompts)\//.test(rel) && rel.includes('/') && !/credential|secret|token/i.test(rel)) {
        const stat = await fs.stat(file); if (stat.size > 16 * 1024 * 1024) throw Error('任务记录过大，需先核对再切换');
        let record; try {record = JSON.parse(await fs.readFile(file, 'utf8'));} catch {throw Error('任务记录无法读取，需先核对再切换');}
        if (active.has(record?.status)) activeRecords.push({path: rel, status: record.status});
      }
    }
  }
  await visit(data);
  return {files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))), activeRecords};
}
async function health(port) {
  const response = await fetch('http://127.0.0.1:' + port + '/api/health', {signal: AbortSignal.timeout(10000)});
  if (!response.ok) throw Error('原服务健康检查未通过');
  const value = await response.json();
  return {version: value.version, instance: value.runtimeInstance ?? null, storedMedia: value.capabilities?.smartGroupStoredMedia === true};
}
async function stopOwned(identity) {
  await assertIdentity(identity); process.kill(identity.pid, 'SIGTERM');
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const listeners = await listenerPids(identity.port);
    if (!listeners.length) return;
    if (listeners.some(pid => pid !== identity.pid)) throw Error('端口由其他进程接管，未继续切换');
    await wait(100);
  }
  throw Error('原服务未正常停止，未强制结束或启动第二个服务');
}
async function writeSelection(workspace, next, expectedBytes, id) {
  const file = path.join(workspace, 'runtime-selection.json'), previous = await readOptional(file);
  if (!Buffer.from(previous ?? '').equals(Buffer.from(expectedBytes ?? ''))) throw Error('版本选择被其他操作改变，未覆盖');
  const bytes = Buffer.from(JSON.stringify(next, null, 2) + '\n'), pending = file + '.' + id + '.' + randomUUID() + '.pending';
  await fs.writeFile(pending, bytes, {flag: 'wx', mode: 0o600}); await fs.rename(pending, file); return bytes;
}
export async function handoffRuntime({workspace, port, expected, expectedVersion, candidate, fallback, evidence, env = process.env, startupTimeout = 25000}) {
  workspace = await fs.realpath(workspace); evidence = path.resolve(evidence);
  if (evidence === workspace || !evidence.startsWith(workspace + path.sep)) throw Error('切换记录必须位于本机工作区内');
  await fs.mkdir(evidence, {recursive: false, mode: 0o700});
  const id = randomUUID(), data = path.join(workspace, 'data'), leaseFile = path.join(workspace, '.runtime-handoff.lock');
  const report = {id, startedAt: new Date().toISOString(), status: 'preparing', port, priorPid: expected?.pid, candidate, fallback, externalCalls: 0};
  const persist = () => fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
  let lease, stopped = false, current, selectionBytes, originalSelection;
  try {
    lease = await fs.open(leaseFile, 'wx', 0o600); await lease.writeFile(JSON.stringify({id, pid: process.pid, startedAt: report.startedAt})); await lease.close();
    originalSelection = await readOptional(path.join(workspace, 'runtime-selection.json')); selectionBytes = originalSelection;
    await fs.writeFile(path.join(evidence, 'previous-selection.json'), originalSelection ?? 'null\n', {flag: 'wx', mode: 0o600});
    const candidatePlan = await runtimeLaunchPlan({workspace, selection: candidate, port, env}), fallbackPlan = await runtimeLaunchPlan({workspace, selection: fallback, port, env});
    if (candidatePlan.env.JINGCHANG_NATIVE_MEDIA_MODE !== 'versioned' || fallbackPlan.env.JINGCHANG_NATIVE_MEDIA_MODE !== 'versioned') throw Error('切换与保留版本都必须支持新版工程，不能用旧规则代替回退');
    await assertIdentity(expected);
    const beforeHealth = await health(port); if (beforeHealth.version !== expectedVersion) throw Error('原服务版本发生变化，未停止');
    const before = await workspaceDataState(data); if (before.activeRecords.length) throw Error('仍有未结束操作，未停止原服务');
    await fs.writeFile(path.join(evidence, 'data-before.json'), JSON.stringify(before.files, null, 2), {flag: 'wx', mode: 0o600});
    const latest = await workspaceDataState(data); if (latest.activeRecords.length || JSON.stringify(latest.files) !== JSON.stringify(before.files)) throw Error('准备期间数据或任务发生变化，未停止原服务');
    if (!Buffer.from(await readOptional(path.join(workspace, 'runtime-selection.json')) ?? '').equals(Buffer.from(originalSelection ?? ''))) throw Error('原版本选择发生变化，未停止');
    report.status = 'stopping'; report.beforeHealth = beforeHealth; report.dataFiles = Object.keys(before.files).length; await persist();
    await stopOwned(expected); stopped = true;
    const afterStop = await workspaceDataState(data);
    if (afterStop.activeRecords.length || JSON.stringify(afterStop.files) !== JSON.stringify(before.files)) throw Error('停止交接时数据发生变化，保留最新文件并恢复保留版本');
    selectionBytes = await writeSelection(workspace, candidate, selectionBytes, id); report.status = 'starting'; await persist();
    current = await startWorkspaceRuntime({workspace, port, env, startupTimeout, handoffId: id});
    const identity = await inspectOwnedServer({pid: current.pid, port, cwd: candidatePlan.directory, entry: candidatePlan.args[0]});
    if (current.version !== candidatePlan.appVersion || current.storedMedia !== true) throw Error('候选版本能力未确认');
    report.newProcess = identity; report.runtime = current;
    const after = await workspaceDataState(data); await fs.writeFile(path.join(evidence, 'data-after.json'), JSON.stringify(after.files, null, 2), {flag: 'wx', mode: 0o600});
    report.businessDataUnchanged = JSON.stringify(after.files) === JSON.stringify(before.files);
    // A new browser may legitimately save after startup. Never roll it back or
    // overwrite it to make a checksum pass; report the changed state for review.
    report.status = 'completed'; report.completedAt = new Date().toISOString(); await persist(); return report;
  } catch (error) {
    report.error = error.code === 'EEXIST' ? '已有切换记录或切换锁，未重复执行' : error.message;
    if (stopped) {
      try {
        if (current) {
          const plan = await runtimeLaunchPlan({workspace, selection: candidate, port, env});
          await stopOwned(await inspectOwnedServer({pid: current.pid, port, cwd: plan.directory, entry: plan.args[0]}));
        }
        if ((await listenerPids(port)).length) throw Error('端口尚被占用，未停止未知服务或覆盖选择');
        selectionBytes = await writeSelection(workspace, fallback, selectionBytes, id);
        const restored = await startWorkspaceRuntime({workspace, port, env, startupTimeout, handoffId: id});
        const plan = await runtimeLaunchPlan({workspace, selection: fallback, port, env});
        report.restoredProcess = await inspectOwnedServer({pid: restored.pid, port, cwd: plan.directory, entry: plan.args[0]});
        report.runtime = restored; report.status = 'restored'; report.latestDataPreserved = true;
      } catch (recoveryError) {report.status = 'recovery-required'; report.recoveryError = recoveryError.message;}
    } else report.status = 'refused';
    await persist();
    if (report.status === 'restored') return report;
    throw Object.assign(Error(report.error), {report});
  } finally {
    if (lease) {
      // Keep the completed lease as an audit record; never remove stale locks.
      let owner; try {owner = JSON.parse(await fs.readFile(leaseFile, 'utf8'));} catch {}
      if (owner?.id === id) await fs.rename(leaseFile, path.join(workspace, `.runtime-handoff.${id}.${report.status}.json`));
    }
  }
}
