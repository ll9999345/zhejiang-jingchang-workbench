# Hypit 接入验收记录（2026-09-22）

## 结论

固定提交 `9c9918d0cedf2f06574ab0d517b1b6b0afb56a66` 的 Hypit 上游 Distribution 已在本机安装并完成一次本地 Runtime/Build/视频导出验收。当前可以确认的是：官方上游包、编译/分发检查、Runtime doctor 和一个本地 8 秒视频结果已经有证据；不能据此宣称所有 Studio 功能、Provider、远程模型、平台抓取或发布能力都已一比一完成。

官方包信息：`@hypit/hypit@0.2.12`，`pnpm@10.33.0`，上游工作区 `node_modules` 实测约 581 MB。`pnpm-workspace.yaml` 为允许原生依赖构建增加了三个明确的 `allowBuilds` 项：`esbuild`、`koffi`、`puppeteer`。这三项配置变化属于当前固定上游工作区的构建准备，不能省略为“零修改官方包”。

## 已完成的本机证据

| 验收项 | 结果 | 证据或边界 |
| --- | --- | --- |
| 固定源码 | 通过 | 上游 Git HEAD 为 `9c9918d0cedf2f06574ab0d517b1b6b0afb56a66` |
| 依赖安装 | 通过 | `integrations/hypit/upstream/node_modules` 约 581 MB |
| 上游检查、类型构建、分发打包 | 通过 | 已生成 `dist/release/hypit-hypit-0.2.12.tgz`，大小约 2.6 MB，SHA-256 为 `05552c666132424d3d3459bbea9cfaf752449636625aa5b9994786cf677345fc` |
| 完整测试（首次沙箱） | 部分通过 | 1029 pass、15 fail、22 skip；失败不能抹掉 |
| 完整测试（非沙箱） | 部分通过 | 1045 pass、1 个 timing fail、22 skip；唯一 timing 测试单独复跑为 1/1 pass |
| 分发首次准备 | 未通过 | DNS 失败；官方 Chrome 152 压缩包损坏 |
| 分发浏览器准备 | 通过 | 改用用户已有 Chrome 153 后继续完成；不把失败下载写成成功 |
| Runtime doctor | 通过 | 选定 Runtime/Endpoint 的本机诊断完成 |
| 本地 Build | 通过 | Build `bld_20260921T232455405Z_11878AB50` 状态为 `complete` |
| 导出媒体 | 通过 | `chat.mp4`，H.264、540×960、30 fps、240 帧、8 秒，AAC 48 kHz 双声道 |
| 媒体完整解码 | 通过 | `ffprobe` 识别两条完整音视频流；`ffmpeg -v error -i ... -f null -` 无错误退出 |

导出视频的本地副本和机器可读证据在 [`../artifacts/hypit_acceptance_20260922/`](../artifacts/hypit_acceptance_20260922/)：`chat.mp4` 的 SHA-256 为 `d5448e58a4d5452d0a9e6012dd4bccd0396c2ad3d957d85d76bfd1de8801c0fb`，完整媒体字段见 `manifest.json`。源临时文件仍保留，复制过程没有删除任何文件。

## 测试如何解读

沙箱首次完整测试出现 15 个失败，非沙箱复跑收敛到 1 个 timing 失败；该 timing 用例单独复跑通过。这里保留每个阶段的原始结果，不把单测复跑通过改写成整套测试全绿。后续应由主验收记录对应日志路径、失败用例和环境差异，再决定是否修复或重新跑完整回归。

## 运行时和用户级缓存

一次手动重试在用户目录 `~/Library/Application Support/Hypit/packages` 写入了 7 个用户级机器包：`cjs-module-lexer`、`tsx`、`typescript`、`koffi`、`@hyperframes/producer`、`@hyperframes/engine`、`@puppeteer/browsers`。该目录实测约 285 MB；它们不是系统级安装，本轮没有删除，后续主工作台可复用，并应在设置页显示实际位置和可复用状态。

这项缓存记录不等于所有 Runtime Program 已准备完成。Chrome 153 是用户已有浏览器；官方 Chrome 152 下载曾因 DNS 和压缩包损坏失败。浏览器版本、下载来源、Runtime Profile 和本地程序状态需要继续按当前机器状态检查。

## 本地功能与远程能力分层

本轮本地已验证的范围是：上游 Distribution 包检查/打包、Runtime doctor、本地 Runtime Build、浏览器渲染和导出文件的技术完整性。它不覆盖所有创作包、Studio Inspector、所有 Provider、结果存储后端、平台下载、发布和长片视觉质量。

外部生成 Provider、账号、额度和远程服务仍需用户明确授权后逐项接入。HypiHub、图片/视频/语音服务、需要登录的平台抓取以及对外发布都必须保留真实请求、服务回执、成本和权限边界；模拟调用或本地导出不能替代付费远程验收。本轮没有新增付费调用、第三方上传或对外发布。

## 许可与保留要求

必须保留上游根目录 `LICENSE`、固定提交记录、Hypit 名称/Logo/版权信息以及修改记录。Hypit 使用带附加条件的 Apache 2.0 修改版许可：自用或本组织内部工作有明确许可范围；多租户托管/SaaS、商业再分发或向第三方收费提供 Hypit 或其衍生物可能需要另行商业许可。不能把它写成 MIT 或无限制商用许可，也不能用本记录替代法律意见。

第三方模型、Provider、浏览器、字体、音乐、素材和平台各有独立条款。输出归属条款不能自动消除这些独立义务。已有 Hypit 许可原文副本见 [`../artifacts/reference_research_20260921/hypit-LICENSE.txt`](../artifacts/reference_research_20260921/hypit-LICENSE.txt)。

## 未完成项

- 将本地 Hypit Distribution 与当前 OpenMontage 工作台建立稳定、可恢复的功能连接，并保留两边项目/结果/凭据边界。
- 对 CLI、Studio、Runtime、媒体、字幕、音轨、模型、Provider、结果导出和错误恢复逐项建立真实验收矩阵。
- 处理完整测试中记录的 15 个沙箱失败、非沙箱 timing 初次失败及其环境原因；单独复跑通过不等于整套回归无缺陷。
- 在明确授权后，逐项验证远程模型账号、额度、费用、上传、回执和取消语义；未授权前保持免费本地路径。
- 在设置页展示 `~/Library/Application Support/Hypit/packages` 的用户级缓存位置、版本和复用状态。

