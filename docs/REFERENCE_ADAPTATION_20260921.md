# 参考视频改编使用说明（2026-09-21）

## 这次解决什么问题

OpenMontage 现在有一条“参考视频 → 独立新项目”的适配路径。它读取用户放入当前项目的本地参考视频，测量镜头边界、镜头时长和抽样关键帧，再把**新主题和新脚本**按参考片的镜头节奏分配到可编辑分镜中。参考片只提供节奏和画面证据，不会被当作新片素材，也不会自动复制原片的旁白、人物或字幕特效。

这不是“自动复刻爆款”的完成证明。当前实现能可靠记录可测量的剪辑结构；人物、钩子、叙事含义、版权状态和“为什么爆”仍需创作者结合关键帧和原片判断。

## 面向用户的操作流程

1. 打开工作台的参考入口：`/reference?project=项目编号`。当前只支持选择当前项目内已有的视频，或从本机导入视频；不承诺粘贴抖音、小红书、YouTube 等平台链接后自动下载。网络 URL 不会被后台偷偷下载，账号登录、限流和网页平台抓取也没有纳入本轮验收。
2. 提交参考分析并等待状态变为完成。当前限制是视频 0.5 秒至 10 分钟、文件不超过 512 MB、检测镜头最多 60 个；分析在本机执行，不上传视频。
3. 查看镜头表和关键帧。镜头数量、平均镜头时长、每分钟切镜数属于机器测量；画面内容、人物和钩子需要由创作者补充。可以填写每个镜头的画面说明和检索词，这些内容会标记为创作者填写，不会冒充自动视觉识别。
4. 填写新主题、新脚本、目标时长和画面方向，创建改编项目。新脚本按原文顺序进入新分镜；参考镜头的时长比例只用于规划，系统不会复制参考片台词。
5. 在新项目中继续选片、配音、字幕、BGM 和导出。若启用配音，最终应以逐镜实测语音时长调整镜头；若不配音，才按参考比例作为规划时长。原项目与参考分析记录会保留。

## 当前已经有的事实能力

- `SceneDetect` 在本机检测镜头边界；没有明显切镜时，会记录为一个连续镜头并给出提示。
- `FrameSampler` 按时间点抽取关键帧，产物保存在当前项目的 `analysis/reference_runs/<reference_id>/` 下。
- 分析结果保存来源路径、视频 SHA-256、媒体探测信息、镜头数量、抽样帧数量、平均镜头时长、每分钟切镜数和警告。
- 改编计划保存参考镜头与新分镜的对应关系、计划开始时间、计划时长、参考证据帧、新脚本文本和作者补充的画面说明。
- 新项目使用独立的 `reference-...` 项目编号，并记录来源项目编号；后续素材、配音、字幕和导出沿用现有素材工作流。
- 相同参考文件和抽帧参数会复用已有分析任务；刷新页面不会重复执行分析。

## 参考项目的借鉴分工

