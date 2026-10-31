# 0.73 LTX 时间线悬停快捷键验收

日期：2026-09-30

依据 Infinite Canvas 固定提交中 [LTX Director 时间线的键盘处理](https://github.com/hero8152/Infinite-Canvas/blob/67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e/static/js/ltx-director-timeline.js#L3847-L3874)，让镜场 LTX 编辑器在鼠标停留于时间线编辑区时响应空格播放/暂停，以及 Delete/Backspace 删除当前片段选择。多选删除记作一次撤销。提示词、数字框、选择框和可编辑文本获得焦点时不会截走这些按键；原有轨道焦点快捷键及 Enter/方向键编辑行为保留。

验收结果：

- `node tests/ltx-director-browser.mjs`：23 项 Chromium 浏览器检查通过，覆盖无轨道焦点的悬停播放/暂停、多选删除与撤销、提示词输入不被截获、分组移动与吸附，以及原有 LTX 编辑和工作流映射。
- `node --test tests/ltx-director.test.mjs`：14/14 通过。
- `npm test`：357/357 通过；`npm run check` 通过。
- 浏览器验收使用隔离工作区和本地 mock；未读取 API Key、提交 ComfyUI 工作流、调用真实模型或使用 GPU。

范围限制：该增量只对齐固定提交中的时间线快捷键行为。LTX 自定义节点版本差异、用户本机插件/模型准备、GPU 运行和生成质量仍未验收；其他参考 GitHub 仓库也没有逐仓逐功能审核，不能因此宣称全部复刻完成。
