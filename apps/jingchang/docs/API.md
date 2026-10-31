# 镜场 API 与平台接入

更新：2026-10-07。工作台默认 `http://127.0.0.1:4768`，当前只供本机使用。JSON 请求使用 `Content-Type: application/json`；本机浏览器访问有来源检查。错误返回 `{error: "中文说明"}`。没有登录令牌系统，也不应直接暴露到公网。

## 0.99 智能分支策略

原生智能循环节点可保存`params.nativeBranch={version:1,enabled:true}`；仅允许该类型及严格开关字段，旧节点无字段时默认关闭。仍通过现有项目PUT和修订冲突保护保存，不新增自动生成入口。界面先检查GET `/api/health`的`capabilities.nativeBranchRouting`，旧后端不能开启该操作。

GET `/api/projects/:id/canvas-run-plan`为只读；启用策略后逐轮步骤携带`nativeBranch`：loopId、roundIndex、候选/所选节点及excludedNodeIds。选择依据提交快照中的坐标、连线和实际计数；POST画布执行仍需原有确认、服务和云预算/发送范围。GET任务可读原收据，POST `/api/jobs/:id/resume`复核原收据和原子任务编号，篡改时先拒绝，不能随当前画布布局重选。GET原生输入/输出检查中的任务回合会报告相同分支收据，未选分支不会借用旧预览作为本轮结果。

策略作用于镜场明确的逐节点绑定执行链；源软件完整智能串联仍未全部迁移。含开关的工程/子图需要v36，整库包需要v4，旧格式无字段继续兼容；任何恢复都不隐式执行或恢复云端调用授权。

## 已可用的接口

| 方法与路径 | 用途 |
|---|---|
| GET `/api/health` | 服务版本、本机 Agent 配置状态与capabilities；nativeBranchRouting=true表示后端支持智能分支策略 |
| GET `/api/codex/status` | 只检查 PATH / `CODEX_BIN` 中是否有 Codex CLI；不执行 CLI 或验证账号 |
| GET `/api/gemini-cli/status` | 只检查 PATH / Gemini CLI 环境变量中是否有 Gemini/Antigravity CLI；不执行 CLI 或验证账号 |
| GET `/api/jimeng/status` | 只检查 PATH / `JIMENG_BIN` / `DREAMINA_BIN` 中是否有 `dreamina`；不执行 CLI、不登录、不查询积分 |
| GET/PUT `/api/config` | 本机语言模型、ComfyUI、修订号 |
| GET/PUT `/api/platforms` | API 平台、地址、模型及图片/对话/视频分类；不保存密钥 |
| POST `/api/platforms/discover` | 用本次密钥向已保存平台拉取 `/models` |
| GET/POST `/api/projects` | 列表、新建项目 |
| GET/PUT `/api/projects/:id` | 读取/保存；必须携带当前 revision，冲突为 409 |
| POST `/api/projects/:id/assets/archive` | `{assetIds:string[]}`；下载当前项目内1–100份素材的 ZIP（总计≤256 MB） |
| GET `/api/projects/:id/history` | 历史版本 |
| POST `/api/projects/:id/restore` | 恢复为新版本 |
| POST `/api/projects/:id/archive` | 以 revision 和 archived 设置回收站状态；不删除项目或媒体 |
| GET/POST `/api/assets` | 全局媒体索引、上传文件；上传请求体是原始二进制，name 放查询参数 |
| GET `/api/chrome-import/classification-models` | 仅镜场 Chrome 扩展可跨域读取；列出已保存的 OpenAI 兼容、支持图片输入的对话模型及其服务来源，不返回 Key |
| POST `/api/chrome-import` | 仅镜场 Chrome 扩展可跨域调用；以原始二进制保存用户选择的网页图片/视频到本机素材库，最多150 MB |
| GET `/api/assets/page` | 分页筛选；支持 `scope`、`type`、`category`、`search` 和 `smartClass=维度::标签`，并返回智能分类筛选项 |
| PATCH `/api/assets/:id` | 编辑名称、分类、标签 |
| GET/POST `/api/shared-folders` | 列出本机共享文件夹、注册或重新启用 `{path,name?}`；仅项目目录内的普通子目录，不接受项目根目录、隐藏目录或符号链接 |
| DELETE `/api/shared-folders/:id` | 停用入口并停止其运行中的本机导入；保留源文件、已导入副本和注册记录 |
| GET `/api/shared-folders/:id/tree` | 递归媒体树，返回类型、大小、相对路径及文件状态校验；最多扫描8000个目录/文件条目，不读隐藏文件、目录链接或非媒体 |
| GET/HEAD `/api/shared-folders/:id/file?path=...&fingerprint=...` | 从已校验的只读文件句柄预览或下载原文件，支持 Range 与后缀 Range；文件头、目录身份及可选预览校验不符时拒绝 |
| POST `/api/shared-folders/import` | `{requestId,projectId,folderId,category?,paths:[{path,fingerprint}]}`；每批1–200份、单媒体最多4GB，创建本机复制任务。路径也可用字符串，按本次实际文件状态记录；同一编号及同一输入只返回原任务 |
| GET `/api/shared-folder-imports?projectId=...` | 项目导入记录与实时接收进度；重启后只恢复原本机收据，不自动重新复制 |
| GET `/api/shared-folder-imports/:id?projectId=...` | 按原任务编号读取同一项目的完整结果、未完成原因及可继续状态 |
| POST `/api/shared-folder-imports/:id/resume` | `{projectId}`；仅明确操作后继续未完成项，校验原文件状态；已完成副本不再复制，原部分文件保留 |
| POST `/api/shared-folder-imports/:id/cancel` | `{projectId}`；停止本批，保留完成副本和部分接收文件 |
| POST `/api/shared-folder-imports/:id/apply` | `{projectId,revision}`；完整性与项目修订检查后，将已完成副本加入当前项目素材库；重复操作不重复关联 |
| GET `/api/asset-catalog` | 独立素材库、媒体/工作流分组、条目、回收状态、目录修订及本机位置；无已有记录时返回默认组织，不自动把旧素材分组 |
| POST `/api/asset-catalog/libraries` | `{name,revision}` 创建独立素材库，附带媒体与工作流分组 |
| PATCH `/api/asset-catalog/libraries/:id` | `{name,revision}`；只更新显示名称 |
| POST `/api/asset-catalog/libraries/:id/archive` | `{archived,revision}` 回收/恢复库；至少保留一个有效库；不删除文件 |
| POST `/api/asset-catalog/libraries/:id/folders` | `{name,type:media/workflow,revision}` 创建分组 |
| PATCH `/api/asset-catalog/libraries/:id/folders/:folderId` | `{name,revision}` 分组显示改名 |
| POST `/api/asset-catalog/libraries/:id/folders/:folderId/archive` | `{archived,revision}` 回收/恢复分组，保留目录及文件 |
| POST `/api/asset-catalog/copy` | `{projectId,libraryId,folderId,assetIds,requestId,revision}`；每批1–200份已有本机媒体，保存独立副本，任务类型`library-copy`；单媒体最多4GB |
| GET `/api/library-copies?projectId=…` | 本项目收藏批次；读取会协调已完成的本机收据，不重新复制 |
| GET `/api/library-copies/:id?projectId=…` | 任务状态、逐项字节进度、完成素材及是否可继续；原文件身份记录不返回客户端 |
| POST `/api/library-copies/:id/resume` | `{projectId}`；只继续未完成项，使用新的本机尝试编号；源媒体已变化时拒绝偷偷替换 |
| POST `/api/library-copies/:id/cancel` | `{projectId}` 停止本批，保留完成与部分接收文件 |
| POST `/api/library-copies/:id/apply` | `{projectId,revision}` 核对完成收据后加入项目；重复关联不增加修订 |
| POST `/api/asset-catalog/items/move` | `{ids,libraryId,folderId,revision}`；每批1–200份、保留条目和素材编号，媒体/工作流类型须一致，旧分组文件保留 |
| POST `/api/asset-catalog/items/archive` | `{ids,archived,revision}`；批量回收/恢复，不清理物理文件；恢复条目前须恢复其所属库和分组 |
| GET/PATCH `/api/asset-catalog/items/:id` | 详情或`{name,revision}`显示改名；媒体元数据名称仍可单独管理 |
| GET/HEAD `/api/asset-catalog/items/:id/download` | 普通本机原文件下载；ComfyUI模板为JSON，整项目快照和选中画布工作流为`.jingchang` |
| POST `/api/asset-catalog/workflows` | `{requestId,revision,libraryId,folderId,name,kind:comfy,workflowId}`复制已有ComfyUI模板；`kind:canvas,projectId,projectRevision`保存整个工程；`{kind:canvas-fragment,projectId,projectRevision,nodeIds}`保存所选子图及媒体依赖；不执行生成 |
| POST `/api/asset-catalog/workflows/import?...` | 原始`.jingchang`文件体；查询参数`requestId,revision,libraryId,folderId,name`。仅接收v22选中工作流，核验媒体后收藏进工作流分组，不创建项目或任务 |
| POST `/api/asset-catalog/items/:id/insert` | `{requestId,projectId,revision,x?,y?}`；把选中工作流追加到当前项目，返回`project,nodeIds,edgeIds,groupIds,assetIds,alreadyInserted`；保留原有内容，不自动生成 |
| GET `/api/asset-catalog/insertions?projectId=...` | 当前项目最近200份插入记录；只读取状态，不自动继续 |
| GET `/api/asset-catalog/insertions/:requestId?projectId=...` | 原请求的状态、插入编号、位置、错误及可继续标记；限定所属项目 |
| POST `/api/asset-catalog/items/:id/open-project` | `{requestId}`；核对画布快照、恢复为新项目，相同编号不会创建第二个项目；选中工作流可另用`/insert`追加到当前项目 |
| POST `/api/assets/:id/classify` | 由用户明确授权后，将一张 PNG/JPEG/WebP 图片发送给已保存的 OpenAI 兼容视觉对话模型分类；请求包含 `platformId`、`model`、一次性 `apiKey`（本机免认证模型可空）、`requestId`、`consent:true`、可选 `prompt` 和 `authorization:{origin,model,sendImage:true,requestLimit:1,budget,currency,consent:true}`。远程目标必须有非零预算。密钥不会写入素材或设置文件；结果只写入该图片元数据。平台可能实际扣费，预算字段不能限制平台扣费。失败/结果不确定时不要自动重试 |
| GET/HEAD `/media/:id` | 访问素材，支持 Range |
| GET `/api/prompts` | 提示词列表（包含当前修订号与版本数，不返回历史正文）；旧数据读取时兼容为 v1 |
| POST `/api/prompts` | 新建提示词（revision=1）；内容上限20,000字 |
| GET/PUT `/api/prompts/:id` | 读取或编辑提示词；PUT 必须携带当前 `revision`，成功后追加一个新版本，过期修订返回409 |
| GET `/api/prompts/:id/versions` | 按新到旧读取完整提示词版本历史 |
| POST `/api/prompts/:id/restore` | `{revision,currentRevision}`；恢复所选旧版本为一个新版本，不覆盖或删除历史 |
| POST `/api/prompts/:id/rewrite` | `{revision,instruction,consent:true}`；只向工作区配置的本机模型发送当前模板和改写要求，单次请求、不重试；结果作为草稿返回，不会自动保存 |
| GET `/api/skills` | 本地创作技能模板 |
| GET/POST `/api/templates` | 画布模板 |
| POST `/api/projects/:id/apply-skill` | 应用画布模板 |
| POST `/api/projects/:id/agent-plan` | 本地规则或本机语言模型生成操作计划 |
| POST `/api/projects/:id/apply-plan` | 按修订号检查并一次性应用计划 |
| GET `/api/projects/:id/preflight` | 画布输入检查 |
| GET/POST `/api/workflows` | 本机 ComfyUI API 工作流模板 |
| GET `/api/workflows/:id` | 模板与可编辑参数 |
| POST `/api/projects/:id/generate` | 提交本机 ComfyUI 工作流，可批量 1–8 次 |
| GET `/api/projects/:id/image-context?nodeId=...` | 预览画布上游文字、参考图候选 |
| POST `/api/projects/:id/generate-image` | 图片模型直接生成或参考图编辑，最多 1 次提交 |
| POST `/api/projects/:id/apply-generation` | 将生成任务的结果一次性加入项目 |
| GET `/api/jobs?projectId=...` | 当前项目任务列表 |
| GET `/api/jobs/:id` | 单任务状态与输出 |
| POST `/api/jobs/:id/cancel` | 停止本机等待，不保证上游停止计费或计算 |
| POST `/api/jobs/:id/resume` | ComfyUI / 画布链 / 本机渲染恢复；同步云请求无可查询编号时不重交 |
| GET `/api/projects/:id/render-plan` | 检查剪辑、实际媒体时长，返回逐镜与声音计划 |
| POST `/api/projects/:id/render` | `{requestId,revision}`；固定剪辑快照后在本机合成 |
| POST `/api/projects/:id/render-apply` | `{jobId,revision}`；将完成的MP4幂等加入项目和画布 |
| GET `/renders/:id` | 下载旧版本MP4 |
| GET `/renders/:id/:attempt/final.mp4`、`subtitles.srt` | 下载已完成尝试的成片及对应字幕；支持HEAD/Range |
| GET `/api/diagnostics` | 本机工具、CLI 可执行文件、素材完整性、文件位置检查；不调用云服务、不探测 CLI 账号或积分 |

Chrome 扩展跨域预检只允许镜场扩展来源访问健康检查、网页素材导入、上述模型清单及单张分类路径；导入和分类只接受 `POST`，模型清单只接受 `GET`，请求头限 `Content-Type`。扩展没有权限读取 `/api/platforms` 或其它本机 API。扩展里的 Key 由用户逐次输入，仅用于当前分类调用，不存入扩展存储；远程模型上传图片前必须有发送同意和正预算记录。

提示词模板正文支持 `{{hero}}` 形式的变量。变量名仅接受英文字母、数字与下划线，最多50个不同变量；使用模板时会逐项填写并在本机替换，不会调用模型。可选的 AI 改写仅使用用户工作区设置中的本机地址和模型，按钮每次需用户勾选同意；不发送 API Key，输出先供用户审阅，不自动写回。若本机地址连接转发服务，用户需确认该服务的数据转发方式。提示词历史最多保留200版，达到上限后会拒绝覆盖，避免静默删除旧历史。

## 0.4 新增接口

| 方法与路径 | 用途 |
|---|---|
| GET/POST `/api/studios` | 创作台列表、新建；可用 projectId 关联原项目，GET 可按 projectId 筛选 |
| GET/PUT `/api/studios/:id` | 创作参数、参考素材、布局；revision 防止覆盖，返回主项目 projectRevision |
| POST `/api/studio-models` | 本次密钥与 consent 拉取模型；GET 仅示例型号，不证明账户可用 |
| GET `/api/studios/:id/jobs` | 创作任务历史 |
| POST `/api/studios/:id/generate` | revision、唯一 requestId、apiKey、authorization 提交一次生成 |
| POST `/api/studios/:id/jobs/:jobId/resume` | 用临时密钥恢复原异步编号，绝不重交生成 |
| POST `/api/studios/:id/jobs/:jobId/cancel` | 停止本机等待；视频显式 cancelUpstream 才调用上游取消 |
| POST `/api/studios/:id/jobs/:jobId/apply` | 使用主项目 revision 回填结果；重复请求幂等 |
| POST `/api/media/crop` | assetId、整数 x/y/width/height；真实裁剪并返回新素材 |
| POST `/api/media/extract-frames` | assetId、times 秒数数组（1–12）；返回 assets 和 duration |

创作台数据在 `data/studios/<id>/studio.json`，其 projectId 对应 `data/projects/`，媒体仍共用 `data/assets/`。回填保留原画布节点并创建新的结果节点。同步图片支持 1/2/4 张、最多20参考图；异步图片只支持无参考、单张、自动质量、无透明背景。每次提交含正预算且只提交一次；有上游编号才能恢复查询。

ComfyUI 的 `/api/projects/:id/generate` 新增可选 `imageBindings: [{nodeId, name: "image", assetId}]`，最多16项。只支持当前项目 PNG/JPEG/WebP（单图≤10MB，去重总计≤80MB）映射到 LoadImage / LoadImageMask。映射字段不得再出现在 overrides；全部校验完成后才上传。上传 `type=input, overwrite=false`，保存映射，同素材多字段/批次复用；恢复原任务不再上传。

媒体处理仅读取本地素材库，保留源文件；裁剪坐标以原图像素计，抽帧时间须落在实际视频时长内。输出作为新素材入库，再由用户选择加入画布。

## 图片直接生成请求

先在 `/api/platforms` 保存一个 `openai-compatible` 平台，其 models 中包含 `category: "image"` 的模型。模型 ID 使用供应商实际值，不会把网页显示名当成模型 ID，也不会失败后自动切换模型。

`POST /api/projects/:id/generate-image`：

```json
{
  "requestId": "本次唯一编号",
  "revision": 3,
  "nodeId": "目标图片节点ID",
  "platformId": "已保存的平台ID",
  "model": "供应商模型ID",
  "size": "1536x864",
  "quality": "medium",
  "includeUpstream": true,
  "referenceIds": [],
  "apiKey": "仅在请求中传递的密钥",
  "authorization": {
    "origin": "https://api.example.com",
    "model": "供应商模型ID",
    "requestLimit": 1,
    "budget": 1,
    "currency": "CNY",
    "sendPrompt": true,
    "sendReferences": false
  }
}
```

