import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs, readdirSync, statSync, renameSync, mkdirSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID, createHash} from 'node:crypto';
import {nativeLibraryImportService, normalizeNativeLibraryIndex} from '../lib/native-library-import.mjs';
import {writeNativeZip} from '../lib/native-canvas-export.mjs';
import {libraryFixture, png} from './helpers/library-backup-fixture.mjs';
import {loadAsset} from '../lib/workspace.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function sourceFixture({media = true, workflows = true} = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jc-native-library-source-')));
  await fs.mkdir(path.join(root, 'data')); await fs.mkdir(path.join(root, 'assets', 'library', '角色'), {recursive: true});
  const mediaItems = [], workflowItems = [];
  if (media) {
    const mp4 = Buffer.alloc(32); mp4.writeUInt32BE(24); mp4.write('ftypisom', 4);
    const wav = Buffer.alloc(48); wav.write('RIFF'); wav.writeUInt32LE(40, 4); wav.write('WAVE', 8);
    for (const [name, bytes, kind] of [['角色.png', png, 'image'], ['视频.mp4', mp4, 'video'], ['音频.wav', wav, 'audio']]) {
      await fs.writeFile(path.join(root, 'assets', 'library', '角色', name), bytes);
      mediaItems.push({id: 'source-' + kind, name: '原版' + kind, kind, url: '/assets/library/' + encodeURIComponent('角色') + '/' + encodeURIComponent(name), created_at: 1783212587156, registrations: {}, ...(kind === 'image' ? {classification: {summary: '原分类', categories: {subject: ['角色']}, tags: ['手绘'], flat: [{dimension: 'subject', label: '主体', tag: '角色'}], updated_at: 1783212587156}} : {})});
    }
  }
  if (workflows) {
    const comfy = {'1': {class_type: 'LoadImage', inputs: {image: 'placeholder.png'}}, '2': {class_type: 'SaveImage', inputs: {images: ['1', 0], filename_prefix: 'local'}}};
    await fs.writeFile(path.join(root, 'assets', 'library', 'comfy.json'), JSON.stringify(comfy));
    const doc = {format: 'infinite-canvas-workflow', version: 1, nodes: [{id: 'original-prompt', type: 'text', x: 100, y: 100, text: '本机片段'}], connections: [], resources: []};
    await fs.writeFile(path.join(root, 'assets', 'library', 'canvas.json'), JSON.stringify(doc));
    workflowItems.push({id: 'source-comfy', name: '原版模板', kind: 'workflow', type: 'workflow', format: 'json', url: '/assets/library/comfy.json'}, {id: 'source-canvas', name: '原版片段', kind: 'workflow', type: 'workflow', format: 'json', url: '/assets/library/canvas.json'});
  }
  const first = {id: 'default', name: '原版主库', type: 'asset', categories: [{id: 'characters', name: '角色组', type: 'image', dir: '角色', items: mediaItems}, {id: 'empty', name: '保留空分组', type: 'image', dir: '空组', items: []}, {id: 'workflows', name: '工作流组', type: 'workflow', items: workflowItems}]};
  const index = {active_library_id: 'default', libraries: [first, {id: 'second', name: '原版第二库', type: 'asset', categories: [{id: 'characters', name: '同源编号空组', type: 'image', items: []}]}], categories: first.categories, updated_at: 1783212587156};
  const indexFile = path.join(root, 'data', 'asset_library.json');
  const save = async () => fs.writeFile(indexFile, JSON.stringify(index)); await save();
  return {root, index, indexFile, save};
}
async function targetFixture(options = {}) {const f = await libraryFixture(), service = nativeLibraryImportService({data: f.data, projects: f.projects, catalog: f.catalog, bundles: f.bundles, ...options}); return {...f, service};}
const preview = (dst, src, requestId = randomUUID()) => dst.service.preview({requestId, projectId: dst.p.id, sourceDirectory: src.root});
const start = async (dst, checked, requestId = randomUUID(), options = {}) => dst.service.import(checked.id, {requestId, projectId: dst.p.id, revision: (await dst.catalog.read()).revision, confirmLocalImport: true}, options);

