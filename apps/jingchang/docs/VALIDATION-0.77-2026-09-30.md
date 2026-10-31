# 0.77 验收：Gemini 语言模型画布与音频链

日期：2026-09-30。

## 本轮交付

- 文本/剧本节点可以绑定 Gemini 原生对话平台，保存系统指令、输出上限、模型快照和素材映射。原有 OpenAI 兼容流式/非流式、APIMart 包装回答和混合画布路径保留。
- 接通固定音频、相连上游已有音频和本轮生成音频；每步最多8张图片、3份视频抽样和1份≤10MB音频。音频必须在 Gemini 模型设置中明确开启，纯音频模型不要求启用图片能力。
- 音频连线会自动映射到兼容语言节点，第二份音频会被拒绝；复制重映射源节点，断开连线清除动态引用。绑定面板显示模型音频能力，并把 Gemini 回答方式固定为完整返回。
- 发送确认按名称显示提示词和参考素材，并提供本机音频试听；固定音频显示原文件发送范围，本轮生成音频明确标记生成后校验。密钥和正预算由用户逐节点确认后才提交。
- Gemini 原生请求使用 `x-goog-api-key`、`generateContent`、`contents.parts[].inlineData` 和 `generationConfig.maxOutputTokens`。音频内嵌于一次请求，没有另行远端素材上传。已知静态请求及实际执行请求均检查18MB编码上限；超限不提交语言模型。
- 完整回答传给下游节点，完成后新建结果节点回填，保留原指令。达到上限、未知/缺失结束状态、网络中断会保存片段并停止下游；继续原任务不重新提交这次同步对话。只有明确 `STOP` 才算完整。
- Gemini 语言绑定使用 v12 完整备份，保留模型音频标记和输入映射，导入更换素材ID后可执行。v1–v11继续支持各自已有能力；含 Gemini 语言绑定的伪旧版本备份会被拒绝。
- 独立音频对话复用结束状态规则；18MB检查提前到建任务/追加消息前，直接接口也拒绝单条第二份音频。

## 验证结果

- `npm test`：372/372通过。覆盖静态/动态音频、ComfyUI模拟生成音频后传递、下游文字、能力/格式/数量/来源拒绝、18MB上限、未知结束状态、原任务防重发、结果回填和备份迁移，并保留其它模块回归。
- `npm run check`：通过，包含新 Gemini 对话共用模块、音频格式表和浏览器脚本。
- `npm run test:canvas-gemini-browser`：8项隔离 Chromium 检查通过；覆盖绑定/重载、音频解码与发送预览、手机布局、双击防重交、下游与回填、实际隔离服务重启、v12备份恢复、不完整结果与密钥不落盘。
- `npm run test:conversation-audio-browser`：7项回归检查通过。
- `node tests/chat-video-browser.mjs`：13项回归检查通过，原有视频抽样/上下文/画布输入/备份路径保留。
- 正式本机服务重启后 `/api/health` 返回 `version:0.77.0`、`agentConfigured:false`、`model:null`；正式任务数0。
- 更新前85份业务文件逐份 SHA-256 校对不变，未新增正式业务文件。检查仅报告数量和校验值，不读取或展示凭据正文。

## 留存证据

- 画布浏览器：`artifacts/canvas-gemini-qa-1790744668969/result.json`，同目录包含绑定、授权、手机和结果截图，以及隔离备份。
- 独立音频回归：`artifacts/conversation-audio-qa-1790744563087/result.json`。
- 视频回归：`artifacts/chat-video-qa-1790744561270/result.json`。
- 正式数据保护：`artifacts/data-preservation-0.77-before.json`、`artifacts/data-preservation-0.77-result.json`。

## 尚未完成

全部模型请求仅发给本机隔离模拟服务，使用合成 WAV、图片和测试密钥。没有使用用户API Key、访问真实 Google/Gemini、发起付费调用或上传用户素材。本地请求/恢复验证不证明真实模型权限、音频听写质量、价格或代理兼容。

其它 GitHub 参考仓库仍未逐仓逐功能盘点；原生视频理解、其它音频会话协议、RunningHub三维/真人资产转换、条件/反馈循环及真实云/GPU验收仍有缺口，整体整合目标保持未完成。

协议字段依据：[Gemini 音频理解文档](https://ai.google.dev/gemini-api/docs/generate-content/audio)、[GenerateContent 响应字段](https://ai.google.dev/api/generate-content)。
