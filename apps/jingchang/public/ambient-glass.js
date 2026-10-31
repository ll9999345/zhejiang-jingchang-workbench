/* Ambient light has its own preference. It never reads or changes task state,
 * projects, media, credentials, or generation requests. */
export const AMBIENT_PREFERENCE_KEY = 'jingchang.ambient-motion.v1';

export function frameQuality(timestamps) {
  const intervals = timestamps.slice(1).map((value, index) => value - timestamps[index]).filter(value => value > 0);
  const duration = timestamps.at(-1) - timestamps[0];
  const fps = duration > 0 ? intervals.length * 1000 / duration : 0;
  const slowShare = intervals.length ? intervals.filter(value => value > 70).length / intervals.length : 1;
  return { fps, frames: intervals.length, slowShare, static: intervals.length < 12 || fps < 24 || slowShare > .35 };
}

export function ambientState({ preference, reducedMotion, reducedTransparency, forcedColors, hidden, supported = true }) {
  if (reducedMotion || reducedTransparency || forcedColors) return { motion: 'paused', quality: 'static', reason: 'system', disabled: true };
  if (!supported) return { motion: 'paused', quality: 'static', reason: 'capability', disabled: true };
  const automatic = preference === 'auto', paused = preference === 'paused' || automatic;
  return { motion: hidden || paused ? 'paused' : 'running', quality: automatic ? 'static' : 'standard', reason: hidden ? 'background' : automatic ? 'performance' : paused ? 'user' : '', disabled: false };
}

let installed;
export function installAmbientGlass() {
  if (installed) return installed;
  const body = document.body;
  body.dataset.glassStyle = 'cyan';
  // The host can mount the shared light field before this module evaluates.
  const light = body.querySelector('.jc-aurora') || document.createElement('div');
  light.className = 'jc-aurora';
  light.setAttribute('aria-hidden', 'true');
  if (!light.isConnected) body.prepend(light);
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'ambient-motion-button';
  button.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M3 8c3-5 6 5 9 0s6 5 9 0M3 16c3-5 6 5 9 0s6 5 9 0"/></svg>';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const transparency = matchMedia('(prefers-reduced-transparency: reduce)');
  const contrast = matchMedia('(forced-colors: active)');
  const supported = typeof CSS !== 'undefined' && (CSS.supports('backdrop-filter', 'blur(1px)') || CSS.supports('-webkit-backdrop-filter', 'blur(1px)'));
  let preference;
  try { preference = localStorage.getItem(AMBIENT_PREFERENCE_KEY); } catch { /* Storage is optional. */ }
  // Older builds persisted an automatic pause. Only explicit user choices
  // carry across visits; a stored "auto" gets a fresh bounded sample here.
  if (!['paused', 'running'].includes(preference)) preference = null;
  let disposed = false, sampled = false, probeId = 0, probeTimer = 0, samples = [];
  function save(value) {
    preference = value;
    try { localStorage.setItem(AMBIENT_PREFERENCE_KEY, value); } catch { /* Keep the in-memory choice. */ }
  }
  function state() {
    return ambientState({ preference, reducedMotion: reduced.matches, reducedTransparency: transparency.matches, forcedColors: contrast.matches, hidden: document.hidden, supported });
  }
  function mount() {
    const rail = document.querySelector('.app .rail');
    if (rail) { if (button.parentElement !== rail) rail.insertBefore(button, rail.querySelector('.avatar')); return; }
    const footer = document.querySelector('.studio .left-footer');
    if (footer) { if (button.parentElement !== footer) footer.insertBefore(button, footer.querySelector('.price-link')); return; }
    const header = document.querySelector('body > header');
    if (header && button.parentElement !== header) header.append(button);
  }
  function stopProbe() { cancelAnimationFrame(probeId); clearTimeout(probeTimer); probeId = 0; probeTimer = 0; samples = []; }
  function sync() {
    if (disposed) return;
    const value = state();
    body.dataset.ambientMotion = value.motion;
    body.dataset.ambientQuality = value.quality;
    body.dataset.ambientReason = value.reason;
    body.dataset.ambientTransparency = transparency.matches || contrast.matches ? 'reduced' : 'standard';
    button.disabled = value.disabled;
    const paused = preference === 'paused' || preference === 'auto' || value.disabled;
    button.setAttribute('aria-pressed', String(paused));
    const label = value.reason === 'system' ? '背景动效已随系统设置暂停'
      : value.reason === 'capability' ? '当前浏览器使用静态外观'
      : preference === 'auto' ? '播放背景动效（低帧率自动暂停）'
      : paused ? '播放背景动效' : '暂停背景动效';
    button.setAttribute('aria-label', label); button.title = label;
    mount();
    if (value.motion === 'paused') stopProbe();
    else if (!sampled && preference === null && !probeId) startProbe();
  }
  function finishProbe() {
    const measured = frameQuality(samples);
    stopProbe(); sampled = true;
    if (state().motion !== 'running' || preference !== null) return;
    body.dataset.ambientSampleStatic = String(measured.static);
    body.dataset.ambientSampleFps = measured.fps.toFixed(1);
    // A slow startup sample is a session decision, not a permanent user
    // preference. A busy tab must not disable motion on every later visit.
    if (measured.static) preference = 'auto';
    sync();
  }
  function startProbe() {
    // One bounded visible-start sample, never a continuous JS animation loop.
    samples = [];
    const tick = time => {
      if (disposed || state().motion !== 'running' || preference !== null) { stopProbe(); return; }
      samples.push(time);
      if (samples.length >= 180 || samples.length > 1 && time - samples[0] >= 2000) finishProbe();
      else probeId = requestAnimationFrame(tick);
    };
    probeId = requestAnimationFrame(tick);
    probeTimer = setTimeout(finishProbe, 2800);
  }
  function toggle() { stopProbe(); sampled = true; save(preference === 'paused' || preference === 'auto' ? 'running' : 'paused'); sync(); }
  function storage(event) { if (event.key !== AMBIENT_PREFERENCE_KEY) return; stopProbe(); preference = ['paused', 'running', 'auto'].includes(event.newValue) ? event.newValue : null; sync(); }
  button.addEventListener('click', toggle);
  document.addEventListener('visibilitychange', sync);
  window.addEventListener('pageshow', sync);
  window.addEventListener('storage', storage);
  for (const media of [reduced, transparency, contrast]) {
    if (media.addEventListener) media.addEventListener('change', sync); else media.addListener(sync);
  }
  const observer = new MutationObserver(mount);
  observer.observe(body, { childList: true, subtree: true });
  sync();
  installed = { button, sync, applyPerformanceFallback() {
    // Unified workspaces can use this session-only choice after their real
    // renderer sample. An explicit user choice always wins; nothing is saved.
    if (disposed || preference !== null || state().motion !== 'running') return false;
    stopProbe(); sampled = true; preference = 'auto'; sync(); return true;
  }, dispose() {
    disposed = true; stopProbe(); observer.disconnect();
    document.removeEventListener('visibilitychange', sync); window.removeEventListener('pageshow', sync); window.removeEventListener('storage', storage);
    for (const media of [reduced, transparency, contrast]) { if (media.removeEventListener) media.removeEventListener('change', sync); else media.removeListener(sync); }
    button.remove(); light.remove(); installed = null;
  } };
  return installed;
}

export function applyAmbientPerformanceFallback() { return installed?.applyPerformanceFallback() || false; }

if (typeof document !== 'undefined') installAmbientGlass();
