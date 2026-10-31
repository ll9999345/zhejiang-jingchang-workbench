import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const sourcePath = new URL('../public/theme-bootstrap.js', import.meta.url);
const nativeKey = 'jingchang.theme.v1';
const workbenchKey = 'backlot.theme';

// Every page and preference below is synthetic. No browser, service, project,
// credentials or network is required to exercise the classic bootstrap script.
function page({values = {}, pathname = '/', readyState = 'complete', studios = 2,
  canvasModule = false, readFails = false, writeFails = false, storageDenied = false} = {}) {
  const preferences = new Map(Object.entries(values));
  const writes = [];
  const documentEvents = new Map();
  const windowEvents = new Map();
  const studioElements = Array.from({length: studios}, () => ({dataset: {theme: 'light'}}));
  const root = {dataset: {}};
  const document = {
    documentElement: root,
    readyState,
    querySelectorAll: selector => selector.startsWith('.studio') ? studioElements : [],
    addEventListener(type, listener) {
      const listeners = documentEvents.get(type) || [];
      listeners.push(listener);
      documentEvents.set(type, listeners);
    },
  };
  const context = {
    document,
    location: {pathname},
    CustomEvent: class {
      constructor(type, {detail} = {}) {this.type = type; this.detail = detail;}
    },
    addEventListener(type, listener) {
      const listeners = windowEvents.get(type) || [];
      listeners.push(listener);
      windowEvents.set(type, listeners);
    },
    dispatchEvent(event) {
      for (const listener of windowEvents.get(event.type) || []) listener(event);
      return true;
    },
  };
  context.window = context;
  if (canvasModule) context.CanvasModule = {};
  if (storageDenied) {
    Object.defineProperty(context, 'localStorage', {get() {throw Error('synthetic storage denial');}});
  } else {
    context.localStorage = {
      getItem(key) {
        if (readFails) throw Error('synthetic storage read failure');
        return preferences.get(key) ?? null;
      },
      setItem(key, value) {
        if (writeFails) throw Error('synthetic storage write failure');
        writes.push([key, value]);
        preferences.set(key, value);
      },
    };
  }
  runInNewContext(readFileSync(sourcePath, 'utf8'), context, {filename: sourcePath.pathname});
  assert.equal(typeof context.JingchangTheme?.read, 'function');
  assert.equal(typeof context.JingchangTheme?.set, 'function');
  return {
    api: context.JingchangTheme,
    root,
    studios: studioElements,
    preferences,
    writes,
    ready() {
      document.readyState = 'interactive';
      for (const listener of documentEvents.get('DOMContentLoaded') || []) listener();
    },
  };
}

function assertTheme(state, expected) {
  assert.equal(state.root.dataset.theme, expected);
  for (const studio of state.studios) assert.equal(studio.dataset.theme, expected);
}

test('fresh native page starts dark and does not create a stored preference', () => {
  const state = page();
  assertTheme(state, 'dark');
  assert.equal(state.api.read(), 'dark');
  assert.deepEqual(state.writes, []);
  assert.equal(state.preferences.size, 0);
});

test('native explicit light preference is retained without a boot write', () => {
  const state = page({values: {[nativeKey]: 'light'}});
  assertTheme(state, 'light');
  assert.equal(state.api.read(), 'light');
  assert.deepEqual(state.writes, []);
});

test('explicit workbench preference wins over a conflicting native preference', () => {
  const state = page({pathname: '/canvas', values: {[workbenchKey]: 'light', [nativeKey]: 'dark'}});
  assertTheme(state, 'light');
  assert.equal(state.api.read(), 'light');
  assert.deepEqual(state.writes, []);
});

test('invalid workbench preference falls through to a valid native preference', () => {
  const state = page({values: {[workbenchKey]: 'system', [nativeKey]: 'light'}});
  assertTheme(state, 'light');
  assert.equal(state.api.read(), 'light');
});

