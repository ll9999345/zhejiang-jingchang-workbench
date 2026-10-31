# MoneyPrinterTurbo 与浙江文旅工作台的接入

更新：2026-09-30。原仓库固定在 `e0c9cb77ffd0226a789441420190f80a125c20c4`（1.3.7）。
`upstream/` 保留原源码与 MIT 许可证；`SOURCE.json` 保存逐文件校验值，适配层不修改上游文件。

## 使用入口

在模型工作台的“创意与脚本”“分镜”或“视频生成”阶段进入“真实素材自动成片”。
网址为 `http://127.0.0.1:4750/footage?project=你的项目编号`。

1. 自动承接已选创意、脚本和镜头。改脚本后点击“更新分镜”，不需要逐条填写搜索词。
2. “自动找素材”下载候选后供逐镜预览；“一键生成初剪”会继续完成选片、旁白、字幕和剪辑。
3. 本机视频、图片、旁白、音乐、SRT 可以直接导入。导入音频时标明音乐或旁白，随机配乐只选音乐。
4. 高级设置提供横/竖/方形、480/720/1080、裁切或保留、转场、字幕样式、音量、1–5 个版本。可以只完成素材、配音或字幕阶段；阶段产物不会显示成已完成视频。
5. 完成后播放成片、下载视频/SRT、查看来源许可和剪辑决策；刷新仅恢复回执，不重新提交。
6. “扩展 AI 服务”提供 MPT 的文本、语音、生成素材、配乐、高级剪辑、Whisper、语义分析和发布操作。未配置服务会显示所缺环境变量。
7. “高级设置 → 批量制作清单”支持 1–100 条 JSON/JSONL 请求，逐条预检后顺序执行、取消和恢复记录；清单变更必须重新检查，导入本身不提交。
8. “导入设置 JSON”识别上游 `moneyprinterturbo.settings-preset` / `version: 1`。可以等价表达的设置逐项映射，不能等价表达的参数会明确拒绝并说明；不导入凭据备份。

普通真实素材成片不依赖 ElevenLabs；本机配音、原稿字幕、本地配乐混音均可独立使用。
真实素材不足会明确列出缺口，不用 AI 图或无关视频冒充真实地点。

## 运行环境

- 主网页/API：项目 `.venv`，原生 `edge-tts==7.2.8`；保持现有工作台依赖。
- MPT 隔离进程：`.runtime/mpt-python`，Python 3.12，按 `upstream/requirements.txt` 安装，另装 `twelvelabs==1.3.4`。
- 带字幕渲染的 FFmpeg：隔离环境 `imageio-ffmpeg` 自带的 7.1 二进制。没有替换系统 FFmpeg。
- 本地识别模型：`.runtime/models/whisper-small`（优先）和 `whisper-base`（保留）。可用 `MPT_WHISPER_MODEL_PATH` 指向另一个已安装的同格式模型；运行时不会自动下载。
- 依赖快照：`runtime-requirements-20260921.txt`；模型来源记录：`model-sources-20260921.json`。

启动仍用现有脚本：

```sh
HOST=127.0.0.1 PORT=4750 sh scripts/serve_model_adapter.sh
```

不直接启动上游 Streamlit/API/CLI，以免共享全局配置、自动发布或跳过现有项目确认。

## 扩展服务配置与验证边界

密钥只读取服务进程已有的环境变量，不进入页面输入、项目文件、导出设置或日志。
没有替用户新建任何云账号，也没有复制既有密钥。已有 V2 模型入口继续使用自己的配置；MPT 隔离扩展使用明确的 `MPT_` 配置。

`MPT_<字段名>` 对应上游 `config.app`；`MPT_<章节>__<字段名>` 对应其他章节。
例如 `MPT_OPENAI_API_KEY`、`MPT_OPENAI_MODEL_NAME`、`MPT_OPENAI_BASE_URL`，
以及 `MPT_AZURE__SPEECH_KEY`、`MPT_AZURE__SPEECH_REGION`、`MPT_KOKORO__BASE_URL`。
具体缺项以 `/model-api/footage/extensions/catalog` 为准，该接口不返回密钥值。

