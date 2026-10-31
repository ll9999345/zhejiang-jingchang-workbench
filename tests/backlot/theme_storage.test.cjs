// Exercise the real theme initialization with browser storage failure modes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

for (const file of ['library.js', 'board.js']) {
  const source = readFileSync(path.join(__dirname, '../../backlot/ui', file), 'utf8');
  const themeCode = source.slice(source.indexOf('const THEME_KEY'), source.indexOf('function renderThemeToggle'));
  for (const mode of ['denied', 'read-failed', 'write-failed', 'normal', 'invalid']) {
    test(`${file}: theme remains usable with ${mode} storage`, () => {
      const writes = [];
      const context = vm.createContext({ document: { documentElement: { dataset: {} } } });
      Object.defineProperty(context, 'localStorage', {
        get() {
          if (mode === 'denied') throw new Error('SecurityError');
          return {
            getItem() {
              if (mode === 'read-failed') throw new Error('SecurityError');
              return mode === 'invalid' ? 'invalid-theme' : 'dark';
            },
            setItem(key, value) {
              if (mode === 'write-failed') throw new Error('QuotaExceededError');
              writes.push([key, value]);
            },
          };
        },
      });
      vm.runInContext(themeCode + '\napplyTheme(currentTheme);', context);
      // The shared UI deliberately uses dark as its new-visitor fallback;
      // an unavailable or invalid preference must not crash theme setup.
      assert.equal(context.document.documentElement.dataset.theme, 'dark');
      vm.runInContext('applyTheme("light"); applyTheme("dark");', context);
      assert.equal(context.document.documentElement.dataset.theme, 'dark');
      if (mode === 'normal') assert.deepEqual(writes.at(-1), ['backlot.theme', 'dark']);
    });
  }
}
