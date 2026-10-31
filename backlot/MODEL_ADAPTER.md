# 模型调用器适配页

`backlot/model_adapter.py` 是 derivative 分支新增的适配层：官方 Backlot
仍然负责观察 `projects/`，新增的 `/model` 页面负责验证 Seedance 请求参数。
官方 `backlot/server.py` 没有被修改。

## 启动

在仓库根目录执行（本机开发模式）：

```bash
scripts/serve_model_adapter.sh
```

打开 `http://127.0.0.1:4750/model`。如果只需要 Backlot 观察板，原来的
`python -m backlot serve --port 4750` 仍然可用。

脚本默认设置 `WEB_API_LOCAL_MODE=1`，服务启动时生成仅存在于当前进程的随机内部授权令牌，
这样模型页的“确认提交”可以直接调用现有任务 API；它不会写入磁盘或发到浏览器。公网部署时
不要启用这个模式，应由部署环境显式设置高熵的 `WEB_API_PAID_AUTH_TOKEN`，并另行加入登录、
限流和用户级额度控制。

## 安全与调用边界

1. 页面默认只调用 `POST /model-api/api/tasks/estimate`，对应
   `SeedanceArkVideo.dry_run()`，不会创建 provider 任务。
2. “进入付费二次确认”再次估算并生成十分钟有效的一次性确认编号；这一步仍不收费。
3. 只有创作者再次点击弹窗中的“确认提交”，服务端才会读取
   `WEB_API_PAID_AUTH_TOKEN` 并调用现有 `POST /api/tasks`。密钥不进入 HTML、JavaScript、
   localStorage、SQLite 或浏览器请求头。
4. 确认编号只能使用一次；服务重启会使未使用编号失效，避免未知回执后的自动重试。
5. 提交后页面提供“刷新任务状态”和“取消远程任务”；它们复用官方 Ark 的查询/取消接口，
   不会重新创建任务。若 provider 返回视频 URL，页面只显示临时链接；仍需下载到本机、
   用 `ffprobe` 检查媒体并通过质量门后才能交付。

在 macOS 开发机上，如果环境变量没有设置，适配层会尝试读取已有的
Keychain 服务项 `ARK_API_KEY`，只放入当前服务进程内存；非 macOS 或 Keychain
不可用时不会报错，仍可通过环境变量配置。公网仍需由部署者显式设置
`WEB_API_PAID_AUTH_TOKEN`，作为第二道付费授权闸门。

这里的“提交成功”只表示 provider 返回了任务回执，不等于视频已经下载、落盘、抽帧质检或
剪辑交付完成；后续仍需要查询、媒体文件验证和质量门。

## 免费规划与参考视频

模型页的三案、分镜不再只停留在浏览器内存：

- `POST /model-api/workflow/draft` 会把当前免费规划写入独立的
  `projects/draft-*/` 草案，包含 `brief`、`research_brief`、三案
  `proposal_packet`、脚本/分镜（已生成时）、阶段 checkpoint、history 和事件；
  草案会立即出现在 Backlot 项目库，但不会调用付费模型。
- `POST /model-api/media/reference/review` 只读取本机参考视频，依赖 FFmpeg、FFprobe
  和 `video_analyzer` 提取场景、关键帧、运动/节奏及音频元数据，结果写入项目
  `analysis/reference/` 和研究工件。网络 URL 不会被后台偷偷下载；缺少识别模型时会返回
  `unavailable`，不伪造字幕。

因此，质量优先可以边看边改并在项目库中留下可追溯草案；速度优先仍自动选优并连续保存，
付费 Seedance 任务仍必须经过单独的二次确认。

图像分镜也已接入直连 Ark 的 `doubao_seedream_image`：它复用服务端
`ARK_API_KEY`（macOS 上可由同名 Keychain 项桥接），支持文本生图、参考图编辑和
本地落盘。返回的临时 URL 会立即下载，随后只把本地文件、模型名、请求 ID、使用量和
SHA-256 指纹写入项目工件；浏览器不会看到密钥，也不会把临时 URL 当成永久素材。
真实调用仍受显式付费确认门保护，缺少密钥时页面只显示不可用，不会静默改用其它模型。

