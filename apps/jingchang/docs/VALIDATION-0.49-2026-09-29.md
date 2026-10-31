# 0.49 验收记录：键盘重做与工作流媒体映射

日期：2026-09-29。验证对象为隔离临时工作区；未改动正式项目数据。

## 实现

- 保留已有 `Cmd/Ctrl+Z` 撤销行为，按键比较改为不区分大小写，使按住 Shift 后的 `Z` 能触发重做。
- 增加常用的 `Cmd/Ctrl+Y` 重做快捷键；两种重做方式都调用现有的撤销/重做按钮与同一项目历史栈。
- 浏览器测试用带有动态媒体引用的画布连线验证撤销/重做，确认边和引用一起恢复。

## 验收证据

- `npm test`：315 项通过，0 失败。
- `npm run check`：通过。
- `node tests/canvas-connections-browser.mjs`：通过。覆盖 `Cmd+Z`、`Cmd+Shift+Z`、`Cmd+Y`，确认动态媒体连线与引用同步撤销/重做；也覆盖 ComfyUI/RunningHub 唯一字段自动映射、多字段手选、断开清理和错误类型拒绝；无浏览器错误。
- 浏览器结果：`artifacts/canvas-connections-qa-1790683033920/result.json`。
- 本机工作台健康状态确认 `agentConfigured=false`、`model=null`。未读取或使用 API Key，未提交第三方生成请求。

## 边界

本轮只修复并验收上述重做快捷键，不代表画布所有快捷键或分组行为已与参考版逐项对齐。其余差异继续记录在 `INFINITE-CANVAS-PARITY.md`。
