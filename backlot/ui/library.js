import { el, fmtAgo, getJSON, subscribe, thumbURL } from "/ui/lib.js";

const grid = document.getElementById("grid");
const searchInput = document.getElementById("projectSearch");
const statusFilter = document.getElementById("projectFilter");
const sortSelect = document.getElementById("projectSort");
const clearFilters = document.getElementById("clearLibraryFilters");
const libraryStatus = document.getElementById("libraryStatus");
const empty = document.getElementById("empty");
const libraryError = document.getElementById("libraryError");
const retryLibrary = document.getElementById("retryLibrary");
const THEME_KEY = "backlot.theme";
let savedTheme = null;
try { savedTheme = localStorage.getItem(THEME_KEY); } catch { /* Theme storage is optional. */ }
// New visitors get the dark editing-room library; preserve an explicit
// preference so returning creators are never switched behind their back.
let currentTheme = savedTheme === "light" || savedTheme === "dark" ? savedTheme : "dark";

function applyTheme(theme) {
  currentTheme = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = currentTheme;
  try { localStorage.setItem(THEME_KEY, currentTheme); } catch { /* Keep the theme for this page. */ }
}

function renderThemeToggle() {
  const next = currentTheme === "light" ? "dark" : "light";
  return el("button", {
    class: "theme-toggle",
    type: "button",
    title: `Switch to ${next} theme`,
    "aria-label": `Switch to ${next} theme`,
    "aria-pressed": currentTheme === "light" ? "true" : "false",
    onclick: () => {
      applyTheme(next);
      const replacement = renderThemeToggle();
      document.querySelector(".theme-toggle").replaceWith(replacement);
    },
  }, el("span", { class: "theme-toggle-icon", "aria-hidden": "true" }, currentTheme === "light" ? "☾" : "☀"));
}

applyTheme(currentTheme);
document.getElementById("liveBadge").before(renderThemeToggle());

// One entry screen owns all three intake modes; avoid a duplicate modal.
document.getElementById("newProjectButton")?.addEventListener("click", () => { window.location.href = "/create/guided"; });
const pinnedProjects = new Set();
try { const saved = JSON.parse(localStorage.getItem("studio.pinned_projects") || "[]"); if (Array.isArray(saved)) saved.forEach(id => pinnedProjects.add(String(id))); } catch { /* Optional local preferences. */ }
const stageNames = {research:"资料核对",proposal:"创意方案",proposal_review:"创意方案",script:"脚本",scene_plan:"分镜",storyboard_review:"分镜",assets:"素材",edit:"后期",compose:"合成",publish:"交付",video_parameters:"视频生成"};
function stageName(value) { return stageNames[value] || "制作中"; }
function pinButton(p) {
  const button = el("button", {class:"studio-pin", type:"button"});
  const update = () => {
    const pinned = pinnedProjects.has(p.project_id);
    button.textContent = pinned ? "★" : "☆";
    button.setAttribute("aria-pressed", String(pinned));
    button.setAttribute("aria-label", `${pinned ? "取消收藏" : "收藏"}：${p.title || p.project_id}`);
    button.title = pinned ? "已收藏" : "收藏作品";
  };
  update();
  button.addEventListener("click", () => {
    if (pinnedProjects.has(p.project_id)) pinnedProjects.delete(p.project_id); else pinnedProjects.add(p.project_id);
    try { localStorage.setItem("studio.pinned_projects", JSON.stringify([...pinnedProjects])); } catch { /* Keep in this page. */ }
    update(); if (activeFilter === "pinned") { updateLibraryView(); if (!button.isConnected) statusFilter?.focus(); }
  });
  return button;
}

function stageURL(projectId, stageName = null) {
  const params = new URLSearchParams();
  // Keep screenshot/static library links static, but never carry arbitrary
  // query parameters into another project.  This keeps stage navigation
  // scoped to the project card that was clicked.
  if (new URLSearchParams(location.search).has("static")) params.set("static", "1");
  if (stageName) params.set("stage", stageName);
  const query = params.toString();
  return `/p/${encodeURIComponent(projectId)}${query ? `?${query}` : ""}`;
}

