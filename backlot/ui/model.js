const form = document.getElementById("requestForm");
const shell = document.querySelector(".shell");
const resultPanel = document.getElementById("resultPanel");
const qualityFocusToolbar = document.getElementById("qualityFocusToolbar");
const qualityExitFocus = document.getElementById("qualityExitFocus");
const speedProgressPanel = document.getElementById("speedProgressPanel");
const speedProgressBadge = document.getElementById("speedProgressBadge");
const speedProgressMessage = document.getElementById("speedProgressMessage");
const speedViewDetails = document.getElementById("speedViewDetails");
const speedExitFocus = document.getElementById("speedExitFocus");
const speedProgressSteps = {
  estimate: document.getElementById("speedStepEstimate"),
  candidates: document.getElementById("speedStepCandidates"),
  storyboard: document.getElementById("speedStepStoryboard"),
  video: document.getElementById("speedStepVideo"),
};
const preparePaid = document.getElementById("preparePaid");
const dialog = document.getElementById("confirmDialog");
const confirmForm = document.getElementById("confirmForm");
const confirmSubmit = document.getElementById("confirmSubmit");
const statusBadge = document.getElementById("statusBadge");
const statusMessage = document.getElementById("statusMessage");
const receipt = document.getElementById("receipt");
const rawEstimate = document.getElementById("rawEstimate");
const estimatedCost = document.getElementById("estimatedCost");
const estimatedModel = document.getElementById("estimatedModel");
const budgetCheck = document.getElementById("budgetCheck");
const confirmText = document.getElementById("confirmText");
const taskActions = document.getElementById("taskActions");
const taskIdElement = document.getElementById("taskId");
const queryTask = document.getElementById("queryTask");
const cancelTask = document.getElementById("cancelTask");
const videoLink = document.getElementById("videoLink");
const videoPending = document.getElementById("videoPending");
const videoPreview = document.getElementById("videoPreview");
const videoPreviewBadge = document.getElementById("videoPreviewBadge");
const videoPreviewHint = document.getElementById("videoPreviewHint");
const videoPreviewList = document.getElementById("videoPreviewList");
const projectLink = document.getElementById("projectLink");
const mediaPipeline = document.getElementById("mediaPipeline");
let workspaceView = "plan";
let workspaceNavigationRevision = 0;
let projectRestoreRevision = 0;
let editStep = "mediaNarrationCard";
const WORKSPACE_COPY = {
  plan: ["创意与脚本", "确定主题、核对资料，再选择创意方案。"],
  storyboard: ["分镜", "逐镜检查画面、运镜、时长和旁白文字；配音与字幕制作在第 4 步。"],
  video: ["视频生成", "确认镜头参数和费用，再提交生成；已完成片段会保留在项目里。"],
  edit: ["后期制作", "准备旁白与字幕，剪辑画面，再添加音乐和完成混音。"],
  delivery: ["验收与导出", "检查真实成片与报告，确认后导出本地交付包。"],
  tools: ["工具与设置", "按需要选用素材分析、抠图与动画工具；无需一次使用所有功能。"],
};

function syncWorkspaceView() {
  if (!shell || !mediaPipeline) return;
  const requestDetails = document.getElementById("projectRequestDetails");
  const requestSummary = document.getElementById("projectRequestSummary");
  const projectId = workflow.draftId;
  if (requestDetails && requestSummary) {
    shell.classList.toggle("existing-project", Boolean(projectId));
    if (requestDetails.dataset.project !== (projectId || "")) {
      requestDetails.open = !projectId && entryContext?.dataset.compactRequest !== "true";
      requestDetails.dataset.project = projectId || "";
    }
    const topic = document.getElementById("prompt")?.value.trim() || "未填写主题";
    requestSummary.textContent = projectId ? `项目需求：${topic.slice(0, 90)} · 点击查看/修改`
      : entryContext?.dataset.compactRequest === "true" ? "已接收创作需求 · 点击查看/修改"
        : "创作需求 · 点击展开或收起";
  }
  shell.dataset.workspaceView = workspaceView;
  const mediaVisible = ["edit", "delivery", "tools"].includes(workspaceView);
  mediaPipeline.hidden = !mediaVisible;
  document.querySelectorAll(".workspace-nav [data-workspace-view]").forEach(button => {
    if (button.dataset.workspaceView === workspaceView) button.setAttribute("aria-current", "step");
    else button.removeAttribute("aria-current");
  });
  const [title, hint] = WORKSPACE_COPY[workspaceView];
  document.getElementById("workspaceHeading").textContent = title;
  document.getElementById("workspaceHint").textContent = hint;
  document.getElementById("mediaWorkspaceTitle").textContent = title;
  document.getElementById("mediaWorkspaceNote").textContent = hint;
  document.getElementById("workspaceToolPicker").hidden = workspaceView !== "tools";
  document.getElementById("workspaceDiagnostics").hidden = workspaceView !== "tools";
  if (qualityReviewSection) qualityReviewSection.hidden = workspaceView !== "delivery";
  document.querySelectorAll(".media-recommended-path a").forEach(link => link.classList.toggle("selected", (window.WorkbenchInteractions?.groupFor(link.hash.slice(1)) || link.hash.slice(1)) === (window.WorkbenchInteractions?.groupFor(editStep) || editStep)));
  document.querySelectorAll("#mediaGrid > article").forEach(card => {
    const group = card.dataset.workspaceGroup || (card.id === "mediaPublishCard" ? "delivery"
      : ["mediaNarrationCard", "mediaAudioEnhanceCard", "mediaVideoComposeCard", "mediaMusicCard", "mediaAudioMixCard"].includes(card.id) ? "edit" : "tools");
    card.hidden = group !== workspaceView
      || (group === "tools" && card.id !== document.getElementById("workspaceToolSelect").value)
      || (group === "edit" && (window.WorkbenchInteractions?.groupFor(card.id) || card.id) !== (window.WorkbenchInteractions?.groupFor(editStep) || editStep));
  });
}

function setWorkspaceView(view) {
  if (!WORKSPACE_COPY[view]) return;
  workspaceView = view;
  const url = new URL(window.location.href);
  // Do not reopen the previous panel after refreshing another workspace.
  let fragment;
  try { fragment = document.getElementById(decodeURIComponent(url.hash.slice(1))); } catch { /* Ignore malformed links. */ }
  if (fragment?.dataset.workspaceGroup && fragment.dataset.workspaceGroup !== view) url.hash = "";
  if (["edit", "delivery", "tools"].includes(view)) url.searchParams.set("workspace", view);
  else url.searchParams.delete("workspace");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  syncWorkspaceView();
}
const toggleAdvancedMediaButton = document.getElementById("toggleAdvancedMedia");
const mediaProjectId = document.getElementById("mediaProjectId");
const mediaCapabilities = document.getElementById("mediaCapabilities");
const mediaCapabilityList = document.getElementById("mediaCapabilityList");
const openmontageToolCatalogButton = document.getElementById("openmontageToolCatalogButton");
const openmontageToolCatalogSummary = document.getElementById("openmontageToolCatalogSummary");
const openmontageToolCatalogPanel = document.getElementById("openmontageToolCatalogPanel");
const openmontageToolCatalogMeta = document.getElementById("openmontageToolCatalogMeta");
const openmontageToolCatalogGrid = document.getElementById("openmontageToolCatalogGrid");
const openmontagePipelineCatalogButton = document.getElementById("openmontagePipelineCatalogButton");
const openmontagePipelineCatalogPanel = document.getElementById("openmontagePipelineCatalogPanel");
const openmontagePipelineCatalogMeta = document.getElementById("openmontagePipelineCatalogMeta");
const openmontagePipelineCatalogGrid = document.getElementById("openmontagePipelineCatalogGrid");
const mediaLoadStatus = document.getElementById("mediaLoadStatus");
const mediaReferencePath = document.getElementById("mediaReferencePath");
const mediaReferenceDepth = document.getElementById("mediaReferenceDepth");
const mediaReferenceMaxKeyframes = document.getElementById("mediaReferenceMaxKeyframes");
const mediaReferenceButton = document.getElementById("mediaReferenceReview");
const mediaStockQueries = document.getElementById("mediaStockQueries");
const mediaStockSources = document.getElementById("mediaStockSources");
const mediaStockKind = document.getElementById("mediaStockKind");
const mediaStockClips = document.getElementById("mediaStockClips");
const mediaStockOrientation = document.getElementById("mediaStockOrientation");
const mediaStockEstimateButton = document.getElementById("mediaStockEstimate");
const mediaStockSearchButton = document.getElementById("mediaStockSearch");
const mediaTrimInput = document.getElementById("mediaTrimInput");
const mediaTrimStart = document.getElementById("mediaTrimStart");
const mediaTrimEnd = document.getElementById("mediaTrimEnd");
const mediaTrimCodec = document.getElementById("mediaTrimCodec");
const mediaTrimOutput = document.getElementById("mediaTrimOutput");
const mediaTrimEstimateButton = document.getElementById("mediaTrimEstimate");
const mediaTrimExecuteButton = document.getElementById("mediaTrimExecute");
const mediaPostprocessOperation = document.getElementById("mediaPostprocessOperation");
const mediaPostprocessInput = document.getElementById("mediaPostprocessInput");
const mediaPostprocessOutput = document.getElementById("mediaPostprocessOutput");
const mediaPostprocessMode = document.getElementById("mediaPostprocessMode");
const mediaPostprocessThreshold = document.getElementById("mediaPostprocessThreshold");
const mediaPostprocessMinSilence = document.getElementById("mediaPostprocessMinSilence");
const mediaPostprocessPadding = document.getElementById("mediaPostprocessPadding");
const mediaPostprocessSpeedFactor = document.getElementById("mediaPostprocessSpeedFactor");
const mediaPostprocessAspect = document.getElementById("mediaPostprocessAspect");
const mediaPostprocessProfile = document.getElementById("mediaPostprocessProfile");
const mediaPostprocessIntensity = document.getElementById("mediaPostprocessIntensity");
const mediaPostprocessSceneMethod = document.getElementById("mediaPostprocessSceneMethod");
const mediaPostprocessSceneThreshold = document.getElementById("mediaPostprocessSceneThreshold");
const mediaPostprocessSceneMinLength = document.getElementById("mediaPostprocessSceneMinLength");
const mediaPostprocessEstimateButton = document.getElementById("mediaPostprocessEstimate");
const mediaPostprocessExecuteButton = document.getElementById("mediaPostprocessExecute");
const mediaTranscriptPath = document.getElementById("mediaTranscriptPath");
const mediaNarrationStatus = document.getElementById("mediaNarrationStatus");
const mediaAnalysisPath = document.getElementById("mediaAnalysisPath");
const mediaFrameStrategy = document.getElementById("mediaFrameStrategy");
const mediaFrameCount = document.getElementById("mediaFrameCount");
const mediaFrameInterval = document.getElementById("mediaFrameInterval");
const mediaFrameTimestamps = document.getElementById("mediaFrameTimestamps");
const mediaFaceSampleFps = document.getElementById("mediaFaceSampleFps");
const mediaFrameEstimateButton = document.getElementById("mediaFrameEstimate");
const mediaFrameExecuteButton = document.getElementById("mediaFrameExecute");
const mediaFaceEstimateButton = document.getElementById("mediaFaceEstimate");
const mediaFaceExecuteButton = document.getElementById("mediaFaceExecute");
const mediaSegments = document.getElementById("mediaSegments");
const mediaTranscriptAlignment = document.getElementById("mediaTranscriptAlignment");
const mediaTranscriptModel = document.getElementById("mediaTranscriptModel");
let currentTranscriptReview = null;
const mediaAudioProvider = document.getElementById("mediaAudioProvider");
const mediaAudioRate = document.getElementById("mediaAudioRate");
const mediaAudioOperation = document.getElementById("mediaAudioOperation");
const mediaAudioPrimary = document.getElementById("mediaAudioPrimary");
const mediaAudioSecondary = document.getElementById("mediaAudioSecondary");
const mediaAudioVideo = document.getElementById("mediaAudioVideo");
const mediaAudioOutput = document.getElementById("mediaAudioOutput");
const mediaAudioMusicVolume = document.getElementById("mediaAudioMusicVolume");
const mediaAudioLufs = document.getElementById("mediaAudioLufs");
const mediaAudioTargetDuration = document.getElementById("mediaAudioTargetDuration");
const mediaAudioTracks = document.getElementById("mediaAudioTracks");
const mediaAudioSegments = document.getElementById("mediaAudioSegments");
const mediaAudioMixEstimateButton = document.getElementById("mediaAudioMixEstimate");
const mediaAudioMixExecuteButton = document.getElementById("mediaAudioMixExecute");
const mediaAudioEnhanceInput = document.getElementById("mediaAudioEnhanceInput");
const mediaAudioEnhancePreset = document.getElementById("mediaAudioEnhancePreset");
const mediaAudioEnhanceOutput = document.getElementById("mediaAudioEnhanceOutput");
const mediaAudioEnhanceExecuteButton = document.getElementById("mediaAudioEnhanceExecute");
const mediaMusicPrompt = document.getElementById("mediaMusicPrompt");
const mediaMusicReferenceVideo = document.getElementById("mediaMusicReferenceVideo");
const mediaMusicDuration = document.getElementById("mediaMusicDuration");
const mediaMusicProvider = document.getElementById("mediaMusicProvider");
const mediaMusicOutput = document.getElementById("mediaMusicOutput");
const mediaMusicInstrumental = document.getElementById("mediaMusicInstrumental");
const mediaMusicReadDurationButton = document.getElementById("mediaMusicReadDuration");
const mediaMusicEstimateButton = document.getElementById("mediaMusicEstimate");
const mediaMusicExecuteButton = document.getElementById("mediaMusicExecute");
const mediaMusicStatus = document.getElementById("mediaMusicStatus");
const mediaImagePrompts = document.getElementById("mediaImagePrompts");
const mediaClips = document.getElementById("mediaClips");
const mediaTransition = document.getElementById("mediaTransition");
const mediaAudioPath = document.getElementById("mediaAudioPath");
const mediaSubtitlePath = document.getElementById("mediaSubtitlePath");
const mediaOutputName = document.getElementById("mediaOutputName");
const mediaQualityFrames = document.getElementById("mediaQualityFrames");
const mediaQualityAudio = document.getElementById("mediaQualityAudio");
const mediaQualityBlack = document.getElementById("mediaQualityBlack");
const mediaQualitySubtitles = document.getElementById("mediaQualitySubtitles");
const mediaStillImages = document.getElementById("mediaStillImages");
const mediaStillDuration = document.getElementById("mediaStillDuration");
const mediaStillTransition = document.getElementById("mediaStillTransition");
const mediaStillOutputName = document.getElementById("mediaStillOutputName");
const mediaOutput = document.getElementById("mediaOutput");
const mediaPublishVideo = document.getElementById("mediaPublishVideo");
const mediaPublishTitle = document.getElementById("mediaPublishTitle");
const mediaPublishDescription = document.getElementById("mediaPublishDescription");
const mediaPublishTags = document.getElementById("mediaPublishTags");
const mediaPublishHashtags = document.getElementById("mediaPublishHashtags");
const mediaPublishPlatform = document.getElementById("mediaPublishPlatform");
const mediaPreview = document.getElementById("mediaPreview");
const mediaPreviewGrid = document.getElementById("mediaPreviewGrid");
const refreshMediaCapabilitiesButton = document.getElementById("refreshMediaCapabilities");
const heartbeat = document.getElementById("heartbeat");
const heartbeatLabel = document.getElementById("heartbeatLabel");
const heartbeatElapsed = document.getElementById("heartbeatElapsed");
const heartbeatDetail = document.getElementById("heartbeatDetail");
const workflowMode = document.getElementById("workflowMode");
const workflowModeHint = document.getElementById("workflowModeHint");
const workflowPanel = document.getElementById("workflowPanel");
const creativeSection = document.getElementById("creativeSection");
const storyboardSection = document.getElementById("storyboardSection");
const creativeModeBadge = document.getElementById("creativeModeBadge");
const storyboardModeBadge = document.getElementById("storyboardModeBadge");
const creativeStatus = document.getElementById("creativeStatus");
const storyboardStatus = document.getElementById("storyboardStatus");
const factGateBadge = document.getElementById("factGateBadge");
const factGateText = document.getElementById("factGateText");
const factChecklist = document.getElementById("factChecklist");
const candidateGrid = document.getElementById("candidateGrid");
const storyboardGrid = document.getElementById("storyboardGrid");
const generateCandidates = document.getElementById("generateCandidates");
const continueStoryboard = document.getElementById("continueStoryboard");
const approveStoryboard = document.getElementById("approveStoryboard");
const qualityVideoSection = document.getElementById("qualityVideoSection");
const qualityVideoBadge = document.getElementById("qualityVideoBadge");
const qualityVideoStatus = document.getElementById("qualityVideoStatus");
const qualityVideoSummary = document.getElementById("qualityVideoSummary");
const qualityVideoStoryboardDuration = document.getElementById("qualityVideoStoryboardDuration");
const qualityVideoShotPlan = document.getElementById("qualityVideoShotPlan");
const qualityPreparePaid = document.getElementById("qualityPreparePaid");
const generateStoryboardImages = document.getElementById("generateStoryboardImages");
const storyboardImageBadge = document.getElementById("storyboardImageBadge");
const storyboardImageStatus = document.getElementById("storyboardImageStatus");
const storyboardImageHeartbeat = document.getElementById("storyboardImageHeartbeat");
const storyboardImageHeartbeatLabel = document.getElementById("storyboardImageHeartbeatLabel");
const storyboardImageHeartbeatElapsed = document.getElementById("storyboardImageHeartbeatElapsed");
const storyboardImageHeartbeatProgress = document.getElementById("storyboardImageHeartbeatProgress");
const storyboardImageHeartbeatDetail = document.getElementById("storyboardImageHeartbeatDetail");
const qualityVideoModel = document.getElementById("qualityVideoModel");
const qualityVideoOperation = document.getElementById("qualityVideoOperation");
const qualityVideoDuration = document.getElementById("qualityVideoDuration");
const qualityVideoResolution = document.getElementById("qualityVideoResolution");
const qualityVideoAspect = document.getElementById("qualityVideoAspect");
const qualityVideoMaxCost = document.getElementById("qualityVideoMaxCost");
const qualityVideoAudio = document.getElementById("qualityVideoAudio");
const qualityVideoEstimateButton = document.getElementById("qualityVideoEstimate");
const qualityVideoEstimatedCost = document.getElementById("qualityVideoEstimatedCost");
const qualityVideoEstimateStatus = document.getElementById("qualityVideoEstimateStatus");
const qualityReviewSection = document.getElementById("qualityReviewSection");
const qualityReviewBadge = document.getElementById("qualityReviewBadge");
const qualityReviewStatus = document.getElementById("qualityReviewStatus");
const qualityReviewProjectLink = document.getElementById("qualityReviewProjectLink");
const qualityOpenMedia = document.getElementById("qualityOpenMedia");
const workflowStepEstimate = document.getElementById("workflowStepEstimate");
const workflowStepCandidates = document.getElementById("workflowStepCandidates");
const workflowStepStoryboard = document.getElementById("workflowStepStoryboard");
const workflowStepVideo = document.getElementById("workflowStepVideo");
const workflowProjectStatus = document.getElementById("workflowProjectStatus");
const workflowProjectLink = document.getElementById("workflowProjectLink");
const workflowOpenMedia = document.getElementById("workflowOpenMedia");
const entryContext = document.getElementById("entryContext");
const entryContextEyebrow = document.getElementById("entryContextEyebrow");
const entryContextTitle = document.getElementById("entryContextTitle");
const entryContextBadge = document.getElementById("entryContextBadge");
const entryContextDescription = document.getElementById("entryContextDescription");
const entryBrief = document.getElementById("entryBrief");
const entryContextNote = document.getElementById("entryContextNote");
const editProjectBrief = document.getElementById("editProjectBrief");
const entrySourceMeta = document.getElementById("entrySourceMeta");
const entrySourcePreview = document.getElementById("entrySourcePreview");
const changeEntryLink = document.getElementById("changeEntryLink");

let lastEstimate = null;
let pendingConfirmation = null;
let currentTaskId = null;
let heartbeatTimer = null;
let heartbeatStartedAt = 0;
let heartbeatBusy = false;
let heartbeatAttempts = 0;
let batchId = null;
let batchTaskIds = [];
// Heartbeat polling can return the same completed clips many times. Keep a
// stable signature so identical receipts do not tear down and recreate the
// <video> elements (which used to make the preview visibly flicker and reset
// playback controls on every poll).
let videoPreviewSignature = null;
let storyboardImageHeartbeatTimer = null;
let storyboardImageHeartbeatStartedAt = 0;
let storyboardImageHeartbeatTotal = 0;
let storyboardImageHeartbeatCompleted = 0;
let mediaActionBusy = false;
let workflow = {
  mode: "quality",
  stage: 0,
  candidates: [],
  selectedCandidateId: null,
  storyboard: null,
  storyboardApproved: false,
  storyboardImagesGenerated: false,
  imageGenerationReceipt: null,
  qualityVideoEstimateReady: false,
  qualityVideoEstimate: null,
  draftId: null,
  projectUrl: null,
};
if (preparePaid) preparePaid.hidden = workflowMode?.value === "quality";
let entryAutoRunInFlight = false;
const ENTRY_AUTO_RUN_KEY = "openmontage.entry_auto_run";

const SUCCESS_STATUSES = new Set(["succeeded", "success", "completed", "done"]);
const FAILURE_STATUSES = new Set(["failed", "error", "cancelled", "canceled"]);
// The request owner, not the animation layer, owns locks and approval gates.
let paidPhase = "idle", paidRevision = 0, paidRequestBusy = false, paidCancelPending = false;
const PAID_ACTIVE = new Set(["preparing", "confirming", "submitting", "queued", "running", "cancelling", "unknown"]);
function syncPaidButtons() {
  const locked = paidRequestBusy || PAID_ACTIVE.has(paidPhase);
  const ready = Boolean(lastEstimate?.valid && lastEstimate.within_max_cost === true && workflow.storyboardApproved);
  if (preparePaid) preparePaid.disabled = locked || workflow.mode === "quality" || !ready;
  if (qualityPreparePaid) qualityPreparePaid.disabled = locked || !ready || workflow.mode !== "quality" || workflow.stage !== 2 || !workflow.qualityVideoEstimateReady;
  if (confirmSubmit) confirmSubmit.disabled = paidRequestBusy || paidPhase === "submitting";
}
function setPaidPhase(state) {
  paidPhase = state;
  const labels = {idle:"进入付费二次确认",preparing:"正在准备确认单",confirming:"等待你的明确确认",submitting:"正在提交任务",queued:"已提交 · 等待任务",running:"视频生成中",cancelling:"取消已请求 · 等待回执",unknown:"等待任务状态",succeeded:"生成完成",failed:"未完成 · 重新确认",cancelled:"已取消 · 重新确认"};
  for (const button of [preparePaid, qualityPreparePaid]) window.WorkbenchInteractions?.setState(button,state,{label:labels[state] || labels.idle});
  syncPaidButtons();
}
function updatePaidReceipt(data) {
  let state = window.WorkbenchInteractions?.taskState(data?.status) || "unknown";
  if (paidCancelPending && ["queued","running","unknown"].includes(state)) state = "cancelling";
  if (["succeeded","failed","cancelled"].includes(state)) paidCancelPending = false;
  setPaidPhase(state);
  cancelTask.disabled = ["succeeded","failed","cancelled"].includes(state) || paidCancelPending;
  cancelTask.textContent = batchTaskIds.length > 1 ? "取消首个分镜任务" : "取消远程任务";
  window.WorkbenchInteractions?.setState(cancelTask, paidCancelPending ? "cancelling" : "ready");
}
function invalidatePaidContext() {
  paidRevision += 1; paidRequestBusy = false; paidCancelPending = false;
  pendingConfirmation = null; stopHeartbeat(); heartbeatBusy = false;
  currentTaskId = null; batchId = null; batchTaskIds = [];
  setPaidPhase("idle");
  if (dialog.open) dialog.close();
}
const ENTRY_MODE_CONFIG = {
  guided: {
    title: "一句话导演",
    badge: "自然语言入口",
    description: "草案已从一句话导演入口交接过来。先确认主题与预算，再按质量优先或速度优先推进事实核验、三案、分镜和视频任务。",
  },
  material: {
    title: "长文与素材导入",
    badge: "素材入口",
    description: "草案已从长文与素材导入入口交接过来。原始文件名和补充文本保留在本机草案中，下面继续做事实分层、创意选优和分镜规划。",
  },
  storyboard: {
    title: "分镜表接管",
    badge: "专业入口",
    description: "草案已从分镜表接管入口交接过来。现有表格作为生产基线，导演工作台只补齐视觉重点、运镜、声音、连续性和质检证据。",
  },
};

