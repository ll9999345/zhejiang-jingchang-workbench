const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const repo = path.resolve(__dirname, '../..');
const openingDir = path.join(repo, 'backlot/ui/opening');
const provenanceDir = path.join(openingDir, 'provenance/20261009-web-gpt6');
const source = fs.readFileSync(path.join(openingDir, 'opening.js'), 'utf8');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');

// Deliberately isolated DOM/renderer fixtures. Real rendering is checked separately
// in the local browser; these tests cover focus, startup and resource lifetimes.
function fixture({ page = 'library', ready = true, reduced = false, seen = false, deniedStorage = false, search = '' } = {}) {
  const events = [];
  const rafs = new Map();
  const renderers = [];
  const storage = new Map(seen ? [['zhejiang:opening:field-notes:v1:seen', '1']] : []);
  let rafId = 0;
  let doc;
  function emitter(target = {}) {
    const handlers = new Map();
    target.addEventListener = (type, fn, opts = {}) => {
      const entries = handlers.get(type) || [];
      const entry = { fn, opts };
      entries.push(entry); handlers.set(type, entries);
      opts.signal?.addEventListener('abort', () => {
        handlers.set(type, (handlers.get(type) || []).filter(item => item !== entry));
      }, { once: true });
    };
    target.dispatchEvent = event => {
      for (const entry of [...(handlers.get(event.type) || [])]) {
        entry.fn(event);
        if (entry.opts.once) handlers.set(event.type, (handlers.get(event.type) || []).filter(item => item !== entry));
      }
      return true;
    };
    target.listenersFor = type => handlers.get(type) || [];
    return target;
  }
  class Element {
    constructor(tag) {
      emitter(this);
      this.tagName = tag.toUpperCase(); this.id = ''; this.dataset = {}; this.attrs = {};
      this.children = []; this.parentNode = null; this.nodes = new Map();
      const classes = new Set();
      this.classList = { add: (...values) => values.forEach(value => classes.add(value)), contains: value => classes.has(value) };
      this.style = { setProperty(name, value) { this[name] = value; } };
    }
    get isConnected() { return this === doc?.body || !!this.parentNode?.isConnected; }
    setAttribute(name, value) { this.attrs[name] = value; }
    append(child) { child.parentNode = this; this.children.push(child); }
    set innerHTML(value) {
      this.html = value;
      if (this.id !== 'zj-brand-opening') return;
      for (const selector of ['.zo-skip', '.zo-static-enter', '.zo-terrain', '.zo-progress-inner', '.zo-reelclock', '.zo-chapter-num', '.zo-chapter-name']) {
        const child = new Element(selector.includes('skip') || selector.includes('enter') ? 'button' : 'div');
        child.selector = selector; this.append(child); this.nodes.set(selector, child);
      }
    }
    querySelector(selector) { return this.nodes.get(selector) || null; }
    focus() { doc.activeElement = this; this.focusedAtPhase = this.parentNode?.dataset.phase; }
    remove() {
      if (doc.activeElement === this || this.children.includes(doc.activeElement)) doc.activeElement = doc.body;
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
      this.parentNode = null;
    }
  }
  doc = emitter({ readyState: ready ? 'interactive' : 'loading', hidden: false, currentScript: { src: 'http://127.0.0.1:4750/ui/opening/opening.js' }, baseURI: 'http://127.0.0.1:4750/' });
  doc.body = new Element('body'); doc.body.dataset.studioPage = page; doc.activeElement = doc.body;
  if (ready) doc.body.classList.add('studio-ready');
  const main = new Element('main'); main.id = 'studioMain'; doc.body.append(main);
  const top = new Element('div'); doc.body.append(top);
  const findId = id => doc.body.children.find(child => child.id === id) || top.children.find(child => child.id === id) || null;
  doc.createElement = tag => new Element(tag);
  doc.getElementById = findId;
  doc.querySelector = selector => selector === '.studio-top-actions' ? top : selector === '#studioMain' ? main : null;
  const baseDispatch = doc.dispatchEvent;
  doc.dispatchEvent = event => { events.push(event); return baseDispatch(event); };
  const win = emitter({
    matchMedia: () => ({ matches: reduced }),
    ZJTerrainRenderer: { create() { const renderer = { kind: 'canvas2d', draws: 0, disposals: 0, render() { this.draws++; }, dispose() { this.disposals++; } }; renderers.push(renderer); return renderer; } },
  });
  class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } }
  const ctx = vm.createContext({
    window: win, document: doc, URL, URLSearchParams, AbortController, CustomEvent,
    location: { search }, innerWidth: 1440, innerHeight: 900, performance: { now: () => 0 },
    sessionStorage: { getItem(key) { if (deniedStorage) throw Error('denied'); return storage.get(key); }, setItem(key, value) { if (deniedStorage) throw Error('denied'); storage.set(key, value); } },
    requestAnimationFrame(fn) { const id = ++rafId; rafs.set(id, fn); return id; },
    cancelAnimationFrame(id) { rafs.delete(id); },
  });
  vm.runInContext(source, ctx);
  return {
    win, doc, main, top, storage, events, renderers, rafs,
    root: () => findId('zj-brand-opening'),
    ready() { doc.body.classList.add('studio-ready'); doc.dispatchEvent({ type: 'studio:ready' }); },
    tick(now) { const callbacks = [...rafs.values()]; rafs.clear(); callbacks.forEach(fn => fn(now)); },
    key(key, shiftKey = false) { const event = { type: 'keydown', key, shiftKey, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } }; doc.dispatchEvent(event); return event; },
  };
}

