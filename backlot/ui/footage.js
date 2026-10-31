/* global fetch, document, window, URL, Blob */

const TERMINAL_STATUSES = new Set([
  "completed", "stage_completed", "failed", "cancelled", "interrupted", "awaiting_review", "needs_materials",
]);

const STATUS_LABELS = Object.freeze({
  queued: "排队中",
  running: "处理中",
  needs_materials: "缺少素材",
  awaiting_review: "等待复核",
  completed: "已完成",
  stage_completed: "本阶段已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
});

const DEFAULT_OPTIONS = Object.freeze({
  aspect_ratio: "16:9",
  resolution: 720,
  fps: 24,
  fit: "crop",
  transition: "cut",
  transition_seconds: 0.4,
  narration: "none",
  voice: "Tingting",
  voice_rate: 1,
  audio_path: null,
  bgm_path: null,
  bgm_mode: "none",
  bgm_style: "guofeng_ambient",
  bgm_prompt: "",
  bgm_model_id: "music_v1",
  narration_volume: 1,
  bgm_volume: 0.18,
  duck_bgm: true,
  source_volume: 0,
  subtitles: Object.freeze({
    enabled: true,
    font: "PingFang SC",
    font_size: 40,
    color: "#FFFFFF",
    outline_color: "#000000",
    outline_width: 2,
    background: false,
    position: "bottom",
  }),
  subtitle_path: null,
  ken_burns: true,
  variants: 1,
  order: "sequential",
});

const SAFE_OPTION_KEYS = new Set([
  "aspect_ratio", "resolution", "fps", "fit", "transition", "transition_seconds", "narration",
  "voice", "voice_rate", "audio_path", "bgm_path", "bgm_mode", "bgm_style", "bgm_prompt", "bgm_model_id", "narration_volume", "bgm_volume",
  "source_volume", "duck_bgm", "subtitles", "subtitle_path", "ken_burns", "variants", "order",
]);
const SAFE_SUBTITLE_KEYS = new Set([
  "enabled", "font", "font_size", "color", "outline_color", "outline_width", "background", "position",
]);
const SECRET_KEY_PATTERN = /(key|token|secret|password|passwd|credential|authorization|api[-_]?key)/i;

function finiteNumber(value, fallback, min = -Infinity, max = Infinity) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function stringValue(value, fallback = "") {
  return value === null || value === undefined ? fallback : String(value);
}

