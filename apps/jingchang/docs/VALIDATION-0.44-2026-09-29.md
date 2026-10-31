# 镜场 Agent 0.44 Gemini 图片会话验收

2026-09-29。基于 Gemini 原生图片接口增加图片模型发现与独立对话图片模式。平台配置仅接受图片模型；模型发现只列出支持 `generateContent` 且名称符合图片模型规则的项目。图片请求使用 Gemini 原生 `generateContent`，按模型发送画幅比例和清晰度；参考图只包含用户在本轮明确选择的图片。用户可以将一张已生成结果选作下一轮编辑参考。

Google 官方文档确认原生图片编辑使用图片与文本输入，REST 使用 `x-goog-api-key` 与 `generateContent`；Gemini 3 图片 REST 请求以 `generationConfig.responseFormat.image` 设置画幅与清晰度，2.5 Flash Image 示例只设置画幅。实现据此采用对应请求结构。参见[官方图片生成与编辑文档](https://ai.google.dev/gemini-api/docs/generate-content/image-generation?hl=en)。

## 验证结果

- `npm test`：306 项通过，0 项失败。
- `npm run check`：通过。
- Gemini 聚焦回归：23 项通过，覆盖 Gemini 图片平台分类、模型发现过滤、请求地址和认证头、参考图编辑、模型清晰度、预算与请求范围校验、密钥不落盘及不确定提交不重试。
- 浏览器组件检查确认 API 设置可保存 Gemini 协议，独立对话可选 Gemini 图片模型并显示能力说明；没有完成 API 配置到实际云生成的完整浏览器端到端验收。
- 本地服务更新到 0.44.0；Agent 模型未配置。

## 范围与未完成项

没有使用用户 API Key，也没有向 Google 发起真实请求；生成接口验证使用本机模拟服务，不证明账号权限、费用、可用区域或生成质量。每轮请求独立发送当前提示词和明确选择的参考图；尚未发送 Gemini 原生多轮对话历史、保留角色上下文或 thought signatures。模型发现只表示平台返回该模型，不证明账户已开通。Infinite Canvas 对照表中仍列有未实现和未验收功能，本次不代表整体功能已完全复刻。