- 文本适配器读取上游 27 项 LLM 注册表；语音接入 11 个路由；视频接入 5 个直接服务及 LoomLoom。
- 本地高级剪辑、Whisper 已实测；第三方适配器做了真实上游函数签名的模拟测试，没有付费实测。
- 预检只检查本机配置、输入和确认，不发送模型请求。配置存在不等于账号有权限或网络可达。
- 执行外部服务前明确服务、预算、网络传输、所选文件上传；发布单独确认账号与平台。
- 预算不是第三方账单的技术上限；使用者须在服务商设置支出限制。已限制适配器中确认过的付费请求重试，但第三方内部处理与账单仍由服务商控制。
- 停止本机任务不等于撤销已受理的远端任务；刷新或重启不会自动重试付费请求。
- 发布的 `accepted` 只表示受理；使用“查询发布结果”查回执，不能把受理当作平台已发布。
- 非 Edge 配音服务不保证逐词时间戳；可使用本机 Whisper 再转录。识别地名可能有同音错字，页面支持原稿对照，不能自动视为质检通过。
- 配音提供本地静态音色目录及自定义 ID。服务不支持语速时禁用该选项；音量以本机增益实现，保留服务返回的原音频。
- 音乐扩展使用视频实际时长；不再用表单默认的 5 秒代替。静态字幕按旁白分段实测时长或上传音频比例安排，后者不是语音强制对齐。
- 高级剪辑保留句级/逐词 SRT 实际时间轴，支持字体、描边、圆角、位置、弹性出现和音量；勾选逐词不会把句级 SRT 伪造成真正词级识别。
- 非公开发布仅支持 YouTube；其他平台必须明确选公开，不会把私密选项静默改成公开。

## API / 命令行 / 导演工具

API 前缀 `/model-api/footage`：`context/{project}`、`plan`、`draft`、`jobs`、`jobs/{id}`、
`jobs/{id}/cancel`、`settings/{project}`、`upload`、`assets/{project}`。
扩展前缀 `/extensions`：`catalog`、`preflight`、`jobs`、`jobs/{id}`、`jobs/{id}/cancel`。
批次前缀 `/batches`：`preflight`、创建批次、查询批次/列表、`{id}/cancel`。批次记录属于第一条任务的项目，每条任务保持自己的项目编号。
写操作共用同源检查，文件必须属于当前项目，设置拒收密钥字段。

```sh
.venv/bin/python scripts/footage_workbench.py plan --request request.json
.venv/bin/python scripts/footage_workbench.py run --request request.json --wait
.venv/bin/python scripts/footage_workbench.py run --request request.json --stop-at subtitle --wait
.venv/bin/python scripts/footage_workbench.py batch --file requests.jsonl --wait
.venv/bin/python scripts/footage_workbench.py list --project PROJECT_ID
```

请求例（预览规划不联网；`confirm_network` 只在明确执行公开检索时设置）：

```json
{"project_id":"PROJECT_ID","topic":"三清山","script":"三清山的峰林，在云雾中展开。","action":"collect","sources":["wikimedia"],"confirm_network":true,"options":{"narration":"local","voice":"Tingting","resolution":720}}
```

`footage_auto_edit` 已注册为导演工具，默认只返回规划，显式 `execute=true` 才执行。
长批次使用 `--wait` 顺序运行，不把 100 个任务同时塞入本机队列。

本轮与 OpenMontage 的完整对照、已补内容和未完成边界见 `docs/FEATURE_PARITY_20260930.md`；不能把已安装的源码、接口模拟通过或账号配置存在当作全部云服务实测完成。

## 文件与许可

草稿单独存于 `artifacts/footage_draft.json`，不会修改 canonical `script.json`；主方案变化使旧草稿失效。
每次执行写唯一的 `footage-…` / `mpt-…` 目录，保留已有素材、旧成片和失败证据。
结果保存实际时长、宽高、哈希、来源与许可。中间渲染文件保留但不混入素材选择器。
没有复制上游默认歌曲和字体；有 MIT 源码许可不代表外部素材可以随意商用。
禁止改编许可不会参与自动选片；地理文字匹配标为“地点检索候选（待核验）”。
