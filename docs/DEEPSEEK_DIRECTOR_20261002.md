# DeepSeek V4.1 Flash：网页导演试用接入

日期：2026-10-02。此次只接入通用 AI 导演，不更换既有 Seedance、配音、字幕、后期或素材搜索提供者。

## 当前状态与使用入口

工作台「工具与设置 → OpenMontage 制作室 → AI 导演」已默认选择 **DeepSeek V4.1 Flash**，API 名称是 **`deepseek-flash`**。可选择普通 OpenMontage 管线，也可选择 Hypit 参考复刻。

认证复用本机 CC Switch 保存的 Claude Code **DeepSeek** 配置，只读取所选记录。Claude Code 当前服务选择、密钥与配置没有修改；不会误用当前另一个中转服务的密钥。

填写创作需求，展开「导演模型与预算」核对预算、单价和思考深度，再检查条件。联网、费用和开始确认默认均未勾选。预填预算不是付费授权；本次接入也没有发起计费生成。参考画面发送继续按具体图片步骤确认。

## 接入方式与可更换性

- 项目偏好位于 `.runtime/director-model.json`：保存提供者、模型、思考深度、既有数据库路径和记录编号，**没有密钥**；该目录已被 Git 忽略。
- 新模块 `web_api/director_settings.py` 负责偏好和凭据引用。认证只在服务端使用，网页、任务参数、Agent 技能上下文和验收回执不包含密钥。
- 数据库以 SQLite 只读模式打开。只有指向官方 `api.deepseek.com` 的所选 DeepSeek 配置可供复用；目标或原记录改成其他服务时停止，不自动搜索其他账号或切换密钥。
- 原有环境变量配置优先。以后可更换提供者和模型；切换网页服务会保留各自的模型/单价草稿，同时撤销旧服务的联网、付费和开始确认。
- GPT 的原有 OpenAI 接口保留。Gemini 本次没有新增或验证账号连接，后续可按实际选择接入；本轮没有把整个制作流程绑定成只能用 DeepSeek。

## 模型协议与预算

使用官方 OpenAI 兼容 `/chat/completions` 接口，真实抽帧以 `image_url` 的 JPEG 内联数据输入；不能用文件名代替视觉分析。模型返回一个动作 JSON，由原导演的工具、版本、审阅与阶段机制执行。

本次预设默认深入思考 `high`，也可选择快速非思考、`low` 或 `max`。单次输出限制为 8192 tokens，仍在工作台预算预留范围内。返回达到输出上限时不会执行被截断的动作，也不会自动重试或换模型；计量使用总输出 token，不把思考 token 当成免费。

网页预填美元单价按 **2026-10-02 官方高峰、未命中缓存价格**作保守预算：输入 $0.30 / 百万 tokens，输出 $1.20 / 百万 tokens。缓存和空闲时段可能更便宜；供应商实际账单与后续价格变化仍须核对。[官方模型与价格](https://api-docs.deepseek.com/quick_start/pricing/)、[思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/)、[图像理解](https://api-docs.deepseek.com/zh-cn/guides/vision/)。

## 本次验证

1. **真实官方鉴权与模型目录**：只调用 `GET https://api.deepseek.com/models`，返回 HTTP 200，找到 `deepseek-flash` / DeepSeek-V4.1-Flash，输入能力包含 `text` 与 `image`。没有提交创作文字、图片或视频，没有调用生成接口。回执：[catalog.json](../artifacts/deepseek-director-20261002/connection-061256-efc0b2/catalog.json)。
2. **后台回归 94 项通过**：37 项新增设置/认证/传输测试，加上导演、Hypit 导演、API 与媒体预览相关回归。模型回复、视觉传输和截断场景使用模拟 HTTP，不冒充真实推理。API 回归另有 3 条既有 FastAPI 弃用提示。
3. **前端 7 项单测、11 组模拟 API 浏览器场景通过**：包含预填模型和价格、思考参数、逐服务草稿恢复、服务切换撤销旧授权，以及原 Hypit 导入、历史与取消交互。回执：[director-browser-results.json](../artifacts/deepseek-director-20261002/mock-ui-final/director-browser-results.json)。
4. **真实网页验收**：4750 服务读取到默认模型；1440px 桌面和 390px 独立手机视口无横向溢出、无页面异常。检查条件在本次本机实测 280 ms 返回，明确仍需联网/费用确认；只读原项目标记保持一致，没有上传、生产或对外页面请求。回执：[verification.json](../artifacts/deepseek-director-20261002/live-2026-10-02T06-23-23-300Z-d2e0e2/verification.json)，截图：[桌面](../artifacts/deepseek-director-20261002/live-2026-10-02T06-23-23-300Z-d2e0e2/desktop-model-settings.png)、[手机](../artifacts/deepseek-director-20261002/live-2026-10-02T06-23-23-300Z-d2e0e2/mobile-model-settings.png)。

上述验证证明连接、认证和网页交接已经接通。**完整参考片理解、自动编写 Hypit 工程、作品审美与实际成片质量，本轮没有作计费制作验收**。之前的本地 Hypit 渲染验证继续见 [HYPIT_DIRECTOR_INTEGRATION_20261002.md](HYPIT_DIRECTOR_INTEGRATION_20261002.md)。