function randomRequestId() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch (_) {
    // The local fallback below is enough for idempotency in older browsers.
  }
  return `footage-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractScriptText(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(extractScriptText).filter(Boolean).join("\n").trim();
  if (!isPlainObject(value)) return "";
  const directKeys = ["text", "narration", "body", "content", "copy", "script_text"];
  for (const key of directKeys) {
    const text = extractScriptText(value[key]);
    if (text) return text;
  }
  for (const key of ["script", "selected", "selected_proposal", "proposal"]) {
    const text = extractScriptText(value[key]);
    if (text) return text;
  }
  return "";
}

function normalizeCandidate(candidate, index = 0) {
  const item = isPlainObject(candidate) ? candidate : {};
  return {
    path: stringValue(item.path),
    thumbnail: stringValue(item.thumbnail || item.thumbnail_path),
    source_url: stringValue(item.source_url),
    license: stringValue(item.license, "许可信息待核对"),
    creator: stringValue(item.creator, "来源未提供作者"),
    source: stringValue(item.source || item.provider, "来源未标注"),
    match_kind: stringValue(item.match_kind || item.kind, "place_candidate"),
    id: stringValue(item.id || item.clip_id || item.path || `candidate-${index + 1}`),
    duration: finiteNumber(item.duration, 0, 0),
  };
}

function normalizeShot(shot, index = 0) {
  const item = isPlainObject(shot) ? shot : {};
  const sourceText = stringValue(item.text || item.narration || item.copy || item.description);
  const queryRows = Array.isArray(item.queries) ? item.queries : [];
  const queries = queryRows.map((query) => {
    const row = isPlainObject(query) ? query : { text: query };
    return { text: stringValue(row.text), kind: row.kind === "generic" ? "generic" : "place" };
  }).filter((row) => row.text);
  const query = stringValue(item.query || item.search_query);
  if (!queries.length && query) queries.push({ text: query, kind: "place" });
  return {
    id: stringValue(item.id || item.shot_id || `shot-${index + 1}`),
    title: stringValue(item.title || item.name || `镜头 ${index + 1}`),
    text: sourceText,
    query,
    queries,
    query_override: stringValue(item.query_override),
    duration_seconds: finiteNumber(item.duration_seconds ?? item.duration, 5, 0.5, 120),
    source_path: stringValue(item.source_path || item.path),
    selection_mode: item.selection_mode === "auto" && !item.source_locked ? "auto" : "manual",
    source_locked: Boolean(item.source_locked),
    selection_warning: stringValue(item.selection_warning),
    start_seconds: finiteNumber(item.start_seconds ?? item.in_point, 0, 0, 86400),
    candidates: Array.isArray(item.candidates) ? item.candidates.map(normalizeCandidate) : [],
    selected_source: isPlainObject(item.selected_source) ? normalizeCandidate(item.selected_source) : null,
  };
}

function normalizeAsset(asset, index = 0) {
  const item = isPlainObject(asset) ? asset : {};
  return {
    path: stringValue(item.path),
    kind: stringValue(item.kind, "file"),
    label: stringValue(item.label || item.name || item.path || `素材 ${index + 1}`),
    origin: stringValue(item.origin, "local"),
    is_music: Boolean(item.is_music),
  };
}

function normalizeContext(value) {
  const raw = isPlainObject(value) ? value : {};
  const shots = Array.isArray(raw.shots) ? raw.shots.map(normalizeShot) : [];
  const assets = Array.isArray(raw.assets) ? raw.assets.map(normalizeAsset).filter((item) => item.path) : [];
  return {
    project_id: stringValue(raw.project_id),
    topic: stringValue(raw.topic || raw.title, "当前浙江文旅项目"),
    script: extractScriptText(raw.script || raw.script_text),
    shots,
    assets,
    jobs: Array.isArray(raw.jobs) ? raw.jobs.filter(isPlainObject) : [],
    selected_candidate_id: stringValue(raw.selected_candidate_id),
    settings: isPlainObject(raw.settings) ? raw.settings : null,
    summary: stringValue(raw.summary),
    draft_updated_at: stringValue(raw.draft_updated_at),
  };
}

function normalizeJobSnapshot(value) {
  const job = isPlainObject(value) ? value : {};
  return {
    ...job,
    job_id: stringValue(job.job_id),
    project_id: stringValue(job.project_id),
    status: stringValue(job.status, "queued"),
    stage: stringValue(job.stage, "queued"),
    progress: finiteNumber(job.progress, 0, 0, 100),
    message: stringValue(job.message),
    shots: Array.isArray(job.shots) ? job.shots.map(normalizeShot) : [],
    outputs: Array.isArray(job.outputs) ? job.outputs.filter(isPlainObject) : [],
    missing_shots: Array.isArray(job.missing_shots) ? job.missing_shots.map(String) : [],
  };
}

function normalizeOptions(value = {}, action = "render") {
  const source = isPlainObject(value) ? value : {};
  const sourceSubtitles = isPlainObject(source.subtitles) ? source.subtitles : {};
  const options = {
    aspect_ratio: ["16:9", "9:16", "1:1"].includes(source.aspect_ratio) ? source.aspect_ratio : DEFAULT_OPTIONS.aspect_ratio,
    resolution: [480, 720, 1080].includes(Number(source.resolution)) ? Number(source.resolution) : DEFAULT_OPTIONS.resolution,
    fps: [24, 30].includes(Number(source.fps)) ? Number(source.fps) : DEFAULT_OPTIONS.fps,
    fit: ["crop", "contain"].includes(source.fit) ? source.fit : DEFAULT_OPTIONS.fit,
    transition: ["cut", "fade", "crossfade"].includes(source.transition) ? source.transition : DEFAULT_OPTIONS.transition,
    transition_seconds: finiteNumber(source.transition_seconds, DEFAULT_OPTIONS.transition_seconds, 0.1, 2),
    narration: ["none", "local", "edge", "uploaded"].includes(source.narration) ? source.narration : DEFAULT_OPTIONS.narration,
    voice: stringValue(source.voice, DEFAULT_OPTIONS.voice).slice(0, 100),
    voice_rate: finiteNumber(source.voice_rate, DEFAULT_OPTIONS.voice_rate, 0.5, 2),
    audio_path: source.audio_path ? stringValue(source.audio_path) : null,
    bgm_path: source.bgm_path ? stringValue(source.bgm_path) : null,
    bgm_mode: ["none", "selected", "random", "local", "elevenlabs"].includes(source.bgm_mode) ? source.bgm_mode : DEFAULT_OPTIONS.bgm_mode,
    bgm_style: ["guofeng_ambient", "cinematic", "documentary"].includes(source.bgm_style) ? source.bgm_style : DEFAULT_OPTIONS.bgm_style,
    bgm_prompt: stringValue(source.bgm_prompt).trim(),
    bgm_model_id: ["music_v1", "music_v2", "music_v2_5"].includes(source.bgm_model_id) ? source.bgm_model_id : DEFAULT_OPTIONS.bgm_model_id,
    narration_volume: finiteNumber(source.narration_volume, DEFAULT_OPTIONS.narration_volume, 0, 2),
    bgm_volume: finiteNumber(source.bgm_volume, DEFAULT_OPTIONS.bgm_volume, 0, 1),
    duck_bgm: source.duck_bgm !== false,
    source_volume: finiteNumber(source.source_volume, DEFAULT_OPTIONS.source_volume, 0, 1),
    subtitles: {
      enabled: sourceSubtitles.enabled !== false,
      font: stringValue(sourceSubtitles.font, DEFAULT_OPTIONS.subtitles.font).slice(0, 80),
      font_size: finiteNumber(sourceSubtitles.font_size, DEFAULT_OPTIONS.subtitles.font_size, 16, 100),
      color: /^#[0-9a-f]{6}$/i.test(stringValue(sourceSubtitles.color)) ? sourceSubtitles.color : DEFAULT_OPTIONS.subtitles.color,
      outline_color: /^#[0-9a-f]{6}$/i.test(stringValue(sourceSubtitles.outline_color)) ? sourceSubtitles.outline_color : DEFAULT_OPTIONS.subtitles.outline_color,
      outline_width: finiteNumber(sourceSubtitles.outline_width, DEFAULT_OPTIONS.subtitles.outline_width, 0, 8),
      background: Boolean(sourceSubtitles.background),
      position: ["top", "center", "bottom"].includes(sourceSubtitles.position) ? sourceSubtitles.position : DEFAULT_OPTIONS.subtitles.position,
    },
    subtitle_path: source.subtitle_path ? stringValue(source.subtitle_path) : null,
    ken_burns: source.ken_burns !== false,
    variants: finiteNumber(source.variants, DEFAULT_OPTIONS.variants, 1, 5),
    order: source.order === "random" ? "random" : DEFAULT_OPTIONS.order,
  };
  return options;
}

function requestShot(shot, index = 0) {
  const item = normalizeShot(shot, index);
  return {
    id: item.id,
    title: item.title,
    text: item.text,
    query: item.query_override || item.query,
    source_path: item.source_path,
    selection_mode: item.selection_mode,
    source_locked: item.source_locked,
    start_seconds: item.start_seconds,
    duration_seconds: item.duration_seconds,
  };
}

function buildCommonRequest(input = {}, action) {
  const projectId = stringValue(input.project_id || input.projectId);
  const shots = Array.isArray(input.shots) ? input.shots.map(requestShot) : [];
  const request = {
    project_id: projectId,
    topic: stringValue(input.topic),
    script: stringValue(input.script),
    shots,
    sources: Array.isArray(input.sources) ? input.sources.map(String).filter(Boolean) : [],
    material_mode: ["stock", "local", "mixed"].includes(input.material_mode || input.materialMode)
      ? (input.material_mode || input.materialMode) : "mixed",
    allow_generic: Boolean(input.allow_generic ?? input.allowGeneric),
    options: normalizeOptions(input.options || input, action || input.action || "render"),
    confirm_network: Boolean(input.confirm_network ?? input.confirmNetwork),
    request_id: stringValue(input.request_id || input.requestId, randomRequestId()),
    stop_at: ["script", "terms", "materials", "audio", "subtitle", "video"].includes(input.stop_at) ? input.stop_at : "video",
  };
  if (action || input.action) request.action = action || input.action;
  return request;
}

function buildPlanRequest(input = {}) {
  const request = buildCommonRequest(input);
  delete request.action;
  if (input.omitShots) delete request.shots;
  return request;
}

function buildJobPayload(input = {}) {
  return buildCommonRequest(input, input.action || "collect");
}

function paidMusicRequested(payload) {
  return payload?.action !== "collect" && payload?.stop_at === "video" && payload?.options?.bgm_mode === "elevenlabs";
}

function musicReviewKey(payload) {
  return JSON.stringify([payload.project_id, payload.options?.bgm_mode, payload.options?.bgm_prompt, payload.options?.bgm_model_id,
    payload.shots?.map(shot => [shot.id, shot.duration_seconds]), payload.script, payload.options?.narration, payload.options?.voice, payload.options?.voice_rate]);
}

function musicSubmissionOptions(payload, consent = {}) {
  const options = normalizeOptions(payload.options, payload.action);
  if (!paidMusicRequested({...payload, options})) return options;
  const budget = Number(consent.budget);
  if (consent.paid !== true || consent.text !== true || consent.billing !== true || !Number.isFinite(budget) || budget <= 0) {
    throw new Error("请先预检音乐，填写有效预算，并完成本次发送文字、一次付费生成和账户消费上限确认。");
  }
  return {...options, bgm_confirm_paid: true, bgm_confirm_text: true, bgm_billing_limit_configured: true, bgm_budget_usd: budget};
}

function sanitizeSettings(value) {
  const source = isPlainObject(value) && isPlainObject(value.options) ? value.options : value;
  if (!isPlainObject(source)) throw new Error("设置必须是 JSON 对象");
  const result = {};
  for (const [key, raw] of Object.entries(source)) {
    if (SECRET_KEY_PATTERN.test(key)) throw new Error("设置文件不能包含密钥、令牌或密码字段");
    if (!SAFE_OPTION_KEYS.has(key)) throw new Error(`设置字段不在允许范围内：${key}`);
    if (key === "subtitles") {
      if (!isPlainObject(raw)) throw new Error("字幕设置格式不正确");
      const subtitles = {};
      for (const [subtitleKey, subtitleValue] of Object.entries(raw)) {
        if (SECRET_KEY_PATTERN.test(subtitleKey) || !SAFE_SUBTITLE_KEYS.has(subtitleKey)) {
          throw new Error(`字幕设置字段不在允许范围内：${subtitleKey}`);
        }
        subtitles[subtitleKey] = subtitleValue;
      }
      result.subtitles = subtitles;
    } else {
      result[key] = raw;
    }
  }
  return result;
}

function convertMptSettings(value, {assets = [], voices = []} = {}) {
  if (!isPlainObject(value)) throw new Error("预设必须是 JSON 对象。");
  function rejectSecrets(node) {
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if (SECRET_KEY_PATTERN.test(key)) throw new Error("设置文件不能包含密钥、令牌或密码；上游凭据备份不能导入。");
      rejectSecrets(child);
    }
  }
  rejectSecrets(value);
  if (value.schema === "moneyprinterturbo.key-backup") throw new Error("这是上游凭据备份，不能导入工作台设置。");
  if (value.schema !== "moneyprinterturbo.settings-preset" || value.version !== 1 || !isPlainObject(value.params)) throw new Error("MoneyPrinterTurbo 预设需要 schema 为 moneyprinterturbo.settings-preset、version 为 1，以及 params 对象。");
  if (Object.keys(value).some(key => !["schema", "version", "app_version", "params"].includes(key))) throw new Error("预设外层包含无法识别的字段，尚未导入。");
  const options = {}, subtitles = {}, mappings = [], notes = [], unsupported = [];
  const params = value.params;
  const mapped = (key, label, target, result, subtitle = false) => { (subtitle ? subtitles : options)[target] = result; mappings.push(`${key} → ${label}`); };
  const invalid = (key, explanation) => unsupported.push(`${key}：${explanation}`);
  const number = (key, raw, minimum, maximum, integer = false) => {
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < minimum || raw > maximum || integer && !Number.isInteger(raw)) { invalid(key, `需要${integer ? "整数" : "数值"} ${minimum}–${maximum}；不会自动截断。`); return false; }
    return true;
  };
  const color = (key, raw, label, target) => { if (typeof raw !== "string" || !/^#[0-9a-f]{6}$/i.test(raw)) invalid(key, "需要六位十六进制颜色。"); else mapped(key, label, target, raw, true); };
  const projectAudio = (key, raw) => {
    if (typeof raw !== "string" || !raw || raw.length > 1024 || raw.startsWith("/") || /[:\\]/.test(raw) || raw.split("/").some(part => ["..", "."].includes(part))) { invalid(key, "只能引用当前项目中的相对路径，不能导入外部或绝对路径。"); return ""; }
    if (!assets.some(asset => asset.path === raw && asset.kind === "audio")) { invalid(key, "当前项目没有这条音频，请先导入文件，再导入设置。"); return ""; }
    return raw;
  };
  for (const [key, raw] of Object.entries(params)) {
    switch (key) {
      case "video_aspect":
        if (["16:9", "9:16", "1:1"].includes(raw)) mapped(key, "画幅", "aspect_ratio", raw); else invalid(key, "当前支持 16:9、9:16、1:1。"); break;
      case "video_fit_mode":
        if (["cover", "contain"].includes(raw)) mapped(key, "画面适配", "fit", raw === "cover" ? "crop" : "contain"); else invalid(key, "需要 cover 或 contain。"); break;
      case "video_concat_mode":
        if (["sequential", "random"].includes(raw)) { mapped(key, "镜头内选片", "order", raw); if (raw === "random") notes.push("随机选片只改变镜头内素材，保留当前旁白与镜头顺序。"); } else invalid(key, "需要 sequential 或 random。"); break;
      case "video_count": if (number(key, raw, 1, 5, true)) mapped(key, "生成版本", "variants", raw); break;
      case "video_transition_mode":
        if (raw === null || raw === "none" || raw === "") mapped(key, "直接切", "transition", "cut"); else invalid(key, "上游转场请使用“扩展 AI 服务 → 高级剪辑”，主流程无法等价表达。"); break;
      case "voice_rate": if (number(key, raw, .5, 2)) mapped(key, "语速", "voice_rate", raw); break;
      case "voice_volume": if (number(key, raw, 0, 2)) mapped(key, "旁白音量", "narration_volume", raw); break;
      case "bgm_volume": if (number(key, raw, 0, 1)) mapped(key, "配乐音量", "bgm_volume", raw); break;
      case "voice_name":
        if (params.custom_audio_file) notes.push("voice_name：使用导入旁白时不调用该音色，声音字段未导入。");
        else if (["none", "no-voice"].includes(raw)) mapped(key, "无旁白", "narration", "none");
        else if (raw === "" || raw === null) notes.push("voice_name 未指定：保留本页当前声音。");
        else {
          const voice = typeof raw === "string" && raw.length <= 100 ? voices.find(item => item.id === raw && item.available) : null;
          if (!voice) invalid(key, "该音色不在本页可用声音清单中，请用扩展多服务配音或先配置对应声音。");
          else { mapped(key, "声音", "voice", raw); options.narration = voice.network ? "edge" : "local"; notes.push("导入声音不会发起配音；Edge 提交前仍须确认发送脚本文本。"); }
        } break;
      case "custom_audio_file":
        if (!raw) notes.push("custom_audio_file 为空：未更改已选旁白。");
        else { const path = projectAudio(key, raw); if (path) { mapped(key, "已导入旁白", "audio_path", path); options.narration = "uploaded"; } } break;
      case "bgm_type":
        if (raw === "" || raw === null) mapped(key, "不使用配乐", "bgm_mode", "none");
        else if (raw === "random") { mapped(key, "本地随机配乐", "bgm_mode", "random"); notes.push("随机配乐使用当前项目明确导入的音乐，不包含上游歌曲库。"); }
        else if (raw === "custom") { mapped(key, "已导入配乐", "bgm_mode", "selected"); if (!params.bgm_file) invalid(key, "缺少项目内 bgm_file；请先导入并指定音乐。"); }
        else invalid(key, "内置歌曲或 AI 配乐不能作为本页本地配乐导入，请从扩展服务生成或手动导入音乐。"); break;
      case "bgm_file":
        if (!raw) notes.push("bgm_file 为空：未更改已选音乐。");
        else if (params.bgm_type !== "custom") invalid(key, "项目音频路径需要 bgm_type 为 custom；不导入上游内置歌曲。");
        else { const path = projectAudio(key, raw); if (path) mapped(key, "已导入配乐路径", "bgm_path", path); } break;
      case "subtitle_enabled":
        if (typeof raw === "boolean") mapped(key, "字幕开关", "enabled", raw, true); else invalid(key, "需要布尔值。"); break;
      case "subtitle_position":
        if (["top", "center", "bottom"].includes(raw)) mapped(key, "字幕位置", "position", raw, true); else invalid(key, "自定义或下三分之一位置请用扩展高级剪辑。"); break;
      case "font_name":
        if (typeof raw !== "string" || !raw.trim() || raw.length > 80 || /[,;:'"\[\]{}\\/\n\r]|\.(ttf|ttc|otf)$/i.test(raw)) invalid(key, "这里使用本机字体名称，上游字体文件名不能直接等价导入；请在本页填写已安装字体名称。");
        else mapped(key, "字幕字体", "font", raw, true); break;
      case "font_size": if (number(key, raw, 16, 100, true)) mapped(key, "字号", "font_size", raw, true); break;
      case "text_fore_color": color(key, raw, "字幕颜色", "color"); break;
      case "stroke_color": color(key, raw, "描边颜色", "outline_color"); break;
      case "stroke_width": if (number(key, raw, 0, 8)) mapped(key, "描边宽度", "outline_width", raw, true); break;
      case "text_background_color":
        if ([false, true, "#000000"].includes(raw)) { mapped(key, "字幕底板", "background", raw !== false, true); if (raw !== false) notes.push("字幕底板使用主流程黑色半透明样式。"); }
        else invalid(key, "彩色底板请使用扩展高级剪辑。"); break;
      case "subtitle_display_mode": if (raw === "sentence") notes.push("subtitle_display_mode：使用主流程逐句字幕。"); else invalid(key, "逐词字幕请使用扩展高级剪辑。"); break;
      case "subtitle_animation": if (raw === "none") notes.push("subtitle_animation：使用主流程静态字幕。"); else invalid(key, "字幕动效请使用扩展高级剪辑。"); break;
      case "rounded_subtitle_background": if (raw === false) notes.push("rounded_subtitle_background：不使用圆角底板。"); else invalid(key, "圆角底板请使用扩展高级剪辑。"); break;
      case "custom_position": if (params.subtitle_position === "custom") invalid(key, "自定义百分比位置请使用扩展高级剪辑。"); else notes.push("custom_position：当前不是自定义位置，此值不生效。"); break;
      case "video_clip_speed": if (raw === 1) notes.push("video_clip_speed：保留正常速度。"); else invalid(key, "视频变速请使用扩展高级剪辑。"); break;
      case "video_clip_duration": invalid(key, "上游单段最大时长不能替代本页逐镜时长；请用扩展高级剪辑或移除此字段后逐镜填写。"); break;
      case "n_threads": notes.push("n_threads：本页由本机流程管理线程，此字段未导入。"); break;
      case "video_source": case "video_subject": case "video_script": case "video_terms": case "video_language": case "paragraph_number": case "video_script_prompt": case "custom_system_prompt": case "match_materials_to_script": case "video_music_prompt": case "sonilo_bgm_prompt":
        notes.push(`${key}：不属于本页样式设置，未导入；保留当前脚本、镜头和来源，请在主流程或扩展服务单独设置。`); break;
      case "video_materials": if (raw === null || Array.isArray(raw) && !raw.length) notes.push("video_materials 为空：未更改当前选片。"); else invalid(key, "素材列表不能作为样式导入，请先导入文件并逐镜选择。"); break;
      default: invalid(key, "字段未映射，尚未导入。");
    }
  }
  if (Object.keys(subtitles).length) options.subtitles = subtitles;
  // Uploaded narration takes priority independent of the order of JSON fields.
  if (options.audio_path) options.narration = "uploaded";
  return {options: sanitizeSettings(options), mappings, notes, unsupported};
}

function assetUrl(projectId, path) {
  const raw = stringValue(path).trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^data:image\//i.test(raw)) return raw;
  if (/^(?:javascript|file|blob):/i.test(raw)) return "";
  return `/model-api/footage/assets/${encodeURIComponent(stringValue(projectId))}?path=${encodeURIComponent(raw.replace(/^\/+/, ""))}`;
}

function jobBelongsToProject(snapshot, projectId, jobId = "") {
  if (!isPlainObject(snapshot)) return false;
  const snapshotProject = snapshot.project_id ?? snapshot.projectId;
  if (snapshotProject && String(snapshotProject) !== String(projectId)) return false;
  if (jobId && snapshot.job_id && String(snapshot.job_id) !== String(jobId)) return false;
  return true;
}

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(String(status || "").toLowerCase());
}

function statusLabel(status) {
  return STATUS_LABELS[String(status || "").toLowerCase()] || "未定义状态";
}

function projectIdFromSearch(search) {
  try {
    return String(new URLSearchParams(search || "").get("project") || "").trim();
  } catch (_) {
    return "";
  }
}

let dom = null;
let state = null;

function clearNode(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

function setText(node, value) {
  if (node) node.textContent = stringValue(value);
}

function getElement(id) {
  return document.getElementById(id);
}

function setPageMessage(kind, message) {
  if (!dom?.pageMessage) return;
  dom.pageMessage.className = `page-message ${kind || ""}`.trim();
  setText(dom.pageMessageText, message);
  if (["error", "warn"].includes(kind) && isMoneyprinterLayout() && dom.actionHint) {
    setText(dom.actionHint, message);
    dom.actionHint.classList.toggle("error", kind === "error");
  }
}

function showSettingsFeedback(kind, message) {
  const report = getElement("settingsImportReport");
  if (!report) return;
  const row = document.createElement("div");
  row.className = `batch-row ${kind || ""}`.trim();
  row.textContent = message;
  report.appendChild(row);
}

function showTaskFeedback(message) {
  const dialog = dom.taskManagerDialog;
  if (!dialog?.open) return;
  let feedback = dialog.querySelector(".dialog-feedback");
  if (!feedback) {
    feedback = document.createElement("p");
    feedback.className = "inline-status error dialog-feedback";
    feedback.setAttribute("role", "alert");
    dialog.querySelector(".dialog-heading").after(feedback);
  }
  feedback.textContent = message;
}

function focusFootageArea(target) {
  if (!target) return;
  if (!target.matches("input,select,textarea,button,summary")) target.setAttribute("tabindex", "-1");
  target.focus({preventScroll: true});
  target.scrollIntoView({behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: target.matches("input,select,textarea,button") ? "center" : "start"});
}

function closeTaskManagerAt(target) {
  if (dom.taskManagerDialog?.open) {
    dom.taskManagerDialog.footageDestination = target;
    dom.taskManagerDialog.close();
  } else focusFootageArea(target);
}

function requestHeaders(extra = {}) {
  return { Accept: "application/json", ...extra };
}

async function requestJSON(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: requestHeaders(options.headers || {}),
  });
  const contentType = response.headers?.get?.("content-type") || "";
  let payload = null;
  if (contentType.includes("application/json")) {
    payload = await response.json();
  } else {
    const text = await response.text();
    payload = text ? { detail: text.slice(0, 500) } : {};
  }
  if (!response.ok) {
    throw new Error(stringValue(payload?.detail || payload?.error, `请求失败（${response.status}）`));
  }
  return payload;
}

function getJSON(path) {
  return requestJSON(path, { method: "GET" });
}

function postJSON(path, body) {
  return requestJSON(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function bindDom() {
  const ids = [
    "footageApp", "projectBadge", "backToModel", "pageMessage", "pageMessageText", "stepScript", "stepMaterials", "stepExport",
    "openTaskManagerButton", "taskManagerDialog", "openSettingsButton", "settingsDialog", "projectRequired", "projectPicker", "selectProjectButton", "projectPickerStatus",
    "scriptStatus", "topicLabel", "proposalSummary", "scriptEditor", "scriptMeta", "replanButton", "shotCountLabel", "shotList",
    "sourceCapabilities", "materialMode", "allowGeneric", "assetUpload", "uploadStatus", "assetSummary", "narrationMode", "voiceSelect",
    "uploadedNarration", "subtitlePath", "networkConfirmRow", "networkConfirm", "voiceStatus", "voicePreviewButton", "voicePreviewAudio", "voicePreviewMode", "reuseVoicePreviewButton",
    "advancedSettings", "aspectRatio", "resolution", "fps", "fit", "transition", "transitionSeconds", "voiceRate", "narrationVolume",
    "sourceVolume", "subtitleFont", "subtitleFontSize", "subtitlePosition", "subtitleColor", "subtitleOutlineColor", "subtitleOutlineWidth", "subtitleEnabled", "subtitleBackground", "kenBurns", "bgmMode", "stopAt",
    "bgmPath", "bgmVolume", "duckBgm", "bgmStyle", "bgmStyleField", "bgmPathField", "bgmNote", "exportSettingsButton", "importSettingsInput", "extendedServicesStatus", "actionHint", "collectButton",
    "bgmElevenlabsFields", "bgmPrompt", "bgmModel", "bgmPreflightButton", "bgmServiceStatus", "bgmPromptPreviewField", "bgmPromptPreview", "bgmBudget", "bgmConfirmText", "bgmConfirmPaid", "bgmBillingLimit",
    "createButton", "renderButton", "cancelButton", "currentJobPanel", "jobStatus", "jobProgressBar", "jobProgressValue", "jobMessage", "materialCoverage",
    "missingShots", "outputArea", "historyCount", "historyList", "variants", "footageOrder", "jobWarnings",
  ];
  dom = Object.fromEntries(ids.map((id) => [id, getElement(id)]));
}

function activeAssets(kind) {
  return (state?.assets || []).filter((asset) => !kind || asset.kind === kind);
}

function assetLabel(asset) {
  const origin = {uploaded:'本机导入',local:'本机',generated:'生成 / 剪辑产物'}[asset.origin] || '项目素材';
  return `${asset.label} · ${origin}`;
}

function renderAssetOptions(select, assets, emptyLabel) {
  if (!select) return;
  const current = select.value;
  clearNode(select);
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = emptyLabel;
  select.appendChild(empty);
  for (const asset of assets) {
    const option = document.createElement("option");
    option.value = asset.path;
    option.textContent = assetLabel(asset);
    select.appendChild(option);
  }
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function renderAssets() {
  const assets = state.assets || [];
  clearNode(dom.assetSummary);
  if (!assets.length) {
    setText(dom.assetSummary, "当前项目还没有可选本机素材。");
  } else {
    for (const asset of assets.slice(0, 120)) {
      const row = document.createElement("div");
      row.className = "asset-row";
      const label = document.createElement("b");
      label.textContent = asset.label;
      label.title = asset.path;
      const kind = document.createElement("span");
      kind.textContent = `${{video:'视频',image:'图片',audio:'音频',subtitle:'字幕'}[asset.kind] || '素材'} · ${asset.origin === 'generated' ? '生成 / 剪辑产物' : '本机素材'}`;
      row.append(label, kind);
      dom.assetSummary.appendChild(row);
    }
  }
  renderAssetOptions(dom.uploadedNarration, activeAssets("audio"), "不使用导入旁白");
  renderAssetOptions(dom.bgmPath, activeAssets("audio"), "暂无已导入音乐");
  renderAssetOptions(dom.subtitlePath, activeAssets("subtitle"), "让系统按脚本生成字幕");
  updateActionButtons();
}

function sourceIsAvailable(source) {
  return String(source?.status || "").toLowerCase() === "available";
}

function renderCapabilities(capabilities) {
  const data = isPlainObject(capabilities) ? capabilities : {};
  state.capabilities = data;
  const recommended = data.default_sources || ["pexels", "pixabay_video", "wikimedia", "mixkit", "archive_org"];
  state.availableSources = Array.isArray(data.sources)
    ? data.sources.filter(sourceIsAvailable).map((source) => String(source.name || "")).filter(name => recommended.includes(name))
    : [];
  clearNode(dom.sourceCapabilities);
  const sources = Array.isArray(data.sources) ? data.sources : [];
  if (!sources.length) {
    const empty = document.createElement("span");
    empty.className = "loading-copy";
    empty.textContent = "服务端没有返回可用素材来源。";
    dom.sourceCapabilities.appendChild(empty);
  } else {
    for (const source of sources) {
      const chip = document.createElement("label");
      const available = sourceIsAvailable(source);
      chip.className = `capability-chip${available ? "" : " off"}`;
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = source.name;
      input.disabled = !available;
      input.checked = state.availableSources.includes(source.name);
      input.addEventListener("change", () => {
        state.availableSources = [...dom.sourceCapabilities.querySelectorAll("input:checked")].map(el => el.value);
        updateActionButtons();
      });
      chip.append(input, document.createTextNode(`${stringValue(source.display_name || source.name, "未命名来源")} · ${available ? "已配置" : "未配置"}`));
      dom.sourceCapabilities.appendChild(chip);
    }
  }
  const upstream = isPlainObject(data.upstream) ? data.upstream : {};
  const upstreamName = stringValue(upstream.name || upstream.integration, "服务端能力清单");
  setText(dom.extendedServicesStatus, `${upstreamName} 已返回能力信息；仅使用服务端标记为可用的来源和声音。`);
  renderVoiceOptions(data.voices);
  updateActionButtons();
}

function availableVoices(network) {
  return Array.isArray(state?.capabilities?.voices)
    ? state.capabilities.voices.filter((voice) => Boolean(voice?.available) && Boolean(voice?.network) === network)
    : [];
}

function renderVoiceOptions(voices) {
  const rows = Array.isArray(voices) ? voices : [];
  const currentMode = dom.narrationMode.value;
  clearNode(dom.narrationMode);
  const none = document.createElement("option");
  none.value = "none";
  none.textContent = "无旁白";
  dom.narrationMode.appendChild(none);
  if (rows.some((voice) => voice?.available && !voice?.network)) {
    const local = document.createElement("option");
    local.value = "local";
    local.textContent = "本机语音（免费）";
    dom.narrationMode.appendChild(local);
  }
  if (rows.some((voice) => voice?.available && voice?.network)) {
    const edge = document.createElement("option");
    edge.value = "edge";
    edge.textContent = "Edge 在线语音（会发送脚本）";
    dom.narrationMode.appendChild(edge);
  }
  const uploaded = document.createElement("option");
  uploaded.value = "uploaded";
  uploaded.textContent = "使用已导入旁白";
  dom.narrationMode.appendChild(uploaded);
  const preferredMode = [...dom.narrationMode.options].some((option) => option.value === currentMode)
    ? currentMode : (rows.some((voice) => voice?.available && !voice?.network) ? "local" : "none");
  dom.narrationMode.value = preferredMode;
  renderVoiceSelect();
}

function renderVoiceSelect() {
  const mode = dom.narrationMode.value;
  const voices = availableVoices(mode === "edge");
  const current = dom.voiceSelect.value;
  clearNode(dom.voiceSelect);
  if (mode === "none" || mode === "uploaded") {
    const option = document.createElement("option");
    option.value = "Tingting";
    option.textContent = mode === "uploaded" ? "导入旁白不需要音色" : "不使用音色";
    dom.voiceSelect.appendChild(option);
    dom.voiceSelect.disabled = true;
  } else if (!voices.length) {
    const option = document.createElement("option");
    option.value = "Tingting";
    option.textContent = mode === "edge" ? "暂无可用在线音色" : "暂无可用本机声音";
    dom.voiceSelect.appendChild(option);
    dom.voiceSelect.disabled = true;
  } else {
    for (const voice of voices) {
      const option = document.createElement("option");
      option.value = stringValue(voice.id, "Tingting");
      option.textContent = stringValue(voice.label || voice.id, "未命名音色");
      dom.voiceSelect.appendChild(option);
    }
    dom.voiceSelect.disabled = false;
    if ([...dom.voiceSelect.options].some((option) => option.value === current)) dom.voiceSelect.value = current;
  }
  const edge = mode === "edge";
  dom.networkConfirmRow.hidden = !edge;
  if (edge) {
    setText(dom.voiceStatus, "在线旁白会把脚本发送到 Edge 服务；提交前需要勾选网络确认。");
  } else if (mode === "local") {
    setText(dom.voiceStatus, voices.length ? "将使用本机语音，不上传脚本。" : "本机声音不可用，建议选择无旁白或导入音频。");
  } else if (mode === "uploaded") {
    setText(dom.voiceStatus, dom.uploadedNarration.value ? "将使用当前项目中的导入旁白。" : "请选择一条已导入旁白，或改为无旁白。");
  } else {
    setText(dom.voiceStatus, "初剪可以先不配旁白，后续仍可导入音频再导出。");
  }
  dom.voicePreviewButton.disabled = mode === "none" || mode === "uploaded" || dom.voiceSelect.disabled || !state.ready;
  updatePreviewReuse();
  updateActionButtons();
}

function previewSignature() {
  return JSON.stringify([state.scriptText.trim(), dom.narrationMode.value, dom.voiceSelect.value, Number(dom.voiceRate.value)]);
}

function updatePreviewReuse() {
  if (!dom?.reuseVoicePreviewButton || !state) return;
  dom.reuseVoicePreviewButton.hidden = !state.voicePreview?.full_text || state.voicePreview.signature !== previewSignature();
}

function reuseVoicePreview() {
  const preview = state.voicePreview;
  if (!preview?.full_text || preview.signature !== previewSignature()) return;
  if (!state.assets.some(asset => asset.path === preview.path)) state.assets.push(normalizeAsset({path: preview.path, kind: "audio", label: "完整试听旁白", origin: "generated"}));
  renderAssets();
  dom.narrationMode.value = "uploaded";
  dom.uploadedNarration.value = preview.path;
  renderVoiceSelect();
  setPageMessage("ok", "完整试听已选为当前旁白；下一次制作将使用这份音频。");
}

function readSubtitleControls(controls) {
  return {
    enabled: controls.subtitleEnabled.checked,
    font: controls.subtitleFont.value,
    font_size: Number(controls.subtitleFontSize.value),
    color: controls.subtitleColor.value,
    outline_color: controls.subtitleOutlineColor.value,
    outline_width: Number(controls.subtitleOutlineWidth.value),
    background: controls.subtitleBackground.checked,
    position: controls.subtitlePosition.value,
  };
}

function applySubtitleControls(controls, subtitles) {
  controls.subtitleEnabled.checked = subtitles.enabled;
  controls.subtitleFont.value = subtitles.font;
  controls.subtitleFontSize.value = String(subtitles.font_size);
  controls.subtitleColor.value = subtitles.color;
  controls.subtitleOutlineColor.value = subtitles.outline_color;
  controls.subtitleOutlineWidth.value = String(subtitles.outline_width);
  controls.subtitleBackground.checked = subtitles.background;
  controls.subtitlePosition.value = subtitles.position;
}

let musicReview = null;

function resetMusicConsent() {
  musicReview = null;
  for (const id of ["bgmConfirmText", "bgmConfirmPaid", "bgmBillingLimit"]) dom[id].checked = false;
  dom.bgmBudget.value = "";
  dom.bgmPromptPreviewField.hidden = true;
  dom.bgmPromptPreview.textContent = "";
  dom.bgmServiceStatus.textContent = "预检仅读取本机配置，不调用生成接口。";
}

function updateMusicControls() {
  const mode = dom.bgmMode.value;
  resetMusicConsent();
  dom.bgmElevenlabsFields.hidden = mode !== "elevenlabs";
  dom.bgmStyleField.hidden = mode !== "local";
  dom.bgmPathField.hidden = mode !== "selected";
  dom.bgmPath.disabled = mode !== "selected";
  dom.bgmNote.textContent = mode === "local" ? "按实际旁白时长合成免费器乐并自动混音。使用本机预设，无需 ElevenLabs。"
    : mode === "random" ? "从当前项目已有的配乐中选一首；没有音乐时会提示导入。"
    : mode === "selected" ? "使用当前项目的音乐文件；请确认素材授权。"
    : mode === "elevenlabs" ? "仅在生成完整视频时调用一次付费音乐接口；自动找素材和提前停止不会生成音乐。费用预估仅作参考，以服务账户实际计费为准。" : "本次视频不添加背景音乐。";
}

function showMusicPreflight(result) {
  const cost = Number(result.estimated_cost_usd);
  dom.bgmServiceStatus.textContent = result.ready
    ? `${result.provider?.model || dom.bgmModel.value} · 计划 ${result.duration_seconds} 秒 · 一次生成参考费用 $${Number.isFinite(cost) ? cost.toFixed(4) : "未知"}。旁白测量后再核对时长，预估超过所填预算会停止；实际扣费受账户计费与消费上限约束。`
    : [...(result.errors || []), ...(result.approvals || [])].join("；") || "音乐服务暂不可用，没有调用生成接口。";
  dom.bgmPromptPreview.textContent = result.prompt_preview || "";
  dom.bgmPromptPreviewField.hidden = !result.prompt_preview;
}

async function previewPaidMusic() {
  if (!state.ready || state.busy || dom.bgmMode.value !== "elevenlabs") return;
  resetMusicConsent();
  dom.bgmPreflightButton.disabled = true;
  try {
    if (!await planStoryboard()) return;
    const payload = currentRequest("render");
    payload.stop_at = "video";
    const reviewKey = musicReviewKey(payload);
    const result = await postJSON("/model-api/footage/music/preflight", payload);
    if (reviewKey !== musicReviewKey({...currentRequest("render"), stop_at: "video"})) return;
    showMusicPreflight(result);
    musicReview = {key: reviewKey, result};
  } catch (error) {
    dom.bgmServiceStatus.textContent = error.message || "配乐预检失败；没有调用生成接口。";
  } finally {
    dom.bgmPreflightButton.disabled = false;
  }
}

function currentOptions(action = "render") {
  for (const id of ["transitionSeconds", "voiceRate", "narrationVolume", "bgmVolume", "sourceVolume", "subtitleFontSize", "subtitleOutlineWidth"]) {
    const control = dom[id];
    const integer = id === "subtitleFontSize";
    const number = Number(control?.value);
    // Float steps control the arrow increment, not what saved presets may
    // express. The actual renderer accepts fractional rates, gains and widths.
    if (control && (control.value.trim() === "" || !Number.isFinite(number) || control.validity?.badInput || control.validity?.rangeUnderflow || control.validity?.rangeOverflow || integer && !Number.isInteger(number))) {
      for (let parent = control.closest("details"); parent; parent = parent.parentElement?.closest("details")) parent.open = true;
      focusFootageArea(control);
      const label = control.closest("label")?.textContent.trim() || "参数";
      throw new Error(`${label}：请填写 ${control.min}–${control.max} 范围内的${integer ? "整数" : "有效数值"}。`);
    }
  }
  return normalizeOptions({
    aspect_ratio: dom.aspectRatio.value,
    resolution: Number(dom.resolution.value),
    fps: Number(dom.fps.value),
    fit: dom.fit.value,
    transition: dom.transition.value,
    transition_seconds: Number(dom.transitionSeconds.value),
    narration: dom.narrationMode.value,
    voice: dom.voiceSelect.value,
    voice_rate: Number(dom.voiceRate.value),
    audio_path: dom.narrationMode.value === "uploaded" ? (dom.uploadedNarration.value || null) : null,
    bgm_path: dom.bgmPath.value || null,
    bgm_mode: dom.bgmMode.value,
    bgm_style: dom.bgmStyle.value,
    bgm_prompt: dom.bgmPrompt.value,
    bgm_model_id: dom.bgmModel.value,
    narration_volume: Number(dom.narrationVolume.value),
    bgm_volume: Number(dom.bgmVolume.value),
    duck_bgm: dom.duckBgm.checked,
    source_volume: Number(dom.sourceVolume.value),
    subtitles: readSubtitleControls(dom),
    subtitle_path: dom.subtitlePath.value || null,
    ken_burns: dom.kenBurns.checked,
    variants: Number(dom.variants.value),
    order: dom.footageOrder.value,
  }, action);
}

function applyOptions(value) {
  const options = normalizeOptions(value, "render");
  dom.aspectRatio.value = options.aspect_ratio;
  dom.resolution.value = String(options.resolution);
  dom.fps.value = String(options.fps);
  dom.fit.value = options.fit;
  dom.transition.value = options.transition;
  dom.transitionSeconds.value = String(options.transition_seconds);
  dom.narrationMode.value = options.narration;
  renderVoiceSelect();
  dom.voiceSelect.value = options.voice;
  dom.voiceRate.value = String(options.voice_rate);
  dom.uploadedNarration.value = options.audio_path || "";
  dom.bgmMode.value = options.bgm_mode;
  dom.bgmStyle.value = options.bgm_style;
  dom.bgmPrompt.value = options.bgm_prompt;
  dom.bgmModel.value = options.bgm_model_id;
  dom.bgmPath.value = options.bgm_path || "";
  dom.narrationVolume.value = String(options.narration_volume);
  dom.bgmVolume.value = String(options.bgm_volume);
  dom.duckBgm.checked = options.duck_bgm;
  dom.sourceVolume.value = String(options.source_volume);
  applySubtitleControls(dom, options.subtitles);
  dom.subtitlePath.value = options.subtitle_path || "";
  dom.kenBurns.checked = options.ken_burns;
  dom.variants.value = String(options.variants);
  dom.footageOrder.value = options.order;
  updateMusicControls();
}

function updateScriptMeta() {
  const count = [...stringValue(dom.scriptEditor.value)].length;
  setText(dom.scriptMeta, `${count} 字 · ${state.shots.length} 个镜头${state.planDirty ? " · 生成时更新镜头" : ""}`);
  setText(dom.shotCountLabel, `${state.shots.length} 个镜头`);
  dom.replanButton.disabled = !state.ready || !state.planDirty || state.busy;
  dom.scriptStatus.className = `status-pill ${state.planDirty ? "warn" : state.shots.length ? "ok" : ""}`.trim();
  setText(dom.scriptStatus, state.planDirty ? "待更新分镜" : state.shots.length ? "已规划" : "未规划");
}

function renderContext() {
  const context = state.context;
  setText(dom.projectBadge, context.topic || "当前项目");
  dom.projectBadge.title = context.project_id || "";
  setText(dom.topicLabel, context.topic ? `主题：${context.topic}` : "当前提案");
  const proposal = context.selected_candidate_id
    ? "已沿用你选定的创意。修改文案后可直接生成，也可先更新分镜查看镜头与搜索词。"
    : "页面会沿用模型工作台刚选定的方案。你可以先改脚本，系统会重新规划镜头和自动搜索词。";
  setText(dom.proposalSummary, proposal);
  dom.scriptEditor.value = state.scriptText;
  updateScriptMeta();
}

function candidateIsGeneric(candidate) {
  const kind = stringValue(candidate?.match_kind).toLowerCase();
  return kind.includes("generic") || kind.includes("illustrative") || kind === "generic";
}

function candidateThumb(candidate) {
  return candidate?.thumbnail || "";
}

function renderCandidateCard(shot, candidate, index) {
  const wrapper = document.createElement("article");
  wrapper.className = `candidate-card${shot.source_path === candidate.path ? " selected" : ""}`;
  const thumbnail = candidateThumb(candidate);
  if (thumbnail) {
    const image = document.createElement("img");
    image.className = "candidate-thumb";
    image.alt = `${shot.title}候选素材预览`;
    image.src = assetUrl(state.projectId, thumbnail);
    image.addEventListener("error", () => {
      image.replaceWith(makeCandidatePlaceholder());
    }, { once: true });
    wrapper.appendChild(image);
  } else {
    wrapper.appendChild(makeCandidatePlaceholder());
  }
  const body = document.createElement("div");
  body.className = "candidate-body";
  const top = document.createElement("div");
  top.className = "candidate-topline";
  const badge = document.createElement("span");
  badge.className = `match-badge${candidateIsGeneric(candidate) ? " generic" : ""}`;
  badge.textContent = candidateIsGeneric(candidate) ? "通用氛围素材" : "地点检索候选（待核验）";
  top.appendChild(badge);
  const source = document.createElement("span");
  source.className = "small-note";
  source.textContent = candidate.source || "来源未标注";
  top.appendChild(source);
  body.appendChild(top);
  const meta = document.createElement("div");
  meta.className = "candidate-meta";
  const license = document.createElement("span");
  license.textContent = `许可：${candidate.license || "待核对"}`;
  const creator = document.createElement("span");
  creator.textContent = `作者：${candidate.creator || "未提供"}`;
  meta.append(license, creator);
  body.appendChild(meta);
  if (candidate.source_url && /^https?:\/\//i.test(candidate.source_url)) {
    const link = document.createElement("a");
    link.className = "candidate-source-link";
    link.href = candidate.source_url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "查看来源页面";
    body.appendChild(link);
  }
  const button = document.createElement("button");
  button.type = "button";
  button.className = "candidate-select";
  button.textContent = shot.source_path === candidate.path ? "当前选片" : "选用此素材";
  button.disabled = !candidate.path;
  button.addEventListener("click", () => {
    const target = state.shots.find((item) => item.id === shot.id);
    if (!target) return;
    target.source_path = candidate.path;
    target.selected_source = candidate;
    target.selection_mode = "manual";
    target.source_locked = true;
    state.shotsDirty = true;
    renderShots();
    setPageMessage("ok", `已将“${target.title}”换成${candidateIsGeneric(candidate) ? "通用" : "景点匹配"}素材；可以继续预览或生成初剪。`);
    updateActionButtons();
  });
  body.appendChild(button);
  wrapper.appendChild(body);
  return wrapper;
}

function makeCandidatePlaceholder() {
  const placeholder = document.createElement("div");
  placeholder.className = "candidate-placeholder";
  placeholder.textContent = "暂无缩略图";
  return placeholder;
}

function renderShotSourceOptions(select, shot) {
  const current = shot.source_path;
  clearNode(select);
  const missing = document.createElement("option");
  missing.value = "";
  missing.textContent = "未选片（等待素材）";
  select.appendChild(missing);
  const seen = new Set([""]);
  const assets = activeAssets().filter((asset) => asset.kind === "video" || asset.kind === "image");
  for (const asset of assets) {
    if (seen.has(asset.path)) continue;
    seen.add(asset.path);
    const option = document.createElement("option");
    option.value = asset.path;
    option.textContent = `${asset.origin === 'generated' ? '生成 / 剪辑产物' : '本机素材'}：${asset.label}`;
    select.appendChild(option);
  }
  for (const candidate of shot.candidates) {
    if (!candidate.path || seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    const option = document.createElement("option");
    option.value = candidate.path;
    option.textContent = `${candidateIsGeneric(candidate) ? "通用" : "景点"}：${candidate.source || "候选素材"}`;
    select.appendChild(option);
  }
  if (current && !seen.has(current)) {
    const option = document.createElement("option");
    option.value = current;
    option.textContent = `当前：${current}`;
    select.appendChild(option);
  }
  select.value = current;
}

function renderShotQueries(row, shot) {
  clearNode(row);
  const override = stringValue(shot.query_override);
  row.dataset.querySource = override ? "override" : "auto";
  const label = document.createElement("span");
  label.className = "query-label";
  label.textContent = override ? "实际搜索词" : "自动搜索词";
  row.appendChild(label);
  const primary = stringValue(shot.query);
  const fallbackDiffers = primary && !shot.queries.some(query => query.text === primary);
  if (override || fallbackDiffers) {
    const chip = document.createElement("span");
    chip.className = "query-chip";
    chip.textContent = override || primary;
    chip.title = override || primary;
    row.appendChild(chip);
    return;
  }
  const queries = shot.queries;
  if (!queries.length) {
    const chip = document.createElement("span");
    chip.className = "query-chip generic";
    chip.textContent = "将由服务端按主题补齐";
    row.appendChild(chip);
    return;
  }
  for (const query of queries.slice(0, 5)) {
    const chip = document.createElement("span");
    chip.className = `query-chip${query.kind === "generic" ? " generic" : ""}`;
    chip.textContent = `${query.kind === "generic" ? "通用" : "地点"}：${query.text}`;
    row.appendChild(chip);
  }
}

function renderShots() {
  clearNode(dom.shotList);
  if (!state.shots.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = state.scriptText ? "生成时会自动规划镜头；也可先点击“更新分镜”查看。" : "当前方案没有脚本，暂时无法规划镜头。";
    dom.shotList.appendChild(empty);
    updateScriptMeta();
    updateActionButtons();
    return;
  }
  state.shots.forEach((shot, index) => {
    const card = document.createElement("article");
    card.className = `shot-card${shot.source_path ? "" : " missing"}`;
    card.dataset.shotId = shot.id;
    const head = document.createElement("div");
    head.className = "shot-card-head";
    const number = document.createElement("span");
    number.className = "shot-index";
    number.textContent = String(index + 1).padStart(2, "0");
    const title = document.createElement("input");
    title.className = "shot-title-input";
    title.type = "text";
    title.value = shot.title;
    title.dataset.field = "title";
    title.setAttribute("aria-label", `镜头 ${index + 1} 标题`);
    head.append(number, title);
    card.appendChild(head);
    const text = document.createElement("textarea");
    text.className = "shot-text";
    text.rows = 3;
    text.value = shot.text;
    text.dataset.field = "text";
    text.setAttribute("aria-label", `镜头 ${index + 1} 旁白或画面说明`);
    card.appendChild(text);
    const fieldGrid = document.createElement("div");
    fieldGrid.className = "shot-field-grid";
    fieldGrid.appendChild(makeShotNumberField("时长（秒）", "duration_seconds", shot.duration_seconds, 0.5, 120));
    fieldGrid.appendChild(makeShotNumberField("入点（秒）", "start_seconds", shot.start_seconds, 0, 86400));
    card.appendChild(fieldGrid);
    const queryRow = document.createElement("div");
    queryRow.className = "shot-query-row";
    renderShotQueries(queryRow, shot);
    card.appendChild(queryRow);
    const advanced = document.createElement("details");
    advanced.className = "shot-advanced";
    const summary = document.createElement("summary");
    summary.textContent = "搜索词覆盖（可选）";
    advanced.appendChild(summary);
    const override = document.createElement("input");
    override.className = "shot-input";
    override.type = "text";
    override.placeholder = "留空则使用自动搜索词，例如：南北湖 湖面 日落";
    override.value = shot.query_override;
    override.dataset.field = "query_override";
    override.setAttribute("aria-label", `镜头 ${index + 1} 搜索词覆盖`);
    advanced.appendChild(override);
    card.appendChild(advanced);
    const sourceRow = document.createElement("div");
    sourceRow.className = "shot-source-row";
    const sourceLabel = document.createElement("span");
    sourceLabel.className = "field-label";
    sourceLabel.textContent = "当前选片";
    const sourceSelect = document.createElement("select");
    sourceSelect.className = "shot-source-select";
    sourceSelect.setAttribute("aria-label", `镜头 ${index + 1} 当前选片`);
    renderShotSourceOptions(sourceSelect, shot);
    sourceSelect.addEventListener("change", () => {
      shot.source_path = sourceSelect.value;
      shot.selected_source = shot.candidates.find((candidate) => candidate.path === shot.source_path) || null;
      shot.selection_mode = "manual";
      shot.source_locked = Boolean(shot.source_path);
      state.shotsDirty = true;
      card.classList.toggle("missing", !shot.source_path);
      updateActionButtons();
    });
    sourceRow.append(sourceLabel, sourceSelect);
    card.appendChild(sourceRow);
    if (shot.candidates.length) {
      const candidates = document.createElement("div");
      candidates.className = "candidate-grid";
      shot.candidates.slice(0, 6).forEach((candidate, candidateIndex) => candidates.appendChild(renderCandidateCard(shot, candidate, candidateIndex)));
      card.appendChild(candidates);
    }
    if (!shot.source_path || shot.selection_warning) {
      const warning = document.createElement("p");
      warning.className = "shot-warning";
      warning.textContent = shot.selection_warning || "这个镜头目前没有合适的选片。点击“只找素材”继续搜索，或导入你自己的视频/图片。";
      card.appendChild(warning);
    }
    dom.shotList.appendChild(card);
  });
  updateScriptMeta();
  updateActionButtons();
}

function makeShotNumberField(labelText, field, value, min, max) {
  const label = document.createElement("label");
  label.textContent = labelText;
  const input = document.createElement("input");
  input.className = "shot-input";
  input.type = "number";
  input.min = String(min);
  input.max = String(max);
  input.step = field === "duration_seconds" ? "0.1" : "0.1";
  input.value = String(value);
  input.dataset.field = field;
  label.appendChild(input);
  return label;
}

function findShotFromTarget(target) {
  const card = target?.closest?.("[data-shot-id]");
  if (!card) return null;
  return state.shots.find((shot) => shot.id === card.dataset.shotId) || null;
}

function handleShotInput(event) {
  const shot = findShotFromTarget(event.target);
  const field = event.target?.dataset?.field;
  if (!shot || !field) return;
  if (field === "title" || field === "text" || field === "query_override") {
    shot[field] = event.target.value;
    if (field === "query_override") {
      const row = event.target.closest("[data-shot-id]").querySelector(".shot-query-row");
      if (row) renderShotQueries(row, shot);
    }
  } else if (field === "duration_seconds") {
    shot.duration_seconds = finiteNumber(event.target.value, shot.duration_seconds, 0.5, 120);
  } else if (field === "start_seconds") {
    shot.start_seconds = finiteNumber(event.target.value, shot.start_seconds, 0, 86400);
    shot.selection_mode = "manual";
    shot.source_locked = Boolean(shot.source_path);
  }
  state.shotsDirty = true;
  updateActionButtons();
}

function mergeJobs(jobs) {
  const map = new Map();
  for (const job of [...(state.jobs || []), ...(Array.isArray(jobs) ? jobs : [])]) {
    const normalized = normalizeJobSnapshot(job);
    if (!normalized.job_id || !jobBelongsToProject(normalized, state.projectId)) continue;
    map.set(normalized.job_id, normalized);
  }
  state.jobs = [...map.values()].sort((a, b) => stringValue(b.created_at).localeCompare(stringValue(a.created_at)));
}

function historyStatusClass(status) {
  if (["completed", "stage_completed"].includes(status)) return "ok";
  if (["needs_materials", "awaiting_review", "queued", "running"].includes(status)) return "warn";
  if (["failed", "cancelled", "interrupted"].includes(status)) return "error";
  return "";
}

function renderHistory() {
  clearNode(dom.historyList);
  const jobs = state.jobs || [];
  setText(dom.historyCount, `${jobs.length} 条`);
  if (!jobs.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "尚无任务记录。点击“自动找素材”开始一个本地任务。";
    dom.historyList.appendChild(empty);
    return;
  }
  for (const job of jobs.slice(0, 100)) {
    const row = document.createElement("div");
    row.className = "history-row";
    const main = document.createElement("div");
    main.className = "history-row-main";
    const title = document.createElement("b");
    title.textContent = `${statusLabel(job.status)} · ${job.stage || "任务"}`;
    title.title = job.job_id;
    const detail = document.createElement("span");
    detail.textContent = `${job.job_id} · ${stringValue(job.message, "暂无说明")}`;
    main.append(title, detail);
    const side = document.createElement("div");
    side.className = "history-row-side";
    const status = document.createElement("span");
    status.className = `history-status ${historyStatusClass(job.status)}`.trim();
    status.textContent = statusLabel(job.status);
    const view = document.createElement("button");
    view.type = "button";
    view.className = "history-view";
    view.textContent = "查看回执";
    view.disabled = state.busy;
    view.title = state.busy ? "请先等待或取消当前任务，再查看其他回执" : "查看本机保存的任务回执";
    view.addEventListener("click", () => {
      state.pollToken += 1;
      state.currentJobId = job.job_id;
      state.currentJob = job;
      renderJobSnapshot(job, {syncShots: false});
      closeTaskManagerAt(dom.currentJobPanel);
    });
    const restore = document.createElement("button");
    restore.type = "button";
    restore.className = "history-view";
    restore.textContent = "恢复到编辑区";
    restore.title = "替换当前脚本、分镜和设置；不会执行任务";
    restore.disabled = state.busy;
    restore.addEventListener("click", async () => {
      try {
        const saved = job.request ? job : await getJSON(`/model-api/footage/jobs/${encodeURIComponent(job.job_id)}?project_id=${encodeURIComponent(state.projectId)}`);
        restoreJobSettings(saved);
        closeTaskManagerAt(dom.scriptEditor);
      } catch (error) {
        const message = `恢复设置失败：${error.message}`;
        showTaskFeedback(message);
        setPageMessage("error", message);
      }
    });
    side.append(status, view, restore);
    row.append(main, side);
    dom.historyList.appendChild(row);
  }
}

function restoreJobSettings(job) {
  if (state.busy) throw new Error("请先等待或取消当前任务，再恢复设置。");
  if (!jobBelongsToProject(job, state.projectId) || !isPlainObject(job.request)) throw new Error("这条回执没有当前项目的完整请求设置。");
  const request = job.request;
  state.scriptText = stringValue(request.script);
  state.context.topic = stringValue(request.topic, state.context.topic);
  state.shots = (Array.isArray(request.shots) && request.shots.length ? request.shots : job.shots || []).map(normalizeShot);
  state.planDirty = !state.shots.length;
  state.shotsDirty = true;
  dom.materialMode.value = request.material_mode || "mixed";
  dom.allowGeneric.checked = Boolean(request.allow_generic);
  state.availableSources = Array.isArray(request.sources) ? request.sources.slice() : [];
  for (const input of dom.sourceCapabilities.querySelectorAll("input")) input.checked = state.availableSources.includes(input.value);
  dom.stopAt.value = request.stop_at || "video";
  applyOptions(request.options || {});
  dom.networkConfirm.checked = false;
  state.currentJob = null;
  state.currentJobId = "";
  renderContext(); renderShots(); renderVoiceSelect();
  setPageMessage("ok", "历史脚本、分镜和设置已恢复到编辑区。任务尚未执行；在线旁白需要重新确认。");
}

function updateProductionSteps() {
  const scriptReady = Boolean(state.shots.length) && !state.planDirty;
  const hasMaterials = state.shots.some((shot) => Boolean(shot.source_path));
  const jobStatus = state.currentJob?.status || "";
  const exportReady = ["running", "awaiting_review", "completed", "stage_completed"].includes(jobStatus) && (hasMaterials || state.currentJob?.outputs?.length);
  const active = exportReady ? 3 : hasMaterials ? 2 : scriptReady ? 2 : 1;
  const steps = [[dom.stepScript, 1], [dom.stepMaterials, 2], [dom.stepExport, 3]];
  for (const [node, number] of steps) {
    node.classList.toggle("active", number === active);
    node.classList.toggle("done", number < active || (number === 3 && jobStatus === "completed"));
    if (number === active) node.setAttribute("aria-current", "step");
    else node.removeAttribute("aria-current");
  }
  dom.stepExport.href = state.currentJob ? "#jobHeading" : "#actionHeading";
}

function setPrimaryAction(primaryId) {
  if (isMoneyprinterLayout()) primaryId = "createButton";
  for (const button of [dom.collectButton, dom.createButton, dom.renderButton]) {
    if (!button) continue;
    const primary = button.id === primaryId;
    button.classList.toggle("primary-action", primary);
    button.classList.toggle("secondary-action", !primary);
  }
}

function isMoneyprinterLayout() {
  return typeof document !== "undefined" && document.body?.dataset?.studioLayout === "moneyprinter";
}

function hasSelectedMaterials() {
  return state.shots.some((shot) => Boolean(shot.source_path));
}

function networkSourceRequired() {
  return dom.materialMode.value !== "local";
}

function sourceSelectionValid() {
  if (dom.materialMode.value === "local") return true;
  return state.availableSources.length > 0;
}

function updateActionButtons() {
  if (!dom || !state) return;
  dom.actionHint.classList.remove("error");
  const disabledByState = !state.ready || state.busy || state.planBusy || !state.scriptText.trim();
  const canCollect = !disabledByState && sourceSelectionValid();
  const soundOnly = ["audio", "subtitle"].includes(dom.stopAt.value);
  const textOnly = ["script", "terms"].includes(dom.stopAt.value);
  if (dom.networkConfirmRow) dom.networkConfirmRow.hidden = !actionNeedsNarration("create") || dom.narrationMode.value !== "edge";
  const canCreate = !disabledByState && (textOnly || soundOnly || hasSelectedMaterials() || (networkSourceRequired() && sourceSelectionValid()));
  const reviewReady = ["awaiting_review", "completed"].includes(state.currentJob?.status || "");
  const canRender = !disabledByState && !state.planDirty && state.shots.length > 0 && (textOnly || soundOnly || state.shots.every((shot) => Boolean(shot.source_path)));
  dom.createButton.textContent = state.busy && state.busyAction === "create" ? "制作中…" : textOnly ? (dom.stopAt.value === "script" ? "保存当前文案" : "整理镜头关键词") : soundOnly ? (dom.stopAt.value === "audio" ? "生成旁白" : "生成旁白与字幕") : dom.stopAt.value === "materials" ? "生成素材" : "生成视频";
  dom.renderButton.textContent = state.busy && state.busyAction === "render" ? "导出中…" : textOnly ? "导出当前文案与关键词" : soundOnly ? "按当前设置制作声音" : dom.stopAt.value === "materials" ? "按当前选片准备素材" : "导出当前选片";
  dom.collectButton.textContent = state.busy && state.busyAction === "collect" ? "查找中…" : "只找素材";
  dom.collectButton.disabled = !canCollect;
  dom.createButton.disabled = !canCreate;
  dom.renderButton.disabled = !canRender;
  const canCancel = Boolean(state.currentJob) && !isTerminalStatus(state.currentJob.status) && state.busy;
  dom.cancelButton.hidden = isMoneyprinterLayout() ? false : !canCancel;
  dom.cancelButton.disabled = !canCancel;
  const currentMode = dom.materialMode.value;
  if (!state.ready) {
    setText(dom.actionHint, state.projectId ? "正在读取当前项目……" : "先选择已有项目或新建作品，再生成视频。");
  } else if (state.planDirty) {
    setText(dom.actionHint, "脚本已修改。生成时会更新镜头与搜索词；也可先更新分镜查看。");
  } else if (textOnly) {
    setText(dom.actionHint, "只保存当前文案或整理当前镜头的关键词；不联网找素材、不制作配音，也不调用 AI 改写文案。");
  } else if (dom.narrationMode.value === "edge" && !dom.networkConfirm.checked) {
    setText(dom.actionHint, "在线配音需要先在音频设置中确认：将本次脚本文本发送给 Edge。");
  } else if (soundOnly) {
    setText(dom.actionHint, "按当前脚本制作声音，无需先导入或搜索视频；完成后可下载旁白和字幕。");
  } else if (!sourceSelectionValid() && currentMode !== "local") {
    setText(dom.actionHint, "当前没有可用公开素材源；请改为只用本机素材并先导入视频或图片。");
  } else if (!hasSelectedMaterials() && currentMode === "local") {
    setText(dom.actionHint, "请先在视频设置中导入本机素材，再展开下方“镜头与选片”确认各镜头素材。");
  } else if (!hasSelectedMaterials()) {
    setText(dom.actionHint, "点击“生成视频”可自动搜索并制作；也可先“只找素材”，在下方镜头与选片中检查。");
  } else if (!reviewReady) {
    setText(dom.actionHint, "已有选片。点击“生成视频”制作，或按当前选片直接导出。");
  } else {
    setText(dom.actionHint, "可以继续替换当前选片，或按复核后的设置导出最终文件。");
  }
  if (canRender) setPrimaryAction("renderButton");
  else if (canCreate) setPrimaryAction("createButton");
  else setPrimaryAction("collectButton");
  updateProductionSteps();
}

function setBusy(busy, action = "") {
  state.busy = Boolean(busy);
  state.busyAction = action;
  dom.collectButton.setAttribute("aria-busy", state.busy && action === "collect" ? "true" : "false");
  dom.createButton.setAttribute("aria-busy", state.busy && action === "create" ? "true" : "false");
  dom.renderButton.setAttribute("aria-busy", state.busy && action === "render" ? "true" : "false");
  updateActionButtons();
}

function renderMissingShots(snapshot) {
  const ids = Array.isArray(snapshot?.missing_shots) ? snapshot.missing_shots : [];
  clearNode(dom.missingShots);
  if (!ids.length) {
    dom.missingShots.hidden = true;
    return;
  }
  dom.missingShots.hidden = false;
  const heading = document.createElement("b");
  heading.textContent = "还缺这些镜头的真实素材：";
  dom.missingShots.appendChild(heading);
  const list = document.createElement("ul");
  for (const id of ids) {
    const item = document.createElement("li");
    const shot = state.shots.find((row) => row.id === id);
    item.textContent = shot ? `${shot.title}（${shot.queries.map((query) => query.text).join("、") || "等待自动搜索"}）` : id;
    list.appendChild(item);
  }
  dom.missingShots.appendChild(list);
}

function outputPath(output, key) {
  return stringValue(output?.[key]);
}

function addOutputLink(container, projectId, label, path, download = false) {
  if (!path) return;
  const link = document.createElement("a");
  link.href = assetUrl(projectId, path);
  if (download) link.download = "";
  link.textContent = label;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  container.appendChild(link);
}

function outputMedia(output) {
  const path = outputPath(output, "output_path");
  const video = /\.(mp4|webm|mov|mkv)$/i.test(path) ? path : "";
  const audio = outputPath(output, "audio_path") || (/\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(path) ? path : "");
  const media = { video, audio, subtitle: outputPath(output, "subtitle_path") };
  if (outputPath(output, "script_path")) media.script = outputPath(output, "script_path");
  if (outputPath(output, "terms_path")) media.terms = outputPath(output, "terms_path");
  return media;
}

function canvasCutUrl(projectId, jobId, output) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(projectId) || !/^footage-[a-f0-9]{24}$/.test(jobId)) return "";
  const match = stringValue(output?.canvas_cut_path).match(/^renders\/(footage-[a-f0-9]{24})\/version-([1-5])\/canvas-cut\.json$/);
  if (!match || match[1] !== jobId || output?.status !== "completed" || !outputMedia(output).video) return "";
  return `/canvas?${new URLSearchParams({project:projectId,cut:jobId,version:match[2]})}`;
}

function renderOutputs(snapshot) {
  const outputs = Array.isArray(snapshot?.outputs) ? snapshot.outputs : [];
  const signature = JSON.stringify(outputs);
  if (dom.outputArea.dataset.signature === signature) return;
  dom.outputArea.dataset.signature = signature;
  clearNode(dom.outputArea);
  dom.outputArea.hidden = !outputs.length;
  for (const [index, first] of outputs.entries()) {
    const media = outputMedia(first);
    const outputInfo = document.createElement("div");
    outputInfo.className = "output-info";
    const title = document.createElement("h3");
    title.textContent = media.video ? (outputs.length > 1 ? `初剪版本 ${index + 1} / ${outputs.length}` : "初剪输出") : media.terms ? "文案与镜头关键词" : media.script ? "当前文案" : media.subtitle ? "旁白与字幕输出" : "旁白输出";
    outputInfo.appendChild(title);
    const meta = document.createElement("div");
    meta.className = "output-meta";
    const duration = finiteNumber(first.duration_seconds, 0, 0);
    meta.append(media.script ? (media.terms ? `${first.terms_count || 0} 个搜索词` : "已确认文案 · 本地保存") : duration ? `${duration.toFixed(2)} 秒` : "时长等待回执");
    if (media.video && first.width && first.height) meta.append(`${first.width} × ${first.height}`);
    meta.append(`本地文件：${media.video || media.audio || media.subtitle || media.script || "未返回"}`);
    outputInfo.appendChild(meta);
    const links = document.createElement("div");
    links.className = "output-links";
    addOutputLink(links, state.projectId, "下载视频", media.video, true);
    addOutputLink(links, state.projectId, "下载旁白", media.audio, true);
    addOutputLink(links, state.projectId, "下载 SRT", media.subtitle, true);
    addOutputLink(links, state.projectId, "下载文案", media.script, true);
    addOutputLink(links, state.projectId, "下载镜头关键词", media.terms, true);
    const canvasUrl = canvasCutUrl(state.projectId, snapshot?.job_id, first);
    if (canvasUrl) {
      const canvasLink = document.createElement("a");
      canvasLink.href = canvasUrl; canvasLink.textContent = "在画布中继续剪辑 →";
      canvasLink.title = "带入这版实际选片、裁剪位置、旁白与音乐；建立独立剪辑版本";
      links.appendChild(canvasLink);
    }
    for (const [label, key] of [["查看剪辑决策", "edit_path"], ["查看来源与许可", "provenance_path"], ["查看来源清单", "sources_path"], ["查看参考节奏对照", "reference_timing_path"]]) addOutputLink(links, state.projectId, label, outputPath(first, key), true);
    outputInfo.appendChild(links);
    const note = document.createElement("p");
    note.className = "output-warning";
    note.textContent = media.video ? "请播放视频、试听旁白，并核对来源许可后再交付。" : media.script ? "保存当前文案与本地整理的搜索词，未调用 AI 生成新文案或下载素材。可修改后继续制作。" : "本阶段只生成声音或字幕。请试听，并核对字幕文字与时间。";
    outputInfo.appendChild(note);
    if (media.video || media.audio) {
      const player = document.createElement(media.video ? "video" : "audio");
      player.className = media.video ? "output-video" : "output-audio";
      player.controls = true;
      player.preload = "metadata";
      player.src = assetUrl(state.projectId, media.video || media.audio);
      player.setAttribute("aria-label", media.video ? "真实素材初剪预览" : "旁白预览");
      player.addEventListener("error", () => { note.textContent = "文件路径已返回，浏览器无法播放；请下载后用本机播放器检查。"; note.classList.add("error"); }, { once: true });
      dom.outputArea.appendChild(player);
    }
    dom.outputArea.appendChild(outputInfo);
  }
}

function materialCoverageText(value) {
  if (!isPlainObject(value) || value.evidence !== "probed_selected_windows") return "";
  const {required_seconds:required, covered_seconds:covered, total_shots:total, ready_shots:ready} = value;
  if (![required,covered].every(Number.isFinite) || required <= 0 || covered < 0 || covered > required
      || !Number.isInteger(total) || total < 1 || !Number.isInteger(ready) || ready < 0 || ready > total) return "";
  const format = number => new Intl.NumberFormat("zh-CN", {maximumFractionDigits: 2}).format(number);
  const still = Array.isArray(value.rows) && value.rows.some(row => row?.reason === "probed_still_image_hold");
  return `片段时长核对：${format(covered)}/${format(required)} 秒（${ready}/${total} 镜头可用）${still ? "，含静态图片定格" : ""}。仍需逐镜核对地点、内容与许可。`;
}

function renderJobSnapshot(snapshot, {syncShots = true} = {}) {
  const job = normalizeJobSnapshot(snapshot);
  if (!jobBelongsToProject(job, state.projectId, state.currentJobId || job.job_id)) return false;
  state.currentJob = job;
  if (syncShots && job.shots.length) {
    state.shots = job.shots.map(normalizeShot);
    renderShots();
  }
  dom.currentJobPanel.hidden = false;
  dom.jobStatus.className = `status-pill ${historyStatusClass(job.status)}`.trim();
  setText(dom.jobStatus, statusLabel(job.status));
  const progress = finiteNumber(job.progress, 0, 0, 100);
  dom.jobProgressBar.style.width = `${progress}%`;
  setText(dom.jobProgressValue, `${Math.round(progress)}%`);
  setText(dom.jobMessage, job.message || `${statusLabel(job.status)}。`);
  const coverageText = materialCoverageText(job.material_coverage);
  setText(dom.materialCoverage, coverageText);
  dom.materialCoverage.hidden = !coverageText;
  renderMissingShots(job);
  dom.jobWarnings.replaceChildren(...(job.warnings || []).map(text=>{const li=document.createElement("li");li.textContent=text;return li;}));
  dom.jobWarnings.hidden = !(job.warnings || []).length;
  renderOutputs(job);
  mergeJobs([job]);
  renderHistory();
  updateActionButtons();
  if (job.status === "needs_materials") setPageMessage("warn", job.message || "部分镜头仍缺少真实素材，请补充后重试。");
  else if (job.status === "failed") setPageMessage("error", job.message || "任务失败，请检查素材和本机运行环境。");
  else if (job.status === "stage_completed") setPageMessage("ok", job.message || "本阶段已完成，可下载本阶段文件；尚未生成完整视频。");
  else if (job.status === "completed") setPageMessage("ok", "本地初剪已返回；请播放、试听和核对来源后再导出或交付。");
  return true;
}

function stopPolling() {
  state.pollToken += 1;
  if (state.pollTimer) window.clearTimeout(state.pollTimer);
  state.pollTimer = null;
}

function pollJob(jobId, projectId) {
  stopPolling();
  const token = state.pollToken;
  const tick = async () => {
    if (token !== state.pollToken || state.projectId !== projectId || state.currentJobId !== jobId) return;
    try {
      const snapshot = await getJSON(`/model-api/footage/jobs/${encodeURIComponent(jobId)}?project_id=${encodeURIComponent(projectId)}`);
      if (!jobBelongsToProject(snapshot, projectId, jobId)) return;
      renderJobSnapshot(snapshot);
      if (!isTerminalStatus(snapshot.status)) {
        state.pollTimer = window.setTimeout(tick, 1400);
      } else {
        setBusy(false);
      }
    } catch (error) {
      if (token !== state.pollToken) return;
      setPageMessage("error", `任务状态读取失败：${error.message}`);
      setBusy(false);
    }
  };
  void tick();
}

async function planStoryboard({ force = false } = {}) {
  if (!state.scriptText.trim()) throw new Error("当前脚本为空，请先补充脚本。");
  if (!force && !state.planDirty && state.shots.length) return true;
  const omitShots = state.planDirty || !state.shots.length;
  const payload = buildPlanRequest({
    projectId: state.projectId,
    topic: state.context.topic,
    script: state.scriptText,
    shots: state.shots,
    omitShots,
    materialMode: dom.materialMode.value,
    allowGeneric: dom.allowGeneric.checked,
    options: currentOptions("collect"),
    sources: state.availableSources,
    confirmNetwork: true,
    stop_at: dom.stopAt.value,
  });
  state.planBusy = true;
  updateActionButtons();
  try {
    const planned = await postJSON("/model-api/footage/plan", payload);
    await postJSON("/model-api/footage/draft", {...payload, shots:planned.shots.map(requestShot)});
    if (state.projectId !== payload.project_id) return false;
    const rows = Array.isArray(planned?.shots) ? planned.shots.map(normalizeShot) : [];
    if (!rows.length) throw new Error("服务端没有返回可编辑镜头。");
    state.shots = rows;
    state.scriptText = stringValue(planned.script, state.scriptText);
    state.planDirty = false;
    state.shotsDirty = false;
    state.context.topic = stringValue(planned.topic, state.context.topic);
    state.missingShots = Array.isArray(planned.missing_shots) ? planned.missing_shots : [];
    dom.scriptEditor.value = state.scriptText;
    renderShots();
    setPageMessage("ok", planned.summary || "分镜已更新；自动搜索词已准备。");
    return true;
  } finally {
    state.planBusy = false;
    updateActionButtons();
  }
}

function actionNeedsNetwork(action) {
  return (action === "collect" || !["script", "terms", "audio", "subtitle"].includes(dom.stopAt.value)) && dom.materialMode.value !== "local" && action !== "render";
}

function actionNeedsNarration(action) {
  return action !== "collect" && !["script", "terms", "materials"].includes(dom.stopAt.value);
}

function currentRequest(action = "create", authorized = false) {
  return buildJobPayload({
    projectId: state.projectId, topic: state.context.topic, script: state.scriptText,
    shots: state.shots, sources: dom.materialMode.value === "local" ? [] : state.availableSources,
    materialMode: dom.materialMode.value, allowGeneric: dom.allowGeneric.checked,
    options: currentOptions(action), stop_at: action === "collect" ? "materials" : dom.stopAt.value,
    confirmNetwork: authorized && (actionNeedsNetwork(action) || actionNeedsNarration(action) && dom.narrationMode.value === "edge" ? true : dom.networkConfirm.checked),
    requestId: randomRequestId(), action,
  });
}

function networkConfirmationValid(action) {
  if (actionNeedsNarration(action) && dom.narrationMode.value === "edge" && !dom.networkConfirm.checked) {
    setPageMessage("warn", "在线旁白会把脚本文本发送到外部服务，请先勾选网络确认。");
    return false;
  }
  if (actionNeedsNetwork(action) && !state.availableSources.length) {
    setPageMessage("warn", "当前没有可用公开素材源，请改为只用本机素材并导入视频或图片。");
    return false;
  }
  return true;
}

async function submitJob(action) {
  if (state.busy || state.planBusy || !state.ready) return;
  if (!networkConfirmationValid(action)) return;
  try {
    setBusy(true, action);
    setPageMessage("", action === "collect" ? "正在提交自动找素材任务……" : action === "create" ? "正在提交初剪任务……" : "正在提交导出任务……");
    const planned = await planStoryboard();
    if (!planned) return;
    const payload = currentRequest(action, true);
    if (paidMusicRequested(payload)) {
      if (!musicReview || musicReview.key !== musicReviewKey(payload)) throw new Error("音乐描述、旁白或镜头已变化，请重新预检发送文字与费用后授权。");
      if (!musicReview.result.ready) throw new Error((musicReview.result.errors || []).join("；") || "音乐服务尚不可用，请配置后重新预检。");
      payload.options = musicSubmissionOptions(payload, {budget: dom.bgmBudget.value,
        paid: dom.bgmConfirmPaid.checked, text: dom.bgmConfirmText.checked, billing: dom.bgmBillingLimit.checked});
    }
    const snapshot = await postJSON("/model-api/footage/jobs", payload);
    if (paidMusicRequested(payload)) resetMusicConsent();
    if (!jobBelongsToProject(snapshot, state.projectId)) throw new Error("任务回执不属于当前项目，已忽略。");
    state.currentJobId = stringValue(snapshot.job_id);
    if (!state.currentJobId) throw new Error("服务端没有返回任务编号。");
    renderJobSnapshot(snapshot);
    dom.currentJobPanel.scrollIntoView({behavior:"smooth",block:"start"});
    if (!isTerminalStatus(snapshot.status)) pollJob(state.currentJobId, state.projectId);
    else setBusy(false);
  } catch (error) {
    setBusy(false);
    setPageMessage("error", error.message || "任务提交失败");
  }
}

async function cancelCurrentJob() {
  const jobId = state.currentJobId;
  if (!jobId || !state.currentJob || isTerminalStatus(state.currentJob.status)) return;
  try {
    const snapshot = await postJSON(`/model-api/footage/jobs/${encodeURIComponent(jobId)}/cancel`, { project_id: state.projectId });
    if (!jobBelongsToProject(snapshot, state.projectId, jobId)) return;
    renderJobSnapshot(snapshot);
    setBusy(false);
  } catch (error) {
    setPageMessage("error", `取消任务失败：${error.message}`);
  }
}

async function uploadSelectedFiles(event) {
  const files = [...(event.target.files || [])];
  if (!files.length) return;
  if (!state.projectId) return;
  setText(dom.uploadStatus, `正在导入 ${files.length} 个文件……`);
  dom.uploadStatus.className = "inline-status";
  let imported = 0;
  for (const file of files) {
    try {
      const path = `/model-api/footage/upload?project_id=${encodeURIComponent(state.projectId)}&filename=${encodeURIComponent(file.name)}&role=${encodeURIComponent(document.getElementById("uploadAudioRole").value)}`;
      const response = await fetch(path, {
        method: "POST",
        credentials: "same-origin",
        headers: { Accept: "application/json", "Content-Type": "application/octet-stream" },
        body: file,
      });
      const contentType = response.headers?.get?.("content-type") || "";
      const result = contentType.includes("application/json") ? await response.json() : {};
      if (!response.ok) throw new Error(stringValue(result?.detail, `导入失败（${response.status}）`));
      state.assets.push(normalizeAsset(result));
      imported += 1;
    } catch (error) {
      setText(dom.uploadStatus, `${file.name} 导入失败：${error.message}`);
      dom.uploadStatus.className = "inline-status error";
    }
  }
  if (imported) {
    setText(dom.uploadStatus, `已导入 ${imported} 个文件，可在镜头和声音选择器中使用。`);
    dom.uploadStatus.className = "inline-status";
    renderAssets();
    renderShots();
    setPageMessage("ok", `已将 ${imported} 个本机文件加入当前项目。`);
  }
  event.target.value = "";
}

async function voicePreview() {
  const mode = dom.narrationMode.value;
  if (mode === "none" || mode === "uploaded") return;
  if (mode === "edge" && !dom.networkConfirm.checked) {
    setPageMessage("warn", "试听在线旁白前，请确认脚本文本会发送到外部服务。");
    return;
  }
  const textMode = dom.voicePreviewMode.value;
  const text = textMode === "full" ? state.scriptText.trim() : state.scriptText.trim().slice(0, 200);
  if (!text) {
    setPageMessage("warn", "当前脚本为空，无法试听。");
    return;
  }
  dom.voicePreviewButton.disabled = true;
  setText(dom.voiceStatus, "正在生成本机试听……");
  const signature = previewSignature();
  let returned = false;
  try {
    const result = await postJSON("/model-api/footage/voice-preview", {
      project_id: state.projectId,
      text,
      voice: dom.voiceSelect.value,
      narration: mode,
      voice_rate: Number(dom.voiceRate.value),
      confirm_network: mode === "edge" ? dom.networkConfirm.checked : true,
      text_mode: textMode,
    });
    if (result?.path) {
      dom.voicePreviewAudio.src = assetUrl(state.projectId, result.path);
      dom.voicePreviewAudio.hidden = false;
      state.voicePreview = {...result, signature};
      returned = true;
      setText(dom.voiceStatus, "试听已返回；真实成片仍会按每段旁白实测时长剪辑。");
    } else {
      setText(dom.voiceStatus, "服务端没有返回可播放试听文件。");
    }
  } catch (error) {
    setText(dom.voiceStatus, `试听失败：${error.message}`);
  } finally {
    renderVoiceSelect();
    if (returned) setText(dom.voiceStatus, `试听已返回${state.voicePreview.duration_seconds ? ` · 实测 ${Number(state.voicePreview.duration_seconds).toFixed(1)} 秒` : ""}。完整试听可手动选为旁白。`);
  }
}

async function exportSettings() {
  getElement("settingsImportReport")?.replaceChildren();
  try {
    const current = currentOptions("render");
    await postJSON(`/model-api/footage/settings/${encodeURIComponent(state.projectId)}`, current);
    const remote = current;
    const settings = sanitizeSettings(remote);
    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `footage-settings-${state.projectId}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    const message = "设置已导出；文件中不包含密钥、令牌或密码。";
    showSettingsFeedback("ok", message);
    setPageMessage("ok", message);
  } catch (error) {
    const message = `设置导出失败：${error.message}`;
    showSettingsFeedback("error", message);
    setPageMessage("error", message);
  }
}