test('真实目录跨工作区追加全部库/空分组/三类媒体/Comfy与原生JSON；原件和工程保持', async () => {
  const src = await sourceFixture(), dst = await targetFixture(), before = await dst.catalog.read(), project = structuredClone(dst.map.get(dst.p.id)), original = await fs.readFile(src.indexFile);
  const checked = await preview(dst, src); assert.equal(checked.status, 'checked'); assert.equal(checked.canImport, true); assert.deepEqual(checked.counts, {libraries: 2, folders: 4, items: 5, media: 3, workflows: 1, fragments: 1, missing: 0, unsupported: 0});
  assert.deepEqual(await dst.catalog.read(), before); assert.equal((await dst.service.inspect(checked.id, dst.p.id)).sourceSha256, checked.sourceSha256);
  const completed = await start(dst, checked), after = await dst.catalog.read(); assert.equal(completed.status, 'completed'); assert.equal(after.libraries.length, 3); assert.equal(after.activeLibraryId, before.activeLibraryId); assert.deepEqual(after.libraries[0], before.libraries[0]); assert.deepEqual(dst.map.get(dst.p.id), project); assert.deepEqual(await fs.readFile(src.indexFile), original);
  const added = after.libraries.filter(l => completed.libraryIds.includes(l.id)); assert.deepEqual(added.map(l => l.name), ['原版主库', '原版第二库']); assert.equal(added[0].folders[1].name, '保留空分组'); assert.equal(added[0].folders[1].items.length, 0); assert.equal(completed.mapping.folders.filter(f => f.sourceId === 'characters').length, 2);
  for (const i of added[0].folders[0].items) {const a = await loadAsset(dst.data, i.assetId); assert.equal(a.nativeLibrarySource.itemId, completed.mapping.items.find(m => m.targetId === i.id).itemId); assert.equal(a.sha256, sha(await fs.readFile(path.join(dst.data, 'assets', a.id)))); if (a.type === 'image/png') assert.deepEqual(a.classification.categories.subject, ['角色']);}
  const workflowItems = added[0].folders[2].items; assert.deepEqual(workflowItems.map(i => i.kind), ['comfy', 'canvas-fragment']); assert.equal((await dst.generation.template(workflowItems[0].workflowId)).inspection.nodeCount, 2); assert.equal((await dst.bundles.previewLibraryPackage(workflowItems[1].bundleId)).canvasFragment, true);
  assert.equal((await fs.readdir(path.join(dst.data, 'jobs')).catch(() => [])).length, 0); assert.equal(dst.activeJobs.size, 0); assert.equal(dst.map.size, 1);
});

test('原生ZIP含打包资源通过现有bundle转换，JSON本机库资源纳入源digest', async () => {
  const src = await sourceFixture({workflows: false}), dst = await targetFixture(); const url = '/assets/library/' + encodeURIComponent('角色') + '/' + encodeURIComponent('角色.png');
  const doc = {format: 'infinite-canvas-workflow', version: 1, nodes: [{id: 'img-source', type: 'image', x: 0, y: 0, url}], connections: [], resources: [{url, archive: 'resources/ref.png', name: 'ref.png', size: png.length}]};
  const zip = path.join(src.root, 'assets', 'library', 'workflow.zip'); await writeNativeZip(zip, doc, [{id: 'packed-image', name: 'ref.png', type: 'image/png', size: png.length, sha256: sha(png)}], [{file: path.join(src.root, 'assets', 'library', '角色', '角色.png')}]);
  await fs.writeFile(path.join(src.root, 'assets', 'library', 'linked.json'), JSON.stringify(doc));
  src.index.libraries[0].categories[2].items = [{id: 'zip', name: '资源ZIP', kind: 'workflow', url: '/assets/library/workflow.zip'}, {id: 'linked', name: '本机引用JSON', kind: 'workflow', url: '/assets/library/linked.json'}]; await src.save();
  const checked = await preview(dst, src); assert.equal(checked.counts.fragments, 2); assert.equal(checked.canImport, true); const done = await start(dst, checked), entries = (await dst.catalog.read()).libraries.filter(l => done.libraryIds.includes(l.id)).flatMap(l => l.folders.flatMap(f => f.items)).filter(i => i.kind === 'canvas-fragment');
  for (const item of entries) {const p = await dst.bundles.previewLibraryPackage(item.bundleId); assert.equal(p.assets, 1); assert.equal(p.nodes, 1);} assert.equal(dst.map.size, 1);
});

