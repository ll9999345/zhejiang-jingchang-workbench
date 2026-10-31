(function () {
  "use strict";
  const BASE = "/model-api/montage";
  const REFERENCE_VIDEO_EXTS = Object.freeze(["mp4", "mov", "m4v", "webm", "mkv", "ogv", "avi", "ts"]);
  const isReferenceVideo = path => REFERENCE_VIDEO_EXTS.some(ext => String(path).toLowerCase().endsWith("." + ext));
  const LABELS = {
    input_path: "输入素材", output_path: "输出文件名", output_dir: "输出目录名", transcript_path: "已有字幕 / 转录（可选）",
    text: "正文", prompt: "描述", query: "搜索内容", query_text: "画面含义", operation: "操作", language: "语言",
    model: "模型", voice: "声音", voice_id: "声音编号", source: "输入视频", strategy: "抽帧方式",
    count: "数量", min_seconds: "最短片段（秒）", max_seconds: "最长片段（秒）", duration_seconds: "时长（秒）",
    start_seconds: "开始（秒）", end_seconds: "结束（秒）", fps: "帧率", format: "输出格式",
    characters: "角色设定", character_design: "角色设定产物", rig_plan: "骨架产物", pose_library: "姿态库",
    scene_plan: "分镜产物", action_timeline: "动作时间线", world_spec: "三维世界设定",
    corpus_dir: "已有语义素材库", queries: "搜索词数组", video_path: "项目视频", audio_path: "项目音频",
    image_path: "项目图片", music_path: "项目音乐", subtitle_path: "项目字幕", segments: "时间片段数组",
    render_video: "导出动画视频", width: "宽度", height: "高度", samples: "渲染采样", cpu_render: "使用 CPU 渲染",
    files: "已有素材清单（输入路径与描述）", thumbs_per_video: "每条视频取样张数",
    mode: "分析方式", max_frames: "取样画面数量", scale: "放大倍数", upscale: "修复后放大倍数",
    face_enhance: "同时修复人脸", bg_upsampler: "同时放大背景", fidelity: "保留原貌程度",
    tile_size: "推理分块大小", max_video_frames: "视频处理帧数上限", denoise_strength: "降噪强度（仅通用轻量模型）",
    style: "配乐预设", tempo_bpm: "节拍速度（BPM）", cue_sheet: "配乐能量段", seed: "随机种子",
    alignment: "字幕定位方式", model_size: "识别模型", max_duration_seconds: "音轨时长上限（秒）",
    diarize: "区分说话人（尚未配置）",
    unique_across_queries: "跨关键词避免重复选用同一条素材",
  };
  const STATUSES = { queued: "排队中", running: "制作中", completed: "已完成", failed: "未完成", cancelled: "已取消",
    cancelling: "停止中", interrupted: "服务重启中断", waiting_approval: "等待你确认", blocked: "制作条件不足", budget_exhausted: "已到预算上限" };
  const PROGRESS_PHASES = {tool_started:"工具已启动",tool_completed:"工具执行结束",tool_failed:"工具执行未完成",
    query_started:"处理搜索词",search_started:"搜索素材",search_completed:"本轮搜索返回",download_started:"下载素材",
    download_validated:"素材校验完成",clip_ready:"素材已就绪",corpus_loaded:"素材库已载入",candidate_started:"处理候选素材",
    media_verified:"完整媒体校验完成",thumbnails_ready:"取样画面已提取",embedding_images:"计算画面语义（首次可能较久）",
    embedding_text:"计算文字语义",clip_indexed:"素材已加入待保存索引",candidates_processed:"候选素材处理结束",index_saving:"保存完整素材库",index_saved:"素材库已保存"};
  function progressNotice(row) {
    const p = row?.progress;
    if (!p || !Object.hasOwn(PROGRESS_PHASES, p.phase)) return "";
    const count = key => Number.isSafeInteger(p[key]) && p[key] >= 0 && p[key] <= 1000000000;
    const parts = [PROGRESS_PHASES[p.phase]];
    if (count('query_index') && count('queries_total') && p.query_index <= p.queries_total) parts.push(`搜索词 ${p.query_index}/${p.queries_total}`);
    if (count('clips_ready')) parts.push(`就绪 ${p.clips_ready} 条`);
    if (count('indexed')) parts.push(`本次入库 ${p.indexed} 条`);
    if (count('skipped') && p.skipped) parts.push(`跳过 ${p.skipped} 条`);
    if (count('failed_count') && p.failed_count) parts.push(`未成功 ${p.failed_count} 条`);
    if (!['queued','running','cancelling'].includes(row.status)) parts.unshift('最后记录');
    return parts.join(' · ');
  }
  function corpusRecoveryNotice(data) {
    if (data?.persistence?.recovered === true || data?.loaded_persistence?.recovered === true) {
      return "当前使用上一份完整素材库；较新结果无法校验，相关文件已保留。";
    }
    return "";
  }
  function queriesFromLines(text, kind, perSource, corpus = false) {
    if (typeof text !== 'string') throw new Error('请填写搜索关键词，每行一个。');
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (!lines.length) throw new Error('请填写搜索关键词，每行一个。');
    if (lines.length > 20 || lines.some(line => line.length > 500)) throw new Error('简易填写最多 20 行，每行最多 500 字；更多参数可使用原始参数模式。');
    if (!['video','image','any'].includes(kind)) throw new Error('请选择素材类型。');
    if (corpus && (!Number.isInteger(Number(perSource)) || Number(perSource)<1 || Number(perSource)>80)) throw new Error('每个来源返回数量须为 1–80 的整数。');
    return lines.map(query => ({query,kind,...(corpus ? {per_source:Number(perSource)} : {})}));
  }
  function queriesToGuide(value, corpus = false) {
    if (!Array.isArray(value) || !value.length) throw new Error('请先填写有效的搜索词数组。');
    const kind=value[0]?.kind ?? 'video', perSource=value[0]?.per_source ?? 10;
    const keys=corpus ? ['query','kind','per_source'] : ['query','kind'];
    if (value.some(row => !row || typeof row !== 'object' || Array.isArray(row)
      || Object.keys(row).some(key => !keys.includes(key))
      || typeof row.query !== 'string' || row.query !== row.query.trim() || /[\r\n]/.test(row.query)
      || (row.kind ?? 'video') !== kind || (corpus && (row.per_source ?? 10) !== perSource))) {
      throw new Error('这组参数包含逐词差异或其他原生设置，请保留原始参数模式，避免丢失设置。');
    }
    const text=value.map(row => row.query).join('\n');
    queriesFromLines(text,kind,perSource,corpus);
    if (value.some(row=>!row.query)) throw new Error('原始参数中含空关键词，请先修改。');
    return {text,kind,perSource};
  }
  function stockResultNotice(data) {
    const count=value=>Number.isSafeInteger(value)&&value>=0;
    if(!count(data?.total_clips)||!count(data?.distinct_clip_ids)||data.distinct_clip_ids>data.total_clips)return '';
    let text=`返回 ${data.total_clips} 条记录，对应 ${data.distinct_clip_ids} 条素材（按来源编号统计）。`;
    if(data.distinct_clip_ids<data.total_clips)text+='部分关键词复用了同一素材。';
    if(count(data.queries_without_clips)&&data.queries_without_clips)text+=`${data.queries_without_clips} 个关键词尚未取得素材。`;
    return text;
  }
  function el(tag, text, attrs = {}) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, String(v)));
    return node;
  }
  function field(text, input) {
    const label = el("label", text);
    label.append(input);
    return label;
  }
  function checkbox(text, checked = false) {
    const input = el("input", null, { type: "checkbox" });
    input.checked = checked;
    const label = field(text, input);
    label.className = "check-row";
    return { input, label };
  }
  function queryEditor(corpus) {
    const node=el('section',null,{class:'montage-query-editor'});
    const mode=el('select',null,{'aria-label':'搜索词填写方式'});
    mode.append(el('option','逐行填写关键词',{value:'lines'}),el('option','原始参数',{value:'json'}));
    const guide=el('div',null,{class:'montage-native-grid'});
    const text=el('textarea',null,{rows:4,'aria-label':'搜索关键词（每行一个）',placeholder:'三清山 云海\nMount Sanqing sunrise'});
    const kind=el('select',null,{'aria-label':'素材类型'});
    for(const [value,label] of [['video','视频'],['image','图片'],['any','视频和图片']]) kind.append(el('option',label,{value}));
    const count=el('input',null,{type:'number',min:1,max:80,step:1,'aria-label':'每个来源返回数量'});count.value='10';
    guide.append(field('搜索关键词（每行一个）',text),field('素材类型',kind));
    if(corpus) guide.append(field('每个来源返回数量',count));
    const raw=el('textarea',null,{rows:6,'aria-label':'搜索词原始参数',placeholder:'填写原生搜索词数组'});
    const rawField=field('搜索词原始参数',raw);rawField.hidden=true;
    const feedback=el('p','',{class:'media-hint',role:'alert'});
    node.append(field('搜索词填写方式',mode),guide,rawField,
      el('p','简易模式最多 20 行。需要逐词设置时可切换到原始参数；切换不会自动执行搜索。',{class:'media-hint'}),feedback);
    const show=()=>{guide.hidden=mode.value!=='lines';rawField.hidden=mode.value!=='json';};
    mode.addEventListener('change',()=>{
      feedback.textContent='';
      try{
        if(mode.value==='json') raw.value=text.value.trim() ? JSON.stringify(queriesFromLines(text.value,kind.value,count.value,corpus),null,2) : '';
        else if(raw.value.trim()){
          const data=queriesToGuide(parseValue(raw.value,{type:'array'},'queries'),corpus);
          text.value=data.text;kind.value=data.kind;count.value=String(data.perSource);
        }else text.value='';
      }catch(error){mode.value=mode.value==='json'?'lines':'json';feedback.textContent=error.message;}
      show();
    });
    return {node,control:raw,
      readValue:()=>mode.value==='lines'?queriesFromLines(text.value,kind.value,count.value,corpus):parseValue(raw.value,{type:'array'},'queries'),
      setValue:value=>{raw.value=JSON.stringify(value,null,2);mode.value='json';feedback.textContent='';show();}};
  }
  function numberInput(value, min, max, step = "any") {
    const input = el("input", null, { type: "number", min, max, step });
    input.value = value;
    return input;
  }
  function parseValue(value, schema, key) {
    if (schema.type === "boolean") return Boolean(value);
    if (!String(value).trim()) return undefined;
    if (["object", "array"].includes(schema.type)) {
      let parsed;
      try { parsed = JSON.parse(value); } catch (_) { throw new Error(`${LABELS[key] || key}需要有效的 JSON。`); }
      if (schema.type === "array" ? !Array.isArray(parsed) : !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${LABELS[key] || key}的数据类型不正确。`);
      }
      return parsed;
    }
    if (["number", "integer"].includes(schema.type)) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || (schema.type === "integer" && !Number.isInteger(parsed))) throw new Error(`${LABELS[key] || key}需要有效数字。`);
      if ((schema.minimum != null && parsed < schema.minimum) || (schema.maximum != null && parsed > schema.maximum)) throw new Error(`${LABELS[key] || key}超出允许范围。`);
      return parsed;
    }
    return String(value).trim();
  }
  async function api(path, body) {
    const response = await fetch(BASE + path, body == null ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(Array.isArray(data.detail) ? data.detail.map(item => item.msg).join("；") : data.detail || "本机服务未完成请求。");
    return data;
  }
  function urlFor(project, path) {
    if (!path || path.startsWith("/") || path.split("/").includes("..")) throw new Error("产物路径无效。");
    return `${BASE}/files/${encodeURIComponent(project)}/${path.split("/").map(encodeURIComponent).join("/")}`;
  }
  function referencePath(value) {
    const path = String(value || "").trim();
    if (!path) return null;
    if (path.startsWith("/") || path.includes("\\") || path.includes(":") || path.split("/").some(part => !part || part === "." || part === "..") || !isReferenceVideo(path)) {
      throw new Error("参考视频须是当前项目内的视频相对路径；请选择已有视频或先导入本地视频。");
    }
    return path;
  }
  function referencePreviewUrl(project, path) {
    const checked = referencePath(path);
    if (!project || !checked) throw new Error("请先选择当前项目的参考视频。");
    return `/model-api/footage/assets/${encodeURIComponent(project)}?path=${encodeURIComponent(checked)}`;
  }
  function mount(host, options = {}) {
    if (!host || host.dataset.nativeStudio) return;
    host.dataset.nativeStudio = "true";
    const getProject = options.getProjectId || (() => document.getElementById("mediaProjectId")?.value.trim() || "");
    const toolPane = el("section", null, { class: "montage-native-pane", "aria-label": "原生工具" });
    const directorPane = el("section", null, { class: "montage-native-pane", "aria-label": "OpenMontage AI 导演" });
    const status = el("p", "请选择当前项目，再选择制作方式。", { role: "status", "aria-live": "polite", class: "montage-message" });
    const history = el("section", null, { class: "montage-history", "aria-label": "OpenMontage 制作记录" });
    const refresh = el("button", "刷新制作记录", { type: "button", class: "secondary compact" });
    host.append(toolPane, directorPane, status, refresh, history);
    let tools = [], capabilities = null, currentMode = "tool", selectedTool = null, controls = [], loading = null, toolStatusJob = null;
    let epoch = 0, historyProject = "", timer = null, submitting = false;
    let assets = [], referenceProject = getProject(), importingReference = false;
    const historyCards = new Map();
    const toolJobs = new Map();
    const toolErrors = new Set();
    const activeJob = row => row && ["queued", "running", "cancelling"].includes(row.status);
    let toolRequestRevision = 0;
    const query = el("input", null, { type: "search", placeholder: "找功能，例如 角色、绿幕、Blender、语义素材", "aria-label": "搜索 OpenMontage 工具" });
    const group = el("select", null, { "aria-label": "工具类别" });
    group.append(el("option", "全部类别", { value: "" }));
    const picker = el("select", null, { "aria-label": "选择 OpenMontage 原生工具" });
    const filter = el("div", null, { class: "montage-filter" });
    filter.append(query, group, picker);
    const toolHint = el("p", "每项工具直接调用原版实现。未配置的服务会显示具体条件。", { class: "media-hint" });
    const form = el("div", null, { class: "montage-native-fields" });
    const network = checkbox("允许本次工具联网，并传输所选文字 / 素材");
    const paid = checkbox("允许所选工具的本次付费请求");
    const capture = checkbox("允许本次录屏或读取屏幕录制素材");
    const code = checkbox("我已审阅所选源码 / 工程，允许本机渲染");
    const ceiling = numberInput("0.5", "0.01", "1000");
    const paidLimit = field("本次费用上限（美元）", ceiling);
    const confirmed = checkbox("确认本次参数，写入新的产物并保留原件");
    const check = el("button", "检查条件", { type: "button", class: "secondary" });
    const execute = el("button", "运行所选工具", { type: "button", class: "primary" });
    const toolActions = el("div", null, { class: "button-row" });
    toolActions.append(check, execute);
    toolPane.append(filter, toolHint, form, network.label, paid.label, paidLimit, capture.label, code.label, confirmed.label, toolActions);
    const engine = el("select", null, { id: "montageDirectorEngine", "aria-label": "导演制作方式", "data-director-control": "engine" });
    engine.append(el("option", "OpenMontage 工具", {value: "openmontage"}), el("option", "Hypit 参考复刻", {value: "hypit"}));
    const reference = el("select", null, { id: "montageDirectorReference", "aria-label": "选择参考视频", "data-director-control": "reference" });
    const referenceInput = el("input", null, { id: "montageDirectorReferencePath", placeholder: "当前项目内视频相对路径（可选手填）", "data-director-control": "reference_path" });
    const referenceFile = el("input", null, { id: "montageDirectorReferenceFile", type: "file", accept: REFERENCE_VIDEO_EXTS.map(ext => "." + ext).join(","), "aria-label": "选择本地参考视频" });
    const referenceImport = el("button", "导入到当前项目", { type: "button", class: "secondary compact" });
    const referenceImportRow = el("div", null, { class: "montage-reference-import" });
    referenceImportRow.append(referenceFile, referenceImport);
    const referencePreview = el("video", null, { controls: "", preload: "metadata", "aria-label": "播放参考视频", class: "montage-reference-preview" });
    referencePreview.hidden = true;
    const referenceHint = el("p", "请先实际观看参考视频，并配置能理解画面的视觉模型。导演需读取参考画面后规划；工具已安装不等于完整复刻已就绪。", {class: "media-hint"});
    const hypitStatus = el("p", "正在读取 Hypit 本机条件……", { id: "montageDirectorHypitStatus", class: "media-hint", role: "status", "aria-live": "polite" });
    const referenceFields = el("div", null, { class: "montage-reference-fields" });
    referenceFields.hidden = true;
    const referenceAdvanced = el("details", null, { class: "montage-settings", id: "montageDirectorReferenceAdvanced" });
    referenceAdvanced.append(el("summary", "手动填写视频路径"), field("参考路径（可选手填）", referenceInput));
    referenceFields.append(field("参考视频", reference), referenceImportRow,
      el("p", "仅导入本机当前项目；支持 0.5 秒至 10 分钟的视频，最多 512 MB。导入不会开始分析或制作。", {class: "media-hint"}), referencePreview, referenceHint, hypitStatus);
    referenceFields.append(referenceAdvanced);
    const pipeline = el("select", null, { "aria-label": "制作管线" });
    const brief = el("textarea", null, { rows: 5, placeholder: "描述要做的作品、已选素材、受众与风格。导演会按原版管线分阶段制作。" });
    const provider = el("select", null, { id: "montageDirectorProvider", "aria-label": "导演模型服务" });
    const model = el("input", null, { id: "montageDirectorModel", placeholder: "填写实际模型名或方舟接入点编号" });
    const thinking = el("select", null, { id: "montageDirectorThinking", "aria-label": "DeepSeek 思考深度" });
    [["off", "快速 · 不启用思考"], ["low", "轻量思考"], ["high", "深入思考 · 默认"], ["max", "最高思考深度"]].forEach(([value, label]) => thinking.append(el("option", label, { value })));
    thinking.value = "high";
    const thinkingField = field("思考深度", thinking);
    thinkingField.hidden = true;
    const providerDrafts = new Map();
    let appliedProvider = "";
    const budget = numberInput("1", "0", "100");
    const inputPrice = numberInput("", "0", "200");
    const outputPrice = numberInput("", "0", "500");
    const remote = checkbox("允许将本次创作文字与工具记录发给所选导演模型");
    const modelPaid = checkbox("允许在上述总预算内调用所选导演模型");
    const auto = checkbox("自动继续本次已授权的制作阶段；联网、付费工具与工程渲染仍逐项确认");
    const directorConfirm = checkbox("确认本次管线、需求与模型，开始独立导演任务");
    const setup = el("p", "模型配置由本机服务管理，网页不读取或保存 API 密钥。", { class: "media-hint", id: "montageDirectorModelSetup" });
    const settings = el("details", null, { class: "montage-settings", id: "montageDirectorModelSettings" });
    const settingsSummary = el("summary", "导演模型与预算");
    settings.append(settingsSummary);
    const setupGrid = el("div", null, { class: "field-grid" });
    setupGrid.append(field("服务", provider), field("模型名", model), field("项目总预算（美元）", budget),
      field("输入单价（美元 / 百万令牌）", inputPrice), field("输出单价（美元 / 百万令牌）", outputPrice), thinkingField);
    settings.append(setupGrid, setup, remote.label, modelPaid.label);
    const directorCheck = el("button", "检查导演条件", { type: "button", class: "secondary" });
    const directorStart = el("button", "开始制作", { type: "button", class: "primary" });
    const directorActions = el("div", null, { class: "button-row" });
    directorActions.append(directorCheck, directorStart);
    const readiness = el("section", null, { id: "montageDirectorReadiness", class: "montage-director-readiness", "aria-label": "导演条件检查结果" });
    readiness.hidden = true;
    const readinessTitle = el("strong", "导演条件检查");
    const readinessList = el("ul", null, { class: "montage-check-list" });
    const readinessNote = el("p", null, { class: "media-hint", role: "status", "aria-live": "polite" });
    const readinessDetails = el("details", null, { class: "montage-settings" });
    readinessDetails.append(el("summary", "检查范围与注意事项"));
    readiness.append(readinessTitle, readinessList, readinessNote, readinessDetails);
    const recovery = el("section", null, { id: "montageDirectorRecovery", class: "montage-director-recovery", "aria-label": "核对未收到回执的提交" });
    recovery.hidden = true;
    const recoveryNote = el("p", null, { role: "status", "aria-live": "polite" });
    const recoverySummary = el("details", null, { class: "montage-settings" });
    const recover = el("button", "核对本次提交", { type: "button", class: "secondary" });
    const retrySubmit = el("button", "重试同一次提交", { type: "button", class: "secondary" });
    const recoveryActions = el("div", null, { class: "button-row" });
    recoveryActions.append(recover, retrySubmit);
    recovery.append(el("strong", "先确认任务是否已建立"), recoveryNote, recoverySummary, recoveryActions);
    let directorRevision = 0, recoveringSubmission = false;
    const pendingSubmissions = new Map();
    const submissionKey = id => "zhejiang:montage-director-submission:" + id;
    function pendingSubmission(id = getProject()) {
      if (!id) return null;
      if (pendingSubmissions.has(id)) return pendingSubmissions.get(id);
      try {
        const saved = JSON.parse(window.sessionStorage.getItem(submissionKey(id)) || "null");
        if (saved?.body?.project_id === id && saved.body.confirm === true && /^[A-Za-z0-9_-]{16,64}$/.test(saved.body.client_request_id || "")) {
          const pending = {body: saved.body, message: "上次提交的回执尚未确认。先核对记录，再决定是否重试。"};
          pendingSubmissions.set(id, pending);
          return pending;
        }
      } catch (_) { /* Storage is optional; the current page keeps the receipt. */ }
      return null;
    }
    function rememberSubmission(body) {
      const pending = {body, message: "正在建立任务；在收到回执前暂停重复提交。"};
      pendingSubmissions.set(body.project_id, pending);
      try { window.sessionStorage.setItem(submissionKey(body.project_id), JSON.stringify({body})); }
      catch (_) { pending.storageUnavailable = true; }
      syncDirectorButtons();
      return pending;
    }
    function clearSubmission(id, clientId) {
      if (pendingSubmission(id)?.body.client_request_id !== clientId) return;
      pendingSubmissions.delete(id);
      try { window.sessionStorage.removeItem(submissionKey(id)); } catch (_) { /* No production action depends on storage. */ }
    }
    function syncDirectorButtons() {
      const pending = pendingSubmission();
      directorStart.disabled = directorCheck.disabled = submitting || recoveringSubmission || importingReference || !!pending;
      directorPane.querySelectorAll("input, select, textarea").forEach(input => { input.disabled = !!pending; });
      referenceImport.disabled = importingReference || !!pending;
      recovery.hidden = !pending;
      if (pending) {
        recoveryNote.textContent = pending.message + (pending.storageUnavailable ? " 本页暂不能保存核对记录，请保持页面打开。" : " 本页保留本次参数用于核对；重试沿用同一提交编号。");
        const body = pending.body;
        recoverySummary.replaceChildren(el("summary", "查看本次提交的需求与预算"),
          el("p", body.brief), el("p", `${body.provider} / ${body.model} · 导演总预算 $${body.max_cost_usd}`),
          el("p", `${body.execution_engine === "hypit" ? "Hypit 参考复刻" : "OpenMontage 工具"} · ${body.pipeline}${body.reference_path ? " · " + body.reference_path : ""}`),
          el("p", "提交编号：" + body.client_request_id, {class: "media-hint"}));
      }
      recover.disabled = retrySubmit.disabled = submitting || recoveringSubmission;
      retrySubmit.hidden = pending?.lastStatus !== "not_found";
    }
    function invalidateDirectorCheck() {
      directorRevision++;
      if (!readiness.hidden) {
        readiness.dataset.state = "stale";
        readinessTitle.textContent = "参数已更新，请重新检查";
        readinessList.replaceChildren();
        readinessDetails.hidden = true;
        readinessNote.textContent = "上次结果对应旧参数；开始时还会重新核对当前条件。";
      }
    }
    function showDirectorCheck(data) {
      readiness.hidden = false;
      readiness.dataset.state = data.can_execute ? "ready" : "needs_setup";
      const issues = data.requirements || [];
      readinessTitle.textContent = data.can_execute ? "配置检查通过，可开始导演规划" : `还有 ${issues.length || 1} 项条件待处理`;
      readinessList.replaceChildren();
      const checks = data.checks || issues.map(message => ({label: "待处理", status: "needs_setup", messages: [message]}));
      const labels = {ready: "已检查", needs_setup: "待设置", not_checked: "尚未检查", warning: "步骤中核对"};
      checks.forEach(check => {
        const row = el("li", null, { "data-check-state": check.status });
        const content = el("div");
        content.append(el("strong", check.label), el("p", (check.messages || []).join("；")));
        row.append(content, el("span", labels[check.status] || check.status, { class: "montage-check-state" }));
        if (check.status === "needs_setup" && ["model", "permissions", "reference"].includes(check.id)) {
          const fix = el("button", check.id === "reference" ? "选择视频" : "去设置", { type: "button", class: "secondary compact" });
          fix.addEventListener("click", () => {
            if (check.id === "reference") reference.focus();
            else { settings.open = true; (check.id === "model" ? model : !remote.input.checked ? remote.input : budget).focus(); }
          });
          row.append(fix);
        }
        readinessList.append(row);
      });
      readinessNote.textContent = data.message || "检查未调用模型、运行工具或新建制作文件。";
      readinessDetails.hidden = !(data.warnings?.length);
      readinessDetails.replaceChildren(el("summary", "检查范围与注意事项"));
      data.warnings?.forEach(note => readinessDetails.append(el("p", note, {class: "media-hint"})));
    }
    directorPane.append(el("p", "导演会读取原版制作技能，逐阶段调用实际工具；你可以随时审阅、确认或取消。", { class: "media-hint" }),
      field("导演制作方式", engine), referenceFields, field("要做哪类作品", pipeline), field("创作需求与素材说明", brief), settings, auto.label, directorConfirm.label, directorActions, readiness, recovery);
    function project() { const id = getProject(); if (!id) throw new Error("请先选择或载入一个项目。"); return id; }
    function syncToolButton() {
      const job = toolJobs.get(`${getProject()}:${selectedTool?.name}`);
      const state = toolErrors.has(`${getProject()}:${selectedTool?.name}`) ? "failed" : job ? window.WorkbenchInteractions?.taskState(job.status) || "unknown" : "ready";
      if (!submitting) window.WorkbenchInteractions?.setState(execute, state, {label: activeJob(job)
        ? ({queued:"任务排队中",running:"工具运行中",cancelling:"等待停止回执"}[job.status])
        : state === "succeeded" ? "已完成 · 再次运行" : state === "failed" ? "未完成 · 检查后重试" : state === "cancelled" ? "已取消 · 再次运行" : "运行所选工具"});
      execute.disabled = submitting || activeJob(job) || !selectedTool || selectedTool.status === "unavailable" || selectedTool.entry === "/footage";
    }
    function showPermissions() {
      const fx = selectedTool?.effects || {};
      network.label.hidden = !fx.network;
      paid.label.hidden = !fx.paid;
      paidLimit.hidden = !fx.paid;
      capture.label.hidden = !fx.capture;
      code.label.hidden = !fx.code && !controls.some(row => ["scene_code", "code", "custom_af", "extra_args"].includes(row.key));
      syncToolButton();
    }
    function nativeInputs() {
      const values = {};
      for (const row of controls) {
        const value = row.readValue ? row.readValue() : parseValue(row.schema.type === "boolean" ? row.control.checked : row.control.value, row.schema, row.key);
        if (row.required && value === undefined) throw new Error(`请填写${LABELS[row.key] || row.key}。`);
        if (value !== undefined) values[row.key] = value;
      }
      return values;
    }
    function chooseTool() {
      toolStatusJob = null;
      selectedTool = tools.find(row => row.name === picker.value) || null;
      controls = [];
      form.replaceChildren();
      confirmed.input.checked = network.input.checked = paid.input.checked = capture.input.checked = code.input.checked = false;
      if (!selectedTool) { toolHint.textContent = "未找到工具，换一个搜索词试试。"; execute.disabled = true; return; }
      const row = selectedTool;
      status.textContent = '已选择' + row.label + '；请填写参数并检查条件，尚未执行。';
      toolHint.textContent = row.readiness ? `${row.label}：${row.readiness.summary} ${row.readiness.note}` : `${row.label} · ${row.provider} · ${row.status === "available" ? "依赖已就绪" : row.status === "degraded" ? "部分能力降级" : "待配置"}`;
      if (!row.readiness && row.status !== "available" && row.dependencies.length) toolHint.textContent += `；所需条件：${row.dependencies.join("、")}`;
      if (!row.readiness && row.status !== "available" && row.setup_hint) toolHint.textContent += `；配置说明：${row.setup_hint}`;
      if (row.name === "clip_search") toolHint.textContent += "；本机 CLIP 主要支持英文描述，英文画面关键词通常更准确。";
      if (["upscale", "face_restore"].includes(row.name)) toolHint.textContent += "；本机 CPU 推理，先用小图或短片试效果；原素材保留。";
      if (row.name === "transcript_aligner") toolHint.textContent += "；把已确认文字贴准配音，文件与正文二选一。中文按汉字定位；每段最多 30 秒，仍须核对听感。";
      if (row.name === "transcriber") toolHint.textContent += "；只运行所选的已安装本地模型。中文精细定位最多 120 秒；说话人区分未配置。";
      if (row.name === "remotion_caption_burn") toolHint.textContent += "；先选择中文精细字幕对齐生成的 JSON，可保留真实逐字时间。普通 SRT 只有句子时间，逐字时间为估计。";
      if (row.entry === "/footage") {
        const link = el("a", "进入真实素材自动成片 →", { href: `/footage?project=${encodeURIComponent(getProject())}` });
        form.append(link); showPermissions(); return;
      }
      const advanced = el("details", null, { class: "montage-settings" });
      advanced.append(el("summary", "高级参数与输出文件名"));
      if(row.name==='corpus_builder') form.append(el('p','本次创建新的语义素材库，原有素材库不覆盖。完成后可用“按画面含义找素材”查询。',{class:'media-hint'}));
      if(row.readiness){
        const original=el('details',null,{class:'montage-settings'});
        original.append(el('summary','来源配置与原版技术说明'));
        for(const source of row.readiness.sources || []) original.append(el('p',`${source.name} · ${source.configured?'已配置（尚未验证连通）':'未配置'}`,{class:'media-hint'}));
        original.append(el('p',row.dependencies.join('、'),{class:'media-hint'}),el('p',row.setup_hint,{class:'media-hint'}));
        advanced.append(original);
      }
      const required = new Set(row.input_schema.required || []);
      for (const [key, schema] of Object.entries(row.input_schema.properties || {})) {
        if(key==='queries' && ['corpus_builder','direct_clip_search'].includes(row.name)){
          const editor=queryEditor(row.name==='corpus_builder');editor.control.dataset.nativeParameter=key;
          controls.push({key,schema,required:required.has(key),control:editor.control,readValue:editor.readValue,setValue:editor.setValue});
          form.append(editor.node);continue;
        }
        if (key === "allow_unsafe_code" || key === "callback_url") continue;
        let control;
        if (schema.enum) {
          control = el("select");
          if (!required.has(key) && schema.default == null) control.append(el("option", "使用原版默认值", { value: "" }));
          const names = row.name === "video_understand" && key === "model"
            ? {clip: "CLIP · 分类与检索", blip: "BLIP · 本机描述 / 英语问答", blip2: "BLIP-2 · 需配置大模型", llava: "LLaVA · 需配置大模型"}
            : row.name === "video_understand" && key === "mode" ? {describe: "描述画面", qa: "画面问答", quality: "技术质量检查", classify: "场景分类"}
            : row.name === "local_music" && key === "style" ? {guofeng_ambient: "国风氛围", cinematic: "电影铺底", documentary: "纪录片"}
            : row.name === "transcriber" && key === "alignment" ? {faster_whisper: "标准定位", whisperx_zh: "中文精细定位（WhisperX）"}
            : key === "language" && schema.enum.length === 1 && schema.enum[0] === "zh" ? {zh: "中文"} : {};
          schema.enum.forEach(value => control.append(el("option", names[value] || String(value), { value })));
          if (schema.default != null) control.value = schema.default;
        } else if (schema.type === "boolean") {
          control = el("input", null, { type: "checkbox" });
          control.checked = schema.default === true;
        } else if (["object", "array"].includes(schema.type) || ["scene_code", "text", "prompt"].includes(key)) {
          control = el("textarea", null, { rows: 4 });
          control.value = schema.default == null ? "" : ["object", "array"].includes(schema.type) ? JSON.stringify(schema.default, null, 2) : String(schema.default);
          control.placeholder = schema.type === "array" ? "填写 JSON 数组；可在下方记录中复制原生数据" : schema.type === "object" ? "填写 JSON 对象；可沿用已有阶段产物" : "填写内容";
        } else {
          control = el("input", null, { type: ["number", "integer"].includes(schema.type) ? "number" : "text" });
          if (schema.type === "integer") control.step = "1";
          else if (schema.type === "number") control.step = "any";
          if (schema.minimum != null) control.min = schema.minimum;
          if (schema.maximum != null) control.max = schema.maximum;
          if (schema.default != null) control.value = schema.default;
          if (row.name==='direct_clip_search' && key==='output_dir' && schema.default==null) control.value='stock';
          if (key.endsWith("_path") && !key.includes("output")) control.placeholder = "当前项目内相对路径";
          if (schema.type === "string" && key.endsWith("_path") && !key.includes("output") && key !== "blend_path") {
            const listId = `montage-asset-${key}`;
            const datalist = el("datalist", null, { id: listId });
            const kind = key.includes("video") ? "video" : key.includes("image") ? "image" : key.includes("audio") || key.includes("music") ? "audio" : "";
            assets.filter(asset => !kind || asset.kind === kind).forEach(asset => datalist.append(el("option", asset.label || asset.path, { value: asset.path })));
            control.setAttribute("list", listId);
            form.append(datalist);
          }
        }
        const fieldLabel = row.name === "corpus_builder" && key === "max_new_clips" ? "本次最多入库（条）" : row.name === "direct_clip_search" && key === "clips_per_query" ? "每个关键词最多采集（条）" : row.name === "video_understand" && key === "query" ? "画面问题（BLIP 建议英语）" : LABELS[key] || key.replaceAll("_", " ");
        const label = field(fieldLabel + (required.has(key) ? " *" : ""), control);
        if (schema.type === "boolean") label.className = "check-row";
        control.dataset.nativeParameter = key;
        controls.push({ key, schema, control, required: required.has(key) });
        if (required.has(key) || ["transcript_path", "min_seconds", "max_seconds", "count", "render_video"].includes(key)
          || (row.name === "video_understand" && ["mode", "model", "max_frames", "query"].includes(key))
          || (row.name === "upscale" && ["scale", "model", "face_enhance"].includes(key))
          || (row.name === "face_restore" && ["model", "upscale", "bg_upsampler"].includes(key))
          || (row.name === "local_music" && ["style", "tempo_bpm"].includes(key))
          || (row.name === "transcript_aligner" && key === "text")
          || (row.name === "corpus_builder" && key === "max_new_clips") || (row.name === "direct_clip_search" && key === "clips_per_query")
          || (row.name === "direct_clip_search" && key === "unique_across_queries")
          || (row.name === "transcriber" && ["model_size", "alignment", "language"].includes(key))) form.append(label);
        else advanced.append(label);
      }
      if (advanced.children.length > 1) form.append(advanced);
      if (row.status === "unavailable") advanced.open = true;
      showPermissions();
    }
    function filterTools() {
      const previous = picker.value;
      const term = query.value.trim().toLowerCase();
      const rows = tools.filter(row => (!group.value || row.capability === group.value) && `${row.label} ${row.name} ${row.group} ${row.provider}`.toLowerCase().includes(term));
      picker.replaceChildren();
      rows.forEach(row => picker.append(el("option", `${row.label}${row.status === "unavailable" ? " · 待配置" : ""}`, { value: row.name })));
      if (rows.some(row => row.name === previous)) picker.value = previous;
      chooseTool();
    }
    async function load() {
      if (loading) return loading;
      loading = Promise.all([api("/tools"), api("/director/capabilities")]).then(([catalog, config]) => {
        tools = catalog.tools;
        capabilities = config;
        group.replaceChildren(el('option', '全部类别', { value: '' }));
        pipeline.replaceChildren(); provider.replaceChildren();
        const groups = new Map(tools.map(row => [row.capability, row.group]));
        [...groups].sort((a, b) => a[1].localeCompare(b[1], "zh-CN")).forEach(([id, label]) => group.append(el("option", label, { value: id })));
        config.pipelines.forEach(row => pipeline.append(el("option", row.label, { value: row.id })));
        if (config.pipelines.some(row => row.id === "documentary-montage")) pipeline.value = "documentary-montage";
        config.providers.forEach(row => provider.append(el("option", row.label + (row.local ? " · 需检查本机服务" : row.configured ? "" : " · 待配置"), { value: row.id })));
        provider.value = config.provider_default;
        applyProviderDefaults();
        filterTools();
        updateDirector();
        syncDirectorButtons();
        status.textContent = getProject() ? "已载入当前项目；检查条件后即可使用原生工具。导演流程需另行通过模型检查。" : "请先选择或载入一个项目。";
      }).catch(error => { status.textContent = error.message; loading = null; throw error; });
      return loading;
    }
    function modelPreset() {
      return capabilities?.providers?.find(row => row.id === provider.value)?.models?.find(row => row.id === model.value.trim());
    }
    function applyProviderDefaults() {
      if (appliedProvider) providerDrafts.set(appliedProvider, {model: model.value, input: inputPrice.value, output: outputPrice.value, thinking: thinking.value});
      const cfg = capabilities?.providers?.find(row => row.id === provider.value);
      const saved = providerDrafts.get(provider.value);
      model.value = saved?.model ?? (provider.value === capabilities?.provider_default ? capabilities.model_default : cfg?.default_model) ?? "";
      const preset = modelPreset();
      inputPrice.value = saved?.input ?? preset?.pricing?.input_per_million ?? "";
      outputPrice.value = saved?.output ?? preset?.pricing?.output_per_million ?? "";
      thinking.value = saved?.thinking ?? capabilities?.reasoning_effort_default ?? "high";
      appliedProvider = provider.value;
      // Changing the recipient must not carry forward another service's data
      // transmission or billing consent. Draft model/prices remain recoverable.
      remote.input.checked = modelPaid.input.checked = directorConfirm.input.checked = false;
    }
    function updateDirector() {
      const cfg = capabilities?.providers?.find(row => row.id === provider.value);
      const local = cfg?.local;
      let miaoLink = settings.querySelector?.('[data-miao-setup]');
      if (!miaoLink && settings.append) {
        miaoLink = el('a', '配置喵喵 API · GPT ↗', {href:'/model-api/montage/director/miaoapi/setup', target:'_blank', rel:'noopener noreferrer', 'data-miao-setup':'true'});
        settings.append(miaoLink);
      }
      if (miaoLink) miaoLink.hidden = provider.value !== 'miaoapi';
      remote.label.hidden = modelPaid.label.hidden = local === true;
      setup.textContent = cfg?.error || (local ? "本机服务仍需运行，并已有所填模型；检查配置不会发出生成请求。" :
        (cfg?.credential_source ? "认证来源：" + cfg.credential_source + "。密钥只在服务端读取。" : "填入服务的实际模型名和官方单价。认证由本机服务环境管理。") + "素材上传与付费工具会另行确认。");
      const preset = modelPreset();
      thinkingField.hidden = provider.value !== "deepseek";
      settingsSummary.textContent = "导演模型与预算" + (model.value.trim() ? " · " + (preset?.label || model.value.trim()) : "");
      if (preset) setup.textContent += ` ${preset.label}${preset.vision ? "支持画面理解" : ""}；${provider.value === 'miaoapi' ? '当前仅发送文字；按喵喵分组页面价格加倍预留' : '预填单价按官方高峰价格保守预算'}，实际账单为准。配置存在不等于实际成片已验收。`;
      if (!model.value.trim()) setup.textContent = "尚未配置导演模型。下面的原生工具可以单独使用；完整导演流程需要填写实际模型并通过条件检查。" + setup.textContent;
      if (!cfg?.configured || !model.value.trim()) settings.open = true;
      referenceFields.hidden = engine.value !== "hypit";
      const hypit = capabilities?.hypit;
      hypitStatus.textContent = hypit?.available
        ? `Hypit${hypit.version ? " " + hypit.version : ""} 命令和依赖可用，工程仍需检查。视觉模型、参考读取与实际制作步骤仍须通过检查。`
        : hypit?.message || "尚未确认 Hypit 本机运行条件；可检查条件，暂不能开始 Hypit 制作。";
      if (referenceFields.hidden) referencePreview.pause();
    }
    function updateReferencePreview() {
      let path = null;
      try { path = referencePath(referenceInput.value); } catch (_) { /* Keep invalid manual input visible for correction. */ }
      const id = getProject();
      referencePreview.hidden = !path || !id;
      const url = path && id ? referencePreviewUrl(id, path) : "";
      if (referencePreview.getAttribute("src") === url) return;
      referencePreview.pause();
      if (url) referencePreview.setAttribute("src", url);
      else referencePreview.removeAttribute("src");
    }
    function updateReferenceOptions() {
      const path = referenceInput.value.trim();
      reference.replaceChildren(el("option", "请选择参考视频；不会自动选取素材", {value: ""}));
      assets.filter(asset => asset.kind === "video").forEach(asset => reference.append(el("option", asset.label || asset.path, {value: asset.path})));
      reference.value = Array.from(reference.options).some(option => option.value === path) ? path : "";
      updateReferencePreview();
    }
    function syncReferenceProject() {
      const id = getProject();
      if (id === referenceProject) return;
      referenceProject = id;
      assets = [];
      referenceInput.value = referenceFile.value = "";
      directorConfirm.input.checked = false;
      invalidateDirectorCheck();
      updateReferenceOptions();
    }
    function directorPayload() {
      syncReferenceProject();
      return { project_id: project(), execution_engine: engine.value, reference_path: engine.value === "hypit" ? referencePath(referenceInput.value) : null,
        pipeline: pipeline.value, brief: brief.value.trim(), provider: provider.value, model: model.value.trim(),
        reasoning_effort: provider.value === "deepseek" ? thinking.value : "high", max_output_tokens: modelPreset()?.max_output_tokens || 4096,
        max_cost_usd: Number(budget.value), input_price_per_million: Number(inputPrice.value), output_price_per_million: Number(outputPrice.value),
        allow_network: remote.input.checked, allow_paid: modelPaid.input.checked, auto_approve_local_stages: auto.input.checked };
    }
    async function importReference() {
      if (importingReference) return;
      let id;
      try {
        syncReferenceProject();
        id = project();
        const file = referenceFile.files?.[0];
        if (!file) throw new Error("先选择要导入的本地参考视频。");
        if (!isReferenceVideo(file.name)) throw new Error("请选择支持的视频文件。");
        if (!file.size || file.size > 512 * 1024 * 1024) throw new Error("参考视频须为非空文件，且不超过 512 MB。");
        importingReference = true;
        syncDirectorButtons();
        directorConfirm.input.checked = false;
        invalidateDirectorCheck();
        status.textContent = "正在将参考视频导入本机当前项目；不会开始分析或制作……";
        const response = await fetch(`/model-api/reference/upload?project_id=${encodeURIComponent(id)}&filename=${encodeURIComponent(file.name)}`, {
          method: "POST", headers: {"Content-Type": "application/octet-stream"}, body: file,
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "参考视频未能导入当前项目。");
        if (getProject() !== id) return;
        const path = referencePath(data.source_path || data.path);
        if (!path) throw new Error("导入响应没有可用的参考路径，请刷新项目素材后选择。");
        if (!assets.some(asset => asset.path === path)) assets.push({path, kind: "video", label: data.label || file.name});
        referenceInput.value = path;
        referenceFile.value = "";
        updateReferenceOptions();
        status.textContent = "参考视频已导入当前项目。请播放核对并填写改编需求，再检查导演条件。";
        host.dispatchEvent(new CustomEvent("montage:reference-import", {bubbles: true, detail: {...data, project_id: id, source_path: path}}));
      } catch (error) { if (!id || getProject() === id) status.textContent = error.message; }
      finally { importingReference = false; syncDirectorButtons(); }
    }
    async function doTool(start) {
      if (submitting) return;
      toolStatusJob = null;
      const originProject = getProject(), originTool = selectedTool, revision = ++toolRequestRevision;
      const current = () => revision === toolRequestRevision && getProject() === originProject && selectedTool === originTool;
      try {
        if (!originTool) throw new Error("先选择一个工具。");
        if (start && activeJob(toolJobs.get(`${originProject}:${originTool.name}`))) return;
        const body = { project_id: project(), tool: originTool.name, inputs: nativeInputs(), confirm: start && confirmed.input.checked,
          allow_network: network.input.checked, allow_paid: paid.input.checked, allow_capture: capture.input.checked,
          allow_code: code.input.checked, max_cost_usd: paid.input.checked ? Number(ceiling.value) : 0 };
        if (start && !body.confirm) throw new Error("请先确认当前内容与参数。");
        toolErrors.delete(`${originProject}:${originTool.name}`);
        submitting = true; execute.disabled = check.disabled = true;
        window.WorkbenchInteractions?.setState(execute,start ? "submitting" : "preparing",{label:start ? "正在建立任务" : "正在检查条件"});
        status.textContent = start ? "正在建立本次原生制作任务……" : "正在检查条件……";
        const data = await api(start ? "/tools/execute" : "/tools/preflight", body);
        if (!current()) return;
        if (data.effects) { originTool.effects = data.effects; showPermissions(); }
        status.textContent = data.job_id ? "任务已保存，尚未完成。下方会更新真实制作状态。" : data.requirements?.join("；") || data.message;
        if (data.job_id) toolStatusJob = {project:originProject,tool:originTool.name,id:data.job_id};
        if (data.url) form.append(el("a", "进入对应制作流程", {href:data.url}));
        if (data.job_id) {
          toolJobs.set(`${originProject}:${originTool.name}`, {job_id:data.job_id,tool:originTool.name,status:data.status || "queued",awaitingHistory:true});
          confirmed.input.checked = false; await refreshHistory();
        }
      } catch (error) {
        if (current()) { toolErrors.add(`${originProject}:${originTool?.name}`); status.textContent = error.message; window.WorkbenchInteractions?.setState(execute,"failed"); }
      } finally {
        if (revision === toolRequestRevision) { submitting = false; check.disabled = false; showPermissions(); syncDirectorButtons(); }
      }
    }
    function openMissingDirectorSettings(data, body) {
      if (data.can_execute === false && (!body.model || (!capabilities?.providers?.find(row => row.id === body.provider)?.local
        && (!body.allow_network || !body.allow_paid || body.input_price_per_million <= 0 || body.output_price_per_million <= 0)))) settings.open = true;
    }
    async function acceptedSubmission(data, body) {
      clearSubmission(body.project_id, body.client_request_id);
      if (getProject() !== body.project_id) return;
      directorConfirm.input.checked = false;
      status.textContent = `导演任务已建立${data.deduplicated ? "，已找回原提交，没有另开任务" : ""}。当前状态：${STATUSES[data.status] || data.status || "已记录"}；阶段与待确认步骤见下方。`;
      await refreshHistory();
    }
    async function submitDirector(pending) {
      if (submitting || recoveringSubmission) return;
      const body = pending.body;
      submitting = true;
      syncDirectorButtons();
      window.WorkbenchInteractions?.setState(directorStart, "submitting", {label: "正在建立任务"});
      if (getProject() === body.project_id) status.textContent = "正在建立独立导演任务，尚未完成制作……";
      try {
        const data = await api("/director/start", body);
        if (data.session_id) await acceptedSubmission(data, body);
        else if (data.request_status === "pending") pending.message = data.message;
        else if (["needs_setup", "confirmation_required"].includes(data.status) && typeof data.can_execute === "boolean") {
          clearSubmission(body.project_id, body.client_request_id);
          if (getProject() === body.project_id) {
            directorConfirm.input.checked = false;
            openMissingDirectorSettings(data, body);
            showDirectorCheck(data);
            status.textContent = data.checks?.length ? "" : data.requirements?.join("；") || data.message || "尚未建立任务，请核对当前条件。";
          }
        } else pending.message = "服务尚未返回可核验的任务回执。请核对本次提交，暂停重复新建。";
      } catch (error) {
        pending.message = "未收到本次提交回执。" + error.message + " 先核对记录，不能据此判断制作失败。";
        if (getProject() === body.project_id) { directorConfirm.input.checked = false; status.textContent = pending.message; }
      } finally {
        submitting = false;
        window.WorkbenchInteractions?.setState(directorStart, "ready", {label: "开始制作"});
        syncDirectorButtons();
      }
    }
    async function recoverDirectorSubmission() {
      const pending = pendingSubmission();
      if (!pending || submitting || recoveringSubmission) return;
      const body = pending.body;
      recoveringSubmission = true;
      pending.message = "正在只读核对本次提交，不会发送模型请求……";
      syncDirectorButtons();
      try {
        const data = await api(`/director/requests/${encodeURIComponent(body.client_request_id)}?project_id=${encodeURIComponent(body.project_id)}`);
        if (data.request_status === "accepted" && data.session_id) await acceptedSubmission({...data, deduplicated: true}, body);
        else { pending.lastStatus = data.request_status; pending.message = data.message || "本次提交状态尚未确认，请继续核对。"; }
      } catch (error) { pending.message = "暂时无法核对：" + error.message + " 保留本次提交，不会自动重试模型。"; }
      finally { recoveringSubmission = false; syncDirectorButtons(); }
    }
    async function doDirector(start) {
      if (submitting || recoveringSubmission || pendingSubmission() || importingReference) return;
      const originProject = getProject(), revision = directorRevision;
      let checking = false;
      try {
        const body = directorPayload();
        if (!body.brief) throw new Error(body.execution_engine === "hypit" ? "填写想怎样改编视频，再检查导演条件。" : "填写创作需求，再检查导演条件。");
        if (start && body.execution_engine === "hypit") {
          if (!body.reference_path) throw new Error("请先选择当前项目的参考视频，或导入本地视频；实际观看后再开始。");
          if (!capabilities?.hypit?.available) throw new Error(capabilities?.hypit?.message || "Hypit 本机运行条件尚未就绪，请先检查导演条件。");
        }
        if (start && !body.model) throw new Error(body.execution_engine === "hypit" ? "请配置能理解参考画面的实际视觉模型，并先检查导演条件。" : "填写实际模型名；未配置的模型不会使用假导演替代。");
        if (start && !directorConfirm.input.checked) throw new Error("确认本次管线、需求与模型后开始。");
        if (start) {
          const clientId = Array.from(window.crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, "0")).join("");
          await submitDirector(rememberSubmission({...body, confirm: true, client_request_id: clientId}));
          return;
        }
        submitting = true;
        checking = true;
        syncDirectorButtons();
        directorCheck.textContent = "正在检查条件";
        readiness.hidden = false;
        readiness.dataset.state = "checking";
        readinessTitle.textContent = "正在检查当前条件";
        readinessList.replaceChildren();
        readinessDetails.hidden = true;
        readinessNote.textContent = "不会发起模型生成或制作请求。";
        readiness.setAttribute("aria-busy", "true");
        status.textContent = "";
        const data = await api("/director/preflight", { ...body, confirm: false });
        if (getProject() !== body.project_id) return;
        if (directorRevision !== revision) { status.textContent = "检查期间参数已修改，请重新检查当前内容。"; return; }
        openMissingDirectorSettings(data, body);
        showDirectorCheck(data);
        status.textContent = data.checks?.length ? "" : data.can_execute ? "配置检查通过。核对需求并勾选开始确认后，可以开始导演规划。" : data.requirements?.join("；") || data.message || "请核对导演条件。";
      } catch (error) {
        if (getProject() === originProject) {
          if (checking && directorRevision === revision) {
            readiness.dataset.state = "check_failed";
            readinessTitle.textContent = "未取得检查结果，可重新检查";
            readinessNote.textContent = error.message;
            status.textContent = "";
          } else status.textContent = error.message;
        }
      }
      finally { submitting = false; directorCheck.textContent = "检查导演条件"; readiness.removeAttribute("aria-busy"); syncDirectorButtons(); }
    }
    function outputs(row, card) {
      const list = el("div", null, { class: "montage-output-list" });
      const order = { video: 0, audio: 1, image: 2, file: 3 };
      const files = visibleOutputs(row).sort((a, b) => (order[a.kind] ?? 4) - (order[b.kind] ?? 4));
      for (const file of files.slice(0, 16)) {
        try {
          const url = urlFor(row.project_id, file.path);
          if (file.kind === "video" && file.playable) list.append(el("video", null, { src: url, controls: "", preload: "metadata" }));
          else if (file.kind === "audio" && file.playable) list.append(el("audio", null, { src: url, controls: "", preload: "metadata" }));
          else if (file.kind === "image") list.append(el("img", null, { src: url, alt: "本次原生工具实际产物", loading: "lazy" }));
          list.append(el("a", "下载 " + file.path.split("/").at(-1), { href: url, download: "" }));
        } catch (_) { /* Invalid output paths never become links. */ }
      }
      card.append(list);
      const candidates = row.native_result?.data?.candidates;
      if (Array.isArray(candidates) && candidates.length) {
        const notes = el("div", null, { class: "montage-suggestions" });
        candidates.forEach(item => notes.append(el("p", `${item.start_seconds}–${item.end_seconds} 秒 · ${item.title || item.text || "候选段落"}`)));
        const apply = el("button", "把建议填入批量裁剪，先审阅再导出", { type: "button", class: "secondary" });
        apply.addEventListener("click", () => host.dispatchEvent(new CustomEvent("montage:suggestions", { bubbles: true,
          detail: { project_id: row.project_id, candidates, source_path: row.source_path } })));
        notes.append(apply); card.append(notes);
      }
      if (row.native_result?.data) {
        const data = row.native_result.data;
        const readable = el("div", null, { class: "montage-result-summary" });
        const stockNotice=stockResultNotice(data);
        if(stockNotice) readable.append(el('p',stockNotice));
        const recoveryNotice = corpusRecoveryNotice(data);
        if (recoveryNotice) readable.append(el("p", recoveryNotice, {class: "corpus-recovery-notice", role: "status"}));
        if (Array.isArray(data.frames)) data.frames.forEach(frame => {
          const content = frame.answer || frame.description || frame.top_category;
          if (content) readable.append(el("p", `${Number(frame.frame_index || 0) + 1} · ${frame.query ? frame.query + " → " : ""}${content}`));
        });
        if (data.output_width && data.output_height) readable.append(el("p", `输出 ${data.output_width} × ${data.output_height}${data.faces_restored ? " · 已修复 " + data.faces_restored + " 张人脸" : ""}`));
        if (data.alignment?.engine === "whisperx_forced_ctc") {
          readable.append(el("p", `已定位 ${data.alignment.aligned_character_count} 个汉字 · 较低分数 ${data.alignment.low_score_character_count} 个 · 请对照配音核查`));
          data.alignment.limitations?.forEach(note => readable.append(el("p", note, {class: "media-hint"})));
          const jsonFile = row.outputs?.find(file => file.path === data.subtitles?.json)
            || row.outputs?.find(file => row.native_result?.artifacts?.includes(file.path) && file.path.endsWith(".json"));
          if (jsonFile && ["transcript_aligner", "transcriber"].includes(row.tool)) {
            const next = el("button", "用此字幕导出逐字高亮", {type: "button", class: "secondary"});
            next.addEventListener("click", () => {
              const values = {transcript_path: jsonFile.path};
              if (/\.(mp4|mov|webm|mkv)$/i.test(row.source_path || "")) values.input_path = row.source_path;
              void host.prepareMontageTool("remotion_caption_burn", values);
            });
            readable.append(next);
          }
        }
        if (Array.isArray(data.limitations)) data.limitations.forEach(note => readable.append(el("p", note, {class: "media-hint"})));
        if (readable.childElementCount) card.append(readable);
        const details = el("details", null, { class: "montage-settings" });
        details.append(el("summary", "原生数据与制作记录"), el("pre", JSON.stringify(row.native_result.data, null, 2)));
        card.append(details);
      }
    }
    async function refreshHistory() {
      clearTimeout(timer);
      const id = getProject(), seq = ++epoch;
      if (!id) { history.replaceChildren(); return; }
      try {
        const [jobs, sessions] = await Promise.all([api(`/jobs?project_id=${encodeURIComponent(id)}`), api(`/director/sessions?project_id=${encodeURIComponent(id)}`)]);
        if (seq !== epoch || getProject() !== id) return;
        if (historyProject !== id) historyCards.clear();
        historyProject = id;
        // Newest authoritative job per tool, including terminal receipts. A
        // missing row is not success and does not discard an accepted job.
        const newestJobs = new Map();
        for (const job of [...jobs.jobs].sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)))) if (!newestJobs.has(job.tool)) newestJobs.set(job.tool, job);
        for (const [tool,job] of newestJobs) {
          const tracked = toolJobs.get(`${id}:${tool}`);
          if (tracked?.awaitingHistory && tracked.job_id !== job.job_id) {
            const exact = jobs.jobs.find(row => row.job_id === tracked.job_id);
            if (exact) toolJobs.set(`${id}:${tool}`, exact);
          } else toolJobs.set(`${id}:${tool}`, job);
        }
        syncToolButton();
        const rows = [...jobs.jobs, ...sessions.sessions].sort((a, b) => b.created_at.localeCompare(a.created_at));
        if(toolStatusJob && toolStatusJob.project===id && toolStatusJob.tool===selectedTool?.name && currentMode==='tool'){
          const finished=jobs.jobs.find(job=>job.job_id===toolStatusJob.id);
          if(finished && !activeJob(finished)){
            status.textContent=finished.status==='completed'?'本次工具已完成，请在下方检查产物。':finished.error || finished.message || '本次任务已结束，请检查下方记录。';
            toolStatusJob=null;
          }
        }
        let heading = history.querySelector("h5");
        if (!heading) { heading = el("h5", "当前项目的 OpenMontage 制作记录"); history.append(heading); }
        const cards = [];
        for (const row of rows.slice(0, 12)) {
          const key = row.job_id || row.session_id;
          const signature = JSON.stringify([row.status, row.error, row.message, row.completed_stages,
            row.pending, row.outputs, row.native_result, row.spent_or_reserved_usd, row.hypit, row.progress]);
          const previous = historyCards.get(key);
          if (previous?.signature === signature) { cards.push(previous.card); continue; }
          const card = el("article", null, { class: "montage-job", "data-montage-state": row.status, "data-montage-job": key });
          const name = row.tool ? tools.find(tool => tool.name === row.tool)?.label || row.tool : capabilities?.pipelines.find(p => p.id === row.pipeline)?.label || row.pipeline;
          card.append(el("strong", `${name} · ${STATUSES[row.status] || row.status}`), el("p", row.error || row.message || ""));
          const progress = progressNotice(row);
          if (progress) card.append(el('p', progress, {class:'media-hint', 'data-native-progress':row.progress.phase}));
          if (row.hypit) {
            const hypit = row.hypit;
            const buildId = hypit.build_id || hypit.buildId || hypit.id;
            const state = hypit.status || hypit.execution_status;
            card.append(el("p", `Hypit${buildId ? " · Build ID: " + buildId : ""}${state ? " · 执行状态：" + (STATUSES[state] || state) : ""}`, {class: "media-hint", "data-hypit-build": buildId || ""}));
            const summary = hypit.summary || hypit.message;
            if (summary) card.append(el(typeof summary === "string" ? "p" : "pre", typeof summary === "string" ? summary : JSON.stringify(summary, null, 2), {class: "montage-hypit-summary"}));
          }
          if (row.completed_stages?.length) card.append(el("p", "已完成阶段：" + row.completed_stages.join(" → "), { class: "media-hint" }));
          if (row.session_id) card.append(el("p", `${row.provider} / ${row.model} · 已消费或预留 $${Number(row.spent_or_reserved_usd || 0).toFixed(4)} / $${row.budget_usd}`, { class: "media-hint" }));
          if (row.pending) {
            const pending = el("details", null, { class: "montage-settings" }); pending.open = true;
            pending.append(el("summary", "审阅本次待确认步骤"), el("p", row.pending.message || "请核对本次实际动作、文件与执行计划。"));
            if (row.pending.action) pending.append(el("pre", JSON.stringify(row.pending.action, null, 2)));
            if (row.pending.files) pending.append(el("strong", "本次文件"), el("pre", typeof row.pending.files === "string" ? row.pending.files : JSON.stringify(row.pending.files, null, 2)));
            if (row.pending.plan) pending.append(el("strong", "实际执行计划"), el("pre", typeof row.pending.plan === "string" ? row.pending.plan : JSON.stringify(row.pending.plan, null, 2)));
            if (row.pending.artifacts?.length) outputs({project_id: id, outputs: row.pending.artifacts}, pending);
            const approval = checkbox("确认这一项动作及所列数据传输 / 服务 / 费用，继续");
            const approve = el("button", "确认此步骤", { type: "button", class: "primary" });
            approve.addEventListener("click", async () => {
              if (!approval.input.checked) { status.textContent = "请先审阅这项动作并勾选确认。"; return; }
              approve.disabled = true;
              try { await api("/director/approve", { project_id: id, session_id: row.session_id, approval_id: row.pending.approval_id, confirm: true }); await refreshHistory(); }
              catch (error) { status.textContent = error.message; approve.disabled = false; }
            });
            pending.append(approval.label, approve); card.append(pending);
          }
          if (["queued", "running", "waiting_approval", "blocked"].includes(row.status)) {
            const cancel = el("button", "取消本次任务", { type: "button", class: "secondary compact" });
            cancel.addEventListener("click", async () => {
              cancel.disabled = true;
              window.WorkbenchInteractions?.setState(cancel,"cancelling",{label:"请求停止中"});
              try { await api(row.session_id ? "/director/cancel" : "/jobs/cancel", row.session_id ? { project_id: id, session_id: row.session_id } : { project_id: id, job_id: row.job_id }); await refreshHistory(); }
              catch (error) { status.textContent = error.message; cancel.disabled = false; }
            });
            card.append(cancel);
          }
          outputs(row, card);
          if (previous?.card.parentNode === history) previous.card.replaceWith(card);
          historyCards.set(key, {signature, card}); cards.push(card);
        }
        if (!rows.length) cards.push(el("p", "还没有制作任务。先检查条件，再开始。", { class: "media-hint" }));
        // Reuse unchanged cards: polling another task must not interrupt
        // playback or clear a checkbox the user is currently reviewing.
        let cursor = heading.nextSibling;
        cards.forEach(card => {
          if (cursor !== card) history.insertBefore(card, cursor);
          cursor = card.nextSibling;
        });
        while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
        const live = new Set(rows.slice(0, 12).map(row => row.job_id || row.session_id));
        for (const key of historyCards.keys()) if (!live.has(key)) historyCards.delete(key);
        if (rows.some(row => ["queued", "running", "cancelling"].includes(row.status)) && !host.hidden) timer = setTimeout(refreshHistory, 1800);
      } catch (error) { if (seq === epoch) status.textContent = error.message; }
    }
    function setMode(mode) {
      currentMode = mode;
      toolPane.hidden = mode !== "tool"; directorPane.hidden = mode !== "director";
      host.hidden = !["tool", "director"].includes(mode);
      if (!host.hidden) void load().then(refreshHistory).catch(() => {});
      else clearTimeout(timer);
    }
    picker.addEventListener("change", chooseTool);
    group.addEventListener("change", filterTools);
    query.addEventListener("input", filterTools);
    provider.addEventListener("change", () => { applyProviderDefaults(); updateDirector(); });
    model.addEventListener("input", updateDirector);
    model.addEventListener("change", updateDirector);
    engine.addEventListener("change", updateDirector);
    reference.addEventListener("change", () => { referenceInput.value = reference.value; directorConfirm.input.checked = false; updateReferencePreview(); });
    referenceInput.addEventListener("input", () => { reference.value = Array.from(reference.options).some(option => option.value === referenceInput.value.trim()) ? referenceInput.value.trim() : ""; updateReferencePreview(); });
    referenceImport.addEventListener("click", () => void importReference());
    check.addEventListener("click", () => void doTool(false));
    execute.addEventListener("click", () => void doTool(true));
    directorCheck.addEventListener("click", () => void doDirector(false));
    directorStart.addEventListener("click", () => void doDirector(true));
    recover.addEventListener("click", () => void recoverDirectorSubmission());
    retrySubmit.addEventListener("click", () => {
      const pending = pendingSubmission();
      if (pending?.lastStatus === "not_found") { pending.lastStatus = null; void submitDirector(pending); }
    });
    refresh.addEventListener("click", () => void refreshHistory());
    form.addEventListener("input", () => { confirmed.input.checked = false; });
    form.addEventListener("change", () => { confirmed.input.checked = false; });
    [network.input, paid.input, capture.input, code.input, ceiling].forEach(input => input.addEventListener('change', () => { confirmed.input.checked = false; }));
    const directorInputValues = new WeakMap();
    const directorInputValue = input => input.type === "checkbox" ? input.checked : input.value;
    directorPane.addEventListener("input", event => {
      if (event.target === directorConfirm.input) return;
      directorConfirm.input.checked = false;
      invalidateDirectorCheck();
      directorInputValues.set(event.target, directorInputValue(event.target));
    });
    directorPane.addEventListener("change", event => {
      if (event.target === directorConfirm.input) return;
      const value = directorInputValue(event.target);
      // A text field's blur can follow checkbox pre-activation. Its input
      // already revoked old consent; the same value must not revoke this click.
      if (directorInputValues.get(event.target) !== value) { directorConfirm.input.checked = false; invalidateDirectorCheck(); }
      directorInputValues.set(event.target, value);
    });
    function changedProject() {
      syncReferenceProject();
      if (getProject() === historyProject) return;
      epoch++; historyProject = getProject(); history.replaceChildren(); historyCards.clear();
      confirmed.input.checked = directorConfirm.input.checked = false;
      syncToolButton();
      readiness.hidden = true;
      syncDirectorButtons();
      status.textContent = historyProject ? "已切换当前项目，请核对所用素材与参数。" : "请先选择或载入一个项目。";
      if (!host.hidden) void refreshHistory();
    }
    document.addEventListener("studio:project", changedProject);
    document.getElementById("mediaProjectId")?.addEventListener("change", changedProject);
    document.getElementById("mediaProjectId")?.addEventListener("input", changedProject);
    host.addEventListener("focusin", changedProject);
    host.setMontageMode = setMode;
    host.setMontageAssets = rows => {
      syncReferenceProject();
      assets = Array.isArray(rows) ? rows : [];
      updateReferenceOptions();
      form.querySelectorAll("datalist").forEach(list => {
        const key = list.id.replace("montage-asset-", "");
        const kind = key.includes("video") ? "video" : key.includes("image") ? "image" : key.includes("audio") || key.includes("music") ? "audio" : "";
        list.replaceChildren();
        assets.filter(asset => !kind || asset.kind === kind).forEach(asset => list.append(el("option", asset.label || asset.path, {value: asset.path})));
      });
    };
    host.selectMontageTool = async name => {
      await load(); query.value = ""; group.value = ""; filterTools(); picker.value = name; chooseTool();
    };
    host.prepareMontageTool = async (name, values = {}) => {
      if (name === "remotion_caption_burn") values = {output_path: "captioned.mp4", ...values};
      await host.selectMontageTool(name);
      setMode("tool");
      for (const {key, schema, control, setValue} of controls) {
        if (!(key in values)) continue;
        if (setValue) setValue(values[key]);
        else if (schema.type === "boolean") control.checked = Boolean(values[key]);
        else control.value = ["array", "object"].includes(schema.type) ? JSON.stringify(values[key], null, 2) : String(values[key]);
        control.closest("details")?.setAttribute("open", "");
      }
      confirmed.input.checked = false;
      status.textContent = "已带入素材与字幕；请检查参数后确认制作。";
    };
    host.prepareMontageDirector = async (values = {}) => {
      const id = getProject();
      await load();
      if (getProject() !== id) throw new Error("项目已切换，请在当前项目重新选择参考视频。");
      if (pendingSubmission()) throw new Error("本项目有一项未收到回执的提交，请先核对任务记录。");
      syncReferenceProject();
      engine.value = values.execution_engine === "openmontage" ? "openmontage" : "hypit";
      if (Object.hasOwn(values, "reference_path")) referenceInput.value = referencePath(values.reference_path) || "";
      if (Object.hasOwn(values, "brief")) brief.value = String(values.brief || "");
      if (values.pipeline && Array.from(pipeline.options).some(option => option.value === values.pipeline)) pipeline.value = values.pipeline;
      updateReferenceOptions();
      updateDirector();
      setMode("director");
      directorConfirm.input.checked = false;
      invalidateDirectorCheck();
      status.textContent = "已带入导演需求与参考。请实际观看参考并检查条件；尚未开始分析或制作。";
    };
    updateReferenceOptions();
    setMode("composition");
  }
  function visibleOutputs(row) {
    const files = [...(row.outputs || [])];
    if (row.tool !== "remotion_caption_burn") return files;
    const declared = new Set(row.native_result?.artifacts || []);
    return files.filter(file => declared.has(file.path));
  }
  window.ZhejiangMontageStudio = {stockResultNotice, queriesFromLines, queriesToGuide, progressNotice, corpusRecoveryNotice,  mount, parseValue, urlFor, visibleOutputs, referencePath, referencePreviewUrl, referenceVideoExtensions: REFERENCE_VIDEO_EXTS };
})();
