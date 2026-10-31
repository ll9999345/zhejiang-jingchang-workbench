// Backlot project board — renders BoardState and stays live via SSE.

import {
  STAGE_ICONS, el, fmtAgo, fmtClock, fmtDuration, fmtMoney,
  getJSON, mediaURL, subscribe, thumbURL, waveBars,
} from "/ui/lib.js";

const rawProjectPath = location.pathname.split("/p/")[1] || "";
const projectId = decodeURIComponent(rawProjectPath);
const encodedProjectId = encodeURIComponent(projectId);
const app = document.getElementById("app");
const modal = document.getElementById("modal");
const player = document.getElementById("player");

// Stage links use a query parameter instead of a second path segment.  The
// server already owns `/p/<project-id>` (including project-id validation), so
// this keeps deep links bookmarkable without ever treating a stage name as a
// different project.  It also lets a library card and an Activity row share
// one navigation contract.
const STAGE_PARAM = "stage";
const requestedStage = () => {
  const value = new URLSearchParams(location.search).get(STAGE_PARAM);
  return value ? String(value).trim() : "";
};

function stageURL(stageName) {
  const url = new URL(window.location.href);
  if (stageName) url.searchParams.set(STAGE_PARAM, stageName);
  else url.searchParams.delete(STAGE_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

// The board is the evidence view; the model page is the production view.
// Keep that distinction explicit so a creator can leave a project, return to
// the library, and still jump back into the exact stage instead of landing on
// another read-only board.
function modelResumeURL(stageName = "") {
  const params = new URLSearchParams({ project: projectId });
  const stage = String(stageName || "").trim();
  if (stage) params.set("resume_stage", stage);
  return `/model?${params.toString()}`;
}

const RESUME_STAGE_LABELS = {
  research: "资料核对",
  proposal: "方案选择",
  proposal_review: "方案选择",
  script: "脚本检查",
  scene_plan: "分镜检查",
  storyboard: "分镜检查",
  storyboard_review: "分镜检查",
  assets: "分镜图/素材",
  video: "视频参数",
  video_parameters: "视频参数",
  provider_running: "视频任务",
  quality_review: "质检",
  review: "质检",
  edit: "后期制作",
  postproduction: "后期制作",
  compose: "合成",
  publish: "发布审核",
  publish_review: "发布审核",
  done: "已完成项目",
};

function resumeStageLabel(stageName) {
  const key = String(stageName || "").trim();
  return RESUME_STAGE_LABELS[key] || key || "工作台";
}

const THEME_KEY = "backlot.theme";
let savedTheme = null;
try { savedTheme = localStorage.getItem(THEME_KEY); } catch { /* Theme storage is optional. */ }
let currentTheme = savedTheme === "light" ? "light" : "dark";
let state = null;
let selectedStage = null;   // stage drawer open for this stage name
let activeRender = 0;
let replay = null;          // {t0, t1, t, playing, speed, lastFrameAt}
let replayEvidence = null;  // server-verified persisted timeline
let replayLoading = false;  // prevent duplicate requests from double-clicks
let firstPaint = true;
let lastStateSignature = null;
let refreshInFlight = null;
let refreshQueued = false;

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
      render();
    },
  }, el("span", { class: "theme-toggle-icon", "aria-hidden": "true" }, currentTheme === "light" ? "☾" : "☀"));
}

applyTheme(currentTheme);

// ---------------------------------------------------------------------------
// header slate
// ---------------------------------------------------------------------------

function renderSlate(s) {
  const board = s.storyboard;
  const chips = [
    el("span", { class: "chip" }, `${s.pipeline.pipeline_type} · 制作流程`),
    board && board.total_duration_seconds
      ? el("span", { class: "chip" }, `${board.scenes.length} 个镜头 · ${fmtDuration(board.total_duration_seconds)}`)
      : null,
    s.style_playbook ? el("span", { class: "chip" }, s.style_playbook) : null,
  ];

  const awaiting = s.stages.find((x) => x.status === "awaiting_human");
  const inProgress = s.stages.find((x) => x.status === "in_progress");
  const stalled = s.stages.find((x) => x.stalled);
  let liveEl;
  if (awaiting) {
    liveEl = el("span", { class: "live" }, el("span", { class: "dot" }), "等待确认");
  } else if (stalled) {
    liveEl = el("span", { class: "live", style: "color:var(--red)" },
      el("span", { class: "dot", style: "background:var(--red);animation:none" }), "进度待检查");
  } else if (s.live || inProgress) {
    liveEl = el("span", { class: "live" }, el("span", { class: "dot" }), "进行中");
  } else {
    liveEl = el("span", { class: "live idle" }, el("span", { class: "dot" }),
      `已保存${s.last_activity ? " · " + fmtAgo(s.last_activity) : ""}`);
  }

  const resumeStage = s.resume_phase || s.resume_stage || s.active_stage || "";
  const resumeEntry = el("a", {
    class: "model-entry",
    href: modelResumeURL(resumeStage),
    title: resumeStage ? `返回工作台继续：${resumeStageLabel(resumeStage)}` : "打开当前项目工作台",
    "aria-label": resumeStage ? `返回工作台继续${resumeStageLabel(resumeStage)}` : "打开当前项目工作台",
  }, resumeStage ? `继续${resumeStageLabel(resumeStage)}` : "打开工作台");

  const cost = el("div", { class: "cost" });
  if (s.cost) {
    const spent = s.cost.total_spent_usd ?? 0;
    const budget = spent + (s.cost.budget_remaining_usd ?? 0);
    const hasBudget = s.cost.budget_remaining_usd != null;
    const pct = hasBudget && budget > 0 ? Math.min(100, (spent / budget) * 100) : 0;
    cost.append(el("div", { class: "nums" }, el("b", {}, fmtMoney(spent)),
      hasBudget ? el("span", {}, ` / ${fmtMoney(budget)}`) : ""));
    if (hasBudget) {
      cost.append(el("div", { class: "bar" }, el("i", {
        class: pct > 90 ? "crit" : pct > 75 ? "warn" : "", style: `width:${pct}%`,
      })));
    }
    cost.append(el("div", { class: "label" }, "已记录生成费用"));
  }

  return el("header", { class: "slate" },
    el("div", { class: "clapper" }),
    el("div", {},
      el("a", {
        class: "backlot-back-link",
        href: "/",
        "aria-label": "返回项目库",
      }, "← 返回项目库"),
      el("a", { class: "wordmark", href: "/", style: "text-decoration:none" }, "Backlot"),
      el("h1", {}, s.title),
    ),
    ...chips,
    el("div", { class: "spacer" }),
    resumeEntry,
    renderThemeToggle(),
    liveEl,
    cost,
  );
}

// ---------------------------------------------------------------------------
// stage rail
// ---------------------------------------------------------------------------

function stageSub(st) {
  if (st.status === "awaiting_human") return "等待确认\n返回工作台继续";
  if (st.status === "in_progress" && st.stalled) {
    return `${st.stalled_minutes} 分钟没有新进度\n可展开查看记录`;
  }
  if (st.status === "in_progress" && st.partial_progress) {
    const done = st.partial_progress.completed_scene_ids;
    if (Array.isArray(done)) return `已完成 ${done.length} 个镜头`;
    return "正在处理";
  }
  if (st.status === "in_progress") return "正在处理";
  if (st.status === "failed") return st.error ? String(st.error).slice(0, 60) : "执行失败";
  if (st.timestamp) {
    const approved = st.gated && st.human_approved ? " · 已确认" : "";
    return fmtClock(st.timestamp) + approved;
  }
  return "";
}

function renderRail(s) {
  const rail = el("nav", { class: "rail" });
  let pendingIndex = 1;
  for (const st of s.stages) {
    const cls = st.status === "completed" ? "done"
      : st.status === "in_progress" ? (st.stalled ? "active stalled" : "active")
      : st.status === "awaiting_human" ? "await"
      : st.status === "failed" ? "failed" : "";
    const icon = STAGE_ICONS[st.status] || String(pendingIndex);
    if (!STAGE_ICONS[st.status]) pendingIndex += 1;
    const node = el("div", {
      class: `stage ${cls}${selectedStage === st.name ? " selected" : ""}${st.undeclared ? " undeclared" : ""}`,
      title: st.undeclared ? `"${st.name}" ran but isn't declared by this pipeline's manifest` : `打开 ${st.name} 制作环节`,
      role: "button",
      tabindex: "0",
      "data-stage": st.name,
      "aria-current": selectedStage === st.name ? "step" : null,
      "aria-label": `打开 ${st.name} 制作环节，当前状态：${st.status}`,
      onclick: () => toggleDrawer(st.name),
      onkeydown: (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggleDrawer(st.name);
        }
      },
    },
      el("span", { class: "line" }),
      el("span", { class: "node" }, icon),
      el("span", { class: "name" }, resumeStageLabel(st.name)),
      el("span", { class: "sub", style: "white-space:pre-line" },
        st.undeclared ? `${stageSub(st)}\nunlisted`.trim() : stageSub(st)),
    );
    rail.append(node);
  }
  return rail;
}

function scrollToStage(stageName) {
  if (!stageName) return;
  // The rail and drawer are recreated on each state refresh.  Resolve the
  // node after render rather than retaining a stale element reference.
  requestAnimationFrame(() => {
    const drawer = document.querySelector(".drawer[data-stage]");
    const stage = [...document.querySelectorAll(".stage")]
      .find((node) => node.getAttribute("data-stage") === stageName);
    (drawer || stage)?.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });
  });
}