test('持久UUID计划、预检/导入请求幂等与关闭后list恢复；原请求换preview阻止', async () => {
  const src = await sourceFixture({workflows: false}), dst = await targetFixture(), id = randomUUID(), requestId = randomUUID(), checked = await preview(dst, src, id);
  assert.deepEqual(await preview(dst, src, id), checked); const done = await start(dst, checked, requestId); const count = (await dst.catalog.read()).libraries.length;
  dst.service = nativeLibraryImportService({data: dst.data, projects: dst.projects, catalog: dst.catalog, bundles: dst.bundles}); const inspected = await dst.service.inspect(id, dst.p.id); assert.equal(inspected.importRequestId, requestId); assert.equal(inspected.canImport, false); assert.deepEqual((await dst.service.list(dst.p.id)).items.map(i => i.id), [id]);
  const repeated = await start(dst, checked, requestId); assert.equal(repeated.alreadyPublished, true); assert.deepEqual(repeated.libraryIds, done.libraryIds); assert.equal((await dst.catalog.read()).libraries.length, count); await assert.rejects(start(dst, checked), /原导入请求编号/);
  const second = await preview(dst, src); await assert.rejects(start(dst, second, requestId), /占用/);
});

test('缺文件、外部URL、text/file与未知工作流形成明确blocked预览，不静默发布', async () => {
  const src = await sourceFixture({media: false, workflows: false}), dst = await targetFixture(); await fs.writeFile(path.join(src.root, 'assets', 'library', 'unknown.json'), JSON.stringify({unknown: true}));
  src.index.libraries[0].categories[0].items = [{id: 'missing', name: '缺失', url: '/assets/library/no.png'}, {id: 'external', name: '外部', url: 'https://example.invalid/media.png'}, {id: 'text', name: '文本', kind: 'text', url: '/assets/library/a.txt'}]; src.index.libraries[0].categories[2].items = [{id: 'unknown', name: '未知', kind: 'workflow', url: '/assets/library/unknown.json'}]; await src.save();
  const checked = await preview(dst, src); assert.equal(checked.status, 'blocked'); assert.equal(checked.missing.length, 1); assert.equal(checked.unsupported.length, 3); assert.equal(checked.canImport, false); await assert.rejects(start(dst, checked), /缺失或不支持/); assert.equal((await dst.catalog.read()).libraries.length, 1);
});

test('源内容或索引变更、源inode替换和路径注入不能沿用预检', async () => {
  for (const mode of ['content', 'index', 'replacement']) {
    const src = await sourceFixture({workflows: false}), dst = await targetFixture(), checked = await preview(dst, src), media = path.join(src.root, 'assets', 'library', '角色', '角色.png');
    if (mode === 'content') {const b = Buffer.from(png); b[b.length - 1] ^= 1; await fs.writeFile(media, b);} else if (mode === 'index') {src.index.libraries[0].name = '变更'; await src.save();} else {await fs.rename(media, media + '.retained'); await fs.writeFile(media, png);}
    await assert.rejects(start(dst, checked), /变化|替换/); assert.equal((await dst.catalog.read()).libraries.length, 1);
  }
  const src = await sourceFixture({media: false, workflows: false}), dst = await targetFixture(); src.index.libraries[0].categories[0].items = [{id: 'injection', name: '危险', url: '/assets/library/%2e%2e/data/asset_library.json'}]; await src.save(); const checked = await preview(dst, src); assert.equal(checked.unsupported[0].reason, '素材路径无效');
});

