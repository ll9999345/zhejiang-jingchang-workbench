# Hypit 工作台续接与验收（2026-09-24）

> 后续状态（2026-09-24）：应用户要求，`/reference` 网页路由和工作台入口已移除。原页面与专用前端测试归档在 `docs/archived_reference_ui_20260924/`，便于保留尚未提交的唯一副本；参考视频、分析记录、`/model-api/reference/*` 与 Hypit CLI/API 保留。本文件以下内容是移除前的历史验收记录，不表示该页面目前仍可打开。

## 当前结论

工作台现能选择官方示例或本机 Hypit 工程，把 OpenMontage 作品另存为 Hypit 工程，调用固定版 Hypit 的 Check、Plan、Studio、Build、Inspect、Get 和其余原生命令。页面对外部服务执行范围设有预算确认，对本地 Build 则先要求同一工程和 Run 的官方 Plan 通过。**本轮官方本地示例已通过 CLI 和工作台 API 两条路径完成 Build，导出的 MP4 已完整解码。** Build 回执与真正生成的视频分别显示，失败不会被当成成片。

**尚不能宣称 Hypit 全功能在本机投入使用。** 官方 `/hypit` 的参考片复刻需要 AI 助手做语义理解和工程编写；目前工作台为选定参考片生成可复制的任务单，并提供原生执行界面，但没有在页面内嵌入 AI 助手。官方 WhisperX 语音对齐服务仍有下述 Intel Mac 依赖阻断；演示工程的本地渲染现已恢复，不等于用户参考片的一键复刻完成。

## 本轮改动与验证

- `/reference` 新增“选择参考视频 → 生成 Hypit 复刻任务单”的可见入口，任务单带当前项目、**明确选中的**片源、已有分析记录和创作要求。项目视频列表不再自动选择第一条，避免把无关素材误当参考片。任务单可复制，也会留在文本框中供手动复制。实际 Chrome 页面验证：初始片源为空且生成按钮禁用；打开选择区、选择视频后按钮启用、任务单出现且无页面脚本错误。
- 接受用户的流程纠正后，`/reference` 的首屏改为“直接导入下载好的参考视频”。未关联任何旧项目时，上传会先自动创建**独立复刻工作区**，再保存原片并自动启动本地镜头分析；已有文旅项目移至可选折叠区。官方示例和新建 Hypit 工程也可在未关联旧项目时起步。实际 Chrome 请求链验证：独立工作区创建 1 次、上传 1 次、分析 1 次，返回后片源选中、复刻任务单可用、无页面脚本错误。浏览器验收对上传回执做了模拟，未往用户项目写入测试视频；后端 TestClient 在临时目录验证了真实文件接收和隔离。
- 独立工作区的上下文现明确返回类型与标题，导入片会重新出现在片源列表；生成给 Codex 的任务单会写“独立复刻工作区”，不会虚构已有文旅脚本或把文件名当成新片主题。真实 Chrome 从无 `?project` 的入口加载，首屏可见上传卡、旧项目关联默认折叠，页面无脚本错误。运行中 4750 服务已重载，旧文旅项目上下文仍能读取。
- 另用 FFmpeg 在 `/private/tmp/hypit-reference-smoke-56qqx0q9` 生成 2 秒、20,467 字节的本机测试片，走真实 API 链：建立独立工作区、上传、从上下文找回原片、分析完成并提取 1 个镜头和 1 张关键帧。这个测试片未写入用户项目，也不是复刻成片。
- 页面只在官方 `hypit.cli-plan@1` 的预检、请求数量、Provider 解析、费用类别全部一致时启用 Build。后端 Build 仍会再次执行同一 Run 的官方 Plan；页面的可用状态不能绕过后端授权检查。
- 修复异步任务读取竞态：读取任务文件和判断运行线程是否存在现在持有同一把锁，防止真实完成结果被错写成“服务重启，任务已停止”。
- 后端从官方失败回执提取实际 Build 故障，`listen EPERM` 会明确提示本次未生成视频。
- 先前服务进程与其旧 Worker 的本地 Build 仍因 `listen EPERM` 失败；确认 Worker 没有活动 Build 后，使用官方 `runtime down` / `runtime up` 只重启演示 Worker，再对 `chat.svrun` 执行全本地 Plan。随后官方 CLI Build `bld_20260924T003217376Z_DD3DED5CBB` 与网页所用 API Build `bld_20260924T003554183Z_A2B7ADF13B` 均返回 `work.outcome=complete`、`result.state=complete`。API 的 Inspect→Get 将 `final.video` 导出为独立 MP4；FFprobe 读到 8 秒、540×960、H.264/AAC、240 帧，FFmpeg 完整解码返回 0；抽帧画面已检查。证据为 `artifacts/hypit_local_build_success_20260924.json`，可播放文件为 `projects/hypit-demo-semantic-composition-20260923-104253-8ff7ef3e/assets/exports/hypit-ui-20260924-0035.mp4`。这是官方示例，**不是用户参考片复刻成果**。
- 真实 Chrome 重新打开带该演示工程的 `/reference` 后，页面展示 1 张可播放、可下载的本地结果卡，无脚本报错；在 4 秒位置的页面截图保存于 `artifacts/hypit_browser_output_20260924.png`。
- 本轮回归：`node --test tests/backlot/*.test.cjs` 为 **35/35 通过**；`.venv/bin/python -m pytest -q web_api/tests/test_hypit_runtime.py web_api/tests/test_hypit_bridge.py web_api/tests/test_reference_adaptation.py` 为 **47/47 通过**；`git diff --check` 通过。浏览器实际操作验收了参考片显式选择和任务单显示。

