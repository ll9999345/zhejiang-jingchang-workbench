(function () {
  "use strict";
  const TYPES = {
    text_card: "文字卡", hero_title: "片头／片尾", stat_card: "数字卡", callout: "提示卡",
    comparison: "两项比较", bar_chart: "柱状图", line_chart: "折线图", pie_chart: "饼图",
    kpi_grid: "指标组合", progress_bar: "进度条", image: "项目图片", video: "项目视频",
  };
  const HINTS = {
    comparison: "每行一项：名称 | 内容；填写两行。",
    bar_chart: "每行一项：名称 | 数值，例如 西湖 | 80。",
    pie_chart: "每行一项：名称 | 数值；数值需大于或等于零。",
    kpi_grid: "每行一项：名称 | 数值。",
    line_chart: "每行一条曲线：名称 | 0:10, 1:20, 2:30。",
    progress_bar: "填写 0 到 1 的数值，例如 0.75 表示 75%。",
    image: "填写当前项目内图片路径，例如 assets/images/frame-01.png。",
    video: "选择项目内视频；MOV 等格式在确认后只转换所选范围，原件保留。原片声音静音，可另选项目音频。",
  };
  function node(tag, text, attrs = {}) {
    const element = document.createElement(tag);
    if (text != null) element.textContent = text;
    Object.entries(attrs).forEach(([name, value]) => element.setAttribute(name, String(value)));
    return element;
  }
  function field(label, control) {
    const wrap = node("label", label);
    wrap.append(control);
    return wrap;
  }
  function numeric(value, label) {
    const number = Number(value);
    if (!String(value).trim() || !Number.isFinite(number)) throw new Error(`${label}需要填写有效数字。`);
    return number;
  }
  function chartRows(text) {
    return text.split(/\r?\n/).filter(line => line.trim()).map(line => {
      const [label, value] = line.split("|").map(part => part.trim());
      if (!label || !value) throw new Error("请按“名称 | 数值”填写每一行。");
      return {label, value: numeric(value, "图表数值")};
    });
  }
  function sceneProps(type, content, secondary) {
    if (["text_card", "hero_title", "callout"].includes(type)) return {text: content, subtitle: secondary || null, heroSubtitle: secondary || null};
    if (type === "stat_card") return {stat: content, subtitle: secondary || null};
    if (type === "comparison") {
      const rows = content.split(/\r?\n/).filter(line => line.trim()).map(line => line.split("|").map(part => part.trim()));
      if (rows.length !== 2 || rows.some(row => row.length !== 2 || !row[0] || !row[1])) throw new Error("比较卡需要两行“名称 | 内容”。");
      return {leftLabel: rows[0][0], leftValue: rows[0][1], rightLabel: rows[1][0], rightValue: rows[1][1], title: secondary || null};
    }
    if (["bar_chart", "pie_chart", "kpi_grid"].includes(type)) return {chartData: chartRows(content), title: secondary || null};
    if (type === "line_chart") {
      const chartSeries = content.split(/\r?\n/).filter(line => line.trim()).map(line => {
        const [label, points] = line.split("|").map(part => part.trim());
        if (!label || !points) throw new Error("折线图需要“名称 | x:y, x:y”。");
        const data = points.split(/[,，]/).map(point => {
          const [x, y] = point.split(":");
          return {x: numeric(x, "横轴"), y: numeric(y, "纵轴")};
        });
        return {label, data};
      });
      return {chartSeries, title: secondary || null};
    }
    if (type === "progress_bar") return {progress: numeric(content, "进度"), progressLabel: secondary || null};
    return {source: content};
  }
  async function request(path, payload) {
    const response = await fetch(path, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload)});
    const data = await response.json();
    if (!response.ok) {
      const details = Array.isArray(data.detail) ? data.detail.map(item => item.msg).join("；") : data.detail;
      throw new Error(details || "本机服务请求失败。");
    }
    return data;
  }
  function mount(host, options = {}) {
    if (!host || host.dataset.montageMounted) return;
    host.dataset.montageMounted = "true";
    const getProjectId = options.getProjectId || (() => document.getElementById("mediaProjectId")?.value.trim() || "");
    const mode = node("select", null, {"aria-label": "制作方式"});
    mode.append(node("option", "场景动画合成", {value: "composition"}), node("option", "长视频批量裁剪", {value: "clips"}),
      node("option", "完整原生工具", {value: "tool"}), node("option", "AI 导演 · 完整制作管线", {value: "director"}));
    const composition = node("div", null, {class: "montage-composition"});
    const sceneList = node("div", null, {class: "montage-scene-list"});
    const addScene = node("button", "添加场景", {type: "button", class: "secondary"});
    const dimensions = node("select", null, {"aria-label": "画幅与分辨率"});
    dimensions.append(node("option", "横屏 1280 × 720", {value: "1280x720"}), node("option", "竖屏 720 × 1280", {value: "720x1280"}), node("option", "方形 720 × 720", {value: "720x720"}));
    const audio = node("input", null, {placeholder: "可选：assets/audio/narration.wav"});
    const audioPicker = node("select", null, {"aria-label": "选择项目音频"});
    const baseCapabilityHint = "原生横屏模板会完整适配到所选画幅；竖屏、方屏保留上下留白。MOV 等视频会在确认后进行本机兼容转换；原件保留，原片声音静音，配音另选。";
    const capabilityHint = node("p", baseCapabilityHint, {class: "media-hint"});
    composition.append(field("画幅", dimensions), capabilityHint, field("已有项目音频（可选）", audioPicker), field("音频路径（也可手工填写）", audio), sceneList, addScene);
    const clips = node("div", null, {class: "montage-clips"});
    clips.hidden = true;
    const source = node("input", null, {placeholder: "assets/video/long-source.mp4"});
    const sourcePicker = node("select", null, {"aria-label": "选择原视频"});
    const ranges = node("textarea", null, {rows: 5, placeholder: "0, 12\n30, 45\n每行填写一个片段的开始秒数和结束秒数"});
    const codec = node("select", null, {"aria-label": "裁剪方式"});
    codec.append(node("option", "精确裁剪（重新编码）", {value: "libx264"}), node("option", "快速复制（切点可能不精确）", {value: "copy"}));
    const suggestions = node("button", "先自动推荐段落 →", {type: "button", class: "secondary"});
    clips.append(field("选择已有原视频", sourcePicker), field("原视频路径（也可手工填写）", source), suggestions,
      field("片段起止秒数（每行一段）", ranges), field("裁剪方式", codec), node("p", "可以先按字幕边界推荐段落，再审阅切点并导出。建议不保证传播效果；AI 导演可进一步做语义取舍。", {class: "media-hint"}));
    const preflight = node("button", "检查制作条件", {type: "button", class: "secondary"});
    const execute = node("button", "确认并开始本机制作", {type: "button"});
    const confirmed = node("input", null, {type: "checkbox"});
    const confirmation = field("我确认本次内容与参数，允许写入新的项目文件", confirmed);
    const status = node("p", "所有输入与输出保留在本机当前项目中。", {class: "media-hint", role: "status", "aria-live": "polite"});
    const previews = node("div", null, {class: "media-preview"});
    const actions = node("div", null, {class: "button-row"});
    actions.append(preflight, execute);
    host.append(field("制作方式", mode), composition, clips, confirmation, actions, status, previews);
    const studio = node("div", null, {class: "montage-studio"});
    host.append(studio);
    window.ZhejiangMontageStudio?.mount(studio, {getProjectId});
    let busy = false;
    let assetProject = null;
    let assets = [];
    let sceneRuntime = null;
    function fillPicker(picker, kind) {
      const previous = picker.value;
      picker.replaceChildren(node("option", "请选择已有素材（也可填写路径）", {value: ""}));
      assets.filter(asset => asset.kind === kind).forEach(asset => picker.append(node("option", asset.label || asset.path, {value: asset.path})));
      if (Array.from(picker.options).some(option => option.value === previous)) picker.value = previous;
    }
    function updateSceneAssets(row) {
      fillPicker(row.mediaPicker, row.sceneType.value);
      row.mediaField.hidden = !["image", "video"].includes(row.sceneType.value);
      if (sceneRuntime) Array.from(row.sceneType.options).forEach(option => {
        option.disabled = Boolean(sceneRuntime.unavailable_scene_types?.[option.value]);
        if (option.disabled) option.textContent = `${TYPES[option.value]}（当前本机暂不可用）`;
      });
    }
    async function refreshAssets() {
      const project = getProjectId();
      if (assetProject !== project) {
        assetProject = project;
        assets = [];
        studio.setMontageAssets?.(assets);
        fillPicker(audioPicker, "audio");
        fillPicker(sourcePicker, "video");
        Array.from(sceneList.children).forEach(updateSceneAssets);
        confirmed.checked = false;
        previews.replaceChildren();
        status.textContent = project ? "项目已切换，输入已保留；请核对所用素材。" : "请先选择或载入一个项目。";
      }
      if (!project) return;
      try {
        const response = await fetch(`/model-api/footage/context/${encodeURIComponent(project)}`);
        if (!response.ok) return;
        const data = await response.json();
        if (getProjectId() !== project) return;
        assets = Array.isArray(data.assets) ? data.assets.filter(asset => typeof asset.path === "string" && !asset.path.startsWith("/") && !asset.path.split("/").includes("..")) : [];
        studio.setMontageAssets?.(assets);
        fillPicker(audioPicker, "audio");
        fillPicker(sourcePicker, "video");
        Array.from(sceneList.children).forEach(updateSceneAssets);
      } catch (_) { /* Manual project-relative paths remain usable. */ }
    }
    audioPicker.addEventListener("change", () => { audio.value = audioPicker.value; confirmed.checked = false; });
    sourcePicker.addEventListener("change", () => { source.value = sourcePicker.value; confirmed.checked = false; });
    function addSceneRow() {
      const row = node("div", null, {class: "montage-scene-row"});
      const type = node("select", null, {"aria-label": "场景类型"});
      Object.entries(TYPES).forEach(([value, text]) => type.append(node("option", text, {value})));
      const duration = node("input", null, {type: "number", min: "0.5", max: "60", step: "0.5", value: "3"});
      const content = node("textarea", null, {rows: 3, placeholder: "填写本场景的内容"});
      const secondary = node("input", null, {placeholder: "说明／标题（可选）"});
      const mediaPicker = node("select", null, {"aria-label": "选择场景素材"});
      const mediaField = field("选择已有场景素材", mediaPicker);
      mediaField.hidden = true;
      row.mediaPicker = mediaPicker;
      row.mediaField = mediaField;
      row.sceneType = type;
      mediaPicker.addEventListener("change", () => { content.value = mediaPicker.value; confirmed.checked = false; });
      const hint = node("p", "填写本场景的文字。", {class: "media-hint"});
      const remove = node("button", "移除本场景", {type: "button", class: "secondary"});
      remove.addEventListener("click", () => { if (!busy) { row.remove(); confirmed.checked = false; } });
      type.addEventListener("change", () => {
        hint.textContent = HINTS[type.value] || "填写本场景的文字。";
        content.placeholder = HINTS[type.value] || "填写本场景的内容";
        confirmed.checked = false;
        updateSceneAssets(row);
      });
      row.append(field("场景类型", type), field("持续秒数", duration), mediaField, field("内容／数据", content), field("补充说明（可选）", secondary), hint, remove);
      row.readScene = index => ({id: `scene-${index + 1}`, type: type.value, duration_seconds: numeric(duration.value, "场景时长"), props: sceneProps(type.value, content.value.trim(), secondary.value.trim())});
      sceneList.append(row);
      updateSceneAssets(row);
    }
    addScene.addEventListener("click", () => { if (!busy) { addSceneRow(); confirmed.checked = false; } });
    addSceneRow();
    function changeMode() {
      composition.hidden = mode.value !== "composition"; clips.hidden = mode.value !== "clips";
      const nativeMode = ["composition", "clips"].includes(mode.value);
      confirmation.hidden = actions.hidden = status.hidden = previews.hidden = !nativeMode;
      studio.setMontageMode?.(mode.value);
      confirmed.checked = false;
    }
    mode.addEventListener("change", changeMode);
    host.prepareMontageTool = async (name, values) => {
      mode.value = "tool"; changeMode();
      if (!studio.prepareMontageTool) throw new Error("原生字幕工具尚未载入，请刷新后重试。");
      await studio.prepareMontageTool(name, values);
    };
    host.prepareMontageDirector = async (values = {}) => {
      mode.value = "director"; changeMode();
      if (!studio.prepareMontageDirector) throw new Error("导演工作台尚未载入，请刷新后重试。");
      await studio.prepareMontageDirector(values);
    };
    host.addEventListener("montage:reference-import", event => {
      if (event.detail?.project_id === getProjectId()) void refreshAssets();
    });
    suggestions.addEventListener("click", async () => {
      mode.value = "tool"; changeMode();
      try {
        await studio.selectMontageTool?.("highlight_selector");
        const control = studio.querySelector('[data-native-parameter="input_path"]');
        if (control) control.value = source.value.trim();
      } catch (error) {
        const message = studio.querySelector('[role="status"]');
        if (message) message.textContent = error.message || "未能读取推荐工具，请刷新后再试。";
      }
    });
    host.addEventListener("montage:suggestions", event => {
      if (event.detail?.project_id !== getProjectId()) return;
      ranges.value = event.detail.candidates.map(row => `${row.start_seconds}, ${row.end_seconds}`).join("\n");
      if (event.detail.source_path) source.value = event.detail.source_path;
      mode.value = "clips"; changeMode();
      status.textContent = "已填入建议段落。请先审阅原视频与切点，再确认裁剪。";
    });
    host.addEventListener("input", event => { if (event.target !== confirmed) confirmed.checked = false; });
    host.addEventListener("change", event => { if (event.target !== confirmed) confirmed.checked = false; });
    function payload() {
      const project_id = getProjectId();
      if (!project_id) throw new Error("请先选择或载入一个项目。");
      if (mode.value === "composition") {
        const [width, height] = dimensions.value.split("x").map(Number);
        return {project_id, scenes: Array.from(sceneList.children).map((row, index) => row.readScene(index)), width, height, fps: 30, audio_path: audio.value.trim() || null};
      }
      const segments = ranges.value.split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
        const pair = line.trim().split(/[,，]/);
        if (pair.length !== 2) throw new Error("每行需要两个秒数，以逗号分隔。");
        return {id: `clip-${index + 1}`, start_seconds: numeric(pair[0], "开始秒数"), end_seconds: numeric(pair[1], "结束秒数")};
      });
      return {project_id, input_path: source.value.trim(), segments, codec: codec.value};
    }
    function showResults(data) {
      previews.replaceChildren();
      const files = data.output ? [data.output] : data.clips || [];
      files.forEach((file, index) => {
        if (!file.path) return;
        const url = `/media/${encodeURIComponent(data.project_id)}/${file.path.split("/").map(encodeURIComponent).join("/")}`;
        const label = node("a", files.length > 1 ? `播放片段 ${index + 1}` : "播放新成片", {href: url, target: "_blank", rel: "noopener"});
        const video = node("video", null, {controls: "", preload: "metadata", src: url, style: "max-width:100%;max-height:240px"});
        previews.append(label, video);
      });
    }
    async function run(shouldExecute) {
      if (busy) return;
      let lockedControls = [];
      try {
        if (assetProject !== getProjectId()) await refreshAssets();
        const body = payload();
        const actionMode = mode.value;
        if (shouldExecute && !confirmed.checked) throw new Error("请勾选确认当前内容与参数后再开始制作。");
        busy = true;
        lockedControls = Array.from(host.querySelectorAll("button, input, select, textarea"), control => ({control, disabled: control.disabled}));
        lockedControls.forEach(({control}) => { control.disabled = true; });
        status.textContent = shouldExecute ? "正在本机制作，请保持当前项目……" : "正在检查本机条件……";
        const path = `/model-api/montage/${actionMode}/${shouldExecute ? "execute" : "preflight"}`;
        const data = await request(path, {...body, dry_run: !shouldExecute, execute: shouldExecute, confirm: shouldExecute});
        if (getProjectId() !== body.project_id) return;
        if (data.status === "completed") {
          status.textContent = `已写入 ${data.clip_count || 1} 个新视频；请播放检查画面和切点。`;
          showResults(data);
          confirmed.checked = false;
          if (options.onResult) options.onResult(data);
          void refreshAssets();
          host.dispatchEvent(new CustomEvent("montage:result", {bubbles: true, detail: data}));
        } else if (data.status === "dry_run") {
          status.textContent = data.message || "本机条件可用；确认内容后即可开始。预检没有写入文件。";
        } else if (data.status === "failed" && data.run_id) {
          const count = data.written_files?.length || 0;
          status.textContent = `${data.error || "本次制作未完成。"} 已保留 ${count} 个本次运行文件；不会自动重试。`;
          confirmed.checked = false;
          showResults(data);
          if (data.manifest?.path) {
            const url = `/media/${encodeURIComponent(data.project_id)}/${data.manifest.path.split("/").map(encodeURIComponent).join("/")}`;
            previews.append(node("a", "查看本次失败与保留文件记录", {href: url, target: "_blank", rel: "noopener"}));
          }
        } else {
          const reasons = data.runtime?.reasons?.join("；");
          throw new Error(data.error || reasons || "当前条件不满足，本次未完成制作。");
        }
      } catch (error) {
        status.textContent = error.message || "制作失败，请检查当前输入。";
      } finally {
        busy = false;
        lockedControls.forEach(({control, disabled}) => { control.disabled = disabled; });
      }
    }
    preflight.addEventListener("click", () => void run(false));
    execute.addEventListener("click", () => void run(true));
    document.getElementById("mediaProjectId")?.addEventListener("change", () => void refreshAssets());
    document.getElementById("mediaProjectId")?.addEventListener("input", () => void refreshAssets());
    document.addEventListener("studio:project", () => void refreshAssets());
    host.addEventListener("focusin", () => { if (assetProject !== getProjectId()) void refreshAssets(); });
    void refreshAssets();
    fetch("/model-api/montage/capabilities").then(response => response.ok ? response.json() : null).then(data => {
      sceneRuntime = data?.composition || null;
      const unavailable = Object.values(sceneRuntime?.unavailable_scene_types || {}).join("；");
      if (unavailable) capabilityHint.textContent = `${baseCapabilityHint}${unavailable}`;
      Array.from(sceneList.children).forEach(updateSceneAssets);
    }).catch(() => {});
  }
  window.ZhejiangMontageTools = {mount, sceneProps};
  function mountExisting() { mount(document.getElementById("montageTools")); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountExisting, {once: true});
  else mountExisting();
})();
