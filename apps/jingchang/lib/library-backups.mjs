import path from 'node:path';
import {promises as fs, constants, createReadStream} from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import {atomicJson, readJson, safeId, textValue, userError, assertNoCredentials} from './workspace.mjs';
import {normalizeAssetCatalog} from './asset-catalog.mjs';
import {portableAssetMetadata} from './project-bundles.mjs';
import {inspectWorkflow} from './providers.mjs';
import {normalizeFields} from './workflow-fields.mjs';
import {streamMediaType} from '../public/media-transfer-core.js';
import {checkMediaHeader} from './stream-assets.mjs';
import {normalizeBundleEdits, checkEditPngs} from './bundle-image-edits.mjs';
import {validatePanoramaLinks} from './bundle-panorama.mjs';
import {validateEnhancementLinks} from './image-enhance.mjs';

export const LIBRARY_MAGIC = Buffer.from('JINGCHANG_LIBRARY_1\n');
export const MAX_LIBRARY_MANIFEST = 12 * 1024 ** 2;
export const MAX_LIBRARY_BYTES = 4 * 1024 ** 3;
const HEADER = LIBRARY_MAGIC.length + 4;
const now = () => new Date().toISOString();
const checkedId = value => {if (!safeId(value)) throw userError('整库备份编号无效'); return value;};
const fingerprint = stat => `${stat.dev}/${stat.ino}/${stat.size}/${stat.mtimeMs}/${stat.ctimeMs}`;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const jobsKinds = new Set(['library-backup', 'library-restore']);
export function publicLibraryJob(job) {const {plan, ...out} = job; return {...out, canResume: ['failed', 'cancelled', 'interrupted'].includes(job.status)};}
const active = job => ['queued', 'running'].includes(job.status);
const checkedDigest = value => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw userError('整库文件校验值无效');
  return value;
};
function rejectUnsafeTree(value, depth = 0) {
  if (depth > 60) throw userError('整库清单嵌套过深');
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw userError('整库清单含不支持的字段');
    rejectUnsafeTree(item, depth + 1);
  }
}
export function portableLibraryCatalog(value) {
  const state = normalizeAssetCatalog(value);
  return {version: 1, revision: 0, activeLibraryId: state.activeLibraryId,
    libraries: state.libraries.map(l => ({id: l.id, name: l.name, archived: l.archived,
      folders: l.folders.map(f => ({id: f.id, name: f.name, type: f.type, archived: f.archived,
        items: f.items.map(i => ({id: i.id, name: i.name, kind: i.kind, archived: i.archived,
          ...(i.kind === 'media' ? {assetId: i.assetId} : i.kind === 'comfy' ? {workflowId: i.workflowId} : {bundleId: i.bundleId})}))}))}))};
}
function unique(values, label, maximum = 20000) {
  if (!Array.isArray(values) || values.length > maximum) throw userError(`整库${label}数量无效`);
  const ids = new Set();
  for (const v of values) {checkedId(v?.id); if (ids.has(v.id)) throw userError(`整库${label}编号重复`); ids.add(v.id);}
  return ids;
}
export function normalizeLibraryArchive(input) {
  rejectUnsafeTree(input); assertNoCredentials(input);
  if (input?.format !== 'jingchang-asset-library' || ![1, 2, 3, 4, 5, 6, 7, 8].includes(input.version)) throw userError('请选择 .jingchang-library 整库备份文件');
  const catalog = portableLibraryCatalog(input.catalog);
  const assetIds = unique(input.assets, '媒体'), workflowIds = unique(input.workflows, '模板'), bundleIds = unique(input.bundles, '画布文件');
  const assets = input.assets.map(a => {
    if(input.version<6&&a.caption!==undefined)throw userError('图片提示词需要第6版整库备份格式');
    const meta = portableAssetMetadata(a);
    if (!streamMediaType(meta.type)) throw userError('整库媒体须为可收藏的图片、视频或音频');
    return {...meta, sha256: checkedDigest(a.sha256)};
  });
  const workflows = input.workflows.map(w => {
    if (!w.workflow || JSON.stringify(w.workflow).length > 2_000_000) throw userError('整库模板超过2MB或内容无效');
    let inspection;
    try {inspection = inspectWorkflow(w.workflow);} catch {throw userError('整库模板不是 ComfyUI API 工作流');}
    if (inspection.nodeCount > 500) throw userError('整库模板最多500个节点');
    if (input.version < 3 && Array.isArray(w.fields) && w.fields.some(f => f && Object.hasOwn(f, 'nativeFieldId'))) throw userError('原生字段编号需要第3版整库备份格式');
    if (input.version < 2 && Array.isArray(w.fields) && w.fields.some(f => f && Object.hasOwn(f, 'randomEnabled'))) throw userError('数字随机模板需要第2版整库备份格式');
    const workflow = structuredClone(w.workflow.prompt || w.workflow);
    if (w.revision !== undefined && (!Number.isSafeInteger(w.revision) || w.revision < 0)) throw userError('整库模板修订号无效');
    return {id: w.id, name: textValue(w.name, 120, '模板名称'), workflow, inspection,
      fields: normalizeFields(workflow, w.fields || []), revision: w.revision ?? 0};
  });
  const bundles = input.bundles.map(b => {
    if (!['canvas', 'canvas-fragment'].includes(b.kind) || !Number.isSafeInteger(b.size) || b.size < HEADER || b.size > MAX_LIBRARY_BYTES) throw userError('整库画布文件记录无效');
    if (b.projectFormatVersion !== undefined && (!Number.isInteger(b.projectFormatVersion) || b.projectFormatVersion < 1 || b.projectFormatVersion > 41)) throw userError('整库画布格式版本无效');
    if (input.version < 8 && b.projectFormatVersion >= 41) throw userError('逐轮选图画布需要第8版整库备份格式');
    if (input.version < 7 && b.projectFormatVersion >= 40) throw userError('素材顺序版本画布需要第7版整库备份格式');
    if (input.version < 6 && b.projectFormatVersion >= 39) throw userError('图片提示词画布需要第6版整库备份格式');
    if (input.version < 5 && b.projectFormatVersion >= 37) throw userError('逐句字幕、画面转场和配乐避让需要第5版整库备份格式');
    if (input.version < 4 && b.projectFormatVersion >= 36) throw userError('智能分支画布需要第4版整库备份格式');
    if (input.version < 3 && b.projectFormatVersion >= 35) throw userError('原生字段映射画布需要第3版整库备份格式');
    if (input.version < 2 && b.projectFormatVersion >= 34) throw userError('数字随机画布需要第2版整库备份格式');
    return {id: b.id, kind: b.kind, size: b.size, sha256: checkedDigest(b.sha256), ...(b.projectFormatVersion !== undefined ? {projectFormatVersion: b.projectFormatVersion} : {})};
  });
  const bundleMap = new Map(bundles.map(b => [b.id, b]));
  for (const l of catalog.libraries) for (const f of l.folders) for (const i of f.items) {
    if (i.kind === 'media' ? !assetIds.has(i.assetId) : i.kind === 'comfy' ? !workflowIds.has(i.workflowId) : !bundleIds.has(i.bundleId) || bundleMap.get(i.bundleId).kind !== i.kind) throw userError('整库条目缺少对应文件或类型不一致');
  }
  const imageEdits = normalizeBundleEdits(input.imageEdits, assets);
  validatePanoramaLinks(assets, 32); validateEnhancementLinks(assets, 32);
  if (assets.reduce((n, a) => n + a.size, 0) + bundles.reduce((n, b) => n + b.size, 0) > MAX_LIBRARY_BYTES) throw userError('整库备份文件内容最多4GiB，请拆分素材库');
  return {format: 'jingchang-asset-library', version: input.version, catalog, assets, workflows, bundles, imageEdits};
}
const filesOf = m => [...m.assets.map(a => ({...a, kind: 'media'})), ...m.bundles];
function summary(m, id) {
  const items = m.catalog.libraries.flatMap(l => l.folders.flatMap(f => f.items));
  return {id, format: m.format, version: m.version, libraries: m.catalog.libraries.length,
    folders: m.catalog.libraries.reduce((n, l) => n + l.folders.length, 0), items: items.length,
    archivedLibraries: m.catalog.libraries.filter(l => l.archived).length,
    archivedItems: items.filter(i => i.archived).length, assets: m.assets.length,
    workflows: m.workflows.length, canvases: m.bundles.filter(b => b.kind === 'canvas').length,
    fragments: m.bundles.filter(b => b.kind === 'canvas-fragment').length, imageEdits: m.imageEdits.length,
    bytes: filesOf(m).reduce((n, f) => n + f.size, 0),
    libraryNames: m.catalog.libraries.map(l => ({name: l.name, archived: l.archived, folders: l.folders.length}))};
}
async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const {bytesWritten} = await handle.write(bytes, offset, bytes.length - offset);
    if (!bytesWritten) throw userError('整库文件写入中断'); offset += bytesWritten;
  }
}
async function ensureDirectory(root, relative) {
  let dir = root;
  for (const name of relative.split(path.sep).filter(Boolean)) {
    if (!safeId(name)) throw userError('整库记录目录无效');
    dir = path.join(dir, name); await fs.mkdir(dir, {recursive: true});
    if (await fs.realpath(dir) !== dir || !(await fs.lstat(dir)).isDirectory()) throw userError('整库记录目录不能是符号链接');
  }
  return dir;
}
async function regular(root, relative) {
  if (path.isAbsolute(relative) || relative.split(path.sep).includes('..')) throw userError('整库文件路径无效');
  const file = path.join(root, relative), st = await fs.lstat(file);
  if (!st.isFile() || st.isSymbolicLink() || await fs.realpath(file) !== file) throw userError('整库只接受本机普通文件');
  return {file, st};
}
async function safeJson(root, relative, maximum = MAX_LIBRARY_MANIFEST) {
  const {file, st} = await regular(root, relative);
  if (st.size > maximum) throw userError('整库记录超过容量限制');
  return readJson(file);
}
async function digest(file, range, signal) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file, {...range, signal})) h.update(chunk);
  return h.digest('hex');
}
async function space(root, bytes) {
  const disk = await fs.statfs(root);
  if (disk.bavail * disk.bsize < bytes + 64 * 1024 ** 2) throw userError('可用空间不足以完成整库操作并保留64MiB余量，原文件保留', 507);
}
async function installJson(root, relative, value) {
  const file = path.join(root, relative);
  try {
    const old = await safeJson(root, relative);
    if (JSON.stringify(old) !== JSON.stringify(value)) throw userError('恢复中的记录已修改或编号被占用，现有记录保留', 409);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    const pending = file + '.pending-' + randomUUID();
    await fs.writeFile(pending, JSON.stringify(value), {flag: 'wx'});
    await fs.link(pending, file);
  }
}

