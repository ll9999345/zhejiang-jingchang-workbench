// Actual Footage UI, isolated local HTTP and synthetic API responses only.
// This verifies browser behavior; it neither configures nor calls ElevenLabs.
const {chromium} = require('/Users/mjd-ppps/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const UI = path.join(ROOT, 'backlot/ui');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'artifacts', `footage-elevenlabs-browser-${Date.now()}`));
fs.mkdirSync(OUT, {recursive: false});
const APPROVALS = ['bgm_confirm_paid', 'bgm_confirm_text', 'bgm_billing_limit_configured', 'bgm_budget_usd'];
const PROMPT = '温暖的江南器乐，古筝与柔和弦乐渐进，为旁白留出空间。最后一个镜头轻柔收束。';
const report = {evidence: 'actual_footage_ui_with_synthetic_local_routes_no_provider_execution', checks: [],
  pageErrors: [], consoleErrors: [], httpErrors: [], externalRequests: [], unexpectedRequests: [],
  apiRequests: [], layoutIssues: [], paidModelCalls: 0, providerCalls: 0, cancelledStaleResponses: 0};
const record = (name, data = {}) => report.checks.push({name, ...data});
const shots = [{id: 'scene-one', title: '江南清晨', text: '湖面迎来清晨。', query: '江南 湖面',
  source_path: 'fixture/scene.svg', duration_seconds: 8, selection_mode: 'manual', source_locked: true},
{id: 'scene-two', title: '古镇漫步', text: '街巷慢慢醒来。', query: '古镇 街巷',
  source_path: 'fixture/scene.svg', duration_seconds: 12, selection_mode: 'manual', source_locked: true}];
const fixtureContext = id => ({project_id: id, topic: `隔离音乐验收 ${id}`, script: '湖面迎来清晨。街巷慢慢醒来。',
  shots, assets: [{path: 'fixture/scene.svg', kind: 'image', label: '隔离示意图', origin: 'local'}], jobs: [], settings: {narration: 'none'}});
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#182848"/><path d="M0 280Q120 190 260 270T640 210V360H0Z" fill="#5750a7"/></svg>';
const mime = {'.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2'};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/favicon.ico') {res.writeHead(204); res.end(); return;}
  const relative = url.pathname === '/footage' ? 'footage.html' : url.pathname.startsWith('/ui/') ? decodeURIComponent(url.pathname.slice(4)) : null;
  const file = relative == null ? null : path.resolve(UI, relative);
  if (!file || !file.startsWith(UI + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end('Static fixture route not found'); return;
  }
  res.writeHead(200, {'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store'});
  fs.createReadStream(file).pipe(res);
});

function noApprovals(value) {for (const key of APPROVALS) assert.equal(Object.hasOwn(value, key), false, key);}
function deferred() {let release, started; return {wait: new Promise(r => {release = r;}), release: () => release(),
  start: new Promise(r => {started = r;}), started: value => started(value)};}

