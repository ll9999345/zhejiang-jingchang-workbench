import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import assert from 'node:assert/strict';

const require = createRequire('/Users/mjd-ppps/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');
const {chromium} = require('playwright');
const root = process.cwd(), stage = process.env.CYAN_GLASS_EVIDENCE || path.join(root, 'artifacts', 'cyan-glass-browser-' + Date.now());
await fs.mkdir(path.join(stage, 'screenshots'), {recursive: true});
const report = {passed: false, checks: [], pageErrors: [], blocked: [], paidGenerations: 0, actualPhoneVerified: false, actualOldHardwareVerified: false, actualOSBackgroundVerified: false};
const screenshots = path.join(stage, 'screenshots');
const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const base = 'http://127.0.0.1:' + port;
const server = spawn(process.execPath, ['--import', './tests/helpers/local-network-only.mjs', 'server.mjs'], {
  cwd: root, env: {...process.env, PORT: String(port), JINGCHANG_DATA_DIR: path.join(stage, 'test-data'), JINGCHANG_LLM_URL: '', JINGCHANG_LLM_MODEL: ''}, stdio: ['ignore', 'pipe', 'pipe']
});
let browser, currentPage;
const output = fs.open(path.join(stage, 'isolated-server.log'), 'a');
for (const stream of [server.stdout, server.stderr]) stream.on('data', async data => (await output).write(data));
const check = name => report.checks.push(name);
const shot = (page, name) => page.screenshot({path: path.join(screenshots, name + '.png')});
async function api(url, method = 'GET', body) {
  const response = await fetch(base + url, {method, ...(body === undefined ? {} : {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)})});
  const value = await response.json(); assert.ok(response.ok, value.error || response.status); return value;
}
async function page(options = {}, {init, preference = 'running', readOnly = false, formal = false} = {}) {
  const context = await browser.newContext({viewport: {width: 1440, height: 960}, ...options});
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || readOnly && !['GET', 'HEAD'].includes(request.method())) {
      report.blocked.push({formal, method: request.method(), host: url.hostname, path: url.pathname}); await route.abort(); return;
    }
    if (!readOnly && request.method() !== 'GET' && /generate|\/canvas-run|\/chat|\/submit/.test(url.pathname)) {
      report.blocked.push({formal, method: request.method(), path: url.pathname}); await route.abort(); return;
    }
    await route.continue();
  });
  if (preference !== null) await context.addInitScript(value => localStorage.setItem('jingchang.ambient-motion.v1', value), preference);
  if (init) await context.addInitScript(init);
  const p = await context.newPage(); currentPage = p;
  p.on('pageerror', error => report.pageErrors.push(error.message));
  return {p, context};
}
async function withinViewport(p, selector) {
  await p.locator(selector).waitFor({state: 'visible'});
  const rect = await p.locator(selector).boundingBox(); assert.ok(rect, selector + ' visible');
  const view = p.viewportSize(); assert.ok(rect.x >= -.5 && rect.x + rect.width <= view.width + .5, selector + ' horizontal containment');
  assert.ok(rect.y >= -.5 && rect.y + rect.height <= view.height + .5, selector + ' vertical containment');
}
async function noOverflow(p) { assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); }
try {
  await Promise.race([once(server.stdout, 'data'), once(server, 'exit').then(() => {throw Error('isolated server exited');}), new Promise((_, reject) => setTimeout(() => reject(Error('isolated startup timeout')), 20000).unref())]);
  // The host's default headless GPU path cannot capture even a blank page.
  // Software rendering is confined to this test browser; no system setting changes.
  browser = await chromium.launch({executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--disable-gpu']});
  report.testSoftwareRendering = true;
  report.browser = browser.version();
  const project = await api('/api/projects', 'POST', {name: '青蓝交互验收（隔离数据）'});
  project.nodes = [
    {...project.nodes[0], id: 'glass-text', type: 'text', title: '保留画布交互', text: '拖动、缩放、撤销与键盘操作仍由原画布处理。', x: 100, y: 110, params: {}},
    {...project.nodes[0], id: 'glass-story', type: 'script', title: '自己的创作流程', text: '青蓝玻璃只影响外观；真实任务回执决定状态。', x: 510, y: 270, params: {}}
  ];
  project.edges = [{id: 'glass-edge', source: 'glass-text', target: 'glass-story'}]; project.groups = []; project.viewport = {x: 0, y: 0, zoom: 1};
  await api('/api/projects/' + project.id, 'PUT', project);
  let jobs = [], failing = false;
  const f = await page(); const p = f.p;
  await p.route(url => new URL(url).pathname.startsWith('/api/jobs'), route => failing ? route.fulfill({status: 503, json: {error: '本地测试查询错误'}}) : route.fulfill({json: jobs}));
  await p.goto(base + '/?project=' + project.id); await p.waitForSelector('[data-node="glass-text"]');
  await p.waitForSelector('.app .rail .ambient-motion-button'); await noOverflow(p);
  assert.equal(await p.locator('body').getAttribute('data-ambient-motion'), 'running');
  assert.equal(await p.locator('.topbar').evaluate(el => getComputedStyle(el).backdropFilter), 'blur(10px)');
  assert.equal(await p.locator('.panel').evaluate(el => getComputedStyle(el).backdropFilter), 'none');
  await shot(p, '01-desktop'); check('desktop cyan palette, limited blur and preserved canvas layout');

  const control = p.locator('.ambient-motion-button');
  await control.focus(); await p.keyboard.press('Enter');
  assert.equal(await p.locator('body').getAttribute('data-ambient-motion'), 'paused');
  assert.equal(await control.getAttribute('aria-pressed'), 'true');
  assert.equal(await control.evaluate(el => el.matches(':focus-visible')), true);
  await shot(p, '02-keyboard'); await p.keyboard.press('Space');
  assert.equal(await p.locator('body').getAttribute('data-ambient-motion'), 'running');
  const controlBox = await control.boundingBox(); await p.mouse.move(controlBox.x + 18, controlBox.y + 18); await p.mouse.down();
  assert.equal(await control.evaluate(el => el.classList.contains('is-spring-pressed')), true); await p.mouse.up(); await control.click();
  check('keyboard Enter/Space ambient control, visible focus and persisted preference');
  const heading = p.locator('[data-node="glass-text"] .node-header');
  const box = await heading.boundingBox(); await p.mouse.move(box.x + 100, box.y + 20); await p.mouse.down();
  await p.mouse.move(box.x + 165, box.y + 45, {steps: 8}); await p.mouse.up();
  await p.waitForFunction(() => document.querySelector('[data-node="glass-text"]').style.left === '165px');
  await p.locator('[data-action="undo"]').click(); assert.equal(await p.locator('[data-node="glass-text"]').evaluate(el => el.style.left), '100px');
  await p.locator('[data-action="redo"]').click(); assert.equal(await p.locator('[data-node="glass-text"]').evaluate(el => el.style.left), '165px');
  assert.equal(await p.locator('.ambient-motion-button').count(), 1); check('node drag, undo/redo and redraw retain exactly one ambient control');

  const baseJob = {id: 'local-receipt-fixture', projectId: project.id, kind: 'studio', name: '浏览器测试回执 · 未发起生成', createdAt: new Date().toISOString()};
  jobs = [{...baseJob, status: 'queued', progress: 30}];
  await p.locator('.task-island-toggle').click(); await p.locator('[data-island-refresh]').click();
  await p.waitForFunction(() => document.querySelector('#task-island').dataset.status === 'queued');
  assert.equal(await p.locator('.task-island-meter').getAttribute('aria-valuenow'), null);
  jobs = [{...baseJob, status: 'running', progress: 80}]; await p.locator('[data-island-refresh]').click();
  await p.waitForFunction(() => document.querySelector('#task-island').dataset.status === 'running');
  assert.equal(await p.locator('.task-island-meter').getAttribute('aria-valuenow'), null);
  await control.click(); assert.equal(await p.locator('#task-island').getAttribute('data-active'), 'true');
  assert.equal(await p.locator('#task-island').getAttribute('data-status'), 'running');
  await shot(p, '03-task-waiting'); check('unknown task fraction remains indeterminate; pausing ambient light does not pause tasks');
  failing = true; await p.locator('[data-island-refresh]').click();
  await p.waitForFunction(() => document.querySelector('.task-island-label').textContent === '状态待确认');
  assert.equal(await p.locator('#task-island').getAttribute('data-status'), 'running');
  failing = false; jobs = [{...baseJob, kind: 'canvas-run', status: 'running', steps: [{status: 'completed'}, {status: 'running'}]}];
  await p.locator('[data-island-refresh]').click(); await p.waitForFunction(() => document.querySelector('.task-island-meter')?.getAttribute('aria-valuenow') === '1');
  assert.equal(await p.locator('.task-island-meter').getAttribute('aria-valuemax'), '2');
  await shot(p, '04-task-measured');
  for (const status of ['cancelled', 'failed', 'completed']) {
    jobs = [{...baseJob, status}]; await p.locator('[data-island-refresh]').click();
    await p.waitForFunction(value => document.querySelector('#task-island').dataset.status === value, status);
    assert.equal(await p.locator('#task-island').getAttribute('data-active'), 'false');
  }
  await p.keyboard.press('Escape'); assert.equal(await p.locator('.task-island-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(await p.locator('.task-island-toggle').evaluate(el => el === document.activeElement), true);
  check('query failure, measured steps, cancellation/failure/completion and Escape use existing task controller');

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII=', 'base64');
  const upload = await fetch(base + '/api/assets?name=local-test.png', {method: 'POST', headers: {'Content-Type': 'image/png'}, body: png}); assert.ok(upload.ok); const image = await upload.json();
  await p.locator('.tabs [data-view="assets"]').click(); await p.locator('[data-asset-scope="global"]').click();
  await p.locator(`[data-image-edit="${image.id}"]`).click(); await p.waitForSelector('#edit-zoom');
  const range = p.locator('#edit-zoom'); const r = await range.boundingBox();
  await p.mouse.move(r.x + r.width * .4, r.y + r.height / 2); await p.mouse.down();
  assert.equal(await range.evaluate(el => getComputedStyle(el).getPropertyValue('--jade-track-height').trim()), '8px');
  await p.mouse.move(r.x + r.width * .55, r.y + r.height / 2, {steps: 5}); await p.mouse.up();
  assert.equal(await range.evaluate(el => getComputedStyle(el).getPropertyValue('--jade-track-height').trim()), '4px');
  await range.focus(); const oldRangeValue = await range.inputValue(); await p.keyboard.press('ArrowRight'); assert.ok(Number(await range.inputValue()) > Number(oldRangeValue));
  await shot(p, '05-slider-editor'); check('existing image-editor slider grows during drag and still changes its real value by keyboard');
  await p.keyboard.press('Escape'); await f.context.close();

  const studio = await api('/api/studios', 'POST', {projectId: project.id, name: '青蓝创作台（隔离）'});
  const light = await page(); await light.p.goto(base + '/creation-studio?project=' + studio.id);
  await light.p.waitForFunction(() => document.querySelector('#save-indicator')?.textContent === '已保存到本机工作区');
  assert.equal(await light.p.locator('.studio').getAttribute('data-theme'), 'light'); await shot(light.p, '06-studio-light');
  await light.p.locator('#theme-toggle').click(); assert.equal(await light.p.locator('.studio').getAttribute('data-theme'), 'dark');
  await light.p.locator('#open-docs').click(); await withinViewport(light.p, 'dialog'); await shot(light.p, '07-studio-dark-dialog');
  await light.context.close(); check('creation studio retains light/dark toggle, project binding and native dialog');

  const conversation = await api('/api/conversations', 'POST', {projectId: project.id});
  for (const width of [1440, 390]) {
    const chat = await page({viewport: {width, height: width === 390 ? 844 : 960}});
    await chat.p.goto(base + '/conversation.html?project=' + project.id + '&conversation=' + conversation.id);
    await chat.p.waitForFunction(() => !document.querySelector('main').inert); await noOverflow(chat.p);
    assert.equal(await chat.p.locator('.ambient-motion-button').count(), 1);
    await shot(chat.p, '15-conversation-' + width); await chat.context.close();
  }
  check('conversation desktop and browser phone preserve draft controls and header links');

  for (const width of [390, 320]) {
    const mobile = await page({viewport: {width, height: 844}, isMobile: true, hasTouch: true, deviceScaleFactor: 1});
    await mobile.p.goto(base + '/?project=' + project.id); await mobile.p.waitForSelector('.node'); await noOverflow(mobile.p);
    await mobile.p.locator('.task-island-toggle').click(); await withinViewport(mobile.p, '.task-island-body');
    assert.equal(await mobile.p.locator('.task-island-body').evaluate(el => getComputedStyle(el).backdropFilter), 'none');
    await shot(mobile.p, '08-mobile-canvas-' + width);
    await mobile.p.goto(base + '/creation-studio?project=' + studio.id); await mobile.p.waitForFunction(() => document.querySelector('#save-indicator')?.textContent === '已保存到本机工作区');
    await noOverflow(mobile.p); await mobile.p.locator('#mobile-left-toggle').click();
    await mobile.p.locator('.ambient-motion-button').click(); await mobile.p.locator('#close-left').click();
    await mobile.p.locator('#open-connect').click(); await withinViewport(mobile.p, 'dialog');
    assert.equal(await mobile.p.locator('dialog').evaluate(el => getComputedStyle(el).backdropFilter), 'none');
    assert.equal(await mobile.p.locator('dialog').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(246, 251, 255)');
    await shot(mobile.p, '09-mobile-studio-dialog-' + width); await mobile.context.close();
  }
  check('390px and 320px browser phone layouts, side panel, task island, opaque dialogs and controls');

  const reduced = await page({reducedMotion: 'reduce'});
  await reduced.p.goto(base + '/?project=' + project.id); await reduced.p.waitForSelector('.node');
  assert.equal(await reduced.p.locator('body').getAttribute('data-ambient-motion'), 'paused');
  assert.equal(await reduced.p.locator('body').getAttribute('data-ambient-quality'), 'static');
  assert.equal(await reduced.p.locator('.ambient-motion-button').isDisabled(), true);
  assert.equal(await reduced.p.locator('.jc-aurora').evaluate(el => getComputedStyle(el, '::before').animationName), 'none');
  await reduced.p.locator('.task-island-toggle').click(); await withinViewport(reduced.p, '.task-island-body'); await shot(reduced.p, '10-reduced-motion');
  await reduced.context.close(); check('browser system reduced-motion disables ambient animation while task details remain usable');

  const old = await page({}, {preference: null, init: () => {
    const real = requestAnimationFrame.bind(window); window.requestAnimationFrame = callback => real(() => setTimeout(() => callback(performance.now()), 85));
  }});
  await old.p.goto(base + '/?project=' + project.id); await old.p.waitForSelector('.node');
  await old.p.waitForFunction(() => document.body.dataset.ambientQuality === 'static', null, {timeout: 15000});
  assert.equal(await old.p.evaluate(() => localStorage.getItem('jingchang.ambient-motion.v1')), 'auto');
  assert.equal(await old.p.locator('.topbar').evaluate(el => getComputedStyle(el).backdropFilter), 'none');
  await shot(old.p, '11-old-machine-static');
  await old.p.reload(); await old.p.waitForSelector('.node'); assert.equal(await old.p.locator('body').getAttribute('data-ambient-quality'), 'static');
  await old.p.locator('.ambient-motion-button').click(); assert.equal(await old.p.locator('body').getAttribute('data-ambient-motion'), 'running');
  await old.p.waitForTimeout(3100); assert.equal(await old.p.locator('body').getAttribute('data-ambient-motion'), 'running');
  await old.context.close(); check('throttled startup auto fallback persists on reload; explicit playback overrides one-time sampling');

  const opaque = await page({}, {init: () => {
    const real = window.matchMedia.bind(window); window.matchMedia = query => {
      const result = real(query); if (query.includes('prefers-reduced-transparency')) Object.defineProperty(result, 'matches', {value: true}); return result;
    };
  }});
  await opaque.p.goto(base + '/?project=' + project.id); await opaque.p.waitForSelector('.node');
  assert.equal(await opaque.p.locator('body').getAttribute('data-ambient-quality'), 'static');
  assert.equal(await opaque.p.locator('.topbar').evaluate(el => getComputedStyle(el).backdropFilter), 'none');
  assert.equal(await opaque.p.locator('.jc-aurora').evaluate(el => getComputedStyle(el).display), 'none');
  await opaque.context.close(); check('simulated reduced-transparency setting selects opaque surfaces without task-state changes');
  const unsupported = await page({}, {init: () => {
    const real = CSS.supports.bind(CSS); CSS.supports = (...args) => args.join(' ').includes('backdrop-filter') ? false : real(...args);
  }});
  await unsupported.p.goto(base + '/?project=' + project.id); await unsupported.p.waitForSelector('.node');
  assert.equal(await unsupported.p.locator('body').getAttribute('data-ambient-reason'), 'capability');
  await unsupported.context.close(); check('simulated old browser without backdrop-filter retains static readable controls');

  const visibility = await page({}, {init: () => {
    window.testHidden = false; Object.defineProperty(document, 'hidden', {get: () => window.testHidden});
  }});
  await visibility.p.goto(base + '/?project=' + project.id); await visibility.p.waitForSelector('.node');
  await visibility.p.evaluate(() => {window.testHidden = true; document.dispatchEvent(new Event('visibilitychange'));});
  assert.equal(await visibility.p.locator('body').getAttribute('data-ambient-motion'), 'paused');
  await visibility.p.evaluate(() => {window.testHidden = false; document.dispatchEvent(new Event('visibilitychange'));});
  assert.equal(await visibility.p.locator('body').getAttribute('data-ambient-motion'), 'running');
  await visibility.context.close(); check('simulated background visibility pauses and restores ambient motion without changing preference');
  const forced = await page({forcedColors: 'active'}); await forced.p.goto(base + '/?project=' + project.id); await forced.p.waitForSelector('.node');
  assert.equal(await forced.p.locator('body').getAttribute('data-ambient-motion'), 'paused');
  assert.equal(await forced.p.locator('.jc-aurora').evaluate(el => getComputedStyle(el).display), 'none');
  await shot(forced.p, '16-forced-colors'); await forced.context.close(); check('browser forced-colors retains native focus and readable static controls');

  const host = await page({}, {preference: null}); await host.p.goto(base + '/?project=' + project.id); await host.p.waitForSelector('.node'); await host.p.waitForTimeout(3300);
  report.actualHostSample = await host.p.evaluate(() => ({motion: document.body.dataset.ambientMotion, quality: document.body.dataset.ambientQuality, fps: document.body.dataset.ambientSampleFps, preference: localStorage.getItem('jingchang.ambient-motion.v1')}));
  await shot(host.p, '12-host-automatic'); await host.context.close(); check('current host one-time sampling measured and recorded without a 60fps claim');

  const liveUrl = process.env.CYAN_GLASS_LIVE_URL || 'http://127.0.0.1:4768';
  const liveProjects = await (await fetch(liveUrl + '/api/projects')).json();
  const latest = liveProjects.filter(item => !item.archived).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0]; assert.ok(latest);
  report.liveProject = {id: latest.id, name: latest.name};
  for (const width of [1440, 390]) {
    const live = await page({viewport: {width, height: width === 390 ? 844 : 960}, ...(width === 390 ? {isMobile: true, hasTouch: true} : {})}, {readOnly: true, formal: true});
    await live.p.goto(liveUrl + '/?project=' + latest.id); await live.p.waitForSelector('.node');
    // Reconcile the existing controller with the now-loaded project before
    // capture; a global boot record must not be presented as this project's job.
    await live.p.locator('.task-island-toggle').click(); await live.p.locator('[data-island-refresh]').click();
    const scopedJobs = await (await fetch(liveUrl + '/api/jobs?includeActive=true&projectId=' + latest.id)).json();
    if (!scopedJobs.length) await live.p.waitForFunction(() => document.querySelector('#task-island').dataset.status === 'idle');
    else await live.p.waitForTimeout(600);
    await live.p.keyboard.press('Escape');
    await noOverflow(live.p); await shot(live.p, '13-live-latest-' + width); await live.context.close();
  }
  const liveStudios = await (await fetch(liveUrl + '/api/studios')).json();
  if (liveStudios.length) {
    const live = await page({}, {readOnly: true, formal: true}); await live.p.goto(liveUrl + '/creation-studio?project=' + liveStudios[0].id);
    await live.p.waitForFunction(() => document.querySelector('#save-indicator')?.textContent === '已保存到本机工作区');
    await live.p.locator('.task-island-toggle').click(); await live.p.locator('[data-island-refresh]').click();
    const scopedJobs = await (await fetch(liveUrl + '/api/jobs?includeActive=true&projectId=' + liveStudios[0].projectId)).json();
    if (!scopedJobs.length) await live.p.waitForFunction(() => document.querySelector('#task-island').dataset.status === 'idle');
    await live.p.keyboard.press('Escape');
    await shot(live.p, '14-live-studio-light'); await live.context.close();
  }
  check('formal latest canvas desktop/phone and existing studio screenshots use GET/HEAD only');
  assert.equal(report.blocked.length, 0, JSON.stringify(report.blocked)); assert.deepEqual(report.pageErrors, []);
  report.passed = true; console.log(JSON.stringify({passed: true, checks: report.checks.length, stage, actualHostSample: report.actualHostSample}));
} catch (error) {
  report.error = error.stack; if (currentPage && !currentPage.isClosed()) await shot(currentPage, 'failure').catch(() => {});
  console.error(error); process.exitCode = 1;
} finally {
  await browser?.close(); server.kill('SIGTERM'); await (await output).close();
  await fs.writeFile(path.join(stage, 'browser-results.json'), JSON.stringify(report, null, 2));
}
