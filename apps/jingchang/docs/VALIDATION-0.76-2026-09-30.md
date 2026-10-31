# 0.76 验收：Gemini 对话音频输入

## 改动

- 独立对话现在允许上传并试听 WAV、MP3、AAC、AIFF、FLAC、OGG、WebM、M4A；单条最多一份音频，每份不超过 10 MB，并检查文件头与声明格式一致。
- API 设置中，Gemini 对话模型可逐个明确开启音频能力。默认关闭；切换协议或模型分类时设置表单会及时重绘，保存后按服务端规则再次校验。
- 选中音频后，提交确认会显示 Gemini 服务地址、模型、最近20条上下文范围、原始音频试听、单次请求和预算授权。素材保存在本机，音频字节仅随已确认的 Gemini `generateContent` 请求内嵌发送。
- Gemini 原生文字对话支持一次非流式请求、结果回存和不自动重试；其它协议、图片模式、Agent 模式或未启用音频的模型会在请求前拒绝音频。

## 验证

- `node --test tests/conversation-audio.test.mjs tests/extended-protocols.test.mjs tests/reference-capacity.test.mjs`：14/14 通过，覆盖原生请求、拒绝条件、请求去重与媒体容量边界。
- `npm run test:conversation-audio-browser`：7项隔离 Chromium 检查通过，覆盖 API 设置的 Gemini/逐模型音频开关、上传与试听、授权预览、模拟请求字节、会话回显、密钥不落盘和无非本机请求。
- `npm test`：361/361 通过。
- `npm run check`：代码语法检查通过。
- 浏览器产物：`artifacts/conversation-audio-qa-1790719467157/`。

测试只向本机隔离的 Gemini 模拟服务发送合成 WAV 和合成测试密钥；没有使用用户密钥、没有连接真实 Google/Gemini 服务、没有费用或听写质量验证。其它 GitHub 参考仓库仍未逐仓逐功能审计，不能据此宣称全部整合完成。

协议字段参考：[Google Gemini 音频理解文档](https://ai.google.dev/gemini-api/docs/generate-content/audio)。
