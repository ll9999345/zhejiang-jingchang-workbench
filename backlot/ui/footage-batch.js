/* Native project batches. Importing or checking a manifest never submits work. */
const BATCH_MAX_BYTES = 1024 * 1024;
const BATCH_ACTIVE = new Set(["queued", "running", "cancelling"]);
const BATCH_LABELS = {queued: "排队中", running: "处理中", cancelling: "正在取消", completed: "已完成", stage_completed: "本阶段已完成", failed: "失败", cancelled: "已取消", interrupted: "已中断", partial: "部分完成", needs_materials: "缺少素材", awaiting_review: "等待复核"};

function parseBatchManifest(source) {
  if (new TextEncoder().encode(source).length > BATCH_MAX_BYTES) throw new Error("批量清单不能超过 1 MiB。");
  const text = String(source).replace(/^\uFEFF/, "").trim();
  if (!text) throw new Error("请导入或填写批量清单。");
  let requests;
  if (text.startsWith("[")) {
    try { requests = JSON.parse(text); } catch (_) { throw new Error("JSON 数组格式不正确，请检查括号和逗号。"); }
  } else {
    requests = text.split(/\r?\n/).flatMap((line, index) => {
      if (!line.trim()) return [];
      try { return [JSON.parse(line)]; } catch (_) { throw new Error(`JSONL 第 ${index + 1} 行格式不正确。`); }
    });
  }
  if (!Array.isArray(requests) || requests.length < 1 || requests.length > 100) throw new Error("清单需要 1–100 条任务。");
  requests.forEach((request, index) => {
    if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error(`第 ${index + 1} 条任务必须是 JSON 对象。`);
  });
  return requests;
}

function batchCanSubmit({requests, checkedFingerprint, ready, confirmed, active}) {
  return Boolean(!active && ready && confirmed && checkedFingerprint && checkedFingerprint === JSON.stringify(requests));
}

function batchTemplate(request) {
  const item = JSON.parse(JSON.stringify(request));
  delete item.request_id;
  item.confirm_network = false;
  return JSON.stringify([item], null, 2);
}

