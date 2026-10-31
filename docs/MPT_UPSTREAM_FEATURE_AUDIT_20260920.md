# MoneyPrinterTurbo 上游能力审计（2026-09-20）

## 审计范围与结论

本报告只审计官方仓库 https://github.com/harry0703/MoneyPrinterTurbo 的源代码、配置示例、测试/CI 和文档，服务于浙江文旅 AI 视频引擎 V2 的接入决策。审计没有安装依赖、没有启动 WebUI/API/CLI、没有执行上游代码、没有下载 Whisper 模型、没有调用任何 LLM/TTS/图片/视频/BGM/发布接口，也没有读取或写入任何秘密。

结论是：MPT 适合当作一个可选的、版本固定的能力后端或少量 MIT 代码参考，不适合把其 Streamlit UI、全局 TOML 配置、任务状态和整条 task.py 管线直接搬进 V2。V2 应继续拥有事实来源、首尾帧与连续性契约、规范化素材清单、质量门和本地成片验收；MPT 只在明确的能力边界内返回文本、音频或本地媒体文件及来源元数据。

优先级建议如下：

1. 先在 V2 原生实现“能力描述 + 授权门 + 规范化结果”，把 MPT 的 Provider Registry、提示词构造、素材来源记录和本地转码行为作为参考。
2. 需要覆盖全部 MPT Provider 时，用独立 Python worker 或本地 HTTP/JSONL 子进程桥接固定 checkout；worker 的 Python 环境、依赖、配置和任务目录与 V2 隔离。
3. 只复用可以被验证为纯函数或局部转换的源代码；不要直接导入 app.services.task、webui/Main.py、app.config.config 或 MPT 的全局状态。

## 固定上游来源