test('符号链接、未知根、账号/秘密字段在读取和计划写入前拒绝', async () => {
  const src = await sourceFixture({workflows: false}), dst = await targetFixture(), image = path.join(src.root, 'assets', 'library', '角色', '角色.png'); await fs.rename(image, image + '.retained'); await fs.symlink(image + '.retained', image); await assert.rejects(preview(dst, src), /普通本机文件|符号链接/);
  const unknown = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jc-unknown-library-'))); await assert.rejects(dst.service.preview({requestId: randomUUID(), projectId: dst.p.id, sourceDirectory: unknown}), /原版项目根/);
  for (const value of [{apiKey: 'synthetic-secret'}, {registrations: {platform: {asset_id: 'account-bound'}}}]) {const clean = await sourceFixture({workflows: false}); Object.assign(clean.index.libraries[0].categories[0].items[0], value); await clean.save(); await assert.rejects(preview(dst, clean), /密钥|账号/);}
  assert.throws(() => normalizeNativeLibraryIndex({...src.index, unexpected: {}}), /未知字段/);
});

test('中途复制停止保留partial；同预检与原request重试仅发布一次', async () => {
  const src = await sourceFixture({media: false, workflows: false}), dst = await targetFixture(), bytes = Buffer.alloc(4 * 1024 ** 2); png.copy(bytes); await fs.writeFile(path.join(src.root, 'assets', 'library', 'large.png'), bytes); src.index.libraries[0].categories[0].items = [{id: 'large', name: '中途中止素材', kind: 'image', url: '/assets/library/large.png'}]; await src.save();
  const checked = await preview(dst, src), requestId = randomUUID(), controller = new AbortController(), original = controller.signal.throwIfAborted.bind(controller.signal), attempts = path.join(dst.data, 'native-library-import', 'previews', checked.id, 'attempts');
  controller.signal.throwIfAborted = () => {if (readdirSync(attempts).filter(n => n.endsWith('.pending')).some(n => statSync(path.join(attempts, n)).size >= 65536)) controller.abort(); original();};
  await assert.rejects(start(dst, checked, requestId, {signal: controller.signal}), e => e.name === 'AbortError'); const partial = readdirSync(attempts).filter(n => n.endsWith('.pending')).map(n => statSync(path.join(attempts, n)).size); assert.ok(partial.some(n => n >= 65536 && n < bytes.length)); assert.equal((await dst.catalog.read()).libraries.length, 1); assert.equal((await dst.service.inspect(checked.id, dst.p.id)).status, 'interrupted');
  const done = await start(dst, checked, requestId); assert.equal(done.status, 'completed'); assert.equal((await dst.catalog.read()).libraries.length, 3); assert.equal((await start(dst, checked, requestId)).alreadyPublished, true); assert.equal((await dst.catalog.read()).libraries.length, 3); assert.deepEqual(await fs.readFile(path.join(src.root, 'assets', 'library', 'large.png')), bytes);
});