// Resume snapshots use workflow phase names (for example
// `proposal_review`), while the Backlot board addresses its real pipeline
// stages (`proposal`). Normalize the handful of aliases here so a copied
// resume link can never open a blank board stage.
const BOARD_STAGE_ALIASES = {
  proposal_review: "proposal",
  idea: "proposal",
  storyboard_review: "scene_plan",
  storyboard: "scene_plan",
  video_parameters: "edit",
  video: "edit",
  provider_running: "edit",
  provider_failed: "edit",
  quality_review: "compose",
  review: "compose",
  postproduction: "edit",
  publish_review: "publish",
  done: "publish",
};

function normalizeBoardStage(stageName) {
  const raw = String(stageName || "").trim();
  return BOARD_STAGE_ALIASES[raw] || raw;
}

function resumeURL(project) {
  const explicit = String(project?.resume_url || "").trim();
  if (explicit) return explicit;
  const id = encodeURIComponent(project?.project_id || "");
  return id ? `/model?project=${id}` : "/model";
}

function boardURL(projectId) {
  return stageURL(projectId);
}

function stageLinkAction(event, projectId, stageName) {
  event.preventDefault();
  event.stopPropagation();
  window.location.href = stageURL(projectId, stageName);
}

function miniRail(projectId, states) {
  const rail = el("div", { class: "mini-rail" });
  for (const s of states) {
    const cls = s.status === "completed" ? "d"
      : s.status === "in_progress" ? "a"
      : s.status === "awaiting_human" ? "w" : "";
    const label = `${s.name}: ${s.status}`;
    rail.append(el("i", {
      class: `${cls} stage-dot-link`,
      title: `${label} · 点击查看此制作环节`,
      role: "link",
      tabindex: "0",
      "aria-label": `打开 ${label}`,
      onclick: (event) => stageLinkAction(event, projectId, s.name),
      onkeydown: (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        stageLinkAction(event, projectId, s.name);
      },
    }));
  }
  return rail;
}

function activeStageLink(project) {
  const stage = normalizeBoardStage(project.resume_stage || project.active_stage);
  if (!stage) return null;
  const label = project.awaiting_human || project.resume_status === "awaiting_human" ? "待你处理" : "继续制作";
  const projectLabel = String(project.title || project.project_id || "当前项目").trim();
  // Use a real anchor for the primary hand-off and send it to the editable
  // model workbench, not the read-only evidence board. The old span+role+
  // keyboard handler looked clickable and the first anchor version opened
  // Backlot, which made “继续制作” a dead end for creators.
  return el("a", {
    class: "lib-stage-link",
    href: resumeURL(project),
    role: "link",
    tabindex: "0",
    title: `${label}：回到${stageName(stage)}继续编辑`,
    "aria-label": `${label}：${projectLabel} · 回到${stageName(stage)}继续编辑`,
  }, `${label} · ${stageName(stage)}`);
}