| 项目 | 结果 |
| --- | --- |
| 参考 checkout | /Users/mjd-ppps/生视频/MPT参考_20260920 |
| origin | https://github.com/harry0703/MoneyPrinterTurbo.git |
| 分支 | main |
| commit | e0c9cb77ffd0226a789441420190f80a125c20c4 |
| commit 时间 | 2026-09-18T17:48:59+08:00 |
| commit 作者/主题 | XiaoChen；fix(asgi): normalize CORS origins (#1392) |
| checkout 形态 | shallow clone，git rev-parse --is-shallow-repository 为 true |
| checkout 工作树 | clean；没有在 checkout 内编辑 |
| pyproject 版本 | 1.3.7 |
| 许可证 | MIT，LICENSE 标注 Copyright (c) 2024 Harry |

LICENSE 允许复制、修改、发布、分发、再许可和销售，但分发实质代码时必须保留版权及许可文本。依赖包拥有各自许可证；MPT 的 resource/songs 中的默认音乐在 README 中明确提示来自 YouTube、可能有版权问题，不能因为 MPT 本身是 MIT 就把这些音频作为 V2 可分发素材。

本报告只代表上述 commit 的静态快照。README 的“支持”清单不等同于当前账号、地区、配额、价格或供应商服务可用；所有外部 Provider 在接入前都需要重新检查协议、价格、内容政策和凭据要求。

## 用户可见功能总览

### 入口、任务和批处理

- AI Agent、Streamlit WebUI、FastAPI API、CLI 四种入口。
- 从主题开始可生成脚本、搜索词、TTS、素材、字幕、BGM 和最终视频；脚本、搜索词、音频、素材、字幕、剪辑参数都可以分别替换或停在中间阶段。
- CLI 的 stop-at 阶段为 script、terms、audio、subtitle、materials、video；支持单任务和 JSON/JSONL 批处理，最多 100 条且清单不超过 1 MiB。
- WebUI 提供任务历史、预览、恢复、批量生成、日志/进度、下载、打开任务目录、设置导入/导出和 API Key 备份/恢复。
- FastAPI 任务接口支持创建视频、只生成音频/字幕、任务列表、任务状态、删除任务、上传/列出本地素材和 BGM、流式下载与下载。
- 可选 Redis 任务状态、并发和队列上限；默认任务文件落在 storage/tasks/<task-id>，本地素材在 storage/local_videos，用户 BGM 在 storage/bgm。

主要入口和模块：

- WebUI：webui/Main.py、webui.sh、webui.bat。
- API：main.py 启动 uvicorn app.asgi:app；路由在 app/router.py、app/controllers/v1/video.py、app/controllers/v1/llm.py。
- CLI：cli.py 的 parse_args/main；支持 --batch-file、--stop-at 和所有主要 VideoParams。
- 主编排：app/services/task.py 的 _run_pipeline 及其 script、terms、audio、subtitle、materials、video、cross-post 阶段。
- Agent Skill：docs/skill/SKILL.md、docs/skill/mpt_agent.py。它会安装或下载 MPT 到用户目录并询问缺失密钥；本审计没有运行它，V2 也不应把它当作本地免费执行路径。

### LLM 和文本能力

app/models/llm_provider.py 有 27 个 Registry Provider ID；app/services/llm.py 负责连接测试、脚本、搜索词和社交元数据。普通 OpenAI-compatible Provider 只需 Registry 项，协议特殊的 Provider 在 llm.py 有单独分支。

| Provider ID | 适配方式 | 凭据/运行要求 |
| --- | --- | --- |
| moonshot | OpenAI-compatible；中国/国际两个默认入口 | Moonshot API Key，云端请求 |
| openai | OpenAI Chat Completions | OpenAI API Key，云端请求 |
| anthropic | 通过 OpenAI-compatible 端点 | Anthropic 凭据，云端请求 |
| gemini | google-genai 原生 SDK | Gemini API Key，云端请求 |
| deepseek | OpenAI-compatible | DeepSeek API Key，云端请求 |
| qwen | DashScope Generation 原生 SDK | DashScope API Key，云端请求 |
| azure | AzureOpenAI | Azure OpenAI Key、Base URL、部署名和 API version |
| volcengine | Ark OpenAI-compatible | 火山方舟 Key，云端请求 |
| grok | xAI OpenAI-compatible | xAI API Key |
| minimax | MiniMax OpenAI-compatible | MiniMax API Key |
| mimo | Xiaomi MiMo OpenAI-compatible | MiMo API Key |
| shengsuanyun | 胜算云 OpenAI-compatible | 胜算云 Key |
| apimart | APIMart OpenAI-compatible /v1 | APIMart Key |
| cloudflare | Cloudflare AI Gateway 特殊分支，内部仍用 OpenAI Client | Cloudflare API Key、account_id，gateway_id 可配置 |
| modelscope | ModelScope 特殊分支，OpenAI Client + 响应解析 | ModelScope API Key |
| aihubmix | OpenAI-compatible | AIHubMix Key |
| aimlapi | OpenAI-compatible | AIML API Key |
| evolink | OpenAI-compatible | EvoLink Key |
| openrouter | OpenAI-compatible | OpenRouter Key |
| api_route | OpenAI-compatible | API Route Key |
| fluxionai | OpenAI-compatible | Fluxion Key |
| ollama | 本地 OpenAI-compatible；代码将 key 固定为 ollama 并推断容器/宿主 Base URL | 本地 Ollama 服务，无云端 Key |
| claude_code | 调用本机 claude CLI 子进程 | 本机 CLI 登录的订阅或其认证环境；不是免费匿名 Provider |
| oneapi | 通用 OpenAI-compatible | OneAPI 网关 Key/地址 |
| litellm | litellm.completion | Registry 不强制 API Key，但底层模型凭据通常来自 worker 环境变量或 LiteLLM 配置 |
| groq | OpenAI-compatible | Groq Key |
| pollinations | OpenAI-compatible | Pollinations 凭据/服务条款需按当前服务复核 |

文本功能包括：

- generate_script：主题、语言、段落数、额外提示和自定义系统提示词；会清除部分 reasoning 标签并限制输入长度。
- generate_terms：生成 1 到 3 词的英文素材搜索词，可按脚本顺序排列；可选 TwelveLabs Marengo 重排。
- generate_social_metadata：TikTok、YouTube Shorts、Instagram Reels、Facebook Reels 的标题、描述/文案和 hashtag；LLM 失败时有启发式兜底，但这不代表平台发布成功。
- test_connection：按 Registry 选择协议、模型、Base URL 和额外字段进行连接测试。

### 素材搜索、本地素材和视频/图片生成

MPT 的主素材入口是 app/services/material.py:download_videos。库存素材走搜索、缓存、筛选和下载；付费生成源则按旁白时长逐段提交，达到所需时长后停止，签名下载地址不进入 24 小时搜索缓存。

| 素材源 | 代码入口/能力 | 凭据、计费和限制 |
| --- | --- | --- |
| local | 本地图片/视频上传和预处理 | 本地文件；不需要外部 Key |
| Pexels | search_videos_pexels | Pexels API Key；库存搜索/下载 |
| Pixabay | search_videos_pixabay | Pixabay API Key；库存搜索/下载 |
| Coverr | search_videos_coverr | Bearer Key；库存搜索/下载 |
| WaveSpeed | generate_videos_wavespeed | 异步文生视频，按请求计费；默认 Seedance 2.0 fast，时长通常 4–15 秒 |
| Volcano Engine Ark Seedance | app/services/volcengine_seedance.py | 官方异步接口，按任务计费；2–12 秒，480/720/1080p |
| OFox | app/services/ofox.py | 多模型异步接口，含 Seedance/Wan 等；按提交片段计费 |
| MuAPI | app/services/muapi.py | 异步模型端点；默认 seedance-lite-t2v，约 3–12 秒，按任务计费 |
| Metaso MiniMax H3 | app/services/metaso_minimax.py | 独立于 MiniMax LLM Key 的异步视频 API；768P/2K，4–15 秒，9:16/16:9/1:1，按任务计费 |
| OpenAI-compatible image | generate_images_openai、_render_openai_image_video | /images/generations 返回图片，再由 MoviePy 生成缩放动画；云端图片调用可能计费，本地网关可以不计云费 |
| LoomLoom/胜算云 | app/services/loomloom.py 的脚本 SkillBot 和视频 backend | 需要 token、账户能力查询、异步运行和明确报价；属于付费云服务，单独于普通 LLM Provider |
| TwelveLabs | app/services/twelvelabs.py | 可选 Marengo 语义重排/视频理解；需要额外依赖和 Key；不是默认素材下载源 |

Stock Provider 的素材记录会保存 provider、asset ID、公开素材页、作者/创作者和 rendition 等字段；下载 URL 会去除查询参数和凭据。这个 provenance 设计可参考 V2，但其记录结构还没有自动满足 V2 的事实来源、镜头首尾帧、哈希和质量证据契约。

CLI 当前可选 video source 为 pexels、pixabay、coverr、wavespeed、volcengine_seedance、ofox、metaso_minimax、muapi、openai_image、local。loomloom 走 task/WebUI 的独立路径，不能仅靠 CLI video source 清单推断它与其他源完全同构。

### TTS、音频和字幕

app/services/voice.py 的 tts(text, voice_name, voice_rate, voice_file, voice_volume, …) 统一分发以下语音方式：

| 方式 | 具体行为 | 凭据/费用/时间轴 |
| --- | --- | --- |
| no-voice | FFmpeg 生成确定时长的静音 | 本地；无 Key |
| Azure TTS V1 / Edge TTS | edge-tts 流式语音，取得 word/sentence boundary | Edge 路径无需 API Key；有网络依赖，通常按服务条款使用 |
| Azure TTS V2 | azure-cognitiveservices-speech 和 SSML/prosody | Speech Key + Region；云端服务 |
| SiliconFlow | /v1/audio/speech | Key；云端服务 |
| Gemini TTS | google-genai，PCM 转 MP3 | Gemini Key；云端服务；没有 Edge 一样的逐词边界 |
| Xiaomi MiMo TTS | OpenAI-compatible audio/speech | MiMo Key/Base URL；云端服务 |
| MiniMax TTS | t2a_v2，支持区域地址、模型、音色、速率、音量 | MiniMax TTS Key 或复用 LLM Key；云端服务 |
| ElevenLabs TTS | text-to-speech/{voice_id} | ElevenLabs Key；云端服务 |
| Chatterbox | OpenAI-compatible 本地/自托管 TTS | 默认本机 4123 端口；不需要云 Key，但需要用户自行运行服务 |
| Kokoro | OpenAI-compatible 本地/自托管 TTS | 默认本机 8880 端口；不需要云 Key，但需要用户自行运行服务 |
| Fish Audio | /v1/tts，支持公共/克隆 voice ID | Key；即使配置 s2.1-pro-free，也受 Fair Use、限流和时间窗口影响，不能当作稳定免费能力 |
| ModelBest VoxCPM | SSE WAV 流，转成内部 MP3；支持参考音频、prompt audio/text | API Key、支持 speech_synthesis 的模型；云端服务，参考音频属于敏感个人素材，应留在本地授权边界 |

Edge 以外的 Provider 通常只能先生成完整文本时间轴；代码会通过 full-text SubMaker 兼容视频流程。只有 Edge 的分段 TTS 会处理 pause tags；其他 Provider 会移除 pause tags 后单次请求。

字幕有两条路径：

- edge：直接聚合 TTS 时间戳，默认快速路径。
- whisper：faster-whisper 本地转写，支持 segment/word 级时间轴、语言检测、标点和脚本纠正；默认 large-v3 约 3 GB，首次可能从 Hugging Face 下载模型。

Edge 失败不会自动触发 Whisper 下载；这避免了隐藏的重量级网络行为，但意味着字幕可能被跳过。V2 接入时必须把“有音频”“有时间轴”“有字幕”分别作为可验证状态，不能把任务返回成功当作字幕已完成。

### 剪辑、字幕样式、BGM 和发布

app/services/video.py 使用 MoviePy 2.2.1 和 FFmpeg：

- 画布：9:16 为 1080x1920，16:9 为 1920x1080，1:1 为 1080x1080。
- fit：cover/crop 或 contain/黑边；素材可随机或顺序拼接。
- 单段时长、播放速度 0.5–2.0、30 fps；转场有 FadeIn、FadeOut、SlideIn、SlideOut、ZoomIn、ZoomOut 等。
- 可选 libx264、h264_nvenc、h264_amf、h264_qsv、h264_mf、h264_videotoolbox；运行时不可用会回退 libx264。
- 字幕支持自定义字体、颜色、描边、背景/圆角框、上/中/下/自定义位置、sentence 或 word_by_word 和 pop_spring 动画。
- 图片源只是 ImageClip 加缩放/平移动画，不是文生视频运动镜头。
- 旁白、BGM 和视频音频用 MoviePy/FFmpeg 合成；任务会依据旁白真实文件时长决定所需画面时长。

BGM 类型包括内置随机、用户上传/本地、Sonilo video-to-music、ElevenLabs video-to-music，可单独控制音量。Sonilo 和 ElevenLabs Music 都需要云端 Key、会把最终视频做代理后上传到远端生成音乐，属于后置付费步骤。内置 resource/songs 的文件包含上游 README 所述的潜在版权问题，不能随 V2 分发而默认带入。

跨平台能力分成两部分：

- social metadata 只生成标题、文案和标签，支持 TikTok、YouTube Shorts、Instagram Reels、Facebook Reels。
- upload_post.py 的真实跨发使用 Upload-Post API，可发 TikTok、Instagram、YouTube；需要账号/API Key，并可能产生外部写入。WebUI/API 配置有 auto upload 和 YouTube privacy/kids 选项。

本审计没有启用或测试跨发；V2 必须把它当成独立的外部发布授权，而不是“视频生成成功”的组成部分。

## 运行时、依赖和导入边界

pyproject.toml 声明 Python >=3.11，版本 1.3.7，主依赖精确固定为：

- moviepy 2.2.1、streamlit 1.59.1、streamlit-tour 1.1.0；
- edge-tts 7.2.7、fastapi 0.136.3、uvicorn 0.32.1、openai 2.24.0；
- faster-whisper 1.1.0、loguru 0.7.3、dashscope 1.20.14、azure-cognitiveservices-speech 1.41.1；
- redis 5.2.0、python-multipart 0.0.27、pyyaml 6.0.3、requests 2.33.1、packaging 24.2、socksio 1.0.0、pydub 0.25.1；
- Python >=3.13 时追加 audioop-lts 0.2.2；
- litellm 1.86.2、google-genai 2.11.0；
- TwelveLabs 为可选 extra，版本约束 twelvelabs>=1.2.8；
- 开发组包含 coverage 7.15.1、pytest 9.1.1、ruff 0.15.21。

FFmpeg 是媒体链路硬依赖。Dockerfile 使用 Python 3.11-slim 并安装 FFmpeg；本地脚本会尝试检测/下载或使用 config 中的 ffmpeg_path。MPT 的 uv.lock 固定了解析结果，不能与 V2 现有 .venv3.13 或 .venv-backlot3.12 直接混装。

Python 3.13 判断：

- 上游 GitHub Actions 的 CI matrix 明确包含 Python 3.11 和 3.13；两者都会执行 uv sync --frozen、compileall、pytest/coverage。pyproject 还为 3.13 增加 audioop-lts。这是“上游声明并持续验证过”的证据。
- 本次没有安装或执行，因而没有对本机 .venv3.13 做运行验收；不能把上游 CI 配置替换成本地兼容性证明。
- 依赖矩阵仍会和 V2 冲突：MPT 锁定 MoviePy 2.2.1、Streamlit/FastAPI、OpenAI SDK、faster-whisper 等；V2 当前工作树有自己的运行时与未提交状态。最安全的方案是单独的 MPT Python 3.13 worker 环境；若后续只需与上游官方默认环境一致，固定 Python 3.11 worker 也更接近 Docker/README 的推荐路径。
- 3.13 兼容不代表所有 Provider 可用。API Key、远端服务、FFmpeg 编码器、Whisper 模型和本地 TTS 服务仍须逐项验收。

导入开销和副作用决定了不应在 V2 进程内“全量 import MPT”：

- app/services/llm.py 顶层加载 OpenAI/Azure 类型；DashScope、google.genai、litellm 等在对应分支再懒加载。
- app/services/voice.py 顶层加载 edge-tts、MoviePy、OpenAI，并在模块内统一管理所有 TTS 路由。
- app/services/material.py 顶层导入多个远程视频模块、MoviePy/PIL、缓存和任务产物模块。
- app/services/task.py 顶层导入 llm、material、voice、subtitle、video、bgm、TwelveLabs、LoomLoom、Sonilo、ElevenLabs Music 和所有异步视频 Provider；导入它就等于接受 MPT 的全套配置/状态耦合。
- app/config/config.py 绑定仓库根目录的 config.toml 并维护同步写入锁，不能共享 V2 的 canonical config。

推荐给主代理的 Provider 暴露方式：

1. V2 前端/编排层只持有静态 capability catalog：provider_id、kind、requires_key、requires_model、supports_word_timing、supports_image/video、duration/aspect limits、paid、source license/provenance policy。LLM Registry 的纯 dataclass 可按 MIT 许可重写成 V2 schema；不需要加载 WebUI。
2. 文本请求通过 worker 的 generate_script、generate_terms、generate_social_metadata 语义接口；V2 传递主题/脚本/语言/提示词，不传 API Key。
3. TTS 请求让 worker 返回本地音频路径、真实时长、Provider、voice_id 和可选 cues/SRT；没有逐词 cues 时由 V2 明确选择 Whisper、句级字幕或“无字幕”，不要假称具备精确同步。
4. 图片/视频请求让 worker 返回本地文件和 manifest；manifest 至少包括 provider、model、prompt hash、源 URL/asset ID、实际时长、宽高、下载时间、文件 SHA-256。V2 接收后再做 ffprobe、抽帧和首尾帧/连续性质量门。
5. 付费 Provider 必须先由 V2 生成报价/预计任务清单并取得现有授权，再让 worker 提交；worker 只能接受显式 job token 或确认字段，不能从“配置里有 Key”推断同意。

## 三种接入路径的取舍

| 路径 | 可以拿到的能力 | 适合范围 | 必须补齐的门 |
| --- | --- | --- | --- |
| V2 原生实现 | stock 搜索、Provider catalog、提示词/词项、音频/媒体 manifest、FFmpeg 本地剪辑 | 低风险、可复核的本地和库存能力 | 许可证/来源、哈希、时长/尺寸、首尾帧、事实来源、质量复核 |
| 固定 checkout 的隔离 worker | 全部 MPT LLM/TTS/图片/视频/LoomLoom/音乐能力；可按上游版本升级 | 需要覆盖大量 Provider，且不能承受 V2 依赖污染时 | 独立 Python 环境；JSONL/HTTP 协议；凭据只在 worker；超时/取消/重启；本地下载和 manifest；V2 付费门 |
| 少量源代码重用 | 纯 Registry、提示词构造、SRT 解析、素材 provenance、局部图片缩放/fit/转码 | 只要一个小能力，不想维护完整 worker 时 | MIT notice、依赖许可证、V2 BaseTool 适配、路径安全、静态/本地测试 |

隔离 worker 的具体边界建议：

- 请求采用版本化 JSON，字段包括 request_id、capability、provider_id、input、output_dir、confirmation_state 和 timeout；绝不把 secret、config.toml 或浏览器会话传进 V2。
- worker 从允许列表解析 output_dir，只能写任务 staging 目录；禁止把结果直接写入 V2 的最终资产目录。
- 返回结果包括 state、local_files、duration、width、height、sha256、provider、model、source_records、warnings 和 billable_request_id（若有）；远端 URL 只能作为短期下载证据，不能作为“完成”。
- V2 成功导入前执行本地文件存在、非空、ffprobe、哈希、真实时长/尺寸、抽帧、音频/字幕可读性检查。付费任务的 ambiguous/unknown 状态不得自动重试。
- 对 LLM/TTS 这类纯文本/音频能力可以先做单请求 worker；对异步文生视频、LoomLoom、BGM 必须支持轮询、取消和进程重启恢复，并把计费状态与本地文件状态分开。
- Worker 可用 Python 3.13 独立环境；如果需要最小依赖，按 capability 启动不同 worker，避免导入所有 MPT 服务。

## 可直接参考的实际源码入口

下表是“源码中确实存在的入口”，不是已在 V2 中接入或已验证的能力：

| 能力 | MPT 入口 | 适配建议 |
| --- | --- | --- |
| Provider 元数据 | app/models/llm_provider.py:LLM_PROVIDER_REGISTRY | 读取/重写为 V2 catalog；不要依赖 WebUI locale 或 affiliate URL |
| LLM 文本 | app/services/llm.py:generate_script、generate_terms、generate_social_metadata | V2 传 canonical prompt/context，worker 返回结构化文本 |
| 素材搜索/下载 | app/services/material.py:download_videos、search_videos_pexels/pixabay/coverr | 只复用协议和来源字段；下载结果走 V2 artifact gate |
| 本地图片缩放 | app/services/material.py:_render_openai_image_video | 仅作为“图片转轻动态”的参考，不能当作真实视频生成 |
| TTS | app/services/voice.py:tts | worker 返回真实音频和 cues；V2 决定字幕精度策略 |
| Whisper 字幕 | app/services/subtitle.py:create | 仅在本地模型已存在或有单独授权时使用；记录模型和下载状态 |
| 转场/画布 | app/services/video.py:_fit_clip_to_canvas、combine_videos、generate_video | 只移植经验证的局部函数；不能覆盖 V2 首尾帧与质量门 |
| BGM | app/services/bgm.py、app/services/sonilo.py、app/services/elevenlabs_music.py | 保持 V2 的后置顺序；AI BGM 仍属于付费/外部上传边界 |
| 任务 API | app/controllers/v1/video.py、app/controllers/v1/llm.py | 作为协议参考；不要把 MPT 全局 task/state 直接暴露为 V2 API |
| CLI | cli.py:parse_args/main | 可作为 worker 的参数/能力清单参考；禁止直接执行上游 CLI 作为本审计动作 |

不建议直接重用的模块：

- app/services/task.py：把 MPT 的顺序、配置快照、Redis/内存状态、跨发线程和所有 Provider 绑在一起，与 V2 agent-first/canonical artifact 管线不一致。
- webui/Main.py：Streamlit 页面状态、上传、配置持久化、预览和付费确认逻辑巨大；移植会重写 V2 UI。
- app/config/config.py：绑定 MPT 根目录和 config.toml，容易污染 V2 配置和凭据边界。
- resource/songs、resource/fonts 和 storage：属于上游运行时资源/用户数据，不应无审查复制到 V2。

## 与 V2 的功能保真限制

MPT 的目标是“主题/脚本到短视频”；它没有 V2 已约定的共享边界首尾帧图、镜头连续性图、事实来源锁定、素材哈希验收、镜头级质量分数或依赖感知修复。每个库存搜索词或远端文生视频任务可以独立返回片段，人物、光线、地理细节和动作连续性不由 MPT 保证。

其他需要保留的限制：

- 中文文旅素材的搜索词由 LLM 常规生成，默认是 1–3 词英文词项；可能丢失景区专名、非遗工艺和史实限定。V2 应在事实来源和人工确认后再发出搜索/生成请求。
- openai_image 只是图片加轻微缩放动画；它不满足真实视频运动、镜头首尾帧或连续动作要求。
- MPT 的 30 fps/MoviePy 输出、fit/crop/transition 与 V2 原生渲染器的编码、字幕、封面和质量证据可能不同；不要用 MPT 任务状态替换 V2 的本地渲染证据。
- Edge 失败会直接跳过字幕生成；非 Edge TTS 通常只有全文时间轴；Whisper 可能触发约 3 GB 模型下载。
- MPT 的默认 API 配置 listen_host=0.0.0.0、api_key 为空；若不改配置，worker/服务可能监听所有网卡且无 API 鉴权。V2 接入应默认为本机回环、随机/外部不可见端口或受控 IPC，并显式鉴权。
- Upload-Post、Sonilo、ElevenLabs Music 和 LoomLoom 都可能把本地成片或音频上传到外部服务；它们必须晚于旁白、时间线、视频质量复核，且要独立授权。
- MPT 的“成功”可以表示任务线程结束或远端返回了 URL；V2 仍必须检查本地文件、时长、尺寸、哈希、抽帧和解码。
- 上游配置中有保存 Key、上传音频、参考音频、cross-post 等功能；本报告没有复制任何配置或秘密，V2 也不能将这些配置文件写入日志。

## 本次验证和未解决阻塞

已执行的只读验证：

    git clone --depth 1 --branch main https://github.com/harry0703/MoneyPrinterTurbo.git /Users/mjd-ppps/生视频/MPT参考_20260920
    git -C /Users/mjd-ppps/生视频/MPT参考_20260920 status --short --branch
    git -C /Users/mjd-ppps/生视频/MPT参考_20260920 rev-parse --is-shallow-repository
    git -C /Users/mjd-ppps/生视频/MPT参考_20260920 log -1 --format='%H%n%aI%n%an%n%s'
    git -C /Users/mjd-ppps/生视频/MPT参考_20260920 diff --check
    rg/nl 静态检查 pyproject.toml、uv.lock、README.md、README-en.md、config.example.toml、.github/workflows/ci.yml、app/services、app/controllers、cli.py、webui/Main.py、docs/skill

验证结果：

- checkout 为 clean、浅克隆为 true，commit 与上表一致。
- git diff --check 无输出，未发现该 checkout 的空白错误。
- 只确认了源代码入口、配置字段、依赖和 CI 声明；没有声称上游在本机已运行。
- 没有安装 upstream dependencies、没有启动服务、没有执行视频/音频生成、没有调用付费 API，也没有做外部发布。

仍未解决的阻塞：

1. Provider 的当前价格、配额、区域可用性、模型名和服务条款随时间变化，需主代理在获得相应授权后逐项复核。
2. MPT 全量 worker 与 V2 的文件 manifest、字幕 cues、取消/重启、任务状态和付费确认协议尚未实现；本报告只给出边界和入口。
3. Python 3.13 只有上游 CI 静态证据，本机 MPT 独立环境尚未安装/运行；任何接入 PR 仍需在隔离环境中做 compileall、单元测试、FFmpeg 本地媒体测试和真实产物验收。
4. 不应把上游默认 BGM、未审查的第三方素材、任何实际 Key 或历史 config.toml 带入 V2。