test('missing or invalid preferences use dark instead of an operating-system choice', () => {
  for (const values of [{}, {[nativeKey]: 'LIGHT'}, {[workbenchKey]: 'auto', [nativeKey]: 'unknown'}]) {
    const state = page({values});
    assertTheme(state, 'dark');
    assert.deepEqual(state.writes, []);
  }
});

test('read obtains the current storage values rather than only the initial theme', () => {
  const state = page();
  state.preferences.set(nativeKey, 'light');
  assert.equal(state.api.read(), 'light');
  state.preferences.set(workbenchKey, 'dark');
  assert.equal(state.api.read(), 'dark');
});

test('loading document gets a dark root immediately and studios synchronize when ready', () => {
  const state = page({readyState: 'loading', studios: 0});
  assert.equal(state.root.dataset.theme, 'dark');
  state.studios.push({dataset: {theme: 'light'}}, {dataset: {theme: 'light'}});
  state.ready();
  assertTheme(state, 'dark');
  assert.deepEqual(state.writes, []);
});

test('loading document retains explicit light when studios become available', () => {
  const state = page({readyState: 'loading', studios: 0, values: {[nativeKey]: 'light'}});
  assert.equal(state.root.dataset.theme, 'light');
  state.studios.push({dataset: {theme: 'dark'}});
  state.ready();
  assertTheme(state, 'light');
  assert.deepEqual(state.writes, []);
});

test('set updates every studio but does not persist by default', () => {
  const state = page();
  state.api.set('light');
  assertTheme(state, 'light');
  assert.deepEqual(state.writes, []);
  assert.equal(state.preferences.size, 0);
});

test('persisting a native user choice writes only the native preference key', () => {
  const state = page({pathname: '/creation-studio'});
  state.api.set('light', {persist: true});
  assertTheme(state, 'light');
  assert.deepEqual(state.writes, [[nativeKey, 'light']]);
  assert.equal(state.preferences.has(workbenchKey), false);
});

test('CanvasModule identifies a proxy page even on a non-canvas pathname', () => {
  const state = page({pathname: '/synthetic-proxy.html', canvasModule: true});
  state.api.set('light', {persist: true});
  assertTheme(state, 'light');
  assert.deepEqual(state.writes, [[workbenchKey, 'light']]);
  assert.equal(state.preferences.has(nativeKey), false);
});

test('canvas and canvas-module routes persist the workbench preference', () => {
  for (const pathname of ['/canvas', '/canvas/', '/canvas-module', '/canvas-module/creation-studio.html']) {
    const state = page({pathname});
    state.api.set('light', {persist: true});
    assertTheme(state, 'light');
    assert.deepEqual(state.writes, [[workbenchKey, 'light']], pathname);
    assert.equal(state.preferences.has(nativeKey), false, pathname);
  }
});

test('invalid set values normalize to dark, including the persisted preference', () => {
  for (const value of ['system', 'LIGHT', '', null, undefined]) {
    const state = page({values: {[nativeKey]: 'light'}});
    state.api.set(value, {persist: true});
    assertTheme(state, 'dark');
    assert.deepEqual(state.writes, [[nativeKey, 'dark']]);
  }
});

test('storage read failure leaves boot and subsequent theme changes usable', () => {
  const state = page({readFails: true});
  assertTheme(state, 'dark');
  assert.equal(state.api.read(), 'dark');
  assert.doesNotThrow(() => state.api.set('light'));
  assertTheme(state, 'light');
  assert.deepEqual(state.writes, []);
});

test('storage write failure preserves the requested theme in the document', () => {
  const state = page({writeFails: true});
  assert.doesNotThrow(() => state.api.set('light', {persist: true}));
  assertTheme(state, 'light');
  assert.deepEqual(state.writes, []);
});

test('a denied localStorage property does not break boot, read or user changes', () => {
  const state = page({storageDenied: true});
  assertTheme(state, 'dark');
  assert.equal(state.api.read(), 'dark');
  assert.doesNotThrow(() => state.api.set('light', {persist: true}));
  assertTheme(state, 'light');
});