## OpenMontage 能力与管线目录

模型页的真实媒体阶段下提供“读取工具目录”和“查看管线目录”两个入口：

- `GET /model-api/tools/catalog` 按 OpenMontage 注册表返回工具的真实状态、提供方、运行时、
  依赖和安装提示；只返回元数据，不返回任何密钥，也不会因为查看目录而启动任务。
- `GET /model-api/pipelines/catalog` 读取并校验 `pipeline_defs/*.yaml`，展示 13 条管线的
  阶段顺序、产出、检查点、人工确认门、参考输入支持和编排预算基线。
- 本机已安装 `opencv-python-headless>=4.10`，人脸追踪可以使用 OpenCV Haar 降级方案；
  未安装 MediaPipe 时页面仍标记“降级可用”，不会把降级结果伪装成精细关键点追踪。

## 分镜返修与无视频模型降级

- `POST /model-api/workflow/storyboard/repair` 接收一个镜头编号和创作者修改意见，
  只更新该镜的画面提示词、运镜提示词、返修次数和质量检查项；其它镜头及共享边界帧
  契约保持不变。浏览器随后会把完整分镜重新保存到 `artifacts/scene_plan.json`，所以
  返修不会只停留在页面内存。
- `POST /model-api/media/stills/compose` 接收项目内的 PNG/JPG/WebP 分镜图，先用本机
  FFmpeg 生成带轻微推镜的动态片段，再复用原有多段合成、转场、旁白、字幕和质检路径。
  结果写入 `renders/still_clips/`、`renders/` 和
  `artifacts/still_composition_manifest.json`，并生成 `checkpoint_compose.json`。
  这是本机后期降级方案，不会冒充 Seedance 或其它视频模型，也不会产生云端费用。
- 工作流保存成功后，页面会显示“进入后期制作”；输入已有项目 ID 后点击“载入项目”，
  可以在同一个页面继续做参考分析、字幕/配音、分镜图、分镜图动态化、多段合成、技术
  质检和本机交付包导出。

## 免费素材检索

OpenMontage 的 `direct_clip_search` 现在也接入了模型页。先点击“预检素材源”查看
Archive.org、NASA、Wikimedia 等来源的可用状态，再确认“检索并下载候选素材”。执行后
素材保存在当前项目的 `assets/stock/clips/`，视频缩略图保存在
`assets/stock/thumbnails/`，并生成 `artifacts/stock_search_manifest.json` 与
`checkpoint_assets.json`。清单会记录来源、作者、原始链接和许可证，便于人工选片与
比赛交付时核验；素材检索本身是免费公共来源，但需要网络连接并遵守各来源许可证。

项目库把素材候选与最终渲染视频分开计数，Backlot 项目页可直接播放、预览或下载候选
素材。当前接入的是快速多来源检索，不包含 CLIP 语义向量排序；后者需要额外的本地
机器学习模型，仍保留为后续可选增强。

素材进入合成前还可以调用 `POST /model-api/media/trim`：预检会读取源视频时长并给出
入点/出点和输出路径，确认执行后由 OpenMontage 的 `video_trimmer`（FFmpeg）把片段写入
`assets/trimmed/`，生成 `artifacts/trim_manifest.json` 和 `checkpoint_edit.json`。默认使用
精确重编码，亦可选择快速 `copy` 模式；两者的取舍会直接显示在页面上。

## 音频后期

### BGM 后置生成（ElevenLabs Music）

工作台把 BGM 单独放在旁白、无 BGM 成片之后，避免音乐节奏反过来限制镜头和配音。接口为
`GET /model-api/media/music/health`、`POST /model-api/media/music/estimate` 和
`POST /model-api/media/music/render`：

