# 本机扩展运行时安装记录（2026-09-14）

本轮是在已有工作树上继续安装，保留所有原有未提交修改。没有格式化、清理或迁移移动硬盘的 Windows 虚拟机备份，没有调用付费生成服务。

## 存储与生效方式

- 外置盘：`/Volumes/Untitled`，1 TB、ExFAT；专用目录 `/Volumes/Untitled/OpenMontage`。
- 模型、安装包、验证输出放专用目录。程序与 Python 环境放项目 `.runtime/`，避免 ExFAT 不支持硬链接造成安装失败。
- `.runtime/local-env.sh` 保存本机路径，不含凭据，已被 `.gitignore` 排除。
- `scripts/serve_model_adapter.sh` 会加载该配置。已运行的旧服务不会自动继承新环境，需要重新启动进程；不会修改用户已有密钥配置。
- 使用外置 Piper 模型时需保持硬盘连接及卷名不变；路径失效会明确报错。

## 已完成的实际验证

| 组件 | 位置或版本 | 本次证据 | 范围限制 |
|---|---|---|---|
| Piper 中文及英文模型 | 外置 `models/piper/`；Piper 1.7.0 | 实际生成 3.077 秒中文 WAV 和 2.752 秒英文 WAV；FFprobe 可解码；模型 SHA-256 与发布源一致 | 未做人工听感验收；中文模型卡的数据集许可证为 Unknown，不能据此宣称商用授权已解决 |
| HyperFrames | 项目 `.runtime/hyperframes/`，固定 0.8.33 | 核心运行检查可用；官方 blank 工程通过 lint/check，导出 1920×1080、10 秒、10 帧 H.264 MP4 | 这是空白工程的安装冒烟测试，不是成片质量验收；WebGL 检查失败；Docker/Kokoro/MusicGen 等可选组件仍缺失 |
| Blender | `.runtime/blender-4.5.9/Blender.app`，4.5.9 LTS Intel | 官方安装包 SHA-256 一致，`--version` 成功，Cycles CPU 渲染 320×180 立方体 PNG 成功并已查看 | 未验证 GPU 渲染及所有 Blender 工具流程 |
| Manim | `.runtime/manim-venv/`，0.21.0，独立 Python 3.13 | pycairo 1.29.1 编译成功；启动和 pip check 通过；CLI 与 `math_animate.execute` 均导出中文文字和图形动画，854×480、15 fps；已查看抽帧 | 未安装或验证 LaTeX 公式渲染；通过 `.runtime/bin/manim` 接入，主 `.venv` 不变 |
| MediaPipe | `.runtime/mediapipe-venv/`，0.10.21，独立 Python 3.12.13；OpenCV 4.11.0、NumPy 1.26.4 | 已成功导入并执行 FaceDetection 空帧推理 | wheel 文件名标记 macOS 11，内部元数据标记 macOS 14，因此在本机 macOS 13.7.8 上 `pip check` 报平台不支持；没有篡改元数据或把该检查当作通过 |
| rembg 本地抠图 | 主 `.venv` 安装 2.0.69；U2Net 模型放外置 `models/rembg/` | 175997641 bytes 模型与库内置 MD5 `60024c5c889badc19c04ad937298a77b` 一致；`BgRemove.execute` 成功输出 320×180 RGBA PNG，alpha 范围 0–255，已查看输出 | 使用 Blender 测试立方体验证，不代表复杂人物发丝等素材均达标；保持现有 NumPy 2.2.6/OpenCV 4.12，不升级到冲突版本 |
| faster-whisper | 现有 `.venv/`，本机已缓存 base 模型 | 禁用网络后成功转录上述中文 WAV，生成逐词时间戳 | “浙江文旅”等出现错字，不能把运行成功当成字幕准确性达标 |

HyperFrames 的 npx 临时缓存路径在本轮发生失效，因此改为项目内固定安装，并通过 `HYPERFRAMES_CLI` 接入工具，避免重复访问 npm 才能检查可用性。测试工程的 GSAP 脚本改为本地副本，避免 CDN 导致浏览器加载超时。

进一步直接调用 `HyperFramesCompose.execute(operation="render_existing")`，质量检查与完整渲染均成功，输出 `hyperframes-tool.mp4`：1920×1080、24 fps、240 帧、10 秒 H.264。原 index.html 摘要保持不变。该测试仍使用空白工程，只验证安装和工具调用链路。