async function initBatchUI({projectId, getCurrentRequest, onJob}) {
  const $ = id => document.getElementById(id);
  const controls = Object.fromEntries(["batchManifest", "batchPreflightButton", "batchPreflightResults", "batchConfirm", "batchSubmitButton", "batchCurrent", "batchCancelButton", "batchHistory", "exportBatchTemplateButton", "importBatchInput"].map(id => [id, $(id)]));
  let checkedFingerprint = "", ready = false, active = false, checking = false, current = null, requestId = "", pollToken = 0;
  const row = (parent, title, message, error = false) => {
    const item = document.createElement("div"); item.className = `batch-row${error ? " error" : ""}`;
    const heading = document.createElement("b"); heading.textContent = title; item.append(heading, document.createTextNode(message)); parent.append(item); return item;
  };
  const api = async (path, data) => {
    const response = await fetch(`/model-api/footage/batches${path}`, data === undefined ? {} : {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(data)});
    const value = await response.json();
    if (!response.ok) throw new Error(typeof value.detail === "string" ? value.detail : "批量请求未通过，请检查清单。");
    return value;
  };
  const query = owner => `?project_id=${encodeURIComponent(owner || projectId)}`;
  function update() {
    let requests = [];
    try { requests = parseBatchManifest(controls.batchManifest.value); } catch (_) { /* Keep execution disabled for invalid text. */ }
    controls.batchSubmitButton.disabled = !batchCanSubmit({requests, checkedFingerprint, ready, confirmed: controls.batchConfirm.checked, active});
    controls.batchPreflightButton.disabled = active || checking;
    controls.batchManifest.disabled = active;
    controls.importBatchInput.disabled = active;
    controls.batchCancelButton.hidden = !current || !BATCH_ACTIVE.has(current.status);
  }
  function invalidate() { ready = false; checkedFingerprint = ""; requestId = ""; controls.batchConfirm.checked = false; update(); }
  function displayPreflight(result) {
    controls.batchPreflightResults.replaceChildren();
    row(controls.batchPreflightResults, result.ready ? "全部检查通过" : "清单尚未通过", (result.errors || []).join("；") || "检查不会下载、配音或制作视频。", !result.ready);
    for (const item of result.items || []) row(controls.batchPreflightResults, `${Number(item.index) + 1}. ${item.topic || "未命名任务"} · ${item.project_id || "缺少项目"}`, item.ready ? `${item.network_required ? "需要联网，清单须明确 confirm_network: true。" : "本机任务。"}${item.plan?.stop_at ? ` 制作到：${item.plan.stop_at}。` : ""}` : (item.errors || []).join("；"), !item.ready);
  }
  function displayBatch(batch) {
    current = batch;
    controls.batchCurrent.replaceChildren();
    row(controls.batchCurrent, `${BATCH_LABELS[batch.status] || batch.status} · ${Math.round(Number(batch.progress) || 0)}%`, `${batch.message || ""} · 批次 ${batch.batch_id} · 记录归属 ${batch.project_id}`);
    for (const [index, item] of (batch.items || []).entries()) {
      const itemRow = row(controls.batchCurrent, `${Number(item.index ?? index) + 1}. ${item.topic || "任务"} · ${item.project_id || ""}`, `${BATCH_LABELS[item.status] || item.status || "等待执行"}${item.message || item.error ? ` · ${item.message || item.error}` : ""}`, ["failed", "interrupted"].includes(item.status));
      if (item.job_id) {
        const link = document.createElement("a"); link.className = "quiet-button"; link.href = `/footage?project=${encodeURIComponent(item.project_id || projectId)}`; link.textContent = "打开所属项目"; itemRow.append(link);
        if (item.project_id === projectId && onJob) {
          const view = document.createElement("button"); view.className = "quiet-button"; view.type = "button"; view.textContent = "查看任务回执";
          view.onclick = async () => { try { const response = await fetch(`/model-api/footage/jobs/${encodeURIComponent(item.job_id)}${query(item.project_id)}`); const job = await response.json(); if (!response.ok) throw new Error("任务回执暂不可用"); onJob(job); } catch (error) { row(controls.batchCurrent, "读取未完成", error.message, true); } };
          itemRow.append(view);
        }
      }
    }
    active = BATCH_ACTIVE.has(batch.status);
    update();
  }
  async function loadHistory() {
    const value = await api(query(projectId));
    const batches = Array.isArray(value) ? value : value.batches || [];
    controls.batchHistory.replaceChildren(new Option(batches.length ? "选择批次查看回执" : "尚无批次记录", ""));
    for (const batch of batches) controls.batchHistory.append(new Option(`${BATCH_LABELS[batch.status] || batch.status} · ${batch.created_at || batch.batch_id}`, batch.batch_id));
    return batches;
  }
  async function poll(batch, token) {
    if (token !== pollToken) return;
    displayBatch(batch);
    if (!BATCH_ACTIVE.has(batch.status)) { await loadHistory(); return; }
    setTimeout(async () => {
      if (token !== pollToken) return;
      try { await poll(await api(`/${encodeURIComponent(batch.batch_id)}${query(batch.project_id)}`), token); }
      catch (error) { row(controls.batchCurrent, "进度读取中断", `${error.message}。刷新或选择历史记录可继续查看，不会重复提交。`, true); }
    }, 1800);
  }
  controls.batchManifest.addEventListener("input", invalidate);
  controls.batchConfirm.addEventListener("change", update);
  controls.importBatchInput.addEventListener("change", async event => {
    const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
    try {
      if (file.size > BATCH_MAX_BYTES) throw new Error("批量清单不能超过 1 MiB。");
      const source = await file.text(); parseBatchManifest(source); controls.batchManifest.value = source; invalidate();
      controls.batchPreflightResults.textContent = "清单已导入，请点击检查；跨项目批次记录保存在第一条任务的项目中。";
    } catch (error) { controls.batchPreflightResults.textContent = error.message; invalidate(); }
  });
  controls.exportBatchTemplateButton.addEventListener("click", () => {
    const blob = new Blob([batchTemplate(getCurrentRequest())], {type: "application/json"});
    const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `footage-batch-template-${projectId}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    controls.batchPreflightResults.textContent = "模板已导出。每条任务保留所属项目；需要联网的任务，请核对后填写 confirm_network: true。";
  });
  controls.batchPreflightButton.addEventListener("click", async () => {
    if (active || checking) return;
    invalidate(); checking = true; update();
    controls.batchPreflightResults.textContent = "正在逐项检查本机配置和请求参数……";
    try {
      const requests = parseBatchManifest(controls.batchManifest.value), fingerprint = JSON.stringify(requests);
      const result = await api("/preflight", {requests});
      if (fingerprint !== JSON.stringify(parseBatchManifest(controls.batchManifest.value))) { controls.batchPreflightResults.textContent = "清单已修改，请重新检查。"; return; }
      displayPreflight(result); ready = result.ready === true;
      if (ready) { checkedFingerprint = fingerprint; requestId = crypto.randomUUID(); }
    } catch (error) { controls.batchPreflightResults.textContent = error.message; }
    finally { checking = false; update(); }
  });
  controls.batchSubmitButton.addEventListener("click", async () => {
    let requests;
    try { requests = parseBatchManifest(controls.batchManifest.value); } catch (error) { controls.batchPreflightResults.textContent = error.message; return; }
    if (!batchCanSubmit({requests, checkedFingerprint, ready, confirmed: controls.batchConfirm.checked, active})) return;
    active = true; update();
    try { const batch = await api("", {requests, request_id: requestId, confirm: true}); controls.batchConfirm.checked = false; ready = false; await poll(batch, ++pollToken); }
    catch (error) { active = false; ready = false; controls.batchConfirm.checked = false; row(controls.batchCurrent, "提交未完成", `${error.message}。如结果不明确，先刷新查看历史，避免重复制作。`, true); update(); await loadHistory(); }
  });
  controls.batchCancelButton.addEventListener("click", async () => {
    if (!current || !BATCH_ACTIVE.has(current.status)) return;
    controls.batchCancelButton.disabled = true;
    try { await poll(await api(`/${encodeURIComponent(current.batch_id)}/cancel`, {project_id: current.project_id}), ++pollToken); }
    catch (error) { row(controls.batchCurrent, "取消未完成", error.message, true); }
    finally { controls.batchCancelButton.disabled = false; }
  });
  controls.batchHistory.addEventListener("change", async () => {
    if (!controls.batchHistory.value) return;
    try { await poll(await api(`/${encodeURIComponent(controls.batchHistory.value)}${query(projectId)}`), ++pollToken); }
    catch (error) { row(controls.batchCurrent, "读取未完成", error.message, true); }
  });
  update();
  try { const history = await loadHistory(); const pending = history.find(batch => BATCH_ACTIVE.has(batch.status)); if (pending) await poll(pending, ++pollToken); }
  catch (error) { controls.batchPreflightResults.textContent = `批次记录暂不可用：${error.message}`; }
}

globalThis.FootageBatch = {parseBatchManifest, batchCanSubmit, batchTemplate, initBatchUI};
if (typeof module !== "undefined" && module.exports) module.exports = globalThis.FootageBatch;
