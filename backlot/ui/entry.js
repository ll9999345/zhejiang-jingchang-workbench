const params = new URLSearchParams(window.location.search);
const validModes = new Set(["guided", "material", "storyboard"]);
const documentMode = document.body.dataset.entryMode;
const hasDirectMode = validModes.has(documentMode) || validModes.has(params.get("mode"));
let selectedMode = validModes.has(documentMode)
  ? documentMode
  : (validModes.has(params.get("mode")) ? params.get("mode") : "guided");

const modeStage = document.getElementById("modeStage");
const contentStage = document.getElementById("contentStage");
const cards = [...document.querySelectorAll(".mode-card")];
const entryForm = document.getElementById("entryForm");
const contentTitle = document.getElementById("contentTitle");
const contentEyebrow = document.getElementById("contentEyebrow");
const guidedPanel = document.getElementById("guidedPanel");
const materialPanel = document.getElementById("materialPanel");
const storyboardPanel = document.getElementById("storyboardPanel");
const entryMessage = document.getElementById("entryMessage");
const storyboardText = document.getElementById("storyboardText");
const storyboardPreview = document.getElementById("storyboardPreview");

function setStep(step) {
  document.querySelectorAll(".entry-step").forEach((item) => {
    item.classList.toggle("active", Number(item.dataset.step) <= step);
  });
}

function selectMode(mode) {
  selectedMode = validModes.has(mode) ? mode : "guided";
  cards.forEach((card) => { card.classList.toggle("active", card.dataset.mode === selectedMode); card.setAttribute("aria-pressed", String(card.dataset.mode === selectedMode)); });
}

function showContent() {
  const titles = { guided: "一句话导演", material: "长文与素材导入", storyboard: "分镜表接管" };
  const eyebrows = { guided: "GUIDED DIRECTOR", material: "MATERIAL INTAKE", storyboard: "STORYBOARD TAKEOVER" };
  contentTitle.textContent = titles[selectedMode];
  contentEyebrow.textContent = eyebrows[selectedMode];
  guidedPanel.hidden = selectedMode !== "guided";
  materialPanel.hidden = selectedMode !== "material";
  storyboardPanel.hidden = selectedMode !== "storyboard";
  // Only the active entry owns required fields. Hidden fields must not block
  // the native form submit for the other two production modes.
  document.getElementById("guidedPrompt").required = selectedMode === "guided";
  modeStage.hidden = false;
  contentStage.hidden = false;
  setStep(2);

}

function showModes() {
  modeStage.hidden = false;
  contentStage.hidden = true;
  setStep(1);
}