function updateStageURL(stageName) {
  const next = stageURL(stageName);
  if (next !== `${location.pathname}${location.search}${location.hash}`) {
    window.history.replaceState({ stage: stageName || null }, "", next);
  }
}

function focusStage(stageName, { updateUrl = true, scroll = true } = {}) {
  const name = String(stageName || "").trim();
  if (!state || !name || !state.stages.some((stage) => stage.name === name)) return false;
  selectedStage = name;
  if (updateUrl) updateStageURL(name);
  render();
  if (scroll) scrollToStage(name);
  return true;
}

function toggleDrawer(stageName) {
  if (selectedStage === stageName) {
    selectedStage = null;
    updateStageURL(null);
    render();
    return;
  }
  focusStage(stageName);
}

const STAGE_ARTIFACTS = {
  research: ["research_brief"],
  proposal: ["proposal_packet"],
  idea: ["brief"],
  script: ["script"],
  scene_plan: ["scene_plan"],
  assets: ["asset_manifest"],
  edit: ["edit_decisions"],
  compose: ["render_report", "final_review"],
  publish: ["publish_log"],
};

function artifactNamesForStage(st) {
  const declared = Array.isArray(st.produces) ? st.produces : [];
  const fallback = STAGE_ARTIFACTS[st.name] || [];
  return [...new Set([...declared, ...fallback].filter(Boolean))];
}

function reviewMetrics(review) {
  const nested = review && review.summary && typeof review.summary === "object"
    ? review.summary : {};
  return {
    critical: Number((review && review.critical) ?? nested.critical ?? 0),
    suggestions: Number((review && review.suggestions) ?? nested.suggestions ?? 0),
    nitpicks: Number((review && review.nitpicks) ?? nested.nitpicks ?? 0),
  };
}

function reviewSummaryText(review) {
  if (!review) return "";
  if (typeof review.summary === "string") return review.summary;
  const nested = review.summary && typeof review.summary === "object" ? review.summary : {};
  const counts = reviewMetrics(review);
  return [
    review.decision,
    `${counts.critical} 项关键问题`,
    `${counts.suggestions} 条建议`,
    nested.review_focus_met ? `review focus ${nested.review_focus_met}` : null,
    nested.schema_validation,
  ].filter(Boolean).join(" · ");
}

function renderDrawer(s) {
  if (!selectedStage) return null;
  const st = s.stages.find((x) => x.name === selectedStage);
  if (!st) return null;

  const body = el("div", { class: "drawer-body" });

  if (st.review) {
    const metrics = reviewMetrics(st.review);
    const summary = reviewSummaryText(st.review);
    body.append(el("div", { class: "findings", style: "margin-bottom:12px" },
      el("span", { class: `f ${metrics.critical ? "crit" : ""}` }, `${metrics.critical} critical`),
      el("span", { class: `f ${metrics.suggestions ? "sugg" : ""}` }, `${metrics.suggestions} suggestions`),
      el("span", { class: "f" }, `${metrics.nitpicks} nitpicks`),
      summary ? el("span", { style: "font-size:calc(11.5px * var(--fs-scale));color:var(--text-2);margin-left:8px" }, summary) : null,
    ));
  }

  const names = artifactNamesForStage(st);
  let shown = false;
  for (const name of names) {
    const artifact = s.artifacts[name];
    if (!artifact) continue;
    shown = true;
    body.append(
      el("div", { class: "d-cat", style: "font-family:var(--mono);font-size:calc(9.5px * var(--fs-scale));color:var(--text-3);letter-spacing:.1em;text-transform:uppercase;margin:6px 0 4px" }, name),
      el("pre", {}, JSON.stringify(artifact, null, 2)),
    );
  }
  if (!shown) {
    body.append(el("div", { class: "hint" },
      st.status === "pending" ? "This stage hasn't run yet." : "No canonical artifact found on disk for this stage."));
  }

  const canResume = [
    "in_progress", "awaiting_human", "failed", "needs_sources", "blocked",
  ].includes(String(st.status || "").toLowerCase());
  const drawerAction = el("div", { class: "drawer-actions" },
    el("a", {
      class: "model-entry",
      href: modelResumeURL(st.name),
      title: canResume
        ? `回到工作台继续：${resumeStageLabel(st.name)}`
        : `在工作台查看：${resumeStageLabel(st.name)}`,
      "aria-label": canResume
        ? `回到工作台继续${resumeStageLabel(st.name)}`
        : `在工作台查看${resumeStageLabel(st.name)}`,
    }, canResume ? `继续${resumeStageLabel(st.name)}` : `在工作台查看${resumeStageLabel(st.name)}`),
  );

  return el("div", { class: "drawer", "data-stage": st.name, id: "stage-drawer" },
    el("div", { class: "drawer-head" },
      el("h3", {}, `${st.name} — ${st.status}`),
      st.gate_skipped ? el("span", { class: "gate-chip" }, "⚑ GATE SKIPPED") : null,
      st.versions > 1 ? el("span", { class: "ver-chip" }, `v${st.versions}`) : null,
      st.timestamp ? el("span", { class: "meta", style: "font-family:var(--mono);font-size:calc(10.5px * var(--fs-scale));color:var(--text-3)" }, st.timestamp) : null,
      el("span", { class: "close", onclick: () => toggleDrawer(st.name) }, "CLOSE ✕"),
    ),
    body,
    drawerAction,
  );
}

// ---------------------------------------------------------------------------
// script card
// ---------------------------------------------------------------------------

function scriptSections(script, limit) {
  const sections = script.sections || [];
  const shown = limit ? sections.slice(0, limit) : sections;
  const nodes = [];
  for (const sec of shown) {
    nodes.push(el("div", { class: "sp-slug" },
      `${(sec.id || "").toUpperCase()} — ${sec.label || "Section"} `,
      el("span", { class: "tc" }, `${fmtDuration(sec.start_seconds)} – ${fmtDuration(sec.end_seconds)}`)));
    if (sec.text) nodes.push(el("div", { class: "sp-action" }, sec.text));
    if (sec.speaker_directions) nodes.push(el("div", { class: "sp-paren" }, `(${sec.speaker_directions})`));
    const cues = sec.enhancement_cues || [];
    if (cues.length) {
      nodes.push(el("div", { style: "margin-left:42px" },
        cues.map((c) => el("span", { class: "sp-cue" }, `▸ ${c.type} · ${String(c.description || "").slice(0, 60)}`))));
    }
  }
  if (limit && sections.length > limit) {
    nodes.push(el("div", { class: "sp-fade" }, `… 还有 ${sections.length - limit} 段`));
  }
  return nodes;
}

function renderScriptCard(s) {
  const script = s.artifacts.script;
  if (!script) return null;
  const scriptStage = s.stages.find((x) => x.name === "script");
  const status = scriptStage ? scriptStage.status : "unknown";
  const stamp = status === "completed"
    ? el("span", { class: "script-status script-approved" }, "已确认")
    : status === "awaiting_human"
      ? el("span", { class: "script-status script-pending" }, "等待确认")
      : status === "in_progress"
        ? el("span", { class: "script-status script-draft" }, "整理中")
        : null;

  const card = el("div", { class: "script-card script-preview", title: "展开完整脚本", onclick: openScriptModal },
    stamp,
    el("div", { class: "sp-title" }, script.title || s.title),
    el("div", { class: "sp-meta" },
      `脚本 · ${fmtDuration(script.total_duration_seconds)} · ${(script.sections || []).length} 段`),
    ...scriptSections(script, 4),
    el("span", { class: "sp-expand" }, "展开完整脚本"),
  );
  return card;
}

function humanize(value) {
  const labels = {
    artifact: "记录", proposal_packet: "创意方案", research_brief: "资料核对", scene_plan: "分镜计划",
    asset_manifest: "素材清单", edit_decisions: "剪辑决策", render_report: "成片报告", publish_log: "导出记录",
    script: "脚本", brief: "创作需求", platform: "平台", duration: "时长", tone: "语气", style: "风格",
    runtime: "渲染方式", pipeline: "制作流程", "estimated cost": "预计费用", concepts: "方案数",
    "fact status": "资料状态", sources: "来源", "data points": "数据条目", angles: "创意角度",
    sections: "段落", scenes: "镜头", assets: "素材", types: "类型", "generation cost": "生成费用",
    cuts: "剪辑片段", outputs: "导出文件", destinations: "导出目标",
  };
  return labels[value] || String(value || "记录").replaceAll("_", " ");
}