Piper 支持 `model`、管线传入的 `model_id`、`PIPER_MODEL` 默认配置，并返回实际使用的模型路径。`PIPER_MODEL_DIR` 将模型名称解析到外置盘文件，支持直接选择 `en_US-lessac-medium` 等名称。现有网页默认旁白提供商未被更换。

MediaPipe 安装包的平台标记问题与上游 [issue #6112](https://github.com/google-ai-edge/mediapipe/issues/6112) 一致；另下载核对的 0.10.18 内部标签也为 macOS 14，因此没有盲目降级。实际运行验证与安装元数据告警分开保留。ManimPango 的预编译包在本机实际可运行，本轮没有安装系统 Pango/Homebrew 软件。

通过 `OPENMONTAGE_MEDIAPIPE_PYTHON` 和白名单 JSON 子进程桥接，原 Python 3.13 工作台可调用独立环境中的 `face_tracker`、`auto_reframe`、`eye_enhance`。健康检查成功结果仅缓存 15 秒，解释器路径变化会重新检查；执行超时、非法响应和缺失环境均返回失败。不会通过请求动态导入任意模块，不输出子进程原始日志。

三工具实测使用无脸的 Manim 测试视频：人脸检测采样 4 帧、检测 0 张脸，method=`mediapipe`；重构图正确回退 center_crop，输出 270×480；眼部处理 method=`mediapipe_face_mesh`，处理 22 帧、增强 0 帧，输出 854×480。两段输出均为 22 帧 H.264、1.467 秒。详见外置验证目录的 `mediapipe-results.json`。这不构成真人追踪或眼部增强精度验收。

## 校验值与来源

- Blender：`https://download.blender.org/release/Blender4.5/blender-4.5.9-macos-x64.dmg`，335828094 bytes，SHA-256 `00c8a433504291374bfa045c0c2d708a779f8abc8400b4718fdd11c117486fa4`；校验清单同目录 `blender-4.5.9.sha256`。
- Piper：发布源 `https://huggingface.co/rhasspy/piper-voices`；各模型 JSON 和 MODEL_CARD 随模型保留。
- `zh_CN-huayan-medium.onnx`：`9929917bf8cabb26fd528ea44d3a6699c11e87317a14765312420be230be0f3d`。
- `en_US-lessac-medium.onnx`：`5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f`。
- npm 固定依赖及完整性信息：`.runtime/hyperframes/package-lock.json`。

## 验证输出

位于 `/Volumes/Untitled/OpenMontage/verification-20260914/`：`piper-zh.wav`、`piper-en.wav`、`transcript/`、`hyperframes-blank-smoke.mp4`、`blender-cpu.png`。

## 验收边界

安装运行时不会自动实现代码中仍缺失的功能，也不会替用户开通云端账户、提供 API 密钥或提高显卡能力。“已有代码”“依赖安装”“工具状态可用”“实际生成”“成片质量通过”分别记录，不互相替代。

本轮仍未安装的本地组件包括：PyTorch/Transformers、GFPGAN/Real-ESRGAN、ComfyUI、Stable Diffusion、MuseTalk/TalkingHead、CogVideo/Hunyuan/LTX/Wan 等模型栈。不能仅因为外置盘空间够就宣称它们在这台 Intel Mac 上已经可运行；其中部分可研究 CPU 方案，部分依赖更强 GPU 或外部运行服务。`music_library` 还没有曲库资源，`corpus_builder` 缺少语义模型时为 degraded。云端提供商仍受各自账户配置和付费授权约束。

本轮回归测试：本机路径与 Manim 安全检查合计 27 passed；HyperFrames 与网页音频管线检查 51 passed；隔离运行时桥接检查 14 passed，共 92 个不同测试通过。最后的语音名称映射修改后，本机路径及音频相关 12 项再次通过。主 `.venv` 和独立 Manim 环境 `pip check` 通过，MediaPipe 独立环境保留上述平台标记告警。

更新后的本地服务在 `http://127.0.0.1:4751/` 运行，原 4750 服务未停止。新服务的首页、音频 health、pipeline catalog 均 HTTP 200。完整目录状态快照见 [runtime-capabilities-20260914.json](runtime-capabilities-20260914.json)，只记录工具名、提供商和状态，不包含密钥。

目录统计：119 个具体工具中，49 available、1 degraded、69 unavailable。这是状态检查，不表示 49 项都完成了全流程实测。外置盘只新增 OpenMontage 专用目录；原有项目和生产产物没有自动迁移，生产输出目录也没有被全局改写。本轮外置内容主要为模型、下载包和验证产物。