export function libraryBackupService({data, activeJobs, projects, catalog, bundles}) {
  const locks = new Map();
  const locked = async (key, fn) => {
    const task = (locks.get(key) || Promise.resolve()).catch(() => {}).then(fn); locks.set(key, task);
    try {return await task;} finally {if (locks.get(key) === task) locks.delete(key);}
  };
  async function root() {const r = await fs.realpath(data); await ensureDirectory(r, 'library-backups'); return r;}
  const relativeJob = id => path.join('jobs', checkedId(id) + '.json');
  async function indexJob(job) {const r = await root(); await ensureDirectory(r,path.join('library-backups','jobs')); await installJson(r,path.join('library-backups','jobs',checkedId(job.id)+'.json'),{id:job.id,projectId:job.projectId});}
  async function persist(job) {job.updatedAt = now(); const r = await root(); await ensureDirectory(r, 'jobs'); await atomicJson(path.join(r, relativeJob(job.id)), job); await indexJob(job);}
  async function readJob(id, projectId) {
    const r = await root(), job = await safeJson(r, relativeJob(id), 40*1024**2);
    if (!jobsKinds.has(job.kind) || job.id !== id || job.projectId !== checkedId(projectId)) throw userError('整库任务不属于当前项目', 403);
    await indexJob(job); return job;
  }
  const visible = publicLibraryJob;
  // Completion is visible only after its durable record has been committed.
  // Returning the mutable runner here could announce a downloadable result
  // before the corresponding completed job exists on disk.
  async function get(id, projectId) {await projects.load(checkedId(projectId)); return visible(await readJob(id, projectId));}
  async function list(projectId) {
    await projects.load(checkedId(projectId)); const r = await root(), dir = await ensureDirectory(r,path.join('library-backups','jobs')), out = [];
    for (const name of await fs.readdir(dir)) {
      if (!/^[\w-]+\.json$/.test(name)) continue;
      const j = await safeJson(r, path.join('library-backups','jobs', name));
      if (j.projectId === projectId) out.push(await get(j.id, projectId));
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200);
  }
  async function inspectFile(file, signal) {
    const r = await root(), {st} = await regular(r, path.relative(r, file));
    if (st.size < HEADER + 2 || st.size > MAX_LIBRARY_BYTES + MAX_LIBRARY_MANIFEST + HEADER) throw userError('整库文件大小无效');
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW); let m, offset;
    try {
      const h = Buffer.alloc(HEADER);
      if ((await handle.read(h, 0, HEADER, 0)).bytesRead !== HEADER || !h.subarray(0, LIBRARY_MAGIC.length).equals(LIBRARY_MAGIC)) throw userError('请选择 .jingchang-library 整库备份文件');
      const n = h.readUInt32BE(LIBRARY_MAGIC.length);
      if (n < 2 || n > MAX_LIBRARY_MANIFEST || HEADER + n > st.size) throw userError('整库清单长度无效');
      const json = Buffer.alloc(n);
      if ((await handle.read(json, 0, n, HEADER)).bytesRead !== n) throw userError('整库清单不完整');
      let value; try {value = JSON.parse(json.toString());} catch {throw userError('整库清单不是有效JSON');}
      m = normalizeLibraryArchive(value); offset = HEADER + n;
    } finally {await handle.close();}
    const ranges = [];
    for (const f of filesOf(m)) {
      signal?.throwIfAborted(); const range = {start: offset, end: offset + f.size - 1}; offset += f.size;
      if (offset > st.size || await digest(file, range, signal) !== f.sha256) throw userError('整库文件不完整或校验失败');
      if (f.kind === 'media') {
        const h = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {const b = Buffer.alloc(Math.min(64, f.size)); const got = await h.read(b, 0, b.length, range.start); checkMediaHeader(b.subarray(0, got.bytesRead), f.type);} finally {await h.close();}
      } else {
        const inspected = await bundles.inspectLibraryRange(file, range, f.kind);
        if (m.version < 8 && inspected.formatVersion >= 41) throw userError('逐轮选图画布需要第8版整库备份格式');
        if (m.version < 7 && inspected.formatVersion >= 40) throw userError('素材顺序版本画布需要第7版整库备份格式');
        if (m.version < 6 && inspected.formatVersion >= 39) throw userError('图片提示词画布需要第6版整库备份格式');
        if (m.version < 5 && inspected.formatVersion >= 37) throw userError('逐句字幕、画面转场和配乐避让需要第5版整库备份格式');
        if (m.version < 4 && inspected.formatVersion >= 36) throw userError('智能分支画布需要第4版整库备份格式');
        if (m.version < 3 && inspected.formatVersion >= 35) throw userError('原生字段映射画布需要第3版整库备份格式');
        if (m.version < 2 && inspected.formatVersion >= 34) throw userError('数字随机画布需要第2版整库备份格式');
        if (f.projectFormatVersion !== undefined && f.projectFormatVersion !== inspected.formatVersion) throw userError('整库画布格式版本与文件内容不一致');
      }
      ranges.push(range);
    }
    if (offset !== st.size) throw userError('整库文件长度与清单不一致');
    await checkEditPngs(m.assets, m.imageEdits, async id => {
      const range = ranges[m.assets.findIndex(a => a.id === id)], h = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {const b = Buffer.alloc(24), got = await h.read(b, 0, 24, range.start); return b.subarray(0, got.bytesRead);} finally {await h.close();}
    });
    if (fingerprint(await fs.lstat(file)) !== fingerprint(st) || await fs.realpath(file) !== file) throw userError('整库文件在核对期间变化', 409);
    return {manifest: m, ranges};
  }
  async function gather(job, signal) {
    if ([...activeJobs.values()].some(j => j.kind === 'library-copy')) throw userError('素材收藏仍在运行，请完成或停止后创建整库备份', 409);
    const r = await root(), state = await catalog.read();
    if (state.revision !== job.catalogRevision) throw userError('素材库已更新，请刷新后创建新备份', 409);
    const c = portableLibraryCatalog(state), entries = c.libraries.flatMap(l => l.folders.flatMap(f => f.items));
    const assetIds = new Set(entries.filter(i => i.kind === 'media').map(i => i.assetId)), workflowIds = new Set(entries.filter(i => i.kind === 'comfy').map(i => i.workflowId));
    const bundleKinds = new Map();
    for (const i of entries.filter(i => ['canvas', 'canvas-fragment'].includes(i.kind))) {
      if (bundleKinds.has(i.bundleId) && bundleKinds.get(i.bundleId) !== i.kind) throw userError('素材库画布文件类型冲突'); bundleKinds.set(i.bundleId, i.kind);
    }
    const assets = [], workflows = [], packaged = [], imageEdits = [], edits = new Set(), sources = [], metadataSources = [];
    let total = 0;
    async function source(relative, expectedSize) {
      const s = await regular(r, relative);
      if (expectedSize !== undefined && s.st.size !== expectedSize) throw userError('素材库文件与大小记录不一致');
      total += s.st.size; if (total > MAX_LIBRARY_BYTES) throw userError('整库备份文件内容最多4GiB');
      const sha256 = await digest(s.file, undefined, signal); sources.push({relative, size: s.st.size, sha256, fingerprint: fingerprint(s.st)}); return sources.at(-1);
    }
    async function record(relative) {
      const {file, st} = await regular(r, relative), value = await safeJson(r, relative);
      metadataSources.push({relative, sha256: await digest(file, undefined, signal), fingerprint: fingerprint(st)}); return value;
    }
    for (const id of assetIds) {
      signal.throwIfAborted(); checkedId(id);
      const a = portableAssetMetadata(await record(path.join('assets', id + '.json')));
      if (a.id !== id || !streamMediaType(a.type)) throw userError('素材库媒体记录不一致');
      const s = await source(path.join('assets', id), a.size); assets.push({...a, sha256: s.sha256});
      if (a.enhancement) for (const key of [a.enhancement.sourceAssetId, a.enhancement.originalAssetId]) assetIds.add(checkedId(key));
      if (a.operation === 'panorama') assetIds.add(checkedId(a.sourceAssetId));
      if (a.editId && !edits.has(a.editId)) {
        edits.add(a.editId); const e = await record(path.join('image-edits', checkedId(a.editId) + '.json')); imageEdits.push(e);
        assetIds.add(checkedId(e.sourceAssetId)); for (const kind of ['image', 'mask', 'input']) assetIds.add(checkedId(e.outputs?.[kind]));
      }
      if (assetIds.size > 20000 || edits.size > 1000) throw userError('整库媒体或编辑依赖过多');
    }
    for (const id of workflowIds) workflows.push(await record(path.join('workflows', checkedId(id) + '.json')));
    for (const [id, kind] of bundleKinds) {
      signal.throwIfAborted(); const p = await bundles.previewLibraryPackage(id);
      if (p.canvasFragment !== (kind === 'canvas-fragment')) throw userError('素材库画布类型与文件内容不一致');
      const file = await bundles.download(id), s = await source(path.relative(r, file)); packaged.push({id, kind, size: s.size, sha256: s.sha256, ...(p.formatVersion >= 34 ? {projectFormatVersion: p.formatVersion} : {})});
    }
    const advancedEditingFormat = packaged.some(b => b.projectFormatVersion >= 37);
    const nativeBranchFormat = packaged.some(b => b.projectFormatVersion >= 36);
    const nativeFieldFormat = workflows.some(w => w.fields.some(f => Object.hasOwn(f, 'nativeFieldId'))) || packaged.some(b => b.projectFormatVersion >= 35);
    const randomFormat = workflows.some(w => w.fields.some(f => Object.hasOwn(f, 'randomEnabled'))) || packaged.some(b => b.projectFormatVersion >= 34);
    const manifest = normalizeLibraryArchive({format: 'jingchang-asset-library', version: packaged.some(b=>b.projectFormatVersion>=41) ? 8 : packaged.some(b=>b.projectFormatVersion>=40) ? 7 : assets.some(a=>a.caption)||packaged.some(b=>b.projectFormatVersion>=39) ? 6 : advancedEditingFormat ? 5 : nativeBranchFormat ? 4 : nativeFieldFormat ? 3 : randomFormat ? 2 : 1, catalog: c, assets, workflows, bundles: packaged, imageEdits});
    return {manifest, sources, metadataSources, catalogHash: hash(c)};
  }
  async function stable(plan) {
    const r = await root();
    if (hash(portableLibraryCatalog(await catalog.read())) !== plan.catalogHash) throw userError('素材库在备份期间更新，请创建新备份，原数据保留', 409);
    for (const s of [...plan.sources, ...plan.metadataSources]) {
      const f = await regular(r, s.relative);
      if (fingerprint(f.st) !== s.fingerprint || await digest(f.file) !== s.sha256) throw userError('素材库文件在备份期间变化，未发布备份', 409);
    }
  }
  async function exportArchive(job, signal) {
    const r = await root(), dir = await ensureDirectory(r, path.join('library-backups', 'exports', job.id));
    if (!job.plan) {job.message = '正在核对整库目录和文件依赖'; await persist(job); job.plan = await gather(job, signal); await persist(job);}
    const m = normalizeLibraryArchive(job.plan.manifest), json = Buffer.from(JSON.stringify(m));
    if (json.length > MAX_LIBRARY_MANIFEST) throw userError('整库配置超过12MiB');
    await stable(job.plan); await space(r, summary(m, job.id).bytes + json.length + HEADER);
    const pending = path.join(dir, randomUUID() + '.pending'), handle = await fs.open(pending, 'wx'), h = Buffer.alloc(4);
    h.writeUInt32BE(json.length); job.totalSteps = job.plan.sources.length + 2; job.completedSteps = 0; job.bytesCopied = 0;
    try {
      await writeAll(handle, LIBRARY_MAGIC); await writeAll(handle, h); await writeAll(handle, json);
      job.completedSteps = 1; await persist(job);
      for (const [index, s] of job.plan.sources.entries()) {
        signal.throwIfAborted(); const source = await regular(r, s.relative), d = createHash('sha256'); let size = 0;
        for await (const chunk of createReadStream(source.file, {signal})) {await writeAll(handle, chunk); d.update(chunk); size += chunk.length; job.bytesCopied += chunk.length;}
        if (size !== s.size || d.digest('hex') !== s.sha256) throw userError('整库文件在复制期间变化');
        job.completedSteps = index + 2; job.message = `已复制 ${index + 1} / ${job.plan.sources.length} 个整库文件`; await persist(job);
      }
    } finally {await handle.close();}
    signal.throwIfAborted(); await stable(job.plan); await inspectFile(pending, signal);
    const sha256 = await digest(pending, undefined, signal), target = path.join(dir, 'library.jingchang-library');
    try {await fs.link(pending, target);} catch (e) {if (e.code !== 'EEXIST') throw e; const existing = await regular(r, path.relative(r, target)); if (await digest(existing.file) !== sha256) throw userError('整库备份文件已被占用，现有文件保留', 409);}
    job.result = {...summary(m, job.id), sha256, url: '/api/asset-library-backups/' + job.id + '/download'};
    job.completedSteps = job.totalSteps; job.message = '整库备份已完成并通过文件校验';
  }
  const importRelative = id => path.join('library-backups', 'imports', checkedId(id), 'record.json');
  async function importRecord(id, projectId) {
    const r = await root(), record = await safeJson(r, importRelative(id));
    if (record.id !== id || record.projectId !== checkedId(projectId)) throw userError('整库接收记录不属于当前项目', 403); return record;
  }
  function publicImport(record) {const {file, ...out} = record; return out;}
  async function getImport(id, projectId) {await projects.load(checkedId(projectId)); return publicImport(await importRecord(id, projectId));}
  async function listImports(projectId) {
    await projects.load(checkedId(projectId)); const r = await root(), dir = await ensureDirectory(r, path.join('library-backups', 'imports')), out = [];
    for (const id of (await fs.readdir(dir)).filter(safeId)) {
      try {const entry = await importRecord(id, projectId); out.push(publicImport(entry));} catch (e) {if (e.status !== 403 && e.code !== 'ENOENT') throw e;}
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200);
  }
  async function upload(stream, payload) {
    const id = checkedId(payload.requestId), projectId = checkedId(payload.projectId); assertNoCredentials(payload); await projects.load(projectId);
    return locked('upload-' + id, async () => {
      const r = await root(), dir = await ensureDirectory(r, path.join('library-backups', 'imports', id)); let previous;
      try {previous = await importRecord(id, projectId);} catch (e) {if (e.code !== 'ENOENT') throw e;}
      const file = path.join(dir, randomUUID() + '.received'), handle = await fs.open(file, 'wx'), sha = createHash('sha256');
      const record = previous?.status === 'checked' ? previous : {id, projectId, status: 'receiving', bytesReceived: 0, createdAt: previous?.createdAt || now()};
      if (!previous || previous.status !== 'checked') await atomicJson(path.join(r, importRelative(id)), record);
      let total = 0, pending = Buffer.alloc(0), manifestSize = null, expected = null, checkpoint = Date.now();
      try {
        for await (const raw of stream) {
          const chunk = Buffer.from(raw); total += chunk.length;
          if (total > MAX_LIBRARY_BYTES + MAX_LIBRARY_MANIFEST + HEADER) throw userError('整库文件超过4GiB文件与12MiB配置限制', 413);
          let write = chunk;
          if (expected === null) {
            pending = Buffer.concat([pending, chunk]);
            if (pending.length >= HEADER && manifestSize === null) {
              if (!pending.subarray(0, LIBRARY_MAGIC.length).equals(LIBRARY_MAGIC)) throw userError('请选择 .jingchang-library 整库备份文件');
              manifestSize = pending.readUInt32BE(LIBRARY_MAGIC.length);
              if (manifestSize < 2 || manifestSize > MAX_LIBRARY_MANIFEST) throw userError('整库清单长度无效');
            }
            if (manifestSize !== null && pending.length >= HEADER + manifestSize) {
              let value; try {value = JSON.parse(pending.subarray(HEADER, HEADER + manifestSize).toString());} catch {throw userError('整库清单不是有效JSON');}
              const m = normalizeLibraryArchive(value); expected = HEADER + manifestSize + summary(m, id).bytes; write = pending; pending = null; await space(r, expected);
            }
            else write = null;
          }
          if (expected !== null && total > expected) throw userError('整库文件长度与清单不一致');
          if (write) await writeAll(handle, write); sha.update(chunk);
          if (record !== previous && Date.now() - checkpoint > 500) {record.bytesReceived = total; record.updatedAt = now(); await atomicJson(path.join(r, importRelative(id)), record); checkpoint = Date.now();}
        }
        if (expected === null || total !== expected) throw userError('整库文件未完整接收');
        await handle.close(); const {manifest} = await inspectFile(file), sha256 = sha.digest('hex');
        if (previous?.status === 'checked') {
          if (previous.sha256 !== sha256) throw userError('此整库接收编号已用于另一份文件，原记录保留', 409);
          return publicImport(previous);
        }
        Object.assign(record, summary(manifest, id), {projectId, status: 'checked', file: path.relative(r, file), bytesReceived: total, sha256, updatedAt: now()});
        await atomicJson(path.join(r, importRelative(id)), record); return publicImport(record);
      } catch (e) {
        if (previous?.status !== 'checked') {Object.assign(record, {status: 'interrupted', bytesReceived: total, error: String(e.message).slice(0, 1000), updatedAt: now()}); await atomicJson(path.join(r, importRelative(id)), record);}
        throw e;
      } finally {await handle.close().catch(() => {});}
    });
  }
  function planFor(m, archive) {
    const map = values => Object.fromEntries(values.map(v => [v.id, randomUUID()]));
    return {archiveSha256: archive.sha256, signature: hash({sha256: archive.sha256, catalog: m.catalog}), createdAt: now(),
      libraries: map(m.catalog.libraries), folders: map(m.catalog.libraries.flatMap(l => l.folders)),
      items: map(m.catalog.libraries.flatMap(l => l.folders.flatMap(f => f.items))), assets: map(m.assets),
      workflows: map(m.workflows), bundles: map(m.bundles), imageEdits: map(m.imageEdits), bundleSummaries: {}};
  }
  function validatePlan(plan, m, archive) {
    if (plan.archiveSha256 !== archive.sha256 || plan.signature !== hash({sha256: archive.sha256, catalog: m.catalog}) || !Number.isFinite(Date.parse(plan.createdAt))) throw userError('整库恢复计划与原文件不一致');
    const seen = new Set();
    for (const [key, values] of Object.entries({libraries: m.catalog.libraries, folders: m.catalog.libraries.flatMap(l => l.folders), items: m.catalog.libraries.flatMap(l => l.folders.flatMap(f => f.items)), assets: m.assets, workflows: m.workflows, bundles: m.bundles, imageEdits: m.imageEdits})) {
      if (!plan[key] || Object.keys(plan[key]).length !== values.length) throw userError('整库恢复编号计划不完整');
      for (const v of values) {const id = checkedId(plan[key][v.id]); if (seen.has(id)) throw userError('整库恢复编号重复'); seen.add(id);}
    }
  }
  async function extract(file, range, entry, dir, signal) {
    const r = await root(); await space(r, entry.size);
    const staged = path.join(dir, randomUUID() + '.received'), handle = await fs.open(staged, 'wx'); const h = createHash('sha256'); let total = 0;
    try {for await (const chunk of createReadStream(file, {...range, signal})) {await writeAll(handle, chunk); h.update(chunk); total += chunk.length;}} finally {await handle.close();}
    if (total !== entry.size || h.digest('hex') !== entry.sha256) throw userError('整库恢复文件校验失败'); return staged;
  }
  async function restoreArchive(job, signal) {
    const r = await root(), archive = await importRecord(job.importId, job.projectId);
    if (archive.status !== 'checked') throw userError('请先完整接收并检查整库文件');
    const {file} = await regular(r, archive.file);
    if (await digest(file, undefined, signal) !== archive.sha256) throw userError('已接收的整库文件发生变化，未恢复目录', 409);
    const {manifest: m, ranges} = await inspectFile(file, signal);
    if (!job.plan) {job.plan = planFor(m, archive); await persist(job);}
    const plan = job.plan; validatePlan(plan, m, archive);
    const already = (await catalog.read()).libraryBackupRestores?.[job.id];
    if (already) {
      if (already.signature !== plan.signature) throw userError('整库恢复记录签名冲突', 409);
      job.result = {libraryIds: already.libraryIds, alreadyPublished: true}; job.completedSteps = job.totalSteps; job.message = '原整库恢复已发布，保留当前目录编辑'; return;
    }
    const current = await catalog.read();
    if (current.revision !== job.catalogRevision) throw userError('素材库已更新，请刷新后继续原恢复记录', 409);
    // Enforce final catalog limits before copying large files.
    normalizeAssetCatalog({...current, libraries: [...current.libraries, ...m.catalog.libraries.map(l => ({...l, id: plan.libraries[l.id], folders: l.folders.map(f => ({...f, id: plan.folders[f.id], items: f.items.map(i => ({...i, id: plan.items[i.id]}))}))}))]});
    const dir = await ensureDirectory(r, path.join('library-backups', 'restores', job.id)); await ensureDirectory(r, 'assets');
    job.totalSteps = m.assets.length + m.imageEdits.length + m.workflows.length + m.bundles.length + 1; job.completedSteps = 0;
    const completed = async message => {job.completedSteps++; job.message = message; await persist(job);};
    for (const [index, a] of m.assets.entries()) {
      signal.throwIfAborted(); const assetId = plan.assets[a.id], relative = path.join('assets', assetId), target = path.join(r, relative);
      try {const old = await regular(r, relative); if (old.st.size !== a.size || await digest(old.file, undefined, signal) !== a.sha256) throw userError('整库恢复的媒体编号已被占用，现有文件保留', 409);}
      catch (e) {if (e.code !== 'ENOENT') throw e; const received = await extract(file, ranges[index], a, dir, signal); signal.throwIfAborted(); await fs.link(received, target);}
      const meta = {...portableAssetMetadata(a), id: assetId, sha256: a.sha256, url: '/media/' + assetId, createdAt: plan.createdAt, source: 'library-backup', importLibraryBackupId: job.id,
        ...(a.editId ? {editId: plan.imageEdits[a.editId], sourceAssetId: plan.assets[a.sourceAssetId]} : {}),
        ...(a.operation === 'panorama' ? {sourceAssetId: plan.assets[a.sourceAssetId]} : {}),
        ...(a.enhancement ? {enhancement: {...a.enhancement, sourceAssetId: plan.assets[a.enhancement.sourceAssetId], originalAssetId: plan.assets[a.enhancement.originalAssetId]}} : {})};
      await installJson(r, relative + '.json', meta); await completed(`已恢复 ${index + 1} / ${m.assets.length} 份媒体与依赖`);
    }
    if (m.imageEdits.length) await ensureDirectory(r, 'image-edits');
    for (const e of m.imageEdits) {
      signal.throwIfAborted(); const value = {...e, id: plan.imageEdits[e.id], sourceAssetId: plan.assets[e.sourceAssetId], outputs: Object.fromEntries(Object.entries(e.outputs).map(([kind, id]) => [kind, plan.assets[id]])), createdAt: plan.createdAt, importLibraryBackupId: job.id};
      await installJson(r, path.join('image-edits', value.id + '.json'), value); await completed('图片编辑步骤与输出关系已恢复');
    }
    if (m.workflows.length) await ensureDirectory(r, 'workflows');
    for (const w of m.workflows) {
      signal.throwIfAborted(); const value = {...w, id: plan.workflows[w.id], revision: 0, createdAt: plan.createdAt, importLibraryBackupId: job.id};
      await installJson(r, path.join('workflows', value.id + '.json'), value); await completed('ComfyUI 模板字段已恢复，未执行生成');
    }
    for (const [index, b] of m.bundles.entries()) {
      signal.throwIfAborted(); const staged = await extract(file, ranges[m.assets.length + index], b, dir, signal);
      plan.bundleSummaries[b.id] = await bundles.restoreLibraryPackage(staged, plan.bundles[b.id], b.kind);
      await completed('画布工作流文件已恢复，未创建项目或执行生成');
    }
    signal.throwIfAborted(); if (await digest(file, undefined, signal) !== archive.sha256) throw userError('整库文件在恢复期间变化，未发布目录', 409);
    const result = await catalog.publishLibraryBackup({catalog: m.catalog, mapping: plan, requestId: job.id, signature: plan.signature, expectedRevision: job.catalogRevision, signal});
    job.result = {libraryIds: result.libraryIds, activeLibraryId: plan.libraries[m.catalog.activeLibraryId], alreadyPublished: result.alreadyPublished};
    await completed('整库已恢复为新增库；当前工程、原素材和任务保持');
  }
  async function run(job) {
    if (activeJobs.has(job.id)) return;
    const controller = new AbortController(); activeJobs.set(job.id, {kind: job.kind, projectId: job.projectId, controller, job});
    try {job.status = 'running'; await persist(job); await (job.kind === 'library-backup' ? exportArchive : restoreArchive)(job, controller.signal); job.status = 'completed'; await persist(job);}
    catch (e) {job.status = controller.signal.aborted ? 'cancelled' : 'interrupted'; job.message = controller.signal.aborted ? '整库操作已停止，原文件与接收副本保留' : String(e.message || '整库操作未完成').slice(0, 1000); await persist(job);}
    finally {activeJobs.delete(job.id);}
  }
  async function start(payload, importId = '') {
    assertNoCredentials(payload); const id = checkedId(payload.requestId), projectId = checkedId(payload.projectId); await projects.load(projectId);
    if (importId) checkedId(importId);
    const kind = importId ? 'library-restore' : 'library-backup', signature = hash({kind, projectId, importId});
    return locked('job-' + id, async () => {
      try {const old = await readJob(id, projectId); if (old.signature !== signature) throw userError('整库任务编号已用于另一操作', 409); return visible(old);} catch (e) {if (e.code !== 'ENOENT') throw e;}
      const state = await catalog.read(); if (state.revision !== payload.revision) throw userError('素材库已更新，请刷新后操作', 409);
      if (importId && (await importRecord(importId, projectId)).status !== 'checked') throw userError('请先完整接收并检查整库文件');
      const job = {id, kind, projectId, signature, ...(importId ? {importId} : {}), name: importId ? '素材库整库恢复' : '素材库整库备份', status: 'queued', catalogRevision: state.revision, completedSteps: 0, totalSteps: 0, message: '等待本机文件处理；不会执行生成', assets: [], createdAt: now()};
      await persist(job); void run(job).catch(() => {}); return visible(job);
    });
  }
  async function resume(id, payload) {
    assertNoCredentials(payload); return locked('job-' + checkedId(id), async () => {
      const job = await readJob(id, payload.projectId); if (active(job) || job.status === 'completed') return visible(job);
      if (activeJobs.has(id)) throw userError('原整库操作仍在停止，请稍后读取原任务', 409);
      if (job.kind === 'library-restore') {const state = await catalog.read(); if (state.revision !== payload.revision) throw userError('素材库已更新，请刷新后继续', 409); job.catalogRevision = state.revision;}
      else if ((await catalog.read()).revision !== job.catalogRevision) throw userError('原备份目录已更新，请创建新备份；原副本保留', 409);
      job.status = 'queued'; job.message = '继续原整库文件计划，已发布记录保持'; await persist(job); void run(job).catch(() => {}); return visible(job);
    });
  }
  async function cancel(id, projectId) {const job = await readJob(id, projectId); activeJobs.get(id)?.controller.abort(); return visible(job);}
  async function download(id) {
    const r = await root(), job = await safeJson(r, relativeJob(id),40*1024**2);
    if (job.id !== id || job.kind !== 'library-backup' || job.status !== 'completed') throw userError('整库备份尚未完整完成', 409);
    const {file} = await regular(r, path.join('library-backups', 'exports', id, 'library.jingchang-library'));
    if (await digest(file) !== job.result?.sha256) throw userError('整库备份校验失败，现有文件保留', 409); return file;
  }
  async function recover() {
    const r = await root(), dir = await ensureDirectory(r,path.join('library-backups','jobs'));
    for (const name of (await fs.readdir(dir)).filter(n => /^[\w-]+\.json$/.test(n))) {
      const entry=await safeJson(r,path.join('library-backups','jobs',name));const job=await readJob(entry.id,entry.projectId);
      if (jobsKinds.has(job.kind) && active(job)) {job.status = 'interrupted'; job.message = '服务重启，整库原计划与文件已保留，请读取后继续'; await persist(job);}
    }
    const imports = await ensureDirectory(r, path.join('library-backups', 'imports'));
    for (const id of (await fs.readdir(imports)).filter(safeId)) {
      let record; try {record = await safeJson(r, importRelative(id));} catch (e) {if (e.code === 'ENOENT') continue; throw e;}
      if (record.status === 'receiving') {record.status = 'interrupted'; record.error = '服务重启，尚未完整接收；原接收文件保留'; await atomicJson(path.join(r, importRelative(id)), record);}
    }
  }
  return {start, get, list, upload, getImport, listImports, resume, cancel, download, recover};
}
