# 镜场 Agent 0.45 Gemini 原生连续图片会话

2026-09-29。独立对话的 Gemini 图片模式新增原生 `user` / `model` 多轮内容。连续会话默认为关闭；只有用户勾选后，才会附加同一 API Base URL 和同一模型的已完成图片轮次。发送确认逐轮展示提示与图片。最多携带8轮，并受当前模型参考图数量和18MB请求限制；超限会在创建生成任务前拒绝。

模型回复中的可支持文本/图片部件和 thought signatures 保存在会话记录中，图片作为普通会话素材存储，不在 JSON 中重复写入图像字节。完整备份会带上这些素材、重映射引用并支持恢复后续接。若模型返回未知或不完整部件，该轮不会被列为可续接的完整原生历史；用户仍可把可见图片明确选为普通参考图。

请求结构按[Google Gemini 图片生成与多轮编辑文档](https://ai.google.dev/gemini-api/docs/generate-content/image-generation?hl=en)对照：REST `generateContent` 使用 `user` / `model` 内容序列，历史图片以 inline data 重建，并保留模型返回的支持签名。此实现只覆盖本项目图片会话所需的文本/图片响应，不代表 Gemini 全部内容部件、视频、音频、流式协议或原生 Agent 已接入。

## 验证

- 全量 `npm test`：307 项通过，0 项失败；会话、Gemini 协议、备份与画布聚焦回归：30 项通过。
- 浏览器端到端检查通过：非 Gemini 协议隐藏历史选项、无兼容历史时禁用、默认关闭、用户确认可检查逐轮提示与图片、实际请求角色/图片/签名正确、工作区中不保存本次 API Key。截图与结果记录保存在 `artifacts/gemini-history-qa-1790679156812/`。
- `npm run check` 通过。

没有使用用户提供的 API Key，也没有向 Google 发起请求。浏览器和接口测试全部使用隔离的本机模拟服务及临时数据。真实账户授权、可用模型、计费和图像质量仍未验证；Infinite Canvas 的其它未完成功能也仍列在 `INFINITE-CANVAS-PARITY.md`。