test('清单/4GiB内容/本地库容量/空间边界，目标占用及篡改计划都拒绝发布', async () => {
  const src = await sourceFixture({workflows: false}); const small = await targetFixture({maxBytes: 32}); await assert.rejects(preview(small, src), /超过4GiB/); const manifest = await targetFixture({manifestLimit: 256}); await assert.rejects(preview(manifest, src), /12MiB/); const disk = await targetFixture({diskInfo: async () => ({bavail: 0, bsize: 1})}), checked = await preview(disk, src); await assert.rejects(start(disk, checked), /空间不足/);
  const dst = await targetFixture(), plan = await preview(dst, src), first = plan.mapping.items[0].fileId; await fs.mkdir(path.join(dst.data, 'assets')); await fs.writeFile(path.join(dst.data, 'assets', first), Buffer.from('occupied')); await assert.rejects(start(dst, plan), /占用/); assert.equal((await dst.catalog.read()).libraries.length, 1);
  const other = await targetFixture(), altered = await preview(other, src), recordFile = path.join(other.data, 'native-library-import', 'previews', altered.id, 'record.json'), record = JSON.parse(await fs.readFile(recordFile)); record.prepared[0].name = '篡改'; await fs.writeFile(recordFile, JSON.stringify(record)); await assert.rejects(other.service.inspect(altered.id, other.p.id), /计划已损坏/); assert.equal((await other.service.list(other.p.id)).issues.length, 1);
  const over = await sourceFixture({media: false, workflows: false}); over.index.libraries = Array.from({length: 100}, (_, i) => ({id: 'lib-' + i, name: '库' + i, categories: []})); over.index.active_library_id = 'lib-0'; await over.save(); await assert.rejects(preview(await targetFixture(), over), /素材库目录记录无效/);
});

test('自定义外部uploads仅提示未访问；list/inspect不再读取源；工程作用域隔离', async () => {
  const src = await sourceFixture({media: false, workflows: false}), dst = await targetFixture(); await fs.writeFile(path.join(src.root, 'data', 'storage_settings.json'), JSON.stringify({local: '/not-readable-external/source'})); const checked = await preview(dst, src); assert.ok(checked.warnings.some(w => w.includes('未访问'))); await fs.rename(src.root, src.root + '-retained'); assert.equal((await dst.service.inspect(checked.id, dst.p.id)).id, checked.id); assert.equal((await dst.service.list(dst.p.id)).items.length, 1); await assert.rejects(dst.service.inspect(checked.id, randomUUID()), /项目不存在/);
  await assert.rejects(dst.service.import(checked.id, {requestId: randomUUID(), projectId: dst.p.id, revision: 0, confirmLocalImport: false}), /明确确认/);
});

test('预检中止传播signal，保留source且不发布checked摘要；原编号可明确重检', async () => {
  const src = await sourceFixture({workflows: false}), dst = await targetFixture(), requestId = randomUUID(), controller = new AbortController(); let checks = 0; const original = controller.signal.throwIfAborted.bind(controller.signal);
  controller.signal.throwIfAborted = () => {if (++checks >= 10) controller.abort(); original();}; const before = await fs.readFile(src.indexFile);
  await assert.rejects(dst.service.preview({requestId, projectId: dst.p.id, sourceDirectory: src.root}, {signal: controller.signal}), e => e.name === 'AbortError'); assert.equal((await dst.service.list(dst.p.id)).items.length, 0); assert.deepEqual(await fs.readFile(src.indexFile), before); assert.equal((await dst.catalog.read()).libraries.length, 1);
  assert.equal((await preview(dst, src, requestId)).status, 'checked');
});

test('动态result不能伪造成功；真实目录已发布但回写失败可无源恢复结果', async () => {
  const src = await sourceFixture({workflows: false}), forged = await targetFixture(), checked = await preview(forged, src), file = path.join(forged.data, 'native-library-import', 'previews', checked.id, 'record.json'), record = JSON.parse(await fs.readFile(file)); record.result = {id: checked.id, status: 'completed', libraryIds: []}; await fs.writeFile(file, JSON.stringify(record)); await assert.rejects(start(forged, checked), /真实素材库发布收据/); assert.equal((await forged.catalog.read()).libraries.length, 1);
  const dst = await targetFixture(), originalPublish = dst.catalog.publishLibraryBackup; let once = true; dst.service = nativeLibraryImportService({data: dst.data, projects: dst.projects, bundles: dst.bundles, catalog: {...dst.catalog, publishLibraryBackup: async input => {const result = await originalPublish(input); if (once) {once = false; throw Error('synthetic-after-publish-crash');} return result;}}});
  const plan = await preview(dst, src), requestId = randomUUID(); await assert.rejects(start(dst, plan, requestId), /未完成/); assert.equal((await dst.catalog.read()).libraries.length, 3); await fs.rename(src.root, src.root + '-after-publish-retained');
  const inspected = await dst.service.inspect(plan.id, dst.p.id); assert.equal(inspected.status, 'completed'); assert.equal(inspected.result.libraryIds.length, 2); assert.equal((await start(dst, plan, requestId)).alreadyPublished, true); assert.equal((await dst.catalog.read()).libraries.length, 3);
});