- 提示词来自目标节点文字，以及选择带入的上游文本、剧本、角色和场景，不从未经保存的浏览器字段直接生成。
- 参考图须属于当前项目，最多 20 张 PNG/JPEG/WebP，每张不超过 10 MB；平台中的模型须明确启用参考图能力。
- 可选 `maskAssetId` 必须是当前项目图片编辑器为所选底图生成的遮罩，来源素材编号与底图必须一致，且解码后的像素尺寸必须相同。镜场遮罩是黑白灰度图（黑色保留、白色重绘）；发送前在内存中把底图转为 PNG，并把遮罩转为 PNG alpha 遮罩（黑色不透明保留、白色透明重绘），不改写原素材。
- 无参考图走 `/images/generations`；普通参考图编辑通过 multipart 传输并走 `/images/edits`；使用遮罩时走 `/images/edits` JSON，请求体使用 `images:[{image_url:"data:..."}]` 和 `mask:{image_url:"data:image/png;base64,..."}`，每次仍只生成一张。不发送 `127.0.0.1` 图片 URL 给云平台，不建立公网素材站点。该 JSON 形态依据 [OpenAI 图片编辑接口](https://developers.openai.com/api/reference/resources/images/methods/edit)；不同兼容平台需由用户按各自文档确认支持后，再在模型设置启用遮罩。
- 云端遮罩请求的本次授权必须明确包括遮罩；未确认支持或未同意发送遮罩时，请求在创建任务前拒绝。底图和遮罩都不超过 10 MB；遮罩素材须在当前项目中。
- 云端调用必须有对应服务、模型、数据发送范围和本次预算授权。预算是授权记录，工作台无法替供应商执行扣费上限，实际费用需在平台核对。
- `apiKey` 只用于当次请求，不写配置、项目、历史或任务文件，不回显给客户端。重新打开面板需要重新输入。
- 每个请求只发起一次模型提交；同一项目的相同 requestId 返回已有记录，并发提交也不会重复创建任务。同一项目已有直接图片生成任务时，新的不同请求返回 409。网络中断、超时、页面关闭或服务重启不触发自动重试。
- 提交后遇到平台 5xx、错误响应内容或图片下载失败，会标记结果不确定：上游可能已经生成或扣费。须先检查平台任务和账单；明确的 400/401/403/429 拒绝与此状态区分。
- 返回 202 与任务编号，随后通过任务查询读取。直接图片 API 是同步上游协议；镜场将它封装成本机后台任务，不等于供应商异步协议。
- 结果先存全局素材库；`apply-generation` 才加入画布。目标节点在生成期间被改动时，新结果作为新节点保存。

## 协议覆盖

| 协议 | 当前状态 |
|---|---|
| 本机 Chat Completions | 已支持自主 Agent 规划 |
| OpenAI 兼容 Images | 已实现文生图、参考图编辑、拉取模型；模拟服务验收，不等于全部中转兼容 |
| 本机 ComfyUI | 已实现 API 工作流、参数、图片输入映射、批次、查询、输出 |
| 创作台特定视频/异步图片协议 | 已实现 videos/generations、videos/edits、videos/extensions、videos/jobs、images/generations/async、images/tasks；仅本机模拟协议验收，不等于 APIMart/方舟/RunningHub |
| Chat Completions / 图文对话 | 独立会话已实现文字、项目图片、视频抽样和上下文、任务与回答入画布；模拟服务验收 |
| ModelScope 异步 | 已实现文字单图、1–3参考图编辑、LoRA、专用请求头与 tasks 查询；更多参数与真实平台验收待完成 |
| APIMart 异步图片/视频 | 已实现 GPT-Image-2 参考图/多图与 Seedance 2.0 文字/公网首尾帧、`/tasks` 查询恢复；其他模型/视频本地媒体尚未覆盖 |
| Gemini 原生图片 | 已实现 generateContent、x-goog-api-key、inlineData、单图/参考图和原生模型发现；同步请求无任务恢复 |
| RunningHub 应用/工作流 | 已实现字段、上传、执行、v2 查询、恢复与入库；本机模拟验收，不调用其 Agent |
| 火山方舟视频 / Seedance | 已实现任务提交/查询、文字/单图/首尾帧、0.81显式Seedance 2.0多素材参考、结果下载与回填；0.82 AK/SK URL素材库、0.83临时托管连接、0.84本机已有火山配置已通过本机模拟验收；真人授权素材与真实账号/托管/新镜场付费生成未验收 |

使用者文档中的名称用于功能对照，未把协议名加入选择器来冒充支持。

实现参考：[OpenAI 官方图片生成文档](https://developers.openai.com/api/docs/guides/image-generation)、[GPT Image 2 模型文档](https://developers.openai.com/api/docs/models/gpt-image-2)。模型可用性、尺寸、权限和实际价格仍由所选平台决定。


## 0.5：对话与自动执行

| 方法与路径 | 用途 |
|---|---|
| GET `/api/conversations?projectId=...` | 当前项目独立会话列表 |
| POST `/api/conversations` | projectId、可选 name 新建对话 |
| GET/PUT `/api/conversations/:id` | 获取会话；PUT 使用 revision 与 name 重命名 |
| POST `/api/conversations/:id/messages` | revision、requestId、platformId、model、text、assetIds、apiKey、authorization，返回任务 |
| POST `/api/conversations/:id/apply` | messageId、主项目 revision；把模型回答幂等加入画布 |
| GET `/api/projects/:id/canvas-run-plan` | 校验并预览已绑定的工作流顺序，无生成调用 |
| POST `/api/projects/:id/canvas-run` | revision、requestId、consent:true、可选backendId，执行所选ComfyUI后端的工作流依赖图 |

文字对话使用已保存的 openai-compatible 平台和 chat 分类模型。参考图要求模型 referenceSupport=true；发送最近20条消息及其中图片，明确授权包含历史图片。每条用户消息最多20份图片/视频，视频最多3份，每图10MB以内，总编码图片上下文不超过24MB，文字上下文10万字以内。任务 kind=conversation，取消走现有 jobs/cancel，无自动重试或生成恢复；任务与会话历史保留。0.12增加上游SSE流式读取与本地任务增量快照，详见后文；不执行模型回答中的代码/工具指令。

节点 `params.workflowBinding` 保存 workflowId、overrides、imageSources、promptField、count、incrementSeeds。imageSources 使用 `{nodeId,name:"image",assetId}` 或 `{nodeId,name:"image",sourceNodeId}`；动态 sourceNodeId 必须是相连的上游图片节点。promptField 指定接收有序上游文字和当前节点文字的 ComfyUI string 字段，不可与 overrides 重复。

画布执行任务 kind=canvas-run，使用项目快照和持久化子任务编号；最多32个生成节点、64次计算。失败阻止后续提交，恢复查询原子任务，未提交的后续节点继续执行；已提交但无编号的子任务不重发。结果通过既有 apply-generation 进入主项目，作为新节点保留原有编辑。不是任意循环执行器；0.13新增已明确绑定和授权的RunningHub应用/工作流节点，其他云协议仍未接入。

创作台 config.protocol 支持 studio（原有协议）、modelscope、ark；缺省 studio 保持旧项目兼容。modelscope 须为 image + imageAsync=true、单张、自动质量、不透明且无参考图，config.loras 最多6项，权重合计1，尺寸采用模型默认值。ark 须为 video + operation=generate，0–2张图片按首帧/尾帧角色传递；不发送原创作台的 videos/uploads 请求。本机图片编码到请求中，结果链接下载不附带 API Key、不跟随重定向，公网响应禁止指向内网。实际模型可能不接受部分时长/分辨率/音频参数，上游明确拒绝后需手动调整，不自动重试。

协议依据：[ModelScope 官方模型页 API 示例](https://modelscope.cn/models/Qwen/Qwen-Image-2.1/summary)、[火山方舟创建视频任务](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh&redirect=1)、[方舟官方 SDK 任务结构](https://github.com/volcengine/volcengine-go-sdk/blob/master/service/arkruntime/model/content_generation.go)。这里只实现明确读取到的接口字段，没有复制上游 Infinite Canvas 实现。


## 0.6：Gemini 与 APIMart

新增 `config.protocol: gemini | apimart` 与 `config.imageResolution: 1k | 2k | 4k`（默认1k，APIMart图片专用）。旧项目缺省值不变，保存时保留已选协议。

- **Gemini**：image、imageAsync=false、count=1、quality=auto、transparent=false；model 为不含路径的 gemini 模型ID。POST `models/{model}:generateContent`，密钥仅在 `x-goog-api-key` 请求头，提示词和校验后的图片编码为 contents.parts，responseModalities 为 TEXT/IMAGE，ratio 映射 imageConfig.aspectRatio。忽略 thought 内部预览图；无最终图片或响应未知不自动重试。原生 `/models` 只展示本次返回的一页并明确提示，可手填其他模型。UI 模型发现请求增加 `protocol` 字段。
- **APIMart 图片**：image、imageAsync=true；当前仅 gpt-image-2 / gpt-image-2-ext。POST `images/generations`，n=1/2/4，ratio 映射 size，imageResolution 映射 resolution；PNG/JPEG/WebP 图片编码为 image_urls data URI。每张输入最多10MB、最多4张；请求整体受48MB限制。未适配的质量与透明参数拒绝提交。
- **APIMart 视频**：video、operation=generate；当前仅 doubao-seedance-2.0 / doubao-seedance-2.0-fast。POST `videos/generations`，duration=5–15、resolution=480p/720p、size、generate_audio；最多两张 HTTPS URL 映射 image_with_roles 的 first_frame/last_frame。未核实的本地图片转换、视频/音频参考、素材库不发送。
- APIMart 从单个 data 条目读取 task_id；GET `tasks/{id}` 必须返回同一任务的 data.id；处理 pending/processing/completed/failed/cancelled。结果解析 result.images / result.videos 的 url 字符串或数组；图片数量须匹配，视频须为单个。下载不附带密钥，不跟随重定向，云端结果不可访问内网。
- 授权、请求ID去重、停止、原编号恢复、项目版本保护、结果回填沿用既有创作台。Gemini 无异步编号，不提供伪恢复；APIMart 停止仅停止本机查询，不调用未适配的上游取消接口。

核对的官方来源（2026-09-28）：[Gemini 图片生成](https://ai.google.dev/gemini-api/docs/generate-content/image-generation)、[APIMart GPT-Image-2](https://docs.apimart.ai/en/api-reference/images/gpt-image-2/generation)、[APIMart 任务状态](https://docs.apimart.ai/en/api-reference/tasks/status)、[APIMart Seedance 2.0](https://docs.apimart.ai/cn/api-reference/videos/doubao-seedance-2-0/generation)。视频文档部分页面抓取失败，使用官方已索引字段证据，因此仅接入已核实子集。未调用真实上游。

## 0.7：RunningHub 云工作流

- GET/POST `/api/cloud-workflows`：列表（`projectId`）与创建。GET/PUT `/api/cloud-workflows/:id`：读取/按 `revision` 保存。配置包含 `projectId,name,kind:app|workflow,targetId,baseUrl,fields`，ID 为数字字符串，地址为 API 根地址。
- POST `/api/cloud-workflows/discover`：`kind,targetId,baseUrl,apiKey,consent:true`；拉取应用 nodeInfoList 或工作流 API JSON，只解析字段，不执行上游 curl 示例。
- GET `/api/cloud-workflows/:id/jobs`；POST `/:id/run` 提交 `revision,requestId,apiKey,authorization`；POST `/:id/jobs/:jobId/resume` 仅带本次 `apiKey`；POST `/:id/jobs/:jobId/apply` 带主项目 `revision`。停止使用既有 `/api/jobs/:jobId/cancel`。
- `fields` 为最多200项 `{nodeId,fieldName,fieldValue,type,label,options,source,assetId?}`。type 支持 text/number/boolean/select/image/video/audio；source 为 value 或 asset。媒体映射最多8份项目素材；图片 PNG/JPEG/WebP≤10MB，视频 MP4/MOV、音频 MP3/WAV/FLAC≤30MB。重复映射只上传一次，验证文件头后再提交。
- 授权记录为 `{origin,targetId,kind,requestLimit:1,sendFields:true,sendAssets:boolean,budget,currency}`。预算为正数，币种 CNY/USD；不是平台扣费强制上限。密钥不写入配置/任务，字段禁止凭据；含密钥的上游返回不保存。
- 应用元数据按官方 GET 参数发送临时 Key；其余提交/上传使用官方请求体，v2 查询使用 Bearer 请求头。下载不带凭据、不跟随重定向，云端下载不访问内网。
- 相同 requestId 不重复提交；停止只停止本机等待。已知编号可恢复，已下载部分不会重复入库；未知提交不会重试。结果支持 png/jpg/jpeg/webp/mp4/mov/mp3/wav/flac，其他格式明确失败并保留已下载结果。

核对的官方文档（2026-09-28）：[应用字段](https://www.runninghub.cn/runninghub-api-doc-cn/api-425749011)、[工作流字段](https://www.runninghub.cn/runninghub-api-doc-cn/api-425749014)、[应用提交](https://rhtv.runninghub.cn/runninghub-api-doc-cn/api-425749010)、[工作流提交](https://rhtv.runninghub.cn/runninghub-api-doc-cn/api-425749013)、[媒体上传](https://pre.runninghub.ai/runninghub-api-doc-en/api-425761099)、[v2任务查询](https://www.runninghub.cn/runninghub-api-doc-cn/api-425767306)。部分页面读取超时，字段根据官方已索引内容核对；真实平台尚未调用。

## 0.8：项目完整备份

| 方法与路径 | 用途 |
|---|---|
| POST `/api/projects/:id/bundle` | `{revision}` 创建快照与本地媒体包，返回清单、编号和下载URL |
| GET/HEAD `/api/project-bundles/exports/:id/download` | 下载已经校验完成的包，支持 Range |
| POST `/api/project-bundles/inspect` | 原始文件体 `application/octet-stream` 上传 `.jingchang`，预检后返回导入编号及清单 |
| POST `/api/project-bundles/:id/import` | 再次核验已上传包，创建新项目；相同导入编号重复确认返回同一项目 |

文件格式为17字节 `JINGCHANG-PACK-1\n`、4字节大端清单长度、UTF-8 JSON 清单、按清单顺序紧接的原始媒体字节。不压缩、不解压路径、不执行包内工作流。清单 format=`jingchang-bundle`、version=1，包含 project/assets/workflows/cloudWorkflows/studios/conversations；每个asset含size与SHA-256。最多1000素材，每文件150MB，总媒体512MB，清单12MB。

配置在落盘前检查类型、编号、凭据字段及引用；所有媒体必须长度和SHA-256一致，导入确认时再次检查。只读本机普通素材文件，不跟随符号链接；缺文件、错误引用、未知版本、重复编号、额外/截断字节均报错。清单校验值用于完整性，不证明发送者身份。

新项目、新素材和新工作流各用新编号，画布内节点编号保持本地作用域；所有已支持素材引用、工作流绑定、创作台和对话图片同时改写。恢复不启动模型，不复制历史任务/授权、密钥、模型文件和全局API设置。公网引用只保留地址，不联网下载。独立ComfyUI模板只有已绑定到项目节点的被收录。

备份位于 `data/bundles/exports/<id>/project.jingchang`；本机接收副本位于 `data/bundles/imports/<id>/`，包括 preview/plan/result 记录。文件保留，不自动清理；清单不合规的上传在创建包文件前拒绝。媒体损坏/传输中断可能留下未完成包，但不能确认导入。

## 0.9：ComfyUI 字段表单

`PUT /api/workflows/:id/config` 接收 `{revision,fields}`，保存新修订；不改原始 workflow。旧模板视为 revision=0、fields=[]，沿用旧行为。旧版字段配置留存于 `data/workflows/history/<id>/`，没有删除历史。

每项 `{nodeId,name,label,help,control,exposed,defaultValue,min?,max?,step?,options?}`：

- string：text/textarea/select；number：number/slider/select；boolean：switch。与原API图中的标量字段类型严格一致，不把连线数组暴露成参数。
- 下拉1–200项，值同类型、不重复，默认值必须在选项中。slider 必须有有限 min/max/正step，min<max。数值默认值与覆盖值都验证范围和步长；number可不设范围。
- exposed=false 隐藏于运行表单并使用默认值，运行覆盖及图片映射不能绕过隐藏设置。不存在、重复、带凭据或类型不符字段会拒绝。
- 最多1000项，label 1–120字、help≤500字。保存使用修订冲突保护；运行可带workflowRevision，过期时409。
- 单次运行、画布执行预检、逐节点提交均检查配置。批次递增seed/noise_seed的每个值在第一次提交前验证，不先跑部分批次再发现越界。
- 保存模板原图不变；实际提交按默认值加本次覆盖构建。节点绑定不会因全局表单修改而悄悄改写，旧参数不合法时要求重新配置。
- 完整备份包含并验证fields，导入后新工作流恢复默认值、控件和约束；没有配置的旧备份仍可导入。

## 0.10：ComfyUI 音视频输入

`POST /api/projects/:id/generate` 新增 `mediaBindings:[{nodeId,name,assetId}]`；旧 `imageBindings` 继续兼容，不能同时传两者。持久任务及节点绑定的历史字段名 `imageBindings` / `imageSources` 保留，但现在可承载已识别的音视频输入，完整备份一并重关联。

识别：LoadImage/LoadImageMask.image→图片；LoadVideo.file→视频；LoadAudio.audio→音频或视频。字段设置还可用`mediaKind:none|image|video|audio`把任意工作流字符串输入显式标为普通文字或媒体字段。保存设置后，直接生成和画布动态映射共用相同规则；动态sourceNodeId必须来自连线上游，类型须匹配，并取首份生成结果。mediaKind仅接受字符串字段，映射媒体时不能再配置下拉选项。

文件按本地普通文件、元数据、大小、文件头和扩展名核对后上传，图片≤10MB，音视频≤150MB，每批≤16映射/300MB不重复文件。音视频格式MP4/MOV/WebM/WAV/MP3/FLAC/OGG/M4A；文件头校验不等于完整解码验证。ComfyUI仍可能因编码、音轨或插件问题拒绝。

媒体共用 `/upload/image` 的 multipart image字段，type=input、overwrite=false；不覆盖ComfyUI已有文件，不重复自动上传。返回文件名和subfolder校验后写入指定输入字段；单个任务跨字段/批次复用相同上传结果。媒体上传超时120秒；提交不确定时不自动重发；恢复只按原prompt_id查询。

## 0.38：自定义工作流媒体字段

工作流字段配置项可带 `mediaKind: "none" | "image" | "video" | "audio"`。仅允许映射原始类型为 string 的输入；带媒体类型时不能使用 select 控件。省略该属性时兼容旧模板和三个内置 ComfyUI 映射。直接生成的 `mediaBindings` / 兼容 `imageBindings`、画布节点的固定/动态 `imageSources` 都按保存的字段设置校验；历史字段名继续保留以兼容既有项目及备份。工作流配置历史与现有完整项目备份沿用原格式。

本轮核对官方源码：[上传接口](https://github.com/Comfy-Org/ComfyUI/blob/master/server.py)、[LoadVideo](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_video.py)、[LoadAudio](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_audio.py)。读取日期2026-09-28；独立适配，没有复制上游实现。只连接既有本机服务，未增加LAN或公网目的地。

## 多 ComfyUI 后端（0.11）

- `GET /api/comfy-backends`：`{revision,backends:[{id,name,url,network,lanAuthorized?}],activeId}`。旧单一comfyUrl自动呈现一个默认条目，无启动写入。
- `PUT /api/comfy-backends`：传revision、1–16个backends与activeId。新/变更局域网URL须在`lanConsentUrls`数组中按完整规范化地址确认。地址和id均不可重复；版本冲突409。不清除原语言模型配置，与旧配置入口共用写锁。
- `POST /api/comfy-backends/probe`：`{backendId,consent:true}`；仅接受已保存后端，GET `/system_stats`，5秒超时/1MB上限，无生成；失败不返回上游响应正文。
- `POST /api/projects/:id/generate` 和 `/canvas-run` 新增可选backendId；省略使用默认。客户端不能直接指定任意endpoint对象。原始字符串调用仍只允许loopback，局域网需要已保存且确认的后端记录。
- 作业保存实际endpoint快照，公开返回`backend:{id,name,url}`；恢复使用原快照，即使该地址已从列表移出。无自动切换或重投。整个画布任务选择一个后端，子任务继承。
- 仅本机和RFC1918私有IPv4，拒绝公网/自定义域名/链路本地/元数据地址/URL凭据/查询参数。禁用HTTP重定向。旧`PUT /api/config`保留兼容，可修改本机默认地址；新增LAN需使用后端管理入口。

本机模拟服务证明路由、状态读取、恢复与配置边界；不证明真实LAN网络、ComfyUI模型/插件或GPU可用。

## 流式对话与片段恢复（0.12）

`POST /api/conversations/:id/messages`新增`stream:boolean`（API省略保持非流式；页面默认true），`maxTokens`128–8192，默认4096。授权、一次性Key和requestId幂等规则不变。上游仅提交一次`chat/completions`，流式模式传stream:true。

- 服务端解析`text/event-stream`中的choices[0].delta.content/refusal，兼容UTF8跨字节分块、CR/LF/CRLF、注释、空choices与DONE；不执行tools。不回显上游错误正文。若同一次响应为JSON，则按普通回答解析，不触发回退请求。
- 总流最多4MB，事件最多512KB，文本最多20万字，180秒期限。跨分块返回的当前密钥在展示/写盘前隐藏；密钥前缀在尚未收齐时暂缓展示，中断尾缀标记已隐藏。
- 任务新增`stream`、`outputText`和`finishReason`。运行中的文字最多约每250ms原子保存一次；页面每350ms读取本地任务快照并更新文字。浏览器不是直接接收供应商SSE，不持有上游密钥；刷新只读本地状态。
- 正常stop/DONE完成；length/content_filter等标记`status:incomplete`，连接异常failed、主动停止cancelled。收到的片段作为assistant消息保存`state:incomplete`；后续上下文过滤片段后取最近20条。
- `/apply`对未完成片段要求`acceptIncomplete:true`；画布节点标题标明片段。完整备份导入保留state，不将片段变成完整回答。
- 服务重启先将运行任务标记interrupted并注明结果不确定，再把已有outputText协调到会话一次。不会续接上游流或重新生成；突然终止可能丢失上一次250ms快照之后的尾部。缺失/损坏对话文件不删除任务中的文字。

协议依据：[OpenAI官方流式指南](https://developers.openai.com/api/docs/guides/streaming-responses)、[Chat Completions流式事件](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events)。本轮未接入Responses API、原生Gemini会话或音视频输入；没有真实云端调用。

## RunningHub与ComfyUI混合画布执行（0.13）

媒体节点新增`params.cloudBinding={recipeId,recipeRevision,inputs}`，和workflowBinding互斥。每个映射为`{nodeId,fieldName,useText:true}`或`{nodeId,fieldName,sourceNodeId}`。文字为当前及所有祖先节点文字（1–20000字）；媒体要求连线上游且类型一致。其他字段沿用已保存云配置。recipeRevision过期、跨项目配置、重复/非法字段和无来源素材在计划阶段拒绝。

- plan返回kind为comfy或runninghub的有序步骤。云步骤包含无凭据的recipe快照、inputs、sendAssets；默认仅预览，不访问供应商。静态媒体本地预检；每云节点最多8项不同引用，真实运行再检查生成结果归属/大小/类型。
- canvas-run新增`cloudCredentials:[{nodeId,apiKey,authorization}]`。每个云节点authorization须匹配origin、targetId、kind、requestLimit:1、sendFields:true、sendAssets，以及正budget/CNY或USD。所有云节点授权必须在任意本机或云端执行前通过；密钥不写入步骤、快照、配置或任务。
- 整体最多32个生成节点、64次生成；RunningHub节点每次1个任务，ComfyUI保留1–8批次。生成输出选择首个与目标节点类型匹配的素材传下游，其余输出保留入库。
- 内部云子任务保存parentJobId和稳定requestId，只有运行中的同项目画布可调起内部入口；HTTP接口不能提供内部执行上下文。停止父任务传递取消信号给云子任务。
- `POST /api/jobs/:id/resume`对含未完成云步骤的画布任务要求重新提供`cloudCredentials:[{nodeId,apiKey}]`。继续原有已记录授权和快照；有编号的云任务查询/下载原结果，没有编号且先前创建了子任务的不重交；尚未开始的后续步骤继续执行。
- 0.13以前纯ComfyUI画布作业可沿用原任务结构恢复。完整备份校验云配置引用/版本，导入重新关联recipeId并把绑定revision同步到新配置0，动态sourceNodeId保留。

真实云账户、费用与权限未验收。运行密钥在本次父子任务内存中暂存，停止/结束清除；服务重启后必须重新输入。直接图片、方舟、ModelScope、Gemini、APIMart等尚未成为此画布调度器的节点；不等同已实现任意供应商混合图。

## 画布交互（0.14）

未增加服务路由；仍以带revision的项目PUT持久化节点和边。`connectionError(project,source,target)`供点选与拖拽共用，拒绝缺失节点、自身、重复及循环连接。服务端项目图校验保持启用。`copySelectedNodes`同时重映射选区内ComfyUI `workflowBinding.imageSources[].sourceNodeId` 与云 `cloudBinding.inputs[].sourceNodeId`，不改recipeId、工作流内部nodeId、素材id及选区外引用。复制不发起生成。

## 宫格图片处理（0.15）

- `POST /api/media/grid-split`：`{assetId,rows:3,columns:3,margin:0,gap:0,indices?}`。行列各1–8；margin/gap为0–4096整数。indices为不重复的从0开始按行排列的编号，缺省导出全部；不可空数组。依据FFprobe实际尺寸计算整数分区，余数分散到各格。返回`{assets,width,height,rows,columns}`，输出顺序固定按行排列。每项包含`operation:grid-split`、`sourceAssetId`及`grid:{rows,columns,margin,gap,index,row,column,x,y,width,height}`。
- `POST /api/media/grid-compose`：`{assetIds,columns:3,tileWidth:512,tileHeight:512,margin:0,gap:0,fit:contain,background:#00000000}`。1–64张本地图片，编号可重复以重复使用素材；列1–8、行不超过8、每格尺寸1–4096、margin/gap整数0–4096。fit取`contain/cover/stretch`，background为`#RRGGBB`或`#RRGGBBAA`。返回新PNG素材，包含`operation:grid-compose`、顺序保留的`sourceAssetIds`及拼接参数。输出最多16777216像素，单边8192；输入解码总像素最多67108864。
- 两种处理共享既有媒体工具最多2项并发、严格本地素材校验、格式白名单和FFmpeg命令超时。所有拼接输入完成校验后才开始输出。动画素材取首帧；不执行模型、远程下载或云上传。原始文件和处理目录均保留。
- 本轮保持同步HTTP处理；关闭网页不取消已开始的处理，已完成的素材仍在全局素材库；没有任务中心进度或跨进程恢复。后续步骤失败时，已经保存的格子仍可从素材库找回。批量加入画布沿用带revision的项目保存和撤销，不替换原节点。

## 本机图片编辑（0.16）

- `GET /api/media/editor-source?assetId=...`：严格读取本地图片，经FFmpeg输出统一PNG首帧预览。使用原始像素方向，浏览器预览和后端编辑均从同一方向开始。预览只存处理目录，不新增素材记录。
- `POST /api/media/image-edit`：`{assetId,operations}`；返回`{image,mask,input,editId}`三份PNG素材和记录编号。元数据带`sourceAssetId/editId/editOutput`。`GET /api/image-edits/:id`读取已保存的源图、原尺寸、最终尺寸、规范化操作和输出编号。
- 笔画类型`paint/erase/mask/unmask`使用`{type,size,opacity,hardness,points:[[x,y],...]}`，paint另需`color:#RRGGBB`。size为1–512原图像素，opacity为0.01–1，hardness为0–1。eraser只处理画笔层，mask/unmask改变重绘范围；坐标对应该步骤执行时的画布。
- `mask-rect`使用`x,y,width,height`整数；`mask-clear/mask-all/mask-invert`不带参数；`expand`使用`left,top,right,bottom`整数0–4096，至少一项非零。新边界透明且遮罩为255，原图/笔画/遮罩同步平移。
- 每次最多500步、总20000坐标点，单步最多5000点；单边8192、总16777216像素，并限制笔刷计算量。未知工具、非法坐标/颜色/尺寸和过量计算在输出前拒绝。规范化丢弃未知字段。
- 后端独立Worker执行像素合成，30秒上限，与既有媒体工具共享最多2项并发；FFmpeg保存三份真实PNG。原图不改变，处理中间文件保留。记录以新ID写入`data/image-edits/`；每次保存创建新版本，不覆盖旧记录。
- 三种输出：image为原图+绘制层；mask为不透明灰度，0保留/255重绘；input保留图像RGB并将重绘区alpha降低。源图原有透明区域初始进入遮罩。LoadImage使用`1-alpha`，LoadImageMask的red读取灰度而alpha读取`1-alpha`，依据[ComfyUI官方实现](https://github.com/comfyanonymous/ComfyUI/blob/master/nodes.py)。模拟服务验证上传字节和通道参数，未运行真实GPU。
- 输出沿用现有资产/项目/工作流接口；0.17起编辑记录随`.jingchang`备份迁移。同步HTTP处理关闭页面后仍可完成；没有服务重启后继续未完成编辑保存的作业机制。未点击保存的UI笔画不持久化。

## 可编辑图片备份（0.17）

- 备份容器头仍为`JINGCHANG-PACK-1`；没有编辑记录时清单`version:1`，含编辑记录时为`version:2`。0.18读取兼容1/2/3，1不能携带非空imageEdits；含全景视角时使用3（见下节）。旧版读取器会明确拒绝2，避免静默丢失记录。
- 清单增加`imageEdits:[{id,version:1,sourceAssetId,sourceWidth,sourceHeight,width,height,operations,outputs:{image,mask,input}}]`。相关素材保留`editId/editOutput/sourceAssetId/operation/width/height`。导出遍历项目和已支持工作流/创作台/对话引用的素材，递归收集编辑原图和全部三个输出，直到依赖齐全。工作区无关编辑记录不被收录。
- 清单规范化复用编辑引擎的操作/尺寸/计算量限制，验证记录和输出一一对应、原图存在、输出种类、尺寸一致及依赖无环；PNG读取真实文件头再次验证尺寸；媒体仍逐文件SHA-256和长度校验。缺失依赖拒绝导出，不静默转成仅成品的备份。
- 导入计划持久化`imageEdits`旧/新ID映射，与素材、项目一起重关联。记录写入`data/image-edits/`，outputs/sourceAssetId及资产editId均更新；已有导入计划重试沿用ID。目标记录若发生冲突拒绝覆盖，已存在且与本次导入完全一致的记录复用。
- `/bundle`导出、`/inspect`预览增加`imageEdits`计数及`formatVersion`。图片原图和三种输出都会计入assets/bytes，因此备份素材数可以多于画布中显示的图片数。仍遵守12MB清单、512MB媒体、1000份素材限制。
- 导入不执行编辑渲染、不提交模型；之后手动打开编辑器才加载原图并回放笔画。未保存的窗口操作、无关编辑分支不迁移；旧v1包缺失的笔画无法凭成品重建。

## 全景视角（0.18）

- `POST /api/media/panorama`：传`assetId`及可选`width,height,yaw,pitch,roll,fov`，仅接收本机已登记图片。默认1280×720、水平/俯仰/旋转均0°、水平视野90°。宽高为16–4096整数、总像素不超过8,388,608；水平/旋转-180–180°，俯仰-90–90°，视野20–120°。
- 原图宽高至少8×4，单边不超过8192、总像素不超过16,777,216，宽高比与2之差不超过0.02。FFmpeg解码首帧、不自动旋转，再由独立Worker完成透视投影和双线性采样；水平接缝环绕、极点钳制、透明像素按预乘alpha插值。Worker超时30秒，与媒体工具共享最多2项并发。
- 输出真实PNG素材，含`operation:panorama,sourceAssetId,sourceWidth,sourceHeight,width,height,panorama:{width,height,yaw,pitch,roll,fov}`。原文件不改变，结果留在素材库；应用到画布由已有项目更新接口完成。预览在浏览器Worker内执行同一投影实现，不发送至第三方。
- 含全景素材的完整备份清单为`version:3`，递归携带原全景图，可与图片编辑依赖链混合。读取兼容1–3；全景记录不允许降级为1/2。校验参数、源/输出尺寸、实际PNG头、源图存在及混合依赖无环。导入重写`sourceAssetId`，原机位参数保留。预览summary含`panoramas`数量。

## 会话图片模式（0.19）

`POST /api/conversations/:id/messages`新增`mode:chat|image`，默认chat。image使用已保存平台的image分类模型，沿用revision/requestId、一次性apiKey、完整authorization；即使本机模拟服务也需请求级正预算确认。新增`size`（默认auto或`宽x高`）与`quality:auto|low|medium|high`。流式显示和maxTokens只影响文字对话。

- 图片模式只把当前text和显式assetIds发送到`images/generations`或`images/edits`，n固定1；最多3张10MB以内本地PNG/JPEG/WebP，校验实际字节、大小、普通文件和模型referenceSupport。尺寸预设只换算参数，不保证所有模型均接受这些尺寸。
- 任务kind为`conversation-image`，存input、requestCount、授权范围、用户消息快照和本地结果素材，不保存Key。文字与图片共用单会话并发门禁。任务先记账再保存会话；已有requestId返回原任务，索引缺失时从原任务补回，不重新发送。
- 已保存图片写入assistant消息`mode:image,assetIds`。会话回画布接口为这些素材创建图片节点并保留原描述；按messageId幂等。图片被继续引用时生成新的任务和素材。
- `/api/jobs/:id/cancel`停止本机等待，不取消上游或自动重发。重启只恢复本地已保存图片和消息；有结果但任务不完整时标记incomplete，放回画布需要acceptIncomplete确认。无上游任务编号的同步接口不能伪恢复查询。
- 后续chat上下文包含完整图片消息；生成图片以user多模态内容表示，避免向兼容接口提交assistant图片内容。未完成消息不自动进入上下文。授权需覆盖历史和当前图片。
- 上传/拖入/粘贴沿用本机素材接口，尚未确认生成时不向上游发送。完整备份保留image模式与素材引用，并在导入时重关联编号；不携带密钥或生成任务。

## ComfyUI提示词列表（0.20）

`POST /api/projects/:id/generate`新增`promptBatch:{nodeId,name,values:string[]}`。values为1–64项非空文字，每项≤32000字、总计≤256000字；只能映射到非媒体输入的文字字段，并遵守字段显隐和下拉约束。未传count时自动取列表长度，传入时必须一致；未使用列表仍为1–8次重复。可选revision检查项目版本，workflowRevision检查字段版本，requestId用于提交去重。

- admission按项目串行，仅串行接纳检查，不阻塞任务执行。整个列表和所有递增seed先校验再上传/提交，安全整数溢出拒绝。保存基础工作流快照及promptBatch，不修改模板。
- 每项独立`items[index]`，记录prompt、promptId、状态和素材；job.assets带batchIndex。按顺序提交，失败停止后续项。媒体仍只上传一次。
- `canResume`表示取消/中断后能否沿原编号继续，或是否仅剩从未提交的项。存在submitting但无promptId时拒绝恢复，不能把未知结果当未提交。已经完成的项不重新运行。服务重启沿用任务中的工作流快照、列表与后端。
- `workflowBinding.promptBatch`保存节点配置；整图plan/start预检1–64列表项及整图64次上限。列表目标字段不能与promptField上游文字自动映射重合。整图子任务记录workflowRevision，字段更改时阻止后续节点使用新配置悄悄运行。下游仍取首份匹配媒体，不是跨节点的逐轮循环。
- 对列表任务，`POST /api/projects/:id/apply-generation`可传`acceptPartial:true`，仅允许在completed/cancelled/interrupted/failed状态取回已完成项。未结束且未明确确认时拒绝。以项目runs内assetIds判定已应用项；先部分应用、再恢复、再应用不会重复创建结果。job记录appliedAssetIds供页面显示，项目记录为判重依据。
- 结果节点保留每项提示词；目标节点内容改变时创建新节点。项目版本冲突返回409。仍遵守项目节点容量；本机媒体文件不会被删除。
- 完整备份保留promptBatch并验证目标字段、列表长度与次数；导入重新关联工作流编号。备份不包含生成作业状态。

## 有界多节点循环（0.21）

- 节点type新增`loop`；`params.loop={mode:"repeat",count:2}`或`{mode:"list",values:["第一轮","第二轮"]}`。缺省重复2轮。1–32轮，列表每项最多16000字、总共128000字。图保持DAG，拒绝嵌套及重叠循环体。
- `canvas-run-plan`与`canvas-run`展开所有可达的已绑定媒体节点，外部依赖先执行一次，循环内每轮按依赖顺序执行。最多32个原始绑定节点、展开合计64次生成。所有轮次的文字、字段、种子在开始前检查。
- 循环步骤包含`executionId,loopId,loopTitle,roundIndex,roundCount`，roundIndex从0开始。云授权数组的nodeId使用executionId；每轮单独一次授权，不能把原nodeId授权隐式扩大。非循环沿用原nodeId。
- 首步骤带roundStart，运行快照startedRounds确保当前轮仅清空一次循环体的旧assetId。每轮子请求编号沿用parentId-stepIndex，原任务恢复不重交。ComfyUI seedOffset为roundIndex乘节点count，仅incrementSeeds启用时生效；所有输出引用落盘。
- 列表文字追加到循环节点公共文字，经既有promptField/useText传入，至少一个循环体节点必须选择此映射。多字段替换、反馈迭代不支持。
- apply-generation支持循环父任务acceptPartial=true取回停止后已完成步骤。结果新建节点，保留轮次与提示词，项目runs.assetIds用于判重；每次应用都检查revision。最终只加入未应用素材，不替换原循环体。
- 完整项目备份保留loop参数/边及ComfyUI、云工作流映射；导入重新关联工作流编号。

## 循环逐轮参数（0.22）

`params.loop.fieldValues`可选，最多16项：`{targetNodeId:"画布节点编号",nodeId:"工作流内部节点编号",name:"steps",values:[10,30]}`。values长度必须与轮数完全相同，只接受原字段类型的string/number/boolean；文字每项最多32000字、所有字段合计256000字。保留重复或列表模式。

只能指向本循环体中的ComfyUI绑定节点；不得写媒体/计算连线、隐藏字段或与promptField/promptBatch/imageSources冲突。逐轮seed/noise_seed与incrementSeeds互斥。逐轮值替换相同字段的固定override，生成模板和原绑定不变。所有轮次先执行configuredGraph及batch约束检查，后轮失败时零提交。

计划step.loopFields记录当前节点本轮使用的字段和值，用于运行前预览；任务快照保存展开后的overrides，跨进程恢复使用原值。复制选区重映射内部fieldValues.targetNodeId，备份保留字段列表并重关联目标节点绑定的工作流。

## 图片接口画布绑定（0.23）

图片节点可保存`params.imageBinding={platform:{id,name,protocol:"openai-compatible",baseUrl,models:[{id,label,category:"image",referenceSupport}]},model,size,quality,includeUpstream,referenceSources:[{sourceNodeId}|{assetId}]}`。平台模型只包含无密钥的选定快照。referenceSources最多3项，动态来源必须为相连上游图片节点，静态素材须属于项目且为≤10MB的PNG/JPEG/WebP。

canvas-run-plan返回kind=image-api，含image绑定快照、text、sendAssets、单次count。循环步骤同样有executionId；列表文字经includeUpstream进入模型。与workflowBinding/cloudBinding互斥。ComfyUI/RH的动态输入现在可来自图片接口生成结果。

canvas-run新增imageCredentials数组，每项`{nodeId:executionId或nodeId,apiKey,authorization:{origin,model,sendPrompt:true,sendReferences,requestLimit:1,budget,currency}}`。必须对每个图片步骤独立授权，全部预检完成后才提交第一步；密钥只留内存并在处理后清空。恢复只要求尚未关联子任务的图片步骤提供本次密钥，沿用原服务/预算授权。

图片子任务复用image-api及持久requestId；保存平台、模型、文字及参考图快照。已完成子任务跳过；有未完成的同步图片子任务时禁止重发，不伪造异步任务编号。只有其他可恢复子任务使用原编号查询。

apply-generation对所有canvas-run支持acceptPartial=true：停止/失败后取回父任务已确认完成的步骤，按素材编号判重；后续恢复完成只应用剩余项。旧版无assetIds的已应用记录按整批完成处理，避免升级后重复回填。

组复制重映射选区内imageBinding.referenceSources[].sourceNodeId，完整备份保留绑定快照并重映射固定assetId；不会覆盖导入工作区的全局平台设置。

## 语言模型画布节点（0.24）

text/script节点新增llmBinding：`{platform:{id,name,protocol:"openai-compatible",baseUrl,models:[{id,label,category:"chat",referenceSupport}]},model,systemPrompt,maxTokens,stream,includeUpstream,referenceSources:[{sourceNodeId}|{assetId}]}`。系统指令≤16000字，用户输入1–32000字，maxTokens为128–8192，stream为布尔值。参考图≤8张，视频≤3份；图片每张≤10MB PNG/JPEG/WebP，编码后合计≤24MB。

canvas-run-plan返回kind=canvas-llm。canvas-run/resume新增llmCredentials，与图片授权结构一致：nodeId采用executionId或nodeId，authorization包含origin/model/sendPrompt/sendReferences/requestLimit=1/正budget/currency。全图授权在第一步提交前检查。

计划中textInputs标记来自上游语言模型的动态文字；运行时从项目执行快照取完整输出，保留原始固定指令和每轮文字。ComfyUI promptField、图片API提示词、RunningHub useText、下游LLM都使用实际输出。未知输出长度在产生后再次检查下游限制，超限时停止未提交的下游。

语言模型子任务kind=canvas-llm，parentId关联父任务；outputText增量保存并脱敏，finishReason记录结束原因。回复和工具调用都是数据，绝不执行工具。断流/截断/取消不会自动重发，也不进入下游。已完成子任务可在父任务恢复时复用。

父任务textResults为完整文字结果，含id（子任务id）、sourceNodeId、type、title、text和可选loopId/roundIndex。apply-generation按runs.textIds与appliedTextIds判重，新增结果节点而不改源指令；可与媒体一同部分回填。未完成片段保留在任务outputText供查看，不计为已完成结果。

组复制重映射llmBinding.referenceSources[].sourceNodeId，完整备份保留无密钥配置快照并重映射固定assetId。导入不修改全局API平台。

## 本地剪辑与渲染（0.26）

- `shot.edit`：`sourceStart`/`sourceEnd`（原视频入/出点，秒，出点可空）、`endMode:loop|hold|strict`、`fit:contain|cover`、`sourceAudio:auto|keep|mute`、`sourceVolume`、`voiceStart`、`voiceOffset`、`voiceVolume`、`fadeIn`、`fadeOut`。音量0–2，配音延迟及淡入淡出不超过镜头；合计淡入淡出不能超时。旧镜头默认循环、完整显示，有配音则关闭原声。
- `project.settings.edit`：`burnSubtitles`；`subtitle:{fontSize,color,outline,bottom,backgroundOpacity}`；`music:[{id,assetId,start,sourceStart,duration,volume,fadeIn,fadeOut,loop}]`。最多16条背景片段，必须引用当前项目音频；位置+时长不得超过成片。完整备份重写音频素材编号，保留全部剪辑参数。
- `render-plan`检查本地常见图片、视频和音频，使用显式媒体格式与仅file/pipe协议；拒绝不匹配元数据、符号链接、伪装媒体、超范围片段。每个镜头按 `round(duration*fps)` 取至少一帧，计划、成片和字幕共用该时长。1–100个镜头，横屏1280×720、竖屏720×1280、方形720×720、4:3为960×720。
- POST要求提交计划对应revision和客户端稳定requestId；同一请求重放返回同一个任务。任务保存项目剪辑快照，不暴露在公共任务响应。`GET /api/jobs/:id`含plan、progress、result、canResume；取消使用现有cancel接口。cancelled/interrupted/failed且有快照的本地渲染可resume，重新合成原快照，每次写入新的attempt目录，不覆盖旧结果或中间文件；无上游请求。
- 成功结果：`{url,subtitleUrl,duration,width,height,fps,subtitlesBurned,musicTracks,attempt,projectRevision}`。只有完成任务可访问当前attempt的成片。H.264/yuv420p + AAC双声道；完成前核对视频/音频轨道及总时长。中文由项目内@napi-rs/canvas绘制透明PNG，再由FFmpeg叠加，不依赖系统FFmpeg的libass编译选项；缺少组件/字体或字幕过长会报错。
- `render-apply`校验任务归属、完成状态、普通本地文件、150MB上限和当前项目revision。结果素材复制有独立编号，重试复用记录；同一jobId只加入一个视频节点和run记录。导出本身不修改项目。


## 0.27：图片机位与 ModelScope 编辑

`image` 节点新增 `params.cameraAngle: {rotation, pitch, distance}`。数值范围分别为 −90..90、−90..90、0.1..8，默认0、0、4。补充文字仍为 `node.text`。`cameraNodeText` 在规划与运行快照阶段统一合成镜头指令，避免刷新、LLM动态文字或运行画布时丢失机位。单次 ComfyUI 运行也使用所选提示词映射。源图沿用 `workflowBinding.imageSources` 或 `studioBinding.referenceSources`，不新增第二套素材索引。

机位界面可创建/编辑 ComfyUI 或 ModelScope 绑定；ComfyUI 使用用户导入工作流的真实 `LoadImage` 输入与文字输入，不内置未经验证的生成模型。生成、原编号恢复、回填、撤销与完整备份沿用已有路由。`GET /api/projects/:id/canvas-run-plan` 可查看实际提交文字。

ModelScope `POST images/generations` 增加 `image_url: [data URI,...]`，每张为验证后的 PNG/JPEG/WebP，最多3张、各10MB。无参考图时省略该字段。保留 `model`、`prompt`、可选 `loras`，不同时提交多套猜测字段，也不上传到图床。输出仍为1张，质量须auto、不透明。同步通用异步图片协议的无参考图限制保持原样。取消/重启后仅 `GET tasks/:id`，不重新编码、下载参考图或提交生成。

协议依据：[Qwen官方 ModelScope 页面（2511）的本机 data URI 示例](https://www.modelscope.ai/models/Qwen/Qwen-Image-Edit-2511)、[ModelScope官方社区的多图编辑说明](https://modelscope.csdn.net/691c36ee82fbe0098caca391.html)。功能依据：[固定基准的 angle.html](https://github.com/hero8152/Infinite-Canvas/blob/67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e/static/angle.html)。本地模拟测试验证请求协议与恢复行为，不能替代真实平台的模型支持和出图质量验收。


## 0.28：LTX Director 生成时间线

复用项目PUT、canvas-run-plan、canvas-run及ComfyUI生成任务接口，不创建独立项目/素材/任务索引。视频节点绑定 `params.workflowBinding.ltxDirector`，仍保存 workflowId、普通 overrides/imageSources、count 与 incrementSeeds。

时间线字段：`nodeId`为导入工作流内的LTXDirector编号；`frameRate`为1–120整数、`durationFrames`为1–10000整数、`displayMode`为seconds/frames。`globalPrompt`最多16000字；`includeUpstream`控制是否追加节点与上游文字，合计不超过32000字。`width/height`为0–8192且非零时是`divisibleBy`（1–256）的整数倍；无有效图片时不能用0尺寸。`resizeMethod`支持maintain aspect ratio / stretch to fit / pad / pad green / crop；`compression`为0–100，`epsilon`为0.0001–0.99。

- `segments`最多64项：`{id,type:'text'|'image',start,length,prompt}`，start/length均为整数帧，片段结束≤10000帧。图片追加`guideStrength`（0–10）和`assetId`或`sourceNodeId`，两者只能填一个。
- `audioSegments`最多16项：`{id,type:'audio',start,length,trimStart,assetId|sourceNodeId}`，trimStart为源音频的帧位置。`useCustomAudio`为false时不会上传/发送音轨。启用时本机ffprobe校验实际时长，超出素材长度在提交前拒绝。
- 片段ID跨轨唯一，同轨不能重叠；输出范围须有有效画面/文字段。`|`在LTX局部提示词中是保留分隔符，表单/服务端拒绝原文包含该符号，避免提示词与分段数量错配。
- `sourceNodeId`必须是已相连、类型匹配且有素材或生成配置的上游节点；执行时解析为本轮素材。移出上游后保留配方且可保存，运行预检提示重新选择来源。复制选区时内部动态引用重映射；完整备份重映射固定素材和工作流编号。

`lib/ltx-director.mjs`编译`timeline_data`、`local_prompts`、`segment_lengths`、`guide_strength`、尺寸、帧率及音频开关。开头空隙并入首段，段间空隙并入前段，末段补至输出截止；截止后的媒体不上传。新版工作流已有start/end帧/秒字段时同步为0与输出长度；其余新版motion/retake字段未适配。

直接ComfyUI生成请求也可提供`ltxDirector`与可选`ltxText`，此路径只接受固定assetId。时间线管理字段不能同时被普通覆盖、提示词列表或promptField占用；隐藏字段/模板修订/参数约束仍有效。普通媒体映射仍最多16项；时间线由内部编译追加，合计最多96项、去重媒体≤300MB。外部请求不能伪造内部`ltxTrack/segmentId`映射。

媒体验证通过后，沿用上传状态和上传去重，将服务返回的安全路径写入各段imageFile/audioFile；不从配方接受任意后端路径或base64字段。任务保留原时间线和输入映射，恢复只查询原promptId；提交/上传结果不确定不自动重发。重复批量1–8次可递增种子，复用同一时间线与媒体上传。

时间线界面可用 Ctrl/Command 多选片段并整体移动，Shift 点击可追加选择；拖动单个边缘可裁切，默认吸附到其它片段边缘、播放头和输出截止位置，也可关闭吸附。空格控制播放/暂停，Delete/Backspace 删除选中片段；多选删除作为单次操作，可撤销。新增 `GET /api/assets/:assetId/waveform`，只接受本机已有音频素材，返回640点的归一化峰值与时长。服务端经 ffprobe 校验素材，再由本机 FFmpeg 输出固定尺寸波形；每次最多30秒、同时最多2项，内存缓存最多128项。不上传或外发音频内容。波形只用于编辑预览，不修改原音频或 ComfyUI 提交内容。


## 0.29：增强 / SeedVR2 放大与原图关联

复用 `/api/projects/:id/canvas-run-plan`、`/canvas-run`、`/api/jobs/:id/resume` 和项目结果回填，不新增另一套执行器。

本地图片节点的 `params.workflowBinding.imageEnhance`：

```json
{
  "kind": "enhance",
  "engine": "comfy",
  "imageField": {"nodeId":"15","name":"image"},
  "strength": 0.5,
  "strengthField": {"nodeId":"204","name":"value"},
  "seedMode":"fixed",
  "seed":1234,
  "seedFields":[{"nodeId":"146","name":"seed"},{"nodeId":"181","name":"seed"}]
}
```

- `kind:upscale` 使用 `resolution:2048|4096`、`maxResolution:4096`、`resolutionField` 和 `maxResolutionField` 替代强度两项。两个字段须是同一 `SeedVR2VideoUpscaler` 的 `resolution` / `max_resolution`。
- `seedMode` 为 `random|fixed|workflow`。random/fixed 需要 1–32 个不同的、原值为数字的 seed/noise_seed 字段。固定值为 0–4294967295；random 在新任务规划时产生同范围值并保存在执行步骤和结果来源记录。仅查看预检计划也会生成预览值，不代表已提交；执行采用持久任务中的值。workflow 使用工作流原值。
- 每个增强节点绑定 1 个图片来源、运行 1 次；支持固定 `assetId` 或相连上游的 `sourceNodeId`。受控字段不得与普通 overrides/promptField/promptBatch 重复，隐藏字段和已有连线不能被静默改写。不同时使用 promptBatch 或 LTX 时间线。多组输入可使用既有画布循环，但受控强度/尺寸不支持被普通循环字段覆盖。
- ModelScope 的 `params.studioBinding.imageEnhance={kind:'enhance',engine:'modelscope'}` 保留现有配置和逐节点授权，仅接受一张本地或动态上游图片。正常 ModelScope 图片模式、异步协议和 LoRA 校验仍适用。没有另造未经上游支持的 `strength` 参数。
- 增强→放大是两节点连线：下游普通 `imageSources` 指向增强节点。执行器在新子任务提交前持久化解析后的源图编号，再沿用上传去重、子请求编号、原任务恢复与部分回填。恢复已有子任务不重新解析或上传源文件。
- 完成的图片素材附加 `enhancement:{kind,engine,sourceAssetId,originalAssetId,strength?|resolution?,maxResolution?,seed?}`。source 是直接输入，original 是增强链第一张输入。普通输出文件不修改；来源记录用于对比与迁移，不代表模型质量证明。实际尺寸从浏览器成功解码的原文件读取。
- 比较入口位于任务结果、素材卡和结果图片节点。可看最初原图或直接输入，适应窗口 / 输出原始尺寸，下载原图和结果。
- 增强来源记录使用完整备份清单 `version:4`；读取兼容 1–4。递归收集缺少于当前画布的原图 / 中间结果，与编辑 / 全景来源一起检查循环，校验源图类型和链条一致性；导入重映射两个源图编号。旧读取器明确拒绝第 4 版，不静默丢失记录。摘要增加 `enhancements` 数量。本机诊断也报告缺失的增强原图索引。

本地验证只向回环模拟服务器发送合成图片。没有运行或安装真实 Z-Image / Klein / SeedVR2 模型。


## 0.30：RunningHub 标准模型、账户与备份

- `GET /api/cloud-models`：返回固定官方目录 `version,source,models`，每项有 `id,name,alias,outputType,category,supported,reason`。没有平台请求。
- `GET /api/cloud-models?id=<endpoint>`：返回本地规范化 `fields,catalogVersion`；仍不支持的型号拒绝返回可运行字段。
- 现有 `/api/cloud-workflows/:id` 允许 `kind:model`，`targetId` 为目录中的模型路径，服务端写入 `catalogVersion,outputType`。字段以 `nodeId:model|ref-N,fieldName` 定位；重复、多余及非法字段拒绝；类型、范围、说明与选项从目录重新构造，不能通过客户端篡改放宽。
- 标准字段增加 `enabled,required,integer,min,max,maxLength,maxItems,maxBytes,accept`，支持 text/number/boolean/select/multi-select/text-list/size/image/video/audio。可选参数关闭时不发送；空数字不强制转为0；INT/FLOAT/BOOLEAN按原类型，LIST按官方请求中的字符串，多选与词典按数组。图像尺寸与特定模型总像素/比例约束在上传前校验。
- 多参考媒体按 `ref-1,ref-2,...` 保存位置，使用原 `source:asset,assetId` 或 `source:value,fieldValue:<HTTPS/asset://>`。相同素材上传去重但不合并参考位置。标准模型最多32份不同素材；应用/工作流仍最多8份。
- `GET /api/cloud-workflows/:id/preview`：本机编译运行参数，缺必填或组合越界返回400，无网络请求。项目素材用占位标记呈现，上传后才替换为平台链接。型号专有比例前缀和分辨率对宽高的优先级体现在预览中。
- 标准模型上传为 `POST /openapi/v2/media/upload/binary`（Bearer，multipart file）；提交为 `POST /openapi/v2/<固定目录endpoint>`（Bearer，JSON）。复用 `/openapi/v2/query`、下载和入库。仅提交1次，保存原任务号；不确定无编号不重交。密钥、上传返回的临时URL不写入本地任务；既有用户填写的素材URL仍属于配置内容。
- `POST /api/cloud-workflows/account`：`baseUrl,apiKey,consent:true`，调用 `POST /uc/openapi/accountStatus`，body字段为小写 `apikey`。仅返回 `remainMoney,remainCoins,currentTaskCounts,currency,checkedAt`；缺值为null；不落盘，无生成。
- 画布 `cloudBinding` 沿用 `recipeId,recipeRevision,inputs`。媒体标准模型输出须匹配媒体节点；`outputType:string` 可绑定文本/剧本节点。对每个ref槽位选择相连上游，输入映射使对应字段启用；生成文字节点可向后续云节点传递完整结果。预检允许将来才产生的动态素材占位，真正提交前再次检查。
- 完整备份在含标准模型时为第5版；导出含目录版本及参数，导入校验型号，重映射固定本地素材、配置编号及绑定版本。旧的第1–4版仍可导入。

0.75 增加 RunningHub 标准文字结果：固定目录中 51 个 `output_type:string` 型号按原字段/参数校验接入（其中仍受真人素材等限制的型号继续禁用）。`/openapi/v2/query` 可返回 `results[].text`，也可提供文字结果 URL；URL 仅下载公开 HTTPS 或本机回环地址，限4MiB、有效 UTF-8 和 text-like MIME，入库为 `text/plain`。结果可在云任务预览/下载、放入主画布作为文字节点，并绑定 RunningHub 文本/剧本节点；下游映射接收完整上游文字。恢复按原任务编号继续，按已保存结果索引跳过，不重复提交。接口和画布测试使用隔离 mock；没有调用真实模型或读取 API Key。

官方字段依据：

- [目录快照](https://github.com/HM-RunningHub/ComfyUI_RH_OpenAPI/blob/8f9c858e7e631a1c1c49df0c4defd77fdd690dd4/models_registry.json)
- [Qwen 3.0 请求示例](https://www.runninghub.cn/runninghub-api-doc-en/api-497874394)：imageNum 为 LIST 字符串。
- [Speech 2.8 HD 请求示例](https://www.runninghub.cn/runninghub-api-doc-en/api-448184545)：pronunciation_dict 为字符串数组。
- [账户查询官方脚本](https://github.com/HM-RunningHub/OpenClaw_RH_Skills/blob/main/runninghub/scripts/runninghub.py)：仅作只读协议参考。

0.79接入自包含GLB三维结果；其他三维格式、压缩网格/动画播放、独立真人资产转换和目录外型号尚未实现。文字模型只完成通用文本字段/URL协议的本机模拟验收，不代表逐型号真实行为已确认。尚未真实验收：逐型号权限、限额、任务返回差异和生成质量。媒体下载支持PNG/JPEG/WebP、MP4/MOV、MP3/WAV/FLAC；额外媒体格式会明确报错并保留已下载结果。


## 0.31：RunningHub LoRA

- `POST /api/loras/import?name=<filename>`：原始文件体、Content-Length。仅导入本机，最多2GiB；只接受 `.safetensors`。逐块写入后验证头部、张量布局与MD5/SHA-256；不执行模型。成功为 `application/x-safetensors` 素材，含 `lora:{md5Hex,sha256,tensorCount,headerBytes}`。失败/中断文件保留在 `data/lora-imports/*.incoming`，不显示为可用素材，不自动清理。
- `GET /api/loras/files?projectId=...`：全局已校验LoRA文件列表；`POST /api/loras/:assetId/attach`：`projectId,revision`，乐观版本检查及重复关联判重。
- `POST /api/loras/prepare`：`projectId,assetId,baseUrl,loraName,apiKey,requestId,authorization`。授权字段必须匹配 `origin,assetId,md5Hex,size,loraName,metadataOnly:true,requestLimit:1`。调用一次官方 `POST /api/openapi/getLoraUploadUrl`，Bearer及JSON `apiKey,loraName,md5Hex`。同requestId查询判重。保存metadata状态，临时签名URL仅存内存，最多5分钟或进程生命周期。
- `GET /api/loras?projectId=...` / `GET /api/loras/:id`：上传记录与发送进度。只返回存储origin，不暴露签名URL。
- `POST /api/loras/:id/confirm`：授权必须匹配 `origin,storageOrigin,assetId,sha256,size,uploadLimit:1,sendFile:true`。再次校验文件与所属项目。发送前持久化uploadCount=1，重复确认只返回原状态。PUT原文件流，固定Content-Type与Content-Length，不附带API Key。拒绝重定向、私网、元数据地址和带用户凭据URL；对HTTPS重新解析并固定DNS目标。传输中再次计算SHA，等待HTTP成功确认。
- `/api/jobs/:id/cancel`停止本机上传。网络失败、停止或HTTP拒绝不会自动再发；无成功确认不会生成可用记录。重启后未用计划expired；进行中的上传interrupted/uncertain。该接口不实现平台分片续传。
- 上传任务 `kind:lora-upload` 存在 `data/jobs/`，可从任务中心打开；成功后记录 `fileName`、指纹和平台。API响应原文、签名查询串、密钥不落盘。文件保存在 `data/assets/<id>`，索引 `<id>.json`。
- 工作流字段发现额外保留 `nodeClass`。LoRA绑定为 `source:lora,assetId,receiptId`，仅允许 `nodeClass:RHLoraLoader,type:text`；AI应用无class元数据时由用户核对后选择。生成与画布预检重新核对本机文件、项目、平台及成功记录，并强制使用记录里的fileName；普通字段值不能替换它。它不属于每次生成要上传的普通参考媒体，也不能映射上游提示词。
- 备份v6增加 `loraReceipts`，只导出当前项目文件的成功记录，不导出失败/未确认请求及签名URL；导入重映射素材/记录/配置编号，并显示历史记录来源。校验原文件与SHA/MD5/张量元数据，恢复记录不代表当前账号权限已验证。读取兼容v1–v6；整体4GiB、单个LoRA2GiB、普通媒体合计512MiB。

协议来源：[RunningHub LoRA官方接口](https://www.runninghub.cn/runninghub-api-doc-en/api-425761100)、[safetensors官方格式实现](https://github.com/safetensors/safetensors/blob/main/safetensors/src/tensor.rs)。真实上传、模型运行、平台存储有效期与账号权限尚未实测。


## 0.32：本地视频抽样与语言模型输入

- `POST /api/chat-media/prepare`：`{assetIds:[id]}`，总计0–20份不同图片/视频（0.34扩展），其中视频≤3。只读取本地已入库素材；不访问远端地址、不调用模型。返回 `{assets,videoSamples,encodedBytes}`。
- `videoSamples` 记录 `{id,assetId,method:"uniform-6-v1",sourceSha256,duration,frames:[{assetId,time,sha256}]}`。每份视频固定6帧；time为近似seek位置，原片最后0.25秒以内保留余量，低帧率尾段可回退到最后一帧。比例保留、最长边≤768、不放大；不包含音轨。缓存按原视频编号、内容校验及算法版本复用，并发请求不会重复生成同一份缓存。
- 支持MP4/MOV/WebM≤150MB、时长≤6小时、1677万像素/单边8192；无时长头的WebM通过有时间/输出上限的时间戳扫描获取时长。显式本地输入格式与协议限制；符号链接、坏文件、缺少帧、内容变化会拒绝。
- `POST /api/conversations/:id/messages` 在原有请求上增加 `videoSampleIds:[id]`。视频必须先prepare；服务端从已保存的预览记录取帧，不能用请求中的任意帧对象替代。消息保留原片编号和完整抽样快照；后续上下文只发原批次图片。模型仍使用兼容Chat Completions，须在平台模型配置中启用referenceSupport。
- 最近20条完整消息的图片与视频帧共用24MB编码上限；回复片段不进入上下文。上游内容为文字、时间标签及image_url data URL，不包含video_url、原片字节或音频。单次发送授权sendReferences包含这些帧，密钥仅本次使用；仍遵守requestId幂等、不确定提交不自动重发。
- 画布 `llmBinding.referenceSources` 接受原有image及新增video上游节点或固定素材。plan返回静态 `videoSamples` 供预览；动态上游视频完成后再本地抽样。子任务input保留referenceIds和videoSamples；父任务已经取消时不能开始模型请求。
- 完整备份v7保留会话原片和6张帧，即使没有放入项目画布；检查SHA、引用、数量和版本。导入重映射所有编号并保留图像内容。v1–v6旧备份继续可读。旧版本不宣称能读v7；不导出密钥、会话原请求索引或自动启动任务。
- 本机诊断增加对话原片/抽样缺失引用检查及对话、抽样记录目录。


## 0.33：自有对话 Agent、系统指令与备份v8

- `PUT /api/conversations/:id` 支持 `{revision, systemPrompt}`，name可省略。系统指令最多16000字，保持版本冲突检查，可单独保存。普通文字对话和Agent问答均以system消息发送；图片模式仍只发送当前提示词及参考图。
- `POST /api/conversations/:id/agent-preview` 为本地预览，不创建生成任务、不调用模型。请求包含revision、mode=agent、platformId/model（chat分类）、text、systemPrompt、assetIds、videoSampleIds、size、quality、stream、maxTokens，以及 `agent:{imagePlatformId,imageModel,imageCount,inheritLastImage}`。imageCount为`auto`或整数1–4；两个平台当前均须为openai-compatible。
- 返回hash、revision、router服务/模型/最多2次调用，image服务/模型/数量/新图尺寸/改图尺寸/质量/选定及沿用参考，context中的消息数、实际图片部分总数、去重视频抽样，以及系统指令。继承仅取最近完整assistant图片消息的首图；未完成片段不参与。显式比例/尺寸按16倍数规范，优先于已选尺寸；无尺寸且沿用历史图时读取其实际尺寸。
- `POST /api/conversations/:id/messages` 增加mode=agent。沿用原revision/requestId判重、apiKey和authorization；router的requestLimit必须为2。agent额外提交previewHash、imageApiKey和imageAuthorization。图片授权须精确匹配预览origin/model/sendPrompt/sendReferences/requestLimit，并包含正budget及CNY/USD币种。hash绑定会话版本、内容、模型和参考选择，改变后必须重新预览。各服务密钥仅存活于当前请求，内容中含本次密钥会在提交前拒绝。
- 图片参数设置与systemPrompt持久化到会话；密钥不持久化。按顺序先调用router模型一次：严格JSON动作只允许chat/generate_image/edit_image及prompt/prompts/reply，禁止自选服务或工具。chat再调用所选对话模型一次，遵循stream/maxTokens；新图调用所选图片服务1–4次，改图1次，每次n=1。模型不允许增加数量、更换地址或扩大参考范围。
- 判断与问答接收最近20条完整上下文和图片/视频抽样；视频沿用0.32相同的6帧快照。图片服务只接收实际创作提示词及已确认图片，不发送整段历史、视频原片、音轨或视频抽样。当前图片参考最多20张（0.34扩展），视频可用于判断与问答。
- 任务kind=conversation-agent，保留stage、requests逐步台账、decision、imageResults、usedReferenceIds、outputText、assets及双服务授权记录。提交前落盘，每张成功图片立即入库；不确定请求标为unconfirmed，不自动重试。启动时活动任务改为interrupted，恢复已存文字/图片和缺失会话索引，不启动后续步骤。
- 会话结果保留agentAction、imagePrompts、usedReferenceIds；图片结果mode=image，文字结果mode=agent。未完成结果标为incomplete，不进入后续上下文；明确acceptIncomplete后可回画布。图片回填按各自实际提示词创建节点，仍按messageId判重。任务中心可打开原会话。
- 完整备份v8保存系统指令、Agent图片设置和结果字段，收录已用参考素材，导入重映射编号。低版本清单携带这些字段时拒绝；普通项目按所需最低版本导出，读取兼容v1–v8。平台配置、密钥、授权和任务不会随备份迁移。诊断检查Agent已用参考是否缺失。

协议、持久化和浏览器验证均使用仅本机网络、合成素材与伪密钥；未执行真实云调用。本路径没有上游失败后按关键词自动生图的回退，避免在判断不明时扩大执行；原生供应商和CLI协议仍未对齐。


## 0.34：参考素材数量与完整备份v9

- `reference-limits.js`共用容量：通用图片20、独立会话20、会话视频3、画布LLM图片8+视频3。`referenceSupport`仍须显式开启；原生平台较低限制不变。请求引用顺序保留，不用截断来处理超额。
- 覆盖直接图片、imageBinding、studioBinding、通用图片创作台、对话图片/问答/Agent。`reference-fields.js`为绑定表单提供动态增删行；支持创作台HTTPS URL，复制预设和重开时保留全部引用。
- `llmStep`在规划时分别计数静态素材实际类型与动态上游预期类型；子任务启动时再次按实际产物类型检查。视频仍为uniform-6-v1，无音频。8图+3视频实际发送8张图片和18张视频抽样，继续受24MB编码上下文限制。
- 图片≤10MB/张。通用图片请求48MiB内预留64KiB参数/表单头部空间；本地已知尺寸在任务/画布计划前检查，外部URL授权下载后按实际大小检查。动态产物在生成后检查；不因此重发任何模型请求。
- 完整备份v9保留扩展引用、Agent usedReferenceIds及顺序，恢复时重映射素材编号。沿用v1–v8旧格式读取；独立创作台以前允许保存最多8份引用的草稿，仍可读取，不因某协议不支持运行就破坏旧备份。超出旧结构容量的内容不能伪装成v8导入。
- 本轮没有配置真实模型密钥，没有执行任何云端生成或上传；单元与浏览器测试使用本机模拟端点。


## 0.35：文档附件、已审阅快照与完整备份v10

- `POST /api/chat-documents/import?name=...`：原始文件字节，1字节至20MiB。支持文字扩展名txt/md/markdown/json/csv/log/py/js/ts/tsx/jsx/html/css/xml/yaml/yml，以及docx/xlsx。验证通过才登记素材；文字统一为text/plain，Office保留对应MIME。所有文档通过`/media/:id`下载时强制attachment，不把HTML/JS作为活动页面打开。
- `POST /api/chat-media/prepare`仍接受`{assetIds}`。返回增加`documentSamples`：每份包含id/assetId/method=document-v1/sourceSha256/name/kind/text/textSha256/truncated/encoding/imageLimit/imageCount/sheetCount/warnings/images。images是assetId/sha256/name列表。仅本机解析、校验和预览，不调用模型。
- 正文最多12000个Unicode字符；UTF-8 BOM/UTF-8/GB18030及带替换提示的回退。DOCX提取正文、表格段落及换行；XLSX读取8表/80非空行/30非空单元格，保留共享字符串、富文本、inlineStr、布尔、缓存值与公式。不会计算公式或访问外部关系。
- Excel内嵌图片按xl/media名称排序，PNG/JPEG/WebP/GIF/BMP/TIFF归一为白底JPEG质量88、最长边1536不放大。显式图片先占20张额度，所选文档按顺序使用剩余额度；坏图提示跳过，同文档不越过当前截取范围补位，后续文档可继续用剩余名额。视频帧沿用独立视频抽样规则，全部编码图片仍受24MiB上下文限制。
- 新消息及agent-preview须携带`documentSampleIds`，与assetIds/所选图片数量/顺序吻合。服务端从本地缓存读取，不接受客户端提供的正文或内嵌图片路径。缓存按原件编号、SHA-256及图片额度区分；发送前复核原件、快照正文及内嵌图片校验值。纯文字文档不要求referenceSupport，含内嵌图片时要求。
- 普通对话和Agent判断/问答接收最近20条完整消息中的文档正文及预览图片。Agent图片工具沿用上游已核实边界，只使用显式图片或授权的上一张生成图，不直接使用表格内图片。Agent预览hash包含documentSampleIds，授权sendReferences覆盖文档提取内容；API Key仍只在本次请求中使用。
- 解析器使用Python标准库；ZIP最多4096项、每项16MiB、展开合计64MiB，拒绝加密/重复/越界路径/符号链接/DTD和实体声明，不解压任意路径。解析与图片转换有超时，图片解码限定本地显式格式与file/pipe协议，1677万像素上限。失败不删除用户原文件。
- 第10版备份包括Office原件及对话documentSamples、正文和内嵌图片；导入重新关联全部素材编号。源文件/正文/图片缺失或校验不匹配会拒绝，文档快照不能伪装为v1–v9。既有v1–v9备份仍可读取。不包含API Key或上游授权。
- 文档预览缓存位于`data/chat-document-samples/`，Office图片转换中间文件位于`data/document-imports/`；原件及JPEG在`data/assets/`。诊断增加Python 3可用性和文档图片引用检查。


## 0.36：逐秒视频抽样与v11备份

新`/api/chat-media/prepare`默认`method=head-1fps-6-v1`。与固定主参考一致使用`fps=1,scale='min(768,iw)':-2`，最多6张JPEG、宽度不超过768、偶数高度按比例；竖屏高度可以超过768。FFmpeg 9的JPEG输出显式选yuvj420p，避免默认有限范围YUV被MJPEG编码器拒绝；没有改变取帧/缩放规则。没有安装或升级FFmpeg。

帧数1–6，取决于源文件的时间戳及fps过滤结果，不按时长强行补到6张。time记录1fps输出的近似时间位置，常见为0、1、2…；不能认为是精确动作发生时刻。极短文件可能没有逐秒输出，此时只取第一帧并持久记录`fallback=first-frame`，UI和模型上下文均明确显示。上游canvas-llm在抽样为空时可退回video_url；镜场没有实现这个原片输入分支，当前首帧回退不代表同等原生视频能力。

`uniform-6-v1`旧记录仍须6张，允许原有小数时间；新记录要求1–6张和连续整数抽样时间，回退只允许一张0秒图片。原件和帧SHA-256仍在发送前复核。新缓存编号包含新算法名，与旧记录隔离。已有会话、旧静态画布任务快照和旧备份按原记录使用，普通新选择及新画布任务使用新默认。

所有图片数量显示根据frames.length合计，包含去重预览与历史实际引用的区别。Agent判断/问答、画布固定/动态视频均走同一抽样流程；图片工具仍不接收视频原片、音轨或抽样。8图+3份足够长的视频仍可传入26张画面；短视频只传实际张数，24MiB编码上限保持。

含新抽样记录的完整备份使用v11，检查新抽样为JPEG，保留fallback、时间、原片/帧校验；新记录不能标成v1–v10。旧uniform-only备份仍可使用原v7（若无其他新版功能），所有既有v1–v10可读。导入不重新解码或自动提交模型。

行为依据：[Infinite Canvas固定源码](https://github.com/hero8152/Infinite-Canvas/blob/67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e/main.py#L8578)、[FFmpeg fps过滤器](https://ffmpeg.org/ffmpeg-filters.html#fps-1)。帧率转换会丢弃或复制输入帧，输出时间戳采用默认四舍五入；本地对照测试使用同一过滤参数核对六张JPEG的解码像素。


## APIMart 完整对话响应（0.37）

兼容平台的对话请求仍为 `POST {baseUrl}/chat/completions`，显式发送布尔 `stream`，地址、模型、密钥、授权均沿用已选平台；不硬编码或静默切换服务。`lib/chat-stream.mjs` 在普通对话、Agent动作计划/回答和画布LLM中共用：若顶层没有`choices`且`data`为对象，接受一层`{code:200,data:{choices:[...]}}`包装；保留原平铺格式，存在顶层choices时不以嵌套内容覆盖。

外层或内层错误、失败标记和非成功代码拒绝解析；不执行工具调用、不记录原始错误正文。支持标准text段及参考项目可读取的无type文字段。未知`finish_reason`记录为`unknown`、`complete:false`，保留文字但禁止自动传给下游。原省略或null结束原因的兼容行为保留。

`safeApiCall`请求流式但收到JSON时直接调用同一解析器，没有第二次提交。请求/回应范围和图片、视频抽样、文档快照规则不改变；备份只包含归一化的历史文字/素材，不保存响应包装，无需新的包格式。

依据：固定Infinite Canvas `main.py:4031–4052`、`11610`、`15963`；[APIMart通用对话官方文档](https://docs.apimart.ai/cn/api-reference/texts/general/chat-completions)的`/v1/chat/completions`与code/data包装示例，以及[非流式官方文档](https://docs.apimart.ai/cn/api-reference/texts/general/chat-completions-nostream)的显式`stream:false`。只读取文档，未调用线上模型。固定参考对APIMart强制关闭流式；镜场保留用户开关，同时兼容同次请求的JSON完整回答和标准SSE输出，此差异明确保留。


## 0.77 Gemini 画布语言节点与音频

文本/剧本节点的 `params.llmBinding` 可以保存 `openai-compatible` 或 `gemini` 对话平台快照；Gemini 对话模型须为 `category:"chat"`，音频能力 `audioSupport:true` 必须由用户在 API 设置逐个开启。绑定快照保留该标记。Gemini 画布节点固定非流式，不根据模型名字自动开启音频能力。

| 方法与路径 | 用途 |
|---|---|
| GET `/api/projects/:id/canvas-run-plan` | 只在本机校验、准备视频抽样和音频试听记录；不向模型提交。步骤返回 `videoSamples`、`audioReferences`、用于用户预览的 `referenceDetails` |
| POST `/api/projects/:id/canvas-run` | `requestId`、`revision`、`consent:true` 及逐节点 `llmCredentials:[{nodeId,apiKey,authorization}]`。每个节点的授权含服务 origin、model、sendPrompt、sendReferences、requestLimit:1、正 budget 和 CNY/USD |
| POST `/api/jobs/:id/resume` | 画布任务按已保存快照恢复；已提交的同步对话无可查询编号，未完整/未知结果不重发，也不驱动后续节点 |
| POST `/api/projects/:id/apply-generation` | 完成的画布任务结果幂等加入原项目；新建结果节点，保留原提示词。未完成文字片段不自动回填 |
| POST `/api/projects/:id/bundle` | 含 Gemini 语言绑定时输出 v12 完整备份；模型音频标记和素材映射随备份恢复，导入更换素材ID，不迁移密钥 |

`referenceSources` 每项只允许 `sourceNodeId` 或 `assetId` 之一。动态素材须为相连上游节点；素材须属于当前项目。每步最多8张 PNG/JPEG/WebP 图片、3份 MP4/WebM/MOV 视频及1份 WAV/MP3/AAC/AIFF/FLAC/OGG/WebM/M4A 音频。音频≤10MB，并校验内容头；图片/视频需要 `referenceSupport:true`，纯音频输入不依赖图片能力。视频仍只发送抽样图片和时间点，不含原声音；选中的音频原文件随已授权请求内嵌发送。

Gemini 使用 `x-goog-api-key` 与 `models/:model:generateContent`，请求体为 `contents`、可选 `systemInstruction` 和 `generationConfig.maxOutputTokens`。已知静态请求在计划阶段检查18MB编码上限，生成的动态素材及实际下游文字在提交前再次检查。没有另行远端文件上传、自动重试或模型替换。

只有明确的 `finishReason:"STOP"` 才算完整回答。达到输出上限、缺失/未知结束状态均保存片段并停止下游；未知原文不写入状态记录。独立会话复用此规则，并在创建任务/追加消息前检查18MB请求上限；服务端直接请求同样拒绝单条消息的第二份音频。

协议字段依据 [Gemini 音频理解文档](https://ai.google.dev/gemini-api/docs/generate-content/audio) 与 [GenerateContent 响应字段](https://ai.google.dev/api/generate-content)。本版验证为隔离本机模拟服务，不能证明真实模型权限、识别质量、价格或代理兼容。

## 0.78 Gemini 原视频输入

- `PUT /api/platforms`：Gemini 的 `chat` 模型可保存 `videoSupport:true`，默认关闭；应按模型及代理文档明确启用。该标记仅声明原视频输入能力，图片/抽样仍需 `referenceSupport`，独立音频仍需 `audioSupport`。
- `POST /api/chat-media/prepare`：`{assetIds,videoInputMode:"frames"|"native"}`。默认 `frames` 使用既有抽样缓存；`native` 在本机校验 MP4/WebM/MOV 原文件，返回 `nativeVideos`。本接口不访问模型或远端素材服务，也不会抽帧替换原片。
- 原视频记录为 `{id,assetId,method:"original-file-v1",sourceSha256,sourceType,mimeType,size,duration,width,height,hasAudio}`。MP4/WebM/MOV 分别发送 `video/mp4`、`video/webm`、`video/quicktime`；`hasAudio` 表示文件是否有音轨。准备记录与原文件的校验值、类型、尺寸、时长及音轨信息一致才可使用。
- `POST /api/conversations/:id/messages`：为新原视频传 `nativeVideoIds`（已准备的编号），原有 `videoSampleIds` 继续表示抽样。最近20条完整上下文含原视频时，必须为已启用视频能力的 Gemini 文字对话，并明确确认 `authorization.sendNativeVideo:true` 及原有服务/模型/预算/一次请求范围。无新素材的追问也包含这项历史发送确认。每个视频在同一消息内只能有一种预览；在不同历史消息中的已确认方式分别保留。
- `params.llmBinding.videoInputMode` 同为 `frames`（缺省）或 `native`；原视频要求平台为 `gemini` 且模型快照有 `videoSupport:true`。计划 `nativeVideos` 显示固定视频，`referenceDetails.dynamic` 标记本轮上游生成。含原视频的步骤 `sendNativeVideo:true`，逐节点 `llmCredentials[].authorization.sendNativeVideo:true` 必须明确确认，子任务 `input` 保存实际视频方式及原片记录。动态生成后再次检查原文件与整体请求大小。
- 单条对话/语言节点最多3份视频；原视频每份≤10MB。Gemini 请求编码后整体≤18MB，覆盖系统指令、全部当前上下文、图片、文档内嵌图和音频。独立对话与已知静态画布输入在建任务前检查，动态素材在上游完成后、语言模型子任务建立前检查。超限不提交语言模型，不自动抽样、不压缩或重发。
- Gemini 发送 `contents.parts[].inlineData` 原文件，使用 `x-goog-api-key` 与单次 `generateContent`，没有另行远端文件上传。原视频内的音轨也包含在原字节中；是否及如何理解取决于所选模型，不承诺识别所有事件。
- 含原视频历史或原视频语言绑定的完整备份使用 v13；素材与原片记录重映射后可继续。v1–v12保留原能力，原视频内容伪装为旧格式会被拒绝。不迁移密钥、旧请求编号或自动提交。

尚不支持大文件 File API/云存储上传、YouTube 输入、其它视频格式及 Gemini 流式视频。本地模拟协议与 Chromium 检查不是实际服务权限或识别质量验收。字段依据 [Google 官方视频理解文档](https://ai.google.dev/gemini-api/docs/generate-content/video-understanding)。

## 0.79：三维 GLB 素材与 RunningHub 输出

- `GET /api/cloud-models` 中16项 `outputType:3d` 型号现可配置。请求仍复用版本固定的官方目录、单次服务/预算/发送范围确认和原任务查询；仅接收查询结果 `outputType:3d` 或 `glb` 中的自包含 GLB 2.0 文件，其他三维格式不自动转换。
- 三维输出保存为 `model/gltf-binary`、`.glb`。下载沿用公共 HTTPS/明确本机来源及无重定向的既有地址边界，最多64MiB，检查二进制头、实际长度、JSON/BIN段、网格、顶点和本机资源范围；拒绝外部资源和含本次密钥的输出。
- `POST /api/assets?name=文件.glb` 可本机导入，Content-Type 为 `model/gltf-binary`；校验失败不新建素材。带 MIME 参数会规范为该标准类型。Chrome采集扩展的上传类型范围不扩大。
- `GET /api/model3d/:assetId` 检查本机普通文件、实际大小及内容，返回素材记录和 `model3d:{format,meshes,primitives,vertices,animations,size}`，拒绝损坏文件与符号链接。
- `GET /api/assets/page?type=3d` 筛选三维素材。云结果加入场景节点；`scene` 可绑定 `outputType:3d` 的标准模型，画布执行按原有授权和恢复规则工作。没有三维输入/转格式协议。
- `/model3d.html?asset=...&project=...` 使用本机 three.js 模块预览，提供旋转、缩放、平移、复位、线框和原文件下载；不从CDN加载模块或读取模型外部资源，浏览器无法渲染时保留下载入口。压缩网格解码和动画播放控制尚未接入。
- v14完整备份支持GLB素材和三维模型配置，恢复重映射素材与绑定；v1–v13继续支持原有能力，伪旧版三维包会被拒绝。

所有本轮生成验收均使用本机模拟服务和合成三维文件，不证明任何型号真实云输出格式、账户权限或质量。


## 0.80：用户主动查看本机 CLI 信息

- `GET /api/local-cli` 返回三个程序的查找状态、帮助主题和 `infoAvailable`；原 `GET /api/codex/status`、`/api/gemini-cli/status`、`/api/jimeng/status` 同样只查找文件，不执行程序。安装、版本执行、登录和账户属于不同状态。
- `POST /api/{codex|gemini-cli|jimeng}/version` 接受 `{consent:true}`，只运行固定 `--version`。
- `POST /api/{codex|gemini-cli|jimeng}/help` 接受 `{consent:true,command:""}`；`command` 必须是所选程序的白名单主题。Codex/Gemini/Antigravity加 `--help`，即梦加 `-h`。`login` / `install` / `user_credit` / 生成主题也只有帮助，不接受自由参数、路径、脚本或提示词。
- Gemini和Antigravity按已解析的程序及显式配置区分，不混用帮助主题。程序路径来自服务环境或PATH，不来自浏览器请求；不会返回完整程序路径。Windows `.cmd/.bat` 与WSL暂返回501；缺失程序404；并行信息请求409；超时504。真实Windows执行尚未验收。
- 不经shell，不传入API Key或 `NODE_OPTIONS` 等任意父环境变量；只保留运行所需的系统路径/语言/临时目录环境。标准输入关闭，单次总输出最多64KiB，版本10秒、帮助20秒超时；关闭页面中止等待，POSIX停止本次创建的进程组。失败不返回原始错误输出、不自动重试。帮助输出中的常见凭据形态与终端控制码会过滤，并通过纯文字显示。
- 响应含 `text` / `arguments` / `checkedAt`，版本另有 `version`。`loggedIn:null`、`accountChecked:false` 保持未检查；不写入业务配置/项目/任务/日志，不创建生成任务。CLI本身由用户安装和管理，工作台不读取其认证文件。

本机Codex版本与主帮助已真实只读检查；其余CLI及超时/取消/主题差异使用隔离的合成可执行程序。CLI对话、图片、视频、积分与登录、任务恢复尚未接入。命令语义核对[官方Codex命令文档](https://learn.chatgpt.com/docs/developer-commands?surface=cli)及本机Codex实际帮助；固定Infinite Canvas版本的状态/帮助接口位于根 `main.py` 12925–13182行。

## 0.81：方舟 Seedance 2.0 多素材参考

创作台 `config.arkReferenceMode` 可选 `frames`（默认、保留旧首尾帧语义）或 `multimodal`（Seedance 2.0）；后者的 `reference_image/reference_video/reference_audio` 不与首尾帧角色混用。模型ID须为2.0系列；`ep-` 接入点允许显式选择此模式，但平台的实际模型与权限仍未检查。

- 本机引用仍是 `{assetId}`；外部引用是 `{url,type}`。图片类型PNG/JPEG/WebP，视频MP4/MOV，音频MP3/WAV；HTTPS需公网地址且不含登录信息、查询参数或片段，`asset://`编号仅在此模式接入。类型与顺序保存在创作台、画布绑定和备份中，不按后缀猜测或静默丢弃。外链添加/本机预览不请求远程媒体；其格式、时长、权限未知，提交后由平台检查。
- 上限9图/3视频/3音频，至少一张图或一段视频。视频、音频各自单段2–15秒、总长15秒。本机可解码PNG/JPEG/WebP最多10MiB/张、宽高300–6000、比例0.4–2.5、最多1600万像素；本机MP3/WAV最多15MiB/段，检查真实单音轨、时长及总时长。工作台48MiB JSON限制比平台64MB请求限制更小，Base64膨胀计入本机限制。平台素材与公网链接不在本机下载，不把未知值记为已核实。
- `GET /api/studios/:id/reference-preview` 仅执行本机解码与内容校验，不创建任务；返回 `fingerprint`、`inputs`（媒体类型、来源、原内容SHA256和已知尺寸/时长）、`counts`、`knownAudioDuration`、`encodedBytes`、`externalMediaUnchecked`、`sendOriginalMedia`、`revision`，不返回媒体字节。
- `POST /api/studios/:id/generate` 的多参考请求需附此 `referenceFingerprint`。视频/音频参考还需 `authorization.sendOriginalMedia:true`；服务、模型、请求数量、素材与预算授权沿用原字段。提交前复核字节、尺寸和时长，内容变化返回409，零生成提交。密钥仍只在本次内存中使用。
- 画布 `studioBinding` 的参考映射保留类型，静态与动态图片/音频可串联；已知本机来源的内容校验在父子步骤间复核，动态结果在实际发送前检查。此节点凭据的授权也须确认 `sendOriginalMedia`。原视频仅使用公网HTTPS或平台asset编号。0.82补AK/SK URL入库；0.83补独立临时托管原文件与入库表单连接。不会擅自抽帧、静音或发送未支持的Base64视频。
- 原任务恢复只查询原编号和下载结果，不重读/重交参考；未返回编号的生成请求不会自动重发。已有结果回填、幂等和版本冲突机制不变。完整备份v15保留类型与参考模式并重映射本机素材ID；v1–v14继续使用原语义，携带多参考新语义却标为旧版本的备份被拒绝。

依据：[固定Infinite Canvas的方舟生成分支](https://github.com/hero8152/Infinite-Canvas/blob/67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e/main.py) 15690–15778行，以及[方舟官方创建视频任务文档](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh&redirect=1)（读取2026-09-30，页面更新2026-09-22）。本轮只实现2.0参考范围，不沿用文档中2.5系列的更大容量或音频单独生成能力。


## 火山素材库（0.82）

入口为画布资产页和创作台素材库的“火山素材库”。这是素材管理，不调用第三方Agent。正式地址固定为 `https://ark.cn-beijing.volcengineapi.com`，不是视频生成的 `/api/v3` 地址。只接入北京地区AIGC素材组；真实账号、授权函与余额未验收。

| 方法与路径 | 行为 |
|---|---|
| GET `/api/ark-assets?projectId=…` | 仅查询该项目本机保存的素材库记录 |
| POST `/api/ark-assets/preview` | 本机检查元数据、关联文件及发送范围；不调用火山、不创建记录 |
| POST `/api/ark-assets/create` | 一次CreateAssetGroup或CreateAsset，按项目/requestId去重，不重发不确定提交 |
| POST `/api/ark-assets/browse` | 一次ListAssetGroups或ListAssets，固定AIGC过滤，每页20项；组最多500页、素材最多1000页，更深NextToken分页尚未接入 |
| POST `/api/ark-assets/remember` | 将服务器本次查询产生的5分钟selectionId保存到当前项目，不联网；不能用任意客户端记录伪造查询结果 |
| POST `/api/ark-assets/:id/refresh` | 只按保存的原编号GetAsset，不重新创建；校验项目、组、类型及状态 |

预览字段：`projectId`、`kind`（`ark-group`/`ark-material`）、`endpoint`、`cloudProject`（默认default）、`name`。组可用`description`；素材使用`groupId`、`assetType`（Image/Video/Audio）、`sourceUrl`，可选`localAssetId`。

预览返回`fingerprint`；素材可附`localSource`的大小、SHA-256、实际宽高、时长/平均帧率与是否含声音。关联本机文件不证明公网文件相同。图片/音频复用现有10MB图片、15MB音频与2–15秒音频检查；视频本机检查最多150MB、MP4/MOV、2–30秒、24–60平均帧、官方尺寸/比例/像素范围，实际解码；未覆盖官方的所有图片格式及16–30秒音频。

外部请求逐次传入`accessKeyId`和`secretAccessKey`，不保存、不使用环境变量凭据。`consent`必需精确匹配`endpoint`、`cloudProject`、`action`、`requestLimit:1`、`sendCredentials:true`。创建另需`requestId`、匹配的`fingerprint`及`consent.fingerprint`、`consoleAuthorizationAccepted:true`；素材另需`sendPublicUrl:true`，视频/音频还需`sendOriginalMedia:true`。平台首次授权函须由用户在控制台完成，界面确认不代替法律授权。

正式素材只接受无凭据/查询/片段的公网HTTPS地址，不支持Base64、本机地址或自动公开本机服务。为了隔离测试，显式loopback HTTP模拟端点只可引用同源本机媒体地址；不能借此将本机地址交给正式火山服务。接口不跟随重定向，只发送白名单元数据。平台返回的12小时签名访问URL、原始错误信息、翻页凭证均不返回或保存。

记录在 `data/ark-materials/`，保存原平台编号与状态。只有Active可引用，Seedance 2.0关联本机参考超过15秒时不提供直接引用。恢复的v16记录仍保存平台原编号，但标记`restored:true`，在界面重新查询后才能引用；平台素材不随备份迁移账号。无原编号的待确认提交需去平台核对，没有自动重交入口。第1–15版备份继续支持原有语义，携带素材库记录时必须为第16版。

协议来源：[创建素材](https://docs.volcengine.com/docs/ark/create-asset-api?lang=zh)、[创建素材组](https://docs.volcengine.com/docs/ark/create-asset-group-api?lang=zh)、[素材状态](https://docs.volcengine.com/docs/ark/get-asset-api?lang=zh)、[素材分页](https://docs.volcengine.com/docs/ark/list-assets-api?lang=zh)。这些说明不是实际账号或云端可用性的证明。


## 0.83 原文件临时托管

| 接口 | 行为 |
|---|---|
| GET `/api/public-media/profiles` | 离线返回temp/Litterbox固定目的地、72小时预计保留及150MiB文件上限 |
| GET `/api/public-media?projectId=…` | 只读取本项目保存的上传记录，不查询或重发托管请求 |
| GET `/api/public-media/:id?projectId=…` | 原记录与本机上传进度；重启后失去活动句柄的uploading返回uncertain |
| POST `/api/public-media/preview` | 本机原文件、普通文件/符号链接检查及SHA-256；不上传、不创建记录 |
| POST `/api/public-media/start` | 预览指纹和公开范围确认后，按projectId/requestId去重；202返回，后台只发送一次 |
| POST `/api/public-media/:id/reference` | 只在本机复核原文件内容及预计到期时限，返回原成功链接；不重新上传、不读取外链 |

预览输入：`{projectId,assetId,service,purpose,endpoint?}`。service为`temp`或`litterbox`；purpose为`ark-material`或`generation-reference`。正式接口固定为`https://temp.sh/upload`和`https://litterbox.catbox.moe/resources/internals/api.php`，没有任意HTTPS代理或自动服务选择。仅相同路径的显式loopback HTTP接口用于隔离模拟。返回链接须为所选服务的HTTPS域名（temp.sh、litter.catbox.moe/litterbox.catbox.moe），无查询参数、登录信息或片段；模拟链接限同源HTTP。没有Bearer或AK/SK上传凭据。

start另需`requestId`、返回的`fingerprint`及consent：`{fingerprint,endpoint,service,purpose,retentionHours:72,requestLimit:1,publicScope:"anyone-with-url",sendOriginalMedia:true}`。每一项都须匹配当前原文件/目的地预览；不是全局、永久或后续生成授权。文件由本机素材编号定位，不能提交路径。图片/视频/音频按原字节multipart上传，不转码、不裁剪、不去声音，向托管服务提供素材编号文件名，隐藏原文件名/路径。temp使用`file`；Litterbox使用`fileToUpload`、`reqtype=fileupload`、`time=72h`。请求固定Content-Length，原内容发送前及流式读取后复核；不跟随重定向、不转交上游授权头。成功URL不加载为远程预览。

记录保存在`data/public-media/`，含来源类型/大小/SHA-256、目的地、用途、原requestId、1次提交、传输字节和预计过期时间。状态为uploading/ready/rejected/uncertain，读取时按预计时限派生expired。ready表示服务返回了格式正确的链接，不证明远端文件与本机内容相同；availabilityUnverified始终为true。响应HTML、断流、过大响应、非白名单链接、重定向及5xx均为uncertain；明确4xx为rejected。所有状态都不会自动重发、续期或换站。

火山preview/create可附`publicMediaId`，与sourceUrl/localAssetId/当前内容摘要共同复核；上传记录须属于当前项目且预计未到期。火山记录保存该关联；不含此字段的旧入库请求保持原行为。火山入库仍需另行AK/SK和平台授权确认，生成仍需独立服务、预算和原文件范围授权。链接可复制后用于其他已支持的外部图片参考接口，但本次托管不扩展那些接口的模型或视频多参考能力。

完整备份按需使用v17，保留publicMedia记录及其本机原文件依赖；火山publicMediaId、原文件ID和记录ID同时重映射，时间及URL保持原值，恢复标记restored。恢复不上传、读取外链或恢复先前的发送授权。0.83的文件上限为150MiB，0.85扩容见下文。协议来源为用户指定[固定版本main.py](https://github.com/hero8152/Infinite-Canvas/blob/67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e/main.py) 9379–9444；temp.sh的file multipart及三日说明在2026-09-30只读核对[官方首页](https://temp.sh/)。Litterbox官方网页当轮未能访问，未进行任何真实托管验收。

## 0.84 本机火山凭据来源

- `GET /api/ark-credentials/status`：只返回configured、source和有限状态。优先检查服务端环境变量ARK_API_KEY；macOS缺省时查询固定同名钥匙串服务的元数据，不加-w/-g、不返回属性、账户或秘密。configured不代表有效认证或模型权限。
- 创作台`POST /api/studio-models`、`POST /api/studios/:id/generate`、`POST /api/studios/:id/jobs/:jobId/resume`可带`credentialSource:"ark-local"`、`credentialConsent:true`和空apiKey。默认manual保留原单次填写行为；不能同时发送本次密钥和本机来源。
- 本机来源仅允许video、ark协议、HTTPS北京官方origin和精确/api/v3路径（可有尾斜杠）。拒绝不同端口、用户信息、查询、片段、其他路径/域名、代理或loopback目标；测试在独立Node预加载器中将官方URL映射到自有本机服务，正式模块没有HTTP开关或白名单例外。
- 生成仍必须有一次请求、正确服务/模型、正预算、提示词与参考范围授权。检查项目版本、参考格式和多素材指纹后才读取密钥；获取失败不创建生成任务，不静默改用其他密钥。模型发现还需consent:true；恢复只使用保存的原任务快照和上游编号，不根据当前连接设置重投。
- 画布`studioCredentials[]`逐节点带同样字段，保持每个节点的预算及发送范围确认。本机描述在执行内存中传递；实际密钥只在子任务服务端临时使用。原查询仍需本次选择和确认。
- 任务仅记录来源类别，不保存密钥。项目、工作流绑定和完整备份不保存来源选择、密码或执行授权，保持既有v1–v17备份格式。已有火山API Key不作为AK/SK素材库凭据。

本机CLI参数依据为`/usr/bin/security help find-generic-password`：-s匹配固定服务，-g显示密码，-w只输出密码。状态故意省略后两者；读取时捕获输出，限制2.5秒/8KiB，所有失败使用固定用户提示，不传播子进程的stdout/stderr。生成结束/停止清除服务端任务内存中的引用。服务端环境变量属于原进程配置，镜场不改写它或新建秘密文件。

435项自动测试和44项浏览器检查通过。本机实际状态configured:true/source:macos-keychain；只做配置存在性检查，本轮没有提取用户密钥、查询真实火山模型清单、上传素材或付费生成。详见 [0.84验收记录](VALIDATION-0.84-2026-09-30.md)。

## 0.85 大文件流式导入、托管及v18备份

| 接口 | 行为 |
| --- | --- |
| POST `/api/assets/stream?projectId=...&requestId=...&name=...` | 请求正文为原始媒体文件；`Content-Type`填写实际媒体类型，`X-Jingchang-File-Size`填写准确十进制字节数。若存在Content-Length必须一致。完整接收及校验后返回201和素材信息 |
| GET `/api/asset-imports/:requestId?projectId=...` | 仅读取该项目原导入记录和实际接收进度；状态为importing/completed/incomplete，重启遗留importing显示interrupted。不重新发送文件 |
| GET `/api/public-media/profiles` | temp的本机上限4,000,000,000字节；Litterbox仍为150MiB，不自动换目的地 |

流式导入只接受常见PNG/JPEG/WebP/GIF/AVIF、MP4/MOV/WebM/FLV及MP3/WAV/OGG/Opus/FLAC/M4A/AAC/WebM音频。文件头检查只识别容器，不替代实际解码及平台输入校验。其他文本、JSON、GLB、Office文档仍沿用原接口和原限制。普通素材接口`POST /api/assets`及Chrome采集仍为150MiB，没有统一扩大生成协议输入。

浏览器直接发送File，不调用整份文件的arrayBuffer；服务端逐块写盘、计数和SHA-256。请求长度、容器头、普通文件/非符号链接、磁盘余量及完成文件身份均核对，未完成正文不产生素材索引。`data/asset-imports/:requestId/original.bin`保留完整或部分原件；成功时与`data/assets/:assetId`硬链接同一文件，不额外复制4GB。原编号重复提交只能返回原完成素材；未完成原编号不重新接收，跨项目及已改变的文件拒绝。失去回复的客户端只读取原记录，不自动重发。

本机原文件托管保持描述符流式传输、完整内容绑定和单次确认；预览和本机导入不联系目标服务。temp.sh的file multipart、三日及4GB说明在2026-10-01再次只读核对[官方首页](https://temp.sh/)。镜场采用明确的十进制4GB限制，Litterbox仍保留已实现的小文件范围。公网传输时限扩至一小时，不自动重试、改用另一服务或改变文件编码。只验收本机模拟接口，不宣称实际托管服务可用。

含超过150MiB常见媒体、FLV或合计超过512MiB普通媒体的备份使用v18。支持每份常见媒体≤4GB、全部文件≤4GiB及12MiB清单；LoRA单文件限制保持2GiB，非媒体不借v18扩容。v1–v17继续维持旧容量和语义，新媒体内容不能伪装成旧版。导出、检查和恢复均流式处理，逐份SHA-256核对并重映射原关联；磁盘不足时停止且保留已经收到的部分文件。项目备份不包含暂存导入台账、密码、执行授权、生成任务或修订历史。

## 0.86 Midjourney 操作与任务恢复

沿用现有 `/api/studios/:id`、`/generate`、`/jobs/:jobId/resume`、`/apply` 和画布执行接口。配置需要 `mode:image`、`protocol:midjourney`、`model:midjourney`、`imageAsync:true`、`count:1`、`quality:auto`、`transparent:false`。界面选择协议时设置上述参数，保留用户填写的 Base URL；不会将火山本机凭据用于此协议。

| 参数 | 含义与范围 |
|---|---|
| `mjMode` | `imagine`、`blend`、`edit`、`upscale`、`variation`、`low_variation`、`high_variation`、`reroll`、`zoom`、`pan`、`inpaint`、`modal`、`remix_subtle`、`remix_strong` |
| `mjSpeed` | `relax` / `fast` / `turbo`，默认 `relax` |
| `mjVersion` | 文生图版本，默认 `6.1`；是否可用由平台核验 |
| `mjSize` | 自定义宽:高，两边1–99，例如`7:5`；未填写沿用画幅 |
| `mjTaskId` | 二次操作必填，同一服务的原任务编号；不接受路径、查询参数或连续两个点 |
| `mjIndex` | 原任务第1–4张图片，默认1 |
| `mjZoom` | 缩放扩图倍数，大于1且不超过4，默认2 |
| `mjDirection` | `left` / `right` / `up` / `down` |
| `mjMaskConvention` | `white-edit` 为镜场白色区域重绘遮罩；`alpha` 为平台透明区域重绘PNG |
| `mjCustomId` | 可选平台按钮编号；不填时由平台根据操作、序号、方向自动匹配 |

一份授权提交一次操作，单价按“每次操作”估算，返回图片可能为1–4份，不能将 `count:1` 当作只接收一张结果。每份结果均保存到本机；创作台可以一并回填同一主画布，画布链继续使用该节点首份结果作为动态参考，全部结果可在任务中下载和回填。

- 文生图/参考图生成：`POST midjourney/generations`，发送 `prompt`、`speed`、`size`、`version` 和可选 `image_urls`。
- 多图融合：`POST midjourney/generations/blend`，需要2–4张PNG/JPEG/WebP，仅发送图片、画幅和速度，不发送提示词。
- 图片编辑：`POST midjourney/generations/edits`，提示词和至少一张参考图片。
- 二次操作使用专用路径，例如 `/upscale`、`/low-variation`、`/zoom`、`/pan`、`/remix-subtle`，发送原 `task_id`；支持可选 `custom_id`。不接受新参考图片，以免静默忽略输入。
- 已授权的本机或HTTPS参考图片转换为data URL；没有自动上传到另一个托管服务。图片保留10MiB上限，请求JSON继续遵循48MiB上限。
- 查询为 `GET midjourney/:encodedTaskId`，仍按原任务快照中的目的地处理。返回编号必须一致；未知状态、其他任务、相互矛盾的编号或不完整图片结构停止处理，不自动重新提交。
- 完成响应支持1–4张 `image_urls`，无单张列表时可接收一张 `grid_image_url`。输出URL下载不携带API Key；最多32个合规平台按钮编号保存在任务中，界面只以转义文字展示。

局部重绘分两次确认。第一次 `/inpaint` 使用已放大的单图任务编号，不发送选图序号。返回 `MODAL` 后，任务持久化为 `awaiting_input`，停止本机轮询，不算图片生成完成，也不会自动请求 `/modal`。在任务界面点击“补充重绘遮罩”仅载入**这次返回的编号和原目的地**；添加一张遮罩后，再确认密钥、预算和发送范围。第二次 `/modal` 使用新的编号及 `mask_url`，可补充提示词。白色重绘遮罩转换为透明像素；平台alpha模式保持原PNG字节。画布在等待补参时停止下游，保留原编号；显式恢复只查询原任务，仍等待补参时继续停止，不自动生成遮罩或补参。

包含Midjourney创作台或节点绑定的完整备份使用v19，恢复时重映射本机参考资产并保留操作参数。原任务编号只是外部参数，仍需相同服务和账号权限；不迁移生成任务、密钥、预算授权，也不重新提交。v1–v18备份保留原含义，不能伪装携带新绑定。

功能依据为[用户指定的固定版本 main.py](https://github.com/hero8152/Infinite-Canvas/blob/67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e/main.py#L14051-L14363)以及APIMart官方[操作总览](https://docs.apimart.ai/cn/api-reference/images/midjourney/generation)、[查询响应](https://docs.apimart.ai/cn/api-reference/images/midjourney/query)、[重绘入口](https://docs.apimart.ai/cn/api-reference/images/midjourney/inpaint)和[重绘补参](https://docs.apimart.ai/cn/api-reference/images/midjourney/modal)。按可观察协议独立实现；本机模拟验收不证明真实平台权限、计费、模型版本、超时时间或图片质量。


## 0.88 素材库组织与v21备份

素材库修改带全局`revision`，冲突返回409；收藏启动后每份完成都会更新目录修订。已有素材不会在启动时被自动分组。复制核对源文件真实身份、声明大小、媒体容器和读取结束状态，源文件改变时不发布收藏结果。保存后的媒体和分组文件为独立副本，保持导入收据的文件校验有效；复制未完成文件留在原尝试中，明确继续使用新编号。

`GET /api/assets/page`新增`libraryId`与`folderId`参数；与原有项目/全局范围、类型、分类、智能分类和搜索相交。`GET /api/jobs/:id`和任务中心识别`library-copy`，专用界面读取其实际进度。回收不删除源文件、完成副本、分组文件或收据；跨分组移动也保留此前文件。工作流字段编辑同步带内容校验后缀的分组文件，旧版本保留。

v21新增`assetCatalog`关系及已有图片分类。只打包本工程涉及的媒体及绑定的ComfyUI条目，保留它们所在库的空分组、名称、类型与回收状态；不包含其它项目素材、整项目快照、目录授权、复制任务或凭据。导入为素材库、分组、条目、资产与工作流重新分配编号；同一恢复请求重复执行不覆盖现有库或重复创建项目。未涉及新字段的备份继续用其所需的最低版本，v1–v20既有校验语义保留。


## 0.89 选中画布工作流与v22

`canvas-fragment`保存1–1500个所选节点、它们之间的连线、分组成员交集和所需媒体/绑定模板。未选的节点、镜头、消息、对话、创作台历史、授权、密钥、任务、目录索引及托管记录不进入模板包。绑定引用所选范围之外的节点时，返回带节点名称的错误，要求明确一并选择；不会擅自扩大选区。

v22增加`canvasFragment:{version:1}`标记，并保留内置图片编辑、全景、增强及LoRA等媒体依赖。普通完整备份继续采用其所需的最低版本，v1–v21语义保留。清单上限12MiB、所有媒体合计4GiB；单文件仍遵守实际媒体类型的大小限制。文件导入校验格式、声明大小、SHA-256及敏感字段；本入口不支持Infinite Canvas原生JSON/ZIP或整库备份。

插入在当前项目锁内执行，先校验目标修订、活动任务、1500节点/5000连线/1500分组容量与位置，再准备独立资源。节点、边、组、素材、ComfyUI模板和RunningHub配置重新编号；只改画布节点引用，不改工作流内部计算节点ID、字段名或片段ID。保留目标既有节点、素材、分镜、消息、设置及视图；相对位置保留，未给位置时放在目标右侧。

插入收据在`data/asset-catalog/insertions/<requestId>.json`。相同编号固定同一条目、目标与位置；修订可在明确继续时刷新。服务重启仅显示中断记录；明确继续使用原资源计划，不重复制完成项。项目已经提交而回复丢失时，由项目中的`kind:canvas-fragment`标记确认原操作。完成记录再次读取不会增加修订，已撤销或移出的节点不会被重新添加。资源准备中断后，已存在且被用户编辑的模板/元数据不会被覆盖。

关闭窗口后本机插入继续。界面收到结果时，仅合并这次插入的节点、边、组和素材，保留复制期间的本机编辑；编辑控件绑定原节点，避免旧文本框失焦时写入新选中节点。一次撤销移除新增图谱及项目关联，媒体和模板文件保留；重做复用相同编号。下载后可在另一镜场工作区导入工作流分组，再插入已有项目；没有中间工程或自动生成。


## 0.90 原生画布JSON/ZIP与v23

| 请求 | 用途 |
|---|---|
| `POST /api/native-canvas/imports?requestId=<id>&name=<名称>`，二进制文件正文 | 接收原生JSON/ZIP，检查后返回预览；不保存素材库条目或创建项目 |
| `GET /api/native-canvas/imports`、`GET /api/native-canvas/imports/:id` | 完成接收记录/原编号预览，只读不恢复执行 |
| `POST /api/native-canvas/imports/:id/library` | 显式保存至工作流分组，正文为`requestId,revision,libraryId,folderId,name`，复用素材库的修订/幂等校验 |
| `POST /api/native-canvas/export` | 正文为`type:json|zip,itemId`，或`type,projectId,revision,nodeIds`；创建原生下载文件，不生成媒体 |
| `GET/HEAD /api/native-canvas/exports/:id/download` | 已完成原生文件，支持范围下载及UTF-8文件名 |

支持v1普通/智能格式、裸节点数组、嵌套`workflow`及UTF-8 BOM。完整原始节点和文档额外字段保存于`params.nativeCanvas`；本机节点另保留有序输入、成员与全部媒体编号。节点/资源新编号、分组/有序输入复制与插入重映射；全量/选区`.jingchang`含原生记录时升级为v23，v1–v22保留原语义。来源格式及节点问题进入文件摘要，不以数据接收成功替代执行验收。

原始JSON经模式/凭据校验后才写入文件；资源文件使用本机新编号，不按ZIP路径解压到宿主机。ZIP检查本地头、中央目录、CRC、SHA-256、声明大小、实际头部和ZIP64字段；只接受已写大小的Stored/Deflate，无加密/数据描述符/符号链接/特殊文件/未知非媒体条目。清单12MiB、媒体1000份/合计4GiB、目录尾8MiB，磁盘至少余64MiB。各媒体文件沿用类型的大小限制。接收中断或拒绝保留隔离的部分文件，不发布条目。

JSON的内嵌base64媒体验证后保存为本机资源；未打包的本地/公网/blob/asset地址列为缺失，不读取或联网下载。原生输出保留原始节点编号及未知参数引用，素材URL替换为本次打包路径；原编号重复要求分别导出。配置、成员和有序输入会随明确的画布编辑更新；原始文件仍保留在接收目录。

`nativeNodeIssues(node,project)`使用实际连线检查未适配语义，防止新增连线后沿用旧标记跳过聚合/多媒体依赖。普通生成配置需显式绑定与迁移确认；直接ComfyUI和图片生成接口也检查本节点。原生MiniMax H3可通过专用编辑器选择ComfyUI或RunningHub显式迁移；原生循环、拆分、聚合及整组输入输出仍拒绝执行。迁移为本机配置的节点原生导出拒绝，须用`.jingchang`。

明确迁移的画布任务保存源节点的初始文字/素材/参数指纹。结果应用时校验原配置未改，再关联首份同类型结果或完整文字到原生源节点；所有结果同时保留为独立输出节点。编辑中的源节点不会被覆盖。此指纹仅用于本机防误覆盖，不是授权或云端生成证明。

接收记录与导出文件在`data/native-canvas/`，保存后复用素材库既有插入收据和重启继续流程。相同接收编号只接受相同原件与名称；相同发布编号复用既有条目。读取记录、刷新或重启不会生成、重新上传或默认继续。原生文件没有全局API/插件/ComfyUI环境，原生导入与源软件真实运行仍分开验收。


## 0.91 MiniMax H3 与 v24

时间轴保存于视频节点 `params.minimaxH3`（未绑定）或 `params.workflowBinding.minimaxH3`（已绑定），两者不能同时存在。工作流绑定仍带 `workflowId,overrides:[],imageSources:[],count:1`；不能混用LTX、提示词列表、普通上游文字／媒体映射或图片增强。同次只生成当前段，变体独立确认。

时间轴格式：`version:1,referenceNodeId,selectedSegmentId,segments,refs,materials,autoUpstream,fallbackByKind,playhead,muted,timelineZoom`。1–64段，按起点排序且不重叠，总范围最多6小时。片段字段为 `id,start,duration,prompt,aspectRatio,megapixels,seed,refs,trimIn,trimOut,resultAssetId,resultAssetIds`。生成时长0.5–60秒、提示词≤32000字、百万像素0.1–2、种子为非负安全整数；裁切区间至少0.1秒并在片段时长内。

参考为 `{kind:'image'|'video'|'audio',assetId}` 或 `{kind,sourceNodeId}`，每类分别9／3／3项，同类重复拒绝。明确片段参考优先于全局／上游；智能原生历史配置可设 `fallbackByKind:true`，仅空片段按缺少类型补齐上游。每段结果和 `materials:[{assetId,segmentId}]` 只引用当前项目素材，动态引用须来自相连的同类型上游。

- `GET /api/projects/:id/canvas-run-plan?nodeId=...`：可选单节点及其祖先范围，跳过其它分支；范围包含循环时需要完整画布运行。所有范围内原生节点仍须完成适配检查。
- `POST /api/projects/:id/canvas-run`：现有执行确认体可带同一 `nodeId`，服务端重新计算执行范围；请求编号去重规则保留。
- `POST /api/projects/:id/generate`：可传 `minimaxH3,minimaxText,nodeId` 和实际 `workflowId/workflowRevision/overrides`。验证导入图中的真正H3参考类及相连提示词、尺寸、时长和种子；配置过的控件范围、隐藏字段仍生效。新增受控 `LoadImage`／`LoadVideo→GetVideoComponents`／`LoadAudio` 节点，清除参考槽位旧输入，只向使用的文件字段上传所选本机素材；模板保留。图片≤10MiB、音视频≤150MiB、单次映射素材合计≤300MiB，沿用现有Comfy输出接收上限150MiB。
- `POST /api/projects/:id/minimax-export`：体为 `{revision,requestId,nodeId,selectedOnly}`。构造独立渲染快照，按顺序拼接所选视频结果的裁切区间，使用项目画幅／帧率、适配保留完整画面，按静音设置处理原声。范围内有未完成／非视频结果或实际源区间越界则拒绝。返回现有 `kind:'render'` 任务，查询、停止、原快照恢复、播放／下载及加入素材库继续使用既有render路径；不修改当前项目分镜。

H3画布步骤保存所选片段及输入指纹，停止／重启恢复查询原 `promptId`，不重新上传或重复提交不确定项。加入结果时检查原片段、绑定、全局参考、节点文字及上游输入；只回填未改输入的对应片段，并保留所有独立结果节点。修改选中片段或裁切本身不会把视频误写到另一段。

普通／智能原生H3通过专用编辑器读取片段和本机素材，显式确认迁移后启用本机绑定，原参数保留。0.92新增原生RunningHub H3的显式云时间轴迁移；仍不能将已迁移节点无损反向转换成外部平台配置，应使用`.jingchang`。

完整工程和选中工作流自动选用v24，包含全局／逐段参考、历史结果、素材抽屉及绑定模板；媒体和内部动态节点编号在恢复／插入／复制时重映射。v1–v23格式继续兼容，旧版本不能携带H3时间轴记录。

原生JSON/ZIP导出会拒绝任何已有镜场H3时间轴的节点，包括尚未绑定的时间轴，避免丢失已编辑片段。未编辑／未迁移的原生H3仍可保留原参数回存。

依据：[固定版H3 API图](https://github.com/hero8152/Infinite-Canvas/blob/67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e/workflows/MiniMax_H3.json)、[字段配置](https://github.com/hero8152/Infinite-Canvas/blob/67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e/workflows/MiniMax_H3.config.json)。本机模拟协议、Chrome与FFmpeg证据不能计作真实H3权重／插件／GPU或RunningHub账户验收。

## 0.92 RunningHub H3、整图发送与 v25

H3 时间轴 `engine` 为 `comfyui`（兼容旧记录默认）或 `runninghub`。云端绑定存于 `params.cloudBinding:{recipeId,recipeRevision,inputs:[],minimaxH3}`；未绑定存于 `params.minimaxH3`。三处时间轴不能同时存在，绑定引擎须匹配，云时间轴只用于视频节点。参考和提示词由片段管理，不能同时启用普通云字段映射。

- 云配置保存／预览接口支持 `workflowJson`（实际 API 图）与 `minimaxProfile:'h3'`。整图仅用于 `kind:'workflow'`，须有1–1000个节点，≤2MiB、嵌套≤30层；拒绝失效连线、秘密、带认证地址和原型字段。字段须指向现有普通输入，不能覆盖计算连线。保存时移除不再提供的旧整图／profile，防止残留错误目的配置。
- `POST /api/cloud-workflows/discover` 可传 `includeWorkflow:true`，须为工作流且仍需 `consent:true`。只查询，不生成；返回受限 `workflowJson` 和字段。包含本次密钥或秘密字段的整图拒绝返回保存；普通字段查询继续脱敏。识别 LoadVideo 的实际 `file`／`video` 输入。已有整图的普通云页面重新拉取时，同时更新匹配的整图，不丢失 H3 profile。
- H3 编译核对实际参考、提示词、分辨率、时长及种子节点；逐类型和次序使用云整图中已有 LoadImage／LoadVideo／LoadAudio 槽位，不虚构云节点。缺少所需槽位、共用一个输入冒充多个参考、缺失必选素材均拒绝。未选可选参考移除对应槽及独占祖先分支；其他输出使用的共享分支保留。原模板不修改。
- 9图／3视频／3音频；同类重复拒绝。专用提示词最多20000字。PNG/JPEG/WebP≤10MiB；MP4/MOV、MP3/WAV/FLAC≤30MiB。规划阶段检查现有素材归属、真实文件大小和内容；动态参考须来自同类型相连上游，运行时解析其结果。超量、类型／格式错误在发送前拒绝。
- `POST /api/projects/:id/canvas-run-plan?nodeId=...` 保留专用H3步骤、原始配方及对应片段输入指纹。当前段运行仍只包含该节点和上游；收到完整上游文字／素材后重新编译实际云配方。
- 云生成授权新增 `authorization.sendWorkflow:true`，只在该步骤实际发送整图时出现；不发整图却传该标记也拒绝。画布逐节点和普通云页面均显示整图，并确认同一站点、目标编号、字段、素材、预算及一次请求。预算只作授权记录，不能限制平台扣费。
- 上传每份素材一次后，将平台文件标识同时写入 `nodeInfoList` 和完整 `workflow` JSON 字符串，发送 `/task/openapi/create`，带 `addMetadata:true`。提交或上传回复不确定时不自动重发；停止、重建及服务重启仅恢复已保存的原任务编号，没有编号不重新生成。
- 接受结果时核对引擎、配方编号及版本、片段输入、全局参考和上游指纹；仅回填原未改片段，所有输出仍独立保留。修改选中段或裁切不误写其它段。切换引擎、解除绑定保留片段、参考及结果。云时间轴的本机FFmpeg导出使用原有独立快照路径。
- v25工程／选中工作流备份包含云API整图、H3 profile、云绑定及全部时间轴素材，恢复／复制／插入重映射编号。即使未绑定，只要H3引擎为RunningHub亦使用v25；v1–v24继续兼容其原有数据，不得承载新的云整图信息。原生JSON/ZIP导出仍拒绝已编辑的镜场H3时间轴，避免静默丢失内容。

提交形态以[固定版本 main.py](https://github.com/hero8152/Infinite-Canvas/blob/67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e/main.py) 12644起及普通／智能H3代码为依据。官方[高级工作流提交](https://www.runninghub.cn/runninghub-api-doc-cn/api-425749013)、[接入指南](https://www.runninghub.cn/runninghub-api-doc-cn/doc-8287342)与[上传示例](https://www.runninghub.ai/runninghub-api-doc-en/api-425761099)提供协议参考；本机整图模拟通过仍不能证明真实RunningHub端点接受该完整图字段或账号有权限。真实端点／账号／模型仍待验收；H3串行循环参数见0.93。

## 0.93 H3 串行循环参数与 v26

复用现有 `params.loop` 的 `repeat/list`、1–32轮、整图最多64次执行及最多16项 `fieldValues`，未引入原生并行或100轮循环。逐轮参数有两种独立格式：

```json
[
  {"targetNodeId":"普通视频节点编号","nodeId":"模板内节点编号","name":"seed","values":[10,11]},
  {"targetNodeId":"H3视频节点编号","kind":"minimax","name":"duration","values":[1,1.5]},
  {"targetNodeId":"H3视频节点编号","kind":"minimax","name":"seed","values":[71,72]}
]
```

H3格式不带模板 `nodeId`，仅用于该循环内已绑定的 ComfyUI / RunningHub H3 视频节点。`name` 只接受 `prompt,duration,aspectRatio,megapixels,seed`；类型、比例枚举及数值范围沿用时间轴校验，每项值数须等于轮数。普通字段的原格式保持。H3专用字段不再同时出现在通用模板变量候选中；同一参数重复映射、显式种子与Comfy自动递增同时启用均拒绝。

规划所有轮次后再允许首次提交，包含后续轮次的字段约束与安全整数溢出检查。RunningHub仍遵守20000字专用提示词限制。列表提示词仅在H3 `autoUpstream:true` 且该轮片段提示词为空时传递；有片段提示词遮住列表则拒绝，不能计为列表已被消费。每轮仅变更执行快照中的所选片段；时长变化在快照中移动后续片段起点并保留间距，原项目时间轴不变。

- `GET /api/projects/:id/canvas-run-plan` 展开所有轮次，`loopFields` 携带普通 `nodeId` 或专用 `kind`、参数名及该轮值。相连上游按本轮结果解析；H3使用初始项目的输入、绑定和依赖指纹。
- `POST /api/projects/:id/canvas-run` 沿用全局执行同意和每个云步骤的服务、预算、素材、整图同意；任何一项缺失均不提交。包含循环时不接受 `nodeId` 的单节点执行范围。H3界面明确显示「检查并运行完整画布」，不会悄悄扩大一个已确认的局部范围。
- 停止或服务重建沿用原步骤、子任务及上游编号。继续已提交RunningHub项只查询原 `taskId`，不再次上传或提交；上传／提交不确定且没有编号时仍不自动重发。
- H3循环输出素材保存 `loopId,roundIndex,sourceNodeId,segmentId,minimaxParameters`。`minimaxParameters` 为最终提交的五项标量，包含解析后的提示词及递增／映射后的种子；这些是请求证据，不是实际模型输出时长或质量证据。
- 加入项目时分组回填对应源片段，全部视频仍保留独立结果节点。分次接受通过该任务的 `runs[].minimaxAttachments` 记录结果状态与依赖指纹，在恢复接受时只添加缺失项；手动改输入／历史主视频后不自动覆盖。片段 `resultVariants:[{assetId,loopId,roundIndex,parameters}]` 保存每轮请求参数；该素材必须存在于片段的结果列表，同一素材不能重复。最新完成轮次成为默认视频，不改变原生成参数，仅按需要缩短当前裁切范围。
- 每段历史100份、抽屉1000项的限制继续存在。自动关联无法容纳整组新增项时保留原历史，全部输出仍作为独立结果接收；不会以截断旧记录的方式让校验通过。用户明确采用某轮参数才编辑片段，仍可撤销／重做。

含H3语义循环参数或逐轮结果记录的完整工程及选中工作流自动选用v26；v1–v25保留原含义，低版本不能携带新信息。备份恢复映射素材，选区插入／复制同时映射内部循环、目标节点与历史关联；恢复不携带密钥或执行授权，不生成或发送素材。未编辑原生文件导出及已迁移H3拒绝原生导出的规则继续生效。

源项目普通循环的起始计数、图片批次、并行／100轮，智能画布分支回合、整组输出与每次自动随机种子策略仍未等价实现。0.93只接入镜场现有串行循环；详细证据见[0.93验收记录](VALIDATION-0.93-2026-10-01.md)。

## 原生数据流后端增量（2026-10-02，未发布）

`GET /api/projects/:id/native-flow` 提供只读解析，可选 `nodeId`，或 `jobId` 加可选配对的 `loopId/roundIndex`。任务结果按原任务快照解析，默认排除循环回合，不能跨项目；只接收完成步骤，查询不创建任务或改写数据。`executionEnabled:false` 仅表示该预览不执行。正式4768仍为0.92.0，未加载此新接口；现有界面未改。

普通ComfyUI的 `workflowBinding.imageSources[]` 可用 `sourceIndex:0–999` 明确选择源节点的一份素材；只用于 `sourceNodeId` 映射。原生组和输出中没有明确序号的多份素材不能静默取第一项。分组文字、全量生成映射和普通原生输出收集已接入本机执行器；继续原请求，分次接收不重复追加，修改上游/接收器后不自动覆盖接收器。其它平台的整组组合、原生拆分/循环执行仍在首次提交前拒绝。

含素材序号或原生细项排序的新工程使用v27；旧版本不能携带这些字段。原生导入的中间工作流包也按是否包含细项排序选择v27或原v23，旧文件不改含义。

新增详细语义、未完成范围和验证证据见[原生数据流增量记录](NATIVE-FLOW-PROGRESS-2026-10-02.md)。

## 0.95 所有独立素材库的备份与恢复

这是镜场自有`.jingchang-library`格式，版本1，独立于`.jingchang`工程版本。文件由`JINGCHANG_LIBRARY_1\n`、4字节大端清单长度、UTF-8 JSON清单及按序原始文件组成；配置≤12MiB，媒体和画布文件内容合计≤4GiB。库目录沿用现有数量限制，拒绝路径、符号链接、凭据、原型字段和失效依赖；逐文件及整包SHA-256检查。内嵌工程／子图保留原文件字节，只恢复为库内快照。

| 方法与路径 | 输入与结果 |
|---|---|
| `GET /api/asset-library-backups?projectId=...` | 读取本项目原备份／恢复记录；公开结果不含内部计划和本机安装路径 |
| `POST /api/asset-library-backups` | JSON `{requestId,projectId,revision}`，`revision`为最新素材库目录修订号；202返回本机备份任务 |
| `GET /api/asset-library-backups/:id?projectId=...` | 读取已经保存的任务状态、真实完成步骤、恢复入口和下载结果 |
| `GET/HEAD /api/asset-library-backups/:id/download` | 仅已完整完成且整包校验一致的备份可下载 |
| `POST /api/asset-library-backups/imports?requestId=...&projectId=...` | 二进制请求体，先限制清单并验证，再流式接收原件；201返回已检查预览，不恢复目录 |
| `GET /api/asset-library-backups/imports?projectId=...` | 读取接收记录与库名称、空／回收组、媒体／模板／快照数量 |
| `GET /api/asset-library-backups/imports/:id?projectId=...` | 接收回复丢失后读取原编号；不自动上传 |
| `POST /api/asset-library-backups/imports/:id/restore` | JSON `{requestId,projectId,revision}`，明确恢复为新增库；202返回恢复任务 |
| `POST /api/asset-library-backups/:id/resume` | JSON `{projectId,revision}`，继续原计划；原备份目录已变则需创建新备份；恢复再次核对目录修订 |
| `POST /api/asset-library-backups/:id/cancel` | JSON `{projectId}`，停止本机处理，已收到／完成文件保留；停止动作异步，以之后读取状态为准 |

任务类别为`library-backup`／`library-restore`，同时进入现有任务中心。请求编号与操作范围绑定；响应丢失后读取原记录，不重建第二份。恢复先持久化新编号映射，再安装完整文件，最后一次发布新目录；发布回执避免重启或响应丢失后重复新增库。既有文件被修改时拒绝覆盖，已完成恢复保持原库名称后续编辑。服务重启将未完成任务标为中断，只有明确继续才处理，不启动模型或上传。

索引／接收／导出在`data/library-backups/`，任务记录同时在`data/jobs/`。平台配置、凭据、生成任务、共享目录授权、未入库工程不迁移；旧工程备份语义不改变。详见[0.95验收](VALIDATION-0.95-2026-10-03.md)。

## 0.96 H3自动参考、随机请求与v33

现有H3时间轴每段新增可选`seedMode: "random"`；缺省／`fixed`沿用保存的`seed`，固定方式规范化时省略该字段。没有增加接受任意抽数器的HTTP参数。新Comfy原生迁移默认随机，RunningHub来源默认固定；旧编辑时间轴和旧任务保留。

原生H3步骤的`nativeDirectorInputs.version=2`表示自动选择，`automatic.policy`为`ordinary`或`smart`，`details`为实际发送清单；`automatic.candidates`保留已确认的全部候选，`duplicates/excluded`为去重／未选入数量。普通前15再检查类型，智能每类9／3／3。手动及旧记录的version1严格规则保持；未选入候选不等于额外上传授权，上游数量变化必须同时满足候选和发送清单检查。

新画布请求在步骤保存`minimaxSeed: {version:1,mode:"random",segmentId,seed}`后再接纳子任务；直接生成任务同样保存真实种子。范围0–4294967294。同`requestId`不重新抽取，恢复先找到原子任务或保存的种子；原编号查询不重编译／重传／重交。随机与递增同时开启拒绝。逐轮明确映射`seed`将执行副本变为固定，原编辑片段不改。

完成的H3输出携带`minimaxParameters:{prompt,duration,aspectRatio,megapixels,seed}`，取实际提交图，不猜测旧任务参数。片段`resultVariants`可保存`{assetId,parameters}`单次记录；逐轮记录同时具有`loopId`和`roundIndex`，只给其中一个会拒绝。显式采用参数后当前段为固定种子，可撤销。

包含随机方式或单次参数的完整工程／子图使用v33，旧v1–v32不接纳新字段；未含新字段的旧格式仍兼容。整库内的画布快照也保持v33，恢复不执行模型或携带凭据／执行授权。详见[0.96验证](VALIDATION-0.96-2026-10-03.md)。

## 0.97 通用数字随机与备份版本

`POST /api/workflows`、`PUT /api/workflows/{id}/config` 的字段可设置 `randomEnabled:true`，仅允许可见的 `control:"number"` 数字输入，沿用 `min/max/step`。滑杆／下拉不能开启。固定默认值继续按原范围、步长检查；随机浮点按固定版小数位策略生成，不吸附步长。

`POST /api/projects/{id}/generate` 可给 `randomFields:[{nodeId,name}]`：缺省启用模板的全部合格字段，空数组全部固定，显式数组只启用所列字段。重复、未知、隐藏或未开启能力的字段拒绝。原 `overrides` 的类型检查保持，已开启字段的手填数值不参与随机提交。`workflowBinding.randomFields` 保存画布节点选择。递增种子忽略启用随机的 seed／noise_seed，其他固定种子保持原行为；H3／LTX／增强专用参数不与通用随机混用。

RunningHub 普通数字字段支持 `randomEnabled`、可选 `randomActive`（缺省启用）及 `min/max/step`，要求 `type:"number",source:"value"`。云单次运行的 `randomFields` 和节点 `cloudBinding.randomFields` 使用相同 `{nodeId,name}` 标识，`name` 对应云字段的 `fieldName`。标准模型不参与。原服务、预算、素材／整图发送授权保持。

只读计划有 `randomFields`／`randomDescriptors`；不选择数值、不提交。实际任务在首次接受时保存 `workflowRandom:{version:1,policy:"infinite-canvas-number-v1",count,fields,batches}`，每批次记录 `values:[{nodeId,name,value}]`。父画布步骤和实际子任务共用同一收据。重复请求编号与恢复只用原记录；客户端不能通过HTTP请求注入内部父任务记录。`GET /api/jobs/{id}` 可读取／下载原值及实际任务状态；无效或缺失记录不能自动重选或静默回退。

新数字随机配置使用工程／子图v34与整库v2，模板／节点选择及云默认开关随备份恢复。整库中的画布格式标签必须匹配实际包内容。没有新字段时仍采用旧格式；v1–v33工程、v1整库继续兼容。任务历史不是工程包的导出内容；旧平台任务查询仍依赖原工作区任务文件。详见[功能边界](WORKFLOW-RANDOM-PROGRESS-2026-10-03.md)与[本机验收](VALIDATION-0.97-2026-10-03.md)。


## 0.98 原生字段配置和节点固定覆盖

`POST /api/workflows/fields/preview` 接受 `{workflowId,nativeConfig}` 或 `{workflow,nativeConfig}`，返回 `{fields,inspection,persisted:false}`；仅在本机检查，不保存或提交。`POST /api/workflows` 可配对 `workflow` 和 `nativeConfig`；`PUT /api/workflows/{id}/config` 接受 `{revision,nativeConfig}`，新增修订并保留原记录。`nativeConfig` 与镜场 `fields` 不可同时提供。配置最多200KB，图最多2MB/500节点；非法目标、重复编号、类型/选项冲突、凭据和不支持键拒绝。

原生字段转为 `nativeFieldId` 与 `{nodeId,name,control,defaultValue,...}`。NULL的原生 `min/max/step` 保留，固定检查不将它当有效边界；随机沿用固定源代码的数值转换策略。仅原 `type:number,random_enabled:true` 的数字输入获得随机能力；滑杆和下拉保持固定。后续字段表单编辑和备份保留原编号。

`POST /api/cloud-workflows/fields/preview` 接受 `{nativeConfig}`，支持 `fields`、`nodeInfoList` 或字段数组，返回 `{fields,persisted:false}`，不查询账户、拉取平台或生成。普通云配置保存可用 `nativeConfig` 代替 `fields`；标准模型和H3仍使用专用结构。LIST选项可从 `fieldData` 的 index 列表读取。

节点 `cloudBinding.overrides:[{nodeId,fieldName,fieldValue}]` 只覆盖对应普通值字段。单个字段不能同时固定覆盖和 `inputs` 上游映射；重复、缺失、媒体/LoRA、错误类型和选项失配拒绝。配置副本用于预览、执行和任务快照，原云配置不改。缺省/空覆盖沿用原值；随机选择优先使用本次持久收据，恢复保留提交时副本。

原生迁移匹配 `comfyParams/comfyRandomActive` 的 field.id 和 `rhParams/rhRandomActive` 的双冒号键。显式选模板或配置、绑定并确认迁移后才可运行；媒体标识不自动转换成素材。凭据、预算和发送范围仍须单独授权，保存/导入本身不授予执行。

新增字段采用工程/子图v35与整库v3；无新增数据时旧v1–v34工程、v1/v2整库兼容。伪降级标识或整库内版本标签与内容不符拒绝。详见[本轮范围](NATIVE-WORKFLOW-CONFIG-PROGRESS-2026-10-03.md)。


## 2026-10-07 · 多入口本机喵喵配置

`GET /api/miao-credentials/status` 仅检查专用配置元数据，不返回或读取密钥、不调用模型。默认手填行为保持。选择 `credentialSource:"miao-local"` 时必须同时带 `credentialConsent:true` 与空/缺省 apiKey，仅可用于固定喵喵 HTTPS 根/v1兼容对话或图片目的。配置登记与模型发现不代表生成权限或质量已验收。

- 普通画布/原生智能串联/恢复：`imageCredentials[]` 和 `llmCredentials[]` 内每项带 `nodeId`、上述来源及本次同意，继续使用每步骤原有模型、发送范围、预算和次数授权。凭据来源只在运行闭包传递，任务/画布不持久化本次同意。已提交子任务按原编号查询，恢复未提交节点须重新确认。
- 图片智能分类 `POST /api/assets/:id/classify`：顶层带上述来源字段；仍要求平台保存的视觉聊天能力、单张PNG/JPEG/WebP≤10MB、图片发送同意及正预算授权。先验证图片与幂等记录，再读取私有密钥；重复相同编号不会再调用。
- 独立 Agent：顶层来源对应路由对话；`agent.credentialSource`/`agent.credentialConsent` 对应图片服务（保留 `agent.imageApiKey` 手填）。两侧用途单独检查，保留 previewHash、路由最多两次、图片1–4次和双预算/参考范围，模型不能扩大请求范围。
- 浏览器每个Key输入对应独立来源控件；切换来源清空Key与本次同意，结束请求清理临时授权。

所有新路径仅用合成API与隔离数据验收，本轮未调用付费生成。端到端模型生成、账单、真实账号与设备仍需单独授权验收。

## 0.99.5 单图增强串联

沿用GET项目`native-cascade-plan`与POST画布执行/原任务恢复入口（具体路由见上文原生串联契约），不新增自动执行接口。增强发送节点必须绑定已保存的Comfy工作流，`workflowBinding.imageEnhance.kind=enhance`且count=1。预检steps携带imageEnhance策略、workflowId/revision，随机策略不含伪造seed；无动态提示词仍可以生成。只取有序引用中第一张图片，其余引用留在unusedRefs。

实际执行前校验输入媒体、字段与已确认模板版本；保存actualInput.enhancement的来源identity、强度、策略和实际seed，再启动原generation子任务。workflow策略不虚构单一seed。random映射的已注册控件须兼容完整0..4294967295整数；受限range/step在预检拒绝并建议fixed/workflow。同级copy共享原结果，恢复沿用原childId和上游编号；原子任务结束后才核对并补注素材来源，冲突保留文件、阻止下游，不自动重发。

模板变动或原来源/参数不一致会停止，不悄悄借用新配置。此能力由本机隔离Comfy协议验收；真实安装、权重和增强质量尚未验收。

## 当前并行候选补充（2026-10-07 16:45）

固定字面提示词列表与SeedVR2放大已增量接入智能串联候选，原列表不展开提及／循环token、实际请求计数、首图共享／原参数／原编号恢复保留。完整留痕.jhistory候选包含当前工程、历史修订、逐步任务／实际输入、输入收据、未回填素材以及本机MP4/SRT；恢复为新工程，历史只读不启动原任务。与本页较早阶段“列表／放大／历史尚未接线”的描述区分，较早描述仍作为当时记录保留。

最新代码／组件已做本机限定检查，最终版本和正式服务状态见[整合记录](UNIFIED-INTEGRATION-2026-10-07.md)。真实供应商质量、消费、实体GPU／手机与完整复杂混合串联没有由这些模拟协议证明，付费生成仍暂停。

## 2026-10-07 本轮上线与归档收尾

正式4750/canvas与4768已核对0.99.5，固定提示词列表、SeedVR2放大、全任务.jhistory与大成片本地导入完成本地接线及隔离检查。历史档案保留源任务，只读查看；恢复建新工程，不跨机启动旧上游任务。归档UI7/7通过，手机长JSON局部换行/滚动，不完整档案不放行恢复。完整回执见 artifacts/unified-integration-20261007-151410/DELIVERY.md。

16:52部署和17:02静态核查后，另一个活跃任务继续写入串联、归档与工程包等后端候选；它不属于root已验/已重载来源，需按较新候选另验，不能以健康版本号断言当前磁盘全上线。完整参考功能对齐、复杂循环/反馈/嵌套/专用混合及真实模型与设备验收仍未完成；付费生成暂停。


## 2026-10-16 · 图片分类专用收据接口（增量）

| 接口 | 请求与结果 | 是否调用上游 |
| --- | --- | --- |
| `GET /api/asset-classification-tasks` | 本机收据数组；可选 `assetId`、`projectId` 筛选，无效编号拒绝 | 否 |
| `GET /api/asset-classification-tasks/:id` | 读取原编号；不存在为 404，损坏记录拒绝继续发送 | 否 |
| `POST /api/asset-classification-tasks/:id/cancel` | JSON `{}`；`queued` 转 `cancelled`，`sending` 转 `uncertain`，终态不复活 | 否，仅停止本机等待 |

既有 `POST /api/assets/:assetId/classify` 增加持久化 `requestId` 绑定和 `classificationTask` 收据返回，错误响应可携带原收据。同编号绑定图片实际字节 SHA-256、项目、平台/地址/协议、模型、提示词摘要及原授权；绑定变化拒绝，完成后只复用本机结果，不再发送；失败、取消、未知结果不自动重试。不存在分类 `resume` 接口。原有单图最多一次、模型能力、预算/币种/同意、手填或本机凭据准入检查仍执行。预算记录不保证供应商实际扣费上限。

收据独立放在 `data/asset-classification-tasks/`，不保留密钥、图片 data URL、完整请求正文或上游原始异常；不进入通用 `jobs`，目前不纳入 `.jingchang` 工程包或 `.jhistory`，跨机迁移是明确未完成项。不要以通用任务数或工程包下载成功推定这些收据已迁移。

本轮 15 项相关测试（恢复专项 12 + Miao 3）、11 项浏览器检查与正式专用接口只读验证通过；浏览器 4 次请求全部为本机模拟 POST。4768 与 4750 `/canvas-module` 已空闲重载，514 个基线原文件指纹保持，仅运行文件 `server.pid` 更新。未进行云分类、计费、第三方素材上传或实体手机/GPU验收。接口语义、证据及当前缺口见[2026-10-16 专项记录](ASSET-CLASSIFICATION-RECOVERY-2026-10-16.md)。

## 2026-10-16 同日后续：分类原记录纳入 .jhistory

现有归档导出、检查、导入、读取与列表响应新增 `classifications`（数量）。`manifest.auxiliaryReceipts`新增 `source: "asset-classification-tasks"`，其 `record`为可迁移的单次分类原收据，含服务/模型、媒体指纹、授权摘要、原状态及完整分类结果，不含进程身份、凭据描述或可执行恢复绑定。活跃分类阻止导出；图片与原指纹不符时档案不完整，禁止恢复。导入不创建 `/api/asset-classification-tasks` 或通用jobs，也没有分类 resume 路由。旧档案兼容0条；只读数量必须对应清单。[字段与实际验收](CLASSIFICATION-HISTORY-2026-10-16.md)。


## 2026-10-16 同日后续：共享文件夹本批可选分类

已增量接入“共享文件夹已完成副本 → 勾选本批图片 → 单独确认服务/模型/总次数/总预算 → 串行逐图原收据 → 本机结果回填”。导入本身不触发模型；明确失败停后续并可重新确认只继续未发送项，未知结果不得继续本批，重启只查询不重发。批次清单与原共享导入记录纳入`.jhistory`只读迁移，恢复不复制活动批次、访问许可或凭据。工程-only备份原语义保留。此前阶段将本批分类列作未完成的记录作为历史保留，最新实现和验收以[本轮详细记录](SHARED-CLASSIFICATION-BATCHES-2026-10-16.md)为准。CLI真实执行/查询回填、APIMart可信素材及真实云/设备验收仍未完成，付费生成继续暂停。


## 2026-10-16 · APIMart虚拟素材接口

- `GET /api/apimart-materials?projectId=...`与`GET /api/apimart-materials/:id?projectId=...`：仅本机原记录。
- `POST /api/apimart-materials/preview`：projectId、endpoint、cloudProject、name、assetType（Image/Video/Audio）、groupName或groupId、sourceUrl；可选localAssetId/publicMediaId，返回fingerprint与本机计划，不发送上游。
- `POST /api/apimart-materials`：上述原范围、固定requestId、fingerprint、consent:true、仅本次apiKey及authorization，返回202。authorization为{origin,action:'register',requestLimit:1,sendPublicUrl:true,sendOriginalMedia:true,budget,currency:'CNY'或'USD',consent:true}；远程注册需要正预算和Key。同编号同范围读原结果，变更范围409。
- `POST /api/apimart-materials/:id/query`：projectId、固定本次requestId、apiKey、consent:true、authorization:{origin,action:'query',upstreamId,requestLimit:1,budget,currency,consent:true}；只GET原保存任务。相同查询ID重放不增加GET，改范围409；每次新查询重新确认。
- `POST /api/apimart-materials/:id/cancel`：projectId；先保存本机停止标记，不保证撤回平台任务。

预览不验证远程文件字节与本机文件相同。Key不持久化；原注册与查询范围/结果在独立账本，历史恢复只读。APIMart视频config.apimartReferenceMode='multimodal'时分别发送image_urls/video_urls/audio_urls，AV需要sendOriginalMedia显式授权；旧首尾帧模式保留。详见[本轮说明](APIMART-MATERIALS-2026-10-16.md)。


## 2026-10-17 · 即梦CLI任务

- `GET /api/jimeng-tasks?projectId=...`、`GET /api/jimeng-tasks/:id?projectId=...`：本机原记录，不执行CLI。
- `POST /api/jimeng-tasks/preview`：{projectId,request}；request含command、prompt、model、resolution、ratio、duration、generateNum、references:[{assetId,role}]，只允许固定八类命令。返回规范计划、程序/素材指纹及fingerprint；不启动CLI。
- `POST /api/jimeng-tasks`：原projectId/request、固定requestId、fingerprint、consent:true、authorization:{service:'local-dreamina-login',action:'generate',command,model,requestLimit:1,useLocalLogin:true,sendPrompt,sendOriginalMedia,budget,currency,consent:true}。发送标记先落盘；同编号不重新生成，改范围409。生成budget须正数，currency为CNY/USD/credits；两个发送布尔值必须与预览中的实际文字/原文件范围一致。
- `POST /api/jimeng-tasks/:id/query`：{projectId,requestId,consent:true,authorization}；授权同上但action:'query'、sendPrompt:false、sendOriginalMedia:false、增加原upstreamId，查询budget可为0。每个固定查询ID至多执行一次query_result，不自动轮询。
- `POST /api/jimeng-tasks/:id/cancel`：{projectId}；只停止本机等待。
- `POST /api/jimeng-tasks/:id/repair`：{projectId}；仅本机恢复已留存输出的导入，不执行CLI。
- `POST /api/jimeng-tasks/:id/apply`：{projectId,revision}；检查原结果指纹和工程版本后回填，重复回填不重复建节点。

新能力`jimengCliTasks:true`不等于已安装/登录。参数与界限详见[本轮使用及验收记录](JIMENG-CLI-2026-10-17.md)。.jhistory以jimeng-cli-tasks附属收据迁移，仅只读，不恢复CLI运行权限。


## 2026-10-17 · 官方CLI发现与版本能力

`GET /api/jimeng/status`仍只检查文件，不运行程序。发现并校验项目安装时，增加projectManaged:{version,sha256,scope:"project"}与capabilities:{profile,image5ProResolutions,generationDownloadDirectory,multiframeMinimumTotalSeconds}；不将其当作登录/模型权限。版本/帮助POST的项目内即梦响应增加offline:true，JSON版本实际解析为version:"1.4.20"。生成预览按已核实能力拒绝旧Pro1k，原记录不改；1.5k需已核实的程序能力。生成参数不包含download_dir，下载仅在独立确认的query_result调用中。旧接口、固定请求编号与只读留痕语义保留。详见[最新记录](CLI-OFFICIAL-COMPATIBILITY-2026-10-17.md)。


## 2026-10-18 · 即梦画布节点上下文与回填

`GET /api/jimeng-tasks/context?projectId=<id>&nodeId=<id>`：只读取已保存的图片/视频节点、原生输入顺序与文字，返回建议request、title和target；不运行工具。`POST /api/jimeng-tasks/preview`与生成POST可选带`canvasTarget`，须原样带回预览指纹对应的`{version:1,nodeId,nodeType,signature}`。确认和执行前重新检查，目标类型必须匹配命令；旧不绑定请求不变。

`POST /api/jimeng-tasks/:id/apply`增量支持`placement:"target"`或`"new"`（兼容缺省new），仍带projectId/revision。target仅用于原任务已绑定节点，项目互斥保存时核对目标/依赖签名和素材；内容变化返回409，显式new可保留两份。已存在的确定性结果节点令重复apply不再写回源节点。绑定记录随原.jhistory只读迁移，不是自动调度或恢复执行许可。[入口、验证及限制](JIMENG-CANVAS-2026-10-18.md)。


## 2026-10-18 · 即梦原编号限额查询

预览与生成可选`resultQueries:{requestLimit:1..30,budget:0..1000000,currency:"credits"|"CNY"|"USD",intervalSeconds:5..300}`，计入plan指纹；生成authorization须另有`resultQueriesConsent:true`。默认省略，旧指纹不变。正常取得原编号后仅按已确认范围查询；异常/停止/重启不自动继续。

`POST /api/jimeng-tasks/:id/continue-result-queries`严格接收`{projectId,requestId,scopeFingerprint,consent:true}`，指纹来自同一原任务GET，绑定原生成计划和原编号，不接受新预算或次数。会话运行时不接受额外手动查询。GET返回可选resultQueries状态及会话，不暴露PID；.jhistory仅只读恢复。[详情与验证边界](JIMENG-RESULT-QUERIES-2026-10-18.md)。


## 2026-10-18 · 创作台jimeng协议与父画布子任务

新增GET `/api/studios/:id/jimeng-preview`，本机只读范围预览；既有创作台生成/继续接口增量支持protocol=jimeng、本机登录确认、不可变生成范围及限额查询授权。画布主执行与原生智能串联复用同一子任务协议；GET任务可补回缺失的原子任务关联但不保存父记录、不启动程序，明确继续后才持久化。回填前检查原输出SHA-256。`jimengStudioProtocol:true`只是实现能力，不是账号/生成验收。[使用、接口与边界](JIMENG-STUDIO-2026-10-18.md)。


## 2026-10-19 · 即梦账号操作与短时网页登录

新增本机账号状态/固定范围预览、明确确认的登录准备/原授权单次检查/积分/退出、原请求读取与本机停止、短时授权材料丢弃。GET不执行CLI，原编号重放不重复执行，重启不恢复授权。账号材料与积分不写工程/账号收据；官方CLI自己管理认证文件。生成/限额查询与账号切换采用同一服务进程内的共享/独占许可，积分可并行读取。 付费继续暂停。[功能、使用和边界](JIMENG-ACCOUNT-2026-10-19.md)。


## 0.99.10 图片提示词与逐图反推（2026-10-19）

新增`GET/PATCH /api/assets/:id/caption`、`GET /api/assets/:id/caption-history`和`GET /api/assets/:id/caption.txt`。PATCH仅接受`{revision,text}`；文字最多100000个Unicode字符，版本不符409，原图不改。TXT为已保存的UTF8文字，不生成新的服务端文件。

`POST /api/asset-caption-batches/preview`接收projectId、assetIds（1–100张PNG/JPEG/WebP，每张<=10MB）、platformId、model、prompt（可选，最多4000字）、maxTokens（128–8192）。只做本机检查，返回plan、fingerprint、requestLimit。`POST /api/asset-caption-batches`再加固定requestId、fingerprint、consent:true、瞬时apiKey或已有Miao凭据选择及精确authorization：origin、model、sendImages:true、requestLimit、budget、currency、consent:true、keySource、localConfigurationConsent。预算远程须>0。只有已保存且支持图片输入的OpenAI兼容/Gemini对话模型可选。

`GET /api/asset-caption-batches?projectId=...`、`GET /api/asset-caption-batches/:id?projectId=...`为原记录。`POST /:id/stop`提交projectId；`POST /:id/resume`另需新固定requestId、原fingerprint、原authorization、新瞬时凭据与再次确认，只继续未发送项；`POST /:id/apply`提交projectId与可选assetIds，只取回完整结果，返回applied/conflicts。同编号开始/继续重放不重发。发送结果不明时不自动继续、重试或重新发送。

当前caption随工程v39、整库v6和独立收藏副本迁移；`.jhistory`记录类型asset-caption-batches经过专用验证后只读恢复，不安装活动任务。参见[完整用法与边界](ASSET-CAPTIONS-2026-10-19.md)。


## 0.99.11 多提示词库（2026-10-19）

`GET /api/prompt-catalog`返回当前目录revision、libraries[].categories与含location的items。`POST /api/prompt-catalog/libraries/create|rename|archive|activate`、`categories/create|rename|archive`、`items/move|archive`均要求当前目录revision；新库/组创建含固定requestId。`POST /api/prompt-catalog/items`还含libraryId/categoryId和title/text/negative/scene，固定原创建ID重放不重复建模板。旧`/api/prompts`及版本/恢复/改写入口保留，新文字字段与历史一起保存。

`GET /api/prompt-catalog/export`导出全部提示词库，`?libraryId=`可按库导出。`POST /api/prompt-catalog/imports`接收requestId、manifest（最多32MiB），只检查备份；GET列表/原id只读核对；`POST /api/prompt-catalog/imports/:id/restore`使用原fingerprint和最新目录revision，按固定新ID映射恢复，目录提交前不显示部分副本，不覆盖原条目。细节和限制见[PROMPT-CATALOG-2026-10-19.md](PROMPT-CATALOG-2026-10-19.md)。


## 0.99.12 原版提示词文件互通（2026-10-19）

提示词编辑、版本与自身v2备份保留recommendations对象和nativeSource只读来源资料。POST /api/prompt-catalog/imports可传{requestId,sourceText}接收原版JSON；GET /api/prompt-catalog/imports/:id/original提供原文下载与X-Content-SHA256；GET /api/prompt-catalog/native-export/preview返回只读report/fingerprint；GET /api/prompt-catalog/native-export?fingerprint=...可选libraryId下载当前可用内容副本，指纹变化409。原文及原版副本为application/octet-stream，整合转发不重写其字节。容量、版本、拒绝规则及导出差异见[PROMPT-NATIVE-2026-10-19.md](PROMPT-NATIVE-2026-10-19.md)。


## 0.99.13 Codex文字/看图（2026-10-19）

GET /api/codex-chats/program只核对本机程序；POST /api/codex-chats/preview检查项目、原节点、图片、旧上下文、服务及程序指纹。POST /api/codex-chats使用固定requestId/fingerprint、瞬时Key、consent及一次请求预算授权。GET列表/原id要求projectId；POST /:id/stop停止本机等待；POST /:id/apply按revision和bound/new方式保护取回。通用jobs可读摘要，resume拒绝重发。完整收据和原图纳入.jhistory只读恢复，不安装活动CLI任务或认证。参数与边界见[CODEX-CHAT-2026-10-19.md](CODEX-CHAT-2026-10-19.md)。


## 0.99.14 · 画布Codex语言节点

沿用canvas-run-plan/canvas-run/jobs/resume/apply-generation，无独立付费捷径。llmBinding.executor可为api或codex，缺省api；codex须OpenAI兼容Responses服务、图片参考，回答方式固定完整返回。计划新增codexProgram公开程序证明；llmCredentials.authorization须对应programSha256/programEntrySha256/programVersion。原模型/服务/预算/发送范围授权继续必填。服务内部建立带parentId的Codex不可变记录，canvas-llm记录codexTaskId；HTTP不接受内部项目/平台快照参数。GET读取原记录，resume不重交已提交语言调用。完整留痕同时核对语言子任务和CLI收据的程序、输入、服务、预算、次数、图片及回答。[细节](CODEX-CANVAS-2026-10-19.md)。


## 0.99.15 · Codex普通对话

新增POST conversations/:id/codex-preview与recover-codex；原messages接收executor:codex、codexFingerprint及程序指纹授权，原API缺省保持。原上下文固定为20条完整消息（含当前），图片字节核对、角色与文本/图片位置保持；不发送原视频/音频或原文档。父conversation任务链接不可变codex-chat收据，get/cancel/apply仍沿用；读取恢复不请求模型、通用resume不重发。[字段与边界](CODEX-CONVERSATION-2026-10-20.md)。


## 0.99.16 · 本机素材库批量裁剪（2026-10-20）

新增 `/api/library-crops/preview`、POST/GET `/api/library-crops`、GET `/:id`、POST `/:id/cancel|resume|apply`；GET只读，修改须本机原范围校验。`libraryCrops:true`。 [使用、接口、边界及来源](LIBRARY-CROPS-2026-10-20.md)。


## Gemini CLI 文字与看图（2026-10-21 候选）

- `GET /api/gemini-cli-chats/program`：本机已核对程序证明；不检查登录或调用模型。
- `POST /api/gemini-cli-chats/preview`：工程、模型、历史、图片、目标节点与程序指纹快照。
- `POST /api/gemini-cli-chats`：显式授权一次请求，指定 `requestId` / `fingerprint`，API Key 仅本次内存使用。同编号读取原记录，计划不符返回 409。
- `GET /api/gemini-cli-chats?projectId=...` / `GET /api/gemini-cli-chats/:id?projectId=...`：原任务和回答。
- `POST /api/gemini-cli-chats/:id/stop`：停止本机等待，不重复发送。
- `POST /api/gemini-cli-chats/:id/apply`：`projectId, revision, placement(bound|new)`；保护新编辑、重复取回幂等。
- 通用任务 `gemini-cli-chat`：读取、取消；通用 resume 拒绝重发。档案包含 `gemini-cli-tasks` 原记录，导入只读。

只使用已保存的 Gemini 原生普通对话服务；不复用网页订阅、账号或 Flow 权益。完整范围及未完成项见 [使用与技术记录](GEMINI-CLI-2026-10-21.md)。

2026-10-21 发布验收：独立任务已发布本机 0.99.17，新增12项、相关79项回归和7组网页流程通过；真实云端/账号/订阅以及本节列出的其它缺口仍未验收。


### 2026-10-21 Gemini普通会话增量（0.99.18已发布）

原文字对话增加 `gemini-cli` 执行方式。`POST /api/conversations/:id/gemini-cli-preview` 核对会话/程序/图片快照；原messages接口携带 `executor: gemini-cli, geminiCliFingerprint` 与本次程序、服务、预算和发送范围授权。`POST /api/conversations/:id/recover-gemini-cli` 明确 `scope: gemini-cli-original-records` 只读原任务修复对话，不请求模型。旧API/Codex、图片、Agent和原音视频能力保留；此CLI暂不发送原音频/原视频。

会话上下文顺序、父子任务、稳定回答编号、停止/强制中断后的原收据读取、保护取回和只读归档已增量连接；正式状态及验证见 [会话使用与技术记录](GEMINI-CONVERSATIONS-2026-10-21.md)。独立CLI生图、Antigravity、画布语言节点联动及真实Jio/Pro/Flow权益仍不能标记完成。

0.99.18发布验收：本轮132项检查、7组Gemini及6组Codex网页通过，正式只读34个GET；513份业务文件保持。空模型配置的流式控件已修正。云端/个人账号/订阅/CLI生图及画布语言节点联动仍未完成。


### 2026-10-21 Gemini画布语言节点（0.99.19已发布）

原`llmBinding.executor`增加`gemini-cli`，仅Gemini原生普通对话服务和文字/PNG/JPEG/WebP；保留原API与Codex。canvas-run-plan包含`geminiCliProgram`证明，逐节点授权需确认原程序指纹。原canvas-run及resume/apply流程连接Gemini不可变子任务与已存平台快照，通用CLI wrapper resume拒绝重发；完整任务留痕严格校验父子关系和原图片，新工程只读导入。

本轮联动不等于CLI生图/原音视频、Antigravity或Google/Jio/Pro/Flow已打通。详细使用、验证与限制见 [画布增量记录](GEMINI-CANVAS-2026-10-21.md)。

0.99.19发布验收：新增8项、相关82项、Gemini4组及Codex4组网页通过；原平台快照、停止/恢复、完整留痕与长输入续聊已验证。正式141个GET、513份业务文件保持。真实云端/个人订阅/CLI生图、原音视频和Antigravity仍未完成。


## 2026-10-21 · 0.99.20选区整理

`GET /api/health`增加`capabilities.canvasArrangeSelection`。几何计算在本机前端执行，复用原`PUT /api/projects/:id`校验/版本保存，无新生成接口或任务。未变更项目数据格式。单选找连通簇、多选保持选区、组整体移动和一次撤销见[说明](CANVAS-ARRANGE-2026-10-21.md)。


## 2026-10-22 · 输入组创建与交接

`GET /api/health`新增`capabilities.nativeInputGroups`，指本轮创建/交接入口，不代表全部组生命周期完成。复用`PUT /api/projects/:id`版本保护和既有`GET /api/projects/:id/native-flow`、`canvas-run-plan`。无新生成接口、任务表或数据格式；检查不保存，确认仅保存工程，不自动发送。详见[本轮说明](INPUT-GROUPS-2026-10-22.md)。


## 2026-10-23 · 输入组成员与拖入归属（0.99.22）

补齐0.99.21仍缺少的普通group/promptGroup成员编辑、同类型跨组与两类共享、中心点拖入/移出。预览不写入，确认含计划散列和工程版本锁；同一修改并发只保存一次，回应丢失后只读原回执、不自动重发。完整拖动画布草稿兼容Alt副本和待保存文字，整组移动按固定源跳过重归属。明确素材字段、H3全局/片段与LTX选择保留原生产节点及序号；独立视觉组不改写，旧显示框保留样式。补齐完整档案中组尺寸及新成员收据字段。

专项27项、相关125项，共152项独立检查；12组新网页及创建9/整理8/原生13组回归通过。含80组固定源归属对照、真实HTTP与Node重启、标准工程/只读任务档案跨工作区、环回Comfy收到原Y图字节并返回PNG。手机/低动态/无滤镜仅浏览器模拟。0付费/第三方上传/个人CLI登录读取；Flow交接、云模型/GPU/账户与所有参考能力仍未完成或未核实。详见[使用、接口和证据](INPUT-GROUP-MEMBERS-2026-10-23.md)。


## 2026-10-23 · 智能组自身素材候选（未发布）

发现固定源smart-group.images未进入镜场普通数据流/参考候选，已独立补自身优先、24单位阅读顺序、类型与数量检查、静态/待生成区分及原生档案已知字段。候选14项＋170相关，共184项检查、7组隔离网页及6张候选图通过；本机协议实际收到正确原PNG，ZIP/标准包/只读档案恢复通过。

发布前复核发现旧sourceIndex会因补回自身素材而换图，兼容迁移尚未完成，因此正式仍0.99.22，不重载、不改个人工程。磁盘0.99.23-dev.1正常启动默认关闭新顺序，只有隔离验收进程显式启用；页面按实际能力位匹配新旧解释。智能分组完整创建/收纳/合并/解组、旧字段与旧页面兼容仍进行中，不把局部修复或测试通过计为整项完成。[问题、候选证据与下一步](SMART-GROUP-MEDIA-CANDIDATE-2026-10-23.md)。

## 2026-10-24 · 素材版本兼容候选（未发布）

仅隔离候选capabilities.nativeMediaVersions=true开放POST `/api/projects/:id/native-media-version/preview`与`/apply`。请求为`{mode:'project',requestId,revision}`或`{mode:'node',nodeId,selection:'preserve'|'adopt',requestId,revision}`。预览返回canApply/effects/planHash；apply还需准确planHash。409表示范围、修订或编号冲突；收到不确定响应只GET当前工程核对nativeMediaEditReceipt，不自动重发。项目/节点nativeMediaVersion为1或2，缺失恒为1；保存到40版工程、7版整库及只读档案。工程升级锁定所有旧节点，单节点范围转换受已验证路径限制。正式仍0.99.22，不将这些候选接口列为正式交付。详见[本轮实现与限制](SMART-MEDIA-VERSION-CANDIDATE-2026-10-24.md)。

### 2026-10-24 · 逐轮素材候选进展（未发布）

素材版本preview的effects新增rounds和automatic，逐轮给出loopId/roundIndex/真实计数、分支跳过及H3候选/发送范围/排除数；fields内待生成项携带原producerIndex。apply仍只接受准确摘要和修订，不增加自动生成入口。内部nativeReferences的待生成范围可携带producerIndices；实际执行按原生产者槽位校验。只读档案可保存经结构校验的原生执行上下文，未知/凭据仍拒绝。不同回合需不同字段序号时暂不能保存，正式仍0.99.22。[本轮验证与限制](NATIVE-ROUND-MEDIA-CANDIDATE-2026-10-24.md)。

### 2026-10-24 · 逐轮独立选图候选（未发布，接续上节）

现可保存各轮不同字段序号，node模式selection增加`refresh`/`clear`。nativeMediaMap记录原身份及上游指纹，计划/执行按回合定位；原快照保持，实际步骤记录nativeMappedFields。相关来源变化须重新检查，重排后仍保留原身份，不能静默选择新第一格。标准工程41版/整库8版与闭合片段、只读档案保留规则；原生ZIP不能表达时明确拒绝。369项、4组网页/6图通过，正式仍0.99.22；本机协议夹具不代表真实平台或云模型通过。[结构、接口、证据与发布门槛](NATIVE-ROUND-MAP-CANDIDATE-2026-10-24.md)。


### 2026-10-25 · 页面素材规则会话（候选未发布）

GET health增加nativeMediaSession版本1；本机API使用x-jingchang-media-session声明启动规则。新旧模式不匹配返回409及NATIVE_MEDIA_SESSION_CHANGED，现代工程在未启用服务中返回NATIVE_MEDIA_RULES_UNAVAILABLE。请求独立上下文在工程读取/保存和快照续跑再次核对；任务GET、停止和保全下载有例外。新页面提交前检查、保存固定声明、保留草稿，不自动刷新或重发；独立模块及进度上传共用。794项及真实隔离V2代理通过，正式仍0.99.22。[使用、接口、证据与缺口](NATIVE-MEDIA-SESSION-CANDIDATE-2026-10-25.md)。

### 2026-10-25 · 智能组操作候选（未发布）

新增候选 `POST /api/projects/:id/smart-groups/preview|apply`，提供创建、加入/合并、解组、单格释放、移出成员、整理、移动和尺寸修改。按修订号/预览摘要/请求编号核对，下游原文件字段先检查再保留，保存丢响应后只读恢复。正常启动仍关闭；正式0.99.22保持。请求结构、使用方法与未完成手势见[候选说明](SMART-GROUP-LIFECYCLE-CANDIDATE-2026-10-25.md)。

### 2026-10-25 · 智能组手势原子保存候选（未发布）

新增候选 `POST /api/projects/:id/smart-groups/reconcile`，仅接受drag/resize，带起点草稿、主卡片和最终几何；服务核对原图字段后一次保存。丢响应只读取回执，前置自动保存冲突保留本地草稿及较新记录。默认正式关闭，详细结构、827项检查及未完成范围见[手势候选说明](SMART-GROUP-GESTURES-CANDIDATE-2026-10-25.md)。

### 2026-10-25 · 缩略图拖出候选

隔离能力smartGroupThumbnailDrag，自动reconcile新增mode:thumb-drag，groupId/index/assetId/x/y/revision/requestId及可选naturalSize、起点draft。一次修订、身份校验、丢响应GET回执，正式未发布。[接口和限制](SMART-GROUP-THUMB-DRAG-CANDIDATE-2026-10-25.md)。

### 2026-10-26 · 原生复制编号与逐轮证明候选

沿用工程PUT与智能组reconcile，无新增云调用端点。候选copySelectedNodes的nativeIdentity选项重映射原始编号/引用，只有有效且等价的原证明才能生成副本范围证明；正式能力关闭。只读档案补齐running/queued布尔快照标记。[使用、证据与边界](NATIVE-COPY-IDENTITY-CANDIDATE-2026-10-26.md)。

### 2026-10-26 · 本机跨项目粘贴候选

新增候选clipboard-pastes的POST准备/插入、GET清单/原记录及POST原记录resume；requestId/修订/规范化选区摘要限定本机恢复。继承原bundle41配置/资产准备、目标锁、插入标记与幂等恢复；不触发生成。输入上限12MiB，坏结构/假凭据/冲突拒绝。正式未发布。[接口与限制](NATIVE-PASTE-INSERTION-CANDIDATE-2026-10-26.md)。