- 预检读取最终成片的真实时长、画幅和文件哈希，生成可复用的四段情绪 cue sheet；不写文件、不调用云端。
- 执行必须同时满足 `dry_run=false`、`execute=true`、`confirm=true` 和服务端授权；没有密钥时明确返回
  `unavailable`，不会写假音频，也不会静默换用低质量后备。
- `ELEVENLABS_API_KEY` 只从服务端环境变量或 macOS Keychain 读取。视频字节不会上传给 ElevenLabs，参考视频
  只被本机转成时长/画幅等文本提示；输出写入项目 `assets/music/`，并生成
  `artifacts/music_manifest.json`、`artifacts/music_cue_sheet.json`、`checkpoint_compose.json` 和事件记录。
- 生成成功后，页面会自动把 BGM 填入“音频后期”主/副音频与轨道清单，创作者无需复制路径，再用
  `audio_mixer` 完成旁白压低、响度规范化和最终导出。

模型页的“音频后期”现在复用了 OpenMontage 的真实 `audio_mixer`（FFmpeg）能力，接口为
`POST /model-api/media/audio/mix`。支持 `full_mix`（旁白、BGM、音效多轨混音并自动压低
BGM）、`duck`（旁白出现时降低副音频）、`mix`（按轨道清单混音）、`extract`（从视频抽取
单声道 WAV）和 `segmented_music`（按时间段把创作者提供的 BGM 后置到视频）。每次执行都
会把输出写入 `assets/audio/processed/`（分段 BGM 视频写入 `renders/`），并保存
`artifacts/audio_mix_manifest.json`、SHA-256 文件指纹、ffprobe 媒体信息和阶段检查点。
预检只读取文件；执行是本机操作，不会调用付费模型，也不会自动生成 BGM。

旁白清理使用 `POST /model-api/media/audio/enhance`，复用了 `audio_enhance` 的
`clean_speech`、`noise_reduce`、`normalize_only`、`podcast`、`broadcast` 和
`voice_clarity` 预设。原始文件不会覆盖，增强文件和 `artifacts/audio_enhance_manifest.json`
会留在当前项目，便于试听、回退和比赛交付核验。工作台的项目载入会递归发现
`assets/audio/processed/` 中的真实文件，Backlot 不会再把它们当作“没有媒体”。

旁白面板默认选择 `macos_say_tts`（provider=`macos`）：在 macOS 上使用系统
`say` 与 FFmpeg 生成免费的真实旁白草稿，并沿用同一套字幕时间轴、文件哈希和
`audio_manifest.json`。它只用于校准节奏和字幕，不支持神经情绪控制；切换为云端
provider 后仍需服务端密钥及明确的付费授权。

## 视频后期工具箱

为了让 OpenMontage 的计划、素材和成片真正接上，模型页还提供
`POST /model-api/media/video/postprocess`。它复用项目内的本机工具，不调用付费模型：

- `silence_cut`：检测旁白中的长停顿，可删除、加速，或只生成停顿报告；适合解决“停顿很长、文案不连贯”。
- `scene_detect`：按内容变化、亮度阈值或自适应方式检测镜头边界，只写入 JSON，方便剪辑和质检复核。
- `auto_reframe`：把横屏素材转换成 9:16、4:5、1:1、16:9 或 21:9；安装人脸跟踪依赖时会跟随主体，未安装时安全退回中心裁切。
- `color_grade`：使用暖色电影、冷青橙、复古胶片等预设统一画面风格，并可调节强度。

视频操作默认只做预检；点击执行后才生成派生视频或报告，原文件不会被覆盖。结果会写入
`renders/processed/` 或 `analysis/video/`，并生成对应的
`artifacts/*_manifest.json`、SHA-256 文件指纹、ffprobe 媒体信息、阶段检查点和事件，
因此 Backlot 项目库能够在刷新后继续找到这些真实产物。