test('画布包安装后回写失败可按固定包与原ID恢复；动态summary从真实包重建', async () => {
  const src = await sourceFixture({media: false}), dst = await targetFixture(), originalRestore = dst.bundles.restoreLibraryPackage; let once = true;
  dst.service = nativeLibraryImportService({data: dst.data, projects: dst.projects, catalog: dst.catalog, bundles: {...dst.bundles, restoreLibraryPackage: async (...args) => {const result = await originalRestore(...args); if (once) {once = false; throw Error('synthetic-after-bundle-install-crash');} return result;}}});
  const checked = await preview(dst, src), requestId = randomUUID(); await assert.rejects(start(dst, checked, requestId), /未完成/); assert.equal((await dst.catalog.read()).libraries.length, 1);
  const recordFile = path.join(dst.data, 'native-library-import', 'previews', checked.id, 'record.json'), record = JSON.parse(await fs.readFile(recordFile)), fragment = record.prepared.find(p => p.kind === 'canvas-fragment'); record.mapping.bundleSummaries[fragment.id] = {name: '伪造', nodes: 999, unsafeExtra: true}; await fs.writeFile(recordFile, JSON.stringify(record));
  const done = await start(dst, checked, requestId), item = (await dst.catalog.read()).libraries.filter(l => done.libraryIds.includes(l.id)).flatMap(l => l.folders.flatMap(f => f.items)).find(i => i.kind === 'canvas-fragment'); assert.equal(item.summary.nodes, 1); assert.equal(item.summary.unsafeExtra, undefined); assert.equal(item.name, '原版片段'); assert.equal(dst.map.size, 1);
});

test('发布入口收到signal且停止时不追加目录；原计划仍可继续', async () => {
  const src = await sourceFixture({workflows: false}), dst = await targetFixture(), controller = new AbortController(), original = dst.catalog.publishLibraryBackup; let stop = true;
  dst.service = nativeLibraryImportService({data: dst.data, projects: dst.projects, bundles: dst.bundles, catalog: {...dst.catalog, publishLibraryBackup: async input => {assert.equal(input.signal, controller.signal); if (stop) {stop = false; controller.abort();} return original(input);}}});
  const checked = await preview(dst, src), requestId = randomUUID(); await assert.rejects(start(dst, checked, requestId, {signal: controller.signal}), e => e.name === 'AbortError'); assert.equal((await dst.catalog.read()).libraries.length, 1);
  // The retry remains the same durable plan; a fresh, non-aborted signal is used.
  dst.service = nativeLibraryImportService({data: dst.data, projects: dst.projects, bundles: dst.bundles, catalog: dst.catalog}); assert.equal((await start(dst, checked, requestId)).status, 'completed'); assert.equal((await dst.catalog.read()).libraries.length, 3);
});

