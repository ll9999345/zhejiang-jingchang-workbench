// Shared helpers for the Backlot UI.

export async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function fmtDuration(seconds) {
  const n = Number(seconds);
  if (seconds == null || !Number.isFinite(n)) return "";
  const s = Math.max(0, Math.round(n));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

export function fmtMoney(v) {
  const n = Number(v);
  if (v == null || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}

export function fmtAgo(epochSeconds) {
  if (!epochSeconds) return "";
  const diff = Date.now() / 1000 - epochSeconds;
  if (diff < 90) return "刚刚";
  if (diff < 3600) return `${Math.round(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.round(diff / 3600)} 小时前`;
  return `${Math.round(diff / 86400)} 天前`;
}

export function fmtClock(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}

export function mediaURL(projectId, relPath) {
  return `/media/${encodeURIComponent(projectId)}/${relPath.split("/").map(encodeURIComponent).join("/")}`;
}

// Downscaled cached JPEG for images (full media only in players/lightbox).
export function thumbURL(projectId, relPath, w = 640) {
  return `/thumb/${encodeURIComponent(projectId)}/${relPath.split("/").map(encodeURIComponent).join("/")}?w=${w}`;
}

// Subscribe to a server-sent change feed; call onChange (debounced) per burst.
export function subscribe(url, onChange) {
  let timer = null, closed = false;
  const revisions = new Map();
  const source = new EventSource(url);
  const schedule = () => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; if (!closed) onChange(); }, 250);
  };
  source.onopen = () => {
    // Revisions belong to the server process, which may have restarted.
    revisions.clear();
    schedule();
  };
  source.onmessage = (msg) => {
    if (closed) return;
    try {
      const data = JSON.parse(msg.data);
      if (data.type === "hello") { revisions.clear(); schedule(); return; }
      if (data.type !== "change") return;
      // A revision is scoped to one project.  The library listens to all
      // projects, so keep one high-water mark per project instead of one
      // global number that would incorrectly drop another project's update.
      const projectId = String(data.project_id || "");
      const revision = Number(data.revision);
      if (projectId && Number.isFinite(revision) && revision > 0) {
        const previous = revisions.get(projectId) || 0;
        if (revision <= previous) return;
        revisions.set(projectId, revision);
      }
    } catch {
      return;
    }
    schedule();
  };
  source.onerror = () => { /* EventSource auto-reconnects */ };
  const close = source.close.bind(source);
  source.close = () => { closed = true; clearTimeout(timer); timer = null; close(); };
  return source;
}

// Deterministic pseudo-waveform bars (seeded by a string).
export function waveBars(container, seedStr, count = 26, maxH = 14) {
  let seed = 0;
  for (const c of seedStr || "wave") seed = (seed * 31 + c.charCodeAt(0)) % 2147483647;
  seed = seed || 7;
  container.innerHTML = "";
  for (let i = 0; i < count; i++) {
    seed = (seed * 16807) % 2147483647;
    const h = 3 + ((seed % 100) / 100) * maxH * (0.55 + 0.45 * Math.sin(i / 5));
    const bar = document.createElement("i");
    bar.style.height = `${Math.max(3, h)}px`;
    container.append(bar);
  }
}

export const STAGE_ICONS = {
  completed: "✓",
  in_progress: "◉",
  awaiting_human: "◈",
  failed: "✕",
};
