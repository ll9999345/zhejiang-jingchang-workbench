import path from 'node:path';
import {promises as fs, constants} from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import {safeId, textValue, userError, assertNoCredentials, atomicJson} from './workspace.mjs';
import {normalizeAssetCatalog} from './asset-catalog.mjs';
import {normalizeAssetClassification} from './asset-classification.mjs';
import {fileMediaType, streamMediaType, MAX_STREAM_MEDIA_BYTES} from '../public/media-transfer-core.js';
import {checkMediaHeader} from './stream-assets.mjs';
import {inspectNativeLibraryWorkflow} from './native-library-workflow.mjs';

export const NATIVE_LIBRARY_LIMITS = {manifest: 12 * 1024 ** 2, bytes: 4 * 1024 ** 3};
const now = () => new Date().toISOString();
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const mark = s => `${s.dev}/${s.ino}/${s.size}/${s.mtimeMs}/${s.ctimeMs}`;
const directoryMark = s => `${s.dev}/${s.ino}`;
const checkedId = value => {if (!safeId(value)) throw userError('原版素材库导入编号无效'); return value;};
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const planSignature = value => {const {bundleSummaries, ...mapping} = value.mapping; return hash({sourceSha256: value.sourceSha256, sourceRootMark: value.sourceRootMark, sourceDirectories: value.sourceDirectories, index: value.index, catalog: value.catalog, mapping, files: value.files, prepared: value.prepared, sourceMapping: value.sourceMapping, sourceDirectory: value.sourceDirectory, counts: value.counts, bytes: value.bytes, missing: value.missing, unsupported: value.unsupported, createdAt: value.createdAt});};
function fields(value, allowed, label) {
  if (!object(value) || Object.keys(value).some(k => !allowed.includes(k))) throw userError(`${label}含未知字段，未导入`);
}
function guard(value, depth = 0) {
  if (depth > 60) throw userError('原版素材库结构过深');
  if (!value || typeof value !== 'object') return;
  if (Object.keys(value).some(k => ['__proto__', 'constructor', 'prototype'].includes(k))) throw userError('原版素材库含不安全字段');
  for (const v of Object.values(value)) guard(v, depth + 1);
}
function sourceId(value) {
  if (typeof value !== 'string' || !value || value.length > 200 || /[\u0000-\u001f\u007f]/u.test(value)) throw userError('原版素材库源编号无效');
  return value;
}
function relativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || value.includes('\\') || /[\u0000-\u001f\u007f]/u.test(value) || path.posix.isAbsolute(value)) throw userError('源文件相对路径无效');
  const parts = value.split('/');
  if (parts.length > 64 || parts.some(p => !p || p === '.' || p === '..' || p.startsWith('.') || p.includes(':'))) throw userError('源文件相对路径无效');
  return parts;
}
function mediaRelative(url) {
  if (typeof url !== 'string' || !url.startsWith('/assets/library/') || /[?#\\\u0000-\u001f\u007f]/u.test(url) || /%2f|%5c/iu.test(url)) return null;
  let decoded; try {decoded = decodeURIComponent(url.slice('/assets/library/'.length));} catch {throw userError('源文件 URL 编码无效');}
  relativePath(decoded); return 'assets/library/' + decoded;
}
async function ordinaryAbsolute(value, remember) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value !== path.resolve(value) || /[\u0000-\u001f\u007f]/u.test(value)) throw userError('请选择明确的普通源项目根目录');
  let current = path.parse(value).root;
  for (const part of value.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); const s = await fs.lstat(current);
    if (!s.isDirectory() || s.isSymbolicLink() || await fs.realpath(current) !== current) throw userError('源目录不能包含符号链接或非目录');
    remember?.(current, s);
  }
  return value;
}
async function ordinary(root, relative, directory = false, remember) {
  const parts = relativePath(relative); let current = root;
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await fs.realpath(root) !== root) throw userError('源项目根目录发生变化');
  remember?.(root, rootStat);
  for (const [i, part] of parts.entries()) {
    current = path.join(current, part); const s = await fs.lstat(current), last = i === parts.length - 1;
    if (s.isSymbolicLink() || await fs.realpath(current) !== current || (!last || directory ? !s.isDirectory() : !s.isFile())) throw userError('源文件或目录不是普通本机文件');
    if (s.isDirectory()) remember?.(current, s);
    if (last) return {file: current, stat: s};
  }
}
async function digestFile(file, signal) {
  signal?.throwIfAborted(); const s = await fs.lstat(file);
  if (!s.isFile() || s.isSymbolicLink() || await fs.realpath(file) !== file) throw userError('预检文件不是普通文件');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW), sha = createHash('sha256');
  try {
    if (mark(await handle.stat()) !== mark(s)) throw userError('预检文件已被替换', 409);
    for await (const chunk of handle.createReadStream({autoClose: false})) {signal?.throwIfAborted(); sha.update(chunk);}
    if (mark(await handle.stat()) !== mark(s) || mark(await fs.lstat(file)) !== mark(s) || await fs.realpath(file) !== file) throw userError('预检期间源文件发生变化', 409);
    return {file, size: s.size, sha256: sha.digest('hex'), fingerprint: mark(s)};
  } finally {await handle.close();}
}
async function checkedJson(file, limit, signal) {
  signal?.throwIfAborted();
  const s = await fs.lstat(file);
  if (!s.isFile() || s.isSymbolicLink() || await fs.realpath(file) !== file || s.size > limit) throw userError('目录清单不是普通文件或超过12MiB', 413);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (mark(await handle.stat()) !== mark(s)) throw userError('目录清单已被替换', 409);
    const bytes = await handle.readFile(); signal?.throwIfAborted();
    if (mark(await handle.stat()) !== mark(s) || mark(await fs.lstat(file)) !== mark(s)) throw userError('目录清单在读取期间变化', 409);
    let value; try {value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes).replace(/^\uFEFF/u, ''));} catch {throw userError('目录清单不是有效 UTF-8 JSON');}
    guard(value); assertNoCredentials(value); return {value, fingerprint: mark(s), sha256: hash(bytes), size: s.size};
  } finally {await handle.close();}
}

