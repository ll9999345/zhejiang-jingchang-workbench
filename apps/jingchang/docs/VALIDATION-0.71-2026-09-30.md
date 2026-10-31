# 0.71 Alt 与 Alt+Shift 拖动复制验收

日期：2026-09-30

按 Infinite Canvas 固定提交的 `duplicateNodesForAltDrag` 行为，本轮将两个快捷键分开处理：Alt 拖动复制单个节点或镜场对应的节点组，不复制连线；Alt+Shift 拖动才会复制组内连线以及指向副本节点的入边，不把副本的出边接到原有下游节点。组合键先于普通 Shift 多选处理。组元数据、成员映射和颜色仍随组副本保存，拖动后可整体移动。

验收结果：

- `node --test tests/canvas-tools.test.mjs`：14/14 通过；新增测试覆盖 Alt 无边、Alt+Shift 复制内边和入边、不复制出边。
- `npm run test:canvas-alt-drag`：通过；隔离浏览器分别运行 Alt 与 Alt+Shift，验证组元数据、连线方向、拖动位移、项目保存及一次撤销。
- `npm run test:canvas-interactions`：24 项既有画布浏览器回归通过。
- `npm test`：353/353 通过；`npm run check` 以及涉及文件的 `node --check` 均通过。
- 没有调用 Astra、其他真实模型、供应商 API，没有上传素材或发起付费任务。

仍需继续核对该基准的其余画布快捷键、群组操作，以及其他参考仓库的适用功能；本条只证明 Alt/Alt+Shift 拖动复制的本地行为。