function shortText(value, limit = 180) {
  const text = String(value || "").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function reviewFact(label, value) {
  if (value == null || value === "") return null;
  return el("div", { class: "approval-fact" },
    el("span", {}, humanize(label)),
    el("b", {}, value),
  );
}

function reviewFacts(items) {
  const facts = items.filter(Boolean);
  return facts.length ? el("div", { class: "approval-facts" }, facts) : null;
}

function titledItems(items, selectedId = null) {
  const rows = (items || []).slice(0, 4).map((item, index) => {
    if (item == null) return null;
    if (typeof item !== "object") {
      return el("li", {}, shortText(item));
    }
    const id = item.id || item.concept_id || item.option_id;
    const title = item.title || item.name || item.display_name || item.label || id || item.path || item.platform || item.description || `Item ${index + 1}`;
    const detail = item.hook || item.why_this_works || item.summary || item.description || item.silhouette_notes;
    return el("li", { class: id && id === selectedId ? "selected" : "" },
      el("div", { class: "approval-item-title" }, shortText(title, 100),
        id && id === selectedId ? el("span", { class: "approval-selected" }, "已选中") : null),
      detail && detail !== title ? el("p", {}, shortText(detail)) : null,
    );
  }).filter(Boolean);
  return rows.length ? el("ul", { class: "approval-items" }, rows) : null;
}

function genericArtifactSummary(artifact) {
  const facts = [];
  const items = [];
  for (const [key, value] of Object.entries(artifact || {})) {
    if (["version", "decision_log_ref"].includes(key)) continue;
    if (["string", "number", "boolean"].includes(typeof value)) {
      facts.push(reviewFact(humanize(key), shortText(value, 90)));
    } else if (Array.isArray(value)) {
      facts.push(reviewFact(humanize(key), `${value.length} item${value.length === 1 ? "" : "s"}`));
      if (!items.length && value.length) items.push(titledItems(value));
    }
    if (facts.length >= 6) break;
  }
  return [reviewFacts(facts), ...items].filter(Boolean);
}

function artifactReviewContent(name, artifact) {
  if (name === "brief") {
    return [
      artifact.hook ? el("p", { class: "approval-lead" }, artifact.hook) : null,
      reviewFacts([
        reviewFact("platform", artifact.target_platform),
        reviewFact("duration", artifact.target_duration_seconds != null ? fmtDuration(artifact.target_duration_seconds) : null),
        reviewFact("tone", artifact.tone),
        reviewFact("style", artifact.style),
      ]),
      titledItems(artifact.key_points),
    ].filter(Boolean);
  }
  if (name === "proposal_packet") {
    const selected = (artifact.selected_concept || {}).concept_id;
    const plan = artifact.production_plan || {};
    const cost = artifact.cost_estimate || {};
    return [
      reviewFacts([
        reviewFact("runtime", plan.render_runtime),
        reviewFact("pipeline", plan.pipeline),
        reviewFact("estimated cost", cost.total_estimated_usd != null ? fmtMoney(cost.total_estimated_usd) : null),
        reviewFact("concepts", Array.isArray(artifact.concept_options) ? artifact.concept_options.length : null),
      ]),
      titledItems(artifact.concept_options, selected),
      (artifact.selected_concept || {}).rationale
        ? el("p", { class: "approval-rationale" },
          el("b", {}, "选择理由  "), shortText(artifact.selected_concept.rationale))
        : null,
    ].filter(Boolean);
  }
  if (name === "research_brief") {
    const checks = Array.isArray(artifact.checks) ? artifact.checks : [];
    return [
      artifact.topic ? el("p", { class: "approval-lead" }, artifact.topic) : null,
      reviewFacts([
        reviewFact("fact status", artifact.status),
        reviewFact("sources", Array.isArray(artifact.sources) ? artifact.sources.length : null),
        reviewFact("data points", Array.isArray(artifact.data_points) ? artifact.data_points.length : null),
        reviewFact("angles", Array.isArray(artifact.angles_discovered) ? artifact.angles_discovered.length : null),
      ]),
      checks.length ? el("ul", { class: "approval-items" }, checks.map((check) => el("li", {},
        el("div", { class: "approval-item-title" }, shortText(check.label || check.id || "source check", 100)),
        el("p", {}, shortText(check.status || "needs_source", 80)),
      ))) : null,
      titledItems(artifact.angles_discovered),
    ].filter(Boolean);
  }
  if (name === "script") {
    const first = (artifact.sections || [])[0];
    return [
      reviewFacts([
        reviewFact("duration", fmtDuration(artifact.total_duration_seconds)),
        reviewFact("sections", (artifact.sections || []).length),
      ]),
      first && first.text ? el("p", { class: "approval-lead" }, shortText(first.text, 220)) : null,
      el("p", { class: "approval-guidance" }, "下方可以查看完整脚本。"),
    ].filter(Boolean);
  }
  if (name === "scene_plan") {
    const scenes = artifact.scenes || [];
    const end = scenes.reduce((max, scene) => Math.max(max, Number(scene.end_seconds) || 0), 0);
    return [
      reviewFacts([
        reviewFact("scenes", scenes.length),
        reviewFact("duration", end ? fmtDuration(end) : null),
      ]),
      titledItems(scenes),
      el("p", { class: "approval-guidance" }, "请在下方分镜记录中核对时长与画面覆盖。"),
    ].filter(Boolean);
  }
  if (name === "asset_manifest") {
    const assets = artifact.assets || [];
    const types = [...new Set(assets.map((asset) => asset.type).filter(Boolean))];
    return [
      reviewFacts([
        reviewFact("assets", assets.length),
        reviewFact("types", types.join(", ")),
        reviewFact("generation cost", artifact.total_cost_usd != null ? fmtMoney(artifact.total_cost_usd) : null),
      ]),
      titledItems(assets),
      el("p", { class: "approval-guidance" }, "合成前，请逐一检查下方的素材版本。"),
    ].filter(Boolean);
  }
  if (name === "edit_decisions") {
    return [
      reviewFacts([
        reviewFact("cuts", Array.isArray(artifact.cuts) ? artifact.cuts.length : null),
        reviewFact("runtime", artifact.render_runtime || (artifact.metadata || {}).render_runtime),
      ]),
      titledItems(artifact.cuts),
    ].filter(Boolean);
  }
  if (name === "render_report") {
    return [
      reviewFacts([
        reviewFact("outputs", Array.isArray(artifact.outputs) ? artifact.outputs.length : null),
        reviewFact("duration", artifact.duration_seconds != null ? fmtDuration(artifact.duration_seconds) : null),
      ]),
      titledItems(artifact.outputs),
    ].filter(Boolean);
  }
  if (name === "publish_log") {
    return [
      reviewFacts([reviewFact("destinations", Array.isArray(artifact.entries) ? artifact.entries.length : null)]),
      titledItems((artifact.entries || []).map((entry) => ({
        title: entry.platform || entry.destination || "Publish destination",
        description: [entry.status, entry.url].filter(Boolean).join(" · "),
      }))),
    ].filter(Boolean);
  }
  return genericArtifactSummary(artifact);
}

function artifactReviewTitle(name, artifact, s) {
  if (name === "proposal_packet") {
    const selected = (artifact.selected_concept || {}).concept_id;
    const concept = (artifact.concept_options || []).find((item) => item.id === selected);
    return (concept && concept.title) || "Production proposal";
  }
  if (name === "research_brief") return artifact.topic || "Research brief";
  if (name === "scene_plan") return "分镜计划";
  if (name === "asset_manifest") return "Generated assets";
  if (name === "edit_decisions") return "Edit decisions";
  if (name === "render_report") return "Render report";
  if (name === "publish_log") return "Publish plan";
  return artifact.title || artifact.name || s.title;
}

function renderApprovalReview(s) {
  const awaiting = s.stages.find((item) => item.status === "awaiting_human");
  if (!awaiting) return null;

  const names = artifactNamesForStage(awaiting);
  const entries = names
    .filter((name) => name !== "decision_log")
    .map((name) => [name, s.artifacts[name]])
    .filter(([, artifact]) => artifact && typeof artifact === "object");
  const stageIndex = s.stages.findIndex((item) => item.name === awaiting.name);
  const nextStage = stageIndex >= 0 ? s.stages[stageIndex + 1] : null;
  const review = awaiting.review || {};
  const reviewSummary = reviewSummaryText(review);

  const artifacts = entries.map(([name, artifact]) => el("article", {
    class: "approval-artifact",
    "data-artifact": name,
  },
    el("div", { class: "approval-artifact-kicker" }, humanize(name)),
    el("h2", {}, artifactReviewTitle(name, artifact, s)),
    ...artifactReviewContent(name, artifact),
  ));

  if (!artifacts.length) {
    artifacts.push(el("div", { class: "approval-missing", role: "alert" },
      el("b", {}, "暂未找到可供审核的内容。 "),
      names.length
        ? `${resumeStageLabel(awaiting.name)}关联的 ${names.map(humanize).join("、")} 暂未加载。`
        : `${resumeStageLabel(awaiting.name)}还没有关联审核文件。`,
    ));
  }

  return el("section", { class: "approval-review", "data-stage": awaiting.name },
    el("div", { class: "approval-review-head" },
      el("div", {},
        el("div", { class: "approval-eyebrow" }, "待确认内容"),
        el("h2", {}, `${resumeStageLabel(awaiting.name)}已准备好`),
        el("p", {}, "这里保存了当前审核内容。返回工作台继续；外部工具创建的任务，请在原工具中确认。"),
      ),
      el("span", { class: "approval-status" }, "等待确认"),
    ),
    reviewSummary ? el("div", { class: "approval-review-note" },
      el("b", {}, "检查记录  "), shortText(reviewSummary, 260)) : null,
    el("div", { class: "approval-artifacts" }, artifacts),
    el("div", { class: "approval-review-foot" },
      el("span", {}, nextStage
        ? `确认后可继续${resumeStageLabel(nextStage.name)}。`
        : "这是最后一个确认环节。"),
      el("button", { type: "button", onclick: () => toggleDrawer(awaiting.name) }, "查看完整记录"),
    ),
  );
}

function openScriptModal() {
  const script = state && state.artifacts.script;
  if (!script) return;
  modal.innerHTML = "";
  modal.append(
    el("span", { class: "modal-close", onclick: closeModal }, "Esc · 关闭"),
    el("div", { class: "modal-page" },
      el("div", { class: "script-card", style: "cursor:default" },
        el("div", { class: "sp-title" }, script.title || state.title),
        el("div", { class: "sp-meta" },
          `脚本 · ${fmtDuration(script.total_duration_seconds)} · ${(script.sections || []).length} 段`),
        ...scriptSections(script, 0),
        el("div", { class: "sp-fade" }, "END"),
      )),
  );
  modal.classList.add("open");
}

function openNarrModal(card) {
  modal.innerHTML = "";
  const meta = [sceneLabel(card.id), card.section_label, fmtDuration(card.duration_seconds)]
    .filter(Boolean).join(" · ");
  modal.append(
    el("span", { class: "modal-close", onclick: closeModal }, "Esc · 关闭"),
    el("div", { class: "modal-page" },
      el("div", { class: "script-card", style: "cursor:default" },
        el("div", { class: "sp-meta" }, meta),
        card.narration ? el("div", { class: "sp-action", style: "margin-left:0" }, card.narration) : null,
        card.shot_intent ? el("div", { class: "sp-paren", style: "margin-left:0" }, `Intent — ${card.shot_intent}`) : null,
        card.description ? el("div", { class: "sp-paren", style: "margin-left:0" }, card.description) : null,
      )),
  );
  modal.classList.add("open");
}

function closeModal() { modal.classList.remove("open"); }
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

// ---------------------------------------------------------------------------
// right rail: decisions, activity
// ---------------------------------------------------------------------------

function renderDecisions(s) {
  const log = s.artifacts.decision_log;
  const decisions = (log && log.decisions) || [];
  if (!decisions.length) return null;
  const body = el("div", { class: "panel-body" });
  // Collapse by category+subject: a decision that changed mid-run (e.g. voice
  // openai_onyx → chirp3) is superseded by the later entry — show the CURRENT
  // choice, not the first one recorded, and mark that it was revised.
  const current = new Map();
  decisions.forEach((d, i) => {
    const key = `${d.category || "decision"}::${d.subject || ""}`;
    const prev = current.get(key);
    current.set(key, { d, order: i, revised: prev ? prev.revised + 1 : 0 });
  });
  const shown = [...current.values()].sort((a, b) => b.order - a.order).slice(0, 8);
  for (const { d, revised } of shown) {
    const selLabel = (() => {
      // Prefer the human label of the selected option over its bare id.
      const opt = (d.options_considered || []).find((o) => (o.option_id ?? o.label) === d.selected);
      return (opt && opt.label) || d.selected || "";
    })();
    const alts = (d.options_considered || [])
      .filter((o) => (o.option_id ?? o.label) !== d.selected && (o.option_id || o.label));
    body.append(el("div", { class: "decision" },
      el("div", { class: "d-cat" }, `${d.category || "decision"}${d.confidence ? ` · ${d.confidence}` : ""}`,
        revised ? el("span", { class: "d-revised" }, " · revised") : null),
      el("div", { class: "d-pick" }, `${d.subject || ""} `, el("span", { class: "arrow" }, "→"), ` ${selLabel}`),
      d.reason ? el("div", { class: "d-why" }, d.reason) : null,
      alts.length ? el("div", { class: "d-alt" }, "also considered: ",
        alts.slice(0, 3).map((o, i) => [i ? " · " : "", el("s", {}, o.label || o.option_id)]).flat()) : null,
    ));
  }
  return el("div", { class: "panel" },
    el("div", { class: "panel-head" }, el("h2", {}, "创作决策"), el("span", { class: "meta" }, "decision_log.json")),
    body);
}

function activityStage(ev, s) {
  const stageNames = new Set((s.stages || []).map((stage) => stage.name));
  const metadata = ev && ev.metadata && typeof ev.metadata === "object" ? ev.metadata : {};
  const explicit = [ev?.stage, ev?.stage_name, metadata.stage, metadata.stage_name]
    .map((value) => String(value || "").trim())
    .find((value) => value && stageNames.has(value));
  if (explicit) return explicit;

  // A few legacy events only carry the tool name.  Use conservative aliases;
  // never guess an arbitrary stage from a scene id, because that can send a
  // creator to the wrong production page.
  const tool = String(ev?.tool || "").toLowerCase();
  const aliases = [
    ["proposal", ["proposal", "creative", "candidate"]],
    ["script", ["script", "story"]],
    ["scene_plan", ["scene_plan", "storyboard"]],
    ["assets", ["asset", "image", "video", "seedance", "stock"]],
    ["edit", ["edit", "trim", "subtitle", "transcri", "audio"]],
    ["compose", ["compose", "remotion", "hyperframe", "ffmpeg"]],
    ["publish", ["publish", "export"]],
  ];
  for (const [stage, terms] of aliases) {
    if (stageNames.has(stage) && terms.some((term) => tool.includes(term))) return stage;
  }
  return null;
}

function renderActivity(s) {
  const events = s.events || [];
  if (!events.length) return null;
  const body = el("div", { class: "panel-body" });
  // A start is "running" only until a later finish/error for the same
  // tool+scene closes it — closed starts are dropped (the finish row tells
  // the story), unmatched starts render as live. Counted (not keyed-single)
  // so parallel runs of the same tool on the same scene stay visible.
  const open = new Map(); // key -> {count, ev}
  const rows = [];
  for (const ev of events) {
    const key = `${ev.tool}:${ev.scene_id || ""}`;
    if (ev.event === "start") {
      const slot = open.get(key) || { count: 0, ev };
      slot.count += 1;
      slot.ev = ev;
      open.set(key, slot);
    } else {
      const slot = open.get(key);
      if (slot) {
        slot.count -= 1;
        if (slot.count <= 0) open.delete(key);
      }
      rows.push(ev);
    }
  }
  for (const slot of open.values()) rows.push(slot.ev);
  rows.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  for (const ev of rows.slice(-10).reverse()) {
    let statusEl;
    if (ev.event === "finish") {
      statusEl = el("span", { class: `status ${ev.success === false ? "err" : "ok"}` },
        `${ev.success === false ? "✕" : "✓"}${ev.duration_s != null ? ` ${ev.duration_s.toFixed ? ev.duration_s.toFixed(1) : ev.duration_s}s` : ""}${ev.cost_usd ? ` ${fmtMoney(ev.cost_usd)}` : ""}`);
    } else if (ev.event === "error") {
      statusEl = el("span", { class: "status err" }, "✕");
    } else {
      statusEl = el("span", { class: "status run" }, "● running");
    }
    const stage = activityStage(ev, s);
    const row = el(stage ? "a" : "div", {
      class: `act-row${stage ? " act-link" : ""}`,
      href: stage ? stageURL(stage) : null,
      title: stage ? `打开 ${stage} 制作环节` : null,
      "data-stage": stage,
      onclick: stage ? (event) => {
        event.preventDefault();
        focusStage(stage);
      } : null,
    },
      el("span", { class: "t" }, fmtClock(ev.ts)),
      el("span", { class: "tool" }, ev.tool || ""),
      el("span", { class: "target" }, ev.scene_id || ""),
      statusEl,
    );
    body.append(row);
  }
  return el("div", { class: "panel" },
    el("div", { class: "panel-head" }, el("h2", {}, "操作记录"), el("span", { class: "meta" }, "events.jsonl")),
    body);
}

// ---------------------------------------------------------------------------
// storyboard filmstrip
// ---------------------------------------------------------------------------

function sceneLabel(id) {
  // "sc4" → "SC 04", "scene-11" → "SC 11", anything else → uppercased id
  const m = String(id).match(/(\d+)\s*$/);
  if (m) return `SC ${m[1].padStart(2, "0")}`;
  return String(id).toUpperCase().slice(0, 10);
}

function sceneCard(s, card) {
  const dur = card.duration_seconds;
  const width = Math.max(132, Math.min(300, 70 + (dur || 3) * 26));
  const wrap = el("div", { class: "scene-card", style: `width:${width}px` });

  const slate = el("div", { class: "sc-slate" },
    el("span", { class: "num" }, sceneLabel(card.id)),
    card.takes.length > 1 ? el("span", { class: "take" }, `T${card.takes.length}`) : null,
    card.hero_moment ? el("span", { class: "hero" }, "★ HERO") : null,
    el("span", { class: "dur" }, fmtDuration(dur)),
  );
  wrap.append(slate);

  // visual slot
  let thumb;
  if (card.generating) {
    thumb = el("div", { class: "thumb generating" },
      el("div", { class: "shimmer" }),
      el("div", { class: "gen-label" },
        el("span", {}, "◉ GENERATING"),
        el("span", { class: "sub" }, card.generating_tool || "")));
  } else if (card.visual && card.visual.exists) {
    const v = card.visual;
    const badge = [v.model || v.source_tool, v.cost_usd != null ? fmtMoney(v.cost_usd) : null,
      v.quality_score != null ? `q ${v.quality_score}` : null].filter(Boolean).join(" · ");
    if (v.type === "video") {
      thumb = el("div", { class: "thumb approved" },
        // Ask the same-origin thumbnail endpoint for a cached first frame.
        // Without a poster, Chromium paints an empty surface while video
        // metadata is loading, which looks like a missing storyboard asset.
        el("video", {
          src: mediaURL(s.project_id, v.path),
          poster: thumbURL(s.project_id, v.path, 640),
          muted: "", preload: "metadata", playsinline: "",
        }),
        el("span", { class: "play" }, "▶"),
        badge ? el("span", { class: "badge" }, badge) : null);
      thumb.onclick = () => {
        const vid = thumb.querySelector("video");
        if (vid.paused) vid.play(); else vid.pause();
      };
    } else {
      const img = el("img", { src: thumbURL(s.project_id, v.path, 640), loading: "lazy", alt: "" });
      // A thumbnail that fails to load must never show a broken-image icon —
      // fall back to the shot spec in place (F: broken links).
      img.onerror = () => {
        const t = img.closest(".thumb");
        if (!t) return;
        t.className = "thumb spec";
        t.innerHTML = "";
        t.append(el("div", { class: "spec-in" },
          el("div", { class: "spec-desc" }, card.description || "asset unavailable"),
          el("div", { class: "spec-shot" }, [card.framing, card.movement].filter(Boolean).join(" · ").slice(0, 70))));
      };
      thumb = el("div", { class: "thumb approved" }, img,
        v.snapshot ? el("span", { class: "badge" }, "snapshot") : (badge ? el("span", { class: "badge" }, badge) : null));
    }
  } else if (card.type === "animation") {
    // Bespoke/atelier scene with no snapshot yet — name it as such rather
    // than "尚未关联素材" (the composition IS the asset).
    thumb = el("div", { class: "thumb spec bespoke" },
      el("div", { class: "spec-in" },
        el("span", { class: "bespoke-tag" }, "◆ BESPOKE"),
        el("div", { class: "spec-desc" }, card.description || ""),
        el("div", { class: "spec-shot" }, "hand-authored composition")));
  } else if (card.visual && !card.visual.exists) {
    thumb = el("div", { class: "thumb missing" },
      el("div", { class: "spec-in" },
        el("span", { class: "warn-ic" }, "⚑"),
        el("div", { class: "spec-desc" }, "asset in manifest, file missing"),
        el("div", { class: "spec-shot" }, card.visual.path || "")));
  } else if (card.type === "text_card") {
    thumb = el("div", { class: "thumb textcard" },
      el("div", { class: "tc-copy" }, (card.narration || card.description || "").slice(0, 48)));
  } else if (card.required_assets.length) {
    thumb = el("div", { class: "thumb missing" },
      el("div", { class: "spec-in" },
        el("span", { class: "warn-ic" }, "⚑"),
        el("div", { class: "spec-desc" }, "尚未关联素材"),
        el("div", { class: "spec-shot" }, (card.required_assets[0].description || "").slice(0, 60))));
  } else {
    thumb = el("div", { class: "thumb spec" },
      el("div", { class: "spec-in" },
        el("div", { class: "spec-desc" }, card.description || ""),
        el("div", { class: "spec-shot" }, [card.framing, card.movement].filter(Boolean).join(" · ").slice(0, 70))));
  }
  wrap.append(thumb);

  // shot language chips
  const sl = card.shot_language;
  if (sl) {
    wrap.append(el("div", { class: "shotchips", style: "display:flex;flex-wrap:wrap;gap:4px;padding:7px 2px 0" },
      [sl.shot_size, sl.camera_movement, sl.lens_mm ? `${sl.lens_mm}mm` : null, sl.lighting_key]
        .filter(Boolean)
        .map((t) => el("span", { style: "font-family:var(--mono);font-size:calc(8.5px * var(--fs-scale));letter-spacing:.04em;color:#62626c;border:1px solid #212129;border-radius:3px;padding:1px 5px" }, String(t).replaceAll("_", " ")))));
  }

  // takes drawer
  if (card.takes.length > 1) {
    const takes = el("div", { class: "takes" });
    card.takes.forEach((t, i) => {
      const isActive = card.visual && (
        t === card.visual
        || (t.path && t.path === card.visual.path)
        || (t.id && t.id === card.visual.id)
      );
      const tk = el("span", { class: `tk${isActive ? " active" : ""}`, title: `take ${i + 1}` });
      if (t.exists && t.type === "image") tk.append(el("img", { src: thumbURL(s.project_id, t.path, 320), loading: "lazy", alt: "" }));
      takes.append(tk);
    });
    takes.append(el("span", { class: "tk-label" }, `${card.takes.length} TAKES`));
    wrap.append(takes);
  }

  // narration + audio — clickable to read in full (F: narration text cut off)
  if (card.narration) {
    const long = card.narration.length > 90;
    wrap.append(el("div", {
      class: `narr${long ? " clip" : ""}`,
      title: "阅读完整旁白",
      onclick: () => openNarrModal(card),
    }, card.narration, long ? el("span", { class: "narr-more" }, "⤢") : null));
  } else if (card.shot_intent || card.description) {
    wrap.append(el("div", { class: "narr tc-note" }, (card.shot_intent || card.description || "").slice(0, 110)));
  }
  const narrAudio = card.audio.find((a) => a.exists && (a.type === "narration" || a.type === "audio"));
  if (narrAudio) {
    const wave = el("div", { class: "wave", style: "cursor:pointer", title: "Play narration" });
    waveBars(wave, card.id + narrAudio.path);
    wave.append(el("span", { class: "wv-time" }, narrAudio.duration_seconds ? fmtDuration(narrAudio.duration_seconds) : "♪"));
    wave.onclick = () => {
      player.src = mediaURL(s.project_id, narrAudio.path);
      player.play();
    };
    wrap.append(wave);
  }
  return wrap;
}

function renderStoryboard(s) {
  const board = s.storyboard;
  if (!board) return null;
  const strip = el("div", { class: "filmstrip" });
  for (const card of board.scenes) strip.append(sceneCard(s, card));
  return el("div", {},
    el("div", { class: "section-title" }, "分镜记录",
      el("span", { class: "meta" },
        `${board.scenes.length} 个镜头${board.total_duration_seconds ? ` · ${fmtDuration(board.total_duration_seconds)}` : ""} · 卡片宽度对应时长`)),
    el("div", { class: "strip-outer" }, strip));
}

// ---------------------------------------------------------------------------
// renders + degraded media
// ---------------------------------------------------------------------------

function renderRenders(s) {
  const renders = s.media.renders;
  if (!renders.length) return null;
  if (activeRender >= renders.length) activeRender = 0;
  const current = renders[activeRender];
  // Full re-renders (every SSE refresh) must not reset an in-progress
  // watch: carry playback position/state over to the recreated element.
  const prev = document.querySelector(".render-hero video");
  const src = mediaURL(s.project_id, current.path);
  // preload="metadata" gives the element its intrinsic aspect ratio (and a
  // poster frame) before playback — without it a portrait 9:16 render sits
  // in a letterboxed 100%-wide black box that reads as landscape.
  const video = el("video", { src, controls: "", preload: "metadata" });
  // Click the frame to start playback (controls handle pause/scrub) — the
  // big player was inert to a click on the picture itself.
  video.addEventListener("click", () => { if (video.paused) video.play().catch(() => {}); });
  if (prev && prev.getAttribute("src") === src && (prev.currentTime > 0 || !prev.paused)) {
    const t = prev.currentTime;
    const wasPlaying = !prev.paused && !prev.ended;
    video.addEventListener("loadedmetadata", () => { video.currentTime = t; }, { once: true });
    video.setAttribute("preload", "metadata");
    if (wasPlaying) video.autoplay = true;
  }
  const versions = el("div", { class: "render-meta" },
    renders.map((r, i) => el("span", {
      class: `v${i === activeRender ? " active" : ""}`,
      onclick: () => { activeRender = i; render(); },
    }, `${r.path.split("/").pop()}${r.at_root ? " · root" : ""}`)),
    el("span", { style: "margin-left:auto" }, `${(current.size / 1048576).toFixed(1)} MB`),
  );
  return el("div", {},
    el("div", { class: "section-title" }, "成片版本",
      el("span", { class: "meta" }, `${renders.length} 个版本`)),
    el("div", { class: "render-hero" }, video),
    versions);
}

function renderFoundMedia(s) {
  // Degraded view: show discovered snapshots when there's no storyboard.
  if (s.storyboard || !s.media.snapshots.length) return null;
  const grid = el("div", { class: "found-grid" });
  for (const snap of s.media.snapshots.slice(0, 12)) {
    grid.append(el("div", { class: "thumb" },
      el("img", { src: thumbURL(s.project_id, snap.path, 640), loading: "lazy", alt: "" })));
  }
  return el("div", {},
    el("div", { class: "section-title" }, "What the watcher found",
      el("span", { class: "meta" }, "snapshots / verification frames")),
    grid);
}

function mediaFileSize(item) {
  const bytes = Number(item?.size);
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function renderMediaShelf(s) {
  const stock = Array.isArray(s.media.stock) ? s.media.stock : [];
  const trimmed = Array.isArray(s.media.trimmed) ? s.media.trimmed : [];
  const audio = Array.isArray(s.media.audio) ? s.media.audio : [];
  const music = Array.isArray(s.media.music) ? s.media.music : [];
  const subtitles = Array.isArray(s.media.subtitles) ? s.media.subtitles : [];
  const analysis = s.media.analysis && typeof s.media.analysis === "object" ? s.media.analysis : {};
  const analysisFrames = Array.isArray(analysis.frames) ? analysis.frames : [];
  const faceTrackingReports = Array.isArray(analysis.face_tracking) ? analysis.face_tracking : [];
  if (!stock.length && !trimmed.length && !audio.length && !music.length && !subtitles.length
      && !analysisFrames.length && !faceTrackingReports.length) return null;

  const shelf = el("div", { class: "media-shelf" });
  const addAudio = (item, label, kind) => {
    const path = item?.path;
    if (!path) return;
    const card = el("article", { class: "media-track" },
      el("div", { class: "media-track-head" },
        el("b", {}, label),
        el("span", { class: "meta" }, mediaFileSize(item))),
      el("div", { class: "media-track-path" }, path),
      el("audio", { controls: "", preload: "metadata", src: mediaURL(s.project_id, path), "aria-label": `${label} ${path}` }),
      el("a", { class: "media-track-link", href: mediaURL(s.project_id, path), target: "_blank", rel: "noreferrer", download: "" }, `打开/下载 ${kind}`),
    );
    shelf.append(card);
  };
  const addSubtitle = (item) => {
    const path = item?.path;
    if (!path) return;
    shelf.append(el("article", { class: "media-track subtitle-track" },
      el("div", { class: "media-track-head" }, el("b", {}, "字幕文件"), el("span", { class: "meta" }, mediaFileSize(item))),
      el("div", { class: "media-track-path" }, path),
      el("a", { class: "media-track-link", href: mediaURL(s.project_id, path), target: "_blank", rel: "noreferrer", download: "" }, "打开/下载字幕"),
    ));
  };
  const addAnalysisFrame = (item, index) => {
    const path = item?.path;
    if (!path) return;
    const timestamp = Number(item?.timestamp_seconds);
    const suffix = Number.isFinite(timestamp) ? ` · ${timestamp.toFixed(1)}s` : "";
    shelf.append(el("article", { class: "media-track analysis-frame-track" },
      el("div", { class: "media-track-head" },
        el("b", {}, `分析关键帧 ${index + 1}${suffix}`),
        el("span", { class: "meta" }, mediaFileSize(item))),
      el("div", { class: "media-track-path" }, path),
      el("img", {
        class: "media-analysis-thumb",
        src: thumbURL(s.project_id, path, 640),
        loading: "lazy",
        alt: `分析关键帧 ${index + 1}`,
      }),
      el("a", { class: "media-track-link", href: mediaURL(s.project_id, path), target: "_blank", rel: "noreferrer", download: "" }, "打开/下载关键帧"),
    ));
  };
  const addFaceTrackingReport = (item, index) => {
    const path = item?.path;
    if (!path) return;
    shelf.append(el("article", { class: "media-track analysis-report-track" },
      el("div", { class: "media-track-head" },
        el("b", {}, `主体追踪报告 ${index + 1}`),
        el("span", { class: "meta" }, mediaFileSize(item))),
      el("div", { class: "media-track-path" }, path),
      el("p", { class: "media-analysis-note" }, "JSON 报告：可用于自动构图、人物连续性和后续质检。"),
      el("a", { class: "media-track-link", href: mediaURL(s.project_id, path), target: "_blank", rel: "noreferrer", download: "" }, "打开/下载追踪报告"),
    ));
  };
  analysisFrames.slice(0, 48).forEach(addAnalysisFrame);
  faceTrackingReports.slice(0, 12).forEach(addFaceTrackingReport);
  stock.slice(0, 24).forEach((item, index) => {
    const path = item?.path;
    if (!path) return;
    const card = el("article", { class: "media-track stock-track" },
      el("div", { class: "media-track-head" },
        el("b", {}, `素材候选 ${index + 1}`),
        el("span", { class: "meta" }, item.type === "image" ? "图片" : mediaFileSize(item))),
      el("div", { class: "media-track-path" }, path),
      item.type === "image"
        ? el("img", { class: "media-stock-thumb", src: thumbURL(s.project_id, path, 480), loading: "lazy", alt: "" })
        : el("video", { controls: "", preload: "metadata", src: mediaURL(s.project_id, path), "aria-label": `素材候选 ${path}` }),
      el("a", { class: "media-track-link", href: mediaURL(s.project_id, path), target: "_blank", rel: "noreferrer", download: "" }, "打开/下载素材"),
    );
    shelf.append(card);
  });
  trimmed.slice(0, 24).forEach((item, index) => {
    const path = item?.path;
    if (!path) return;
    shelf.append(el("article", { class: "media-track trimmed-track" },
      el("div", { class: "media-track-head" },
        el("b", {}, `已裁剪片段 ${index + 1}`),
        el("span", { class: "meta" }, mediaFileSize(item))),
      el("div", { class: "media-track-path" }, path),
      el("video", { controls: "", preload: "metadata", src: mediaURL(s.project_id, path), "aria-label": `已裁剪片段 ${path}` }),
      el("a", { class: "media-track-link", href: mediaURL(s.project_id, path), target: "_blank", rel: "noreferrer", download: "" }, "打开/下载片段"),
    ));
  });
  audio.forEach((item) => addAudio(item, "旁白 / 音效", "音频"));
  music.forEach((item) => addAudio(item, "BGM / 配乐", "音乐"));
  subtitles.forEach(addSubtitle);
  return el("div", {},
    el("div", { class: "section-title" }, "项目素材",
      el("span", { class: "meta" }, `${stock.length} 份候选 · ${trimmed.length} 段剪辑 · ${audio.length} 条音频 · ${music.length} 首配乐 · ${subtitles.length} 份字幕 · ${analysisFrames.length} 张分析帧 · ${faceTrackingReports.length} 份追踪记录`)),
    shelf);
}

function renderNoState(s) {
  if (s.has_pipeline_state) return null;
  return el("div", { class: "notice", style: "border-color:#2b2b33;background:var(--surface-2);color:var(--text-3)" },
    el("span", { style: "font-size:calc(15px * var(--fs-scale))" }, "◌"),
    el("span", {},
      el("b", { style: "color:var(--text-2)" }, "尚无阶段记录。 "),
      "这里先展示本机已有的素材和成片。 ",
      "后续保存制作阶段后，可以查看完整过程。"));
}

function renderAwaitingNotice(s) {
  const awaiting = s.stages.find((x) => x.status === "awaiting_human");
  if (!awaiting) return null;
  return el("div", { class: "notice" },
    el("span", { style: "font-size:calc(16px * var(--fs-scale))" }, "◈"),
    el("span", {},
      el("b", {}, `${resumeStageLabel(awaiting.name)}等待确认。 `),
      el("a", { href: modelResumeURL(awaiting.name) }, "返回工作台继续"), "；外部工具创建的任务，请在原工具中确认。"));
}

// ---------------------------------------------------------------------------
// replay — scrub a completed run from its timestamps
// ---------------------------------------------------------------------------

// Python writers emit tz-aware UTC isoformat, but treat tz-naive strings as
// UTC too — mixing local-parsed and UTC-parsed timestamps would skew replay
// ordering by the user's UTC offset.
const ts = (iso) => {
  if (!iso) return null;
  let s = String(iso);
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) s += "Z";
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
};

function replayTimelinePoints(s) {
  // Newer servers expose semantic frames (multiple writes at one instant
  // merged into one visible state).  Keep timeline as a compatibility alias
  // for older boards, but prefer the explicit frames field when present.
  const persisted = replayEvidence?.frames || replayEvidence?.semantic_frames || replayEvidence?.timeline;
  let points;
  if (Array.isArray(persisted) && persisted.length) {
    points = persisted.map((item) => ({ ...item, _t: ts(item.timestamp) }))
      .filter((item) => item._t != null)
      .sort((a, b) => a._t - b._t);
  } else {
    points = [];
    for (const st of s.stages) {
      for (const h of st.history_entries || []) {
        const t = ts(h.timestamp);
        if (t != null) points.push({ timestamp: h.timestamp, kind: "stage", stage: st.name, status: h.status, _t: t });
      }
    }
    for (const ev of s.events || []) {
      const t = ts(ev.ts);
      if (t != null) points.push({ ...ev, timestamp: ev.ts, kind: "event", _t: t });
    }
    points.sort((a, b) => a._t - b._t);
  }
  // Several checkpoint/event records can share one timestamp.  They produce
  // one visible state, so collapse them to one replay boundary; otherwise a
  // single browser tick can rebuild the whole board many times and flicker.
  const collapsed = [];
  for (const point of points) {
    const previous = collapsed[collapsed.length - 1];
    if (previous && previous._t === point._t) {
      collapsed[collapsed.length - 1] = point;
    } else {
      collapsed.push(point);
    }
  }
  return collapsed;
}

function replayBounds(s) {
  const points = replayTimelinePoints(s);
  const moments = points.map((point) => point._t).filter((t) => t != null);
  if (moments.length < 2) return null;
  return { t0: Math.min(...moments), t1: Math.max(...moments) };
}

function replayPointLabel(t, sourcePoints = null) {
  const points = sourcePoints || replay?.points || replayTimelinePoints(state || { stages: [], events: [] });
  let point = null;
  for (const candidate of points) {
    if (candidate._t <= t) point = candidate;
    else break;
  }
  if (!point) return "准备回放";
  if (point.label) return String(point.label);
  const first = Array.isArray(point.items) && point.items.length ? point.items[0] : point;
  const subject = first.stage || first.tool || point.stage || point.tool || "制作";
  const event = first.event || first.status || point.event || point.status || "更新";
  const extra = Array.isArray(point.items) && point.items.length > 1
    ? ` · ${point.items.length} 条记录` : "";
  return `${subject} · ${event}${extra}`;
}

function replayPointStage(point) {
  if (!point) return "";
  if (point.stage) return String(point.stage);
  const items = Array.isArray(point.items) ? point.items : [];
  return String(items.find((item) => item?.stage)?.stage || "");
}

function replayPointIndex(t, sourcePoints = null) {
  const points = sourcePoints || replay?.points || replayTimelinePoints(state || { stages: [], events: [] });
  let low = 0;
  let high = points.length - 1;
  let result = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle]._t <= t) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result;
}

