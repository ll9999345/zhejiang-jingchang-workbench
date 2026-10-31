# OpenMontage 完整安装与验收记录

> 历史快照：本文记录 2026-08-28 的检查，并不表示所有可选工具和云端服务已经实测可用。2026-09-14 移动硬盘接入后的实际安装、验证与限制见 [LOCAL_RUNTIME_INSTALL_20260914.md](LOCAL_RUNTIME_INSTALL_20260914.md)。

> 2026-10-01 最新接入与实际证据见 [OPENMONTAGE_WEB_COMPLETION_20261001.md](OPENMONTAGE_WEB_COMPLETION_20261001.md)：128 项网页工具、实际超分/人脸修复/BLIP、免费器乐合成、中文精细字幕对齐与逐字高亮 MP4；后期页整理为文案/视频/音频/字幕。当前依赖快照 61 可用、3 降级、64 未配置，不是全部生产验收。71 项后端及 76 项前端回归通过；通用 AI 导演和云账号生产验收仍待模型与预算。下文保持历史记录，不当作当前运行状态。

> 当前独立 ML 环境的 pip check 仍有 BasicSR / GFPGAN 的两条 tb-nightly 训练依赖元数据提示；已有稳定版 TensorBoard 2.21.0 与 Torch 日志组件实际可导入，未以 nightly 覆盖它。真实推理验收与这两条提示分别记录，不能沿用下文历史的“pip check 通过”描述当前 ML 环境。

更新时间：2026-08-28

## 结论

OpenMontage 官方 `make setup` 已在本机成功完成。当前工作区保留 OpenMontage 上游基线，并叠加浙江文旅工作台适配层；没有用低配模型替换上游模型，也没有用演示数据冒充真实生成。

## 已安装并验证

- Python 3.13.14 项目虚拟环境：`.venv/`
- Remotion Composer 依赖：已安装
- Piper 本地 TTS：已安装
- HyperFrames 运行时：0.8.17，缓存与 doctor 检查通过
- FFmpeg/FFprobe：9.0.1
- OpenCV：4.12.0.88 官方二进制轮子
- 素材/转录辅助组件：`faster-whisper`、PySceneDetect、`pydub`（含 Python 3.13 `audioop-lts` 兼容层）、BeautifulSoup、`yt-dlp`、YouTube Transcript API
- `pip check`：通过
- 回归测试：1865 passed、9 skipped、3 xfailed
- Backlot、同源模型调用器、媒体管线与 OpenMontage 工具目录：HTTP 验证通过

OpenCV 使用 4.12 的原因是当前 Intel macOS 与 FFmpeg 9 的兼容性：源码构建会失败，官方预编译轮子可以正常安装。这是运行时兼容修复，不是视频/图片模型降级。

## 当前可用能力

- Ark/Seedance：模型调用器可发现并使用本机已有的 `ARK_API_KEY`（密钥只留在服务端/钥匙串，不写入网页）。实际生成仍遵守费用确认门槛。
- 图片生成：`doubao_seedream_image` 已被调用器识别为可用。
- 视频生成：`seedance_ark` 已被调用器识别为可用。
- 本地旁白：macOS `say` 与 Piper 已可用。
- 字幕、抽帧、场景检测、视频拼接、剪辑后处理、音频混音、质量检查、导出包：本机可用。
- 本地视频分析/转录：FFmpeg、PySceneDetect、faster-whisper 与 URL/字幕解析组件已安装；首次使用 faster-whisper 模型时仍会按所选模型下载权重。
- Remotion 与 HyperFrames：工具目录已识别为可用的组合运行时。

## 仍需外部配置的项目

“完整安装”表示代码、依赖和运行时已安装；云端服务是否能实际扣费生成，还取决于账户授权、余额和模型开通状态。当前调用器不会伪造成功：

- Doubao TTS：本机未检测到 `DOUBAO_SPEECH_API_KEY`，因此使用本地旁白回退。
- ElevenLabs Music：本机未检测到 `ELEVENLABS_API_KEY`，BGM 仍按后置阶段等待授权。
- 其他云端图片/视频提供商：没有相应密钥时保持“不可用”并显示配置说明。
- HyperFrames doctor 仍会提示 whisper-cpp、Kokoro、MusicGen、Docker 等可选项缺失；它们不是官方 `make setup` 的核心依赖，其中部分需要模型权重、较大磁盘空间或 GPU。当前 Intel Mac 上不预装这些重型可选运行时，以免下载后仍无法运行；轻量的 faster-whisper/解析组件已补齐。

## 启动方式

```bash
./scripts/serve_model_adapter.sh
```

脚本现在优先使用 `.venv/bin/python`，并把该环境的可执行目录加入 `PATH`，所以 Piper 等依赖不会被旧的 `.venv-backlot` 环境悄悄遮蔽。网页地址：`http://127.0.0.1:4750/`。

## 安全边界

模型密钥只从本机环境或 macOS Keychain 读取，绝不返回给浏览器、HTML、日志或命令行。付费生成必须经过显式确认；预估、能力检查和回归测试不会产生模型费用。