function readEntryDraft() {
  try {
    const raw = sessionStorage.getItem("openmontage.entry_draft");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

const DRAFT_PROMPT_KEY = "openmontage.workflow_draft_prompt";
const WORKFLOW_PHASES = {
  candidates: "proposal_review",
  storyboard: "storyboard_review",
  video: "video_parameters",
  provider: "provider_running",
  review: "quality_review",
  postproduction: "postproduction",
  publish: "publish_review",
  done: "done",
};

function projectQueryId() {
  return String(new URLSearchParams(window.location.search).get("project") || "").trim();
}

function resumeStageQuery() {
  return String(new URLSearchParams(window.location.search).get("resume_stage") || "").trim();
}

function normalizeResumeShots(value) {
  const shots = Array.isArray(value) ? value : Array.isArray(value?.shots) ? value.shots : [];
  return shots.map((shot, index) => {
    const start = Number(shot?.start_seconds);
    const end = Number(shot?.end_seconds);
    const duration = Number(shot?.duration_seconds ?? shot?.duration_hint_seconds);
    const imagePath = shot?.image_path || shot?.image_url || shot?.frame_path || shot?.preview_path || shot?.visual?.path || null;
    return {
      ...shot,
      id: String(shot?.id || shot?.shot_id || `shot-${String(index + 1).padStart(2, "0")}`),
      title: shot?.title || shot?.name || shot?.section_label || `镜头 ${index + 1}`,
      purpose: shot?.purpose || shot?.shot_intent || shot?.description || "",
      duration_seconds: Number.isFinite(duration) && duration > 0
        ? Math.round(duration)
        : Number.isFinite(start) && Number.isFinite(end) && end > start ? Math.round(end - start) : 5,
      visual_prompt: shot?.visual_prompt || shot?.visual || shot?.description || "",
      motion_prompt: shot?.motion_prompt || shot?.movement || shot?.motion || "",
      first_frame_contract: shot?.first_frame_contract || shot?.first_frame || "",
      last_frame_contract: shot?.last_frame_contract || shot?.last_frame || "",
      continuity_anchor: shot?.continuity_anchor || shot?.continuity || "",
      image_path: imagePath,
      image_sha256: shot?.image_sha256 || null,
      image_provider: shot?.image_provider || shot?.provider || null,
      image_model: shot?.image_model || shot?.model || null,
    };
  });
}

function phaseToQualityStage(phase, fallback = 0) {
  const normalized = String(phase || "").toLowerCase();
  if (["proposal_review", "candidates", "proposal", "idea", "script"].includes(normalized)) return 0;
  if (["storyboard_review", "scene_plan", "storyboard", "assets"].includes(normalized)) return 1;
  if (["video_parameters", "video", "edit", "compose", "provider_running", "provider_failed", "postproduction"].includes(normalized)) return 2;
  if (["quality_review", "review", "publish_review", "publish", "done"].includes(normalized)) return 3;
  return Math.max(0, Math.min(3, Number(fallback) || 0));
}

function restoredWorkspace(phase, requested, stage, hasStoryboard, storyboardApproved) {
  const normalized = String(phase || "").toLowerCase();
  const current = normalized === "postproduction" ? "edit"
    : ["quality_review", "review", "publish_review", "publish", "done"].includes(normalized) ? "delivery"
      : ["plan", "storyboard", "video", "delivery"][stage] || "plan";
  if (requested === "plan") return requested;
  if (requested === "storyboard" && hasStoryboard) return requested;
  if (requested === "video" && storyboardApproved) return requested;
  if (["edit", "delivery", "tools"].includes(requested)) return requested;
  return current;
}

function inferResumePhase(resume, state) {
  const explicit = resume?.workflow_state?.phase || resume?.resume_phase || resume?.phase;
  if (explicit) return String(explicit);
  const stages = Array.isArray(state?.stages) ? state.stages : [];
  const active = stages.find((stage) => ["in_progress", "awaiting_human"].includes(stage?.status));
  if (active) return active.name === "proposal" ? "proposal_review" : active.name === "scene_plan" ? "storyboard_review" : active.name;
  if (state?.artifacts?.final_review || state?.artifacts?.render_report) return "quality_review";
  if (state?.artifacts?.scene_plan) return "storyboard_review";
  if (state?.artifacts?.proposal_packet) return "proposal_review";
  return "proposal_review";
}

function inferResumeMode(resume, state) {
  const snapshot = resume?.workflow_state || {};
  const marker = resume?.marker || resume?.project || {};
  return [snapshot.workflow_mode, marker.workflow_mode, state?.workflow_mode]
    .map((value) => String(value || "").toLowerCase())
    .find((value) => value === "quality" || value === "speed") || "quality";
}

function artifactCandidates(artifacts) {
  const options = artifacts?.proposal_packet?.concept_options;
  return Array.isArray(options) ? options.map((item) => ({
    ...item,
    id: item.id || item.concept_id || item.option_id,
    concept: item.concept || item.description || item.hook || "",
    hook: item.hook || item.concept || item.description || "",
  })).filter((item) => item.id) : [];
}

function artifactStoryboard(artifacts, state) {
  const scenes = artifacts?.scene_plan?.scenes || state?.storyboard?.scenes || [];
  // New production runs record confirmed frames in asset_manifest, while
  // older OpenMontage image jobs only wrote image_manifest.json.  Treat both
  // as the same durable source when restoring a project; otherwise a refresh
  // would show the already-generated PNGs in the media list but mark every
  // video shot as "missing confirmed storyboard image".
  const assets = artifacts?.asset_manifest?.assets || [];
  const generatedImages = artifacts?.image_manifest?.images || [];
  const byScene = new Map();
  assets.forEach((asset) => {
    const sceneId = String(asset?.scene_id ?? asset?.shot_id ?? "");
    if (!sceneId || !asset?.path) return;
    // Asset manifests also contain the final per-shot videos.  Those are
    // valid Backlot media, but they are not storyboard stills and must never
    // be fed back into the image-to-video gate as an <img> source.  Accept
    // explicit image/frame types and image extensions only.
    const type = String(asset.type || asset.kind || "").toLowerCase();
    const path = String(asset.path || "").toLowerCase();
    const isImage = ["image", "frame", "storyboard_image", "still"].includes(type)
      || /\.(png|jpe?g|webp|gif|avif)(?:$|[?#])/.test(path);
    if (!isImage) return;
    if (!byScene.has(sceneId)) byScene.set(sceneId, asset);
  });
  generatedImages.forEach((image) => {
    const sceneId = String(image?.scene_id ?? image?.shot_id ?? "");
    if (!sceneId || !image?.path || byScene.has(sceneId)) return;
    byScene.set(sceneId, {
      ...image,
      type: "image",
      provider: image.provider || image.image_provider || null,
      model: image.model || image.image_model || null,
    });
  });
  return {
    shots: normalizeResumeShots(scenes).map((shot) => {
      const asset = byScene.get(String(shot.id));
      return asset?.path && !shot.image_path ? {
        ...shot,
        image_path: asset.path,
        image_sha256: asset.sha256 || null,
        image_provider: asset.provider || null,
        image_model: asset.model || null,
      } : shot;
    }),
    total_duration_seconds: Number(artifacts?.scene_plan?.metadata?.total_duration_seconds
      || state?.storyboard?.total_duration_seconds || 0) || null,
    style_playbook: artifacts?.scene_plan?.style_playbook || state?.storyboard?.style_playbook || null,
  };
}

async function restoreProjectWorkflow(projectId, { preserveWorkspace = false } = {}) {
  if (!projectId) return false;
  const navigationRevision = workspaceNavigationRevision;
  const restoreRevision = ++projectRestoreRevision;
  let resume;
  try {
    resume = await getJSON(`/api/project/${encodeURIComponent(projectId)}/resume`);
  } catch (error) {
    // Older local projects do not have the resume endpoint yet.  Their board
    // state is still enough for a conservative, review-only restoration.
    try {
      resume = { state: await getJSON(`/api/project/${encodeURIComponent(projectId)}/state`), legacy_degraded: true };
    } catch (fallbackError) {
      setStatus("error", "项目恢复失败", `${fallbackError.message}；请先打开 Backlot 查看项目状态。`);
      return false;
    }
  }
  if (restoreRevision !== projectRestoreRevision) return true;
  stockPlanUseProposal = false;
  stockPendingAutomatic = null;
  const requestedWorkspace = new URLSearchParams(window.location.search).get("workspace");
  const state = resume?.state || resume?.board_state || resume?.project_state || {};
  const snapshot = resume?.workflow_state || {};
  const artifacts = snapshot.artifacts || state.artifacts || {};
  const mode = inferResumeMode(resume, state);
  const phase = resumeStageQuery() || inferResumePhase(resume, state);
  const proposalCandidates = Array.isArray(snapshot.candidates) && snapshot.candidates.length
    ? snapshot.candidates : artifactCandidates(artifacts);
  const selected = snapshot.selected_candidate_id
    || artifacts?.proposal_packet?.selected_concept?.concept_id
    || resume?.selected_candidate_id
    || null;
  const storyboard = snapshot.storyboard?.shots?.length
    ? { ...snapshot.storyboard, shots: normalizeResumeShots(snapshot.storyboard.shots) }
    : artifactStoryboard(artifacts, state);
  const allImages = storyboard.shots.length > 0 && storyboard.shots.every((shot) => Boolean(
    shot.image_path || shot.image_url || shot.frame_path || shot.preview_path,
  ));
  const stages = Array.isArray(state.stages) ? state.stages : [];
  const assetsStage = stages.find((stage) => stage.name === "assets");
  const storyboardApproved = snapshot.storyboard_approved === true
    || (assetsStage?.status === "completed" && assetsStage?.human_approved === true)
    || ["video_parameters", "provider_running", "provider_failed", "postproduction", "quality_review", "publish_review", "done"].includes(phase);

  workflow = {
    mode,
    stage: phaseToQualityStage(phase, mode === "speed" && storyboard.shots.length ? 2 : 0),
    candidates: proposalCandidates,
    selectedCandidateId: selected,
    storyboard: storyboard.shots.length ? storyboard : null,
    storyboardApproved,
    storyboardImagesGenerated: snapshot.storyboard_images_complete === true || allImages,
    imageGenerationReceipt: snapshot.image_generation_receipt || null,
    qualityVideoEstimateReady: false,
    qualityVideoEstimate: null,
    draftId: projectId,
    projectUrl: `/p/${encodeURIComponent(projectId)}`,
    draftPrompt: snapshot.prompt || artifacts?.brief?.prompt || resume?.prompt || state?.title || "",
    resumePhase: phase,
    legacyDegraded: Boolean(resume?.legacy_degraded),
  };
  const chosenWorkspace = preserveWorkspace || workspaceNavigationRevision !== navigationRevision ? workspaceView
    : restoredWorkspace(phase, requestedWorkspace, workflow.stage, Boolean(workflow.storyboard), storyboardApproved);
  const videoParams = snapshot.video_parameters || {};
  if (qualityVideoModel && ["mini", "standard"].includes(String(videoParams.model_variant || ""))) qualityVideoModel.value = videoParams.model_variant;
  if (qualityVideoResolution && videoParams.resolution) qualityVideoResolution.value = String(videoParams.resolution);
  if (qualityVideoAspect && videoParams.aspect_ratio) qualityVideoAspect.value = String(videoParams.aspect_ratio);
  if (qualityVideoMaxCost && videoParams.max_cost_cny != null) qualityVideoMaxCost.value = String(videoParams.max_cost_cny);
  if (qualityVideoDuration && videoParams.duration != null) qualityVideoDuration.value = String(videoParams.duration);
  const prompt = workflow.draftPrompt;
  if (prompt && document.getElementById("prompt")) document.getElementById("prompt").value = prompt;
  if (workflowMode) workflowMode.value = mode;
  showRestoredProjectContext(projectId, state?.title || resume?.title || "", prompt, chosenWorkspace);
  sessionStorage.setItem("openmontage.workflow_draft_id", projectId);
  if (prompt) sessionStorage.setItem(DRAFT_PROMPT_KEY, prompt);
  if (workflowProjectStatus) {
    workflowProjectStatus.textContent = workflow.legacyDegraded
      ? "已恢复旧项目；关键审批数据缺失，付费确认需要重新完成。"
      : "已从本机项目快照恢复；不会自动重新估算或提交模型任务。";
  }
  if (workflowProjectLink) {
    workflowProjectLink.href = `/p/${encodeURIComponent(projectId)}`;
    workflowProjectLink.hidden = false;
    workflowProjectLink.textContent = "打开本项目 Backlot 记录";
  }
  if (workflowOpenMedia) workflowOpenMedia.hidden = false;
  workflowPanel.hidden = false;
  lastEstimate = null;
  currentTaskId = resume?.task_id || resume?.current_task_id || null;
  batchId = resume?.batch_id || null;
  batchTaskIds = Array.isArray(resume?.task_ids) ? resume.task_ids : [];
  if (proposalCandidates.length) renderCandidates();
  if (workflow.storyboard) {
    renderStoryboard();
    syncStoryboardImageGate();
  }
  if (mode === "quality") {
    setQualityStage(workflow.stage);
    if (workflow.stage >= 2) {
      // setQualityStage syncs the defaults into the stage; restore any saved
      // video controls after that one-time layout pass.
      if (qualityVideoModel && videoParams.model_variant) qualityVideoModel.value = String(videoParams.model_variant);
      if (qualityVideoResolution && videoParams.resolution) qualityVideoResolution.value = String(videoParams.resolution);
      if (qualityVideoAspect && videoParams.aspect_ratio) qualityVideoAspect.value = String(videoParams.aspect_ratio);
      if (qualityVideoMaxCost && videoParams.max_cost_cny != null) qualityVideoMaxCost.value = String(videoParams.max_cost_cny);
      if (qualityVideoDuration && videoParams.duration != null) qualityVideoDuration.value = String(videoParams.duration);
      updateQualityVideoSummary();
    }
    setModeFocus("quality");
  } else {
    creativeSection.hidden = proposalCandidates.length === 0;
    storyboardSection.hidden = !workflow.storyboard;
    setModeFocus("speed", { details: true });
    setWorkflowStep(workflow.stage >= 2 ? 2 : proposalCandidates.length ? 1 : 0);
  }
  syncReceiptVisibility();
  // A restored project may expose both the first task and a batch handle.
  // Only start a poller for a genuinely non-terminal provider job.  The old
  // branch started the batch heartbeat whenever task_ids existed, even after
  // Backlot had persisted `succeeded`; reopening a finished project then
  // showed a misleading "0/7 generating" banner and could issue pointless
  // provider queries.
  const running = String(resume?.task_status || resume?.status || "").toLowerCase();
  const batchStatus = String(
    resume?.active_batch?.status || resume?.batch_status || running || "",
  ).toLowerCase();
  const taskTerminal = SUCCESS_STATUSES.has(running) || FAILURE_STATUSES.has(running);
  const batchTerminal = SUCCESS_STATUSES.has(batchStatus) || FAILURE_STATUSES.has(batchStatus);
  // A storyboard batch is the unit shown in the UI. Prefer its aggregate
  // heartbeat over polling only the first shot; the latter made a 7-shot run
  // look like one 5-second task after reopening the project.
  if (batchId && batchTaskIds.length && !batchTerminal) {
    startBatchHeartbeat({ batch_id: batchId, task_ids: batchTaskIds, status: batchStatus || "restored" });
  } else if (currentTaskId && running && !taskTerminal) {
    startHeartbeat({ task_id: currentTaskId, status: running });
  } else if (batchId && batchTaskIds.length && SUCCESS_STATUSES.has(batchStatus)) {
    // The provider batch is already terminal.  Move a quality workflow to
    // the review gate immediately so the creator can continue without a
    // refresh or another network call.
    if (mode === "quality") {
      setQualityStage(3);
      if (qualityReviewBadge) qualityReviewBadge.textContent = "可开始实测";
      if (qualityReviewStatus) qualityReviewStatus.textContent = "已恢复已完成的视频任务；现在进入裁判式质检，可直接运行真实抽帧、音频、黑帧和字幕检查。";
    }
  }
  if (taskTerminal || batchTerminal) updatePaidReceipt({status:batchTerminal ? batchStatus : running});
  const restoredFailure = phase === "provider_failed" || FAILURE_STATUSES.has(batchStatus) || FAILURE_STATUSES.has(running);
  setStatus(
    restoredFailure ? "error" : "ok",
    restoredFailure ? "生成任务失败" : "项目已恢复",
    restoredFailure
      ? "已保留已完成镜头；请打开项目记录查看失败原因并仅重试失败镜头。"
      : workflow.legacyDegraded
        ? "已恢复可见工件；旧项目缺少部分快照，请在当前阶段重新检查后再进行付费确认。"
        : `当前停在“${phase}”；可继续处理，刷新不会重新创建模型任务。`,
  );
  if (chosenWorkspace) {
    if (["plan", "storyboard", "video"].includes(chosenWorkspace)) setQualityStage(["plan", "storyboard", "video"].indexOf(chosenWorkspace));
    else setWorkspaceView(chosenWorkspace);
  }
  if (requestedWorkspace && requestedWorkspace !== chosenWorkspace && !preserveWorkspace) {
    const url = new URL(window.location.href);
    url.searchParams.delete("workspace");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }
  window.requestAnimationFrame(() => document.querySelector(".workspace-context")?.scrollIntoView({ block: "start", behavior: "auto" }));
  return true;
}

function initEntryContext() {
  const params = new URLSearchParams(window.location.search);
  const requestedMode = params.get("entry");
  const requestedView = ["quality", "speed"].includes(params.get("view")) ? params.get("view") : null;
  if (projectQueryId() || !ENTRY_MODE_CONFIG[requestedMode]) return;
  const draft = readEntryDraft();
  if (draft?.mode !== requestedMode || !draft?.prompt) {
    window.location.replace(`/create/${requestedMode}`);
    return;
  }
  const mode = requestedMode;
  if (!entryContext) return;

  const config = ENTRY_MODE_CONFIG[mode];
  entryContext.hidden = false;
  entryContext.dataset.compactRequest = mode === "guided" ? "true" : "false";
  entryContextEyebrow.textContent = "新建项目 / 已接收创作需求";
  entryContextTitle.textContent = config.title;
  entryContextBadge.textContent = config.badge;
  entryContextDescription.textContent = config.description;
  entryBrief.textContent = draft.prompt;
  entryBrief.hidden = false;
  entryContextNote.textContent = "已沿用入口内容；下面继续选择方案、检查分镜。";
  entryContextNote.hidden = false;
  changeEntryLink.href = `/create/${mode}`;
  changeEntryLink.textContent = "更换制作入口";

  if (draft?.prompt) document.getElementById("prompt").value = draft.prompt;
  if (mode === "guided" && draft?.settings) {
    const settings = draft.settings;
    if (["quality", "speed"].includes(settings.workflowMode)) {
      workflowMode.value = settings.workflowMode;
      workflow.mode = settings.workflowMode;
    }
    if (["9:16", "16:9", "1:1"].includes(settings.aspectRatio)) {
      document.getElementById("aspectRatio").value = settings.aspectRatio;
    }
    const budget = Number(settings.budget);
    if (Number.isFinite(budget) && budget > 0) document.getElementById("maxCost").value = budget;
    workflowModeHint.textContent = workflow.mode === "speed"
      ? "速度优先会在服务端给三案评分，自动选择最高分方案并推进到分镜；付费模型仍保留二次确认。"
      : "质量优先会先展示三套差异化方案；你选定后再生成分镜，确认分镜后才进入付费视频任务。";
  }
  // The entry page is the source of truth for a guided handoff. A query view
  // is only accepted for that entry, so a stale/manual URL cannot silently
  // change a material or imported-storyboard workflow.
  if (mode === "guided" && requestedView) {
    workflowMode.value = requestedView;
    workflow.mode = requestedView;
    workflowModeHint.textContent = requestedView === "speed"
      ? "速度优先会自动完成免费估算、三案评分和分镜规划；付费视频仍需一次明确确认。"
      : "质量优先会整屏展示三套方案；你选定并确认后，再逐镜检查分镜和进入视频生成。";
  }

  entrySourceMeta.innerHTML = "";
  const names = Array.isArray(draft?.fileNames) ? draft.fileNames.filter(Boolean) : [];
  if (names.length) {
    const files = document.createElement("span");
    files.textContent = `来源文件：${names.join("、")}`;
    entrySourceMeta.append(files);
  }
  if (draft?.settings?.contentType) {
    const type = document.createElement("span");
    type.textContent = `内容类型：${draft.settings.contentType}`;
    entrySourceMeta.append(type);
  }
  if (draft?.settings?.strategy) {
    const strategy = document.createElement("span");
    strategy.textContent = `接管策略：${draft.settings.strategy}`;
    entrySourceMeta.append(strategy);
  }
  if (draft?.sourceText) {
    entrySourcePreview.hidden = false;
    entrySourcePreview.textContent = draft.sourceText;
  }
}

function showRestoredProjectContext(projectId, title, prompt, workspace) {
  if (!entryContext) return;
  entryContext.hidden = false;
  entryContext.dataset.compactRequest = "true";
  entryContextEyebrow.textContent = "当前项目 / 继续制作";
  entryContextTitle.textContent = title || "继续已有项目";
  entryContextBadge.textContent = WORKSPACE_COPY[workspace]?.[0] || "项目已恢复";
  entryContextDescription.textContent = "已从本机项目记录恢复当前进度；可以从停下的步骤继续。";
  entryBrief.textContent = prompt || title || "项目需求未记录";
  entryBrief.hidden = !prompt || prompt.trim() === title.trim();
  entrySourceMeta.replaceChildren();
  const id = document.createElement("span");
  id.textContent = `项目：${projectId}`;
  entrySourceMeta.append(id);
  entrySourcePreview.hidden = true;
  entrySourcePreview.textContent = "";
  changeEntryLink.href = `/p/${encodeURIComponent(projectId)}`;
  changeEntryLink.textContent = "查看项目记录";
  entryContextNote.hidden = true;
}

function refreshProjectBriefForEstimate() {
  if (!entryContext || entryContext.hidden) return;
  const prompt = modelPayload().prompt;
  if (!prompt) return;
  if (workflow.draftId && workflow.draftPrompt && prompt !== workflow.draftPrompt) {
    entryContextEyebrow.textContent = "新的创作需求 / 重新规划";
    entryContextTitle.textContent = "重新规划当前主题";
    entryContextBadge.textContent = "待估算";
    entryContextDescription.textContent = "需求已修改；继续时会建立新草案，原项目仍保留在项目库。";
    entrySourceMeta.replaceChildren();
    changeEntryLink.href = "/create/guided";
    changeEntryLink.textContent = "更换制作入口";
  }
  entryBrief.textContent = prompt;
  entryBrief.hidden = false;
}

function requestedEntryView() {
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view");
  return ["quality", "speed"].includes(view) ? view : null;
}

function entryAutoRunSignature(draft, view) {
  return JSON.stringify({
    createdAt: draft?.createdAt || null,
    mode: draft?.mode || null,
    view,
    prompt: draft?.prompt || "",
    settings: draft?.settings || {},
  });
}

async function autoStartEntryWorkflow() {
  const params = new URLSearchParams(window.location.search);
  const view = requestedEntryView();
  const draft = readEntryDraft();
  if (params.get("entry") !== "guided" || !view || draft?.mode !== "guided" || !draft?.prompt) return;

  const signature = entryAutoRunSignature(draft, view);
  // A second invocation during the same page load must not submit another
  // estimate. After a full refresh, however, the in-memory workflow is gone;
  // in that case rerun the free handoff so the focused workbench is rebuilt
  // instead of leaving the creator on an empty parameter page.
  if (entryAutoRunInFlight) return;
  if (sessionStorage.getItem(ENTRY_AUTO_RUN_KEY) === signature && (lastEstimate || workflow.candidates.length || workflow.storyboard)) {
    setModeFocus(view, { details: view === "speed" && Boolean(workflow.storyboard) });
    return;
  }
  // Set the guard before the first request so a double navigation cannot
  // create two planning runs. The request is a free dry-run; failure leaves
  // the normal manual controls available for a deliberate retry.
  sessionStorage.setItem(ENTRY_AUTO_RUN_KEY, signature);
  entryAutoRunInFlight = true;
  workflowMode.value = view;
  workflow.mode = view;
  setStatus("neutral", "正在接管入口草案", view === "quality"
    ? "正在免费估算并准备三套方案；完成后会停在创作者选择。"
    : "正在免费估算并自动完成三案评分与分镜规划；不会创建付费任务。 ");
  setModeFocus(view);
  try {
    const data = await postJSON("/model-api/api/tasks/estimate", modelPayload());
    const continuation = showEstimate(data, { autoAdvance: true });
    if (continuation) await continuation;
    if (view === "quality" && data.valid && data.within_max_cost === true) {
      await runCandidates();
    }
  } catch (error) {
    lastEstimate = null;
    workflowPanel.hidden = true;
    setStatus("error", "入口接管失败", `${error.message}；你仍可点击“免费估算”手动重试。`);
    showProjectRequest();
  } finally {
    entryAutoRunInFlight = false;
  }
}

function setStatus(kind, label, message) {
  statusBadge.className = `status ${kind}`;
  statusBadge.textContent = label;
  statusMessage.textContent = message;
  const details = statusMessage.closest("details");
  if (details && ["error", "warn"].includes(kind)) details.open = true;
  syncSpeedProgress(label, message);
}

function speedProgressPhase() {
  if (currentTaskId) return 3;
  if (workflow.storyboardApproved) return 3;
  if (workflow.storyboard) return 2;
  if (workflow.candidates.length) return 1;
  if (lastEstimate) return 0;
  return -1;
}

function syncSpeedProgress(label = "准备中", message = "系统会自动完成估算、三案评分、分镜规划和进入视频任务前的检查。") {
  if (!speedProgressPanel) return;
  speedProgressBadge.textContent = label;
  speedProgressMessage.textContent = message;
  const phase = speedProgressPhase();
  const keys = Object.keys(speedProgressSteps);
  keys.forEach((key, index) => {
    const step = speedProgressSteps[key];
    if (!step) return;
    step.classList.toggle("done", phase > index);
    step.classList.toggle("active", phase === index);
  });
}

function updateModeFocusUrl(mode) {
  const url = new URL(window.location.href);
  if (mode === "quality" || mode === "speed") url.searchParams.set("view", mode);
  else url.searchParams.delete("view");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function setModeFocus(mode, { scroll = false, details = false } = {}) {
  const focusedMode = mode === "quality" || mode === "speed" ? mode : null;
  // Quality gets the immersive single-workspace view. Speed keeps the
  // original two-column layout so the creator can see parameters and the
  // automatically produced result at the same time.
  shell?.classList.toggle("mode-focus", focusedMode === "quality");
  shell?.classList.toggle("quality-focus", focusedMode === "quality");
  shell?.classList.toggle("speed-focus", focusedMode === "speed");
  shell?.classList.toggle("speed-details", focusedMode === "speed" && details);
  if (qualityFocusToolbar) qualityFocusToolbar.hidden = focusedMode !== "quality";
  if (speedProgressPanel) speedProgressPanel.hidden = focusedMode !== "speed";
  if (speedViewDetails) speedViewDetails.textContent = details ? "收起详细流程" : "展开详细流程";
  if (focusedMode) updateModeFocusUrl(focusedMode);
  else updateModeFocusUrl(null);
  if (scroll) {
    const target = focusedMode === "quality" ? resultPanel : form;
    window.requestAnimationFrame(() => target?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }
  syncSpeedProgress(statusBadge?.textContent || "准备中", statusMessage?.textContent || undefined);
}

function exitModeFocus() {
  setModeFocus(null);
  if (speedProgressPanel) speedProgressPanel.hidden = true;
}

function showProjectRequest() {
  exitModeFocus();
  const details = document.getElementById("projectRequestDetails");
  if (details) details.open = true;
  form?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function modelPayload() {
  return {
    prompt: document.getElementById("prompt").value.trim(),
    model_variant: document.getElementById("modelVariant").value,
    operation: document.getElementById("operation").value,
    duration: Number(document.getElementById("duration").value),
    aspect_ratio: document.getElementById("aspectRatio").value,
    resolution: document.getElementById("resolution").value,
    max_cost_cny: Number(document.getElementById("maxCost").value),
    generate_audio: document.getElementById("generateAudio").checked,
    watermark: false,
  };
}

function storyboardVideoPlan() {
  const source = Array.isArray(workflow.storyboard?.shots) ? workflow.storyboard.shots : [];
  const shots = source.map((shot, index) => {
    const id = String(shot.id || `shot-${String(index + 1).padStart(2, "0")}`);
    const rawDuration = shot.duration_seconds ?? shot.duration_hint_seconds ?? 0;
    const duration = Number.isFinite(Number(rawDuration)) ? Math.round(Number(rawDuration)) : 0;
    const imagePath = shot.image_path || shot.image_url || shot.frame_path || shot.preview_path || null;
    const first = shot.first_frame_path || imagePath;
    const last = shot.last_frame_path || imagePath;
    const prompt = [
      shot.visual_prompt,
      shot.motion_prompt,
      shot.first_frame_contract ? `首帧连续性约束：${shot.first_frame_contract}` : "",
      shot.last_frame_contract ? `尾帧连续性约束：${shot.last_frame_contract}` : "",
      shot.continuity_anchor ? `连续性锚点：${shot.continuity_anchor}` : "",
    ].filter(Boolean).join("；");
    return {
      id,
      title: shot.title || `镜头 ${index + 1}`,
      duration_seconds: duration,
      image_path: imagePath,
      first_frame_path: first,
      last_frame_path: last,
      prompt,
    };
  });
  return { shots, total: shots.reduce((sum, shot) => sum + shot.duration_seconds, 0) };
}

function renderQualityVideoShotPlan() {
  if (!qualityVideoShotPlan) return;
  const plan = storyboardVideoPlan();
  qualityVideoShotPlan.replaceChildren();
  if (!plan.shots.length) {
    const empty = document.createElement("p");
    empty.className = "workflow-note";
    empty.textContent = "尚未确认分镜；视频任务会在分镜图确认后解锁。";
    qualityVideoShotPlan.append(empty);
  } else {
    plan.shots.forEach((shot, index) => {
      const row = document.createElement("div");
      row.className = `quality-video-shot-row${shot.image_path ? "" : " missing"}`;
      const title = document.createElement("b");
      title.textContent = `${String(index + 1).padStart(2, "0")} · ${shot.title}`;
      const duration = document.createElement("span");
      duration.textContent = `${shot.duration_seconds} 秒`;
      const status = document.createElement("em");
      status.textContent = shot.image_path ? "已绑定确认分镜图 · 将按此镜头生成" : "缺少确认分镜图 · 暂不能提交";
      row.append(title, duration, status);
      qualityVideoShotPlan.append(row);
    });
  }
  if (qualityVideoStoryboardDuration) {
    qualityVideoStoryboardDuration.textContent = plan.shots.length
      ? `${plan.total} 秒 · ${plan.shots.length} 镜`
      : "等待分镜确认";
  }
}

// 质量优先的第 3 阶段使用一组就地参数，提交前再同步回主表单。
// 这样免费估算、付费确认和真正提交始终使用同一份参数，避免页面显示与
// provider 收到的内容不一致。
function syncQualityVideoControls({ fromMain = true } = {}) {
  const mainModel = document.getElementById("modelVariant");
  const mainOperation = document.getElementById("operation");
  const mainDuration = document.getElementById("duration");
  const mainResolution = document.getElementById("resolution");
  const mainAspect = document.getElementById("aspectRatio");
  const mainMaxCost = document.getElementById("maxCost");
  const mainAudio = document.getElementById("generateAudio");
  if (fromMain) {
    if (qualityVideoModel && mainModel) qualityVideoModel.value = mainModel.value;
    if (qualityVideoOperation) qualityVideoOperation.value = "image_to_video";
    const plan = storyboardVideoPlan();
    // Before a storyboard exists the shared form still needs one valid
    // provider duration. Once it exists, the quality stage is a batch: the
    // visible value must be the locked sum, never the first five-second shot.
    const duration = plan.total || Number(mainDuration?.value || 5);
    if (qualityVideoDuration) qualityVideoDuration.value = String(duration);
    if (qualityVideoResolution && mainResolution) qualityVideoResolution.value = mainResolution.value;
    if (qualityVideoAspect && mainAspect) qualityVideoAspect.value = mainAspect.value;
    if (qualityVideoMaxCost && mainMaxCost) qualityVideoMaxCost.value = mainMaxCost.value;
    if (qualityVideoAudio && mainAudio) qualityVideoAudio.checked = mainAudio.checked;
    return;
  }
  if (qualityVideoModel && mainModel) mainModel.value = qualityVideoModel.value;
  if (qualityVideoOperation) qualityVideoOperation.value = "image_to_video";
  const plan = storyboardVideoPlan();
  const duration = plan.total || Number(mainDuration?.value || 5);
  if (qualityVideoDuration) qualityVideoDuration.value = String(duration);
  if (mainOperation) mainOperation.value = "image_to_video";
  // The shared input is retained for compatibility with the single-shot
  // endpoint. For a storyboard batch it is a workflow summary; the server
  // replaces it with each shot's own duration before calling the provider.
  if (mainDuration) mainDuration.value = duration;
  if (qualityVideoResolution && mainResolution) mainResolution.value = qualityVideoResolution.value;
  if (qualityVideoAspect && mainAspect) mainAspect.value = qualityVideoAspect.value;
  if (qualityVideoMaxCost && mainMaxCost) mainMaxCost.value = qualityVideoMaxCost.value;
  if (qualityVideoAudio && mainAudio) mainAudio.checked = qualityVideoAudio.checked;
}

function qualityVideoPayload() {
  syncQualityVideoControls({ fromMain: false });
  const plan = storyboardVideoPlan();
  const totalDuration = plan.total || 5;
  if (qualityVideoDuration) qualityVideoDuration.value = String(totalDuration);
  return {
    ...modelPayload(),
    operation: "image_to_video",
    // This top-level duration is the creator-visible batch total. The
    // server's storyboard adapter deliberately strips it before issuing one
    // provider request per shot, so no provider receives an invalid 36s
    // single-clip duration.
    duration: totalDuration,
    storyboard_project_id: workflow.draftId,
    storyboard_total_duration_seconds: plan.total,
    storyboard_shots: plan.shots,
    batch_mode: "storyboard_shots",
  };
}

function paidPayload() {
  const base = workflow.mode === "quality" ? qualityVideoPayload() : modelPayload();
  return { ...base, workflow_mode: workflow.mode, workflow_candidate_id: workflow.selectedCandidateId };
}

async function postJSON(path, body, extraHeaders = {}) {
  return requestJSON(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
}

async function getJSON(path) {
  return requestJSON(path, { headers: { accept: "application/json" } });
}

async function requestJSON(path, options) {
  let response;
  try {
    response = await fetch(path, options);
  } catch {
    throw new Error(options.method === "POST"
      ? "与工作台服务的连接中断。请求可能已被接收，请先查看项目任务状态，再决定是否重试。"
      : "暂时无法连接工作台服务，请确认本机服务正在运行后刷新。已有项目文件会保留。");
  }
  let data;
  try { data = await response.json(); } catch {
    throw new Error(`服务返回了无法识别的结果（${response.status}），请检查任务状态；本次不会自动重试。`);
  }
  if (!response.ok) {
    const detail = data.detail || data.error;
    const message = typeof detail === "string" ? detail
      : Array.isArray(detail) ? detail.map(item => item.msg || "参数不完整").join("；")
        : `请求未完成（${response.status}），请稍后检查服务状态。`;
    throw new Error(message);
  }
  return data;
}

function workflowEntryMode() {
  const requested = new URLSearchParams(window.location.search).get("entry");
  if (ENTRY_MODE_CONFIG[requested]) return requested;
  const draft = readEntryDraft();
  return ENTRY_MODE_CONFIG[draft?.mode] ? draft.mode : "guided";
}

const ADVANCED_MEDIA_KEY = "openmontage.show_advanced_media";

function setAdvancedMediaExpanded(expanded, { persist = true } = {}) {
  if (!mediaPipeline || !toggleAdvancedMediaButton) return;
  const open = Boolean(expanded);
  mediaPipeline.classList.toggle("show-advanced-media", open);
  toggleAdvancedMediaButton.setAttribute("aria-expanded", open ? "true" : "false");
  toggleAdvancedMediaButton.textContent = open ? "收起声音精细调整" : "声音精细调整";
  toggleAdvancedMediaButton.title = open
    ? "收起参考分析、素材检索和其他按需工具，保留主流程"
    : "展开旁白降噪与声音精细调整";
  if (persist) sessionStorage.setItem(ADVANCED_MEDIA_KEY, open ? "1" : "0");
}

async function persistWorkflowDraft(stage) {
  const prompt = modelPayload().prompt;
  if (!prompt) return null;
  const data = await postJSON("/model-api/workflow/draft", {
    prompt,
    mode: workflow.mode,
    stage,
    draft_id: workflow.draftId || sessionStorage.getItem("openmontage.workflow_draft_id") || null,
    selected_candidate_id: workflow.selectedCandidateId,
    entry_mode: workflowEntryMode(),
    aspect_ratio: document.getElementById("aspectRatio")?.value || "9:16",
    resolution: document.getElementById("resolution")?.value || "480p",
    // Keep the confirmed storyboard attached to the video-stage snapshot.
    // Without this, reopening a project after clicking “确认分镜” restored
    // the controls but silently lost the exact shot prompts/images that the
    // paid request is supposed to use.
    storyboard: ["storyboard", "video"].includes(stage) ? workflow.storyboard : null,
    storyboard_approved: Boolean(workflow.storyboardApproved),
    storyboard_images_complete: Boolean(workflow.storyboardImagesGenerated),
    image_generation_receipt: workflow.imageGenerationReceipt || null,
    video_parameters: stage === "video" ? {
      model_variant: qualityVideoModel?.value || document.getElementById("modelVariant")?.value,
      operation: qualityVideoOperation?.value || "image_to_video",
      duration: qualityVideoDuration?.value || null,
      resolution: qualityVideoResolution?.value || document.getElementById("resolution")?.value,
      aspect_ratio: qualityVideoAspect?.value || document.getElementById("aspectRatio")?.value,
      max_cost_cny: qualityVideoMaxCost?.value || document.getElementById("maxCost")?.value,
    } : null,
  });
  workflow.draftId = data.draft_id || data.project_id || workflow.draftId;
  workflow.projectUrl = data.project_url || (workflow.draftId ? `/p/${workflow.draftId}` : null);
  if (workflow.draftId) {
    sessionStorage.setItem("openmontage.workflow_draft_id", workflow.draftId);
    sessionStorage.setItem(DRAFT_PROMPT_KEY, prompt);
    workflow.draftPrompt = prompt;
  }
  if (workflowProjectStatus) workflowProjectStatus.textContent = "免费规划已保存到项目库，可随时打开继续查看。";
  if (workflowProjectLink && workflow.projectUrl) {
    workflowProjectLink.href = workflow.projectUrl;
    workflowProjectLink.hidden = false;
  }
  if (workflowOpenMedia) {
    // Do not expose the post-production workbench while the creator is still
    // comparing proposals. It becomes a single, contextual hand-off after a
    // storyboard exists, so the normal path never branches backwards.
    const canOpenMedia = ["storyboard", "video"].includes(stage);
    workflowOpenMedia.hidden = !canOpenMedia;
    workflowOpenMedia.textContent = "进入后期制作";
    workflowOpenMedia.title = canOpenMedia ? "打开当前项目的后期制作与交付面板" : "确认分镜后进入后期制作";
  }
  return data;
}

function setWorkflowStep(active) {
  const steps = [workflowStepEstimate, workflowStepCandidates, workflowStepStoryboard, workflowStepVideo];
  steps.forEach((step, index) => {
    if (!step) return;
    step.classList.toggle("active", index === active);
    step.classList.toggle("done", index < active);
  });
}

function setQualityStage(stage) {
  workflow.stage = Math.max(0, Math.min(3, Number(stage) || 0));
  workspaceView = ["plan", "storyboard", "video", "delivery"][workflow.stage];
  setWorkflowStep(workflow.stage);
  if (workflow.mode !== "quality") {
    if (qualityVideoSection) qualityVideoSection.hidden = true;
    if (qualityReviewSection) qualityReviewSection.hidden = true;
    syncReceiptVisibility();
    syncWorkspaceView();
    return;
  }
  // Quality mode is deliberately a one-stage-at-a-time workspace. Keeping
  // only the active gate visible prevents the creator from having to infer
  // which button is safe to press next.
  if (creativeSection) creativeSection.hidden = workflow.stage !== 0;
  if (storyboardSection) storyboardSection.hidden = workflow.stage !== 1;
  if (qualityVideoSection) qualityVideoSection.hidden = workflow.stage !== 2;
  if (qualityReviewSection) qualityReviewSection.hidden = workflow.stage !== 3;
  if (qualityOpenMedia) qualityOpenMedia.hidden = !workflow.projectUrl;
  if (workflow.stage === 2) {
    syncQualityVideoControls({ fromMain: true });
    updateQualityVideoSummary();
  }
  syncReceiptVisibility();
  syncWorkspaceView();
}

function syncReceiptVisibility() {
  if (!receipt) return;
  // In quality mode the first estimate belongs to the input gate, not to a
  // selected proposal or a storyboard. Keep the global receipt hidden until
  // stage 3 has its own parameter estimate; otherwise creators see a stale
  // cost before they have chosen the plan, duration, resolution, or model that
  // will actually be submitted. Speed mode keeps the original two-column
  // receipt because its automatic path is already parameterized at input.
  const qualityReceiptReady = workflow.mode === "quality"
    && workflow.stage >= 2
    && Boolean(workflow.qualityVideoEstimateReady);
  const visible = workflow.mode !== "quality"
    || qualityReceiptReady
    || Boolean(currentTaskId);
  receipt.hidden = !visible;
  if (rawEstimate && !currentTaskId) rawEstimate.hidden = !visible;
}

function applyEstimateReceipt(data) {
  lastEstimate = data;
  if (rawEstimate) {
    rawEstimate.hidden = false;
    rawEstimate.textContent = JSON.stringify(data?.dry_run || {}, null, 2);
  }
  if (estimatedCost) estimatedCost.textContent = data?.estimated_cost_cny == null ? "未知" : `¥${Number(data.estimated_cost_cny).toFixed(4)}`;
  if (estimatedModel) estimatedModel.textContent = data?.dry_run?.model || data?.dry_run?.model_name || "由 provider 决定";
  if (budgetCheck) budgetCheck.textContent = data?.within_max_cost === true ? "在费用上限内" : "不在费用上限内";
}

function syncStoryboardImageGate(message) {
  const shots = Array.isArray(workflow.storyboard?.shots) ? workflow.storyboard.shots : [];
  const completed = shots.filter((shot) => Boolean(
    shot?.image_path || shot?.image_url || shot?.frame_path || shot?.preview_path,
  )).length;
  const complete = shots.length > 0 && shots.every((shot) => Boolean(
    shot?.image_path || shot?.image_url || shot?.frame_path || shot?.preview_path,
  ));
  workflow.storyboardImagesGenerated = complete;
  if (storyboardImageBadge) {
    storyboardImageBadge.className = `workflow-badge${complete ? " ok" : completed ? " progress" : ""}`;
    storyboardImageBadge.textContent = complete ? "已生成，请确认" : completed ? `已回填 ${completed}/${shots.length}` : "尚未生成";
  }
  if (storyboardImageStatus) {
    storyboardImageStatus.textContent = message || (complete
      ? "分镜图已全部回填。请逐张检查画面、人物比例和风格；确认无误后才能进入视频生成。"
      : completed
        ? `已显示 ${completed}/${shots.length} 张分镜图，其余图片仍在生成；全部显示并确认后才能进入视频生成。`
        : "先检查并修改分镜提示词，再生成分镜图；所有图片显示并确认后才能进入视频生成。");
  }
  if (approveStoryboard && workflow.mode === "quality") approveStoryboard.disabled = !complete;
}

function formatStoryboardImageElapsed() {
  if (!storyboardImageHeartbeatStartedAt) return "00:00";
  const seconds = Math.max(0, Math.floor((Date.now() - storyboardImageHeartbeatStartedAt) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function stopStoryboardImageHeartbeat({ hide = true } = {}) {
  if (storyboardImageHeartbeatTimer) window.clearInterval(storyboardImageHeartbeatTimer);
  storyboardImageHeartbeatTimer = null;
  if (!hide || !storyboardImageHeartbeat) return;
  storyboardImageHeartbeat.hidden = true;
  storyboardImageHeartbeat.className = "heartbeat storyboard-image-heartbeat";
  storyboardImageHeartbeatStartedAt = 0;
  storyboardImageHeartbeatTotal = 0;
  storyboardImageHeartbeatCompleted = 0;
}

function updateStoryboardImageHeartbeat({
  state = "running",
  label = "分镜图生成中",
  detail = "已提交图片生成请求，等待服务端回执。",
  completed = storyboardImageHeartbeatCompleted,
  total = storyboardImageHeartbeatTotal,
} = {}) {
  if (!storyboardImageHeartbeat) return;
  const safeTotal = Math.max(0, Number(total) || 0);
  const safeCompleted = Math.max(0, Math.min(safeTotal, Number(completed) || 0));
  storyboardImageHeartbeatCompleted = safeCompleted;
  storyboardImageHeartbeatTotal = safeTotal;
  storyboardImageHeartbeat.hidden = false;
  storyboardImageHeartbeat.className = `heartbeat storyboard-image-heartbeat${state === "done" ? " done" : state === "failed" ? " failed" : ""}`;
  if (storyboardImageHeartbeatLabel) storyboardImageHeartbeatLabel.textContent = label;
  if (storyboardImageHeartbeatElapsed) storyboardImageHeartbeatElapsed.textContent = formatStoryboardImageElapsed();
  if (storyboardImageHeartbeatDetail) storyboardImageHeartbeatDetail.textContent = detail;
  if (storyboardImageHeartbeatProgress) {
    // The backend persists one artifact after every successful shot.  The bar
    // therefore reflects the real completed-shot count, with a small pulse at
    // zero so the creator can still see that the worker is alive.
    const percent = safeTotal > 0 ? Math.round((safeCompleted / safeTotal) * 100) : 0;
    storyboardImageHeartbeatProgress.style.width = state === "running" ? `${Math.max(percent, 8)}%` : "100%";
    storyboardImageHeartbeatProgress.style.animation = state === "running" ? "" : "none";
  }
}

function startStoryboardImageHeartbeat(total) {
  stopStoryboardImageHeartbeat({ hide: false });
  storyboardImageHeartbeatStartedAt = Date.now();
  storyboardImageHeartbeatTotal = Math.max(0, Number(total) || 0);
  storyboardImageHeartbeatCompleted = 0;
  updateStoryboardImageHeartbeat({
    state: "running",
    label: "分镜图生成中",
    detail: `已提交 0/${storyboardImageHeartbeatTotal} 张，等待服务端回执；按镜头顺序处理，不会重复提交。`,
  });
  storyboardImageHeartbeatTimer = window.setInterval(() => {
    updateStoryboardImageHeartbeat({
      state: "running",
      label: "分镜图生成中",
      detail: `服务端仍在处理，已完成 ${storyboardImageHeartbeatCompleted}/${storyboardImageHeartbeatTotal} 张；已等待 ${formatStoryboardImageElapsed()}。`,
    });
  }, 1000);
}

function finishStoryboardImageHeartbeat(state, label, detail, completed = storyboardImageHeartbeatCompleted) {
  if (!storyboardImageHeartbeatStartedAt) return;
  stopStoryboardImageHeartbeat({ hide: false });
  updateStoryboardImageHeartbeat({ state, label, detail, completed });
}

function sleepStoryboardImagePoll(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function storyboardImageProgressItems(snapshot) {
  const candidates = [
    snapshot?.images_written,
    snapshot?.result?.images_written,
    snapshot?.images,
    snapshot?.result?.images,
  ];
  return candidates.find((items) => Array.isArray(items) && items.length) || [];
}

function applyStoryboardImageProgress(snapshot) {
  const items = storyboardImageProgressItems(snapshot);
  const shots = Array.isArray(workflow.storyboard?.shots) ? workflow.storyboard.shots : [];
  if (!items.length || !shots.length) return 0;
  const byShot = new Map(items.map((item) => [String(item?.shot_id || ""), item]));
  const itemsHaveShotIds = items.some((item) => Boolean(item?.shot_id));
  let changed = false;
  let applied = 0;
  const cards = new Map([...storyboardGrid.querySelectorAll(".storyboard-card")].map((card) => [card.dataset.shotId, card]));
  let needsFullRender = false;
  shots.forEach((shot, index) => {
    const shotKey = String(shot.id || `shot-${String(index + 1).padStart(2, "0")}`);
    // Once the server supplies shot ids, never fall back by array position:
    // a partial list such as [shot-02] must not paint shot 02 into card 01.
    const item = byShot.get(shotKey) || (!itemsHaveShotIds ? items[index] : null);
    if (!item?.path) return;
    const next = {
      image_path: item.path,
      image_sha256: item.sha256 || shot.image_sha256 || null,
      image_provider: item.provider || shot.image_provider || null,
      image_model: item.model || shot.image_model || null,
    };
    const shotChanged = shot.image_path !== next.image_path || shot.image_sha256 !== next.image_sha256
      || shot.image_provider !== next.image_provider || shot.image_model !== next.image_model;
    if (shotChanged) {
      Object.assign(shot, next);
      changed = true;
    }
    applied += 1;
    // A few imported storyboards do not carry stable ids.  Use the same
    // deterministic fallback as renderStoryboard so an incremental update
    // still lands in the correct card instead of waiting for a full rerender.
    const card = cards.get(shotKey);
    const slot = card?.querySelector(".storyboard-image-slot");
    if (slot && shotChanged) renderStoryboardImageSlot(slot, shot);
    else if (!slot) needsFullRender = true;
  });
  if (changed && needsFullRender) renderStoryboard();
  if (changed) {
    const complete = shots.length > 0 && applied >= shots.length && shots.every((shot) => Boolean(shot.image_path || shot.image_url || shot.frame_path || shot.preview_path));
    syncStoryboardImageGate(complete
      ? "分镜图已全部回填。请逐张检查画面、人物比例和风格；确认无误后才能进入视频生成。"
      : `已立即显示 ${applied}/${shots.length} 张分镜图，其余图片仍在生成。`);
  }
  return applied;
}

async function waitForStoryboardImageJob(projectId, total, initial) {
  // The server writes an accepted receipt before calling the provider.  This
  // loop is deliberately a poll of durable state, not a guess based on an
  // open request: a refresh can resume the same job without a duplicate paid
  // submission.
  const deadline = Date.now() + 30 * 60 * 1000;
  let snapshot = initial || {};
  const statusUrl = snapshot.status_url || `/model-api/workflow/storyboard/images/status/${encodeURIComponent(projectId)}`;
  while (Date.now() < deadline) {
    const applied = applyStoryboardImageProgress(snapshot);
    const completed = Math.max(Number(snapshot.completed_shots || 0), applied);
    const expected = Number(snapshot.total_shots || total || 0);
    const state = snapshot.status || snapshot.state || "accepted";
    const jobId = snapshot.job_id ? `任务 ${snapshot.job_id}；` : "";
    updateStoryboardImageHeartbeat({
      state: state === "completed" ? "done" : state === "failed" || state === "stalled" ? "failed" : "running",
      label: state === "completed" ? "分镜图生成完成" : state === "stalled" ? "分镜图任务已停滞" : "分镜图生成中",
      detail: `${jobId}服务端已完成 ${completed}/${expected} 张；${snapshot.message || "每 2 秒刷新一次真实任务状态。"}`,
      completed,
      total: expected,
    });
    if (state === "completed") {
      applyStoryboardImageProgress(snapshot);
      return snapshot.result || snapshot;
    }
    if (state === "failed" || state === "stalled") {
      const error = new Error(snapshot.error || snapshot.message || "图片生成任务未完成，请检查服务端日志后重试。");
      // Preserve the authoritative server-side count so a failed 4/5 batch is
      // visible as 4/5 instead of being reset to an unhelpful 0/5.
      error.completedShots = completed;
      error.totalShots = expected;
      error.imagesWritten = storyboardImageProgressItems(snapshot);
      throw error;
    }
    await sleepStoryboardImagePoll(2000);
    snapshot = await getJSON(statusUrl);
  }
  const error = new Error("图片生成等待超过 30 分钟；任务未自动重试，请检查任务状态后再决定是否重新提交。");
  error.completedShots = Number(snapshot.completed_shots || 0);
  error.totalShots = Number(snapshot.total_shots || total || 0);
  error.imagesWritten = storyboardImageProgressItems(snapshot);
  throw error;
}

function buildStoryboardImagePrompt(shot) {
  // OpenMontage's image guidance uses a compact scene-specific prompt. Keep
  // that shape, but include both boundary contracts so the generated still
  // can actually be checked against the next shot instead of only its start.
  return [
    shot.visual_prompt,
    shot.motion_prompt,
    shot.first_frame_contract ? `首帧连续性约束：${shot.first_frame_contract}` : "",
    shot.last_frame_contract ? `尾帧连续性约束：${shot.last_frame_contract}` : "",
    shot.continuity_anchor ? `连续性锚点：${shot.continuity_anchor}` : "",
  ].filter(Boolean).join("；");
}

function invalidateQualityVideoEstimate() {
  workflow.qualityVideoEstimateReady = false;
  workflow.qualityVideoEstimate = null;
  if (qualityPreparePaid) qualityPreparePaid.disabled = true;
  if (qualityVideoEstimatedCost) qualityVideoEstimatedCost.textContent = "尚未估算";
  if (qualityVideoEstimateStatus) qualityVideoEstimateStatus.textContent = "参数已改变，请重新点击免费估算";
  if (qualityVideoBadge && workflow.stage === 2) qualityVideoBadge.textContent = "待重新估算";
}

function updateQualityVideoSummary(data = null) {
  if (!qualityVideoSummary) return;
  const model = qualityVideoModel?.value === "standard" ? "Seedance 2.0 · 标准" : "Seedance 2.0 mini";
  const plan = storyboardVideoPlan();
  const resolution = qualityVideoResolution?.value || "480p";
  const aspect = qualityVideoAspect?.value || "9:16";
  const cost = data?.estimated_cost_cny == null ? "待估算" : `¥${Number(data.estimated_cost_cny).toFixed(4)}`;
  qualityVideoSummary.replaceChildren();
  const label = document.createElement("span");
  label.textContent = "模型 / 参数";
  const value = document.createElement("b");
  value.textContent = `${model} · 图生视频 · ${plan.total || "待确认"}s · ${resolution} · ${aspect}`;
  const costLabel = document.createElement("span");
  costLabel.textContent = "费用状态";
  const costValue = document.createElement("b");
  costValue.textContent = cost;
  qualityVideoSummary.append(label, value, costLabel, costValue);
  renderQualityVideoShotPlan();
}

function resetWorkflow({ preserveDraft = false } = {}) {
  invalidatePaidContext();
  stopStoryboardImageHeartbeat();
  const prompt = (document.getElementById("prompt")?.value || "").trim();
  const sessionDraftId = sessionStorage.getItem("openmontage.workflow_draft_id");
  const sessionDraftPrompt = sessionStorage.getItem(DRAFT_PROMPT_KEY) || "";
  const keepDraft = Boolean(preserveDraft && (workflow.draftId || sessionDraftId)
    && prompt && prompt === (workflow.draftPrompt || sessionDraftPrompt));
  const draftId = keepDraft ? (workflow.draftId || sessionDraftId) : null;
  workflow = {
    mode: workflowMode.value,
    stage: 0,
    candidates: [],
    selectedCandidateId: null,
    storyboard: null,
    storyboardApproved: false,
    storyboardImagesGenerated: false,
    imageGenerationReceipt: null,
    qualityVideoEstimateReady: false,
    qualityVideoEstimate: null,
    draftId,
    projectUrl: draftId ? `/p/${encodeURIComponent(draftId)}` : null,
    draftPrompt: keepDraft ? prompt : null,
  };
  if (!keepDraft) {
    sessionStorage.removeItem("openmontage.workflow_draft_id");
    sessionStorage.removeItem(DRAFT_PROMPT_KEY);
  }
  workflowPanel.hidden = false;
  creativeSection.hidden = false;
  storyboardSection.hidden = true;
  candidateGrid.innerHTML = "";
  storyboardGrid.innerHTML = "";
  continueStoryboard.disabled = true;
  approveStoryboard.disabled = true;
  approveStoryboard.hidden = workflow.mode === "speed";
  approveStoryboard.textContent = "确认分镜，进入视频生成";
  if (qualityPreparePaid) qualityPreparePaid.disabled = true;
  if (qualityVideoBadge) qualityVideoBadge.textContent = "等待确认";
  if (qualityVideoStatus) qualityVideoStatus.textContent = "分镜确认后才会解锁视频任务。先检查模型、分辨率和费用，再进行一次明确的付费确认。";
  syncQualityVideoControls({ fromMain: true });
  updateQualityVideoSummary();
  if (qualityVideoEstimatedCost) qualityVideoEstimatedCost.textContent = "尚未估算";
  if (qualityVideoEstimateStatus) qualityVideoEstimateStatus.textContent = "修改参数后请先点击免费估算";
  syncStoryboardImageGate();
  if (qualityReviewBadge) qualityReviewBadge.textContent = "待实测";
  if (qualityReviewStatus) qualityReviewStatus.textContent = "视频完成后才进入这一关。下面的四项权重是比赛口径，分数只有绑定真实视频、抽帧和质检报告后才会显示。";
  if (qualityReviewProjectLink) { qualityReviewProjectLink.hidden = true; qualityReviewProjectLink.removeAttribute("href"); }
  if (qualityOpenMedia) qualityOpenMedia.hidden = true;
  creativeModeBadge.className = "workflow-badge";
  creativeModeBadge.textContent = workflow.mode === "quality" ? "等待创作者选择" : "等待自动评分";
  storyboardModeBadge.className = "workflow-badge";
  storyboardModeBadge.textContent = "等待生成";
  creativeStatus.textContent = workflow.mode === "quality"
    ? "质量优先：三案会完整展示，选定后才进入分镜。"
    : "速度优先：三案会先在服务端评分，系统自动选择最高分方案。";
  storyboardStatus.textContent = "分镜会保留景别差异、运镜重点和共享边界帧。";
  factGateBadge.textContent = "待补来源";
  factGateText.textContent = "系统不会把未经核验的地点、年代或数据写成事实；目前先建立核验清单，正式交付前需要补充来源。";
  factChecklist.innerHTML = "";
  if (workflowProjectStatus) workflowProjectStatus.textContent = "免费规划尚未保存为项目。";
  if (workflowProjectLink) {
    workflowProjectLink.hidden = true;
    workflowProjectLink.removeAttribute("href");
  }
  if (workflowOpenMedia) workflowOpenMedia.hidden = true;
  preparePaid.disabled = true;
  preparePaid.hidden = workflow.mode === "quality";
  setQualityStage(0);
}

function showEstimate(data, { autoAdvance = false } = {}) {
  // Re-estimating the same prompt updates the same local draft.  A changed
  // prompt or an explicit mode switch still starts a new draft, so unrelated
  // projects are never silently overwritten.
  resetWorkflow({ preserveDraft: true });
  applyEstimateReceipt(data);
  syncReceiptVisibility();
  if (data.valid && data.within_max_cost === true) setModeFocus(workflow.mode, { scroll: true });
  generateCandidates.disabled = !(data.valid && data.within_max_cost === true);
  if (data.valid && data.within_max_cost === true) {
    setStatus("ok", "估算通过", workflow.mode === "speed"
      ? "估算完成，速度优先将自动生成三案、评分并进入分镜。"
      : "估算完成，下一步先生成三套免费方案供你选择。");
    if (workflow.mode === "speed") {
      if (autoAdvance) return runCandidates();
      void runCandidates();
    }
  } else {
    setStatus("warn", "需要调整", data.error || "估算未通过费用或参数检查。");
  }
}

async function runQualityVideoEstimate() {
  if (workflow.mode !== "quality" || workflow.stage !== 2 || !workflow.storyboardApproved) {
    setStatus("warn", "尚未到视频参数阶段", "请先确认分镜图，再调整视频模型、时长和清晰度。");
    return;
  }
  const plan = storyboardVideoPlan();
  if (!plan.shots.length || plan.shots.some((shot) => shot.duration_seconds <= 0 || !shot.image_path)) {
    renderQualityVideoShotPlan();
    setStatus("warn", "分镜尚未准备好", "请先生成并确认每个分镜图；视频会按这些镜头逐镜生成，不能使用单一总时长替代。");
    return;
  }
  const payload = qualityVideoPayload();
  if (qualityVideoEstimateButton) qualityVideoEstimateButton.disabled = true;
  if (qualityPreparePaid) qualityPreparePaid.disabled = true;
  if (qualityVideoBadge) qualityVideoBadge.textContent = "估算中";
  if (qualityVideoEstimateStatus) qualityVideoEstimateStatus.textContent = `正在估算 ${plan.shots.length} 个分镜（合计 ${plan.total} 秒），不会创建视频任务`;
  setStatus("neutral", "视频参数估算中", `正在按 ${plan.shots.length} 个已确认分镜逐镜执行免费 dry-run（合计 ${plan.total} 秒），不会扣费。`);
  try {
    const data = await postJSON("/model-api/workflow/video/estimate", payload);
    workflow.qualityVideoEstimate = data;
    applyEstimateReceipt(data);
    updateQualityVideoSummary(data);
    const ready = Boolean(data?.valid && data?.within_max_cost === true);
    workflow.qualityVideoEstimateReady = ready;
    // Set the readiness flag before syncing the shared receipt.  Otherwise
    // the stage-3 estimate is valid but the global receipt still sees the
    // previous `false` state and remains hidden until another UI event.
    syncReceiptVisibility();
    if (qualityVideoEstimatedCost) {
      qualityVideoEstimatedCost.textContent = data?.estimated_cost_cny == null
        ? "未知"
        : `¥${Number(data.estimated_cost_cny).toFixed(4)}`;
    }
    if (qualityVideoBadge) qualityVideoBadge.textContent = ready ? "可确认" : "需调整";
    if (qualityVideoEstimateStatus) {
      qualityVideoEstimateStatus.textContent = ready
        ? "估算通过；确认费用后可进入二次付费确认。"
        : (data?.error || "估算未通过，请调整模型、时长、清晰度或费用上限。");
    }
    syncPaidButtons();
    setStatus(ready ? "ok" : "warn", ready ? "视频参数估算通过" : "视频参数需要调整", ready
      ? "当前参数已通过费用检查。下一步进入二次付费确认，仍不会自动提交模型任务。"
      : (data?.error || "请调整参数后重新估算。"));
  } catch (error) {
    workflow.qualityVideoEstimateReady = false;
    workflow.qualityVideoEstimate = null;
    if (qualityVideoBadge) qualityVideoBadge.textContent = "估算失败";
    if (qualityVideoEstimateStatus) qualityVideoEstimateStatus.textContent = error.message;
    setStatus("error", "视频参数估算失败", error.message);
  } finally {
    if (qualityVideoEstimateButton) qualityVideoEstimateButton.disabled = false;
  }
}

function findVideoUrl(data) {
  return data?.data?.local_video_url || data?.data?.video_url || data?.data?.url || data?.data?.content?.video_url || data?.data?.task?.content?.video_url || null;
}

function isPlayableVideoUrl(value) {
  if (!value || typeof value !== "string") return false;
  try {
    const parsed = new URL(value, window.location.origin);
    return ["http:", "https:"].includes(parsed.protocol);
  } catch (_) {
    return false;
  }
}

function clearVideoPreview() {
  if (videoPreviewList) videoPreviewList.replaceChildren();
  if (videoPreview) videoPreview.hidden = true;
  videoPreviewSignature = null;
}

function renderVideoPreviews(entries, { batch = false } = {}) {
  const validEntries = (Array.isArray(entries) ? entries : [])
    .filter((entry) => isPlayableVideoUrl(entry?.url));
  if (!videoPreview || !videoPreviewList || !validEntries.length) {
    clearVideoPreview();
    return;
  }
  const nextSignature = JSON.stringify({
    batch: Boolean(batch),
    entries: validEntries.map((entry, index) => ({
      key: entry?.id || entry?.shot_id || entry?.title || `video-${index + 1}`,
      url: entry.url,
      title: entry?.title || `视频片段 ${index + 1}`,
      duration_seconds: entry?.duration_seconds ?? null,
    })),
  });
  if (!videoPreview.hidden && videoPreviewSignature === nextSignature) {
    return;
  }
  videoPreviewList.replaceChildren();
  validEntries.forEach((entry, index) => {
    const figure = document.createElement("figure");
    figure.className = "video-preview-card";
    const video = document.createElement("video");
    video.controls = true;
    video.preload = "metadata";
    video.playsInline = true;
    video.src = entry.url;
    video.setAttribute("aria-label", entry.title || `视频片段 ${index + 1}`);
    const caption = document.createElement("figcaption");
    const duration = Number(entry.duration_seconds);
    const durationLabel = Number.isFinite(duration) && duration > 0 ? ` · ${duration} 秒` : "";
    caption.textContent = `${entry.title || `视频片段 ${index + 1}`}${durationLabel}`;
    figure.append(video, caption);
    videoPreviewList.append(figure);
  });
  videoPreview.hidden = false;
  const totalDuration = validEntries.reduce((sum, entry) => {
    const duration = Number(entry.duration_seconds);
    return sum + (Number.isFinite(duration) && duration > 0 ? duration : 0);
  }, 0);
  if (videoPreviewBadge) {
    videoPreviewBadge.textContent = batch
      ? `${validEntries.length} 个片段可播放${totalDuration ? ` · 合计 ${totalDuration} 秒` : ""}`
      : "可播放";
  }
  if (videoPreviewHint) {
    videoPreviewHint.textContent = batch
      ? `这里按分镜逐镜预览，不是单个总片。${totalDuration ? `当前已返回片段合计 ${totalDuration} 秒；` : ""}其余镜头仍在生成时，页面会继续显示实时进度。全部完成后可在后期面板合成连续成片。`
      : "视频已返回，可直接在此播放；下方链接仍可打开原始文件。";
  }
  videoPreviewSignature = nextSignature;
}

function formatElapsed(seconds) {
  const safe = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function statusLabel(status) {
  const labels = {
    submitted: "已提交，等待排队", queued: "排队中", running: "模型生成中", processing: "模型处理中",
    succeeded: "已完成", success: "已完成", completed: "已完成", done: "已完成",
    failed: "生成失败", error: "生成失败", cancelled: "已取消", canceled: "已取消",
  };
  return labels[String(status || "").toLowerCase()] || `处理中 · ${status || "未知状态"}`;
}

function updateHeartbeat(data) {
  const status = String(data.status || "unknown").toLowerCase();
  heartbeat.hidden = false;
  heartbeat.classList.toggle("done", SUCCESS_STATUSES.has(status));
  heartbeat.classList.toggle("failed", FAILURE_STATUSES.has(status));
  heartbeatLabel.textContent = statusLabel(status);
  heartbeatElapsed.textContent = formatElapsed((Date.now() - heartbeatStartedAt) / 1000);
  heartbeatDetail.textContent = SUCCESS_STATUSES.has(status)
    ? "任务已到终态；系统正在确认视频文件链接并写入本次独立项目。"
    : FAILURE_STATUSES.has(status)
      ? "任务已停止；请查看回执和 Backlot 项目中的失败原因。"
      : `实时心跳第 ${heartbeatAttempts} 次 · 每 5 秒自动查询一次，不会重复创建任务。`;
}

function stopHeartbeat() {
  if (heartbeatTimer) window.clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function showBatchTask(data) {
  batchId = data.batch_id || batchId;
  batchTaskIds = Array.isArray(data.task_ids) ? data.task_ids : batchTaskIds;
  currentTaskId = data.task_id || batchTaskIds[0] || null;
  updatePaidReceipt(data);
  taskActions.hidden = false;
  taskIdElement.textContent = batchId ? `${batchId} · ${batchTaskIds.length} 个分镜任务` : (currentTaskId || "—");
  if (currentTaskId) sessionStorage.setItem("openmontage.task_id", currentTaskId);
  if (batchId && batchTaskIds.length) {
    sessionStorage.setItem("openmontage.batch_id", batchId);
    sessionStorage.setItem("openmontage.batch_task_ids", JSON.stringify(batchTaskIds));
  }
  if (data.backlot_project_url) {
    projectLink.href = data.backlot_project_url;
    projectLink.hidden = false;
    workflow.projectUrl = data.backlot_project_url;
  }
  // The initial submit-batch response nests provider receipts under
  // data.tasks, while subsequent batch/query responses expose tasks at the
  // top level. Normalize both shapes so the first completed clip is visible
  // immediately instead of looking like a missing/5-second single task.
  const taskItems = Array.isArray(data.tasks)
    ? data.tasks
    : Array.isArray(data?.data?.tasks)
      ? data.data.tasks
      : [];
  const completedVideos = taskItems
    .map((task, index) => ({
      title: task?.data?.shot_title || task?.data?.shot_id || `分镜视频 ${index + 1}`,
      url: findVideoUrl(task),
      duration_seconds: task?.duration_seconds ?? task?.data?.duration_seconds,
    }))
    .filter((entry) => entry.url);
  if (data.continuous_video_url) {
    completedVideos.unshift({
      title: `连续成片 · ${data.total_duration_seconds || "—"} 秒`,
      url: data.continuous_video_url,
      duration_seconds: data.total_duration_seconds,
    });
  }
  renderVideoPreviews(completedVideos, { batch: true });
  if (completedVideos.length) {
    videoLink.href = completedVideos[0].url;
    videoLink.textContent = completedVideos.length > 1 ? "打开第一个已完成的视频文件" : "打开已完成的视频文件";
    videoLink.hidden = false;
  } else {
    videoLink.hidden = true;
  }
  videoPending.hidden = data.status === "completed" && completedVideos.length > 0;
  if (data.status !== "completed") {
    videoPending.textContent = `已完成 ${data.completed_count || completedVideos.length}/${data.total_count || batchTaskIds.length} 个分镜；完成的片段已可先预览。`;
  }
  rawEstimate.hidden = false;
  rawEstimate.textContent = JSON.stringify(data, null, 2);
  heartbeat.hidden = false;
  heartbeatLabel.textContent = data.status === "completed" ? "全部分镜视频已完成" : data.status === "failed" ? "部分分镜生成失败" : "分镜视频批量生成中";
  heartbeatDetail.textContent = `${data.completed_count || 0}/${data.total_count || batchTaskIds.length} 个镜头完成 · 每 5 秒自动查询，不会重复创建任务。`;
  heartbeat.classList.toggle("done", data.status === "completed");
  heartbeat.classList.toggle("failed", data.status === "failed");
}

async function refreshBatch(silent = false) {
  if (!batchTaskIds.length || heartbeatBusy) return;
  const revision = paidRevision, taskKey = batchId;
  heartbeatBusy = true;
  heartbeatAttempts += 1;
  try {
    const data = await postJSON("/model-api/paid/batch/query", { batch_id: batchId, task_ids: batchTaskIds });
    if (revision !== paidRevision || taskKey !== batchId) return;
    showBatchTask(data);
    if (data.status === "completed") {
      stopHeartbeat();
      sessionStorage.removeItem("openmontage.batch_id");
      sessionStorage.removeItem("openmontage.batch_task_ids");
      setQualityStage(3);
      if (qualityReviewBadge) qualityReviewBadge.textContent = "可开始实测";
      if (qualityReviewStatus) qualityReviewStatus.textContent = "全部分镜视频已返回并写入独立项目。现在进入裁判式质检，运行真实抽帧、音频、黑帧和字幕检查。";
      setStatus("ok", "全部分镜视频已完成", "所有镜头均使用已确认分镜图和对应秒数生成；现在可以进入质检。");
    } else if (data.status === "failed") {
      stopHeartbeat();
      sessionStorage.removeItem("openmontage.batch_id");
      sessionStorage.removeItem("openmontage.batch_task_ids");
      setStatus("error", "分镜视频部分失败", "请打开独立 Backlot 项目查看失败镜头；已完成镜头不会被覆盖。");
    } else if (!silent) {
      setStatus("neutral", "分镜视频生成中", `已完成 ${data.completed_count || 0}/${data.total_count || batchTaskIds.length} 个镜头，心跳会继续刷新。`);
    }
  } catch (error) {
    if (revision !== paidRevision || taskKey !== batchId) return;
    if (!silent) setStatus("warn", "批量心跳暂时失败", `${error.message}；系统会继续重试。`);
    heartbeatDetail.textContent = `第 ${heartbeatAttempts} 次批量查询暂时失败：${error.message}；将继续重试。`;
  } finally {
    if (revision === paidRevision) heartbeatBusy = false;
  }
}

function startBatchHeartbeat(data) {
  batchId = data.batch_id || null;
  batchTaskIds = Array.isArray(data.task_ids) ? data.task_ids : [];
  heartbeatStartedAt = Date.now();
  heartbeatAttempts = 0;
  showBatchTask(data);
  stopHeartbeat();
  heartbeatTimer = window.setInterval(() => {
    heartbeatElapsed.textContent = formatElapsed((Date.now() - heartbeatStartedAt) / 1000);
    void refreshBatch(true);
  }, 5000);
  void refreshBatch(true);
}

function showTask(data) {
  const batchTaskIdsFromReceipt = data?.data?.batch_task_ids;
  if (Array.isArray(batchTaskIdsFromReceipt) && batchTaskIdsFromReceipt.length > 1) {
    // Older browser sessions persisted only the first task id. If that task
    // belongs to a quality batch, upgrade the session to the batch heartbeat
    // so the creator sees the full storyboard instead of one 5-second clip.
    startBatchHeartbeat({
      batch_id: data?.data?.batch_id,
      task_id: data.task_id,
      task_ids: batchTaskIdsFromReceipt,
      status: data.status,
      total_duration_seconds: data?.data?.storyboard_total_duration_seconds,
      continuous_video_url: data?.data?.continuous_video_url,
    });
    return;
  }
  currentTaskId = data.task_id;
  updatePaidReceipt(data);
  setModeFocus(workflow.mode === "speed" ? "speed" : "quality", { details: workflow.mode === "speed" });
  taskActions.hidden = false;
  taskIdElement.textContent = data.task_id;
  sessionStorage.setItem("openmontage.task_id", data.task_id);
  const url = findVideoUrl(data);
  const status = String(data.status || "unknown").toLowerCase();
  const finished = SUCCESS_STATUSES.has(status);
  if (finished && url) {
    videoLink.href = url;
    videoLink.hidden = false;
    videoPending.hidden = true;
    renderVideoPreviews([{ title: "已完成视频", url }]);
  } else {
    videoLink.hidden = true;
    videoPending.hidden = false;
    clearVideoPreview();
  }
  const projectId = data?.data?.backlot_project_id;
  const projectUrl = data?.data?.backlot_project_url || (projectId ? `/p/${projectId}` : null);
  if (projectUrl) {
    projectLink.href = projectUrl;
    projectLink.hidden = false;
    sessionStorage.setItem("openmontage.project_url", projectUrl);
    workflow.projectUrl = projectUrl;
    if (qualityReviewProjectLink) {
      qualityReviewProjectLink.href = projectUrl;
      qualityReviewProjectLink.hidden = false;
    }
    if (qualityOpenMedia) qualityOpenMedia.hidden = false;
  }
  if (projectId) showMediaPanel(projectId, { loadState: true });
  rawEstimate.hidden = false;
  rawEstimate.textContent = JSON.stringify(data.data || data, null, 2);
  updateHeartbeat(data);
}

async function refreshTask(silent = false) {
  if (!currentTaskId || heartbeatBusy) return;
  const revision = paidRevision, taskKey = currentTaskId;
  heartbeatBusy = true;
  heartbeatAttempts += 1;
  try {
    const data = await postJSON("/model-api/paid/query", { task_id: currentTaskId });
    if (revision !== paidRevision || taskKey !== currentTaskId) return;
    showTask(data);
    const status = String(data.status || "unknown").toLowerCase();
    if (SUCCESS_STATUSES.has(status)) {
      stopHeartbeat();
      if (workflow.mode === "quality") {
        setQualityStage(3);
        if (qualityReviewBadge) qualityReviewBadge.textContent = "可开始实测";
        if (qualityReviewStatus) qualityReviewStatus.textContent = "视频文件已返回。现在进入裁判式质检：先打开独立项目或后期面板运行真实抽帧、音频、黑帧和字幕检查，证据齐全后才填写分数。";
      } else {
        setWorkflowStep(3);
      }
      setStatus("ok", "视频已完成", "模型任务已完成，链接只在终态显示；现在可以进入质检并查看真实证据。 ");
    } else if (FAILURE_STATUSES.has(status)) {
      stopHeartbeat();
      setStatus("error", "视频任务已停止", `任务状态：${data.status}。请打开独立项目查看错误事件。`);
    } else if (!silent) {
      setStatus("neutral", "实时生成中", `当前状态：${statusLabel(status)}。心跳会继续自动刷新。`);
    }
  } catch (error) {
    if (revision !== paidRevision || taskKey !== currentTaskId) return;
    if (!silent) setStatus("warn", "心跳暂时失败", `${error.message}；系统会继续重试，不会重复创建任务。`);
    heartbeatDetail.textContent = `第 ${heartbeatAttempts} 次查询暂时失败：${error.message}；将继续重试。`;
  } finally {
    if (revision === paidRevision) heartbeatBusy = false;
  }
}

function startHeartbeat(data) {
  updatePaidReceipt(data);
  currentTaskId = data.task_id;
  heartbeatStartedAt = Date.now();
  heartbeatAttempts = 0;
  heartbeat.hidden = false;
  heartbeat.className = "heartbeat";
  updateHeartbeat(data);
  stopHeartbeat();
  heartbeatTimer = window.setInterval(() => {
    heartbeatElapsed.textContent = formatElapsed((Date.now() - heartbeatStartedAt) / 1000);
    void refreshTask(true);
  }, 5000);
  void refreshTask(true);
}

function mediaProject() {
  return mediaProjectId?.value.trim() || "";
}

function requireMediaProject() {
  const projectId = mediaProject();
  if (!projectId) throw new Error("请先完成视频任务，或输入一个已存在的本机项目 ID。");
  return projectId;
}

function mediaLines(element) {
  return (element?.value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function mediaSegmentsPayload({ timed = false } = {}) {
  const lines = mediaLines(mediaSegments);
  if (!lines.length) throw new Error("请先输入至少一段旁白文本。");
  let cursor = 0;
  return lines.map((text, index) => {
    const duration = Math.max(1.2, Math.min(12, text.replace(/\s/g, "").length / 3.5));
    const item = { id: `segment-${String(index + 1).padStart(2, "0")}`, text };
    if (timed) {
      item.start_seconds = Number(cursor.toFixed(3));
      item.end_seconds = Number((cursor + duration).toFixed(3));
    }
    cursor += duration;
    return item;
  });
}

function mediaAudioPayload(projectId, execution = false) {
  const provider = mediaAudioProvider?.value || "macos";
  const rate = Number(mediaAudioRate?.value || 1);
  if (!Number.isFinite(rate) || rate < 0.25 || rate > 2) {
    throw new Error("语速倍率应在 0.25—2 之间。");
  }
  return {
    project_id: projectId,
    segments: mediaSegmentsPayload(),
    preferred_provider: provider,
    allowed_providers: provider === "piper" ? ["piper"] : null,
    model_id: provider === "piper" ? document.getElementById("mediaPiperModel").value : null,
    voice: provider === "macos" ? "Tingting" : null,
    speaking_rate: rate,
    output_format: "mp3_44100_128",
    dry_run: !execution,
    execute: execution,
    confirm: execution,
  };
}

function musicPayload(projectId, execution = false) {
  const prompt = mediaMusicPrompt?.value.trim() || "";
  if (prompt.length < 4) throw new Error("BGM 提示词至少需要 4 个字符。");
  const durationRaw = mediaMusicDuration?.value.trim() || "";
  const duration = durationRaw ? Number(durationRaw) : null;
  if (duration !== null && (!Number.isFinite(duration) || duration < 3 || duration > 600)) {
    throw new Error("BGM 时长应在 3—600 秒之间；留空可从参考成片读取。");
  }
  const outputName = mediaMusicOutput?.value.trim() || "generated-bgm.mp3";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(outputName)) {
    throw new Error("BGM 输出文件名不安全或扩展名不受支持。");
  }
  const reference = mediaMusicReferenceVideo?.value.trim() || null;
  return {
    project_id: projectId,
    prompt,
    duration_seconds: duration,
    preferred_provider: mediaMusicProvider?.value || "local",
    local_style: document.getElementById("mediaMusicLocalStyle")?.value || "guofeng_ambient",
    local_tempo_bpm: Number(document.getElementById("mediaMusicLocalTempo")?.value || 72),
    reference_video_path: reference,
    reference_summary: "以最终无 BGM 成片的画面节奏、情绪曲线和转场为文本参考",
    output_name: outputName,
    force_instrumental: mediaMusicInstrumental?.checked !== false,
    allow_fallback: false,
    dry_run: !execution,
    execute: execution,
    confirm: execution,
  };
}

async function requestMusicEstimate(projectId) {
  return postJSON("/model-api/media/music/estimate", musicPayload(projectId, false));
}

function updateMusicExecuteGate(data) {
  if (!mediaMusicExecuteButton) return;
  const ready = data?.status === "dry_run" && data?.would_generate === true;
  mediaMusicExecuteButton.dataset.musicReady = ready ? "1" : "0";
  mediaMusicExecuteButton.disabled = !ready;
  mediaMusicExecuteButton.textContent = ready ? "确认并生成 BGM" : "预检通过后生成 BGM";
  mediaMusicExecuteButton.title = ready
    ? "已通过预检；点击后确认所选制作方式"
    : "先完成免费预检；服务不可用时不会产生文件";
}

function applyMusicEstimate(data) {
  updateMusicExecuteGate(data);
  if (data?.duration_seconds && mediaMusicDuration && !mediaMusicDuration.value) {
    mediaMusicDuration.value = Number(data.duration_seconds).toFixed(1);
  }
  if (mediaMusicStatus) {
    if (data?.status === "dry_run" && data?.would_generate) {
      const cost = data.estimated_cost_cny == null ? "待服务端返回" : `约 ¥${Number(data.estimated_cost_cny).toFixed(2)}`;
      mediaMusicStatus.textContent = data.provider?.provider === "local_synthesis"
        ? `本机预检通过：${data.duration_seconds || "—"} 秒，免费器乐预设；确认后合成。`
        : `预检通过：${data.duration_seconds || "—"} 秒，预计 ${cost}；确认后才会调用 ElevenLabs。`;
    } else if (data?.status === "dry_run") {
      mediaMusicStatus.textContent = data.message || data.error || "BGM 当前不可用；没有写入文件。";
    } else if (data?.error) {
      mediaMusicStatus.textContent = data.error;
    }
  }
}

async function estimateMusicMedia() {
  if (mediaMusicEstimateButton) mediaMusicEstimateButton.disabled = true;
  try {
    const projectId = requireMediaProject();
    const hasReference = Boolean(mediaMusicReferenceVideo?.value.trim());
    const hasDuration = Boolean(mediaMusicDuration?.value.trim());
    if (!hasReference && !hasDuration) {
      const message = "请先填写目标时长，或填入无 BGM 成片路径后读取时长；这样系统才能按成片节奏编排音乐。";
      updateMusicExecuteGate({ status: "invalid_request" });
      if (mediaMusicStatus) mediaMusicStatus.textContent = message;
      showMediaResult({ status: "invalid_request", error: message, hint: "填写目标时长或参考成片路径后再预检。" });
      mediaMusicDuration?.focus();
      return;
    }
    if (mediaMusicStatus) mediaMusicStatus.textContent = "正在读取参考成片时长、BGM cue sheet 和服务状态；不会写文件。";
    const data = await requestMusicEstimate(projectId);
    applyMusicEstimate(data);
    showMediaResult(data);
  } catch (error) {
    updateMusicExecuteGate({ status: "invalid_request" });
    if (mediaMusicStatus) mediaMusicStatus.textContent = `BGM 预检失败：${error.message}`;
    showMediaResult({ status: "invalid_request", error: error.message });
  } finally {
    if (mediaMusicEstimateButton) mediaMusicEstimateButton.disabled = false;
  }
}

async function readMusicReferenceDuration() {
  if (!mediaMusicReferenceVideo?.value.trim()) {
    if (mediaMusicStatus) mediaMusicStatus.textContent = "请先填写无 BGM 成片路径，再读取其时长。";
    mediaMusicReferenceVideo?.focus();
    return;
  }
  if (mediaMusicReadDurationButton) mediaMusicReadDurationButton.disabled = true;
  try {
    const projectId = requireMediaProject();
    if (mediaMusicStatus) mediaMusicStatus.textContent = "正在读取参考成片真实时长（免费，不调用 ElevenLabs）。";
    const data = await requestMusicEstimate(projectId);
    if (data?.status === "dry_run" && data.duration_seconds && mediaMusicDuration) {
      mediaMusicDuration.value = Number(data.duration_seconds).toFixed(1);
      mediaMusicStatus.textContent = `已带入参考成片时长：${Number(data.duration_seconds).toFixed(1)} 秒。接下来可免费预检 BGM。`;
    } else {
      applyMusicEstimate(data);
    }
    showMediaResult(data);
  } catch (error) {
    updateMusicExecuteGate({ status: "invalid_request" });
    if (mediaMusicStatus) mediaMusicStatus.textContent = `读取时长失败：${error.message}`;
    showMediaResult({ status: "invalid_request", error: error.message });
  } finally {
    if (mediaMusicReadDurationButton) mediaMusicReadDurationButton.disabled = false;
  }
}

async function executeMusicMedia() {
  if (mediaMusicExecuteButton?.dataset.musicReady !== "1") {
    if (mediaMusicStatus) mediaMusicStatus.textContent = "请先完成免费预检；预检未通过时不会调用音乐服务。";
    return;
  }
  if (mediaMusicExecuteButton) mediaMusicExecuteButton.disabled = true;
  try {
    const projectId = requireMediaProject();
    if (mediaMusicStatus) mediaMusicStatus.textContent = "先做一次免费预检，确认服务可用和预计费用……";
    const previewPayload = musicPayload(projectId, false);
    const preview = await postJSON("/model-api/media/music/estimate", previewPayload);
    applyMusicEstimate(preview);
    showMediaResult(preview);
    if (preview.status !== "dry_run") return;
    if (!preview.would_generate) {
      setStatus("warn", "BGM 暂不可用", preview.error || preview.message || "请先配置 ElevenLabs Music。 ");
      return;
    }
    const cost = preview.estimated_cost_cny == null ? "待服务端确认" : `预计 ¥${Number(preview.estimated_cost_cny).toFixed(2)}`;
    const local = preview.provider?.provider === "local_synthesis";
    const question = local
      ? `确认在本机合成 ${preview.duration_seconds} 秒器乐配乐吗？免费，不联网；按预设编排并保留已有配乐。`
      : `确认生成 ${preview.duration_seconds} 秒器乐 BGM（${cost}）吗？将产生 ElevenLabs 费用，且只写入当前项目。`;
    if (!window.confirm(question)) return;
    if (mediaMusicStatus) mediaMusicStatus.textContent = "已确认，正在生成 BGM；请勿重复点击。";
    setStatus("neutral", "BGM 制作中", local ? "本机正在合成器乐，完成后带入混音。" : "ElevenLabs 正在生成器乐，完成后会自动带入下方混音轨道。 ");
    const result = await postJSON("/model-api/media/music/render", {
      ...previewPayload,
      dry_run: false,
      execute: true,
      confirm: true,
    });
    showMediaResult(result);
    applyMusicEstimate(result);
    if (result.status === "completed") {
      if (mediaMusicStatus) mediaMusicStatus.textContent = "BGM 已生成并通过文件/哈希验证，已自动带入混音。";
      mediaAudioOperation && (mediaAudioOperation.value = "full_mix");
      selectEditStep("mediaAudioMixCard");
      document.getElementById("mediaAudioMixCard")?.scrollIntoView({ behavior: "auto", block: "start" });
    }
  } catch (error) {
    updateMusicExecuteGate({ status: "invalid_request" });
    if (mediaMusicStatus) mediaMusicStatus.textContent = `BGM 未生成：${error.message}`;
    showMediaResult({ status: "invalid_request", error: error.message });
    setStatus("error", "BGM 未生成", error.message);
  } finally {
    if (mediaMusicExecuteButton) mediaMusicExecuteButton.disabled = mediaMusicExecuteButton.dataset.musicReady !== "1";
  }
}

function parseAudioTrackLines() {
  return mediaLines(mediaAudioTracks).map((line, index) => {
    const fields = line.split(/[|｜]/).map((item) => item.trim());
    const path = fields[0];
    const role = fields[1] || "speech";
    const volume = fields[2] === undefined || fields[2] === "" ? 1 : Number(fields[2]);
    const start = fields[3] === undefined || fields[3] === "" ? 0 : Number(fields[3]);
    if (!path) throw new Error(`第 ${index + 1} 条音频轨道缺少路径。`);
    if (!["speech", "music", "sfx", "primary", "secondary"].includes(role)) {
      throw new Error(`第 ${index + 1} 条音频轨道角色无效：${role}。`);
    }
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new Error(`第 ${index + 1} 条音频轨道音量应在 0—1 之间。`);
    if (!Number.isFinite(start) || start < 0) throw new Error(`第 ${index + 1} 条音频轨道起始秒数无效。`);
    return { path, role, volume, start_seconds: start };
  });
}

function parseAudioSegments() {
  return mediaLines(mediaAudioSegments).map((line, index) => {
    const match = line.match(/^\s*([0-9]+(?:\.[0-9]+)?)\s*[-—]\s*([0-9]+(?:\.[0-9]+)?)\s*$/);
    if (!match) throw new Error(`第 ${index + 1} 条 BGM 时间应写成“开始秒-结束秒”。`);
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!(end > start)) throw new Error(`第 ${index + 1} 条 BGM 时间的结束秒必须大于开始秒。`);
    return { start, end };
  });
}

function audioMixOutputName(operation) {
  const value = mediaAudioOutput?.value.trim() || (operation === "segmented_music" ? "openmontage-with-bgm.mp4" : "openmontage-mix.wav");
  const video = /\.(mp4|mov|m4v|webm|mkv)$/i.test(value);
  const audio = /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(value);
  if (operation === "segmented_music" && !video) throw new Error("按片段后置 BGM 的输出文件名必须是 mp4、mov、m4v、webm 或 mkv。 ");
  if (operation !== "segmented_music" && !audio) throw new Error("音频混音/抽取的输出文件名必须是 mp3、wav、m4a、aac、ogg 或 flac。 ");
  return value;
}

function audioNumber(element, fallback, label, { min = null, max = null } = {}) {
  const raw = element?.value.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || (min !== null && value < min) || (max !== null && value > max)) {
    throw new Error(`${label}数值不在允许范围内。`);
  }
  return value;
}

function audioMixPayload(projectId, execution = false) {
  const operation = mediaAudioOperation?.value || "full_mix";
  const primary = mediaAudioPrimary?.value.trim() || null;
  const secondary = mediaAudioSecondary?.value.trim() || null;
  const video = mediaAudioVideo?.value.trim() || null;
  const tracks = parseAudioTrackLines();
  if ((operation === "full_mix" || operation === "mix") && primary && !tracks.some((track) => track.path === primary)) tracks.unshift({ path: primary, role: "speech", volume: 1, start_seconds: 0 });
  if ((operation === "full_mix" || operation === "mix") && secondary && !tracks.some((track) => track.path === secondary)) tracks.push({ path: secondary, role: "music", volume: 0.3, start_seconds: 0 });
  if (operation === "duck" && (!primary || !secondary)) throw new Error("旁白压低 BGM 需要同时填写主音频/旁白和 BGM 路径。 ");
  if (operation === "extract" && !primary) throw new Error("从视频抽取音频需要填写主音频/抽取源路径。 ");
  if (operation === "segmented_music" && (!video || !secondary)) throw new Error("按片段后置 BGM 需要填写视频路径和 BGM 路径。 ");
  if ((operation === "mix" || operation === "full_mix") && !tracks.length) throw new Error("多轨混音至少需要一条轨道，或填写主音频/BGM路径。 ");
  const body = {
    project_id: projectId,
    operation,
    tracks,
    primary_audio: operation === "duck" ? primary : null,
    secondary_audio: operation === "duck" ? secondary : null,
    input_path: operation === "extract" ? primary : null,
    video_path: operation === "segmented_music" ? video : null,
    music_path: operation === "segmented_music" ? secondary : null,
    music_volume_during_speech: audioNumber(mediaAudioMusicVolume, 0.15, "旁白时 BGM 音量", { min: 0, max: 1 }),
    loudnorm_target: audioNumber(mediaAudioLufs, -16, "响度目标", { min: -40, max: 0 }),
    target_duration: audioNumber(mediaAudioTargetDuration, null, "目标时长", { min: 0.1 }),
    normalize: true,
    segments: operation === "segmented_music" ? parseAudioSegments() : [],
    dry_run: !execution,
    execute: execution,
    output_name: audioMixOutputName(operation),
  };
  // The segmented operation uses this field for music level, while the
  // regular duck/full_mix operations use music_volume_during_speech.
  body.music_volume = body.music_volume_during_speech;
  return body;
}

async function estimateAudioMixMedia() {
  await runMediaAction(
    async (projectId) => postJSON("/model-api/media/audio/mix", audioMixPayload(projectId, false)),
    () => audioMixPayload(mediaProject(), false),
  );
}

async function executeAudioMixMedia() {
  if (mediaAudioMixExecuteButton) mediaAudioMixExecuteButton.disabled = true;
  try {
    const projectId = requireMediaProject();
    const previewPayload = audioMixPayload(projectId, false);
    setStatus("neutral", "检查音频后期计划", "正在读取旁白、BGM、音效和视频的真实时长；不写入文件。 ");
    const preview = await postJSON("/model-api/media/audio/mix", previewPayload);
    showMediaResult(preview);
    if (preview.status !== "dry_run") return;
    if (!preview.would_execute) {
      setStatus("warn", "音频后期暂不可用", preview.error || "请检查本机 FFmpeg 和 ffprobe。 ");
      return;
    }
    if (!window.confirm(`确认执行“${preview.operation}”并写入 ${preview.output?.path || "项目音频产物"} 吗？原始素材不会被覆盖。`)) return;
    setStatus("neutral", "音频后期处理中", "正在使用 FFmpeg 混音/压低 BGM/抽取，并在完成后验证输出。 ");
    const result = await postJSON("/model-api/media/audio/mix", { ...previewPayload, dry_run: false, execute: true });
    showMediaResult(result);
  } catch (error) {
    showMediaResult({ status: "invalid_request", error: error.message });
    setStatus("error", "音频后期未执行", error.message);
  } finally {
    if (mediaAudioMixExecuteButton) mediaAudioMixExecuteButton.disabled = false;
  }
}

function audioEnhancePayload(projectId, execution = false) {
  const inputPath = mediaAudioEnhanceInput?.value.trim();
  if (!inputPath) throw new Error("请先填写要清理的旁白路径。 ");
  const outputName = mediaAudioEnhanceOutput?.value.trim() || "narration-enhanced.m4a";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(mp3|wav|m4a|aac|ogg|flac|mp4|mov|m4v|webm|mkv)$/i.test(outputName)) throw new Error("增强输出文件名不安全或扩展名不受支持。 ");
  return { project_id: projectId, input_path: inputPath, preset: mediaAudioEnhancePreset?.value || "clean_speech", output_name: outputName, dry_run: !execution, execute: execution };
}

async function executeAudioEnhanceMedia() {
  if (mediaAudioEnhanceExecuteButton) mediaAudioEnhanceExecuteButton.disabled = true;
  try {
    const projectId = requireMediaProject();
    const previewPayload = audioEnhancePayload(projectId, false);
    setStatus("neutral", "检查旁白清理计划", "只读取输入文件和 FFmpeg 能力，不覆盖原始旁白。 ");
    const preview = await postJSON("/model-api/media/audio/enhance", previewPayload);
    showMediaResult(preview);
    if (preview.status !== "dry_run") return;
    if (!preview.would_execute) { setStatus("warn", "旁白清理暂不可用", preview.error || "请检查本机 FFmpeg。 "); return; }
    if (!window.confirm(`确认使用“${preview.preset}”处理旁白并保存 ${preview.output?.path || "增强文件"} 吗？`)) return;
    setStatus("neutral", "旁白清理中", "正在降噪、压缩并规范化响度；原文件保持不变。 ");
    const result = await postJSON("/model-api/media/audio/enhance", { ...previewPayload, dry_run: false, execute: true });
    showMediaResult(result);
  } catch (error) {
    showMediaResult({ status: "invalid_request", error: error.message });
    setStatus("error", "旁白清理未执行", error.message);
  } finally {
    if (mediaAudioEnhanceExecuteButton) mediaAudioEnhanceExecuteButton.disabled = false;
  }
}

function mediaImagePayload(projectId) {
  const lines = mediaLines(mediaImagePrompts);
  if (!lines.length) throw new Error("请先输入至少一条分镜图提示词。");
  return { project_id: projectId, shots: lines.map((prompt, index) => ({ id: `shot-${String(index + 1).padStart(2, "0")}`, prompt, aspect_ratio: document.getElementById("aspectRatio")?.value || "9:16", resolution: document.getElementById("resolution")?.value || "480p" })) };
}

function mediaClipPaths() {
  const clips = mediaLines(mediaClips);
  if (!clips.length) throw new Error("请先输入至少一个项目内视频路径。");
  return clips;
}

function mediaCsv(element) {
  return (element?.value || "")
    .split(/[，,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function mediaPathURL(path) {
  if (/^https?:\/\//i.test(String(path || ""))) return String(path);
  const projectId = mediaProject();
  const cleanPath = String(path || "").replace(/^\/+/, "");
  if (!projectId || !cleanPath) return "#";
  return `/media/${encodeURIComponent(projectId)}/${cleanPath.split("/").map(encodeURIComponent).join("/")}`;
}

function workflowMediaPathURL(path) {
  const rawPath = String(path || "").trim();
  if (!rawPath) return "#";
  if (/^(https?:|data:|blob:)/i.test(rawPath)) return rawPath;
  const projectId = workflow.draftId || sessionStorage.getItem("openmontage.workflow_draft_id") || "";
  const cleanPath = rawPath.replace(/^\/+/, "");
  if (!projectId || !cleanPath) return "#";
  return `/media/${encodeURIComponent(projectId)}/${cleanPath.split("/").map(encodeURIComponent).join("/")}`;
}

function addMediaPreviewLink(container, path, label) {
  if (!path) return;
  const link = document.createElement("a");
  link.className = "media-preview-link";
  link.href = mediaPathURL(path);
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = label || path;
  container.append(link);
}

function renderMediaPreview(data) {
  if (!mediaPreview || !mediaPreviewGrid) return;
  const items = [];
  const seen = new Set();
  const add = (kind, path, label, options = {}) => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    items.push({ kind, path: String(path), label: label || String(path), composeCandidate: Boolean(options.composeCandidate) });
  };
  (Array.isArray(data?.images) ? data.images : []).forEach((image, index) => {
    add("image", image?.path, image?.shot_id ? `分镜 ${image.shot_id}` : `分镜图 ${index + 1}`);
  });
  (Array.isArray(data?.keyframes) ? data.keyframes : []).forEach((frame, index) => {
    const timestamp = Number(frame?.timestamp_seconds);
    const suffix = Number.isFinite(timestamp) ? ` · ${timestamp.toFixed(1)}s` : "";
    add("image", frame?.path, `参考关键帧 ${index + 1}${suffix}`);
  });
  (Array.isArray(data?.frames) ? data.frames : []).forEach((frame, index) => {
    const timestamp = Number(frame?.timestamp_seconds);
    const suffix = Number.isFinite(timestamp) ? ` · ${timestamp.toFixed(1)}s` : "";
    add("image", frame?.path, `抽取帧 ${index + 1}${suffix}`);
  });
  (Array.isArray(data?.stock_clips) ? data.stock_clips : Array.isArray(data?.clips) ? data.clips : []).forEach((clip, index) => {
    if (!clip || typeof clip !== "object") return;
    const kind = clip.kind === "image" ? "image" : "video";
    const source = clip.source ? ` · ${clip.source}` : "";
    add(kind, clip.path, `素材候选 ${index + 1}${source}`, { composeCandidate: kind === "video" });
    if (clip.thumbnail) add("image", clip.thumbnail, `素材缩略图 ${index + 1}${source}`);
  });
  (Array.isArray(data?.trimmed_clips) ? data.trimmed_clips : []).forEach((clip, index) => {
    const path = typeof clip === "string" ? clip : clip?.path;
    add("video", path, `已裁剪片段 ${index + 1}`, { composeCandidate: true });
  });
  (Array.isArray(data?.renders) ? data.renders : []).forEach((render, index) => {
    const path = typeof render === "string" ? render : render?.path;
    add("video", path, `项目渲染视频 ${index + 1}`);
  });
  (Array.isArray(data?.still_clips) ? data.still_clips : []).forEach((clip, index) => {
    add("video", clip?.clip_path, `分镜动态图 ${index + 1}`);
  });
  // Video-postprocess returns either a derived video or a JSON analysis
  // report.  Decide from the declared kind (and the extension as a safe
  // fallback) so a scene report is not mounted in a <video> element.
  const outputPath = data?.output?.path;
  const outputIsReport = data?.output?.kind === "report" || /\.json$/i.test(String(outputPath || ""));
  const outputIsAudio = data?.output?.kind === "audio" || /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(String(outputPath || ""));
  const outputIsImage = /\.(png|jpg|jpeg|webp)$/i.test(String(outputPath || ""));
  const outputLabel = data?.local ? "本地工具产物" : outputIsReport
    ? (data?.operation === "scene_detect" ? "场景检测报告" : "视频分析报告")
    : outputIsAudio ? "音频产物" : "视频后期输出";
  add(outputIsReport ? "file" : outputIsImage ? "image" : outputIsAudio ? "audio" : "video", outputPath, outputLabel, {
    composeCandidate: !outputIsReport && !outputIsImage && !outputIsAudio && (data?.local || ["silence_cut", "auto_reframe", "color_grade"].includes(String(data?.operation || ""))),
  });
  add("video", data?.video?.path, "视频");
  const reportLabel = data?.summary && data?.report?.path
    ? "人脸追踪报告"
    : (data?.operation === "scene_detect" ? "场景检测报告" : "静音整理报告");
  add("file", data?.report?.path, reportLabel);
  (Array.isArray(data?.reports) ? data.reports : []).forEach((report, index) => {
    const path = typeof report === "string" ? report : report?.path;
    add("file", path, `人脸追踪报告 ${index + 1}`);
  });
  add("file", data?.analysis?.path, "视频分析报告");
  add("audio", data?.audio?.path, "旁白音频");
  (Array.isArray(data?.audio_files) ? data.audio_files : []).forEach((file, index) => {
    const path = typeof file === "string" ? file : file?.path;
    add("audio", path, `项目旁白 ${index + 1}`);
  });
  const musicItems = Array.isArray(data?.music) ? data.music : data?.music ? [data.music] : [];
  musicItems.forEach((file, index) => {
    const path = typeof file === "string" ? file : file?.path;
    add("audio", path, `项目 BGM ${index + 1}`);
  });
  add("subtitle", data?.subtitles?.srt, "SRT 字幕");
  add("subtitle", data?.subtitles?.vtt, "VTT 字幕");
  (Array.isArray(data?.subtitle_files) ? data.subtitle_files : []).forEach((file, index) => {
    const path = typeof file === "string" ? file : file?.path;
    add("subtitle", path, `项目字幕 ${index + 1}`);
  });
  add("file", data?.manifest?.path, "阶段清单");
  if (data?.artifacts && typeof data.artifacts === "object") {
    Object.entries(data.artifacts).forEach(([name, value]) => {
      const path = typeof value === "string" ? value : value?.path;
      if (path) add("file", path, name);
    });
  }
  (Array.isArray(data?.files_written) ? data.files_written : []).forEach((path) => add("file", path, "交付包文件"));
  if (!items.length) {
    mediaPreview.hidden = true;
    mediaPreviewGrid.innerHTML = "";
    return;
  }
  mediaPreview.hidden = false;
  mediaPreviewGrid.innerHTML = "";
  items.forEach(({ kind, path, label, composeCandidate }) => {
    const card = document.createElement("article");
    card.className = `media-preview-item ${kind}`;
    const title = document.createElement("b");
    title.textContent = label;
    card.append(title);
    if (kind === "image") {
      const image = document.createElement("img");
      image.loading = "lazy";
      image.alt = label;
      image.src = mediaPathURL(path);
      card.append(image);
    } else if (kind === "video") {
      const video = document.createElement("video");
      video.controls = true;
      video.preload = "metadata";
      video.src = mediaPathURL(path);
      card.append(video);
    } else if (kind === "audio") {
      const audio = document.createElement("audio");
      audio.controls = true;
      audio.preload = "metadata";
      audio.src = mediaPathURL(path);
      card.append(audio);
    }
    addMediaPreviewLink(card, path, `打开 ${path}`);
    if (composeCandidate && mediaClips) {
      const useButton = document.createElement("button");
      useButton.type = "button";
      useButton.className = "secondary compact media-preview-use";
      useButton.textContent = "加入合成清单";
      useButton.onclick = () => {
        const paths = mediaLines(mediaClips);
        if (!paths.includes(path)) paths.push(path);
        mediaClips.value = paths.join("\n");
        mediaClips.dispatchEvent(new Event("input", { bubbles: true }));
        selectEditStep("mediaVideoComposeCard");
        setStatus("ok", "已加入合成清单", `${path} 已加入多段视频合成；你仍可在下方调整顺序。`);
        mediaClips.scrollIntoView({ behavior: "smooth", block: "center" });
      };
      card.append(useButton);
    }
    mediaPreviewGrid.append(card);
  });
}

function autofillMediaPaths(data, { preserveExisting = false } = {}) {
  const candidateOutput = data?.output?.path || null;
  const outputKind = String(data?.output?.kind || "").toLowerCase();
  const outputIsAudio = outputKind === "audio" || /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(String(candidateOutput || ""));
  const outputPath = (/\.(mp4|mov|webm|mkv|m4v)$/i.test(String(candidateOutput || "")) ? candidateOutput : null) || data?.video?.path || data?.preferred_video_path || null;
  const musicPath = data?.music?.path || (Array.isArray(data?.music) ? data.music.find((item) => item?.path)?.path : null) || (outputIsAudio && data?.capability === "music_generation" ? candidateOutput : null);
  // Music generation also returns output.kind=audio. Keep it out of the
  // narration fields, otherwise adding BGM silently replaces the voice track.
  const audioPath = data?.audio?.path || (outputIsAudio && !musicPath ? candidateOutput : null);
  const subtitlePath = data?.subtitles?.srt || data?.files?.srt?.path;
  const defaults = { video: false, segments: false };
  const preferredVideoPath = data?.preferred_video_path || outputPath;
  if (preferredVideoPath && mediaTranscriptPath && !mediaTranscriptPath.value) {
    mediaTranscriptPath.value = preferredVideoPath;
    defaults.video = true;
  }
  if (preferredVideoPath && mediaAnalysisPath && !mediaAnalysisPath.value) mediaAnalysisPath.value = preferredVideoPath;
  if (outputPath && mediaPublishVideo && (!preserveExisting || !mediaPublishVideo.value.trim())) mediaPublishVideo.value = outputPath;
  if (outputPath) {
    if (mediaAudioVideo && mediaAudioOperation?.value === "segmented_music" && (!preserveExisting || !mediaAudioVideo.value.trim())) mediaAudioVideo.value = outputPath;
    if (mediaMusicReferenceVideo && !mediaMusicReferenceVideo.value) mediaMusicReferenceVideo.value = outputPath;
    if (mediaPostprocessInput && !mediaPostprocessInput.value) mediaPostprocessInput.value = outputPath;
  }
  if (audioPath && mediaAudioPath && (!preserveExisting || !mediaAudioPath.value.trim())) mediaAudioPath.value = audioPath;
  if (audioPath && mediaAudioPrimary && !mediaAudioPrimary.value) mediaAudioPrimary.value = audioPath;
  if (audioPath && mediaAudioEnhanceInput && !mediaAudioEnhanceInput.value) mediaAudioEnhanceInput.value = audioPath;
  if (musicPath) {
    if (mediaMusicOutput && (!preserveExisting || !mediaMusicOutput.value.trim())) mediaMusicOutput.value = musicPath.split("/").at(-1);
    if (mediaAudioSecondary && (!preserveExisting || !mediaAudioSecondary.value.trim())) mediaAudioSecondary.value = musicPath;
    if (mediaAudioTracks && (!preserveExisting || !mediaAudioTracks.value.trim())) {
      const tracks = mediaLines(mediaAudioTracks);
      if (!tracks.some((line) => line.split(/[|｜]/)[0].trim() === musicPath)) {
        tracks.push(`${musicPath} | music | 0.3 | 0`);
        mediaAudioTracks.value = tracks.join("\n");
      }
    }
  }
  if (subtitlePath && mediaSubtitlePath && (!preserveExisting || !mediaSubtitlePath.value.trim())) mediaSubtitlePath.value = subtitlePath;
  const narrationSegments = Array.isArray(data?.narration_segments) ? data.narration_segments : [];
  if (mediaSegments && !mediaSegments.value.trim() && narrationSegments.length) {
    mediaSegments.value = narrationSegments
      .map((segment) => String(segment?.text || "").trim())
      .filter(Boolean)
      .join("\n");
    defaults.segments = true;
  }
  if (data?.project_id && mediaProjectId && !mediaProjectId.value) mediaProjectId.value = data.project_id;
  return defaults;
}

function showMediaResult(data) {
  if (!mediaOutput) return;
  if (data?.project_id && mediaProject() && data.project_id !== mediaProject()) {
    setStatus("warn", "另一个项目的操作已返回", "结果保留在原项目中，切回该项目即可查看。");
    return;
  }
  mediaOutput.textContent = JSON.stringify(data, null, 2);
  const status = String(data?.status || "").toLowerCase();
  // Preflight and errors do not represent new files. Preserve the last real
  // preview and avoid inserting planned output paths into the asset picker.
  if (["completed", "passed"].includes(status)) {
    autofillMediaPaths(data);
    updateAssetPickers(data);
    renderMediaPreview(data);
  }
  const isMusicResult = Boolean(data?.music || data?.capability === "music_generation" || data?.provider?.provider === "elevenlabs");
  if (isMusicResult && mediaMusicStatus) {
    if (status === "completed") mediaMusicStatus.textContent = "BGM 已生成并完成验证，已自动带入下方混音轨道。";
    else if (status === "dry_run") applyMusicEstimate(data);
    else if (data?.error) mediaMusicStatus.textContent = data.error;
  }
  if (data?.technical && data?.semantic_review === "not_run") {
    const warnings = data.technical.warnings || [];
    const failures = data.technical.failures || [];
    setStatus(failures.length || status === "failed" ? "error" : "warn", failures.length || status === "failed" ? "技术质检未通过" : "技术检查已完成，仍需画面审核", [...failures, ...warnings, "尚未审核画面内容、字幕同步和审美质量。"].join("；"));
  } else if (status === "completed" || status === "passed") {
    setStatus("ok", "后期阶段完成", "真实文件已写入当前项目，并记录了清单、哈希和事件。");
  } else if (status === "unavailable" || status === "authorization_required" || status === "confirmation_required") {
    setStatus("warn", "能力或授权未满足", data.error || "当前操作没有写入文件。");
  } else if (status === "dry_run" && data?.transcriber?.status === "unavailable") {
    setStatus("warn", "自动转录不可用", data.transcriber.unavailable_reason || data.transcriber.install_instructions || "请先安装 faster-whisper；本次仅完成预览，没有写入字幕。");
  } else if (status === "dry_run" && ["unavailable", "unknown"].includes(String(data?.tool?.status || "").toLowerCase())) {
    setStatus("warn", "本地分析能力不可用", data.tool.unavailable_reason || data.tool.install_instructions || "请先安装该分析工具依赖；本次仅完成预检，没有写入文件。");
  } else if (status === "dry_run" && data?.tool?.status === "degraded") {
    setStatus("warn", "本地分析将使用降级方案", data.tool.degraded_reason || "可继续执行，但结果会使用工具声明的 fallback。");
  }
}

function renderMediaCapabilities(data) {
  if (!mediaCapabilities || !mediaCapabilityList) return;
  const capabilities = data?.capabilities || {};
  const entries = Object.entries(capabilities);
  mediaCapabilities.textContent = entries.length ? entries.map(([name, item]) => `${name}: ${item.status || "unknown"}`).join(" · ") : "能力检查返回为空";
  mediaCapabilityList.innerHTML = "";
  entries.forEach(([name, item]) => {
    const card = document.createElement("span");
    const status = String(item.status || "unknown").toLowerCase();
    card.className = `media-capability ${status}`;
    const dependencies = Array.isArray(item.dependencies) && item.dependencies.length
      ? ` · ${item.dependencies.join(", ")}`
      : "";
    card.textContent = `${name} · ${status === "available" ? "可用" : status === "degraded" ? "降级" : status === "deferred" ? "后置" : "未配置"}${dependencies}`;
    card.title = item.install_instructions || item.degraded_reason || item.unavailable_reason || "本机能力状态";
    card.setAttribute("aria-label", `${name}：${status}${dependencies}`);
    mediaCapabilityList.append(card);
  });
}

const TOOL_CAPABILITY_LABELS = {
  analysis: "分析与质检",
  audio_processing: "音频后期",
  avatar: "数字人/口型",
  capture: "屏幕采集",
  character_animation: "角色动画",
  enhancement: "画面增强",
  graphics: "图形与动效",
  image_generation: "图片生成",
  music_generation: "音乐生成",
  music_search: "音乐检索",
  publish: "交付发布",
  source_ingest: "素材导入",
  subtitle: "字幕",
  tts: "语音合成",
  video_generation: "视频生成",
  video_processing: "视频处理",
};

const TOOL_STATUS_LABELS = {
  available: "可用",
  degraded: "降级",
  unavailable: "未配置",
};

function renderOpenMontageToolCatalog(data) {
  if (!openmontageToolCatalogPanel || !openmontageToolCatalogGrid) return;
  openmontageToolCatalogPanel.hidden = false;
  openmontageToolCatalogGrid.innerHTML = "";
  if (!data || data.status !== "ready") {
    const message = data?.error || "工具目录暂时不可用；请稍后重试。";
    if (openmontageToolCatalogSummary) openmontageToolCatalogSummary.textContent = message;
    if (openmontageToolCatalogMeta) openmontageToolCatalogMeta.textContent = "没有读取到工具状态，未执行任何工具。";
    return;
  }

  const toolCount = Number(data.tool_count || 0);
  const available = Number(data.available_count || 0);
  const degraded = Number(data.degraded_count || 0);
  const unavailable = Number(data.unavailable_count || 0);
  if (openmontageToolCatalogSummary) {
    openmontageToolCatalogSummary.textContent = `${toolCount} 个工具：${available} 可用 · ${degraded} 降级 · ${unavailable} 未配置`;
  }
  if (openmontageToolCatalogMeta) {
    const runtimes = Object.entries(data.composition_runtimes || {})
      .map(([name, ready]) => `${name} ${ready ? "可用" : "未配置"}`)
      .join(" · ");
    const warningCount = Array.isArray(data.runtime_warnings) ? data.runtime_warnings.length : 0;
    const offerCount = Array.isArray(data.setup_offers) ? data.setup_offers.length : 0;
    openmontageToolCatalogMeta.textContent = `本机注册表已读取${runtimes ? ` · 合成运行时：${runtimes}` : ""}${warningCount ? ` · ${warningCount} 条运行提示` : ""}${offerCount ? ` · ${offerCount} 个可配置入口` : ""}`;
  }

  const groups = new Map();
  (Array.isArray(data.tools) ? data.tools : []).forEach((tool) => {
    const capability = String(tool?.capability || "generic");
    if (!groups.has(capability)) groups.set(capability, []);
    groups.get(capability).push(tool);
  });

  Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b)).forEach(([capability, tools], groupIndex) => {
    tools.sort((a, b) => String(a?.name || "").localeCompare(String(b?.name || "")));
    const group = document.createElement("details");
    group.className = "tool-catalog-group";
    group.open = groupIndex < 2;
    const groupSummary = document.createElement("summary");
    const groupAvailable = tools.filter((tool) => tool?.status === "available").length;
    const groupDegraded = tools.filter((tool) => tool?.status === "degraded").length;
    groupSummary.textContent = `${TOOL_CAPABILITY_LABELS[capability] || capability} · ${tools.length} 个工具 · ${groupAvailable} 可用${groupDegraded ? ` · ${groupDegraded} 降级` : ""}`;
    group.append(groupSummary);

    const list = document.createElement("div");
    list.className = "tool-catalog-list";
    tools.forEach((tool) => {
      const card = document.createElement("article");
      card.className = "tool-catalog-tool";
      const head = document.createElement("div");
      head.className = "tool-catalog-tool-head";
      const name = document.createElement("strong");
      name.textContent = String(tool?.name || "未命名工具");
      const status = String(tool?.status || "unavailable");
      const badge = document.createElement("span");
      badge.className = `tool-status ${["available", "degraded", "unavailable"].includes(status) ? status : "unavailable"}`;
      badge.textContent = TOOL_STATUS_LABELS[status] || "未配置";
      head.append(name, badge);
      card.append(head);

      const providerLine = document.createElement("p");
      providerLine.className = "tool-catalog-line";
      providerLine.textContent = `${tool?.provider || "openmontage"} · ${tool?.runtime || "local"}`;
      card.append(providerLine);

      const bestFor = Array.isArray(tool?.best_for) ? tool.best_for.filter(Boolean) : [];
      if (bestFor.length) {
        const bestLine = document.createElement("p");
        bestLine.className = "tool-catalog-line";
        bestLine.textContent = `适合：${bestFor.join("、")}`;
        card.append(bestLine);
      }
      const dependencies = Array.isArray(tool?.dependencies) ? tool.dependencies.filter(Boolean) : [];
      if (dependencies.length) {
        const dependencyLine = document.createElement("p");
        dependencyLine.className = "tool-catalog-line tool-catalog-dependencies";
        dependencyLine.textContent = `依赖：${dependencies.join("、")}`;
        card.append(dependencyLine);
      }
      const instructions = String(tool?.install_instructions || "").trim();
      if (instructions && status !== "available") {
        const hint = document.createElement("small");
        hint.className = "tool-catalog-hint";
        hint.textContent = instructions;
        card.append(hint);
      }
      list.append(card);
    });
    group.append(list);
    openmontageToolCatalogGrid.append(group);
  });
}

async function loadOpenMontageToolCatalog() {
  if (!openmontageToolCatalogButton) return;
  openmontageToolCatalogButton.disabled = true;
  if (openmontageToolCatalogSummary) openmontageToolCatalogSummary.textContent = "正在读取工具状态……";
  try {
    const data = await getJSON("/model-api/tools/catalog");
    renderOpenMontageToolCatalog(data);
  } catch (error) {
    renderOpenMontageToolCatalog({ status: "unavailable", error: `工具目录读取失败：${error.message}` });
  } finally {
    openmontageToolCatalogButton.disabled = false;
  }
}

function renderOpenMontagePipelineCatalog(data) {
  if (!openmontagePipelineCatalogPanel || !openmontagePipelineCatalogGrid) return;
  openmontagePipelineCatalogPanel.hidden = false;
  openmontagePipelineCatalogGrid.innerHTML = "";
  if (!data || data.status !== "ready") {
    if (openmontagePipelineCatalogMeta) openmontagePipelineCatalogMeta.textContent = data?.error || "管线目录暂时不可用。";
    return;
  }
  const pipelines = Array.isArray(data.pipelines) ? data.pipelines : [];
  if (openmontagePipelineCatalogMeta) {
    openmontagePipelineCatalogMeta.textContent = `${pipelines.length} 条已验证管线${data.invalid_count ? ` · ${data.invalid_count} 条清单需修复` : ""}。管线只展示生产契约，不会因查看而执行任务。`;
  }
  pipelines.forEach((pipeline, index) => {
    const card = document.createElement("details");
    card.className = "pipeline-catalog-card";
    card.open = index === 0;
    const summary = document.createElement("summary");
    const title = document.createElement("strong");
    title.textContent = String(pipeline?.name || "未命名管线");
    const badge = document.createElement("span");
    badge.className = "pipeline-catalog-badge";
    badge.textContent = `${pipeline?.stage_count || 0} 个阶段`;
    summary.append(title, badge);
    card.append(summary);

    const meta = document.createElement("p");
    meta.className = "tool-catalog-line";
    meta.textContent = `${pipeline?.category || "未分类"} · ${pipeline?.stability || "未标注稳定性"} · 检查点：${pipeline?.default_checkpoint_policy || "默认"}`;
    card.append(meta);
    if (pipeline?.description) {
      const description = document.createElement("p");
      description.className = "pipeline-catalog-description";
      description.textContent = pipeline.description;
      card.append(description);
    }
    const orchestration = pipeline.orchestration || {};
    const policy = document.createElement("p");
    policy.className = "tool-catalog-line";
    const budget = orchestration.budget_default_usd == null ? "未设预算" : `$${orchestration.budget_default_usd}`;
    policy.textContent = `编排：${orchestration.mode || "默认"} · 预算基线 ${budget} · 每阶段最多修订 ${orchestration.max_revisions_per_stage ?? "—"} 次`;
    card.append(policy);

    const stages = document.createElement("div");
    stages.className = "pipeline-stage-list";
    (Array.isArray(pipeline.stages) ? pipeline.stages : []).forEach((stage, stageIndex) => {
      const stageItem = document.createElement("div");
      stageItem.className = "pipeline-stage-item";
      const stageName = document.createElement("span");
      stageName.className = "pipeline-stage-name";
      stageName.textContent = `${stageIndex + 1}. ${stage?.name || "stage"}`;
      stageItem.append(stageName);
      const stageFlags = document.createElement("small");
      const flags = [];
      if (stage?.human_approval_default) flags.push("需创作者确认");
      if (stage?.checkpoint_required) flags.push("有检查点");
      if (Array.isArray(stage?.produces) && stage.produces.length) flags.push(`产出：${stage.produces.join("、")}`);
      stageFlags.textContent = flags.join(" · ") || "自动阶段";
      stageItem.append(stageFlags);
      stages.append(stageItem);
    });
    card.append(stages);
    openmontagePipelineCatalogGrid.append(card);
  });
}

async function loadOpenMontagePipelineCatalog() {
  if (!openmontagePipelineCatalogButton) return;
  openmontagePipelineCatalogButton.disabled = true;
  if (openmontagePipelineCatalogMeta) openmontagePipelineCatalogMeta.textContent = "正在读取已验证管线……";
  try {
    renderOpenMontagePipelineCatalog(await getJSON("/model-api/pipelines/catalog"));
  } catch (error) {
    renderOpenMontagePipelineCatalog({ status: "unavailable", error: `管线目录读取失败：${error.message}` });
  } finally {
    openmontagePipelineCatalogButton.disabled = false;
  }
}

async function refreshMediaCapabilities() {
  if (!mediaPipeline || mediaPipeline.hidden) return;
  try {
    renderMediaCapabilities(await getJSON("/model-api/media/capabilities"));
  } catch (error) {
    if (mediaCapabilities) mediaCapabilities.textContent = `能力检查失败：${error.message}`;
  }
}

function projectStatePreview(state) {
  const media = state?.media && typeof state.media === "object" ? state.media : {};
  const renders = Array.isArray(media.renders) ? media.renders : [];
  const stockClips = Array.isArray(media.stock) ? media.stock : [];
  const trimmedClips = Array.isArray(media.trimmed) ? media.trimmed : [];
  const audioFiles = Array.isArray(media.audio) ? media.audio : [];
  const music = Array.isArray(media.music) ? media.music : [];
  const subtitleFiles = Array.isArray(media.subtitles) ? media.subtitles : [];
  const analysis = media.analysis && typeof media.analysis === "object" ? media.analysis : {};
  const analysisFrames = Array.isArray(analysis.frames) ? analysis.frames : [];
  const faceTrackingReports = Array.isArray(analysis.face_tracking) ? analysis.face_tracking : [];
  const images = [];
  const imagePaths = new Set();
  const addImage = (path, shotId = null, label = null) => {
    if (!path) return;
    const cleanPath = String(path);
    if (imagePaths.has(cleanPath)) return;
    imagePaths.add(cleanPath);
    images.push({ path: cleanPath, shot_id: shotId, label });
  };
  const scenes = Array.isArray(state?.storyboard?.scenes) ? state.storyboard.scenes : [];
  scenes.forEach((scene) => {
    const visual = scene?.visual;
    if (visual?.exists && visual?.path && visual.type === "image") {
      addImage(visual.path, scene.id, "分镜图");
    }
  });
  // A project may contain review keyframes, stock thumbnails, or generated
  // stills that are not referenced by scene_plan yet.  They are still real
  // visual assets and should appear when the creator loads the project.
  (Array.isArray(media.snapshots) ? media.snapshots : []).forEach((snapshot, index) => {
    const path = typeof snapshot === "string" ? snapshot : snapshot?.path;
    addImage(path, snapshot?.shot_id || null, snapshot?.shot_id ? "分镜快照" : `项目图片 ${index + 1}`);
  });
  analysisFrames.forEach((frame, index) => {
    const path = typeof frame === "string" ? frame : frame?.path;
    addImage(path, null, `分析抽取帧 ${index + 1}`);
  });
  const artifactPaths = {};
  Object.entries(state?.artifacts || {}).forEach(([name, value]) => {
    const path = typeof value === "string" ? value : value?.path;
    if (path) artifactPaths[name] = path;
  });
  const stages = Array.isArray(state?.stages) ? state.stages.map((stage) => ({
    name: stage.name,
    status: stage.status,
    timestamp: stage.timestamp || null,
  })) : [];
  // Prefer a stitched/final render for transcription and analysis.  The
  // project index is reverse-chronological, so blindly taking renders[0]
  // often selected the last five-second shot instead of the complete film.
  const compositionOutput = state?.artifacts?.composition_manifest?.output;
  const composedPath = typeof compositionOutput?.path === "string" ? compositionOutput.path : "";
  const preferredRender = renders.find((render) => /(?:storyboard-final|openmontage-compose|final)\.(?:mp4|mov|m4v|webm|mkv)$/i.test(String(render?.path || ""))) || renders[0] || null;
  const firstRender = preferredRender;
  const preferredVideoPath = composedPath || preferredRender?.path || null;

  // OpenMontage keeps narration text and measured timing in the script
  // artifact.  Expose it to the media panel so a resumed project can be
  // used immediately instead of presenting empty controls that appear dead.
  const script = state?.artifacts?.script && typeof state.artifacts.script === "object"
    ? state.artifacts.script
    : state?.script && typeof state.script === "object" ? state.script : {};
  const scriptSections = Array.isArray(script.sections) ? script.sections : [];
  const narrationSegments = scriptSections.map((section, index) => {
    // ``section.text`` is the shot description in OpenMontage's cinematic
    // script artifact, not spoken copy.  Only use fields explicitly marked as
    // narration/dialogue so resuming a project never turns camera directions
    // into a several-minute voice track by accident.
    const text = String(
      section?.narration
      || section?.voiceover
      || section?.voiceover_text
      || section?.spoken_text
      || section?.dialogue
      || section?.tts_text
      || "",
    ).replace(/\s+/g, " ").trim();
    if (!text) return null;
    const start = Number(section?.start_seconds);
    const end = Number(section?.end_seconds);
    return {
      id: String(section?.id || `segment-${String(index + 1).padStart(2, "0")}`),
      text,
      ...(Number.isFinite(start) ? { start_seconds: start } : {}),
      ...(Number.isFinite(end) ? { end_seconds: end } : {}),
      label: section?.label || null,
    };
  }).filter(Boolean);
  // Candidate-based projects keep a single explicit narration paragraph at
  // ``script.narration`` rather than repeating it in every shot.  Preserve
  // that intentional voiceover, but never fall back to visual shot text.
  if (!narrationSegments.length) {
    const fullNarration = String(
      script?.narration
      || script?.voiceover
      || script?.narration_text
      || "",
    ).replace(/\s+/g, " ").trim();
    if (fullNarration) {
      const totalDuration = Number(script?.total_duration_seconds);
      narrationSegments.push({
        id: "narration-01",
        text: fullNarration,
        ...(Number.isFinite(totalDuration) && totalDuration > 0
          ? { start_seconds: 0, end_seconds: totalDuration }
          : {}),
      });
    }
  }
  const firstAudio = audioFiles[0] || null;
  const firstSubtitle = subtitleFiles.find((item) => /\.srt$/i.test(String(item?.path || ""))) || subtitleFiles[0] || null;
  return {
    project_id: state?.project_id,
    title: state?.title,
    renders,
    stock_clips: stockClips,
    trimmed_clips: trimmedClips,
    images,
    audio_files: audioFiles,
    music,
    subtitle_files: subtitleFiles,
    analysis: { frames: analysisFrames, face_tracking: faceTrackingReports },
    reports: faceTrackingReports,
    artifacts: artifactPaths,
    stage_summary: stages,
    output: firstRender,
    preferred_video_path: preferredVideoPath,
    narration_segments: narrationSegments,
    audio: firstAudio,
    subtitles: firstSubtitle ? { srt: firstSubtitle.path } : null,
  };
}

async function loadMediaProjectState(projectId) {
  if (!projectId) return null;
  if (mediaLoadStatus) mediaLoadStatus.textContent = `正在读取项目 ${projectId} 的脚本、分镜、媒体和质检记录……`;
  try {
    const state = await getJSON(`/api/project/${encodeURIComponent(projectId)}/state`);
    // A slower response from the previous project must not replace this one.
    if (mediaProject() !== projectId) return null;
    const preview = projectStatePreview(state);
    const stockManifest = preview.artifacts?.stock_search_manifest;
    if (stockManifest?.clips && workflow.draftId === projectId) renderStockShotResults(stockManifest);
    if (mediaOutput) {
      mediaOutput.textContent = JSON.stringify({
        project_id: state.project_id,
        title: state.title,
        stages: preview.stage_summary,
        artifacts: Object.keys(preview.artifacts),
        media: {
          renders: preview.renders.length,
          stock_clips: preview.stock_clips.length,
          trimmed_clips: preview.trimmed_clips.length,
          images: preview.images.length,
          audio: preview.audio_files.length,
          music: preview.music.length,
          subtitles: preview.subtitle_files.length,
          analysis_frames: preview.analysis.frames.length,
          face_tracking_reports: preview.analysis.face_tracking.length,
        },
      }, null, 2);
    }
    const defaults = autofillMediaPaths(preview, { preserveExisting: true });
    renderMediaPreview(preview);
    updateAssetPickers(preview);
    const stageDone = preview.stage_summary.filter((stage) => stage.status === "completed").length;
    if (mediaLoadStatus) {
      const filled = [];
      if (defaults.video) filled.push("已填入可识别成片");
      if (defaults.segments) filled.push(`已填入 ${preview.narration_segments.length} 段脚本旁白`);
      const suffix = filled.length ? ` ${filled.join("，")}；可直接点击旁白/字幕按钮。` : "";
      const narrationHint = preview.narration_segments.length || mediaSegments?.value.trim()
        ? ""
        : " 未发现明确的旁白文本；请先在‘旁白分段’输入框填写口播稿，再检查配音或生成字幕。";
      mediaLoadStatus.textContent = `${state.title || projectId} 已载入：${stageDone}/${preview.stage_summary.length || 0} 个阶段完成，${preview.renders.length} 个视频、${preview.stock_clips.length} 个素材候选、${preview.trimmed_clips.length} 个已裁剪片段、${preview.audio_files.length} 条旁白、${preview.music.length} 条 BGM、${preview.subtitle_files.length} 个字幕文件。${suffix}`;
      if (narrationHint) mediaLoadStatus.textContent += narrationHint;
    }
    if (defaults.video || defaults.segments) {
      if (!preview.narration_segments.length && !mediaSegments?.value.trim()) {
        setMediaNarrationStatus("warn", `已填入完整成片路径，但当前项目没有明确的旁白文本；请先在‘旁白分段’输入框填写口播稿，再检查配音服务或生成 SRT/VTT 字幕。镜头画面提示词不会被当作口播。 `);
      } else {
        setMediaNarrationStatus("ready", `当前项目已准备好旁白/字幕输入：${defaults.video ? "已填入完整成片路径" : "保留现有媒体路径"}${defaults.segments ? `，已填入 ${preview.narration_segments.length} 段脚本` : ""}。如需修改，可直接编辑上方输入框。`);
      }
    } else if (!preview.narration_segments.length && !mediaSegments?.value.trim()) {
      setMediaNarrationStatus("warn", "当前项目没有明确的旁白文本；请先在‘旁白分段’输入框填写口播稿，再检查配音服务或生成 SRT/VTT 字幕。镜头画面提示词不会被当作口播。 ");
    }
    if (mediaSegments?.value.trim() && !preview.narration_segments.length) setMediaNarrationStatus("ready", "已恢复你填写的旁白，可直接修改、配音或生成字幕。");
    void restoreTranscriptReview(projectId, state.artifacts?.transcript_manifest);
    return state;
  } catch (error) {
    if (mediaProject() !== projectId) return null;
    if (mediaLoadStatus) mediaLoadStatus.textContent = `项目读取失败：${error.message}`;
    if (mediaOutput) mediaOutput.textContent = JSON.stringify({ status: "project_load_failed", project_id: projectId, error: error.message }, null, 2);
    throw error;
  }
}

let narrationDraftProject = null;
const narrationDraftFields = [...document.querySelectorAll("#mediaGrid input, #mediaGrid textarea, #mediaGrid select")].filter(field => field.id && field.type !== "file" && !field.dataset.pickerTarget);
const mediaFieldDefaults = new Map(narrationDraftFields.map(field => [field.id, field.type === "checkbox" ? field.checked : field.value]));

function saveNarrationDraft() {
  if (!narrationDraftProject) return;
  try {
    localStorage.setItem(`openmontage.narration.${narrationDraftProject}`, JSON.stringify(
      Object.fromEntries(narrationDraftFields.map(field => [field.id, field.type === "checkbox" ? field.checked : field.value])),
    ));
  } catch {
    setMediaNarrationStatus("warn", "浏览器暂时无法保存输入草稿，请复制保存旁白文字后再离开页面。");
  }
}

function restoreNarrationDraft(projectId) {
  if (narrationDraftProject === projectId) return;
  saveNarrationDraft();
  narrationDraftProject = projectId;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(`openmontage.narration.${projectId}`) || "{}"); } catch { /* Ignore corrupt browser drafts. */ }
  narrationDraftFields.forEach(field => {
    if (field.type === "checkbox") field.checked = typeof saved?.[field.id] === "boolean" ? saved[field.id] : mediaFieldDefaults.get(field.id);
    else field.value = typeof saved?.[field.id] === "string" ? saved[field.id] : mediaFieldDefaults.get(field.id);
  });
  syncPiperField();
  syncLocalToolFields();
  resetLocalToolCheck();
}

narrationDraftFields.forEach(field => {
  field.addEventListener("input", saveNarrationDraft);
  field.addEventListener("change", saveNarrationDraft);
});

function showMediaPanel(projectId, { loadState = false, open = false } = {}) {
  if (!mediaPipeline || !projectId) return;
  if (mediaProjectId.value !== projectId) {
    const file = document.getElementById("localBgmFile");
    if (file) file.value = "";
    const audio = document.getElementById("localBgmPreview");
    if (audio) { audio.pause?.(); audio.removeAttribute("src"); audio.hidden = true; }
    document.querySelectorAll("#mediaPipeline .operation-feedback").forEach(feedback => {
      feedback.textContent = "";
      feedback.hidden = true;
    });
    const preview = document.getElementById("mediaPreview");
    if (preview) preview.hidden = true;
    const output = document.getElementById("mediaOutput");
    if (output) output.textContent = "";
  }
  if (open) setWorkspaceView("edit");
  else syncWorkspaceView();
  mediaProjectId.value = projectId;
  restoreNarrationDraft(projectId);
  syncProjectSelection(projectId);
  const savedStep = sessionStorage.getItem(`openmontage.edit_step.${projectId}`);
  editStep = editSteps.includes(savedStep) ? savedStep : "mediaNarrationCard";
  syncWorkspaceView();
  sessionStorage.setItem("openmontage.media_project_id", projectId);
  void refreshMediaCapabilities();
  if (loadState) {
    void loadMediaProjectState(projectId).catch((error) => {
      setStatus("warn", "项目产物未载入", error.message);
    });
  }
}

function setMediaNarrationStatus(kind, message) {
  if (!mediaNarrationStatus) return;
  const state = ["ready", "working", "success", "error", "warn"].includes(kind) ? kind : "ready";
  mediaNarrationStatus.className = `media-inline-status ${state}`;
  mediaNarrationStatus.textContent = message;
}

function mediaNarrationResultStatus(data, operationLabel = "操作") {
  const status = String(data?.status || "unknown").toLowerCase();
  if (data?.technical && data?.semantic_review === "not_run") {
    const failures = data.technical.failures || [];
    const warnings = data.technical.warnings || [];
    return [failures.length || status === "failed" ? "error" : "warn", `${operationLabel}：${[...failures, ...warnings, "技术检查不代表成片质量通过；字幕同步、画面内容与审美仍需人工检查。"].join("；")}`];
  }
  if (Array.isArray(data?.resolved_sources) && typeof data?.clip_count === "number" && data?.message) {
    return [status === "failed" ? "error" : status === "no_results" || data.partial ? "warn" : "success", data.message];
  }
  if (status === "completed" || status === "passed") {
    if (data?.alignment?.engine === "whisperx_forced_ctc") {
      const uncertain = Number(data.alignment.low_score_character_count || 0);
      return [uncertain ? "warn" : "success", `${operationLabel}完成：已定位 ${data.word_count || data.alignment.aligned_character_count || 0} 个汉字${uncertain ? `，其中 ${uncertain} 个匹配分数较低` : ""}；请核对错字与配音，字幕时间不会证明内容准确。`];
    }
    return ["success", `${operationLabel}完成：结果已返回，请查看下方的检查结果或媒体产物。`];
  }
  if (["queued", "running", "pending", "in_progress", "submitted"].includes(status)) {
    return ["working", `${operationLabel}已受理，尚未完成；请查看当前任务状态，避免重复提交。`];
  }
  if (status === "available" || status === "dry_run") {
    if (data?.source_summary && Array.isArray(data?.sources)) {
      return [data.would_execute ? "ready" : "warn", `${data.message || "素材源配置检查完成。"} 配置可用来源：${data.sources.join("、") || "无"}。此检查不联网，不代表来源目前可访问或一定有匹配素材。`];
    }
    const detail = data?.requires_confirmation
      ? "预检完成；下一步会在你确认后执行，不会自动扣费或写入。"
      : "预检完成；本次没有写入文件。";
    return ["ready", `${operationLabel}已响应：${detail}`];
  }
  if (["unavailable", "authorization_required", "confirmation_required"].includes(status)) {
    return ["warn", `${operationLabel}暂不可用：${data?.error || "请检查本机能力或服务端授权。"}`];
  }
  return ["error", `${operationLabel}未完成：${data?.error || `返回状态 ${status}`}`];
}

async function runMediaAction(action, operation) {
  if (mediaActionBusy) {
    setStatus("warn", "已有后期操作进行中", "请等待当前按钮完成后再开始下一项，避免重复写入同一项目。");
    setMediaNarrationStatus("warn", "已有旁白/字幕操作正在进行，请等待它完成后再点击其他按钮。 ");
    return;
  }
  mediaActionBusy = true;
  let actionProjectId = null;
  const trigger = document.activeElement instanceof HTMLButtonElement
    && document.activeElement.closest("#mediaPipeline")
    ? document.activeElement
    : null;
  const narrationAction = Boolean(trigger?.closest("#mediaNarrationCard, #mediaVoiceCard, #mediaSubtitleCard"));
  const triggerText = trigger?.textContent || "";
  const card = trigger?.closest("article");
  let feedback = card?.querySelector(".operation-feedback");
  if (card && !feedback) {
    feedback = document.createElement("p");
    feedback.className = "media-inline-status operation-feedback";
    feedback.setAttribute("role", "status");
    feedback.setAttribute("aria-live", "polite");
    trigger.closest(".media-actions")?.after(feedback);
    if (!feedback.isConnected) card.append(feedback);
  }
  const updateFeedback = (kind, message) => {
    if (actionProjectId && mediaProject() !== actionProjectId) return;
    if (!feedback) return;
    feedback.hidden = false;
    feedback.className = `media-inline-status operation-feedback ${kind}`;
    feedback.textContent = message;
  };
  const started = Date.now();
  updateFeedback("working", `${triggerText || "操作"}正在处理…`);
  const elapsedTimer = window.setInterval(() => {
    updateFeedback("working", `已等待 ${Math.floor((Date.now() - started) / 1000)} 秒，正在等待服务返回结果，请勿重复提交。`);
  }, 1000);
  if (trigger) {
    trigger.disabled = true;
    trigger.textContent = "处理中…";
    trigger.setAttribute("aria-busy", "true");
    window.WorkbenchInteractions?.setState(trigger,"running");
  }
  mediaPipeline?.setAttribute("aria-busy", "true");
  try {
    const projectId = requireMediaProject();
    actionProjectId = projectId;
    operation(projectId);
    if (narrationAction) setMediaNarrationStatus("working", `${triggerText || "旁白/字幕操作"}正在请求本机服务……`);
    setStatus("neutral", "后期处理中", "正在执行本机后期阶段；完成后会显示真实产物路径和哈希。");
    const data = await action(projectId);
    if (mediaProject() !== projectId) return data;
    showMediaResult(data);
    const [resultKind, resultMessage] = mediaNarrationResultStatus(data, triggerText || "操作");
    window.WorkbenchInteractions?.setState(trigger,window.WorkbenchInteractions.taskState(data.status));
    updateFeedback(resultKind, resultMessage);
    if (narrationAction) {
      const [kind, message] = mediaNarrationResultStatus(data, triggerText || "旁白/字幕操作");
      setMediaNarrationStatus(kind, message);
    }
    return data;
  } catch (error) {
    if (actionProjectId && mediaProject() !== actionProjectId) return;
    window.WorkbenchInteractions?.setState(trigger,"failed");
    updateFeedback("error", `${triggerText || "操作"}未完成：${error.message}`);
    showMediaResult({ status: "invalid_request", error: error.message });
    setStatus("error", "后期操作未执行", error.message);
    if (narrationAction) setMediaNarrationStatus("error", `${triggerText || "旁白/字幕操作"}未执行：${error.message}`);
  } finally {
    window.clearInterval(elapsedTimer);
    mediaActionBusy = false;
    mediaPipeline?.removeAttribute("aria-busy");
    if (trigger) {
      trigger.disabled = false;
      trigger.textContent = triggerText;
      trigger.removeAttribute("aria-busy");
      if (actionProjectId && mediaProject() !== actionProjectId) window.WorkbenchInteractions?.setState(trigger,"idle");
    }
  }
}

async function estimateAudioMedia() {
  setMediaNarrationStatus("working", "正在检查配音服务和当前旁白分段……");
  await runMediaAction(
    async (projectId) => postJSON("/model-api/media/audio/estimate", mediaAudioPayload(projectId, false)),
    () => mediaSegmentsPayload(),
  );
}

async function renderSubtitleMedia() {
  setMediaNarrationStatus("working", "正在生成 SRT/VTT 字幕文件……");
  await runMediaAction(
    async (projectId) => postJSON("/model-api/media/subtitles/render", { project_id: projectId, segments: mediaSegmentsPayload({ timed: true }), dry_run: false, execute: true }),
    () => mediaSegmentsPayload({ timed: true }),
  );
}

function mediaTranscriptPayload(projectId, execution = false) {
  const mediaPath = mediaTranscriptPath?.value.trim();
  if (!mediaPath) throw new Error("请先输入待识别的项目内媒体路径。");
  return {
    project_id: projectId,
    media_path: mediaPath,
    formats: ["srt", "vtt", "json"],
    model_size: mediaTranscriptModel?.value || "base",
    alignment: mediaTranscriptAlignment?.value || "faster_whisper",
    language: mediaTranscriptAlignment?.value === "whisperx_zh" ? "zh" : null,
    dry_run: !execution,
    execute: execution,
    confirm: false,
  };
}

async function transcribeMedia() {
  const button = document.getElementById("mediaTranscribe");
  if (button) button.disabled = true;
  setMediaNarrationStatus("working", "正在检查本机 faster-whisper 转录能力……");
  try {
    const projectId = requireMediaProject();
    const previewPayload = mediaTranscriptPayload(projectId, false);
    setStatus("neutral", "检查自动转录能力", "先读取本机识别器状态，不执行模型，也不写入文件。 ");
    const preview = await postJSON("/model-api/media/transcribe", previewPayload);
    showMediaResult(preview);
    const [previewKind, previewMessage] = mediaNarrationResultStatus(preview, "自动转录预检");
    setMediaNarrationStatus(previewKind, previewMessage);
    if (preview.status !== "dry_run") return;
    if (preview.media?.exists === false) {
      setMediaNarrationStatus("warn", `自动转录暂不可用：找不到媒体文件 ${preview.media?.path || previewPayload.media_path}。`);
      return;
    }
    if (preview.transcriber?.status !== "available") {
      setMediaNarrationStatus("warn", `自动转录暂不可用：${preview.transcriber?.unavailable_reason || preview.transcriber?.install_instructions || "本机识别器未就绪。"}`);
      return;
    }
    if (!preview.would_execute) {
      setMediaNarrationStatus("warn", preview.error || "所选字幕模式暂不可用；本次未执行识别。");
      return;
    }
    const timing = previewPayload.alignment === "whisperx_zh" ? "，并用 WhisperX 做中文精细定位" : "";
    if (!window.confirm(`确认使用本机 faster-whisper ${previewPayload.model_size} 识别该媒体${timing}并生成 SRT、VTT、JSON 字幕文件吗？可能占用较多 CPU/内存，不调用付费云服务；上一次的文件保留。`)) {
      setMediaNarrationStatus("ready", "已取消自动转录，未写入字幕文件。需要时可以再次点击。 ");
      return;
    }
    setMediaNarrationStatus("working", "自动转录进行中：正在读取音频并生成 SRT/VTT/JSON，请保持页面打开……");
    setStatus("neutral", "自动转录中", "正在读取真实音频时间戳并生成字幕；没有有效时间戳时不会生成伪造文件。 ");
    const result = await postJSON("/model-api/media/transcribe", {
      ...previewPayload,
      dry_run: false,
      execute: true,
      confirm: true,
    });
    showMediaResult(result);
    if (result.status === "completed" && mediaProject() === projectId && result.segments?.length) {
      showTranscriptReview(result);
    }
    const [resultKind, resultMessage] = mediaNarrationResultStatus(result, "自动转录");
    setMediaNarrationStatus(resultKind, resultMessage);
  } catch (error) {
    showMediaResult({ status: "invalid_request", error: error.message });
    setStatus("error", "自动转录未执行", error.message);
    setMediaNarrationStatus("error", `自动转录未执行：${error.message}`);
  } finally {
    if (button) button.disabled = false;
  }
}

function analysisSource(projectId) {
  const mediaPath = mediaAnalysisPath?.value.trim();
  if (!mediaPath) throw new Error("请先输入待分析的项目内视频路径。");
  return { project_id: projectId, media_path: mediaPath };
}

function frameSamplingPayload(projectId, execution = false) {
  const source = analysisSource(projectId);
  const count = Number(mediaFrameCount?.value || 8);
  const interval = Number(mediaFrameInterval?.value || 5);
  if (!Number.isFinite(count) || count < 1 || count > 200) throw new Error("抽取数量应在 1—200 之间。");
  if (!Number.isFinite(interval) || interval < 0.1 || interval > 3600) throw new Error("固定间隔应在 0.1—3600 秒之间。");
  const rawTimestamps = String(mediaFrameTimestamps?.value || "").split(",").map((item) => item.trim()).filter(Boolean);
  const timestamps = rawTimestamps.map((item) => Number(item));
  if (timestamps.some((value) => !Number.isFinite(value) || value < 0)) throw new Error("指定时间点必须是非负数字，并用逗号分隔。");
  return {
    ...source,
    strategy: mediaFrameStrategy?.value || "count",
    count: Math.round(count),
    interval_seconds: interval,
    timestamps,
    max_frames: Math.round(count),
    format: "jpg",
    quality: 2,
    dry_run: !execution,
    execute: execution,
    confirm: false,
  };
}

function faceTrackingPayload(projectId, execution = false) {
  const source = analysisSource(projectId);
  const sampleFps = Number(mediaFaceSampleFps?.value || 5);
  if (!Number.isFinite(sampleFps) || sampleFps < 0.1 || sampleFps > 60) throw new Error("人脸采样 FPS 应在 0.1—60 之间。");
  return {
    ...source,
    sample_fps: sampleFps,
    min_detection_confidence: 0.5,
    dry_run: !execution,
    execute: execution,
    confirm: false,
  };
}

async function estimateFrameSampling() {
  await runMediaAction(
    async (projectId) => postJSON("/model-api/media/frames/sample", frameSamplingPayload(projectId, false)),
    () => analysisSource(requireMediaProject()),
  );
}

async function executeFrameSampling() {
  if (mediaFrameExecuteButton) mediaFrameExecuteButton.disabled = true;
  try {
    const projectId = requireMediaProject();
    const previewPayload = frameSamplingPayload(projectId, false);
    setStatus("neutral", "检查抽帧能力", "只读取 FFmpeg 和源视频状态，不抽帧、不写入文件。");
    const preview = await postJSON("/model-api/media/frames/sample", previewPayload);
    showMediaResult(preview);
    if (preview.status !== "dry_run" || !preview.would_execute) return;
    if (!window.confirm("确认从该视频抽取真实关键帧吗？操作仅在本机执行，会写入 analysis/frames/，不会调用付费模型。")) return;
    setStatus("neutral", "正在抽取关键帧", "正在调用本机 FFmpeg；完成后会显示帧预览和 SHA-256 清单。");
    const result = await postJSON("/model-api/media/frames/sample", { ...previewPayload, dry_run: false, execute: true, confirm: true });
    showMediaResult(result);
  } catch (error) {
    showMediaResult({ status: "invalid_request", error: error.message });
    setStatus("error", "抽帧未执行", error.message);
  } finally {
    if (mediaFrameExecuteButton) mediaFrameExecuteButton.disabled = false;
  }
}

async function estimateFaceTracking() {
  await runMediaAction(
    async (projectId) => postJSON("/model-api/media/faces/track", faceTrackingPayload(projectId, false)),
    () => analysisSource(requireMediaProject()),
  );
}

async function executeFaceTracking() {
  if (mediaFaceExecuteButton) mediaFaceExecuteButton.disabled = true;
  try {
    const projectId = requireMediaProject();
    const previewPayload = faceTrackingPayload(projectId, false);
    setStatus("neutral", "检查人脸追踪能力", "只读取 OpenCV/MediaPipe 状态，不分析视频、不写入报告。");
    const preview = await postJSON("/model-api/media/faces/track", previewPayload);
    showMediaResult(preview);
    if (preview.status !== "dry_run" || !preview.would_execute) return;
    const method = preview.tool?.status === "degraded" ? "（当前将使用 OpenCV Haar 降级方案）" : "";
    if (!window.confirm(`确认追踪该视频中的人物脸部位置吗？${method}操作仅在本机执行，会写入 analysis/face_tracking/。`)) return;
    setStatus("neutral", "正在追踪人脸", "正在读取真实视频帧并生成 JSON 报告；完成后可打开报告查看详情。");
    const result = await postJSON("/model-api/media/faces/track", { ...previewPayload, dry_run: false, execute: true, confirm: true });
    showMediaResult(result);
  } catch (error) {
    showMediaResult({ status: "invalid_request", error: error.message });
    setStatus("error", "人脸追踪未执行", error.message);
  } finally {
    if (mediaFaceExecuteButton) mediaFaceExecuteButton.disabled = false;
  }
}

function referenceReviewPayload(projectId, execution = false) {
  const source = mediaReferencePath?.value.trim();
  if (!source) throw new Error("请先填写参考视频路径。");
  const maxKeyframes = Number(mediaReferenceMaxKeyframes?.value || 20);
  if (!Number.isFinite(maxKeyframes) || maxKeyframes < 1 || maxKeyframes > 50) {
    throw new Error("最多关键帧应在 1—50 之间。");
  }
  return {
    project_id: projectId,
    source,
    analysis_depth: mediaReferenceDepth?.value || "standard",
    max_keyframes: Math.round(maxKeyframes),
    dry_run: !execution,
    execute: execution,
    confirm: false,
  };
}

async function reviewReferenceMedia() {
  if (mediaReferenceButton) mediaReferenceButton.disabled = true;
  try {
    const projectId = requireMediaProject();
    const previewPayload = referenceReviewPayload(projectId, false);
    setStatus("neutral", "检查参考分析能力", "只检查本机文件、FFmpeg 和分析器，不提取关键帧、不写入项目。");
    const preview = await postJSON("/model-api/media/reference/review", previewPayload);
    showMediaResult(preview);
    if (preview.status !== "dry_run") return;
    if (!preview.would_execute) {
      setStatus("warn", "参考分析暂不可用", preview.analyzer?.install_instructions || preview.error || "请检查 ffmpeg、ffprobe 和本机 video_analyzer 依赖。");
      return;
    }
    const sourceName = preview.source?.project_path || preview.source?.name || "该视频";
    if (!window.confirm(`确认分析“${sourceName}”并提取关键帧吗？操作仅在本机执行，不会上传或产生模型费用。`)) return;
    setStatus("neutral", "正在分析参考视频", "正在检测场景、提取关键帧并写入研究工件；大视频可能需要一段时间。");
    const result = await postJSON("/model-api/media/reference/review", {
      ...previewPayload,
      dry_run: false,
      execute: true,
      confirm: true,
    });
    showMediaResult(result);
    if (result.status === "completed") {
      setStatus("ok", "参考视频分析完成", `已提取 ${result.keyframes?.length || 0} 个关键帧、识别 ${result.scene_count || 0} 个场景；结果已归档到当前项目。`);
    }
  } catch (error) {
    showMediaResult({ status: "invalid_request", error: error.message });
    setStatus("error", "参考分析未执行", error.message);
  } finally {
    if (mediaReferenceButton) mediaReferenceButton.disabled = false;
  }
}

async function openReferenceDirector() {
  try {
    const projectId = requireMediaProject();
    const host = document.getElementById("montageTools");
    if (!host?.prepareMontageDirector) throw new Error("导演面板尚未载入，请稍后重试。");
    const source = mediaReferencePath?.value.trim() || "";
    // An absolute desktop path is valid for the local analyzer, but never
    // passes to the model as permission to read outside its project.
    const projectRelative = source && !source.startsWith("/") && !source.includes("\\")
      && !source.split("/").includes("..") && !/^[a-z]+:/i.test(source) ? source : "";
    openWorkspaceFragment("mediaMontageCard");
    await host.prepareMontageDirector({execution_engine: "hypit", reference_path: projectRelative, pipeline: "cinematic"});
    if (mediaProject() !== projectId) return;
    host.scrollIntoView({behavior: "auto", block: "start"});
    if (source && !projectRelative) setStatus("neutral", "导入参考片后继续", "这条参考片在项目外。请在导演面板选择本地视频导入，再填写想怎样改编；不会自动提交制作。");
  } catch (error) { setStatus("warn", "暂未进入参考制作", error.message); }
}

let stockPlanRows = [];
let stockPlanSignature = "";
let stockPlanUseProposal = false;
let stockPendingAutomatic = null;
function prepareStockPlan(force = false) {
  if (!workflow.draftId || (mediaProject() && mediaProject() !== workflow.draftId)) return;
  const candidate = workflow.candidates.find(item => item.id === workflow.selectedCandidateId);
  if (!candidate && !workflow.storyboard?.shots?.length) return;
  const topic = workflow.draftPrompt || document.getElementById("prompt").value;
  const shots = stockPlanUseProposal ? [] : workflow.storyboard?.shots || [];
  const signature = JSON.stringify([workflow.draftId, workflow.selectedCandidateId, topic, shots]);
  if (!force && signature === stockPlanSignature) return;
  stockPlanSignature = signature;
  stockPlanRows = buildStockPlan(topic, candidate, shots);
  mediaStockQueries.value = stockPlanRows.map(row => row.query).join("\n");
  mediaStockSources.value = "";
  document.getElementById("stockPlanSummary").textContent = `已按当前${shots.length ? "分镜" : "方案"}整理 ${stockPlanRows.length} 个检索词：${stockPlanRows.map(row => row.query).join("、")}。英文画面词为通用补充素材，不能证明拍摄地点。`;
  document.getElementById("stockShotResults").replaceChildren();
}

function renderStockShotResults(data) {
  const target = document.getElementById("stockShotResults");
  target.replaceChildren();
  const shots = !stockPlanUseProposal && workflow.storyboard?.shots?.length ? workflow.storyboard.shots : [{id:"proposal", title:"选定方案"}];
  shots.forEach(shot => {
    const block = document.createElement("div"); block.className = "narration-import";
    const clips = (data.clips || []).filter(clip => (clip.shot_ids || []).includes(String(shot.id)));
    const title = document.createElement("p");
    title.textContent = `${shot.title || shot.id}：${clips.length ? `${clips.length} 个候选，待核对地点和画面` : "缺素材：可上传实拍或使用分镜图生成"}`;
    block.append(title);
    clips.forEach(clip => {
      const link = document.createElement("a"); link.href = mediaPathURL(clip.path); link.target = "_blank"; link.rel = "noopener";
      link.textContent = `预览 · ${clip.query || "候选"} · ${clip.source || ""}（待核验）`;
      block.append(link, document.createElement("br"));
    });
    target.append(block);
    const card = [...storyboardGrid.querySelectorAll(".storyboard-card")].find(card => card.dataset.shotId === String(shot.id));
    if (card) {
      card.querySelector(".stock-shot-status")?.remove();
      const status = block.cloneNode(true); status.classList.add("stock-shot-status"); card.append(status);
    }
  });
}

function mediaStockPayload(projectId, execution = false) {
  if (workflow.draftId && workflow.draftId !== projectId) throw new Error("正在载入当前项目方案，请稍后重试。");
  prepareStockPlan();
  const queries = mediaLines(mediaStockQueries);
  if (!queries.length) throw new Error("请先输入至少一个素材检索关键词，每行一个。 ");
  const clipsPerQuery = Number(mediaStockClips?.value || 3);
  if (!Number.isFinite(clipsPerQuery) || clipsPerQuery < 1 || clipsPerQuery > 20) {
    throw new Error("每个关键词的素材数量应在 1—20 之间。");
  }
  return {
    project_id: projectId,
    queries,
    query_shot_ids: queries.map(query => stockPlanRows.find(row => row.query === query)?.shot_ids || []),
    sources: mediaCsv(mediaStockSources).length ? mediaCsv(mediaStockSources) : null,
    kind: mediaStockKind?.value || "video",
    clips_per_query: Math.round(clipsPerQuery),
    orientation: mediaStockOrientation?.value || null,
    extract_thumbnails: true,
    timeout_seconds: 120,
    dry_run: !execution,
    execute: execution,
    confirm: execution,
  };
}

async function estimateStockMedia() {
  await runMediaAction(
    async (projectId) => postJSON("/model-api/media/stock/search", mediaStockPayload(projectId, false)),
    () => mediaStockPayload(mediaProject(), false),
  );
}

async function searchStockMedia({automatic = false} = {}) {
  if (mediaActionBusy) { if (automatic) stockPendingAutomatic = {project:mediaProject(), candidate:workflow.selectedCandidateId}; return; }
  prepareStockPlan();
  if (!automatic && !window.confirm("将按当前方案检索免费候选素材并下载到本机，不会调用付费模型。继续吗？")) return;
  const planKey = stockPlanSignature;
  const projectId = mediaProject();
  document.querySelectorAll(".stock-progress").forEach(el => { el.textContent = "正在按方案查找免费素材…"; });
  if (mediaStockSearchButton) mediaStockSearchButton.disabled = true;
  try {
    const result = await runMediaAction(
      async (projectId) => postJSON("/model-api/media/stock/search", mediaStockPayload(projectId, true)),
      () => mediaStockPayload(mediaProject(), true),
    );
    if (projectId !== mediaProject() || planKey !== stockPlanSignature) return;
    document.querySelectorAll(".stock-progress").forEach(el => { el.textContent = result?.message || result?.error || "检索未完成，请在素材工具中查看原因。"; });
    if (result) renderStockShotResults(result);
  } finally {
    if (mediaStockSearchButton) mediaStockSearchButton.disabled = false;
    const pending = stockPendingAutomatic;
    stockPendingAutomatic = null;
    if (pending?.project === mediaProject() && pending?.candidate === workflow.selectedCandidateId) void searchStockMedia({automatic:true});
  }
}

function mediaTrimPayload(projectId, execution = false) {
  const inputPath = mediaTrimInput?.value.trim();
  if (!inputPath) throw new Error("请先填写源视频路径。");
  const start = Number(mediaTrimStart?.value || 0);
  if (!Number.isFinite(start) || start < 0) throw new Error("起始秒数必须是大于等于 0 的数字。");
  const rawEnd = mediaTrimEnd?.value.trim();
  const end = rawEnd ? Number(rawEnd) : null;
  if (end !== null && (!Number.isFinite(end) || end <= start)) {
    throw new Error("结束秒数必须大于起始秒数，留空则裁到视频结尾。");
  }
  const outputName = mediaTrimOutput?.value.trim() || "segment-01.mp4";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(mp4|webm|mov|m4v)$/i.test(outputName)) {
    throw new Error("输出文件名须为安全的视频文件名（mp4/webm/mov/m4v）。");
  }
  return {
    project_id: projectId,
    input_path: inputPath,
    start_seconds: start,
    end_seconds: end,
    codec: mediaTrimCodec?.value || "libx264",
    output_name: outputName,
    dry_run: !execution,
    execute: execution,
  };
}

async function estimateTrimMedia() {
  await runMediaAction(
    async (projectId) => postJSON("/model-api/media/trim", mediaTrimPayload(projectId, false)),
    () => mediaTrimPayload(mediaProject(), false),
  );
}

async function executeTrimMedia() {
  if (mediaTrimExecuteButton) mediaTrimExecuteButton.disabled = true;
  try {
    const projectId = requireMediaProject();
    const previewPayload = mediaTrimPayload(projectId, false);
    setStatus("neutral", "检查裁剪计划", "读取源视频时长和 FFmpeg 能力，不写入文件。 ");
    const preview = await postJSON("/model-api/media/trim", previewPayload);
    showMediaResult(preview);
    if (preview.status !== "dry_run") return;
    if (!preview.would_execute) {
      setStatus("warn", "片段裁剪暂不可用", preview.error || "请检查 ffmpeg 和 ffprobe 是否已安装。");
      return;
    }
    if (!window.confirm(`确认把“${preview.input?.path || previewPayload.input_path}”裁剪为 ${preview.output?.path || "assets/trimmed/"} 吗？`)) return;
    setStatus("neutral", "裁剪片段中", "正在按入点/出点生成可复用视频片段……");
    const result = await postJSON("/model-api/media/trim", {
      ...previewPayload,
      dry_run: false,
      execute: true,
    });
    showMediaResult(result);
  } catch (error) {
    showMediaResult({ status: "invalid_request", error: error.message });
    setStatus("error", "片段裁剪未执行", error.message);
  } finally {
    if (mediaTrimExecuteButton) mediaTrimExecuteButton.disabled = false;
  }
}

function videoPostprocessNumber(element, fallback, label, { min = null, max = null, optional = false } = {}) {
  const raw = element?.value.trim();
  if (!raw && optional) return null;
  const value = raw ? Number(raw) : fallback;
  if (!Number.isFinite(value) || (min !== null && value < min) || (max !== null && value > max)) {
    throw new Error(`${label}数值不在允许范围内。`);
  }
  return value;
}

function videoPostprocessOutputName(operation, mode) {
  const fallback = operation === "scene_detect" || (operation === "silence_cut" && mode === "mark")
    ? (operation === "scene_detect" ? "scene-detection.json" : "silence-report.json")
    : operation === "auto_reframe" ? "openmontage-reframed.mp4"
      : operation === "color_grade" ? "openmontage-graded.mp4"
        : "openmontage-tight.mp4";
  const value = mediaPostprocessOutput?.value.trim() || fallback;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(mp4|mov|m4v|webm|mkv|json)$/i.test(value)) {
    throw new Error("输出文件名须为安全的视频或 JSON 报告文件名。 ");
  }
  const report = operation === "scene_detect" || (operation === "silence_cut" && mode === "mark");
  if (report && !/\.json$/i.test(value)) throw new Error("当前操作只生成 JSON 报告，输出文件名必须以 .json 结尾。 ");
  if (!report && !/\.(mp4|mov|m4v|webm|mkv)$/i.test(value)) throw new Error("当前视频后期操作的输出文件名必须是视频格式。 ");
  return value;
}

function videoPostprocessPayload(projectId, execution = false) {
  const operation = mediaPostprocessOperation?.value || "silence_cut";
  const mode = mediaPostprocessMode?.value || "remove";
  const inputPath = mediaPostprocessInput?.value.trim();
  if (!inputPath) throw new Error("请先填写要处理的视频路径。 ");
  const body = {
    project_id: projectId,
    operation,
    input_path: inputPath,
    output_name: videoPostprocessOutputName(operation, mode),
    mode,
    silence_threshold_db: videoPostprocessNumber(mediaPostprocessThreshold, -35, "静音阈值", { min: -90, max: -1 }),
    min_silence_duration: videoPostprocessNumber(mediaPostprocessMinSilence, 0.5, "最短停顿", { min: 0.1, max: 60 }),
    padding_seconds: videoPostprocessNumber(mediaPostprocessPadding, 0.08, "说话边缘保留", { min: 0, max: 10 }),
    silence_speed_factor: videoPostprocessNumber(mediaPostprocessSpeedFactor, 6, "停顿加速倍率", { min: 1.5, max: 100 }),
    target_aspect: mediaPostprocessAspect?.value || "portrait",
    profile: mediaPostprocessProfile?.value || "cinematic_warm",
    intensity: videoPostprocessNumber(mediaPostprocessIntensity, 0.85, "调色强度", { min: 0, max: 1 }),
    scene_method: mediaPostprocessSceneMethod?.value || "content",
    scene_threshold: videoPostprocessNumber(mediaPostprocessSceneThreshold, null, "场景检测阈值", { min: 0, optional: true }),
    min_scene_length_seconds: videoPostprocessNumber(mediaPostprocessSceneMinLength, 1, "最短镜头", { min: 0.1, max: 600 }),
    dry_run: !execution,
    execute: execution,
  };
  return body;
}

function syncVideoPostprocessFields() {
  const operation = mediaPostprocessOperation?.value || "silence_cut";
  const mode = mediaPostprocessMode?.value || "remove";
  const show = (id, visible) => {
    const element = document.getElementById(id);
    if (element) element.hidden = !visible;
  };
  const silence = operation === "silence_cut";
  show("mediaPostprocessModeField", silence);
  show("mediaPostprocessThresholdField", silence);
  show("mediaPostprocessMinSilenceField", silence);
  show("mediaPostprocessPaddingField", silence);
  show("mediaPostprocessSpeedField", silence && mode === "speed_up");
  show("mediaPostprocessAspectField", operation === "auto_reframe");
  show("mediaPostprocessProfileField", operation === "color_grade");
  show("mediaPostprocessIntensityField", operation === "color_grade");
  const scenes = operation === "scene_detect";
  show("mediaPostprocessSceneMethodField", scenes);
  show("mediaPostprocessSceneThresholdField", scenes);
  show("mediaPostprocessSceneMinLengthField", scenes);

  if (mediaPostprocessOutput) {
    const current = mediaPostprocessOutput.value.trim();
    const isReport = operation === "scene_detect" || (silence && mode === "mark");
    const looksLikeDefault = !current || /^(openmontage-(processed|tight|reframed|graded)|scene-detection|silence-report)\.(mp4|json)$/i.test(current);
    if (looksLikeDefault || (isReport && !/\.json$/i.test(current)) || (!isReport && /\.json$/i.test(current))) {
      mediaPostprocessOutput.value = isReport
        ? (operation === "scene_detect" ? "scene-detection.json" : "silence-report.json")
        : operation === "auto_reframe" ? "openmontage-reframed.mp4"
          : operation === "color_grade" ? "openmontage-graded.mp4" : "openmontage-tight.mp4";
    }
  }
}

async function estimateVideoPostprocess() {
  await runMediaAction(
    async (projectId) => postJSON("/model-api/media/video/postprocess", videoPostprocessPayload(projectId, false)),
    () => videoPostprocessPayload(mediaProject(), false),
  );
}

async function executeVideoPostprocess() {
  if (mediaPostprocessExecuteButton) mediaPostprocessExecuteButton.disabled = true;
  try {
    const projectId = requireMediaProject();
    const previewPayload = videoPostprocessPayload(projectId, false);
    setStatus("neutral", "检查视频后期计划", "正在读取视频元数据和本机工具能力；预检不会写入文件。 ");
    const preview = await postJSON("/model-api/media/video/postprocess", previewPayload);
    showMediaResult(preview);
    if (preview.status !== "dry_run") return;
    if (!preview.would_execute) {
      setStatus("warn", "视频后期暂不可用", preview.error || "请检查本机 FFmpeg 和 ffprobe。 ");
      return;
    }
    if (!window.confirm(`确认执行“${preview.operation_label || preview.operation}”并写入 ${preview.output?.path || "视频后期产物"} 吗？原视频不会被覆盖。`)) return;
    setStatus("neutral", "视频后期处理中", "正在执行 OpenMontage 本机工具；完成后会验证输出并刷新项目库。 ");
    const result = await postJSON("/model-api/media/video/postprocess", { ...previewPayload, dry_run: false, execute: true });
    showMediaResult(result);
  } catch (error) {
    showMediaResult({ status: "invalid_request", error: error.message });
    setStatus("error", "视频后期未执行", error.message);
  } finally {
    if (mediaPostprocessExecuteButton) mediaPostprocessExecuteButton.disabled = false;
  }
}

async function renderAudioMedia() {
  const provider = mediaAudioProvider?.value || "macos";
  const isLocal = ["macos", "piper"].includes(provider);
  const warning = provider === "piper"
    ? "将用已安装的离线音色生成旁白，免费并保存在当前项目。请保持模型硬盘连接。继续吗？"
    : isLocal
    ? "将使用本机 macOS Tingting 生成免费旁白草稿，并写入当前项目。它适合校准节奏，不等同于 ElevenLabs 的情感音色。继续吗？"
    : "将尝试调用已配置的云端 TTS 服务，可能产生费用。只有服务端密钥和明确授权都通过后才会生成；不会写入假音频。继续吗？";
  if (!window.confirm(warning)) {
    setMediaNarrationStatus("ready", "已取消生成旁白，未写入音频文件。需要时可以再次点击。 ");
    return;
  }
  setMediaNarrationStatus("working", "正在检查配音参数并生成旁白，请保持页面打开……");
  await runMediaAction(
    async (projectId) => postJSON("/model-api/media/audio/render", mediaAudioPayload(projectId, true)),
    () => mediaSegmentsPayload(),
  );
}

async function estimateImagesMedia() {
  await runMediaAction(
    async (projectId) => postJSON("/model-api/media/images/estimate", mediaImagePayload(projectId)),
    () => mediaImagePayload(mediaProject()),
  );
}

async function renderImagesMedia() {
  if (!window.confirm("将尝试调用已配置的生图服务并可能产生费用。未配置时不会写入假图。继续吗？")) return;
  await runMediaAction(
    async (projectId) => postJSON("/model-api/media/images/render", { ...mediaImagePayload(projectId), dry_run: false, execute: true, confirm: true }),
    () => mediaImagePayload(mediaProject()),
  );
}

async function composeMedia() {
  await runMediaAction(
    async (projectId) => postJSON("/model-api/media/compose", { project_id: projectId, clips: mediaClipPaths(), transition: mediaTransition.value, transition_duration: 0.5, auto_normalize: true, audio_path: mediaAudioPath.value.trim() || null, subtitle_path: mediaSubtitlePath.value.trim() || null, output_name: mediaOutputName.value.trim() || "openmontage-compose.mp4", dry_run: false, execute: true }),
    () => mediaClipPaths(),
  );
}

function mediaStillPaths() {
  const paths = mediaLines(mediaStillImages);
  if (!paths.length) throw new Error("请先输入至少一张分镜图路径。");
  return paths;
}

async function composeStillMedia() {
  await runMediaAction(
    async (projectId) => postJSON("/model-api/media/stills/compose", {
      project_id: projectId,
      images: mediaStillPaths(),
      default_duration_seconds: Number(mediaStillDuration?.value || 5),
      transition: mediaStillTransition?.value || "crossfade",
      transition_duration: 0.5,
      audio_path: mediaAudioPath?.value.trim() || null,
      subtitle_path: mediaSubtitlePath?.value.trim() || null,
      output_name: mediaStillOutputName?.value.trim() || "openmontage-stills-compose.mp4",
      width: 720,
      height: 1280,
      fps: 24,
      dry_run: false,
      execute: true,
    }),
    () => mediaStillPaths(),
  );
}

function qualityMediaPaths() {
  const explicit = mediaLines(document.getElementById("mediaQualityPaths"));
  const paths = explicit.length ? explicit : [mediaPublishVideo?.value.trim()].filter(Boolean);
  if (!paths.length) throw new Error("请先合成视频，或填写待检查视频的项目内路径。");
  if (mediaQualitySubtitles?.checked !== false) {
    const subtitlePath = mediaSubtitlePath?.value.trim();
    if (subtitlePath) paths.push(subtitlePath);
    else if (!paths.some(path => /\.(srt|vtt|ass|ssa|ttml|dfxp)$/i.test(path))) {
      throw new Error("已勾选检查字幕，请先在后期制作中选择字幕文件；无字幕成片可取消勾选。此项检查字幕文件，不能识别已烧录在画面里的文字。");
    }
  }
  return [...new Set(paths)];
}

async function qualityMedia() {
  await runMediaAction(
    async (projectId) => postJSON("/model-api/media/quality", {
      project_id: projectId, media_paths: qualityMediaPaths(),
      sample_frames: Math.max(0, Math.min(12, Number(mediaQualityFrames?.value || 4))),
      check_audio: mediaQualityAudio?.checked !== false,
      check_black_frames: mediaQualityBlack?.checked !== false,
      check_subtitles: mediaQualitySubtitles?.checked !== false, execute: true,
    }),
    qualityMediaPaths,
  );
}

function mediaPublishPayload(projectId, execution = false) {
  const videoPath = mediaPublishVideo?.value.trim();
  const title = mediaPublishTitle?.value.trim();
  if (!videoPath) throw new Error("请先填写交付视频路径，或先完成本机合成。");
  if (!title) throw new Error("请先填写交付标题。");
  return {
    project_id: projectId,
    video_path: videoPath,
    title,
    description: mediaPublishDescription?.value.trim() || "",
    tags: mediaCsv(mediaPublishTags),
    hashtags: mediaCsv(mediaPublishHashtags),
    platform: mediaPublishPlatform?.value || "local",
    visibility: "private",
    subtitles_path: mediaSubtitlePath?.value.trim() || null,
    dry_run: !execution,
    execute: execution,
    confirm: false,
  };
}

async function publishMedia() {
  if (!window.confirm("只会在本机项目内生成 exports/ 交付文件夹，不会上传或产生模型费用。继续吗？")) return;
  await runMediaAction(
    async (projectId) => postJSON("/model-api/media/publish", {
      ...mediaPublishPayload(projectId, true),
      dry_run: false,
      execute: true,
      confirm: true,
    }),
    () => mediaPublishPayload(mediaProject(), false),
  );
}

function renderCandidate(candidate) {
  const selected = workflow.selectedCandidateId === candidate.id;
  const auto = workflow.mode === "speed" && selected;
  const priority = candidate.scorecard?.priority?.total ?? "—";
  const official = candidate.scorecard?.official?.weighted_total ?? "—";
  const card = document.createElement("article");
  card.className = `candidate-card${selected ? " selected" : ""}${auto ? " auto" : ""}`;
  const classLine = document.createElement("span"); classLine.className = "candidate-class"; classLine.textContent = `${candidate.class_label || candidate.candidate_class || "创意方案"}${auto ? " · 系统已选" : ""}`; card.append(classLine);
  const title = document.createElement("h4"); title.textContent = candidate.title || "未命名方案"; card.append(title);
  const concept = document.createElement("p"); concept.textContent = candidate.concept || candidate.hook || ""; card.append(concept);
  const motif = document.createElement("p"); motif.textContent = `视觉母题：${candidate.signature_motif || "—"}`; card.append(motif);
  const transition = document.createElement("p"); transition.textContent = `转场：${candidate.transition_strategy || "—"}`; card.append(transition);
  const facts = document.createElement("div"); facts.className = "candidate-facts";
  facts.innerHTML = `<div class="candidate-fact"><span>镜头数</span><b>${candidate.proposed_shot_count || 0}</b></div><div class="candidate-fact"><span>官方权重预评估</span><b>${official}</b></div><div class="candidate-fact"><span>原创/风格/传播</span><b>${priority}</b></div><div class="candidate-fact"><span>事实状态</span><b>${candidate.fact_status === "needs_research" ? "待核验" : "已核验"}</b></div>`;
  card.append(facts);
  if (workflow.mode === "quality") {
    const button = document.createElement("button");
    button.className = selected ? "secondary" : "primary";
    button.type = "button";
    button.textContent = selected ? "已选择此方案" : "选择此方案";
    button.onclick = () => selectCandidate(candidate.id);
    card.append(button);
  } else if (auto) {
    const note = document.createElement("p"); note.className = "microcopy"; note.textContent = "速度优先：自动选优，不需要手动点击。"; card.append(note);
  }
  return card;
}

function renderCandidates() {
  candidateGrid.innerHTML = "";
  workflow.candidates.forEach((candidate) => candidateGrid.append(renderCandidate(candidate)));
  const hasSelection = Boolean(workflow.selectedCandidateId);
  if (creativeModeBadge) {
    creativeModeBadge.className = `workflow-badge${hasSelection ? " ok" : ""}`;
    creativeModeBadge.textContent = workflow.mode === "speed"
      ? (hasSelection ? "已自动选优" : "等待自动评分")
      : (hasSelection ? "已选择方案" : "等待创作者选择");
  }
  // Rendering candidates is also used while restoring a later-stage project.
  // Do not let that paint pass overwrite the durable storyboard/video/review
  // stage with stage 0; only the initial candidates gate needs this sync.
  if (workflow.mode === "quality" && workflow.stage === 0) setQualityStage(0);
  continueStoryboard.disabled = !workflow.selectedCandidateId;
}

function selectCandidate(candidateId) {
  stockPlanUseProposal = true;
  stockPlanSignature = "";
  workflow.selectedCandidateId = candidateId;
  renderCandidates();
  syncReceiptVisibility();
  const selected = workflow.candidates.find((candidate) => candidate.id === candidateId);
  creativeStatus.textContent = `已选择“${selected?.title || candidateId}”。确认后进入分镜；你仍可返回重新选择。`;
  void persistWorkflowDraft("candidates").then(() => {
    if (workflow.selectedCandidateId !== candidateId) return;
    showMediaPanel(workflow.draftId);
    prepareStockPlan(true);
    void searchStockMedia({automatic:true});
  }).catch((error) => {
    if (workflowProjectStatus) workflowProjectStatus.textContent = `方案已选，但项目草案保存失败：${error.message}`;
  });
  setStatus("ok", "方案已选择", "下一步会生成分镜草案，不会立即扣费。 ");
}

async function runCandidates() {
  if (!lastEstimate?.valid || lastEstimate.within_max_cost !== true) return;
  generateCandidates.disabled = true;
  setWorkflowStep(1);
  setStatus("neutral", "创意方案生成中", "正在生成三套差异化方案、系统预评分和事实核验待办；这一步免费。 ");
  try {
    const data = await postJSON("/model-api/workflow/candidates", { prompt: modelPayload().prompt, mode: workflow.mode });
    workflow.candidates = data.candidates || [];
    workflow.selectedCandidateId = data.selected_candidate_id || null;
    creativeModeBadge.className = "workflow-badge ok";
    creativeModeBadge.textContent = workflow.mode === "quality" ? "等待创作者选择" : "已自动选优";
    creativeStatus.textContent = data.selection_reason || "三案已就绪。";
    const checks = data.research?.checks || [];
    factGateBadge.textContent = data.research?.status === "needs_sources" ? "待补来源" : "已核验";
    factGateText.textContent = data.research?.note || factGateText.textContent;
    factChecklist.innerHTML = "";
    checks.forEach((check) => {
      const item = document.createElement("span");
      item.className = `fact-check${check.status === "safe_by_default" ? " safe" : ""}`;
      item.textContent = `${check.status === "safe_by_default" ? "✓" : "!"} ${check.label}`;
      factChecklist.append(item);
    });
    renderCandidates();
    await persistWorkflowDraft("candidates");
    if (workflow.mode === "speed" && workflow.selectedCandidateId) await runStoryboard();
    else {
      setQualityStage(0);
      setStatus("ok", "三案已就绪", "质量优先：请比较三套方案后选择一套，再进入分镜阶段。 ");
    }
  } catch (error) {
    setStatus("error", "三案生成失败", error.message);
    generateCandidates.disabled = false;
  }
}

function renderStoryboardImageSlot(imageSlot, shot) {
  imageSlot.innerHTML = "";
  const imagePath = shot.image_path || shot.image_url || shot.frame_path || shot.preview_path;
  if (!imagePath) {
    const placeholder = document.createElement("span");
    placeholder.className = "storyboard-image-placeholder";
    placeholder.textContent = "尚未生成分镜图";
    imageSlot.append(placeholder);
    return;
  }
  const image = document.createElement("img");
  const imageUrl = workflowMediaPathURL(imagePath);
  const cacheKey = shot.image_sha256 || shot.image_revision || Date.now();
  image.src = `${imageUrl}${imageUrl.includes("?") ? "&" : "?"}v=${encodeURIComponent(cacheKey)}`;
  image.alt = `${shot.title || "分镜"}预览图`;
  // Generated frames must be visible as soon as their durable progress
  // arrives.  Lazy loading can defer off-screen cards and make a successful
  // frame look missing during the review step.
  image.loading = "eager";
  image.onerror = () => {
    imageSlot.innerHTML = "";
    const fallback = document.createElement("span");
    fallback.className = "storyboard-image-placeholder";
    fallback.textContent = "图片路径无法读取，请检查本机项目产物";
    imageSlot.append(fallback);
  };
  imageSlot.append(image);
}

function renderStoryboard() {
  const storyboard = workflow.storyboard;
  if (storyboardModeBadge && storyboard?.shots?.length) storyboardModeBadge.textContent = workflow.storyboardApproved ? "分镜已确认" : `${storyboard.shots.length} 个镜头 · 待确认`;
  storyboardGrid.innerHTML = "";
  (storyboard?.shots || []).forEach((shot, index) => {
    const card = document.createElement("article"); card.className = "storyboard-card";
    card.dataset.shotId = String(shot.id || `shot-${String(index + 1).padStart(2, "0")}`);
    const head = document.createElement("div"); head.className = "storyboard-card-head";
    const title = document.createElement("h4"); title.textContent = `${String(index + 1).padStart(2, "0")} · ${shot.title || "分镜"}`; head.append(title);
    const duration = document.createElement("span"); duration.className = "storyboard-duration"; duration.textContent = `${shot.duration_seconds || 5} 秒`; head.append(duration); card.append(head);
    const purpose = document.createElement("p"); purpose.textContent = shot.purpose || ""; card.append(purpose);
    const imageSlot = document.createElement("div"); imageSlot.className = "storyboard-image-slot";
    renderStoryboardImageSlot(imageSlot, shot);
    card.append(imageSlot);
    const details = document.createElement("details"); details.className = "storyboard-details";
    const summary = document.createElement("summary"); summary.textContent = "查看镜头细节与修改"; details.append(summary);
    const visual = document.createElement("div"); visual.className = "prompt-line"; visual.append(document.createElement("b")); visual.firstChild.textContent = "画面："; visual.append(document.createTextNode(shot.visual_prompt || "")); details.append(visual);
    const motion = document.createElement("div"); motion.className = "prompt-line"; motion.append(document.createElement("b")); motion.firstChild.textContent = "运镜："; motion.append(document.createTextNode(shot.motion_prompt || "")); details.append(motion);
    const continuity = document.createElement("p"); continuity.textContent = `首帧：${shot.first_frame_contract || "—"} 尾帧：${shot.last_frame_contract || "—"}`; details.append(continuity);
    const repair = document.createElement("div"); repair.className = "storyboard-repair";
    const repairLabel = document.createElement("label"); repairLabel.textContent = "发现问题？写下本镜修改意见";
    const repairInput = document.createElement("textarea"); repairInput.rows = 2; repairInput.className = "storyboard-repair-input"; repairInput.placeholder = "例如：人物缩小为画面高度三分之一，突出湖面细节，保持尾帧向右运动。";
    repairLabel.append(repairInput); repair.append(repairLabel);
    const repairActions = document.createElement("div"); repairActions.className = "storyboard-repair-actions";
    const revision = document.createElement("span"); revision.className = "storyboard-revision"; revision.textContent = shot.revision ? `已返修 ${shot.revision} 次` : "尚未返修";
    const repairButton = document.createElement("button"); repairButton.type = "button"; repairButton.className = "secondary compact"; repairButton.textContent = "保存本镜修改";
    repairButton.onclick = async () => {
      const note = repairInput.value.trim();
      if (!note) { setStatus("warn", "请填写修改意见", "每次返修至少写明一个画面、比例、运镜或连续性问题。"); repairInput.focus(); return; }
      repairButton.disabled = true;
      try {
        await repairStoryboardShot(shot.id, note);
        repairInput.value = "";
      } catch (error) {
        setStatus("error", "分镜返修失败", error.message);
      } finally {
        repairButton.disabled = false;
      }
    };
    repairActions.append(revision, repairButton); repair.append(repairActions); details.append(repair); card.append(details);
    storyboardGrid.append(card);
  });
}

async function runStoryboardImages() {
  if (workflow.mode !== "quality" || !workflow.storyboard?.shots?.length) {
    setStatus("warn", "尚未到分镜图阶段", "请先生成并检查分镜提示词。");
    return;
  }
  if (!workflow.draftId) {
    try {
      await persistWorkflowDraft("storyboard");
    } catch (error) {
      setStatus("error", "项目草案保存失败", `分镜图生成前无法绑定本机项目：${error.message}`);
      return;
    }
  }
  const aspect = qualityVideoAspect?.value || document.getElementById("aspectRatio")?.value || "9:16";
  const resolution = qualityVideoResolution?.value || document.getElementById("resolution")?.value || "480p";
  const shots = workflow.storyboard.shots.map((shot, index) => ({
    id: shot.id || `shot-${String(index + 1).padStart(2, "0")}`,
    prompt: buildStoryboardImagePrompt(shot),
    aspect_ratio: aspect,
    resolution,
  }));
  if (generateStoryboardImages) generateStoryboardImages.disabled = true;
  if (storyboardImageBadge) storyboardImageBadge.textContent = "检查生图能力";
  if (storyboardImageStatus) storyboardImageStatus.textContent = "正在免费检查图片模型与当前分镜参数，不会写入图片。";
  setStatus("neutral", "分镜图能力检查中", "正在执行图片 provider dry-run；通过后会再次征得你的确认才生成图片。");
  const base = {
    project_id: workflow.draftId,
    shots,
    preferred_provider: "auto",
  };
  try {
    const preview = await postJSON("/model-api/workflow/storyboard/images", {
      ...base,
      dry_run: true,
      execute: false,
      confirm: false,
    });
    if (preview.status !== "available") {
      const reason = preview.error || "当前没有可用的图片生成 provider；未写入任何图片。";
      throw new Error(reason);
    }
    if (!window.confirm("图片模型检查通过。继续生成分镜图可能产生模型费用，且会写入当前独立项目。确定继续吗？")) {
      stopStoryboardImageHeartbeat();
      if (storyboardImageBadge) storyboardImageBadge.textContent = "等待确认";
      if (storyboardImageStatus) storyboardImageStatus.textContent = "已取消本次生图；确认后仍可重新生成。";
      setStatus("warn", "已取消分镜图生成", "没有调用图片生成模型，也没有写入图片。 ");
      return;
    }
    if (storyboardImageBadge) storyboardImageBadge.textContent = "生成中";
    if (storyboardImageStatus) storyboardImageStatus.textContent = "图片生成中；完成后会把每张图片回填到对应分镜卡片。";
    startStoryboardImageHeartbeat(shots.length);
    setStatus("neutral", "分镜图生成中", "正在按镜头逐张生成并保存本机图片，请不要重复点击。 ");
    const accepted = await postJSON("/model-api/workflow/storyboard/images", {
      ...base,
      dry_run: false,
      execute: true,
      confirm: true,
      background: true,
    });
    if (accepted.status === "authorization_required") {
      throw new Error("服务端没有加载图片生成授权；请用本机工作台启动脚本重启后再试，本次没有写入图片。");
    }
    const result = accepted.status === "completed"
      ? (accepted.result || accepted)
      : await waitForStoryboardImageJob(workflow.draftId, shots.length, accepted);
    // Apply both final and partial receipts before validating the gate.  The
    // polling loop has already painted earlier shots; this also handles a
    // fast provider that returns a completed receipt in the first response.
    applyStoryboardImageProgress(result);
    if (result.status !== "completed" || !Array.isArray(result.images) || result.images.length !== shots.length) {
      const written = Number(result.images_written?.length || result.completed_shots || 0);
      throw new Error(result.error || `图片生成未完成，已写入 ${written}/${shots.length} 张，未通过全部分镜图回填检查。`);
    }
    const byShot = new Map(result.images.map((image) => [String(image.shot_id), image]));
    workflow.storyboard.shots.forEach((shot, index) => {
      const image = byShot.get(String(shot.id)) || result.images[index];
      if (!image?.path) return;
      shot.image_path = image.path;
      shot.image_sha256 = image.sha256 || null;
      shot.image_provider = image.provider || null;
      shot.image_model = image.model || null;
    });
    workflow.imageGenerationReceipt = result;
    renderStoryboard();
    syncStoryboardImageGate("分镜图已全部回填。请逐张检查画面、人物比例和风格；确认无误后才能进入视频生成。");
    finishStoryboardImageHeartbeat(
      "done",
      "分镜图生成完成",
      `已回填 ${shots.length}/${shots.length} 张图片；现在逐张检查画面、人物比例和风格。`,
      shots.length,
    );
    try {
      await persistWorkflowDraft("storyboard");
    } catch (error) {
      if (workflowProjectStatus) workflowProjectStatus.textContent = `分镜图已生成，但项目草案保存失败：${error.message}`;
    }
    setStatus("ok", "分镜图已生成", "图片已显示在各分镜卡片中。请检查无误后点击“确认分镜，进入视频生成”。");
  } catch (error) {
    if (Array.isArray(error.imagesWritten) && error.imagesWritten.length) {
      applyStoryboardImageProgress({ images_written: error.imagesWritten });
    }
    workflow.storyboardImagesGenerated = false;
    if (storyboardImageBadge) storyboardImageBadge.textContent = "生成失败";
    if (storyboardImageStatus) storyboardImageStatus.textContent = error.message;
    if (storyboardImageHeartbeatStartedAt) {
      const completed = Number(error.completedShots ?? storyboardImageHeartbeatCompleted ?? 0);
      const total = Number(error.totalShots ?? storyboardImageHeartbeatTotal ?? 0);
      const count = total > 0 ? `已完成 ${completed}/${total} 张；` : "";
      finishStoryboardImageHeartbeat("failed", "分镜图生成未完成", `${count}${error.message}；本次未通过全部图片回填检查。`, completed);
    } else {
      stopStoryboardImageHeartbeat();
    }
    setStatus("error", "分镜图生成失败", error.message);
  } finally {
    if (generateStoryboardImages) generateStoryboardImages.disabled = false;
  }
}

async function repairStoryboardShot(shotId, instructions) {
  if (!workflow.selectedCandidateId || !workflow.storyboard) throw new Error("请先选择方案并生成分镜。");
  stopStoryboardImageHeartbeat();
  setStatus("neutral", "保存分镜返修", "正在更新本镜画面与运镜提示词，并保留相邻镜头的连续性契约……");
  const data = await postJSON("/model-api/workflow/storyboard/repair", {
    prompt: modelPayload().prompt,
    mode: workflow.mode,
    candidate_id: workflow.selectedCandidateId,
    shot_id: shotId,
    instructions,
    draft_id: workflow.draftId || sessionStorage.getItem("openmontage.workflow_draft_id") || null,
    storyboard: workflow.storyboard,
  });
  workflow.storyboard = data.storyboard;
  workflow.storyboardImagesGenerated = false;
  workflow.imageGenerationReceipt = null;
  workflow.storyboardApproved = false;
  renderStoryboard();
  syncStoryboardImageGate("分镜已返修，请重新生成分镜图并再次检查所有镜头。");
  try {
    await persistWorkflowDraft("storyboard");
  } catch (error) {
    if (workflowProjectStatus) workflowProjectStatus.textContent = `本镜已更新，但项目草案保存失败：${error.message}`;
  }
  storyboardStatus.textContent = data.message || "本镜已更新，请重新检查共享边界帧。";
  setStatus("ok", "分镜返修已保存", `镜头 ${shotId} 已更新；未调用付费模型。`);
  return data;
}

async function runStoryboard() {
  if (!workflow.selectedCandidateId) return;
  stopStoryboardImageHeartbeat();
  continueStoryboard.disabled = true;
  setStatus("neutral", "分镜规划中", "正在把选定方案拆成差异化镜头、运镜和共享边界帧；这一步免费。 ");
  try {
    workflow.storyboard = await postJSON("/model-api/workflow/storyboard", { prompt: modelPayload().prompt, mode: workflow.mode, candidate_id: workflow.selectedCandidateId });
    stockPlanUseProposal = false;
    storyboardSection.hidden = false;
    setModeFocus(workflow.mode, { scroll: workflow.mode === "quality" });
    storyboardModeBadge.className = workflow.mode === "speed" ? "workflow-badge ok" : "workflow-badge";
    storyboardModeBadge.textContent = workflow.mode === "speed" ? "自动接收" : "等待确认";
    storyboardStatus.textContent = workflow.storyboard.next_action || "请检查分镜内容。";
    renderStoryboard();
    workflow.storyboardImagesGenerated = false;
    workflow.imageGenerationReceipt = null;
    workflow.storyboardApproved = false;
    syncStoryboardImageGate();
    try {
      await persistWorkflowDraft("storyboard");
      showMediaPanel(workflow.draftId);
      prepareStockPlan(true);
      void searchStockMedia({automatic:true});
    } catch (error) {
      if (workflowProjectStatus) workflowProjectStatus.textContent = `分镜已生成，但项目草案保存失败：${error.message}`;
    }
    if (workflow.mode === "quality") setQualityStage(1);
    else setWorkflowStep(2);
    if (workflow.mode === "speed") {
      workflow.storyboardApproved = true;
      // Speed mode has no creator gate here: the service has already selected
      // the best proposal and accepted the generated storyboard. Keep the
      // shared button disabled so the two-column fast path cannot be mistaken
      // for the quality-review flow.
      approveStoryboard.disabled = true;
      approveStoryboard.hidden = true;
      approveStoryboard.textContent = "已自动确认，进入付费二次确认";
      syncPaidButtons();
      // Main workflow index 2 is “视频生成”;质检只有在任务完成后才进入。
      setWorkflowStep(2);
      void persistWorkflowDraft("storyboard").catch((error) => {
        if (workflowProjectStatus) workflowProjectStatus.textContent = `分镜已接收，但项目快照保存失败：${error.message}`;
      });
      setStatus("ok", "已自动进入视频阶段", "速度优先已完成三案选优与分镜规划；真正付费提交仍需一次明确确认。 ");
    } else {
      approveStoryboard.hidden = false;
      approveStoryboard.disabled = !workflow.storyboardImagesGenerated;
      setStatus("ok", "分镜提示词已生成", "质量优先：先检查并修改每个镜头，再点击“生成分镜图”；图片全部显示并确认后才能进入视频生成。 ");
    }
  } catch (error) {
    setStatus("error", "分镜生成失败", error.message);
    continueStoryboard.disabled = false;
  }
}

// A draft created by one of the three first-version entry pages is restored
// before the creator starts the free estimate, so the handoff is visible and
// the prompt/settings are not silently lost.
initEntryContext();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  refreshProjectBriefForEstimate();
  stopHeartbeat();
  preparePaid.disabled = true;
  setStatus("neutral", "估算中", "正在执行免费 dry-run，不会发送生成任务……");
  try {
    const data = await postJSON("/model-api/api/tasks/estimate", modelPayload());
    showEstimate(data);
  } catch (error) {
    lastEstimate = null;
    workflowPanel.hidden = true;
    exitModeFocus();
    setStatus("error", "估算失败", error.message);
  }
});

workflowMode.addEventListener("change", () => {
  workflow.mode = workflowMode.value;
  // The shared parameter form is still used by the speed path, while the
  // quality path owns its controls inside stage 3. Keep the generic paid
  // button and receipt aligned immediately when the creator switches modes,
  // even before a new estimate has been submitted.
  if (preparePaid) preparePaid.hidden = workflow.mode === "quality";
  workflowModeHint.textContent = workflow.mode === "quality"
    ? "质量优先会先展示三套差异化方案；你选定后再生成分镜，确认分镜后才进入付费视频任务。"
    : "速度优先会在服务端给三案评分，自动选择最高分方案并推进到分镜；付费模型仍保留二次确认。";
  if (lastEstimate) {
    resetWorkflow();
    setModeFocus(workflow.mode, { scroll: true });
    setStatus("neutral", "模式已切换", "请重新生成三案，避免把上一种模式的选择带入当前流程。 ");
  }
});

// Project-library links open the same workbench with a project id.  Restore
// the durable snapshot before considering a fresh entry auto-run; otherwise a
// return visit would show the empty input page (or submit duplicate planning
// calls) instead of continuing the interrupted stage.
const requestedProjectId = projectQueryId();
if (requestedProjectId) {
  void restoreProjectWorkflow(requestedProjectId).then((restored) => {
    if (!restored) return autoStartEntryWorkflow();
    return null;
  }).catch((error) => {
    setStatus("error", "项目恢复失败", error.message);
  });
} else {
  void autoStartEntryWorkflow();
}

qualityExitFocus?.addEventListener("click", showProjectRequest);
speedExitFocus?.addEventListener("click", showProjectRequest);
editProjectBrief?.addEventListener("click", showProjectRequest);
speedViewDetails?.addEventListener("click", () => {
  const details = !shell?.classList.contains("speed-details");
  setModeFocus("speed", { details, scroll: details });
});

generateCandidates.addEventListener("click", () => void runCandidates());
continueStoryboard.addEventListener("click", () => void runStoryboard());
generateStoryboardImages?.addEventListener("click", () => void runStoryboardImages());
qualityVideoEstimateButton?.addEventListener("click", () => void runQualityVideoEstimate());
[qualityVideoModel, qualityVideoOperation, qualityVideoDuration, qualityVideoResolution, qualityVideoAspect, qualityVideoMaxCost, qualityVideoAudio]
  .filter(Boolean)
  .forEach((control) => control.addEventListener("change", () => {
    if (workflow.mode !== "quality" || workflow.stage !== 2) return;
    invalidateQualityVideoEstimate();
    updateQualityVideoSummary();
  }));
approveStoryboard.addEventListener("click", () => {
  if (workflow.mode === "speed") return;
  if (!workflow.storyboardImagesGenerated) {
    setStatus("warn", "请先生成并确认分镜图", "分镜提示词可以先修改；点击“生成分镜图”并确认每张图显示无误后，才能进入视频生成。");
    return;
  }
  workflow.storyboardApproved = true;
  workflow.qualityVideoEstimateReady = false;
  workflow.qualityVideoEstimate = null;
  approveStoryboard.disabled = true;
  preparePaid.disabled = true;
  if (qualityPreparePaid) qualityPreparePaid.disabled = true;
  if (workflow.mode === "quality") {
    if (qualityVideoBadge) qualityVideoBadge.textContent = "已解锁";
    if (qualityVideoStatus) qualityVideoStatus.textContent = "分镜图已确认。请在本阶段选择视频模型、时长、清晰度和画幅，先免费估算，再进入二次付费确认。";
    updateQualityVideoSummary();
    setQualityStage(2);
    void persistWorkflowDraft("video").catch((error) => {
      if (workflowProjectStatus) workflowProjectStatus.textContent = `分镜已确认，但阶段快照保存失败：${error.message}`;
    });
  } else {
    // Speed mode is already auto-approved above; the next main step is the
    // video-generation stage (index 2). Quality mode uses its dedicated
    // stage controller and never reaches this branch.
    setWorkflowStep(2);
  }
  setStatus("ok", "分镜已确认", workflow.mode === "quality"
    ? "现在进入视频参数阶段。请先点击“免费估算本阶段”，通过后才会解锁二次付费确认。"
    : "现在可以进入付费二次确认；确认前不会创建视频任务。 ");
});

async function preparePaidFlow(triggerButton = preparePaid) {
  if (paidRequestBusy || PAID_ACTIVE.has(paidPhase)) return;
  if (!workflow.storyboardApproved) { setStatus("warn", "尚未确认分镜", "请先确认分镜图，再进入视频付费确认。"); return; }
  if (workflow.mode === "quality" && (!workflow.qualityVideoEstimateReady || workflow.stage !== 2)) { setStatus("warn", "请先完成视频参数估算", "先在视频参数阶段完成免费估算。"); return; }
  if (!lastEstimate?.valid || lastEstimate.within_max_cost !== true) { setStatus("warn", "当前参数未通过费用检查", "请先免费估算并确认费用在本次上限内。"); return; }
  if (workflow.mode === "quality") syncQualityVideoControls({ fromMain: false });
  const revision = ++paidRevision;
  paidRequestBusy = true; setPaidPhase("preparing");
  setStatus("neutral", "确认单准备中", "正在锁定已确认参数；仍然不会提交外部任务……");
  try {
    const data = await postJSON("/model-api/paid/prepare", paidPayload());
    if (revision !== paidRevision) return;
    if (!data.confirmation_id) throw new Error("服务未返回确认单，请重新估算。");
    pendingConfirmation = data.confirmation_id;
    confirmText.textContent = `本次预估 ¥${Number(data.estimated_cost_cny).toFixed(4)}，确认单约 ${Math.round(data.expires_in_seconds / 60)} 分钟后失效。只有点击“确认提交”后，服务端才会使用已配置授权调用 provider。`;
    setPaidPhase("confirming"); dialog.showModal();
    setStatus("warn", "等待确认", "确认单已准备；请在弹窗中明确决定是否提交。");
  } catch (error) {
    if (revision !== paidRevision) return;
    pendingConfirmation = null; setPaidPhase("failed"); setStatus("error", "确认单失败", error.message);
  } finally { if (revision === paidRevision) { paidRequestBusy = false; syncPaidButtons(); } }
}
preparePaid.addEventListener("click", () => void preparePaidFlow(preparePaid));
qualityPreparePaid?.addEventListener("click", () => void preparePaidFlow(qualityPreparePaid));
// A submission already sent cannot be cancelled by merely closing its dialog.
dialog?.addEventListener("cancel", event => { if (paidPhase === "submitting") event.preventDefault(); });
dialog?.addEventListener("close", () => {
  if (paidPhase === "confirming") {
    pendingConfirmation = null; setPaidPhase("idle");
    setStatus("neutral", "已取消确认", "没有提交 provider 任务。");
  }
  syncPaidButtons();
});
confirmForm.addEventListener("submit", async event => {
  if (event.submitter?.value !== "confirm") { if (paidPhase === "submitting") event.preventDefault(); return; }
  event.preventDefault();
  if (paidRequestBusy || paidPhase !== "confirming" || !pendingConfirmation) return;
  const revision = paidRevision, confirmation = pendingConfirmation, mode = workflow.mode;
  paidRequestBusy = true; setPaidPhase("submitting");
  window.WorkbenchInteractions?.setState(confirmSubmit,"submitting",{label:"正在提交"});
  setStatus("neutral", "提交中", "已收到明确确认；正在建立任务，请勿重复点击。");
  try {
    const data = await postJSON(mode === "quality" ? "/model-api/paid/submit-batch" : "/model-api/paid/submit", {confirmation_id:confirmation});
    if (revision !== paidRevision) return;
    if (!data.task_id && !data.task_ids?.length) throw new Error("提交回执缺少任务 ID，请先核对项目记录，避免重复提交。");
    pendingConfirmation = null; setPaidPhase("queued"); dialog.close();
    if (mode === "quality") { showBatchTask(data); setQualityStage(2); startBatchHeartbeat(data); }
    else { showTask(data); setWorkflowStep(2); startHeartbeat(data); }
    setStatus("neutral", "任务已建立", "服务已接受请求；页面会查询真实任务状态，尚未代表生成完成。");
  } catch (error) {
    if (revision !== paidRevision) return;
    pendingConfirmation = null; setPaidPhase("failed"); dialog.close();
    setStatus("error", "提交未确认", `${error.message}；重试前请先核对项目记录。`);
  } finally {
    if (revision === paidRevision) { paidRequestBusy = false; window.WorkbenchInteractions?.setState(confirmSubmit,"ready",{label:"确认提交"}); syncPaidButtons(); }
  }
});
queryTask.addEventListener("click", async () => {
  if (!currentTaskId || queryTask.disabled) return;
  queryTask.disabled = true;
  try { if (batchTaskIds.length > 1) await refreshBatch(false); else await refreshTask(false); }
  finally { queryTask.disabled = false; }
});
cancelTask.addEventListener("click", async () => {
  if (!currentTaskId || cancelTask.disabled || paidCancelPending) return;
  if (!window.confirm(batchTaskIds.length > 1 ? "这里只取消首个分镜任务，其余镜头继续。确定吗？" : "确定取消这个远程视频任务吗？")) return;
  const revision = paidRevision, task = currentTaskId;
  paidCancelPending = true; cancelTask.disabled = true; setPaidPhase("cancelling");
  window.WorkbenchInteractions?.setState(cancelTask,"cancelling");
  setStatus("neutral", "请求取消中", "正在发送取消请求；只有查询到终态才算已取消。");
  try {
    await postJSON("/model-api/paid/cancel", {task_id:task});
    if (revision !== paidRevision || task !== currentTaskId) return;
    setStatus("warn", "已请求取消", "仍在查询最终状态。取消请求被接受不等于任务已经停止。");
    if (batchTaskIds.length > 1) await refreshBatch(true); else await refreshTask(true);
  } catch (error) {
    if (revision !== paidRevision || task !== currentTaskId) return;
    paidCancelPending = false; setStatus("error", "取消请求未确认", error.message);
  } finally { if (revision === paidRevision) cancelTask.disabled = paidCancelPending || ["succeeded","failed","cancelled"].includes(paidPhase); }
});

refreshMediaCapabilitiesButton?.addEventListener("click", () => void refreshMediaCapabilities());
toggleAdvancedMediaButton?.addEventListener("click", () => {
  const expanded = toggleAdvancedMediaButton.getAttribute("aria-expanded") === "true";
  setAdvancedMediaExpanded(!expanded);
});
openmontageToolCatalogButton?.addEventListener("click", () => void loadOpenMontageToolCatalog());
openmontagePipelineCatalogButton?.addEventListener("click", () => void loadOpenMontagePipelineCatalog());
document.getElementById("mediaEstimateAudio")?.addEventListener("click", () => void estimateAudioMedia());
document.getElementById("mediaRenderSubtitles")?.addEventListener("click", () => void renderSubtitleMedia());
document.getElementById("mediaTranscribe")?.addEventListener("click", () => void transcribeMedia());
bindTranscriptReview();
mediaFrameEstimateButton?.addEventListener("click", () => void estimateFrameSampling());
mediaFrameExecuteButton?.addEventListener("click", () => void executeFrameSampling());
mediaFaceEstimateButton?.addEventListener("click", () => void estimateFaceTracking());
mediaFaceExecuteButton?.addEventListener("click", () => void executeFaceTracking());
mediaReferenceButton?.addEventListener("click", () => void reviewReferenceMedia());
document.getElementById("mediaReferenceHypit")?.addEventListener("click", () => void openReferenceDirector());
mediaStockEstimateButton?.addEventListener("click", () => void estimateStockMedia());
mediaStockSearchButton?.addEventListener("click", () => void searchStockMedia());
mediaTrimEstimateButton?.addEventListener("click", () => void estimateTrimMedia());
mediaTrimExecuteButton?.addEventListener("click", () => void executeTrimMedia());
mediaPostprocessEstimateButton?.addEventListener("click", () => void estimateVideoPostprocess());
mediaPostprocessExecuteButton?.addEventListener("click", () => void executeVideoPostprocess());
mediaPostprocessOperation?.addEventListener("change", () => syncVideoPostprocessFields());
mediaPostprocessMode?.addEventListener("change", () => syncVideoPostprocessFields());
mediaAudioMixEstimateButton?.addEventListener("click", () => void estimateAudioMixMedia());
mediaAudioMixExecuteButton?.addEventListener("click", () => void executeAudioMixMedia());
mediaAudioEnhanceExecuteButton?.addEventListener("click", () => void executeAudioEnhanceMedia());
mediaAudioOperation?.addEventListener("change", () => {
  if (!mediaAudioOutput) return;
  const current = mediaAudioOutput.value.trim();
  if (mediaAudioOperation.value === "segmented_music" && (!current || /\.(wav|mp3|m4a|aac|ogg|flac)$/i.test(current))) {
    mediaAudioOutput.value = "openmontage-with-bgm.mp4";
  } else if (mediaAudioOperation.value !== "segmented_music" && (!current || /\.(mp4|mov|m4v|webm|mkv)$/i.test(current))) {
    mediaAudioOutput.value = "openmontage-mix.wav";
  }
});
document.getElementById("mediaRenderAudio")?.addEventListener("click", () => void renderAudioMedia());
mediaMusicReadDurationButton?.addEventListener("click", () => void readMusicReferenceDuration());
let localBgmObjectURL = null;
document.getElementById("localBgmFile")?.addEventListener("change", event => {
  if (localBgmObjectURL) URL.revokeObjectURL(localBgmObjectURL);
  const file = event.target.files?.[0];
  const preview = document.getElementById("localBgmPreview");
  preview.hidden = !file;
  if (file) { localBgmObjectURL = URL.createObjectURL(file); preview.src = localBgmObjectURL; }
});
document.getElementById("localBgmReadDuration")?.addEventListener("click", async () => {
  const status = document.getElementById("localBgmStatus");
  const projectId = mediaProject();
  try {
    const reference = mediaMusicReferenceVideo.value.trim() || mediaPublishVideo.value.trim();
    if (!reference) throw new Error("当前项目尚未选择成片，请先完成画面合成，或手动填写配乐时长。");
    const result = await postJSON("/model-api/media/music/estimate", {...musicPayload(projectId), duration_seconds:null, reference_video_path:reference});
    if (mediaProject() !== projectId) return;
    if (!result.duration_seconds) throw new Error(result.error || "无法读取成片时长");
    document.getElementById("localBgmDuration").value = result.duration_seconds;
    status.textContent = `已读取成片时长：${result.duration_seconds} 秒。`;
  } catch (error) { if (mediaProject() === projectId) status.textContent = error.message; }
});
document.getElementById("localBgmImport")?.addEventListener("click", async () => {
  const button = document.getElementById("localBgmImport");
  const status = document.getElementById("localBgmStatus");
  const file = document.getElementById("localBgmFile").files?.[0];
  const projectId = mediaProject();
  if (!file || !projectId) { status.textContent = "请先载入项目并选择音乐文件。"; return; }
  if (file.size > 40 * 1024 * 1024) { status.textContent = "音乐文件超过 40 MB，请选择较小的音频。"; return; }
  const duration = Number(document.getElementById("localBgmDuration").value);
  if (!(duration >= 3 && duration <= 600)) { status.textContent = "配乐时长应为 3—600 秒。"; return; }
  button.disabled = true;
  status.textContent = "正在本机适配音乐时长…";
  try {
    const encoded = await new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = () => reject(new Error("无法读取音乐文件")); reader.readAsDataURL(file);
    });
    const result = await postJSON("/model-api/media/music/import", {project_id:projectId, filename:file.name, audio_base64:encoded, duration_seconds:duration, reference_video_path:mediaMusicReferenceVideo.value.trim() || null});
    if (mediaProject() !== projectId) return;
    if (result.status !== "completed") throw new Error(result.error || "本机配乐未完成");
    showMediaResult(result);
    status.textContent = "本机配乐已完成，已带入最终混音；请试听后合成。";
    if (result.reference?.path && mediaAudioVideo) mediaAudioVideo.value = result.reference.path;
    if (mediaAudioOperation) mediaAudioOperation.value = "full_mix";
    const preview = document.getElementById("localBgmPreview"); preview.src = mediaPathURL(result.music.path); preview.hidden = false;
    selectEditStep("mediaAudioMixCard");
  } catch (error) { if (mediaProject() === projectId) status.textContent = `配乐未完成：${error.message}`; }
  finally { button.disabled = false; }
});
mediaMusicEstimateButton?.addEventListener("click", () => void estimateMusicMedia());
mediaMusicExecuteButton?.addEventListener("click", () => void executeMusicMedia());
mediaMusicProvider?.addEventListener("change", () => {
  document.querySelectorAll("[data-local-music-option]").forEach(node => { node.hidden = mediaMusicProvider.value !== "local"; });
  updateMusicExecuteGate({status: "invalid_request"});
});
document.getElementById("mediaEstimateImages")?.addEventListener("click", () => void estimateImagesMedia());
document.getElementById("mediaRenderImages")?.addEventListener("click", () => void renderImagesMedia());
document.getElementById("mediaCompose")?.addEventListener("click", () => void composeMedia());
document.getElementById("mediaComposeStills")?.addEventListener("click", () => void composeStillMedia());
document.getElementById("mediaQuality")?.addEventListener("click", () => void qualityMedia());
document.getElementById("mediaPublish")?.addEventListener("click", () => void publishMedia());
workflowOpenMedia?.addEventListener("click", () => {
  const projectId = workflow.draftId || sessionStorage.getItem("openmontage.workflow_draft_id");
  if (!projectId) return;
  showMediaPanel(projectId, { loadState: true, open: true });
  mediaPipeline?.scrollIntoView({ behavior: "smooth", block: "start" });
});
qualityOpenMedia?.addEventListener("click", () => {
  const projectId = workflow.draftId || sessionStorage.getItem("openmontage.workflow_draft_id");
  if (!projectId) {
    setStatus("warn", "项目尚未保存", "先完成视频任务回执，系统才能打开对应的后期与质检证据。");
    return;
  }
  showMediaPanel(projectId, { loadState: true, open: true });
  mediaPipeline?.scrollIntoView({ behavior: "smooth", block: "start" });
});
document.getElementById("loadMediaProject")?.addEventListener("click", () => {
  const projectId = mediaProject();
  if (!projectId) {
    setStatus("warn", "请填写项目 ID", "输入项目库中的项目 ID 后再载入后期制作面板。");
    mediaProjectId?.focus();
    return;
  }
  showMediaPanel(projectId, { loadState: true });
  mediaPipeline?.scrollIntoView({ behavior: "smooth", block: "start" });
  setStatus("ok", "项目已载入", `后期制作面板已切换到项目 ${projectId}。`);
});

syncVideoPostprocessFields();
setAdvancedMediaExpanded(sessionStorage.getItem(ADVANCED_MEDIA_KEY) === "1", { persist: false });
mediaProjectId?.addEventListener("change", () => {
  invalidatePaidContext();
  const projectId = mediaProject();
  if (projectId) showMediaPanel(projectId, { loadState: true });
});

// Project names and asset pickers keep filesystem details out of the common path.
const workspaceProjectSelect = document.getElementById("workspaceProjectSelect");
function syncProjectSelection(projectId) {
  if (![...workspaceProjectSelect.options].some(option => option.value === projectId)) workspaceProjectSelect.add(new Option(projectId, projectId));
  workspaceProjectSelect.value = projectId;
  document.dispatchEvent(new CustomEvent("studio:project", { detail: { id: projectId } }));
}
async function loadWorkspaceProjects() {
  try {
    const projects = await getJSON("/api/projects");
    workspaceProjectSelect.replaceChildren(new Option("请选择项目", ""));
    for (const project of projects) {
      if (!project.project_id) continue;
      const id = String(project.project_id);
      const rawTitle = String(project.title || project.prompt || id).replace(/\s+/g, " ").trim();
      const shortTitle = rawTitle.length > 28 ? `${rawTitle.slice(0, 28)}…` : rawTitle;
      const option = new Option(shortTitle, id);
      option.title = `${rawTitle}（项目编号：${id}）`;
      workspaceProjectSelect.add(option);
    }
    if (mediaProject()) syncProjectSelection(mediaProject());
  } catch { workspaceProjectSelect.replaceChildren(new Option("项目列表暂时不可用，可按编号载入", "")); }
}
workspaceProjectSelect.addEventListener("change", () => {
  invalidatePaidContext();
  const projectId = workspaceProjectSelect.value;
  if (!projectId) return;
  workspaceNavigationRevision += 1;
  showMediaPanel(projectId, { loadState: true });
  const url = new URL(window.location.href); url.searchParams.set("project", projectId); url.searchParams.delete("stage"); url.searchParams.delete("resume_stage");
  window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  workflow.draftId = projectId; workflow.storyboard = null; workflow.storyboardApproved = false; workflow.candidates = [];
  void restoreProjectWorkflow(projectId, { preserveWorkspace: true }).catch(error => { mediaLoadStatus.textContent = `项目恢复失败：${error.message}`; });
});
let pickerProjectId = null;
const projectAssetPaths = new Set();
const assetPickers = [];
const pickerDefinitions = {
  localToolInput: "素材", mediaTranscriptPath: "要识别的音视频", mediaAnalysisPath: "要分析的视频",
  mediaAudioPath: "配音", mediaSubtitlePath: "字幕", mediaPublishVideo: "交付视频",
  mediaMusicReferenceVideo: "参考成片", mediaAudioPrimary: "主音频", mediaAudioSecondary: "背景音乐",
  mediaAudioVideo: "要混音的视频", mediaAudioEnhanceInput: "要清理的音频", mediaPostprocessInput: "待处理视频",
  mediaClips: "加入一个视频片段", mediaStillImages: "加入一张分镜图", mediaQualityPaths: "加入待检查视频",
};
for (const [id, label] of Object.entries(pickerDefinitions)) {
  const field = document.getElementById(id); const originalLabel = field?.closest("label");
  if (!originalLabel) continue;
  const wrapper = document.createElement("label"); wrapper.className = "asset-picker";
  wrapper.append(document.createTextNode(label));
  const select = document.createElement("select"); select.dataset.pickerTarget = id;
  select.add(new Option("载入项目后选择素材", "")); wrapper.append(select);
  const advanced = document.createElement("details"); advanced.className = "path-details";
  const summary = document.createElement("summary"); summary.textContent = field.tagName === "TEXTAREA" ? "查看清单 / 手动调整顺序" : "手动填写路径";
  advanced.append(summary);
  const fieldGroup = document.createElement("div"); fieldGroup.className = "asset-picker-group";
  if (originalLabel.dataset.localField) { fieldGroup.dataset.localField = originalLabel.dataset.localField; delete originalLabel.dataset.localField; }
  originalLabel.before(fieldGroup); fieldGroup.append(wrapper, advanced); advanced.append(originalLabel);
  select.addEventListener("change", () => {
    if (!select.value) return;
    if (field.tagName === "TEXTAREA") { const paths = mediaLines(field); if (!paths.includes(select.value)) paths.push(select.value); field.value = paths.join("\n"); }
    else field.value = select.value;
    field.dispatchEvent(new Event("input", { bubbles:true })); field.dispatchEvent(new Event("change", { bubbles:true }));
    saveNarrationDraft();
  });
  const selection = document.createElement("div"); selection.className = "selected-assets"; wrapper.after(selection);
  const renderSelected = () => {
    selection.replaceChildren();
    if (field.tagName !== "TEXTAREA") return;
    const paths = mediaLines(field);
    paths.forEach((path, index) => {
      const row = document.createElement("div"); row.className = "selected-asset-row";
      const name = document.createElement("span"); name.textContent = `${index + 1}. ${path.split("/").pop()}`; name.title = path; row.append(name);
      for (const [label, delta] of [["上移", -1], ["下移", 1], ["移出清单", 0]]) {
        const button = document.createElement("button"); button.type = "button"; button.textContent = label; button.className = "secondary compact";
        button.disabled = delta === -1 && index === 0 || delta === 1 && index === paths.length - 1;
        button.addEventListener("click", () => {
          if (!delta) paths.splice(index, 1);
          else [paths[index], paths[index + delta]] = [paths[index + delta], paths[index]];
          field.value = paths.join("\n"); field.dispatchEvent(new Event("input", {bubbles:true})); saveNarrationDraft();
        }); row.append(button);
      }
      selection.append(row);
    });
  };
  field.addEventListener("input", renderSelected);
  assetPickers.push({select, field, renderSelected});
}
function updateAssetPickers(data) {
  const projectId = mediaProject();
  if (pickerProjectId !== projectId) { projectAssetPaths.clear(); pickerProjectId = projectId; }
  const collect = value => {
    if (typeof value === "string" && /\.(mp4|mov|mkv|webm|mp3|wav|m4a|ogg|flac|png|jpe?g|webp|srt|vtt)$/i.test(value) && !/^(https?:|\/)/.test(value) && !value.split("/").includes("..")) projectAssetPaths.add(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") for (const item of Object.values(value)) collect(item);
  };
  collect(data);
  for (const {select, field, renderSelected} of assetPickers) {
    let pattern = /\.(mp4|mov|mkv|webm)$/i;
    if (field.id === "mediaSubtitlePath") pattern = /\.(srt|vtt)$/i;
    else if (field.id === "mediaStillImages" || (field.id === "localToolInput" && localToolOperation.value === "bg_remove")) pattern = /\.(png|jpe?g|webp)$/i;
    else if (["mediaAudioPath", "mediaAudioSecondary", "mediaAudioEnhanceInput"].includes(field.id)) pattern = /\.(mp3|wav|m4a|ogg|flac)$/i;
    else if (["mediaTranscriptPath", "mediaAudioPrimary"].includes(field.id)) pattern = /\.(mp4|mov|mkv|webm|mp3|wav|m4a|ogg|flac)$/i;
    const paths = [...projectAssetPaths].filter(path => pattern.test(path));
    select.replaceChildren(new Option(paths.length ? "选择项目中的素材…" : "暂无对应素材，可展开手动填写", ""));
    for (const path of paths) select.add(new Option(path.split("/").pop(), path));
    if (paths.includes(field.value)) select.value = field.value;
    else if (field.tagName !== "TEXTAREA" && field.value.trim()) {
      select.add(new Option(`已填写：${field.value.split("/").pop()}`, field.value)); select.value = field.value;
    }
    renderSelected();
  }
}
void loadWorkspaceProjects();

const localToolOperation = document.getElementById("localToolOperation");
const localToolExecute = document.getElementById("localToolExecute");
const localToolStatus = document.getElementById("localToolStatus");
let checkedLocalPayload = null;
function localToolPayload(projectId) {
  const operation = localToolOperation.value;
  const payload = { project_id: projectId, operation };
  if (["bg_remove", "eye_enhance"].includes(operation)) {
    payload.input_path = document.getElementById("localToolInput").value.trim();
    if (!payload.input_path) throw new Error("请填写当前项目内的素材路径。");
  }
  if (operation === "hyperframes_render") payload.workspace_path = document.getElementById("localToolWorkspace").value.trim();
  if (["manim_title", "manim_flow", "blender_title"].includes(operation)) {
    payload.title = document.getElementById("localToolTitle").value.trim();
    payload.subtitle = document.getElementById("localToolSubtitle").value.trim() || null;
  }
  if (operation === "manim_flow") payload.labels = mediaLines(document.getElementById("localToolLabels"));
  if (["manim_title", "manim_flow"].includes(operation)) {
    payload.duration_seconds = Number(document.getElementById("localToolDuration").value);
    const portrait = document.getElementById("localToolAspect").value === "portrait";
    payload.width = portrait ? 720 : 1280; payload.height = portrait ? 1280 : 720;
  }
  return payload;
}
function resetLocalToolCheck() {
  checkedLocalPayload = null;
  localToolExecute.disabled = true;
  localToolExecute.textContent = "检查通过后生成";
  localToolStatus.textContent = "内容已更新，请先检查素材与环境。";
}
function syncLocalToolFields() {
  const operation = localToolOperation.value;
  const visible = {
    input: ["bg_remove", "eye_enhance"].includes(operation),
    workspace: operation === "hyperframes_render",
    title: ["manim_title", "manim_flow", "blender_title"].includes(operation),
    flow: operation === "manim_flow",
    animation: ["manim_title", "manim_flow"].includes(operation),
  };
  document.querySelectorAll("[data-local-field]").forEach(field => { field.hidden = !visible[field.dataset.localField]; });
  document.getElementById("localToolInput").placeholder = operation === "eye_enhance" ? "assets/video/source.mp4" : "assets/images/source.png";
  resetLocalToolCheck();
}
document.querySelectorAll("#localToolsCard input, #localToolsCard textarea, #localToolsCard select").forEach(field => field.addEventListener("input", resetLocalToolCheck));
localToolOperation.addEventListener("change", () => { syncLocalToolFields(); updateAssetPickers({}); });
mediaProjectId?.addEventListener("input", resetLocalToolCheck);
document.getElementById("localToolPreflight").addEventListener("click", async () => {
  resetLocalToolCheck();
  let payload;
  const result = await runMediaAction(async projectId => {
    payload = localToolPayload(projectId);
    return postJSON("/model-api/media/local-tools/preflight", payload);
  }, projectId => localToolPayload(projectId));
  if (result?.status === "dry_run" && result.would_write && ["available", "degraded"].includes(result.tool?.status)) {
    checkedLocalPayload = JSON.stringify(payload);
    localToolExecute.disabled = false;
    localToolExecute.textContent = "生成并保存新文件（免费）";
    localToolStatus.textContent = `${result.tool.status === "degraded" ? "当前工具使用降级方案。" : "检查通过。"}点击生成后保存到项目；原素材保留。`;
  } else localToolStatus.textContent = result?.error || result?.message || "检查未通过，请核对项目和输入内容。";
});
localToolExecute.addEventListener("click", async () => {
  const result = await runMediaAction(async projectId => {
    const payload = localToolPayload(projectId);
    if (!checkedLocalPayload || checkedLocalPayload !== JSON.stringify(payload)) throw new Error("项目或参数已变化，请重新检查。");
    checkedLocalPayload = null;
    return postJSON("/model-api/media/local-tools/execute", { ...payload, dry_run: false, execute: true, confirm: true });
  }, projectId => localToolPayload(projectId));
  resetLocalToolCheck();
  localToolStatus.textContent = result?.status === "completed" ? `已完成：${result.output?.path || "请查看下方预览"}。再次生成前请重新检查。` : result?.error || "本次未完成，请查看操作反馈。";
});
syncLocalToolFields();

const editSteps = ["mediaNarrationCard", "mediaVoiceCard", "mediaSubtitleCard", "mediaVideoComposeCard", "mediaMusicCard", "mediaAudioMixCard"];
function selectEditStep(id, { scroll = true } = {}) {
  if (!editSteps.includes(id)) return;
  editStep = id; workspaceNavigationRevision += 1;
  const projectId = mediaProject();
  if (projectId) try { sessionStorage.setItem(`openmontage.edit_step.${projectId}`, id); } catch { /* Optional resume preference. */ }
  setWorkspaceView("edit");
  const url = new URL(window.location.href); url.hash = id;
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  if (scroll) document.getElementById(id)?.scrollIntoView({behavior:"auto", block:"start"});
  document.querySelectorAll(".media-recommended-path a").forEach(link => link.classList.toggle("selected", (window.WorkbenchInteractions?.groupFor(link.hash.slice(1)) || link.hash.slice(1)) === (window.WorkbenchInteractions?.groupFor(id) || id)));
}
document.querySelectorAll(".media-recommended-path a").forEach(link => link.addEventListener("click", event => {
  event.preventDefault(); selectEditStep(link.hash.slice(1), { scroll: false });
}));
const nextEditStep = {
  mediaNarrationCard:["mediaVoiceCard","选择旁白声音"], mediaVoiceCard:["mediaSubtitleCard","制作字幕"],
  mediaSubtitleCard:["mediaVideoComposeCard","剪辑与合成"], mediaVideoComposeCard:["mediaMusicCard","添加配乐（可选）"],
  mediaMusicCard:["mediaAudioMixCard","最终混音"], mediaAudioMixCard:[null,"检查成片与导出"],
};
editSteps.forEach(id => {
  const [next, label] = nextEditStep[id];
  const button = document.createElement("button"); button.type = "button"; button.className = "secondary next-workspace-step";
  button.textContent = `下一步：${label} →`;
  button.addEventListener("click", () => next ? selectEditStep(next) : setWorkspaceView("delivery"));
  document.getElementById(id).append(button);
});
const settingsDelivery = document.querySelector(".settings-navigation > [data-workspace-view]");
if (settingsDelivery) { settingsDelivery.disabled = false; settingsDelivery.addEventListener("click", () => navigateWorkspace("delivery")); }

// Build the tool picker from the real cards, preserving each existing control.
const workspaceToolSelect = document.getElementById("workspaceToolSelect");
document.getElementById("stockRebuildPlan")?.addEventListener("click", () => prepareStockPlan(true));
workspaceToolSelect.addEventListener("change", () => prepareStockPlan());
let stockOriginView = null;
document.querySelectorAll("[data-open-footage]").forEach(button => button.addEventListener("click", async () => {
  button.disabled = true;
  try {
    if (!workflow.draftId) await persistWorkflowDraft(workflow.storyboard ? "storyboard" : "candidates");
    if (!workflow.draftId) throw new Error("请先保存主题或选择一个项目。");
    window.location.href = `/footage?project=${encodeURIComponent(workflow.draftId)}`;
  } catch (error) {
    setStatus("error", "暂时无法打开素材成片", error.message);
  } finally { button.disabled = false; }
}));
document.querySelectorAll("[data-open-stock]").forEach(button => button.addEventListener("click", () => {
  stockOriginView = workspaceView;
  workspaceNavigationRevision += 1;
  const card = mediaStockQueries.closest("article");
  workspaceToolSelect.value = card.id;
  setWorkspaceView("tools");
  const projectId = workflow.draftId || mediaProjectId.value.trim();
  if (projectId) showMediaPanel(projectId, { loadState: true });
  prepareStockPlan();
  document.getElementById("stockReturn").hidden = false;
  card.scrollIntoView({ block: "start", behavior: "auto" });
}));
document.getElementById("stockReturn")?.addEventListener("click", () => {
  document.querySelector(`.workspace-nav [data-workspace-view="${stockOriginView || "storyboard"}"]`)?.click();
});
document.querySelectorAll("#mediaGrid > article").forEach((card, index) => {
  if (!card.id) card.id = `workspaceTool${index}`;
  const group = card.dataset.workspaceGroup || (card.id === "mediaPublishCard" ? "delivery"
    : ["mediaNarrationCard", "mediaAudioEnhanceCard", "mediaVideoComposeCard", "mediaMusicCard", "mediaAudioMixCard"].includes(card.id) ? "edit" : "tools");
  card.dataset.workspaceGroup = group;
  if (group === "tools") workspaceToolSelect.add(new Option(card.querySelector("h4")?.textContent || "素材工具", card.id));
});
workspaceToolSelect.addEventListener("change", syncWorkspaceView);

function openWorkspaceFragment(fragment) {
  let id;
  try { id = decodeURIComponent(String(fragment || "").replace(/^#/, "")); } catch { return false; }
  const card = document.getElementById(id);
  if (!id || !card?.dataset.workspaceGroup) return false;
  if (editSteps.includes(id) || id === "mediaAudioEnhanceCard") {
    selectEditStep(id === "mediaAudioEnhanceCard" ? "mediaVoiceCard" : id);
  } else if (card.dataset.workspaceGroup === "tools" && [...workspaceToolSelect.options].some(option => option.value === id)) {
    workspaceNavigationRevision += 1;
    workspaceToolSelect.value = id; setWorkspaceView("tools"); prepareStockPlan();
  } else if (card.dataset.workspaceGroup === "delivery") {
    workspaceNavigationRevision += 1; setWorkspaceView("delivery");
  } else return false;
  card.scrollIntoView({behavior:"auto", block:"start"});
  return true;
}

async function openTranscriptTool(correctText) {
  try {
    const result = currentTranscriptReview;
    if (!result || result.project_id !== mediaProject()) throw new Error("请先识别当前项目的字幕。");
    const host = document.getElementById("montageTools");
    if (!host?.prepareMontageTool) throw new Error("字幕导出工具尚未载入，请稍后重试。");
    let name, values;
    if (correctText) {
      const lines = document.getElementById("mediaTranscriptText").value.split(/\r?\n/).map(text => text.trim());
      if (lines.length !== result.segments.length || lines.some(text => !text)) throw new Error("请保持原有字幕段数，每行一段、不要留空；时间段会沿用原录音。");
      name = "transcript_aligner";
      values = {input_path: result.media_path, segments: result.segments.map((segment, index) => ({start: segment.start, end: segment.end, text: lines[index]}))};
    } else {
      const savedText = result.segments.map(segment => segment.text.replace(/\s*\n\s*/g, " ")).join("\n");
      if (document.getElementById("mediaTranscriptText").value.trim() !== savedText.trim()) throw new Error("还有未保存的文字校对；请先做精细定位，再用生成的新字幕导出高亮。");
      name = "remotion_caption_burn";
      values = {transcript_path: result.files.json.path};
      if (/\.(mp4|mov|webm|mkv)$/i.test(result.media_path)) values.input_path = result.media_path;
    }
    openWorkspaceFragment("mediaMontageCard");
    await host.prepareMontageTool(name, values);
    host.scrollIntoView({behavior: "auto", block: "start"});
  } catch (error) { setMediaNarrationStatus("warn", error.message); }
}
function showTranscriptReview(result, preserveDraft = false) {
  currentTranscriptReview = result;
  const input = document.getElementById("mediaTranscriptText");
  if (!preserveDraft || !input.value.trim()) input.value = result.segments.map(segment => segment.text.replace(/\s*\n\s*/g, " ")).join("\n");
  document.getElementById("mediaTranscriptReview").hidden = false;
}
async function restoreTranscriptReview(projectId, manifest) {
  if (mediaProject() !== projectId || currentTranscriptReview || manifest?.status !== "completed" || manifest.project_id !== projectId) return;
  const path = manifest.outputs?.json?.path;
  if (!path || path.startsWith("/") || path.split("/").includes("..")) return;
  try {
    const payload = await getJSON(`/media/${encodeURIComponent(projectId)}/${path.split("/").map(encodeURIComponent).join("/")}`);
    if (mediaProject() !== projectId || currentTranscriptReview || !payload.segments?.length) return;
    showTranscriptReview({project_id:projectId, media_path:manifest.source_media.path, segments:payload.segments,
      files:manifest.outputs, alignment:payload.alignment, duration_seconds:payload.duration_seconds}, true);
    setMediaNarrationStatus("ready", "已恢复已有字幕和你的文字草稿；请核对错字，修改后先做精细定位，再导出高亮视频。刷新没有重新识别录音。");
  } catch { /* Existing subtitle files remain downloadable; no inference retry. */ }
}
function bindTranscriptReview() {
  document.getElementById("mediaTranscriptCorrect")?.addEventListener("click", () => void openTranscriptTool(true));
  document.getElementById("mediaTranscriptAnimate")?.addEventListener("click", () => void openTranscriptTool(false));
  document.addEventListener("studio:project", () => {
    if (currentTranscriptReview?.project_id !== mediaProject()) {
      currentTranscriptReview = null;
      document.getElementById("mediaTranscriptReview").hidden = true;
    }
  });
}

// One visible workspace at a time. Restoring a project restores data only;
// it must never expose post-production beneath the storyboard again.
if (qualityReviewSection && mediaPipeline) mediaPipeline.insertBefore(qualityReviewSection, document.getElementById("mediaGrid"));
function navigateWorkspace(view, recordHistory = true) {
  if (!WORKSPACE_COPY[view]) return;
  const previousView = workspaceView;
  const previousURL = window.location.href;
  workspaceNavigationRevision += 1;
    const projectId = mediaProjectId?.value.trim() || workflow.draftId;
    if (view === "storyboard" && !workflow.storyboard?.shots?.length) {
      document.getElementById("workspaceHint").textContent = "请先在创意阶段确认方案，系统会为当前项目生成分镜。";
      return;
    }
    if (view === "video" && !workflow.storyboardApproved) {
      document.getElementById("workspaceHint").textContent = "请先检查并确认分镜图，再进入视频生成。";
      return;
    }
    if (["plan", "storyboard", "video"].includes(view)) {
      const url = new URL(window.location.href); url.searchParams.delete("workspace");
      window.history.replaceState(null, "", `${url.pathname}${url.search}`);
      if (view === "plan" && !workflow.draftId && !lastEstimate) exitModeFocus();
      else if (workflow.mode === "quality") setModeFocus("quality");
      setQualityStage(["plan", "storyboard", "video"].indexOf(view));
    } else {
      setWorkspaceView(view);
      if (projectId) showMediaPanel(projectId, { loadState: true });
    }
  if (recordHistory && workspaceView !== previousView) {
    const nextURL = window.location.href;
    window.history.replaceState({ studioStage: previousView }, "", previousURL);
    window.history.pushState({ studioStage: workspaceView }, "", nextURL);
  }
  document.querySelector(".workspace-context")?.scrollIntoView({ block: "start", behavior: "auto" });
}
document.querySelectorAll(".workspace-nav [data-workspace-view]").forEach(button => {
  button.disabled = false;
  button.addEventListener("click", () => navigateWorkspace(button.dataset.workspaceView));
});
window.addEventListener("popstate", event => {
  const id = new URLSearchParams(window.location.search).get("project");
  if (id && workflow.draftId && id !== workflow.draftId) { window.location.reload(); return; }
  if (event.state?.studioStage) navigateWorkspace(event.state.studioStage, false);
});
const syncPiperField = () => { document.getElementById("mediaPiperModelField").hidden = mediaAudioProvider?.value !== "piper"; };
mediaAudioProvider?.addEventListener("change", syncPiperField);
syncWorkspaceView();
syncPiperField();
const requestedWorkspaceView = new URLSearchParams(window.location.search).get("workspace");
if (["edit", "delivery", "tools"].includes(requestedWorkspaceView)) setWorkspaceView(requestedWorkspaceView);

// A refresh should not make a running provider task look like it disappeared.
const restoredTaskId = requestedProjectId ? null : sessionStorage.getItem("openmontage.task_id");
const restoredBatchId = requestedProjectId ? null : sessionStorage.getItem("openmontage.batch_id");
let restoredBatchTaskIds = [];
try { restoredBatchTaskIds = JSON.parse(sessionStorage.getItem("openmontage.batch_task_ids") || "[]"); } catch { restoredBatchTaskIds = []; }
if (restoredBatchId && Array.isArray(restoredBatchTaskIds) && restoredBatchTaskIds.length) {
  startBatchHeartbeat({ batch_id: restoredBatchId, task_id: restoredBatchTaskIds[0], task_ids: restoredBatchTaskIds, status: "restored" });
} else if (restoredTaskId) {
  taskActions.hidden = false;
  taskIdElement.textContent = restoredTaskId;
  projectLink.href = sessionStorage.getItem("openmontage.project_url") || "#";
  projectLink.hidden = projectLink.href === "#";
  startHeartbeat({ task_id: restoredTaskId, status: "restored" });
}

const queryMediaProjectId = new URLSearchParams(window.location.search).get("project");
const restoredMediaProjectId = queryMediaProjectId || sessionStorage.getItem("openmontage.media_project_id");
if (restoredMediaProjectId) {
  showMediaPanel(restoredMediaProjectId, { loadState: true });
}
// Resolve the actual card before scrolling, including when no project has
// been selected yet. A hidden card must never masquerade as an opened tool.
openWorkspaceFragment(window.location.hash);

setPaidPhase(paidPhase);
window.WorkbenchInteractions?.setState(confirmSubmit,"ready");