async function importSettings(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  const report = document.getElementById("settingsImportReport");
  report.replaceChildren();
  try {
    const parsed = JSON.parse((await file.text()).replace(/^\uFEFF/, ""));
    const isMpt = isPlainObject(parsed) && ("params" in parsed || stringValue(parsed.schema).startsWith("moneyprinterturbo."));
    const conversion = isMpt ? convertMptSettings(parsed, {assets: state.assets, voices: state.capabilities.voices || []}) : null;
    if (conversion) {
      const heading = document.createElement("b");
      heading.textContent = conversion.unsupported.length ? "以下选项无法等价导入，本次未更改设置：" : "本次仅导入下列可对应的样式设置：";
      report.appendChild(heading);
      for (const line of [...conversion.mappings, ...conversion.unsupported, ...conversion.notes]) { const item = document.createElement("div"); item.className = "batch-row"; item.textContent = line; report.appendChild(item); }
      if (conversion.unsupported.length) throw new Error("预设包含主流程不能等价表达的选项。请查看逐项说明，改用扩展高级剪辑或调整预设后导入。");
      if (!conversion.mappings.length) throw new Error("此预设没有可导入的本页样式设置；当前设置未更改。");
    }
    const imported = conversion ? conversion.options : sanitizeSettings(parsed);
    const merged = normalizeOptions({ ...currentOptions("render"), ...imported, subtitles: { ...currentOptions("render").subtitles, ...(imported.subtitles || {}) } }, "render");
    const saved = await postJSON(`/model-api/footage/settings/${encodeURIComponent(state.projectId)}`, merged);
    applyOptions(saved?.options || merged);
    if (conversion?.options.narration === "edge") dom.networkConfirm.checked = false;
    const message = conversion ? `已映射并保存 ${conversion.mappings.length} 项本页样式；未导入字段见说明，尚未执行任务。` : "设置已导入并保存到当前项目。";
    showSettingsFeedback("ok", message);
    setPageMessage("ok", message);
  } catch (error) {
    const message = `设置未导入：${error.message}`;
    showSettingsFeedback("error", message);
    setPageMessage("error", message);
  }
}

