# 第三方项目与许可证

## MoneyPrinterTurbo

- 项目： [harry0703/MoneyPrinterTurbo](https://github.com/harry0703/MoneyPrinterTurbo)
- 许可证： MIT（见其 [LICENSE](https://github.com/harry0703/MoneyPrinterTurbo/blob/main/LICENSE)）
- 本项目使用方式：早期只参考阶段化任务机制。2026-09-20 接入固定版本的隔离能力后端，并以原生页面实现真实素材自动成片。
- 固定版本：`e0c9cb77ffd0226a789441420190f80a125c20c4`（上游 1.3.7）。
- 源码位于 `integrations/moneyprinterturbo/upstream/`；完整 MIT 原文保留在其 `LICENSE` 中，逐文件 SHA-256 位于 `integrations/moneyprinterturbo/SOURCE.json`。上游源文件不直接改写，接入代码置于父目录。
- 没有随本系统复制上游默认音乐、字体、用户存储或含密钥的配置；源码 MIT 许可不代表任何音乐或素材可自由商用。
- 隔离运行环境：`.runtime/mpt-python`，避免替换 V2 的 FastAPI、MoviePy、语音等既有依赖。新增原生在线配音依赖 `edge-tts==7.2.8` 安装于项目 `.venv`。
- 适配记录：见 [`MONEY_PRINTER_TURBO_ADAPTATION.md`](./MONEY_PRINTER_TURBO_ADAPTATION.md)，更新日期 2026-09-21。

分发时必须一并保留上游 MIT 版权与许可文本，并遵守各依赖和素材的独立许可。

## 本地语音识别模型

- 下载来源：[Systran/faster-whisper-base](https://huggingface.co/Systran/faster-whisper-base) 与 [Systran/faster-whisper-small](https://huggingface.co/Systran/faster-whisper-small)，对应 OpenAI Whisper 的 CTranslate2 转换权重，模型页标明 MIT。
- 安装于项目 `.runtime/models/whisper-base`、`.runtime/models/whisper-small`。主页面默认 small，也可明确选择 base；按所选模型加载，缺少时失败，不再静默改为另一个模型。加载设置为 `local_files_only=True`，识别时不上传音频。
- 本机识别仍会误识别同音地名；参考原稿只用于对照，不冒充自动识别结果。

## 中文精细字幕定位与动态字幕运行时（2026-10-01）

- [WhisperX](https://github.com/m-bain/whisperX/tree/771b4a14a9486f8fd5aef18ef49e35d639523dd3) 固定 revision `771b4a14a9486f8fd5aef18ef49e35d639523dd3`，原 **BSD-2-Clause** 许可和选定的原始对齐模块位于 `.runtime/vendor/WhisperX-771b4a14a9486f8fd5aef18ef49e35d639523dd3`。本轮不是完整 WhisperX / pyannote 说话人分离安装；来源和摘要见 `20261001T101042Z-alignment-sources-7a3a96db.json`。
- 中文 CTC 模型为 [jonatasgrosman/wav2vec2-large-xlsr-53-chinese-zh-cn](https://huggingface.co/jonatasgrosman/wav2vec2-large-xlsr-53-chinese-zh-cn/tree/99ccb2737be22b8bb50dcfcc39ad4d567fb90cfd)，固定上述 revision，原模型卡标明 **Apache-2.0** 并保留在 `.runtime/models/whisperx-align-zh-20261001/README.md`。原 `pytorch_model.bin` 核对发布方 LFS 摘要 `de031fd4b29e0c0667e5346450fadfe1326c89936b888b59c4ede608db763ee4`；经 `weights_only=True` 受限读取另存 safetensors，原文件保留。安装回执为 `20261001T101531Z-alignment-models-e31feb62.json`。不加载远端代码、不运行时下载，不把模型分数当作字幕正确率。
- 新增 Torchaudio 2.2.2（原安装许可 **BSD-2-Clause**）、pandas 2.2.3（**BSD-3-Clause**）与 NLTK 3.9.1（代码 **Apache-2.0**）于现有 `.runtime/montage-ml`。Torch 2.2.2、NumPy 1.26.4、Transformers 4.44.2 保留；支持依赖和精确版本见 `.runtime/installation-receipts/alignment-dependencies-20261001T120901Z-369c41d1.json`，原包许可保留。
- Punkt 分句数据来自 [nltk/nltk_data](https://github.com/nltk/nltk_data/tree/550b6625bcef1f2abff2ff770a5a0d272c9c6b2a)，固定 revision `550b6625bcef1f2abff2ff770a5a0d272c9c6b2a`。所需英语表安装于 `.runtime/nltk_data/tokenizers/punkt_tab/english`；原 README 和下载 ZIP 都保留，回执为 `20261001T101401Z-alignment-tokenizer-427d14ea.json`。训练数据说明与代码许可分别保留，不将全部语料笼统描述为 NLTK 代码的 Apache-2.0 许可。
- [Remotion](https://github.com/remotion-dev/remotion/tree/v4.0.330) 字幕兼容运行时固定 **4.0.330**，安装于 `.runtime/remotion-caption-4.0.330`，配套 React 18.3.1（MIT）。Remotion 使用发行包保留的 **Remotion 自定义许可**，不是 MIT；分发和商业使用须遵守原许可。安装回执 `20261001T105548Z-caption-runtime-2efbe9f5.json` 保存版本与原许可位置。原 `remotion-composer` 4.0.484 依赖未替换；输出任务保留本项目 TSX 副本、来源摘要和 runtime 记录，本机没有借用其他项目或安装系统浏览器。

上述回执均在项目 `.runtime/installation-receipts/`。字级时间定位不等于自动识别正确、说话人分离、翻译或任意文字均支持。

## 本机语义素材与角色动画运行时（2026-10-01）

- CLIP 模型来源：[openai/clip-vit-base-patch32](https://huggingface.co/openai/clip-vit-base-patch32)，固定版本 `bf8895cff1da285aa497db31204d14464adcaa7c`。本机使用 safetensors，不加载 Torch pickle，不设置 `trust_remote_code`。安装在 `.runtime/models/clip-vit-base-patch32-20261001`；逐文件来源、大小与 SHA-256 保留在 `INSTALLATION.json`。模型与代码遵守各自原始许可，不意味着检索到的素材已获使用许可。
- CPU 推理隔离环境：`.runtime/montage-ml`，Python 3.12、Torch 2.2.2、NumPy 1.26.4、Transformers 4.44.2、Pillow 12.3.0。没有替换主项目 Python 或安装系统驱动，各包的许可证保留在原安装目录。
- [GSAP](https://github.com/greensock/GSAP) 3.12.5 安装于 `.runtime/montage-render/node_modules/gsap`。仅使用本地核心发行包，保留发行包的版权头；其该版本 `package.json` 标明 Standard no-charge license，**不描述为 MIT**。角色导出不再向 CDN 请求脚本。
- Playwright 1.51.0 安装于项目 `.venv`；使用已安装的 Google Chrome，没有自动下载/替换浏览器。角色动画输出 SVG/GSAP 工程与逐帧编码 MP4；工程下载不在工作台同源页面执行。

## 本机画质修复与视觉模型（2026-10-01）

- [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) 0.3.0（BSD-3-Clause）、[GFPGAN](https://github.com/TencentARC/GFPGAN) 1.3.8（Apache-2.0）及 facexlib 0.3.0 安装在原 `.runtime/montage-ml`。推理读取 `.runtime/models/restoration-20261001`，禁止运行时下载。四种超分模型、GFPGAN、人脸检测/解析权重分别记录实际来源，不把代码许可扩大解释为任意第三方素材许可。
- [BasicSR](https://github.com/XPixelGroup/BasicSR/tree/8d56e3a045f9fb3e1d8872f92ee4a4f07f886b0a) 固定源码 `8d56e3a045f9fb3e1d8872f92ee4a4f07f886b0a`，原 `LICENSE.txt` 为 Apache-2.0；原始目录保留在 `.runtime/vendor/BasicSR-…`。使用已兼容 Torchvision 的官方源码，不覆盖已有 Torch/NumPy/Transformers。
- [CodeFormer](https://github.com/sczhou/CodeFormer/tree/b33cc7d639d6545bfcccc7e0bc6ae51f24e79c2b) 固定 `b33cc7d639d6545bfcccc7e0bc6ae51f24e79c2b`，原架构源码与完整 **S-Lab License 1.0** 在 `.runtime/vendor/codeformer`。该许可限定非商业用途；商业用途需按原文联系作者，不能描述为 MIT 或无限制商用。工具默认 GFPGAN，CodeFormer 为明确选择的独立模型，没有将其冒充另一架构。
- BLIP 来源为官方 [Salesforce/blip-image-captioning-base](https://huggingface.co/Salesforce/blip-image-captioning-base/tree/82a37760796d32b1411fe092ab5d4e227313294b) 和 [Salesforce/blip-vqa-base](https://huggingface.co/Salesforce/blip-vqa-base/tree/787b3d35d57e49572baabd22884b3d5a05acf072)，分别固定上述版本；原模型卡标明 BSD-3-Clause，卡片保存在各模型目录。Caption 原始张量经受限加载后另存 safetensors，保留原文件；VQA 使用发布方 safetensors。不是 BLIP-2/LLaVA，也不冒称中文大型视觉模型。
- 公开下载记录在 `.runtime/installation-receipts/20261001T072949Z-sources-93a4d72c.json`、`20261001T073745Z-vision-4543e499.json`、`20261001T074253Z-restoration-482c2f19.json`。GitHub 文件摘要是本机记录，HF LFS 摘要与发布方核对；两类验证不混称签名。实际包版本见同目录 `local-models-dependencies-20261001.json`。
- `local_music` 为本项目的确定性合成器作曲程序，未复制第三方歌曲、录音或训练权重；配乐是预设器乐草稿，不是训练过的 AI 作曲模型。本轮没有注册或调用 ElevenLabs。

## 参考视频改编所依据的公开项目

- [OpenMontage](https://github.com/calesthio/OpenMontage)：借鉴项目、工件和本地工作台的组织方式；未复制其以外的第三方实现。
- [Hypit](https://github.com/hypit-ai/hypit/tree/9c9918d0cedf2f06574ab0d517b1b6b0afb56a66)：固定上游提交 `9c9918d0cedf2f06574ab0d517b1b6b0afb56a66`，本地保留源码、Distribution 和验收产物；借鉴参考证据、目标方向、实际语音时间分离的理念。完整许可文本保留在 `artifacts/reference_research_20260921/hypit-LICENSE.txt`。其许可为带附加条件的 Apache 2.0 修改版，不应描述为 MIT 或无限制商用许可。
- [PySceneDetect](https://github.com/Breakthrough/PySceneDetect)：参考镜头边界检测能力；本项目通过现有 `tools/analysis/scene_detect.py` 使用本地检测工具，并保留 FFmpeg 回退路径。

详细的借鉴分工、用户流程、接入证据和未完成边界见 [`REFERENCE_ADAPTATION_20260921.md`](./REFERENCE_ADAPTATION_20260921.md) 与 [`HYPIT_INTEGRATION_ACCEPTANCE_20260922.md`](./HYPIT_INTEGRATION_ACCEPTANCE_20260922.md)。以上记录不表示外部模型账号、额度、Provider 或发布权限已经开通。

## 工作台界面与动效（2026-09-29）

- [Motion](https://github.com/motiondivision/motion) 12.23.24：直接使用其 MIT 许可的 JavaScript 浏览器发行包；文件为 `backlot/ui/vendor/motion-12.23.24.js`，版权与完整许可为同目录的 `motion-LICENSE.md`。分发时一并保留。
- [cmdk](https://github.com/dip/cmdk)：参考可搜索命令面板的交互组织；本项目以原生 DOM 实现，没有复制/安装其 React 组件运行时。
- [apple-design](https://github.com/emilkowalski/skills/tree/main/skills/apple-design) 与 [UI UX Pro Max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill)：作为本轮设计研究资料使用；研究来源、版本和适配范围见 [`ui-redesign-20260929/DESIGN.md`](./ui-redesign-20260929/DESIGN.md)。


## 2026-10-19 HyperFrames模板的本机动画脚本

自动生成的HyperFrames新工程复用此前安装的GSAP 3.12.5本机发行文件（`.runtime/montage-render/node_modules/gsap/dist/gsap.min.js`），逐字节复制到带SHA-256的工程内文件，保留原版权与许可头；没有复制在线CDN的3.14.2，也没有新增安装。上述GSAP原许可口径保持；该脚本与HyperFrames CLI、OpenMontage自身许可证分别处理。原旧HTML不自动改写，完整实现/验证见[本轮记录](defense-evidence/records/2026-10-19-integration-hyperframes/README.md)。