function card(p) {
  const poster = el("div", { class: "lib-poster" });
  if (p.poster) {
    poster.append(el("img", { src: thumbURL(p.project_id, p.poster, 640), loading: "lazy", alt: `${p.title || p.project_id || "项目"}预览图` }));
  } else {
    poster.append(el("span", { class: "lp-txt" }, "等待第一帧画面"));
  }
  if (p.live && p.active_stage) {
    poster.append(el("span", { class: "lp-live" },
      el("span", { class: "dot" }),
      p.awaiting_human ? "待你确认" : `制作中 · ${stageName(p.active_stage)}`));
  } else if (p.awaiting_human) {
    poster.append(el("span", { class: "lp-live" }, "待你确认"));
  }

  const meta = el("div", { class: "lb-meta" },
    p.scene_count ? el("span", {class:"chip"}, `${p.scene_count} 个镜头`) : el("span", {class:"chip"}, "创意草稿"),
    p.render_count ? el("span", {class:"chip"}, `${p.render_count} 版成片`) : null,
    el("span", {class:"when"}, fmtAgo(p.last_activity)),
  );

  const projectLink = el("a", {
    class: `lib-card${p.live ? " live-card" : ""}`,
    href: resumeURL(p),
    style: "text-decoration:none;color:inherit",
    title: p.resume_stage ? `继续${stageName(p.resume_stage)}` : "打开工作台",
    "aria-label": p.resume_stage ? `继续${stageName(p.resume_stage)}：${p.title || p.project_id}` : `打开项目 ${p.title || p.project_id}`,
  },
    poster,
    el("div", { class: "lib-body" },
      el("h3", {}, (p.title || p.project_id)),
      meta,
    ),
  );
  // Keep the project card itself navigable, but place the “continue at stage”
  // controls beside it. This avoids nested interactive elements, which made a
  // real user click ambiguous (the card and the stage link both matched).
  const active = activeStageLink(p);
  const recordLink = el("a", {
    class: "lib-board-link",
    href: boardURL(p.project_id),
    title: "查看项目的 Backlot 制作记录与证据",
  }, "查看制作记录");
  const stageActions = active || p.stage_states.length
    ? el("div", { class: "lib-card-stage-actions" }, active, recordLink, p.stage_states.length ? miniRail(p.project_id, p.stage_states) : null)
    : null;
  return el("article", {
    class: `lib-card-shell${p.live ? " live-card" : ""}`,
    "data-project-id": p.project_id,
  }, projectLink, pinButton(p), stageActions);
}

let visibleLimit = 12;
const libraryMore = document.getElementById("libraryMore");
libraryMore?.addEventListener("click", () => { visibleLimit += 12; updateLibraryView(); });
let allProjects = [];
let activeQuery = "";
let activeFilter = "all";
let activeSort = "recent";

function projectText(project) {
  return [project.title, project.project_id, project.pipeline_type, project.active_stage, project.resume_stage]
    .filter(Boolean).join(" ").toLocaleLowerCase();
}

function matchesFilter(project) {
  if (activeFilter === "pinned") return pinnedProjects.has(project.project_id);
  if (activeFilter === "live") return Boolean(project.live);
  if (activeFilter === "awaiting") return Boolean(project.awaiting_human || project.resume_status === "awaiting_human");
  if (activeFilter === "failed") return (project.stage_states || []).some((stage) => stage.status === "failed");
  if (activeFilter === "ready") return Boolean(project.resume_url || project.resume_stage || project.active_stage);
  return true;
}

function visibleProjects() {
  const query = activeQuery.trim().toLocaleLowerCase();
  return allProjects
    .filter((project) => (!query || projectText(project).includes(query)) && matchesFilter(project))
    .sort((a, b) => activeSort === "title"
      ? String(a.title || a.project_id || "").localeCompare(String(b.title || b.project_id || ""), "zh-CN")
      : Number(b.last_activity || 0) - Number(a.last_activity || 0));
}