function compactText(value, limit = 2200) {
  const text = String(value || "").replace(/\u0000/g, "").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function updateFileList(input, target) {
  const names = [...(input.files || [])].map((file) => file.name);
  target.textContent = names.length ? `已选择：${names.join("、")}` : "尚未选择文件";
}

async function readTextFile(input, target) {
  const file = input.files?.[0];
  if (!file || !/\.txt$|\.csv$|\.tsv$/i.test(file.name)) return;
  try {
    const text = await file.text();
    target.value = text;
    if (target === storyboardText) updateStoryboardPreview();
  } catch {
    entryMessage.textContent = "文件读取失败，可以直接粘贴内容后继续。";
  }
}

function updateStoryboardPreview() {
  const source = storyboardText.value.trim();
  if (!source) {
    storyboardPreview.textContent = "等待导入或粘贴分镜表。";
    return;
  }
  const lines = source.split(/\r?\n/).filter((line) => line.trim()).slice(0, 8);
  storyboardPreview.textContent = `已读取 ${source.split(/\r?\n/).filter((line) => line.trim()).length} 行\n\n${lines.join("\n")}`;
}

cards.forEach((card) => card.addEventListener("click", () => { selectMode(card.dataset.mode); showContent(); }));
document.querySelectorAll("[data-prompt]").forEach(button => button.addEventListener("click", () => { document.getElementById("guidedPrompt").value = button.dataset.prompt; document.getElementById("guidedPrompt").focus(); }));
document.getElementById("changeMode").addEventListener("click", showModes);
document.getElementById("backToModes").addEventListener("click", showModes);
document.getElementById("materialFiles").addEventListener("change", (event) => {
  updateFileList(event.currentTarget, document.getElementById("materialFileList"));
  void readTextFile(event.currentTarget, document.getElementById("materialText"));
});
document.getElementById("storyboardFiles").addEventListener("change", (event) => {
  updateFileList(event.currentTarget, document.getElementById("storyboardFileList"));
  void readTextFile(event.currentTarget, storyboardText);
});
storyboardText.addEventListener("input", updateStoryboardPreview);

entryForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const materialText = document.getElementById("materialText").value.trim();
  const tableText = storyboardText.value.trim();
  const guidedPrompt = document.getElementById("guidedPrompt").value.trim();
  const fileInput = selectedMode === "material" ? document.getElementById("materialFiles") : document.getElementById("storyboardFiles");
  const fileNames = [...(fileInput?.files || [])].map((file) => file.name);
  if ((selectedMode === "guided" && guidedPrompt.length < 2) || (selectedMode === "material" && materialText.length < 2) || (selectedMode === "storyboard" && tableText.length < 2)) {
    entryMessage.textContent = "请先填写内容，或导入可读取的文本文件。";
    document.getElementById(selectedMode === "guided" ? "guidedPrompt" : selectedMode === "material" ? "materialText" : "storyboardText").focus();
    return;
  }
  let prompt = guidedPrompt;
  if (selectedMode === "material") {
    prompt = `根据导入素材制作浙江文旅短视频：${compactText(materialText || fileNames.join("、") || "待解析素材")}；默认以美景为主，补充动态运镜、信息密度和自然转场。`;
  } else if (selectedMode === "storyboard") {
    prompt = `接管以下浙江文旅分镜表，只补齐缺失的视觉重点、运镜、声音与质检，不擅自改变已确认镜头：${compactText(tableText || fileNames.join("、") || "待导入分镜表")}。`;
  }
  if (prompt.length < 2) {
    entryMessage.textContent = "请先填写一句话、素材内容或分镜表。";
    return;
  }
  const draft = {
    mode: selectedMode,
    prompt,
    sourceText: selectedMode === "material" ? compactText(materialText, 5000) : compactText(tableText, 5000),
    fileNames,
    settings: selectedMode === "guided" ? {
      contentType: document.getElementById("guidedType").value,
      workflowMode: document.getElementById("guidedWorkflow").value,
      aspectRatio: document.getElementById("guidedAspect").value,
      budget: document.getElementById("guidedBudget").value,
    } : {
      strategy: selectedMode === "material" ? document.getElementById("materialStrategy").value : document.getElementById("storyboardContinuity").value,
      scope: selectedMode === "storyboard" ? document.getElementById("storyboardScope").value : null,
    },
    createdAt: new Date().toISOString(),
  };
  // Carry the creator's explicit workflow choice into the director page. The
  // model page uses this view hint to open the matching focused workbench and
  // run the free handoff exactly once; material/storyboard entries keep their
  // existing manual planning path.
  try {
    sessionStorage.removeItem("openmontage.entry_auto_run");
    sessionStorage.setItem("openmontage.entry_draft", JSON.stringify(draft));
  } catch {
    entryMessage.textContent = "浏览器暂时不能保存草稿。内容仍在这里，请允许本站本地存储后重试。";
    return;
  }
  setStep(3);
  entryMessage.textContent = "已保存本机安全草案，正在进入导演规划页面。";
  const destination = new URL("/model", window.location.origin);
  destination.searchParams.set("entry", selectedMode);
  if (selectedMode === "guided") {
    destination.searchParams.set("view", draft.settings.workflowMode);
  }
  window.location.href = `${destination.pathname}${destination.search}`;
});

selectMode(selectedMode);
showContent();