test('源中间目录换壳及预检期间根换壳，即使原文件inode保持也拒绝发布', async () => {
  const src = await sourceFixture({workflows: false}), dst = await targetFixture(), checked = await preview(dst, src), file = path.join(src.root, 'assets', 'library', '角色', '角色.png'), before = await fs.stat(file);
  await fs.rename(path.join(src.root, 'assets'), path.join(src.root, 'assets-before'));
  await fs.mkdir(path.join(src.root, 'assets'));
  await fs.rename(path.join(src.root, 'assets-before', 'library'), path.join(src.root, 'assets', 'library'));
  assert.equal((await fs.stat(file)).ino, before.ino);
  await assert.rejects(start(dst, checked), /目录链已被替换/);
  assert.equal((await dst.catalog.read()).libraries.length, 1);
  const other = await sourceFixture({workflows: false}), target = await targetFixture(), original = target.catalog.read; let replaced = false;
  target.service = nativeLibraryImportService({data: target.data, projects: target.projects, bundles: target.bundles, catalog: {...target.catalog, read: async () => {const value = await original(); if (!replaced) {replaced = true; const retained = other.root + '-retained'; await fs.rename(other.root, retained); await fs.mkdir(other.root); await fs.rename(path.join(retained, 'data'), path.join(other.root, 'data')); await fs.rename(path.join(retained, 'assets'), path.join(other.root, 'assets'));} return value;}}});
  await assert.rejects(preview(target, other), /源目录已被替换|根目录已被替换/);
  assert.equal((await original()).libraries.length, 1);
});

test('白名单原元数据与完整分类保留在源映射及素材记录；独立缩略图明确阻止完整迁入', async () => {
  const src = await sourceFixture(), dst = await targetFixture(), image = src.index.libraries[0].categories[0].items[0];
  Object.assign(image, {width: 32, height: 32, natural_w: 32, natural_h: 32, format: 'png', thumbnail: image.url});
  for (let i = 0; i < 41; i++) image.classification.categories['original_' + i] = ['原分类' + i];
  const workflow = src.index.libraries[0].categories[2].items[0]; Object.assign(workflow, {node_count: 2, connection_count: 1, resource_count: 0}); await src.save();
  const checked = await preview(dst, src), sourceMetadata = {...image}; delete sourceMetadata.registrations;
  assert.deepEqual(checked.mapping.items.find(i => i.itemId === image.id).metadata, sourceMetadata);
  assert.equal(checked.mapping.items.find(i => i.itemId === workflow.id).metadata.node_count, 2);
  const result = await start(dst, checked), migrated = result.mapping.items.find(i => i.itemId === image.id), asset = await loadAsset(dst.data, migrated.fileId);
  assert.deepEqual(asset.nativeLibrarySource.metadata, sourceMetadata);
  const outside = await sourceFixture({workflows: false}), blank = await targetFixture(); outside.index.libraries[0].categories[0].items[0].thumbnail = 'https://external.invalid/thumb.png'; await outside.save(); const blocked = await preview(blank, outside);
  assert.equal(blocked.status, 'blocked'); assert.ok(blocked.unsupported.some(i => /独立缩略图/.test(i.reason)));
});

test('源最终复验读取期间替换中间目录，保持原文件完整指纹也不得发布', async () => {
  const src = await sourceFixture({workflows: false}), dst = await targetFixture(), checked = await preview(dst, src), plan = JSON.parse(await fs.readFile(path.join(dst.data, 'native-library-import', 'previews', checked.id, 'record.json'), 'utf8'));
  const file = path.join(src.root, 'assets', 'library', '角色', '角色.png'), before = await fs.stat(file), controller = new AbortController(); let calls = 0, replaced = false;
  controller.signal.throwIfAborted = () => {if (++calls === Object.keys(plan.sourceDirectories).length + 4) {replaced = true; renameSync(path.join(src.root, 'assets'), path.join(src.root, 'assets-retained')); mkdirSync(path.join(src.root, 'assets')); renameSync(path.join(src.root, 'assets-retained', 'library'), path.join(src.root, 'assets', 'library'));}};
  await assert.rejects(start(dst, checked, randomUUID(), {signal: controller.signal}), /目录链已被替换/);
  assert.equal(replaced, true); const after = await fs.stat(file); for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(after[key], before[key]);
  assert.equal((await dst.catalog.read()).libraries.length, 1);
});