function updateLibraryView() {
  const projects = visibleProjects();
  const hasFilters = Boolean(activeQuery || activeFilter !== "all");
  const existing = new Map([...grid.children].map(node => [node.dataset.projectId, node]));
  const kept = new Set();
  projects.slice(0, visibleLimit).forEach((project, index) => {
    const signature = projectSignature(project);
    let node = existing.get(String(project.project_id));
    if (!node || node.dataset.signature !== signature) {
      node = card(project);
      node.dataset.signature = signature;
    }
    kept.add(node);
    if (grid.children[index] !== node) grid.insertBefore(node, grid.children[index] || null);
  });
  [...grid.children].forEach(node => { if (!kept.has(node)) node.remove(); });
  if (libraryMore) { libraryMore.hidden = projects.length <= visibleLimit; libraryMore.textContent = `查看更多作品（还有 ${Math.max(0, projects.length - visibleLimit)} 个）`; }
  clearFilters.hidden = !hasFilters;
  libraryStatus.textContent = hasFilters
    ? `显示 ${projects.length} / ${allProjects.length} 个项目`
    : `${allProjects.length} 个项目`;
  if (!allProjects.length) {
    empty.textContent = "还没有作品。点击右上角“新建作品”，从一个想法开始。";
    empty.style.display = "block";
  } else if (!projects.length) {
    empty.textContent = "没有匹配的项目。可以换个关键词或清除筛选。";
    empty.style.display = "block";
  } else {
    empty.style.display = "none";
  }
}

function applyLibraryFilters() {
  visibleLimit = 12;
  activeQuery = searchInput?.value || "";
  activeFilter = statusFilter?.value || "all";
  activeSort = sortSelect?.value || "recent";
  updateLibraryView();
}

searchInput?.addEventListener("input", applyLibraryFilters);
statusFilter?.addEventListener("change", applyLibraryFilters);
sortSelect?.addEventListener("change", applyLibraryFilters);
clearFilters?.addEventListener("click", () => {
  if (searchInput) searchInput.value = "";
  if (statusFilter) statusFilter.value = "all";
  applyLibraryFilters();
  searchInput?.focus();
});

let lastLibrarySignature = null;
let libraryRenderInFlight = null;
let libraryRenderQueued = false;
let libraryRenderTimer = null;

function projectSignature(project) {
  // Keep the signature limited to creator-visible/stateful fields. A running
  // task may publish a heartbeat every few seconds, which only changes
  // `last_activity`; using that raw timestamp here would replace the whole
  // card and make the library flash. Keep a minute bucket so the relative
  // time label can still refresh without repainting on every heartbeat.
  const stable = { ...(project || {}) };
  const lastActivity = Number(stable.last_activity);
  delete stable.timestamp;
  delete stable.ts;
  delete stable.created_at;
  delete stable.updated_at;
  delete stable.last_activity;
  stable.last_activity_minute = Number.isFinite(lastActivity)
    ? Math.floor(lastActivity / 60)
    : null;
  return JSON.stringify(stable);
}

async function render() {
  if (libraryRenderInFlight) {
    libraryRenderQueued = true;
    return libraryRenderInFlight;
  }
  libraryRenderInFlight = getJSON("/api/projects").then((projects) => {
    allProjects = Array.isArray(projects) ? projects : [];
    libraryError.hidden = true;
    const signature = JSON.stringify(allProjects.map(projectSignature));
    document.getElementById("count").textContent = `${allProjects.length} 个项目`;
    const liveCount = allProjects.filter((p) => p.live).length;
    const badge = document.getElementById("liveBadge");
    badge.classList.toggle("idle", liveCount === 0);
    document.getElementById("liveText").textContent = liveCount ? `${liveCount} LIVE` : "IDLE";
    if (signature === lastLibrarySignature) {
      updateLibraryView();
      return;
    }
    lastLibrarySignature = signature;

    updateLibraryView();
  }).catch((error) => {
    console.error(error);
    empty.style.display = "none";
    libraryError.hidden = false;
    libraryStatus.textContent = "项目库读取失败";
  }).finally(() => {
    libraryRenderInFlight = null;
    if (libraryRenderQueued) {
      libraryRenderQueued = false;
      void render().catch(console.error);
    }
  });
  return libraryRenderInFlight;
}

function scheduleRender() {
  window.clearTimeout(libraryRenderTimer);
  libraryRenderTimer = window.setTimeout(() => render().catch(console.error), 180);
}

retryLibrary?.addEventListener("click", () => render());
render().catch(console.error);
if (!new URLSearchParams(location.search).has("static")) {
  subscribe("/api/library/events", scheduleRender);
}