// The active root categories field is an alias, never a second library.
export function normalizeNativeLibraryIndex(input) {
  guard(input); assertNoCredentials(input);
  fields(input, ['active_library_id', 'libraries', 'categories', 'updated_at'], '原版目录清单');
  if (input.libraries !== undefined && !Array.isArray(input.libraries) || input.categories !== undefined && !Array.isArray(input.categories)) throw userError('原版库或活动分组别名结构无效');
  if (input.updated_at !== undefined && (!Number.isSafeInteger(input.updated_at) || input.updated_at < 0)) throw userError('原版目录更新时间无效');
  const raw = Array.isArray(input.libraries) && input.libraries.length ? input.libraries : [{id: 'default', name: '默认资产库', type: 'asset', categories: input.categories}];
  if (!raw.length || raw.length > 100) throw userError('原版素材库最多100个库');
  const libIds = new Set(); let itemCount = 0;
  const libraries = raw.map(l => {
    fields(l, ['id', 'name', 'type', 'categories'], '原版素材库'); const id = sourceId(l.id);
    if (libIds.has(id) || l.type !== undefined && l.type !== 'asset' || !Array.isArray(l.categories) || l.categories.length > 200) throw userError('原版素材库编号、类型或分组数量无效');
    libIds.add(id); const catIds = new Set();
    return {id, name: textValue(l.name, 80, '素材库名称'), categories: l.categories.map(c => {
      fields(c, ['id', 'name', 'type', 'items', 'dir'], '原版分组'); const categoryId = sourceId(c.id);
      if (catIds.has(categoryId) || !Array.isArray(c.items) || c.items.length > 10000) throw userError('原版分组编号或条目数量无效'); catIds.add(categoryId);
      if (c.dir !== undefined) relativePath(c.dir);
      const ids = new Set();
      return {id: categoryId, name: textValue(c.name, 80, '素材分组名称'), type: c.type ?? 'image', ...(c.dir ? {dir: c.dir} : {}), items: c.items.map(i => {
        fields(i, ['id', 'name', 'url', 'kind', 'mediaKind', 'type', 'format', 'size', 'created_at', 'classification', 'registrations', 'node_count', 'connection_count', 'resource_count', 'thumbnail', 'width', 'height', 'natural_w', 'natural_h'], '原版素材条目');
        const itemId = sourceId(i.id); if (ids.has(itemId) || ++itemCount > 20000) throw userError('原版条目编号重复或超过20000份'); ids.add(itemId);
        if (i.registrations !== undefined && (!object(i.registrations) || Object.keys(i.registrations).length)) throw userError('目录含账号或平台注册记录，请使用移除账号记录的离线副本');
        if (i.created_at !== undefined && (!Number.isFinite(i.created_at) || i.created_at < 0)) throw userError('原版素材时间无效');
        if (i.size !== undefined && (!Number.isSafeInteger(i.size) || i.size < 1 || i.size > NATIVE_LIBRARY_LIMITS.bytes)) throw userError('原版素材字节数无效');
        let classification;
        if (i.classification !== undefined) {
          fields(i.classification, ['summary', 'categories', 'tags', 'flat', 'updated_at', 'model', 'provider'], '原版分类');
          classification = normalizeAssetClassification(i.classification, {providerId: i.classification.provider || '', model: i.classification.model || ''});
          if (i.classification.updated_at !== undefined) {if (!Number.isSafeInteger(i.classification.updated_at) || i.classification.updated_at < 0 || !Number.isFinite(new Date(i.classification.updated_at).valueOf())) throw userError('原版分类时间无效'); classification.updatedAt = new Date(i.classification.updated_at).toISOString();}
        }
        for (const key of ['width', 'height', 'natural_w', 'natural_h', 'node_count', 'connection_count', 'resource_count']) if (i[key] !== undefined && (!Number.isSafeInteger(i[key]) || i[key] < 0)) throw userError('原版素材尺寸或计数无效');
        for (const key of ['kind', 'mediaKind', 'type', 'format', 'thumbnail']) if (i[key] !== undefined && (typeof i[key] !== 'string' || i[key].length > (key === 'thumbnail' ? 2048 : 100) || /[\u0000-\u001f\u007f]/u.test(i[key]))) throw userError('原版素材类型或缩略图字段无效');
        const sourceMetadata = Object.fromEntries(Object.entries(i).filter(([key]) => key !== 'registrations'));
        return {id: itemId, name: textValue(i.name, 200, '素材名称'), url: i.url, kind: i.kind || i.mediaKind || i.type || '', sourceMetadata, ...(i.size !== undefined ? {size: i.size} : {}), ...(i.created_at !== undefined ? {createdAt: i.created_at} : {}), ...(classification ? {classification} : {})};
      })};
    })};
  });
  const active = input.active_library_id || libraries[0].id;
  if (!libraries.some(l => l.id === active)) throw userError('原版活动素材库不存在');
  return {libraries, activeLibraryId: active, updatedAt: input.updated_at};
}