async function loadProject() {
  const revision = ++state.loadRevision;
  if (!state.projectId) {
    setPageMessage("", "请选择已有项目，或从新建作品开始。这里会承接项目当前的文案和素材。");
    setText(dom.projectBadge, "未选择项目");
    setText(dom.scriptStatus, "未选择项目");
    dom.projectRequired.hidden = false;
    updateActionButtons();
    void loadProjectChoices();
    return;
  }
  const encoded = encodeURIComponent(state.projectId);
  const results = await Promise.allSettled([
    getJSON(`/model-api/footage/context/${encoded}`),
    getJSON("/model-api/footage/capabilities"),
    getJSON(`/model-api/footage/jobs?project_id=${encoded}`),
  ]);
  if (revision !== state.loadRevision) return;
  const contextResult = results[0];
  if (contextResult.status === "rejected") {
    setPageMessage("error", `当前项目读取失败：${contextResult.reason?.message || "未知错误"}`);
    state.ready = false;
    dom.projectRequired.hidden = false;
    void loadProjectChoices();
    updateActionButtons();
    return;
  }
  dom.projectRequired.hidden = true;
  state.context = normalizeContext(contextResult.value);
  state.scriptText = state.context.script;
  state.shots = state.context.shots;
  state.assets = state.context.assets;
  state.planDirty = false;
  state.shotsDirty = false;
  const capabilityResult = results[1];
  if (capabilityResult.status === "fulfilled") renderCapabilities(capabilityResult.value);
  else setPageMessage("warn", `能力清单读取失败，仍可使用已导入素材：${capabilityResult.reason?.message || "未知错误"}`);
  if (!state.context.settings || !Object.keys(state.context.settings).length) {
    dom.narrationMode.value=availableVoices(false).length ? "local" : "none";
    renderVoiceSelect();
  }
  const jobsResult = results[2];
  mergeJobs([...(state.context.jobs || []), ...(jobsResult.status === "fulfilled" ? (jobsResult.value?.jobs || []) : [])]);
  renderContext();
  renderAssets();
  if (state.context.settings) {
    try { applyOptions(sanitizeSettings(state.context.settings)); } catch (_) { /* Invalid saved options are ignored safely. */ }
  }
  renderShots();
  renderHistory();
  state.ready = true;
  renderVoiceSelect();
  import("./footage-extensions.js").then(m => m.initExtensions({
    projectId: state.projectId,
    onScriptCandidate: async ({script, terms}) => {
      if (state.busy) throw new Error("请先等待或取消当前制作任务，再应用脚本。");
      dom.scriptEditor.value = script;
      dom.scriptEditor.dispatchEvent(new Event("input", {bubbles: true}));
      await planStoryboard({force: true});
      if (Array.isArray(terms) && terms.length) {
        state.shots.forEach((shot, index) => {shot.query = String(terms[index % terms.length] || ""); shot.query_override = shot.query;});
        state.shotsDirty = true; renderShots();
      }
      setPageMessage("ok", "候选脚本已采用并重新规划分镜；关键词已分配给新镜头。");
    },
    onTerms: terms => {if (!terms.length) return; state.shots.forEach((shot, index) => {shot.query = String(terms[index % terms.length] || ""); shot.query_override = shot.query;}); state.shotsDirty = true; renderShots(); setPageMessage("ok", "关键词已分配，可继续自动找素材。");},
    onAssetsChanged: assets => {state.assets = assets.map(normalizeAsset); renderAssets(); renderShots();},
  })).catch(() => {dom.extendedServicesStatus.textContent = "扩展面板加载失败，可刷新后重试。";});
  import("./footage-batch.js").then(() => globalThis.FootageBatch.initBatchUI({projectId: state.projectId, getCurrentRequest: () => currentRequest("create"), onJob: job => {state.currentJobId = job.job_id; renderJobSnapshot(job, {syncShots: false});}})).catch(() => {document.getElementById("batchPreflightResults").textContent = "批量面板加载失败，请刷新重试。";});
  setPageMessage("ok", "当前项目已读取。检查文案与设置后，点击“生成视频”。");
  updateActionButtons();
  // Restore read-only progress for a running job. Polling never submits work.
  const latest = state.jobs[0];
  if (latest) {
    state.currentJobId = latest.job_id;
    renderJobSnapshot(latest, {syncShots: false});
  }
  const running = state.jobs.find(job => !isTerminalStatus(job.status));
  if (running) {
    state.currentJobId = running.job_id;
    setBusy(true, running.request?.action || "create");
    renderJobSnapshot(running);
    pollJob(running.job_id, state.projectId);
  }
}

