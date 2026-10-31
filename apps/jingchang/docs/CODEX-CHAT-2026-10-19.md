# 0.99.13 · Codex文字与看图任务

日期：2026-10-19。入口：镜场画布 → 设置 → 本机工具 → **Codex文字与看图任务**。选中节点后打开可带入当前正文；进入前先保存画布。原即梦任务、普通对话、版本/帮助和原API模型配置保留。

本轮接通Codex CLI的文字/图片理解回答和本机任务恢复，不包含Codex生图、CLI既有登录账户复用、Gemini/Antigravity执行或全部参考功能。真实程序已用本机合成Responses服务验证，真实云模型/账户/费用/看图质量尚未验收；付费继续暂停。

## 使用顺序

1. 先在原API设置保存支持 **Responses API** 的OpenAI兼容服务及对话模型；看图须手动开启模型的图片能力。普通Chat Completions可用不等于该服务支持Responses，不会自动探测或更换接口。
2. 从本机工具入口打开本页，选择服务、模型，填写问题。系统指令可留空。需要连续讨论时，明确选择一份已完整返回的本机原回答。
3. 按需展开参考图片，勾选当前工程中的PNG、JPEG或WebP。不能把未导入电脑文件路径直接交给程序。旧上下文带入的图片也会列在预览中。
4. 点击“本机检查发送范围”，核对程序版本、目的服务、型号、文字、旧上下文和图片。这一步只读本机文件，不调用模型、不检查登录账户。
5. 填写仅本次使用的API Key、预算与单位，再勾选同意发送。公网服务要求正预算；本机免认证合成/自建服务可留空Key并填0。预算不是供应商实际扣费的强制上限。
6. 点击“确认发送一次”。页面只读取本机记录更新状态。重复点击、断线后读取或刷新页面不会再次提交同编号。
7. 完整回答保存后可以下载原文字，或“取回原节点”“另存文本节点”。取回检查原正文和参数是否有新编辑；已有新编辑则拒绝覆盖，可选择另存。相同任务、相同取回方式重复操作不增副本、不覆盖后来的编辑。

草稿只保留在当前浏览器会话，不保存API Key。再次预览或改动输入会清除原确认范围。读到原任务前结果不明时保留原请求编号，先读取原记录与核对原平台；不会自动提交一个新编号。

## 运行与恢复

使用已经安装且本轮核对的官方 `@openai/codex` 0.147.0。程序未找到、安装结构/版本未核对或没有所需macOS隔离时，入口明确拒绝执行；不会自动安装、升级、替换工具。仅按当前CPU架构查找已安装原生程序，不把某一架构的验证算作全部架构验收。

Codex使用独立的本次工作目录与子进程配置目录，不读写现有CLI登录认证，不加载用户配置/执行规则，不运行模型命令、MCP、子代理或网页工具。本机操作系统限制只允许读取本次工作资料和程序运行文件，写入本次目录，只连接这一任务的镜场本机端口。主机HOME、CODEX_HOME和原CLI配置不修改。

工具进程拿不到平台密钥。镜场本机转发器持有本次API Key，只向预览的唯一服务/模型发送已确认的标准文字/图片上下文；不会将工具自行构造的额外输入、工具列表或账户配置发出去。转发前先保存原请求记录，最多一次Responses提交；即使工具尝试重连，也不会扩大成第二次上游请求。Key只在内存和这次授权HTTP请求中使用，记录、下载、截图与历史档案不包含它。

停止只中止本机等待，不表示平台任务已取消或一定未计费。服务重启不重跑CLI、不查询模型、不重发原请求。已收到完整的上游回答时可以继续读取、人工取回，即使本机程序未收到交付或已退出；没有完整回答时标为结果待核对或未完成。原程序是否正常结束单独保留，不把完整上游收据当作程序所有后处理都成功。

## 数据与留痕

- `data/codex-chat-tasks/<原请求>.json`：固定计划、程序/输入指纹、授权范围。
- 同编号的 `.sent.json`、`.response.json`、`.process.json`、`.stop.json`、`.end.json`：不可变收据。文件发布先写完整并同步，再建立唯一文件名；已有记录不被覆盖。
- `work-<原请求>/`：本次图片副本、独立程序运行目录及隔离策略。不是用户原项目目录；不自动清理或迁移到活动工具。
- `data/jobs/<原请求>.json`：供统一任务中心读取的运行摘要，完整原收据为权威依据。其他已有任务即使同编号也会拒绝覆盖。
- 项目“导出全部留痕”的 `.jhistory` 保存原输入/程序/授权、回答、任务与原参考图字节。恢复为新项目后只读展示，不安装活动CLI任务、账户、访问许可、Key或工作目录。工程-only备份不含任务历史的原语义保持。

## API

- `GET /api/codex-chats/program`：只读查找、版本/文件指纹能力，不执行程序或认证账户。
- `POST /api/codex-chats/preview`：projectId、platformId、model、text、可选systemPrompt/maxTokens/assetIds/nodeId/previousTaskId，返回plan/fingerprint/requestLimit=1。
- `POST /api/codex-chats`：另带固定requestId、原fingerprint、瞬时apiKey、consent:true，以及authorization的origin/model/sendPrompt:true/sendReferences/requestLimit:1/budget/currency。只接受当前指纹匹配的范围。
- `GET /api/codex-chats?projectId=...`、`GET /api/codex-chats/:id?projectId=...`：读取本工程原记录，不调用CLI或模型。
- `POST /api/codex-chats/:id/stop`：projectId；停止当前本机等待。
- `POST /api/codex-chats/:id/apply`：projectId、当前画布revision、placement:`bound`或`new`；只取回完整普通回答，原编辑冲突409。
- 原 `GET /api/jobs` 和单任务查询接入真实摘要；该类任务的通用resume入口拒绝自动重发。

## 容量与限制

当前只对本轮核对的macOS官方CLI提供执行，不把Windows/WSL、不同版本或不同CPU的真实运行列为通过。文字问题20000字符、系统指令16000、20轮/10万字上下文、最多20张PNG/JPEG/WebP（每张10MiB、合计18MiB原字节）；输出上限128–8192，保存回答最多20万字，Responses线数据8MiB、CLI输出2MiB。本服务实例最多同时等待两份CLI回答。输入超限、图片/程序/计划变化或旧任务编号冲突均先拒绝，不静默截断或覆盖。

本轮包含真实Codex执行、本机合成Responses返回、HTTP强制终止前后恢复、隔离系统探针、读写保护和本机浏览器操作；没有真实云模型生成，也没有检查CLI用户登录、用量或账单。手机/低动态/静态效果为Chrome模拟，实体设备未验。Codex原生生图/既有账户复用、Gemini/Antigravity生成与对话、CLI绑定到现有普通会话/语言节点自动调度，以及全参考功能仍需继续补齐。

实现参考固定版Infinite Canvas `main.py` 4918–4973、5468–5508的文字、历史和图片输入行为，运行模块独立编写，没有接入LibTV/RunningHub Agent。参数核对来自实际已安装程序的离线帮助及[OpenAI官方非交互说明](https://learn.chatgpt.com/docs/non-interactive-mode)、[官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。本轮只使用现有Node.js、Chrome/Playwright、macOS隔离、FFmpeg和项目内已有测试依赖，没有新增安装。