export function nativeLibraryImportService({data, projects, catalog, bundles, maxBytes = NATIVE_LIBRARY_LIMITS.bytes, manifestLimit = NATIVE_LIBRARY_LIMITS.manifest, diskInfo = fs.statfs}) {
  const locks = new Set();
  async function base() {const root = await fs.realpath(data); const dir = path.join(root, 'native-library-import'); await fs.mkdir(dir, {recursive: true}); if (await fs.realpath(dir) !== dir || (await fs.lstat(dir)).isSymbolicLink()) throw userError('目录导入记录位置不能是符号链接'); return {root, dir};}
  async function directory(...parts) {let dir = (await base()).dir; for (const part of parts) {dir = path.join(dir, checkedId(part)); await fs.mkdir(dir, {recursive: true}); if (await fs.realpath(dir) !== dir || (await fs.lstat(dir)).isSymbolicLink()) throw userError('目录导入位置已变化');} return dir;}
  async function targetDirectory(relative) {let dir = (await base()).root; for (const part of relativePath(relative)) {dir = path.join(dir, part); await fs.mkdir(dir, {recursive: true}); if (await fs.realpath(dir) !== dir || (await fs.lstat(dir)).isSymbolicLink()) throw userError('本地目标目录已变化');} return dir;}
  async function save(record, initial = false) {guard(record); assertNoCredentials(record); const bytes = JSON.stringify(record); if (Buffer.byteLength(bytes) > manifestLimit) throw userError('导入计划超过12MiB', 413); const dir = await directory('previews', record.id), file = path.join(dir, 'record.json'); if (initial) {const staged = path.join(dir, randomUUID() + '.record-pending'); await fs.writeFile(staged, bytes, {flag: 'wx', mode: 0o600}); await fs.link(staged, file);} else await atomicJson(file, record);}
  async function read(id, projectId) {checkedId(id); checkedId(projectId); await projects.load(projectId); const file = path.join(await directory('previews', id), 'record.json'); const {value} = await checkedJson(file, manifestLimit); if (value.version !== 1 || value.id !== id || value.projectId !== projectId || !Array.isArray(value.files) || !Array.isArray(value.prepared) || !Array.isArray(value.missing) || !Array.isArray(value.unsupported) || !object(value.mapping) || typeof value.signature !== 'string' || planSignature(value) !== value.signature) throw userError('预检记录不属于当前项目或计划已损坏', 409);
    const current = await catalog.read(), receipt = current.libraryBackupRestores?.[value.id], expectedIds = value.catalog.libraries.map(l => value.mapping.libraries[l.id]);
    if (receipt) {if (receipt.signature !== value.signature || JSON.stringify(receipt.libraryIds) !== JSON.stringify(expectedIds) || expectedIds.some(id => !current.libraries.some(l => l.id === id && l.importLibraryBackupId === value.id))) throw userError('素材库发布收据与原导入计划不一致', 409); value.status = 'completed'; value.result = {id, status: 'completed', libraryIds: receipt.libraryIds, mapping: value.sourceMapping, counts: value.counts, alreadyPublished: true};}
    else if (value.result || value.status === 'completed') throw userError('预检结果尚无真实素材库发布收据', 409);
    return value;
  }
  function visible(record) {const status = record.status === 'importing' && !locks.has(record.id) ? 'interrupted' : record.status; const messages = {checked: '目录预检通过；明确确认后追加独立素材库', blocked: '目录含缺失或不支持条目，尚不能完整导入', importing: '正在本机复制并复验；未知结果请读取原编号', interrupted: '导入已中止；副本保留，可沿用原计划继续', failed: '导入未完成；源文件和已接收副本保留', completed: '已追加新素材库；原项目与活动库选择保持'}; return {id: record.id, projectId: record.projectId, status, sourceDirectory: record.sourceDirectory, sourceSha256: record.sourceSha256, catalogRevision: record.catalogRevision, counts: record.counts, bytes: record.bytes, missing: record.missing, unsupported: record.unsupported, warnings: record.warnings, canImport: ['checked', 'interrupted', 'failed'].includes(status) && !record.missing.length && !record.unsupported.length, mapping: record.sourceMapping, createdAt: record.createdAt, message: messages[status], ...(record.importRequestId ? {importRequestId: record.importRequestId} : {}), ...(record.error ? {error: record.error} : {}), ...(record.result ? {result: record.result} : {})};}
  async function locked(id, fn) {if (locks.has(id)) throw userError('该目录预检或导入正在进行，请读取原编号', 409); locks.add(id); try {return await fn();} finally {locks.delete(id);}}
  async function verifySources(record, signal) {
    signal?.throwIfAborted();
    if (!object(record.sourceDirectories) || record.sourceDirectories[record.sourceDirectory] !== record.sourceRootMark) throw userError('预检目录身份记录不完整，请重新预检', 409);
    await ordinaryAbsolute(record.sourceDirectory);
    if (directoryMark((await fs.lstat(record.sourceDirectory))) !== record.sourceRootMark) throw userError('源项目根目录已被替换，请重新预检', 409);
    const assertDirectories = async () => {for (const [directory, fingerprint] of Object.entries(record.sourceDirectories)) {signal?.throwIfAborted(); const stat = await fs.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== directory || directoryMark(stat) !== fingerprint) throw userError('源目录链已被替换，请重新预检', 409);}};
    await assertDirectories();
    const index = await ordinary(record.sourceDirectory, 'data/asset_library.json'), actual = await digestFile(index.file, signal);
    if (actual.fingerprint !== record.index.fingerprint || actual.sha256 !== record.index.sha256) throw userError('源目录索引已变化，请重新预检', 409);
    for (const entry of record.files) {const source = await ordinary(record.sourceDirectory, entry.relative); const value = await digestFile(source.file, signal); if (value.size !== entry.size || value.sha256 !== entry.sha256 || value.fingerprint !== entry.fingerprint) throw userError('源素材在预检后变化，请重新预检', 409);}
    await assertDirectories();
  }
  async function preview(body, {signal} = {}) {signal?.throwIfAborted(); fields(body, ['requestId', 'projectId', 'sourceDirectory'], '目录预检参数'); assertNoCredentials(body); const id = checkedId(body.requestId), projectId = checkedId(body.projectId); await projects.load(projectId);
    return locked(id, async () => {
      let old; try {old = await read(id, projectId);} catch (e) {if (e.code !== 'ENOENT') throw e;}
      if (old) {if (old.sourceDirectory !== body.sourceDirectory) throw userError('预检编号已用于另一源目录', 409); return visible(old);}
      const sourceDirectories = {};
      const remember = (directory, stat) => {const fingerprint = typeof stat === 'string' ? stat : directoryMark(stat); if (sourceDirectories[directory] !== undefined && sourceDirectories[directory] !== fingerprint) throw userError('预检期间源目录已被替换', 409); sourceDirectories[directory] = fingerprint;};
      const sourceDirectory = await ordinaryAbsolute(body.sourceDirectory, remember), sourceRootMark = sourceDirectories[sourceDirectory], b = await base();
      if (sourceDirectory === b.root || sourceDirectory.startsWith(b.root + path.sep) || b.root.startsWith(sourceDirectory + path.sep)) throw userError('源目录不能与本地数据目录重叠');
      let indexFile; try {indexFile = await ordinary(sourceDirectory, 'data/asset_library.json', false, remember); await ordinary(sourceDirectory, 'assets/library', true, remember);} catch (e) {if (e.code === 'ENOENT') throw userError('请选择含 data/asset_library.json 和 assets/library 的原版项目根目录'); throw e;}
      const index = await checkedJson(indexFile.file, manifestLimit, signal), normalized = normalizeNativeLibraryIndex(index.value), current = await catalog.read();
      const mapping = {libraries: {}, folders: {}, items: {}, assets: {}, workflows: {}, bundles: {}, bundleSummaries: {}}, sourceMapping = {libraries: [], folders: [], items: []}, missing = [], unsupported = [], warnings = ['仅导入目录索引中的条目；原项目、源文件、平台账号和当前库选择保持。'], files = [], prepared = [], libraries = []; let bytes = 0;
      const addFile = async relative => {signal?.throwIfAborted(); let existing = files.find(f => f.relative === relative); if (existing) return existing; const {file, stat} = await ordinary(sourceDirectory, relative, false, remember); if (!stat.size || stat.size > maxBytes) throw userError('源文件为空或超过4GiB', 413); const v = await digestFile(file, signal); existing = {...v, relative}; delete existing.file; files.push(existing); return existing;};
      for (const l of normalized.libraries) {
        signal?.throwIfAborted();
        const libraryId = randomUUID(); mapping.libraries[libraryId] = libraryId; sourceMapping.libraries.push({sourceId: l.id, targetId: libraryId});
        const library = {id: libraryId, name: l.name, archived: false, folders: []}; libraries.push(library);
        for (const c of l.categories) {
          signal?.throwIfAborted();
          const folderId = randomUUID(); mapping.folders[folderId] = folderId; sourceMapping.folders.push({libraryId: l.id, sourceId: c.id, targetId: folderId});
          const type = c.type === 'workflow' ? 'workflow' : ['image', 'media'].includes(c.type) ? 'media' : null;
          if (!type) {unsupported.push({libraryId: l.id, categoryId: c.id, reason: '未知分组类型'}); continue;}
          const f = {id: folderId, name: c.name, type, archived: false, items: []}; library.folders.push(f);
          for (const i of c.items) {
            signal?.throwIfAborted();
            const ref = {libraryId: l.id, categoryId: c.id, itemId: i.id}; let relative;
            try {relative = mediaRelative(i.url);} catch {unsupported.push({...ref, reason: '素材路径无效'}); continue;}
            if (!relative) {unsupported.push({...ref, reason: '只支持索引中的 /assets/library 本机副本；外部地址未访问'}); continue;}
            if (i.sourceMetadata.thumbnail && i.sourceMetadata.thumbnail !== i.url) {unsupported.push({...ref, reason: '独立缩略图引用尚不支持完整迁入；未访问缩略图'}); continue;}
            if (['text', 'file'].includes(i.kind)) {unsupported.push({...ref, reason: '当前不支持文本或通用文件条目'}); continue;}
            let source; try {source = await addFile(relative);} catch (e) {if (e.code === 'ENOENT') {missing.push({...ref, reason: '索引引用的本机文件缺失'}); continue;} throw e;}
            if (i.size !== undefined && i.size !== source.size) throw userError('索引素材字节数与本机文件不一致');
            const itemId = randomUUID(); mapping.items[itemId] = itemId;
            const provenance = {...ref, metadata: i.sourceMetadata, ...(i.createdAt !== undefined ? {createdAt: i.createdAt} : {})};
            if (type === 'media') {
              const mediaType = fileMediaType({name: relative});
              if (!streamMediaType(mediaType) || source.size > MAX_STREAM_MEDIA_BYTES) {unsupported.push({...ref, reason: '媒体格式或大小尚不支持'}); continue;}
              const handle = await fs.open(path.join(sourceDirectory, relative), constants.O_RDONLY | constants.O_NOFOLLOW); try {const prefix = Buffer.alloc(64), n = await handle.read(prefix, 0, 64, 0); checkMediaHeader(prefix.subarray(0, n.bytesRead), mediaType);} finally {await handle.close();}
              const kind = mediaType.split('/')[0]; if (i.kind && ![kind, 'media'].includes(i.kind)) {unsupported.push({...ref, reason: '条目种类与实际媒体内容不一致'}); continue;}
              const assetId = randomUUID(); mapping.assets[assetId] = assetId;
              f.items.push({id: itemId, name: i.name, kind: 'media', archived: false, assetId});
              prepared.push({kind: 'media', id: assetId, itemId, source: relative, size: source.size, sha256: source.sha256, type: mediaType, name: i.name, ...(i.classification ? {classification: i.classification} : {}), provenance}); bytes += source.size;
            } else {
              const dir = await targetDirectory(path.join('native-canvas', 'native-library-import', id, itemId)), inspected = await inspectNativeLibraryWorkflow({file: path.join(sourceDirectory, relative), directory: dir, name: i.name, sourceRoot: sourceDirectory, signal});
              if (inspected.kind === 'unsupported') {unsupported.push({...ref, reason: inspected.reason || '工作流结构尚不支持', ...(inspected.missingResources ? {missingResources: inspected.missingResources} : {})}); continue;}
              for (const extra of inspected.sourceFiles || []) {if (!extra.file.startsWith(sourceDirectory + '/assets/library/')) throw userError('工作流请求访问未知源目录'); for (const directory of extra.directoryMarks || []) {if (directory.directory !== sourceDirectory && !directory.directory.startsWith(sourceDirectory + path.sep)) throw userError('工作流目录身份不属于明确源目录'); remember(directory.directory, directory.fingerprint);} await addFile(path.relative(sourceDirectory, extra.file).split(path.sep).join('/'));}
              const targetId = randomUUID(), kind = inspected.kind; if (!['comfy', 'canvas-fragment'].includes(kind)) throw userError('工作流检查返回未知类型');
              mapping[kind === 'comfy' ? 'workflows' : 'bundles'][targetId] = targetId;
              f.items.push({id: itemId, name: i.name, kind, archived: false, [kind === 'comfy' ? 'workflowId' : 'bundleId']: targetId});
              const preparedEntry = {kind, id: targetId, itemId, name: i.name, source: relative, inspected, provenance}; prepared.push(preparedEntry);
              if (kind === 'comfy') bytes += source.size;
              else {signal?.throwIfAborted(); const exported = await bundles.exportPreparedFragment(inspected.project, inspected.resources || []), packageFile = await bundles.download(exported.id), packageInfo = await digestFile(packageFile, signal); preparedEntry.package = {...packageInfo, exported}; bytes += packageInfo.size;}
            }
            sourceMapping.items.push({...ref, metadata: i.sourceMetadata, targetId: itemId, fileId: prepared.at(-1).id, kind: prepared.at(-1).kind});
            if (bytes > maxBytes) throw userError('目录导入内容超过4GiB，请拆分源库', 413);
          }
        }
      }
      const active = sourceMapping.libraries.find(l => l.sourceId === normalized.activeLibraryId)?.targetId || libraries[0].id;
      const preparedCatalog = normalizeAssetCatalog({version: 1, revision: 0, activeLibraryId: active, libraries});
      normalizeAssetCatalog({...current, libraries: [...current.libraries, ...preparedCatalog.libraries]});
      // Storage settings only describe another scope; they never authorize reading it.
      try {const settingsFile = await ordinary(sourceDirectory, 'data/storage_settings.json', false, remember), settings = await checkedJson(settingsFile.file, 65536, signal); fields(settings.value, ['upload', 'generated', 'local'], '原版存储目录设置'); if (typeof settings.value.local === 'string' && settings.value.local && settings.value.local !== 'assets/uploads' && settings.value.local !== path.join(sourceDirectory, 'assets/uploads')) warnings.push('原版配置了自定义本地上传目录；本次未访问。需要另行明确选择该目录。');} catch (e) {if (e.code !== 'ENOENT') throw e;}
      const sourceSha256 = hash({index: index.sha256, files, directories: sourceDirectories}), counts = {libraries: libraries.length, folders: libraries.reduce((n, l) => n + l.folders.length, 0), items: prepared.length, media: prepared.filter(p => p.kind === 'media').length, workflows: prepared.filter(p => p.kind === 'comfy').length, fragments: prepared.filter(p => p.kind === 'canvas-fragment').length, missing: missing.length, unsupported: unsupported.length};
      const record = {version: 1, id, projectId, sourceDirectory, sourceRootMark, sourceDirectories, index: {sha256: index.sha256, fingerprint: index.fingerprint, size: index.size}, sourceSha256, catalogRevision: current.revision, catalog: preparedCatalog, mapping, sourceMapping, files, prepared, counts, bytes, missing, unsupported, warnings, status: missing.length || unsupported.length ? 'blocked' : 'checked', createdAt: now()};
      record.signature = planSignature(record); await verifySources(record, signal); signal?.throwIfAborted(); await save(record, true); return visible(record);
    });
  }
  async function inspect(id, projectId) {return visible(await read(id, projectId));}
  async function list(projectId) {
    checkedId(projectId); await projects.load(projectId); const dir = await directory('previews'), items = [], issues = [];
    for (const name of await fs.readdir(dir)) {
      if (!safeId(name)) continue;
      let belongs = false;
      try {const {value} = await checkedJson(path.join(dir, name, 'record.json'), manifestLimit); if (value.projectId !== projectId) continue; belongs = true; items.push(visible(await read(name, projectId)));}
      catch (e) {if (belongs && e.code !== 'ENOENT') issues.push({id: name, reason: '本机预检记录损坏；未访问源目录'});}
    }
    return {items: items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), issues};
  }
  async function installJson(file, value, dir) {
    const bytes = Buffer.from(JSON.stringify(value)); guard(value); assertNoCredentials(value);
    try {const old = await checkedJson(file, manifestLimit); if (hash(JSON.stringify(old.value)) !== hash(bytes)) throw userError('导入目标记录已被其他内容占用，现有文件保留', 409); return;} catch (e) {if (e.code !== 'ENOENT') throw e;}
    const staged = path.join(dir, randomUUID() + '.pending'); await fs.writeFile(staged, bytes, {flag: 'wx', mode: 0o444}); await fs.link(staged, file);
  }
  async function installMedia(source, target, entry, dir, signal) {
    try {const old = await digestFile(target, signal); if (old.size !== entry.size || old.sha256 !== entry.sha256) throw userError('导入媒体编号已被占用，原文件保留', 409); return;} catch (e) {if (e.code !== 'ENOENT') throw e;}
    const before = await digestFile(source, signal); if (before.sha256 !== entry.sha256 || before.size !== entry.size) throw userError('预检媒体已变化', 409);
    const staged = path.join(dir, randomUUID() + '.pending'), input = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW), output = await fs.open(staged, 'wx', 0o600), digest = createHash('sha256'); let total = 0;
    try {if (mark(await input.stat()) !== before.fingerprint) throw userError('媒体在复制前被替换', 409); for await (const chunk of input.createReadStream({autoClose: false})) {signal?.throwIfAborted(); let offset = 0; while (offset < chunk.length) {const r = await output.write(chunk, offset, chunk.length - offset); if (!r.bytesWritten) throw userError('本机复制中断'); offset += r.bytesWritten;} digest.update(chunk); total += chunk.length;} await output.sync(); if (total !== entry.size || digest.digest('hex') !== entry.sha256 || mark(await input.stat()) !== before.fingerprint || mark(await fs.lstat(source)) !== before.fingerprint) throw userError('本机复制期间媒体发生变化', 409); await output.chmod(0o444);} finally {await input.close(); await output.close();}
    signal?.throwIfAborted(); await fs.link(staged, target); const installed = await digestFile(target, signal); if (installed.size !== entry.size || installed.sha256 !== entry.sha256) throw userError('安装后的媒体校验失败');
  }
  async function importDirectory(id, body, {signal} = {}) {fields(body, ['requestId', 'projectId', 'revision', 'confirmLocalImport'], '目录导入参数'); assertNoCredentials(body); const requestId = checkedId(body.requestId), projectId = checkedId(body.projectId); if (body.confirmLocalImport !== true) throw userError('请明确确认本机目录导入'); if (!Number.isSafeInteger(body.revision) || body.revision < 0) throw userError('请读取当前素材库修订');
    return locked(checkedId(id), async () => {
      const record = await read(id, projectId); if (record.missing.length || record.unsupported.length) throw userError('预检存在缺失或不支持条目，不能完整导入');
      if (record.importRequestId && record.importRequestId !== requestId) throw userError('请使用原导入请求编号继续此预检计划', 409);
      const requests = await directory('requests'), dir = await directory('previews', id, 'attempts'); await installJson(path.join(requests, requestId + '.json'), {version: 1, requestId, previewId: id, projectId, signature: record.signature}, dir);
      if (!record.importRequestId) {record.importRequestId = requestId; await save(record);}
      if (record.result) return {...record.result, alreadyPublished: true};
      const current = await catalog.read();
      const published = current.libraryBackupRestores?.[record.id]; if (published) {if (published.signature !== record.signature) throw userError('原导入发布签名冲突', 409); record.status = 'completed'; record.result = {id, status: 'completed', libraryIds: published.libraryIds, mapping: record.sourceMapping, counts: record.counts, alreadyPublished: true}; await save(record); return record.result;}
      signal?.throwIfAborted(); await verifySources(record, signal);
      if (current.revision !== body.revision) throw userError('素材库已更新，请刷新后继续原导入计划', 409);
      normalizeAssetCatalog({...current, libraries: [...current.libraries, ...record.catalog.libraries]});
      const disk = await diskInfo((await base()).root); if (disk.bavail * disk.bsize < record.bytes * 2 + 64 * 1024 ** 2) throw userError('本机空间不足以导入并保存独立库副本及64MiB余量', 507);
      record.status = 'importing'; delete record.error; await save(record);
      try {
        const assets = await targetDirectory('assets'), workflowDir = await targetDirectory('workflows'); let outputBytes = 0;
        for (const entry of record.prepared) {
          signal?.throwIfAborted();
          if (entry.kind === 'media') {
            await installMedia(path.join(record.sourceDirectory, entry.source), path.join(assets, entry.id), entry, dir, signal);
            const meta = {id: entry.id, name: entry.name, type: entry.type, size: entry.size, sha256: entry.sha256, category: '原版素材库', tags: entry.classification?.tags || [], ...(entry.classification ? {classification: entry.classification} : {}), createdAt: record.createdAt, source: 'native-library-import', importNativeLibraryId: id, nativeLibrarySource: entry.provenance, url: '/media/' + entry.id};
            await installJson(path.join(assets, entry.id + '.json'), meta, dir); outputBytes += entry.size;
          } else if (entry.kind === 'comfy') {
            const value = {id: entry.id, name: textValue(entry.name, 120, '工作流名称'), workflow: entry.inspected.workflow, inspection: entry.inspected.inspection, fields: entry.inspected.fields || [], revision: 0, createdAt: record.createdAt, importNativeLibraryId: id, nativeLibrarySource: entry.provenance};
            await installJson(path.join(workflowDir, entry.id + '.json'), value, dir); outputBytes += Buffer.byteLength(JSON.stringify(value));
          } else {
            for (const resource of entry.inspected.resources || []) {const d = await digestFile(resource.file, signal); if (d.size !== resource.size || d.sha256 !== resource.sha256) throw userError('预检画布素材副本发生变化', 409);}
            const b = await base(); if (!entry.package || !entry.package.file.startsWith(path.join(b.root, 'bundles', 'exports') + path.sep)) throw userError('画布准备文件不属于本机导入计划');
            const packageInfo = await digestFile(entry.package.file, signal); if (packageInfo.size !== entry.package.size || packageInfo.sha256 !== entry.package.sha256 || packageInfo.fingerprint !== entry.package.fingerprint) throw userError('预检画布准备文件已变化', 409);
            const bundleDir = await targetDirectory(path.join('library-backups', 'native-library-import', id)), retained = path.join(bundleDir, entry.id + '.bundle'); await installMedia(entry.package.file, retained, entry.package, dir, signal);
            // A fixed checked package closes the restore→record-save crash window.
            const summary = await bundles.restoreLibraryPackage(retained, entry.id, 'canvas-fragment'); if (summary.sha256 !== entry.package.sha256) throw userError('发布画布文件与原预检不一致', 409); record.mapping.bundleSummaries[entry.id] = summary; await save(record);
            outputBytes += entry.package.size;
          }
          if (outputBytes > maxBytes) throw userError('转换后的目录内容超过4GiB，未发布素材库', 413);
        }
        signal?.throwIfAborted(); await verifySources(record, signal); signal?.throwIfAborted();
        const result = await catalog.publishLibraryBackup({catalog: record.catalog, mapping: record.mapping, requestId: record.id, signature: record.signature, expectedRevision: body.revision, signal});
        record.status = 'completed'; record.result = {id, status: 'completed', libraryIds: result.libraryIds, mapping: record.sourceMapping, counts: record.counts, alreadyPublished: result.alreadyPublished}; await save(record); return record.result;
      } catch (e) {record.status = signal?.aborted ? 'interrupted' : 'failed'; record.error = '本机目录导入未完成；源文件和已接收副本保留'; await save(record).catch(() => {}); throw e.status || e.name === 'AbortError' ? e : userError(record.error);}
    });
  }
  return {preview, inspect, list, import: importDirectory};
}