async function loadProjectChoices() {
  try {
    const projects = await getJSON("/api/projects");
    clearNode(dom.projectPicker);
    const empty = document.createElement("option");
    empty.value = ""; empty.textContent = "选择已有项目";
    dom.projectPicker.appendChild(empty);
    for (const project of Array.isArray(projects) ? projects : []) {
      if (!project?.project_id) continue;
      const option = document.createElement("option");
      option.value = String(project.project_id); option.textContent = String(project.title || project.project_id);
      dom.projectPicker.appendChild(option);
    }
    setText(dom.projectPickerStatus, dom.projectPicker.options.length > 1 ? "选择项目后进入当前制作页，不会自动执行任务。" : "尚无已有项目，请点击“新建作品”。");
  } catch (error) {
    clearNode(dom.projectPicker);
    const empty = document.createElement("option"); empty.value = ""; empty.textContent = "项目列表暂不可用";
    dom.projectPicker.appendChild(empty);
    setText(dom.projectPickerStatus, "项目列表读取失败，可从项目库选择，或新建作品。");
  }
  dom.selectProjectButton.disabled = !dom.projectPicker.value;
}

function bindFootageDialogs() {
  for (const [opener, dialog] of [[dom.openTaskManagerButton, dom.taskManagerDialog], [dom.openSettingsButton, dom.settingsDialog]]) {
    opener.addEventListener("click", () => {
      if (dialog.open) return;
      dialog.querySelector(".dialog-feedback")?.remove();
      dialog.showModal();
    });
    dialog.addEventListener("close", () => {
      const destination = dialog.footageDestination;
      dialog.footageDestination = null;
      if (destination) focusFootageArea(destination);
      else opener.focus({preventScroll: true});
    });
    for (const button of dialog.querySelectorAll("[data-close-dialog]")) {
      button.addEventListener("click", () => { dialog.close(); });
    }
  }
}

