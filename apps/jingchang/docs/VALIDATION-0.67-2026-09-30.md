# 0.67 验收记录

日期：2026-09-30  
范围：对照 Infinite Canvas 固定提交的 [LTX Director 快捷键](https://github.com/hero8152/Infinite-Canvas/blob/67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e/static/js/ltx-director-timeline.js#L3847-L3870)，补齐空格播放/暂停与 Delete/Backspace 删除片段。

## 实现

- 时间线获得键盘焦点时，空格复用现有预览播放/暂停按钮逻辑。
- Delete 或 Backspace 删除焦点片段；多选时一次删除所有选中片段，只创建一个撤销记录。
- 删除后焦点回到时间线；从时间线输入框、提示词编辑框等表单字段操作时不触发删除。
- 时间线旁显示快捷键提示，屏幕阅读器可读取支持的快捷键。

## 验收结果

- `npm test`：345 项通过，0 项失败。
- `node tests/ltx-director-browser.mjs`：22 项隔离浏览器检查通过，覆盖空格启动/暂停、Delete 多选删除、Backspace 单项删除及撤销恢复，页面错误为 0。
- `npm run check` 与 `npm run check:chrome-importer`：通过。
- 本机 `/api/health` 返回 `version: 0.67.0`、`agentConfigured: false`、`model: null`；`/api/jobs` 为空。工作台页面已重新加载。
- 没有调用 Astra 或其他模型、云账户、ComfyUI 工作流或付费服务，也没有使用或读取真实 API Key。

## 尚未完成

这只补齐两个明确的时间线键盘行为，不表示 LTX 全部快捷键或其他插件版本字段均已对齐，也不证明真实 GPU 生成质量。Infinite Canvas 的其他差距，以及 LibTV、RunningHub、其他候选 GitHub 项目尚未逐仓逐功能审计的范围仍然存在；见 `FEATURES.md` 和 `INFINITE-CANVAS-PARITY.md`。