test('retains original provenance and existing homepage bytes across visual adaptation', () => {
  const provenance = JSON.parse(fs.readFileSync(path.join(provenanceDir, 'extraction.json')));
  const original = fs.readFileSync(path.join(provenanceDir, 'Zhejiang_FieldNotes_Interactive_Preview.html'));
  assert.equal(hash(original), provenance.source_sha256);
  const styles = [...original.toString().matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)];
  const scripts = [...original.toString().matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
  const clean = value => value.replace(/^\n+/, '').trimEnd() + '\n';
  assert.equal(hash(clean(styles[1][1])), provenance.selected_blocks['opening.css'].extracted_sha256);
  assert.equal(hash(clean(scripts[0][1])), provenance.selected_blocks['terrain.js'].extracted_sha256);
  assert.doesNotMatch(source, /demoToast|demo-project|demo-view|newProjectButton|fetch\s*\(|XMLHttpRequest|sendBeacon\s*\(/);
  const before = fs.readFileSync(path.join(provenanceDir, 'index.before.html'), 'utf8');
  assert.equal(hash(Buffer.from(before)), provenance.index_before_sha256);
  const index = fs.readFileSync(path.join(repo, 'backlot/ui/index.html'), 'utf8');
  assert.equal(index.replace(/^.*\/ui\/opening\/(?:opening\.css|terrain\.js|opening\.js).*\n/gm, ''), before);
  assert.ok(index.indexOf('/ui/studio.js') < index.indexOf('/ui/opening/terrain.js'));
  assert.ok(index.indexOf('/ui/opening/terrain.js') < index.indexOf('/ui/opening/opening.js'));
});

test('liquid opening uses code-native glass studies and scoped workbench materials', () => {
  const css = fs.readFileSync(path.join(openingDir, 'opening.css'), 'utf8');
  const terrain = fs.readFileSync(path.join(openingDir, 'terrain.js'), 'utf8');
  assert.doesNotMatch(source, /data:image|<img|zo-grain|asset\s*\(/);
  assert.doesNotMatch(css, /Songti|STSong|Noto Serif|feTurbulence|hue-rotate|sepia\s*\(/);
  assert.doesNotMatch(terrain, /float hash|float noise|float hill|drawPath|waveMask/);
  assert.match(css, /font-family:var\(--sans/);
  assert.match(css, /border-top-color:rgba\(229,219,255,\.31\)/);
  assert.match(css, /border-left-color:rgba\(178,197,255,\.19\)/);
  assert.match(css, /background:rgba\(38,39,70,\.30\);backdrop-filter:blur\(10px\)/);
  const f = fixture();
  assert.match(f.root().html, /zo-glass-study-main/);
  assert.match(f.root().html, /让山海/);
  assert.match(f.root().html, /到作品/);
  assert.equal(f.win.ZhejiangOpening.version, '1.1.0-liquid');
});

test('standalone HTML embeds the current opening verbatim and has no external loading paths', () => {
  const html = fs.readFileSync(path.join(repo, 'output/web-opening-liquid-20261009/liquid-opening.html'), 'utf8');
  const styles = [...html.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style>/g)];
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.equal(styles.length, 2); assert.equal(scripts.length, 3);
  const embeddedCss = styles.find(match => match[1].includes('opening.css'))[2].trim();
  assert.equal(embeddedCss, fs.readFileSync(path.join(openingDir, 'opening.css'), 'utf8').trim());
  for (const filename of ['terrain.js', 'opening.js']) {
    const embedded = scripts.find(match => match[1].includes(filename))[2].trim();
    assert.equal(embedded, fs.readFileSync(path.join(openingDir, filename), 'utf8').trim());
  }
  scripts.forEach(match => assert.doesNotThrow(() => new vm.Script(match[2])));
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(html, /<(?:script|img|iframe|video|audio|source|link)\b[^>]*(?:src|href)\s*=/i);
  assert.doesNotMatch(html, /@import|url\s*\(|\b(?:fetch|XMLHttpRequest|WebSocket|sendBeacon)\s*\(|location\.(?:assign|replace)\s*\(/);
  assert.doesNotMatch(html, /demo-project|demoCards|demoCanvasArea|demoSearch|demoStatus/);
  assert.match(html, /独立预览 · 非实际产品录屏/);
  assert.match(html, /data-studio-page="library"/);
  assert.match(html, /id="studioMain" tabindex="-1"/);
  for (const alias of ['demoReplayMain', 'demoModes', 'demoCloseModes']) assert.match(html, new RegExp('id="' + alias + '"'));
});

test('actual 2D renderer code draws a bounded smooth field and releases its canvas', () => {
  const terrain = fs.readFileSync(path.join(openingDir, 'terrain.js'), 'utf8');
  const calls = [];
  const drawing = Object.fromEntries(['setTransform', 'fillRect', 'save', 'translate', 'scale', 'restore', 'beginPath', 'ellipse', 'stroke'].map(name => [name, (...args) => calls.push([name, ...args])]));
  drawing.createRadialGradient = (...args) => { calls.push(['gradient', ...args]); return { addColorStop(...values) { calls.push(['stop', ...values]); } }; };
  const canvas = { width: 0, height: 0, getContext(kind) { assert.equal(kind, '2d'); return drawing; } };
  const win = { innerWidth: 390, innerHeight: 844, devicePixelRatio: 3 };
  const ctx = vm.createContext({ window: win, Math, Float32Array });
  vm.runInContext(terrain, ctx);
  const renderer = win.ZJTerrainRenderer.create(canvas, { renderer: '2d' });
  renderer.render({ time: 1.2, progress: .4, pointer: { x: .8, y: .2 } });
  assert.equal(renderer.kind, 'canvas2d');
  assert.ok(canvas.width <= 390 && canvas.height <= 844);
  assert.equal(calls.filter(call => call[0] === 'gradient').length, 4);
  assert.equal(calls.filter(call => call[0] === 'ellipse').length, 1);
  assert.ok(calls.flatMap(call => call.slice(1)).filter(value => typeof value === 'number').every(Number.isFinite));
  renderer.dispose(); renderer.dispose();
  assert.equal(canvas.width, 1); assert.equal(canvas.height, 1); assert.equal(renderer.ctx, null);
  const count = calls.length; renderer.render(); assert.equal(calls.length, count);
});

test('starts once after actual studio readiness and keeps replay available', () => {
  const f = fixture({ ready: false });
  assert.equal(f.root(), null); assert.equal(f.top.children.length, 0);
  f.ready(); assert.ok(f.root()); assert.equal(f.top.children.length, 1);
  const root = f.root(); f.ready(); assert.equal(f.root(), root); assert.equal(f.top.children.length, 1);
});

test('autoplay gates honor session, reduced motion, explicit off and non-library pages', () => {
  for (const settings of [{ seen: true }, { reduced: true }, { search: '?opening=off' }, { page: 'canvas' }]) {
    const f = fixture(settings); assert.equal(f.root(), null); assert.equal(f.rafs.size, 0);
    assert.equal(f.top.children.length, settings.page === 'canvas' ? 0 : 1);
  }
  const always = fixture({ seen: true, search: '?opening=always' }); assert.ok(always.root());
  const denied = fixture({ deniedStorage: true }); assert.ok(denied.root()); assert.doesNotThrow(() => denied.win.ZhejiangOpening.skip());
});

test('Tab and Shift+Tab keep focus on the visible modal action; Escape cleans up', () => {
  const f = fixture(); const root = f.root(); const skip = root.querySelector('.zo-skip');
  assert.equal(f.doc.activeElement, skip);
  for (const shift of [false, true]) {
    f.main.focus(); const event = f.key('Tab', shift);
    assert.equal(event.prevented, true); assert.equal(event.stopped, true); assert.equal(f.doc.activeElement, skip);
  }
  assert.equal(f.doc.listenersFor('keydown')[0].opts.capture, true);
  f.key('Escape'); assert.equal(f.root(), null); assert.equal(f.doc.activeElement, f.main);
  assert.equal(f.rafs.size, 0); assert.equal(f.renderers[0].disposals, 1); assert.equal(f.doc.listenersFor('keydown').length, 0);
});

test('manual replay in reduced motion focuses the visible enter button after static mode is applied', () => {
  const f = fixture({ reduced: true });
  const replay = f.top.children[0]; replay.focus(); replay.dispatchEvent({ type: 'click' });
  const root = f.root(); const enter = root.querySelector('.zo-static-enter');
  assert.equal(root.dataset.phase, 'static'); assert.equal(f.doc.activeElement, enter); assert.equal(enter.focusedAtPhase, 'static');
  assert.equal(f.rafs.size, 0); assert.equal(f.renderers.length, 0);
  f.key('Tab', true); assert.equal(f.doc.activeElement, enter);
  enter.dispatchEvent({ type: 'click' }); assert.equal(f.root(), null); assert.equal(f.doc.activeElement, replay);
});

test('visible skip click immediately returns to the library without lingering animation', () => {
  const f = fixture();
  f.root().querySelector('.zo-skip').dispatchEvent({ type: 'click' });
  assert.equal(f.root(), null); assert.equal(f.rafs.size, 0); assert.equal(f.doc.activeElement, f.main);
  assert.equal(f.renderers[0].disposals, 1);
  assert.equal(f.events.find(event => event.type === 'opening:entered').detail.reason, 'skip');
});

test('completion, repeated replay, visibility loss and page exit release resources exactly once', () => {
  const f = fixture(); f.tick(6490);
  assert.equal(f.root(), null); assert.equal(f.rafs.size, 0); assert.equal(f.renderers[0].disposals, 1);
  assert.equal(f.win.ZhejiangOpening.sessionSeen, true);
  assert.equal(f.events.find(event => event.type === 'opening:entered').detail.reason, 'complete');
  f.win.ZhejiangOpening.replay(); f.win.ZhejiangOpening.replay();
  assert.equal(f.doc.body.children.filter(node => node.id === 'zj-brand-opening').length, 1);
  assert.equal(f.renderers[1].disposals, 1);
  f.doc.hidden = true; f.doc.dispatchEvent({ type: 'visibilitychange' });
  assert.equal(f.root(), null); assert.equal(f.renderers[2].disposals, 1); assert.equal(f.rafs.size, 0);
  f.win.ZhejiangOpening.replay(); f.win.dispatchEvent({ type: 'pagehide' }); f.win.ZhejiangOpening.skip();
  assert.equal(f.root(), null); assert.equal(f.renderers[3].disposals, 1); assert.equal(f.rafs.size, 0);
});
