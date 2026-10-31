# 2026-10-04 · 喵喵 GPT 接入与实际验证

当前结论：**接入代码与本机专用认证已配置，真实模型调用尚未通过。** 用户已有的镜场平台配置保留；没有新建密钥，没有替换默认 DeepSeek，也没有新增视频生产。

## 用途与入口

- [连接设置](http://127.0.0.1:4750/model-api/montage/director/miaoapi/setup)：读取本机状态、选择模型和协议。保存设置不会调用模型。
- 文旅「工具与设置 → OpenMontage 制作室 → AI 导演」可选择喵喵 API；沿用现有导演的工具、阶段确认和任务记录。
- 镜场「设置 → 创作助理」增加喵喵选项。文字剧本、逐镜修改、提示词改写仍先展示修改计划；应用可撤销。本轮没有切换已有默认服务。
- 镜场已有「API 平台与模型」记录与本轮「创作助理」是两个配置用途；保存平台地址与模型分类，不等于画布助理已切换到该平台。

当前只允许发送文字。多模态画面理解、图片与视频生成、第三方工具的额外费用分别需要相应服务配置与授权，不能由此宣称全自动成片已通过。

## 已有配置如何保留

沿用喵喵平台已有的「镜场-对话专用」密钥。经用户明确批准，把它保存到 macOS 钥匙串的独立服务 `cn.zhejiang-tourism.workbench.miaoapi` / 账户 `director-text`。服务器端读取；浏览器、项目、日志与本文件不包含密钥。

模型偏好单独保存在 `.runtime/miaoapi-director.json`，只含版本、模型和协议。修改保留上一版副本；不会覆盖其他提供商的密钥。已有镜场平台列表仍为 1 项、revision 1；原助理设置仍为 DeepSeek、revision 1。

服务地址固定为 `https://miaoapi.xyz/v1`。协议可明确选择 Responses 或 Chat Completions；失败不会自动换模型、协议、提供商或再次提交。

## 模型与预算

2026-10-04 通过已登录平台页面核对。不降智的 GPT 分组从旧缓存的 0.3x 刷新为 **0.35x**，工作台已更新对应预算。

| 平台模型名 | 页面输入 / 输出单价（美元 / 百万令牌） | 应用预留单价 |
| --- | --- | --- |
| gpt-5.4-mini | 0.2625 / 1.575 | 0.525 / 3.15 |
| gpt-5.6-sol | 最高上下文档位 3.50 / 15.75 | 7.00 / 31.50 |

预留按输入字节上界、额外提示词空间和输出上限计算，价格加倍、不假定缓存折扣。**这是工作台的预算检查，不是平台硬性账单封顶。** 分组、峰值倍率和价格可能变化，实际扣费以平台记录为准。

这些是喵喵目录中的模型别名，未独立核验上游模型身份。gpt-6.1-sol 出现在平台目录，但本轮没有查到对应价格，不开放此自动导演配置；已有镜场的模型分类保持不变。

## 本轮真实测试与故障

- 用户批准：喵喵 API 的 gpt-5.4-mini，1 次虚构文字测试，费用上限 0.10 美元，不发送素材或真实项目，不自动重试。
- 已执行：2026-10-04 14:59:05（北京时间），Responses 接口，输出上限 2048 tokens。请求编号 `83d05c5c-0445-4515-bc7b-5ca883dfc42a`。
- 结果：**HTTP 403**；没有得到回答，没有生成或应用画布修改。真实请求数 1，自动重试数 0。原始失败回执保留。
- 同一项目 Python 环境的不带密钥 GET 诊断，返回 HTTP 403、`Server: cloudflare`、正文 `error code: 1010`。这证明该诊断请求被站点防护拦截。原付费请求错误正文未保留，因此不能把它的具体原因与诊断结果完全等同。
- 平台页面读取时，专用密钥显示今日用量 0.0000 美元；近 24 小时使用记录显示 0 请求、0 tokens、0.0000 美元。此为当时页面值，不保证无延迟或未来补记。

[Cloudflare 官方说明](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/)将 1010 解释为站点对客户端特征的访问限制，应由站点方核查。本轮没有绕过网站防护、关闭 TLS 证书验证、扩大权限或更换密钥。解决平台访问限制后，新的真实测试仍需要明确调用范围与预算；本轮单次授权已用完。

## 实现与本地验证

主适配器：`web_api/miaoapi_director.py`；本机桥：`scripts/canvas_deepseek.py`；文旅导演：`web_api/montage_director.py`；设置路由：`web_api/montage_api.py`。镜场复用 `lib/director-provider.mjs` 与原有规划、审阅、应用流程。

实际使用 Python 标准库、macOS Security.framework、FastAPI、Node.js、原生 JavaScript；没有为此安装系统软件。

本轮必要验证：

- Python 相关回归原运行 121 项通过，其中喵喵协议/预算/本机设置/媒体拒绝等 27 项；价格更新后喵喵 27 项再次通过。
- 镜场 DeepSeek 与喵喵相关 12 项通过：提供商授权隔离、虚构计划检查、应用一次、失败及重启不重复提交、提示词草稿等。模型返回为模拟数据，不是成功的真实云调用。
- 既有前端相关 10 项通过；设置脚本语法检查通过。
- Chrome 实际检查配置页、文旅模型选择、镜场设置，未点击模型制作或发送真实项目。
- 文旅 63 个项目/检查点文件指纹保持一致。镜场 7 个项目中 6 个一致；独立手势验收项目发生并行版本变化（revision 23），没有恢复或覆盖该变化。不能宣称全部 7 个工程指纹不变。

回执目录：[artifacts/miaoapi-integration-20261004-143140](../artifacts/miaoapi-integration-20261004-143140)。[答辩留档](defense-evidence/records/2026-10-04-miaoapi-director/README.md)保存截图、图注与边界。

## 来源

- [喵喵使用文档](https://miaoapi.xyz/docs)与[模型价格](https://miaoapi.xyz/model-plaza?embedded=1)：服务方协议与当时分组价格。
- [OpenAI Responses 迁移文档](https://developers.openai.com/api/docs/guides/migrate-to-responses)：Responses 的输入、输出、JSON 格式与 `store: false` 参数；只说明兼容协议，不证明中转模型身份。
- [Apple Security](https://developer.apple.com/documentation/security)：已有 macOS 钥匙串框架；没有把凭据写入普通文件。

尚未验收：真实 GPT 规划与质量、全部 12 条制作管线、付费媒体工具和多模态画面理解。本轮不报告整体完成百分比。