function bindEvents() {
  bindFootageDialogs();
  dom.projectPicker.addEventListener("change", () => { dom.selectProjectButton.disabled = !dom.projectPicker.value; });
  dom.selectProjectButton.addEventListener("click", () => { if (dom.projectPicker.value) window.location.assign(`/footage?project=${encodeURIComponent(dom.projectPicker.value)}`); });
  dom.scriptEditor.addEventListener("input", () => {
    state.scriptText = dom.scriptEditor.value;
    state.planDirty = true;
    updatePreviewReuse();
    updateScriptMeta();
    setPageMessage("warn", "文案已修改。点击“生成视频”会自动更新镜头与搜索词；也可先更新分镜查看。");
    updateActionButtons();
  });
  dom.replanButton.addEventListener("click", async () => {
    if (state.busy || state.planBusy) return;
    try {
      setPageMessage("", "正在按新的脚本重新规划镜头……");
      await planStoryboard({ force: true });
    } catch (error) {
      setPageMessage("error", `分镜更新失败：${error.message}`);
    }
  });
  dom.shotList.addEventListener("input", handleShotInput);
  dom.materialMode.addEventListener("change", updateActionButtons);
  dom.allowGeneric.addEventListener("change", updateActionButtons);
  dom.narrationMode.addEventListener("change", renderVoiceSelect);
  dom.voiceSelect.addEventListener("change", updatePreviewReuse);
  dom.voiceRate.addEventListener("input", updatePreviewReuse);
  dom.stopAt.addEventListener("change", updateActionButtons);
  dom.uploadedNarration.addEventListener("change", renderVoiceSelect);
  dom.bgmMode.addEventListener("change", updateMusicControls);
  dom.bgmPrompt.addEventListener("input", resetMusicConsent);
  dom.bgmModel.addEventListener("change", resetMusicConsent);
  dom.bgmPreflightButton.addEventListener("click", () => { void previewPaidMusic(); });
  dom.networkConfirm.addEventListener("change", updateActionButtons);
  dom.assetUpload.addEventListener("change", (event) => { void uploadSelectedFiles(event); });
  dom.voicePreviewButton.addEventListener("click", () => { void voicePreview(); });
  dom.reuseVoicePreviewButton.addEventListener("click", reuseVoicePreview);
  dom.exportSettingsButton.addEventListener("click", () => { void exportSettings(); });
  dom.importSettingsInput.addEventListener("change", (event) => { void importSettings(event); });
  dom.collectButton.addEventListener("click", () => { void submitJob("collect"); });
  dom.createButton.addEventListener("click", () => { void submitJob("create"); });
  dom.renderButton.addEventListener("click", () => { void submitJob("render"); });
  dom.cancelButton.addEventListener("click", () => { void cancelCurrentJob(); });
}