function replayClock(t) {
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// Keep the transport controls alive while replaying.  Updating their text and
// range value in place avoids replacing inputs, media elements, and focused
// controls on every 100ms heartbeat.
function updateReplayControls() {
  if (!replay) return;
  const toggle = document.querySelector("[data-replay-toggle]");
  if (toggle) {
    toggle.textContent = replay.playing ? "❚❚" : "▶";
    toggle.setAttribute("aria-label", replay.playing ? "暂停回放" : "继续回放");
    toggle.setAttribute("title", replay.playing ? "暂停回放" : "继续回放");
  }
  const range = document.querySelector("[data-replay-range]");
  if (range && document.activeElement !== range) {
    const pos = (replay.t - replay.t0) / Math.max(1, replay.t1 - replay.t0);
    range.value = String(Math.round(pos * 1000));
  }
  const point = document.querySelector("[data-replay-point]");
  if (point) point.textContent = replayPointLabel(replay.t, replay.points);
  const time = document.querySelector("[data-replay-time]");
  if (time) time.textContent = replayClock(replay.t);
  const pointIndex = replayPointIndex(replay.t, replay.points);
  const count = document.querySelector("[data-replay-count]");
  if (count) count.textContent = `${Math.max(0, pointIndex + 1)} / ${replay.points.length}`;
  const previous = document.querySelector("[data-replay-prev]");
  const next = document.querySelector("[data-replay-next]");
  if (previous) previous.disabled = pointIndex <= 0;
  if (next) next.disabled = pointIndex < 0 || pointIndex >= replay.points.length - 1;
  const stage = replayPointStage(replay.points[pointIndex]);
  const stageLink = document.querySelector("[data-replay-stage-link]");
  if (stageLink) {
    stageLink.hidden = !stage;
    if (stage) {
      stageLink.href = modelResumeURL(stage);
      stageLink.title = `打开${resumeStageLabel(stage)}工作台`;
      stageLink.textContent = `打开${resumeStageLabel(stage)}`;
    }
  }
}

function stateAt(s, T) {
  const view = structuredClone(s);
  for (const st of view.stages) {
    const past = (st.history_entries || []).filter((h) => ts(h.timestamp) != null && ts(h.timestamp) <= T);
    past.sort((a, b) => ts(a.timestamp) - ts(b.timestamp));
    if (!past.length) {
      st.status = "pending"; st.review = null; st.timestamp = null;
      st.gate_skipped = false; st.human_approved = false; st.partial_progress = null;
    } else {
      const cur = past[past.length - 1];
      st.status = cur.status || "pending";
      st.timestamp = cur.timestamp;
      // Historical checkpoints do not carry the live review/progress objects;
      // never let today's gate evidence leak into an earlier replay frame.
      st.review = null;
      st.gate_skipped = false;
      st.human_approved = false;
      st.partial_progress = null;
    }
  }
  view.events = (view.events || [])
    .filter((ev) => ts(ev.ts) != null && ts(ev.ts) <= T)
    .sort((a, b) => ts(a.ts) - ts(b.ts));

  // Storyboard: visuals appear as their scene finishes (events) or when the
  // assets stage has completed as of T (legacy runs without events).
  if (view.storyboard) {
    const assetsStage = view.stages.find((x) => x.name === "assets");
    const assetsDone = assetsStage && assetsStage.status === "completed";
    const finished = new Set();
    const startedNow = new Map();
    for (const ev of view.events) {
      if (!ev.scene_id) continue;
      if (ev.event === "finish") { finished.add(ev.scene_id); startedNow.delete(ev.scene_id); }
      else if (ev.event === "start") startedNow.set(ev.scene_id, ev);
      else if (ev.event === "error") startedNow.delete(ev.scene_id);
    }
    const scenePlanStage = view.stages.find((x) => x.name === "scene_plan");
    const scenePlanDone = scenePlanStage && ["completed", "awaiting_human"].includes(scenePlanStage.status);
    if (!scenePlanDone) {
      view.storyboard = null;
    } else {
      for (const card of view.storyboard.scenes) {
        const visible = assetsDone || finished.has(card.id);
        if (!visible) { card.visual = null; card.takes = []; card.audio = []; }
        card.generating = startedNow.has(card.id);
        card.generating_tool = (startedNow.get(card.id) || {}).tool;
      }
    }
  }
  // Final artifacts hide until their stage happened — for every project
  // shape, storyboard or not (a degraded run must not show the finished
  // movie before its stages ran).
  const scriptStage = view.stages.find((x) => x.name === "script");
  if (!(scriptStage && ["completed", "awaiting_human"].includes(scriptStage.status))) {
    delete view.artifacts.script;
  }
  const composeStage = view.stages.find((x) => x.name === "compose");
  if (!(composeStage && composeStage.status === "completed")) {
    view.media.renders = [];
  }
  // Artifacts are evidence produced by a stage. During replay, hide evidence
  // for stages that have not reached a terminal checkpoint yet; otherwise the
  // drawer can show today's assets while the rail is still in proposal.
  for (const [stageName, names] of Object.entries(STAGE_ARTIFACTS)) {
    const stage = view.stages.find((item) => item.name === stageName);
    if (!stage || !["completed", "awaiting_human"].includes(stage.status)) {
      for (const name of names) delete view.artifacts[name];
    }
  }
  return view;
}

function renderReplayBar(s) {
  const bounds = replayBounds(s);
  if (!bounds) return null;
  if (!replay) {
    if (replayEvidence?.can_replay === false) return null;
    // collapsed: just the entry button
    return el("div", { class: "replay-bar", style: "justify-content:flex-end" },
      el("span", { class: "rp-time" }, replayEvidence?.frames?.length
        ? `${replayEvidence.frames.length} 个已保存阶段` : "按阶段回放已保存记录"),
      el("button", {
        class: "rp-btn",
        type: "button",
        disabled: replayLoading ? "" : null,
        title: "按时间线回放整个制作过程",
        "aria-label": "回放整个制作过程",
        onclick: startReplay,
      }, replayLoading ? "加载时间线…" : "▶ 回放制作过程"));
  }
  const pos = (replay.t - replay.t0) / Math.max(1, replay.t1 - replay.t0);
  const pointLabel = el("span", { class: "rp-point", "data-replay-point": "true", "aria-live": "polite" }, replayPointLabel(replay.t, replay.points));
  const timeLabel = el("span", { class: "rp-time", "data-replay-time": "true" }, replayClock(replay.t));
  const pointIndex = replayPointIndex(replay.t, replay.points);
  const pointCount = el("span", { class: "rp-count", "data-replay-count": "true" }, `${Math.max(0, pointIndex + 1)} / ${replay.points.length}`);
  const setT = (value) => {
    replay.t = replay.t0 + (Number(value) / 1000) * (replay.t1 - replay.t0);
    replay.lastFrameAt = performance.now();
    updateReplayControls();
  };
  const stage = replayPointStage(replay.points[pointIndex]);
  const stageLink = stage ? el("a", {
    class: "rp-stage-link",
    "data-replay-stage-link": "true",
    href: modelResumeURL(stage),
    title: `打开${resumeStageLabel(stage)}工作台`,
  }, `打开${resumeStageLabel(stage)}`) : null;
  return el("div", { class: "replay-bar" },
    el("button", {
      class: "rp-btn rp-step",
      type: "button",
      "data-replay-prev": "true",
      title: "回到上一个已保存阶段",
      "aria-label": "回到上一个已保存阶段",
      disabled: pointIndex <= 0 ? "" : null,
      onclick: () => stepReplay(-1),
    }, "‹"),
    el("button", {
      class: "rp-btn",
      type: "button",
      "data-replay-toggle": "true",
      title: replay.playing ? "暂停回放" : "继续回放",
      "aria-label": replay.playing ? "暂停回放" : "继续回放",
      onclick: toggleReplayPlay,
    }, replay.playing ? "❚❚" : "▶"),
    el("input", {
      type: "range", min: "0", max: "1000", value: String(Math.round(pos * 1000)), "data-replay-range": "true",
      "aria-label": "回放时间进度",
      title: "拖动查看制作过程中的阶段状态",
      // A full render() would destroy this slider mid-drag: while dragging,
      // only pause + track the time label; re-render the board on release.
      onpointerdown: () => {
        replay.playing = false;
        replay.lastFrameAt = performance.now();
        updateReplayControls();
      },
      oninput: (e) => setT(e.target.value),
      onchange: (e) => {
        setT(e.target.value);
        replay.lastRenderedPoint = replayPointIndex(replay.t, replay.points);
        render();
      },
    }),
    el("button", {
      class: "rp-btn rp-step",
      type: "button",
      "data-replay-next": "true",
      title: "前进到下一个已保存阶段",
      "aria-label": "前进到下一个已保存阶段",
      disabled: pointIndex >= replay.points.length - 1 ? "" : null,
      onclick: () => stepReplay(1),
    }, "›"),
    pointLabel,
    pointCount,
    timeLabel,
    stageLink,
    el("button", {
      class: "rp-btn",
      type: "button",
      title: "退出回放并返回实时状态",
      "aria-label": "退出回放并返回实时状态",
      onclick: stopReplay,
    }, "退出回放"),
  );
}

function stepReplay(delta) {
  if (!replay || !replay.points?.length) return;
  const current = replayPointIndex(replay.t, replay.points);
  let next = current + (Number(delta) < 0 ? -1 : 1);
  if (current < 0) next = Number(delta) < 0 ? 0 : 1;
  next = Math.max(0, Math.min(replay.points.length - 1, next));
  replay.playing = false;
  replay.t = replay.points[next]._t;
  replay.lastFrameAt = performance.now();
  replay.lastRenderedPoint = next;
  render();
  updateReplayControls();
}

let replayTimer = null;

async function startReplay() {
  if (replay || replayLoading) return;
  replayLoading = true;
  render();
  try {
    replayEvidence = await getJSON(`/api/project/${encodedProjectId}/replay`);
  } catch (error) {
    // Local state still contains the same history; the endpoint is an audit
    // enhancement, not a reason to make an existing replay unusable.
    replayEvidence = null;
  }
  // The persisted replay endpoint is authoritative. If it explicitly says
  // the run is not replayable, do not resurrect a misleading local-history
  // replay from raw checkpoint noise.
  if (replayEvidence?.can_replay === false) {
    replayLoading = false;
    render();
    return;
  }
  const points = replayTimelinePoints(state);
  const moments = points.map((point) => point._t).filter((t) => t != null);
  const bounds = moments.length >= 2 ? { t0: Math.min(...moments), t1: Math.max(...moments) } : null;
  if (!bounds) {
    replayLoading = false;
    render();
    return;
  }
  const duration = Math.max(1, bounds.t1 - bounds.t0);
  // Preserve the upstream “scrub the whole run” feel (about 20 seconds),
  // while using a monotonic clock so dropped browser frames never change the
  // end point or make the replay drift.
  const speed = Math.max(1, duration / 20000);
  replay = {
    ...bounds,
    points,
    t: bounds.t0,
    playing: true,
    speed,
    lastRenderedPoint: -1,
    lastFrameAt: performance.now(),
  };
  document.body.classList.add("replaying");
  replayLoading = false;
  scheduleTick();
  render();
  replay.lastRenderedPoint = replayPointIndex(replay.t, replay.points);
  updateReplayControls();
}

function stopReplay() {
  replay = null;
  clearTimeout(replayTimer);
  document.body.classList.remove("replaying");
  render();
}

function toggleReplayPlay() {
  if (!replay) return;
  if (!replay.playing && replay.t >= replay.t1) {
    // Replaying a completed run is repeatable: pressing play at the end
    // starts from its first persisted checkpoint instead of doing nothing.
    replay.t = replay.t0;
    replay.lastRenderedPoint = -1;
  }
  replay.playing = !replay.playing;
  replay.lastFrameAt = performance.now();
  if (replay.playing) scheduleTick();
  render();
}

function scheduleTick() {
  // Single pending tick, ever — rapid pause/play must not stack chains.
  clearTimeout(replayTimer);
  replayTimer = setTimeout(tickReplay, 100);
}

function tickReplay() {
  if (!replay || !replay.playing) return;
  const now = performance.now();
  const elapsed = Math.min(500, Math.max(0, now - (replay.lastFrameAt || now)));
  replay.lastFrameAt = now;
  replay.t = Math.min(replay.t1, replay.t + elapsed * replay.speed);
  if (replay.t >= replay.t1) replay.playing = false;
  const pointIndex = replayPointIndex(replay.t, replay.points);
  // The timeline is continuous, but the board only needs rebuilding when a
  // persisted checkpoint boundary is crossed (or at the final frame).  The
  // slider and labels are updated in place for smooth, flicker-free motion.
  const shouldRender = pointIndex !== replay.lastRenderedPoint || !replay.playing;
  if (shouldRender) {
    replay.lastRenderedPoint = pointIndex;
    render();
  } else {
    updateReplayControls();
  }
  if (replay.playing) scheduleTick();
}

// ---------------------------------------------------------------------------
// page assembly
// ---------------------------------------------------------------------------

function render() {
  if (!state) return;
  const s = replay ? stateAt(state, replay.t) : state;
  const initialPaint = firstPaint;
  // A live event often updates a badge or one activity row while the creator
  // is reading a long script/storyboard.  Rebuilding the DOM must not throw
  // them back to the top; only the first paint is allowed to choose the top.
  const preserveViewport = Boolean(replay) || !initialPaint;
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  document.title = `Backlot — ${s.title}`;
  document.body.classList.toggle("first", firstPaint);
  firstPaint = false;
  app.innerHTML = "";
  app.append(renderSlate(s));
  app.append(renderRail(s));
  const replayBar = renderReplayBar(state);
  if (replayBar) app.append(replayBar);
  const drawer = renderDrawer(s);
  if (drawer) app.append(drawer);
  const awaitingNotice = renderAwaitingNotice(s);
  if (awaitingNotice) app.append(awaitingNotice);
  const noState = renderNoState(s);
  if (noState) app.append(noState);

  const main = el("div", { class: "main-col" });
  const approvalReview = renderApprovalReview(s);
  if (approvalReview) main.append(approvalReview);
  const script = renderScriptCard(s);
  if (script) main.append(script);
  const aside = el("aside", {});
  const decisions = renderDecisions(s);
  const activity = renderActivity(s);
  if (decisions) aside.append(decisions);
  if (activity) aside.append(activity);

  // Media sections live INSIDE the main column so a tall decisions rail
  // never pushes them below the fold — the column flows beside the rail.
  const storyboard = renderStoryboard(s);
  const found = renderFoundMedia(s);
  const renders = renderRenders(s);
  const mediaShelf = renderMediaShelf(s);

  if (approvalReview || script || decisions || activity) {
    for (const section of [storyboard, found, renders, mediaShelf]) {
      if (section) main.append(section);
    }
    const hasAside = Boolean(decisions || activity);
    app.append(el("div", { class: `board${hasAside ? "" : " solo"}` }, main, hasAside ? aside : null));
  } else {
    for (const section of [storyboard, found, renders, mediaShelf]) {
      if (section) app.append(section);
    }
  }
  if (preserveViewport) {
    // Apply after layout so a newly inserted drawer/media card cannot reset
    // the scroll position during style recalculation.
    window.requestAnimationFrame(() => window.scrollTo(scrollX, scrollY));
  }
}

// Defensive normalization (F-02): the server contract guarantees these
// fields, but a sparse/legacy payload must degrade, never crash the board.
function normalize(s) {
  s.pipeline = s.pipeline || { pipeline_type: "unknown", stages: [], known: false };
  s.stages = Array.isArray(s.stages) ? s.stages : [];
  for (const stage of s.stages) {
    stage.produces = Array.isArray(stage.produces) ? stage.produces : [];
  }
  s.artifacts = s.artifacts || {};
  s.media = s.media || {};
  s.media.renders = Array.isArray(s.media.renders) ? s.media.renders : [];
  s.media.stock = Array.isArray(s.media.stock) ? s.media.stock : [];
  s.media.trimmed = Array.isArray(s.media.trimmed) ? s.media.trimmed : [];
  s.media.snapshots = Array.isArray(s.media.snapshots) ? s.media.snapshots : [];
  s.media.music = Array.isArray(s.media.music) ? s.media.music : [];
  s.media.audio = Array.isArray(s.media.audio) ? s.media.audio : [];
  s.media.subtitles = Array.isArray(s.media.subtitles) ? s.media.subtitles : [];
  s.media.analysis = s.media.analysis || {};
  s.media.analysis.frames = Array.isArray(s.media.analysis.frames) ? s.media.analysis.frames : [];
  s.media.analysis.face_tracking = Array.isArray(s.media.analysis.face_tracking) ? s.media.analysis.face_tracking : [];
  s.events = Array.isArray(s.events) ? s.events : [];
  if (s.storyboard && Array.isArray(s.storyboard.scenes)) {
    for (const c of s.storyboard.scenes) {
      c.takes = Array.isArray(c.takes) ? c.takes : [];
      c.audio = Array.isArray(c.audio) ? c.audio : [];
      c.required_assets = Array.isArray(c.required_assets) ? c.required_assets : [];
    }
  } else {
    s.storyboard = null;
  }
  return s;
}

// BoardState contains audit timestamps that can change during a burst of
// checkpoint writes without changing anything a creator can see.  Comparing
// this semantic projection keeps the board from tearing down and rebuilding
// the whole DOM for heartbeat-only noise, while status, artifact and event
// changes still produce a normal refresh.
const VOLATILE_STATE_KEYS = new Set([
  "timestamp", "ts", "created_at", "updated_at", "last_activity",
]);

function semanticStateProjection(value, key = "") {
  if (Array.isArray(value)) return value.map((item) => semanticStateProjection(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value)
    .filter((name) => !VOLATILE_STATE_KEYS.has(name))
    .sort()
    .map((name) => [name, semanticStateProjection(value[name], name)]));
}

function visualStateSignature(value) {
  return JSON.stringify(semanticStateProjection(value));
}

async function refresh() {
  if (refreshInFlight) {
    refreshQueued = true;
    return refreshInFlight;
  }
  refreshInFlight = (async () => {
    const nextState = normalize(await getJSON(`/api/project/${encodeURIComponent(projectId)}/state`));
    const nextSignature = visualStateSignature(nextState);
    const unchanged = nextSignature === lastStateSignature;
    state = nextState;
    lastStateSignature = nextSignature;
    const fromURL = requestedStage();
    const previousStage = selectedStage;
    if (fromURL && state.stages.some((stage) => stage.name === fromURL)) {
      selectedStage = fromURL;
    } else if (fromURL) {
      // Do not leave a misleading deep-link in the address bar when a stage is
      // not part of this project's pipeline (for example, a stale copied URL).
      updateStageURL(null);
      selectedStage = null;
    }
    // Live SSE updates may arrive while the creator is scrubbing.  Keep the
    // fresh state in memory, but do not interrupt the replay's deterministic
    // view; the next “LIVE” click renders the newest board.
    if (!replay && !unchanged) {
      render();
      if (selectedStage && fromURL && previousStage !== selectedStage) scrollToStage(selectedStage);
    }
  })();
  try {
    await refreshInFlight;
  } finally {
    refreshInFlight = null;
    if (refreshQueued) {
      refreshQueued = false;
      void refresh().catch(console.error);
    }
  }
}

refresh().catch((err) => {
  app.innerHTML = "";
  app.append(el("div", { class: "empty", style: "margin-top:80px" },
    el("div", { class: "big" }, "PROJECT NOT FOUND"),
    el("div", {}, String(err))));
});
// ?static=1 disables the live feed (screenshots, static exports).
if (!new URLSearchParams(location.search).has("static")) {
  subscribe(`/api/project/${encodeURIComponent(projectId)}/events`, () => refresh().catch(console.error));
}
