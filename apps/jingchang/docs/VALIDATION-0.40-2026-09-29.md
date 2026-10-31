# 镜场 Agent 0.40 画布删除快捷键验收

2026-09-29。对齐 Infinite Canvas 固定提交的画布键盘操作，为选区接入 Delete 与 Backspace，并复用现有可撤销节点移除逻辑。上游键盘行为核对：[固定版本 canvas.js](https://github.com/hero8152/Infinite-Canvas/blob/67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e/static/js/canvas.js#L15993-L16004)。测试在独立本地数据目录运行，没有调用 Agent、Astra、第三方模型、GPU 或付费服务。

## 验证结果

- 最终代码全量自动测试 304/304 通过，0 失败、跳过或取消：`node --import ./tests/helpers/local-network-only.mjs --test tests/*.test.mjs`。
- Playwright 浏览器检查 21 项通过：包含 Delete/Backspace 删除选中节点、撤销恢复、输入框内 Backspace 不删除节点，以及 0.39 的六种对齐、保存刷新恢复、右键菜单、移动布局与连线交互。无页面脚本错误。截图和结果保存在 `artifacts/canvas-interactions-qa-1790670597674/`。
- `npm run check` 通过。
- 本地服务版本更新为 0.40.0；未使用或保存用户 API Key，Agent/Astra 均未调用。

## 尚存差距

这两种删除快捷键及六种对齐已接入，不代表全部快捷键或 Infinite Canvas 整体功能完成。其他快捷键、分组样式、第三方协议/账户/GPU 验收和对照清单中的其他缺项仍待实现或验收。