function initFootageUI() {
  bindDom();
  state = {
    projectId: projectIdFromSearch(window.location.search),
    context: normalizeContext({}),
    scriptText: "",
    shots: [],
    assets: [],
    jobs: [],
    capabilities: {},
    availableSources: [],
    currentJob: null,
    currentJobId: "",
    busy: false,
    busyAction: "",
    planBusy: false,
    planDirty: false,
    shotsDirty: false,
    ready: false,
    loadRevision: 0,
    pollToken: 0,
    pollTimer: null,
    voicePreview: null,
  };
  dom.backToModel.href = state.projectId
    ? `/model?project=${encodeURIComponent(state.projectId)}`
    : "/create/guided";
  bindEvents();
  void loadProject();
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  document.addEventListener("DOMContentLoaded", initFootageUI, { once: true });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    DEFAULT_OPTIONS,
    TERMINAL_STATUSES,
    assetUrl,
    canvasCutUrl,
    applySubtitleControls,
    buildCommonRequest,
    buildJobPayload,
    buildPlanRequest,
    convertMptSettings,
    extractScriptText,
    isTerminalStatus,
    jobBelongsToProject,
    normalizeContext,
    normalizeJobSnapshot,
    materialCoverageText,
    normalizeOptions,
    paidMusicRequested,
    musicReviewKey,
    musicSubmissionOptions,
    normalizeShot,
    outputMedia,
    readSubtitleControls,
    renderShotQueries,
    sanitizeSettings,
    statusLabel,
  };
}