(async () => {
  let browser, currentPage, deferredNext = null, unavailable = false, nextJob = 1;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  report.localOrigin = base;
  try {
    browser = await chromium.launch({executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox']});
    const context = await browser.newContext({viewport: {width: 1440, height: 1000}, reducedMotion: 'reduce', colorScheme: 'light', acceptDownloads: true});
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (['data:', 'blob:'].includes(url.protocol)) return route.continue();
      if (url.origin !== base) {report.externalRequests.push({origin: url.origin, method: request.method()}); return route.abort();}
      if (url.pathname.startsWith('/ui/') || url.pathname === '/footage' || url.pathname === '/favicon.ico') return route.continue();
      const method = request.method();
      const body = request.postData() ? request.postDataJSON() : null;
      report.apiRequests.push({path: url.pathname, query: url.search, method, body});
      const fulfill = data => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(data)});
      const id = decodeURIComponent(url.pathname.split('/').at(-1));
      if (method === 'GET' && url.pathname.startsWith('/model-api/footage/assets/')) return route.fulfill({status: 200, contentType: 'image/svg+xml', body: svg});
      if (method === 'GET' && url.pathname.startsWith('/model-api/footage/context/')) return fulfill(fixtureContext(id));
      if (method === 'GET' && url.pathname === '/model-api/footage/capabilities') return fulfill({default_sources: ['pexels'], sources: [{name: 'pexels', display_name: '隔离素材替身', status: 'available'}], voices: [], upstream: {name: '本地验收替身'}});
      if (method === 'GET' && url.pathname === '/model-api/footage/jobs') return fulfill({jobs: []});
      if (method === 'GET' && url.pathname === '/model-api/footage/batches') return fulfill({batches: []});
      if (method === 'GET' && url.pathname === '/model-api/footage/extensions/catalog') return fulfill({operations: [{id: 'edit', label: '本地剪辑（验收未执行）', providers: [{id: 'fixture', label: '隔离替身', local: true, configured: true, missing: []}]}]});
      if (method === 'GET' && url.pathname === '/model-api/footage/extensions/jobs') return fulfill({jobs: []});
      if (method === 'GET' && url.pathname === '/api/projects') return fulfill([{project_id: 'music-desktop', title: '隔离桌面验收'}, {project_id: 'music-other', title: '隔离项目切换'}, {project_id: 'music-mobile', title: '隔离手机验收'}]);
      if (method === 'POST' && url.pathname === '/model-api/footage/plan') return fulfill({project_id: body.project_id, topic: body.topic, script: body.script, shots, summary: '隔离替身返回分镜，无素材搜索。'});
      if (method === 'POST' && url.pathname === '/model-api/footage/draft') return fulfill({project_id: body.project_id, shots: body.shots, saved: true});
      if (method === 'POST' && url.pathname.startsWith('/model-api/footage/settings/')) return fulfill({project_id: id, settings: body});
      if (method === 'POST' && url.pathname === '/model-api/footage/music/preflight') {
        const waiting = deferredNext; deferredNext = null;
        const result = {required: true, ready: !unavailable, errors: unavailable ? ['ELEVENLABS_API_KEY 未配置；请在本机服务配置后重新预检。'] : [], approvals: [],
          provider: {provider: 'elevenlabs', model: body.options.bgm_model_id}, model_id: body.options.bgm_model_id,
          duration_seconds: body.shots.reduce((sum, shot) => sum + shot.duration_seconds, 0), estimated_cost_usd: 0.04,
          prompt_preview: `${body.options.bgm_prompt}\n\n纯器乐，无人声。\n0–8 秒：湖面迎来清晨。\n8–20 秒：街巷慢慢醒来。`, paid_calls: 0};
        if (waiting) {waiting.started({body, result}); await waiting.wait;}
        try {return await fulfill(result);} catch (error) {
          if (waiting && /closed|disposed|cancel|Invalid Interception/i.test(error.message)) {report.cancelledStaleResponses++; return;}
          throw error;
        }
      }
      if (method === 'POST' && url.pathname === '/model-api/footage/jobs') return fulfill({job_id: `footage-${String(nextJob++).padStart(24, '0')}`, project_id: body.project_id,
        status: 'stage_completed', stage: 'isolated_browser_receipt', progress: 100, message: '仅浏览器隔离回执：没有实际生成、采集或 provider 调用。', request: body, shots: body.shots, outputs: []});
      report.unexpectedRequests.push({path: url.pathname, method});
      return route.abort();
    });
    function attach(page) {
      page.on('pageerror', error => report.pageErrors.push(error.message));
      page.on('console', message => {if (message.type() === 'error') report.consoleErrors.push(message.text());});
      page.on('response', response => {if (response.status() >= 400) report.httpErrors.push({url: response.url(), status: response.status()});});
    }
    const count = suffix => report.apiRequests.filter(r => r.path === `/model-api/footage/${suffix}` && r.method === 'POST').length;
    async function load(page, project) {
      await page.goto(`${base}/footage?project=${project}`, {waitUntil: 'domcontentloaded'});
      await page.waitForFunction(() => !document.querySelector('#createButton').disabled);
    }
    async function chooseMusic(page, prompt = PROMPT) {
      await page.locator('#bgmMode').selectOption('elevenlabs');
      await page.locator('#bgmModel').selectOption('music_v2_5');
      await page.locator('#bgmPrompt').fill(prompt);
    }
    async function preview(page) {
      const response = page.waitForResponse(r => r.url() === `${base}/model-api/footage/music/preflight` && r.request().method() === 'POST');
      await page.locator('#bgmPreflightButton').click();
      const result = await (await response).json();
      await page.waitForFunction(() => !document.querySelector('#bgmPreflightButton').disabled);
      return result;
    }
    async function approve(page) {
      for (const id of ['bgmConfirmText', 'bgmConfirmPaid', 'bgmBillingLimit']) await page.locator(`#${id}`).check();
      await page.locator('#bgmBudget').fill('0.25');
    }
    async function submit(page, action) {
      const response = page.waitForResponse(r => r.url() === `${base}/model-api/footage/jobs` && r.request().method() === 'POST');
      await page.locator(`#${action}Button`).click();
      const receipt = await (await response).json();
      await page.waitForFunction(() => !document.querySelector('#createButton').disabled);
      return receipt.request;
    }
    async function cleared(page) {
      assert.equal(await page.locator('#bgmPromptPreviewField').isVisible(), false);
      assert.equal(await page.locator('#bgmPromptPreview').textContent(), '');
      for (const id of ['bgmConfirmText', 'bgmConfirmPaid', 'bgmBillingLimit']) assert.equal(await page.locator(`#${id}`).isChecked(), false);
      assert.equal(await page.locator('#bgmBudget').inputValue(), '');
    }
    async function layout(page, name) {
      const result = await page.evaluate(() => {
        const elements = ['bgmPrompt', 'bgmModel', 'bgmPreflightButton', 'bgmBudget', 'bgmServiceStatus', 'bgmPromptPreview'].map(id => {
          const node = document.getElementById(id), rect = node.getBoundingClientRect(), style = getComputedStyle(node);
          return {id, left: rect.left, right: rect.right, width: rect.width, color: style.color, background: style.backgroundColor};
        });
        return {viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth,
          theme: document.documentElement.dataset.theme, bodyBackground: getComputedStyle(document.body).backgroundColor, elements,
          overflowElements: [...document.querySelectorAll('body *')].map(node => {
            const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
            return {tag: node.tagName, id: node.id, class: node.className?.baseVal ?? node.className,
              left: rect.left, right: rect.right, width: rect.width, position: style.position,
              display: style.display, visibility: style.visibility};
          }).filter(node => node.display !== 'none' && node.visibility !== 'hidden' && node.width > 0 && node.right > innerWidth + .1)};
      });
      assert.equal(result.theme, 'dark');
      for (const node of result.elements) assert.ok(node.left >= -1 && node.right <= result.viewport + 1, `${node.id} extends outside viewport`);
      await page.locator('#bgmPrompt').scrollIntoViewIfNeeded();
      await page.screenshot({path: path.join(OUT, `${name}-music-controls.png`)});
      await page.screenshot({path: path.join(OUT, `${name}-full-page.png`), fullPage: true});
      if (result.viewport === 390) {
        await page.locator('#bgmBudget').evaluate(node => node.scrollIntoView({block: 'center'}));
        await page.screenshot({path: path.join(OUT, `${name}-approval-controls.png`)});
      }
      record(`${name}: actual dark UI and viewport layout`, result);
      if (result.scrollWidth > result.viewport) {
        const issue = {kind: 'horizontal-overflow', viewport: result.viewport, scrollWidth: result.scrollWidth,
          overflowElements: result.overflowElements, screenshot: `${name}-music-controls.png`};
        report.layoutIssues.push(issue); report.rootCause = issue;
      }
      return result;
    }

    currentPage = await context.newPage(); attach(currentPage);
    const desktop = currentPage;
    await load(desktop, 'music-desktop');
    await chooseMusic(desktop);
    const full = await preview(desktop);
    assert.equal(full.provider.model, 'music_v2_5');
    assert.equal(await desktop.locator('#bgmPromptPreview').textContent(), full.prompt_preview);
    assert.ok((await desktop.locator('#bgmServiceStatus').textContent()).includes('$0.0400'));
    await desktop.locator('#bgmPromptPreviewField summary').click();
    record('desktop preflight shows exact model, complete transmitted text and reference cost', {model: full.provider.model, prompt_preview: full.prompt_preview, estimated_cost_usd: full.estimated_cost_usd, duration_seconds: full.duration_seconds});
    const jobsBefore = count('jobs');
    await desktop.locator('#renderButton').click();
    await desktop.waitForFunction(() => document.querySelector('#pageMessageText').textContent.includes('确认'));
    assert.equal(count('jobs'), jobsBefore);
    record('no three confirmations: render cannot POST a job');
    await approve(desktop);
    // Export while all approvals are present, so omission is tested independently of the post-job reset.
    await desktop.locator('#openSettingsButton').click();
    const downloadEvent = desktop.waitForEvent('download');
    await desktop.locator('#exportSettingsButton').click();
    const download = await downloadEvent;
    const exportedPath = path.join(OUT, 'desktop-exported-settings.json');
    await download.saveAs(exportedPath);
    const exported = JSON.parse(fs.readFileSync(exportedPath, 'utf8'));
    noApprovals(exported);
    assert.equal(exported.bgm_model_id, 'music_v2_5');
    assert.equal(exported.bgm_prompt, PROMPT);
    for (const request of report.apiRequests.filter(r => r.path.startsWith('/model-api/footage/settings/') && r.method === 'POST')) noApprovals(request.body);
    await desktop.locator('#settingsDialog [data-close-dialog]').first().click();
    record('config export and settings persistence omit all four temporary approval fields', {export_file: exportedPath, exported_model: exported.bgm_model_id});
    const desktopLayout = await layout(desktop, '01-desktop');
    assert.ok(desktopLayout.scrollWidth <= desktopLayout.viewport, JSON.stringify(desktopLayout));
    const paidRequest = await submit(desktop, 'render');
    assert.equal(paidRequest.project_id, 'music-desktop');
    assert.equal(paidRequest.options.bgm_mode, 'elevenlabs');
    assert.equal(paidRequest.options.bgm_model_id, 'music_v2_5');
    assert.equal(paidRequest.options.bgm_prompt, PROMPT);
    assert.equal(paidRequest.options.bgm_confirm_paid, true);
    assert.equal(paidRequest.options.bgm_confirm_text, true);
    assert.equal(paidRequest.options.bgm_billing_limit_configured, true);
    assert.equal(paidRequest.options.bgm_budget_usd, 0.25);
    await cleared(desktop);
    record('approved render carries exact model and temporary flags once, then clears consent', {request: paidRequest});

    // The source still says ElevenLabs, but collecting materials is a free stage.
    await preview(desktop); await approve(desktop);
    const preflightsBeforeCollect = count('music/preflight');
    const freeRequest = await submit(desktop, 'collect');
    assert.equal(freeRequest.action, 'collect'); assert.equal(freeRequest.stop_at, 'materials'); noApprovals(freeRequest.options);
    assert.equal(count('music/preflight'), preflightsBeforeCollect);
    record('free collect with ElevenLabs selected sends no approval fields or new music preflight', {request: freeRequest});

    for (const change of ['prompt', 'model']) {
      await chooseMusic(desktop, `${PROMPT} ${change} 前的文字。`);
      const waiting = deferred(); deferredNext = waiting;
      await desktop.locator('#bgmPreflightButton').click();
      const original = await waiting.start;
      if (change === 'prompt') await desktop.locator('#bgmPrompt').fill(`${PROMPT} 已更改的文字。`);
      else await desktop.locator('#bgmModel').selectOption('music_v1');
      waiting.release();
      await desktop.waitForFunction(() => !document.querySelector('#bgmPreflightButton').disabled);
      await cleared(desktop);
      const before = count('jobs'); await desktop.locator('#renderButton').click();
      await desktop.waitForFunction(() => document.querySelector('#pageMessageText').textContent.includes('重新预检'));
      assert.equal(count('jobs'), before);
      record(`delayed preflight after ${change} change cannot apply preview or submit`, {old_model: original.body.options.bgm_model_id});
    }
    await chooseMusic(desktop);
    const oldProject = deferred(); deferredNext = oldProject;
    await desktop.locator('#bgmPreflightButton').click(); await oldProject.start;
    await load(desktop, 'music-other'); oldProject.release();
    await desktop.waitForFunction(() => document.querySelector('#bgmMode').value === 'none');
    assert.ok((await desktop.locator('#projectBadge').textContent()).includes('music-other'));
    await cleared(desktop);
    await chooseMusic(desktop); await approve(desktop);
    const projectJobs = count('jobs'); await desktop.locator('#renderButton').click();
    await desktop.waitForFunction(() => document.querySelector('#pageMessageText').textContent.includes('重新预检'));
    assert.equal(count('jobs'), projectJobs);
    record('project navigation cancels old preflight and the new project requires its own review');

    unavailable = true;
    const unavailableResult = await preview(desktop);
    assert.equal(unavailableResult.ready, false);
    assert.ok((await desktop.locator('#bgmServiceStatus').textContent()).includes('ELEVENLABS_API_KEY 未配置'));
    const deniedJobs = count('jobs'); await approve(desktop); await desktop.locator('#renderButton').click();
    await desktop.waitForFunction(() => document.querySelector('#pageMessageText').textContent.includes('ELEVENLABS_API_KEY 未配置'));
    assert.equal(count('jobs'), deniedJobs);
    const missingKeyCount = count('music/preflight');
    const freeMissingKey = await submit(desktop, 'collect'); noApprovals(freeMissingKey.options);
    assert.equal(count('music/preflight'), missingKeyCount);
    record('missing-key preflight is clear and blocks paid render while free collect still works');
    unavailable = false;

    currentPage = await context.newPage(); attach(currentPage);
    const mobile = currentPage; await mobile.setViewportSize({width: 390, height: 844});
    await load(mobile, 'music-mobile'); await chooseMusic(mobile);
    const mobilePreview = await preview(mobile);
    await mobile.locator('#bgmPromptPreviewField summary').click();
    assert.equal(await mobile.locator('#bgmPromptPreview').textContent(), mobilePreview.prompt_preview);
    await approve(mobile); const mobileLayout = await layout(mobile, '02-mobile-390');
    const mobileRequest = await submit(mobile, 'render');
    assert.equal(mobileRequest.options.bgm_model_id, 'music_v2_5');
    assert.equal(mobileRequest.options.bgm_confirm_text, true); assert.equal(mobileRequest.options.bgm_budget_usd, 0.25);
    record('390px mobile selection and exact approved payload work', {request: mobileRequest});
    assert.ok(mobileLayout.scrollWidth <= mobileLayout.viewport, JSON.stringify(mobileLayout));
    assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []); assert.deepEqual(report.httpErrors, []);
    assert.deepEqual(report.externalRequests, []); assert.deepEqual(report.unexpectedRequests, []);
    record('no browser errors, external hosts or provider calls', {paidModelCalls: 0, providerCalls: 0});
    report.passed = true;
  } catch (error) {
    report.passed = false; report.failure = error.message;
    if (currentPage && !currentPage.isClosed()) await currentPage.screenshot({path: path.join(OUT, 'failed-screen.png'), fullPage: true}).catch(() => {});
    throw error;
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(path.join(OUT, 'receipt.json'), JSON.stringify(report, null, 2), {flag: 'wx'});
  }
  console.log(JSON.stringify({passed: report.passed, checks: report.checks.length, evidence: OUT, paidModelCalls: 0, externalRequests: report.externalRequests.length, pageErrors: report.pageErrors.length}));
})().catch(error => {console.error(error); process.exitCode = 1;});
