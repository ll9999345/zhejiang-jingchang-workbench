import {promises as fs, constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {validateRuntimeConfig, workspaceRoot} from '../lib/runtime-config.mjs';
import {projectDreamina} from '../lib/project-cli.mjs';

const entries = ['server.mjs', 'package.json', 'package-lock.json', 'lib', 'public', 'resources', 'node_modules'];
const managed = ['.tools/dreamina/managed.json', '.tools/dreamina/1.4.20/darwin-amd64/dreamina'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (base, file) => file.startsWith(base + path.sep);
const relative = value => typeof value === 'string' && value.length < 2048 && !/[\\\x00-\x1f\x7f]/.test(value) && !path.isAbsolute(value) && value.split('/').every(p => p && p !== '.' && p !== '..');
const allowed = value => relative(value) && (entries.some(p => value === p || value.startsWith(p + '/')) || managed.includes(value) || value === 'runtime-config.json');
async function walk(root, rel = '') {
  const file = path.join(root, rel), stat = await fs.lstat(file);
  if (stat.isSymbolicLink()) throw Error('版本快照不接受符号链接：' + rel);
  if (stat.isFile()) {
    if (rel.split('/').some(p => p === '.env' || p.startsWith('.env.'))) throw Error('版本快照不包含私密配置');
    return [rel];
  }
  if (!stat.isDirectory()) throw Error('版本快照仅支持普通文件和目录');
  const result = [];
  for (const name of (await fs.readdir(file)).sort()) result.push(...await walk(root, rel ? rel + '/' + name : name));
  return result;
}
async function fingerprint(root, files) {
  const rows = {};
  const sorted = [...files].sort();
  // Bound simultaneous reads; retain deterministic manifest ordering.
  for (let i = 0; i < sorted.length; i += 16) {
    const batch = await Promise.all(sorted.slice(i, i + 16).map(async rel => {
      if (!relative(rel)) throw Error('版本文件路径无效');
      const file = path.join(root, rel), stat = await fs.lstat(file);
      if (!stat.isFile() || await fs.realpath(file) !== file) throw Error('版本文件不是独立普通文件：' + rel);
      return [rel, {sha256: hash(await fs.readFile(file)), size: stat.size, mode: stat.mode & 0o777}];
    }));
    for (const [rel, value] of batch) rows[rel] = value;
  }
  return rows;
}
async function sourceFiles(root) {
  const files = [];
  for (const entry of entries) files.push(...await walk(root, entry));
  try {
    await fs.lstat(path.join(root, '.tools/dreamina'));
    if (!await projectDreamina({root})) throw Error('项目内 Dreamina 安装校验失败，未制作不完整版本');
    files.push(...managed);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return files;
}
export async function captureRuntime({source, destination, nativeMediaMode}) {
  const config = validateRuntimeConfig({version: 1, nativeMediaMode});
  source = await fs.realpath(source); destination = path.resolve(destination);
  const files = await sourceFiles(source), before = await fingerprint(source, files);
  // Never merge into or replace an existing directory. Failed preparations stay
  // available for diagnosis and cannot be selected without a final manifest.
  await fs.mkdir(destination, {recursive: false, mode: 0o700});
  if (await fs.realpath(destination) !== destination) throw Error('版本目标不能经过符号链接');
  for (const rel of files) {
    const target = path.join(destination, rel);
    await fs.mkdir(path.dirname(target), {recursive: true});
    await fs.copyFile(path.join(source, rel), target, constants.COPYFILE_EXCL);
    await fs.chmod(target, before[rel].mode);
  }
  if (JSON.stringify(await fingerprint(source, await sourceFiles(source))) !== JSON.stringify(before)) throw Error('制作期间源代码已变化，未封存版本');
  if (JSON.stringify(await fingerprint(destination, files)) !== JSON.stringify(before)) throw Error('版本副本不一致，未封存');
  await fs.writeFile(path.join(destination, 'runtime-config.json'), JSON.stringify(config, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  const pkg = JSON.parse(await fs.readFile(path.join(destination, 'package.json'), 'utf8'));
  const manifest = {format: 1, appVersion: pkg.version, nativeMediaMode, platform: process.platform, arch: process.arch, nodeMajor: Number(process.versions.node.split('.')[0]), files: await fingerprint(destination, [...files, 'runtime-config.json'])};
  const bytes = JSON.stringify(manifest, null, 2) + '\n';
  await fs.writeFile(path.join(destination, 'runtime-manifest.json'), bytes, {flag: 'wx', mode: 0o600});
  const manifestSha256 = hash(bytes);
  await verifyRuntime({directory: destination, manifestSha256});
  return {directory: destination, manifestSha256, appVersion: manifest.appVersion, nativeMediaMode, files: Object.keys(manifest.files).length};
}
export async function verifyRuntime({directory, manifestSha256}) {
  directory = path.resolve(directory);
  if (await fs.realpath(directory) !== directory || !/^[a-f0-9]{64}$/.test(manifestSha256 || '')) throw Error('版本目录或封存摘要无效');
  const manifestFile = path.join(directory, 'runtime-manifest.json'), stat = await fs.lstat(manifestFile);
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw Error('版本清单无效');
  const bytes = await fs.readFile(manifestFile);
  if (hash(bytes) !== manifestSha256) throw Error('版本清单已经改变，拒绝启动');
  const m = JSON.parse(bytes);
  if (m.format !== 1 || !m.files || !Object.keys(m.files).length || Object.keys(m.files).length > 20000 || m.platform !== process.platform || m.arch !== process.arch || m.nodeMajor !== Number(process.versions.node.split('.')[0])) throw Error('版本格式或运行环境不匹配');
  const files = Object.keys(m.files).sort();
  if (!files.every(allowed) || !['server.mjs', 'package.json', 'package-lock.json', 'runtime-config.json'].every(p => files.includes(p))) throw Error('版本清单包含非运行文件或缺少入口');
  const actual = (await walk(directory)).filter(p => p !== 'runtime-manifest.json').sort();
  if (JSON.stringify(actual) !== JSON.stringify(files)) throw Error('版本文件增减，拒绝启动');
  if (JSON.stringify(await fingerprint(directory, files)) !== JSON.stringify(m.files)) throw Error('版本内容或执行权限改变，拒绝启动');
  const config = validateRuntimeConfig(JSON.parse(await fs.readFile(path.join(directory, 'runtime-config.json'), 'utf8')));
  const pkg = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
  if (config.nativeMediaMode !== m.nativeMediaMode || pkg.version !== m.appVersion) throw Error('版本配置不一致');
  return m;
}
export async function runtimeLaunchPlan({workspace, selection, port = 4768, dataDir, env = process.env}) {
  workspace = await fs.realpath(workspaceRoot({JINGCHANG_WORKSPACE_ROOT: workspace}));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('服务端口无效');
  let directory = workspace, manifest;
  if (selection !== undefined) {
    if (!selection || Object.keys(selection).sort().join(',') !== 'manifestSha256,runtime,version' || selection.version !== 1 || !relative(selection.runtime)) throw Error('运行版本选择无效');
    directory = path.resolve(workspace, selection.runtime);
    if (!inside(workspace, directory)) throw Error('运行版本必须保存在工作区内');
    manifest = await verifyRuntime({directory, manifestSha256: selection.manifestSha256});
  }
  const data = path.resolve(dataDir || path.join(workspace, 'data'));
  if (manifest && (data === directory || inside(directory, data))) throw Error('用户数据不能写入封存的程序目录');
  const childEnv = {...env, PORT: String(port), JINGCHANG_DATA_DIR: data, JINGCHANG_WORKSPACE_ROOT: workspace};
  if (manifest) {
    delete childEnv.JINGCHANG_SMART_GROUP_MEDIA_TEST;
    childEnv.JINGCHANG_NATIVE_MEDIA_MODE = manifest.nativeMediaMode;
  }
  return {directory, workspace, data, port, appVersion: manifest?.appVersion, args: [path.join(directory, 'server.mjs')], env: childEnv};
}
