# Google Flow / Jio Pro 接入说明 · 2026-10-25

状态：用户报告已开通Jio渠道的Pro账号、可以使用Google Flow；本轮仅查官方公开文档，未读取登录账号或额度，未调用云模型、未上传素材。镜场的Flow交接尚未实现，不能把此说明算作已接通功能。

## 已核实的公开说明

- [Jio官方Pro权益说明](https://www.jio.com/help/faq/mobile/offers/google-gemini-offer/what-is-google-ai-pro-subscription-and-how-can-i-benefit-from-it/)包含Flow使用权益。
- [Google Flow入门](https://support.google.com/flow/answer/16353333?hl=en)列出年龄、支持地区、订阅等条件；实际模型和消耗在产品设置中核对。公开计划介绍不代表已验收个人账号。
- [Google额度说明](https://support.google.com/googleone/answer/16287445?hl=en)说明各产品各有使用限制，消耗随功能/模型变化。不要用宣传固定数量替代账号当日显示。
- [Gemini API计费说明](https://ai.google.dev/gemini-api/docs/billing)描述API项目独立的额度/计费设置。因此不能仅凭Flow网页会员推定镜场已拥有免费API权限；需要另查具体API项目与授权范围。

## 当前可采用的人工配合方式

1. 在镜场准备分镜、每镜头提示词、画幅与时长；将自己选择的参考素材保存到本机。
2. 自己在[官方Flow入口](https://labs.google/fx/tools/flow)登录，确认实际模型、额度和单次消耗。需要登录/验证码时由用户处理。
3. 在原先暂停生成的要求改变且明确了执行范围前，不自动点击生成、不发送提示词或素材、不消耗订阅额度。
4. 用户自行制作并下载结果后，可通过镜场已有本地素材导入入口继续整理。自动关联原镜头、保留Flow来源和失败恢复的专用交接需另行实现、验证。

## 后续实现范围

优先准备纯本地交接包：镜头编号、提示词、尺寸/时长、用户选择的参考文件清单；不含账号信息或凭据。打开官方网页与上传/生成分开；结果由用户选择本地文件回填，核对镜头编号和版本再保存。网页流程不伪装成后台API，不复制Cookie/会话令牌，不依赖第三方Agent。

这只是接入设计；目前没有Flow专用按钮、任务状态同步、自动上传或真实Flow生成验收。既有API与数据保持，付费生成继续暂停。
