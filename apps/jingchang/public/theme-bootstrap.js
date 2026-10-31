/* Runs before styles: only explicit theme choices are stored. */
(() => {
  const nativeKey = 'jingchang.theme.v1';
  const workbenchKey = 'backlot.theme';
  const valid = value => value === 'light' || value === 'dark';
  const stored = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const read = () => {
    for (const key of [workbenchKey, nativeKey]) {
      const value = stored(key);
      if (valid(value)) return value;
    }
    return 'dark';
  };
  function set(value, {persist = false} = {}) {
    const theme = valid(value) ? value : 'dark';
    document.documentElement.dataset.theme = theme;
    document.querySelectorAll('.studio').forEach(studio => { studio.dataset.theme = theme; });
    if (persist) {
      const mounted = window.CanvasModule || /^\/canvas(?:-module)?(?:\/|$)/.test(location.pathname);
      try { localStorage.setItem(mounted ? workbenchKey : nativeKey, theme); } catch { /* This page still follows the choice. */ }
    }
    window.dispatchEvent(new CustomEvent('jingchang:theme', {detail: {theme}}));
    return theme;
  }
  window.JingchangTheme = Object.freeze({read, set, version: '2026.10.09-liquid.1'});
  set(read());
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => set(read()), {once: true});
  window.addEventListener('storage', event => { if ([nativeKey, workbenchKey].includes(event.key)) set(read()); });
})();