| 项目 | 本项目借鉴的部分 | 本项目没有声称复刻的部分 |
| --- | --- | --- |
| [OpenMontage](https://github.com/calesthio/OpenMontage) | 项目目录、分析工件、分镜、素材、检查点和本地工作台的组织方式 | 不把参考视频分析误报成完整自动导演；仍保留人工确认和证据链 |
| [Hypit](https://github.com/hypit-ai/hypit/tree/9c9918d0cedf2f06574ab0d517b1b6b0afb56a66) | 已固定上游提交并接入本地 Distribution/Runtime 验收；借鉴原片证据、目标方向和实际语音时间分离 | 参考改编页仍不是 Hypit 全部 Studio、Provider、模型服务和发布能力的一比一完成证明 |
| [MoneyPrinterTurbo](https://github.com/harry0703/MoneyPrinterTurbo) | 脚本、素材、配音、字幕、BGM、合成的阶段化生产顺序 | 不覆盖 OpenMontage 的项目状态、付费闸门、创作者确认或原生工作台 |
| [PySceneDetect](https://github.com/Breakthrough/PySceneDetect) | 作为镜头边界检测的参考/底层能力来源；当前工具也有 FFmpeg 回退路径 | 镜头检测不等于语义理解、版权判断或爆款预测 |

## 事实、待验收和明确边界

已确认的事实是：系统可以在本机测量镜头和抽帧，并据此建立一份使用新主题、新脚本的独立改编计划。已有旧的媒体参考审阅接口仍只负责抽帧、场景和节奏归档；新改编入口才会把结果接到独立分镜项目。

以下内容在本轮仍需实际验收后才能宣称完成：新参考页的完整点击流程；改编项目从计划到素材、配音、字幕、BGM、导出的全链路；导出后的“计划时长—实测语音时长—最终镜头时长”对照工件；不同画幅和多版本导出的视觉质量。验收前不要填写通过的测试数量或把待开发工件写成已生成。

当前不会自动完成这些事情：理解人物身份、开头钩子、情绪和文案；判断参考片是否有版权或获得改编许可；换脸或换主持人；自动生成同款特效；保证新片与参考片一样爆；把参考片自动变成目标素材；替用户编写没有提供的脚本。画面说明和检索词由创作者填写时，必须保持“作者补充”的标记。

## 第三方参考与许可提示

本轮已保留固定提交的 Hypit 上游源码、分发包和本地运行时验收证据；没有进行付费调用、第三方上传或对外发布。Hypit 的完整许可文本和固定提交版本记录在 [`artifacts/reference_research_20260921/`](../artifacts/reference_research_20260921/)。该许可是带附加条件的 Apache 2.0 修改版；不能写成 MIT、无限制商用，也不能替用户作法律保证。任何后续修改或再分发都必须在对应位置保留版权、名称/Logo、许可和修改记录，并在 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) 登记来源、版本和修改内容。

## 保留规则

参考片导入、分析和改编都会写入新的分析目录或新的 `reference-...` 项目。原项目、已有分镜、素材、旁白、成片和旧分析记录保留；本说明不授权删除、覆盖或迁移旧生产资料。

## Hypit 完整一比一接入实施清单（计划，当前未完成）

用户已将目标提高为完整一比一接入 Hypit。下面是对固定提交 `9c9918d0cedf2f06574ab0d517b1b6b0afb56a66` 的只读审计结果和后续实施边界。它描述需要完成的工作，不能当作当前已经接入或已经验收。

### 已核对的上游结构

- 根包是 `@hypit/hypit` `0.2.12`，`packageManager` 固定为 `pnpm@10.33.0`，引擎要求 Node `>=22.15.0`；仓库 `.node-version` 为 `24.14.1`。
- `pnpm-workspace.yaml` 收纳 `packages/*`、`services/*` 和示例项目包。当前只读统计为 122 个 workspace package manifest 加 3 个 service manifest；源码仓库约 40 MB，当前 `node_modules` 实测约 581 MB。Python 环境、浏览器、模型和生成媒体另行计量，不能把源码或 Node 依赖大小当作完整运行时磁盘需求。
- `bin/hypit.mjs` 是 Distribution 入口，注册 `tsx`，支持 `hypit --version`；`hypit studio` 启动 Studio，其他命令进入 `packages/video-cli`。根脚本还提供 `check`、`test`、`build:public-types`、`pack:distribution`、`check:distribution`、`docs:dev/build/preview` 和本地 WhisperX/OpenCV 测试。
- 功能包覆盖 SVML/SVS 编译与运行（`compiler-node`、`compiler-markup-node`、`elaborator`、`run`、`runtime*`）、Film/Timeline/Composition、媒体管线、字幕/音轨/图形轨道、模型和 Provider、结果存储、浏览器捕获、Studio 与视频 CLI。完整接入不能只复制参考视频分析接口，必须保持这些包之间的 workspace 版本和运行契约。

### 首轮安装、构建和验收命令（实施时执行）

在获得明确安装授权并先记录磁盘空间后，实施者应在 `integrations/hypit/upstream` 使用与锁文件匹配的命令：

```bash
corepack pnpm@10.33.0 install --frozen-lockfile
corepack pnpm@10.33.0 check
corepack pnpm@10.33.0 build:public-types
corepack pnpm@10.33.0 test
corepack pnpm@10.33.0 check:distribution
corepack pnpm@10.33.0 pack:distribution
node bin/hypit.mjs --version
node bin/hypit.mjs --help
node bin/hypit.mjs studio --help
```

这些命令是计划命令，本轮没有执行安装或构建。发布 Distribution 的实际入口还应按上游文档验证 `hypit paths`、`hypit doctor`、`hypit runtime init/use/up/status/logs/down`、`hypit plan`、`hypit check`、`hypit snapshot`、`hypit build/status/inspect/get`、`hypit result`、`hypit auth`、`hypit pricing`、`hypit media prepare-fetch/fetch` 和 `hypit capture install-browser`。必须把“命令能启动”“本地能力可用”“远程模型成功”“最终视频看过并通过”分开记录。

### 编译器、CLI、Studio、运行与渲染依赖

- 编译链不是单一转译器：SVML/SVS 源码需要 markup/compiler/elaborator/run 相关包，Runtime Host/Local 和 Package Loader 负责加载项目包与运行时。
- CLI 由 `video-cli`、`cli` 和根 `bin/hypit.mjs` 组成；Studio 由 `packages/studio`、Studio Adapter 及 HyperFrames 浏览器预览组成。Studio 浏览器预览不等于 MP4 导出。
- 最终图像渲染依赖 HyperFrames Provider、受支持的 Chrome for Testing、FFmpeg/FFprobe；浏览器捕获文档要求 Chrome 153 或更高。媒体本地 Provider 需要可信的 `ffmpeg` 与 `ffprobe`，系统包管理器负责它们，不由 Hypit 自动安装。
- 本地图像能力另有 Python 3.13、NumPy 2.x、OpenCV 4.x 的 `services/image-opencv`；本地语音对齐另有 Python 3.10–3.13（锁定 Python 3.13）、WhisperX 3.8.6、faster-whisper、PyTorch/torchaudio、NLTK 和语言对齐资源；下载后仅使用本地资源运行。
- `services/yt-dlp` 是 Python 3.10–3.13 的锁定下载器环境，要求 FFmpeg/FFprobe；平台链接抓取是否可用取决于 yt-dlp extractor、登录和站点限制，不能把它写成无条件支持。

### 外部服务和凭据边界

完整功能可选 HypiHub，也可接 Provider 包对应的 BeatAPI、HiAPI、Monid、Pollo、Tokendance 等远程服务，以及 ElevenLabs、Fish Audio、Mimo、MiniMax 等语音/模型路由；具体模型是否可用必须以当前账户、Endpoint 和服务返回为准。Hypit 安装包本身不提供模型额度。

可纯本地验证的部分包括：编译、语法与包分发检查；项目/运行时配置读写；`plan`、`check`、静态 `doctor`；本地 FFmpeg 媒体操作；本地 OpenCV 图像处理；准备好模型后的本地 WhisperX；准备好浏览器后的 HyperFrames 预览/渲染；结果文件、manifest、快照和可播放视频的本机检查。需要外部账号或付费的图片、视频、语音、HypiHub、发布和远程下载必须单独授权并记录实际回执，不能用模拟测试替代。

### 磁盘、网络与许可验收

当前仓库约 40 MB，依赖安装大小、pnpm store、Python `.venv`、Chrome 浏览器、WhisperX 模型缓存和生成媒体缓存尚未实测，因此接入前必须先测量可用空间并把各目录分别登记；不得依据仓库大小推断完整安装所需容量。准备模型、浏览器和依赖会产生下载和额外磁盘占用。

必须随接入保留根目录 `LICENSE` 原文、Hypit 名称/Logo/版权信息、固定提交记录和对应修改记录。该许可是带附加条件的 Apache 2.0 修改版：自用或为本组织工作有明确许可范围；多租户托管/SaaS、商业再分发或向第三方收费提供 Hypit 或其衍生物可能需要另行商业许可；不得移除 CLI、运行报告、manifest 或用户界面中要求保留的标识。第三方 Provider、模型、字体、音乐、素材和服务仍有各自条款，Hypit 输出归属条款不能替代它们。

### 当前完成状态

当前已完成固定提交源码与 Distribution 的本机安装、类型/分发检查、Runtime doctor 和一次本地 Build/导出验收；但完整功能的一比一接入仍未完成。外部生成 Provider、账号和额度未授权，Studio 全功能、所有 Provider、平台下载、远程模型与发布链路仍需分别验收，不能把一次本地视频导出扩大为全部 Hypit 能力已通过。