## 真实运行边界

| 能力 | 当前证据 | 状态 |
| --- | --- | --- |
| 固定 Hypit 发行版 | `@hypit/hypit` 0.2.12，提交 `9c9918d0cedf2f06574ab0d517b1b6b0afb56a66`；`/model-api/hypit/status` 返回 ready | 已接通 |
| 官方本地示例 | `semantic-composition` 的 Doctor、Check、Plan 通过，3/3 请求是本地 Provider、0 外部请求 | 可本地构建 |
| 旧 Worker 的失败 | 2026-09-24 重启 4750 服务后，同一 `chat.svrun` 的 Build `bld_20260924T002446199Z_6EDE4E4256` 仍因 HyperFrames 子进程 `listen EPERM 127.0.0.1` 与 `pgrep` 权限故障失败，记录于 `artifacts/hypit_local_build_recheck_20260924.json` | 保留失败证据 |
| 官方 Worker 重启后的 Build | 官方 `runtime down/up` 后，CLI 和网页 API 两次 Build 均完整完成；API Inspect/Get 导出 `hypit-ui-20260924-0035.mp4`，FFprobe、完整解码和抽帧检查通过。详见 `artifacts/hypit_local_build_success_20260924.json` | 本地示例已产出视频 |
| WhisperX 中文词级对齐 | 在现有桥接项目运行官方 `programs prepare --endpoint whisperx.local --json`，安装立即失败：锁定的 `torch==2.8.0` 没有 macOS x86_64 wheel；当前主机为 Intel x86_64 | 本机官方受管服务不可用 |
| 官方参考片复刻 | 仓库官方 Skill 要求 AI 助手分析参考片并编写可编辑工程。工作台现在可生成含片源和目标的任务单，供 Codex 执行官方 Skill | 页面内一键 AI 复刻未实现 |
| 外部生成/发布 Provider | 需要各服务凭据、费用和执行范围；未做真实付费或上传验收 | 未验证 |

WhisperX 的受管安装日志位于用户级 Hypit 程序目录的 `whisperx-whisperx.local-127.0.0.1%3A8765/install.log`。当前桥接验收项目的模型缓存指向已连接的 `/Volumes/Untitled/OpenMontage/models/hypit-whisperx`；安装在下载模型前就因平台 wheel 缺失而停止，所以外置硬盘容量不是这次失败的原因。`programs status` 仍显示服务为 `down`。

旧的 2026-09-22 本地验收曾获得 8 秒、540×960、H.264/AAC 的视频，记录在 `docs/HYPIT_INTEGRATION_ACCEPTANCE_20260922.md`。本轮新导出文件与它的 SHA-256 一致，符合相同官方示例的确定性输出；本轮仍以新的 Build ID、Inspect/Get 和完整解码独立验收。此结果不证明参考视频语义复刻或 WhisperX 已可用。

## 后续验收条件

下一步需要用用户明确选定的参考片，由 AI 助手按官方 Skill 完成语义分析、目标创作与 SVML/SVS/SVRun 编写，再针对那条新工程执行 Plan、Build、Inspect/Get 和成片质检。官方 WhisperX 中文词级对齐需可运行其锁定依赖的环境；外部 Provider 需单独取得具体服务、预算及素材上传范围的授权。不能把演示示例、Plan 通过或 Build 回执当成用户复刻成片的质量验收。
