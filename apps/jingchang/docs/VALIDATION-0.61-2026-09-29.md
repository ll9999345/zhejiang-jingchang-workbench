# 0.61 验收记录

日期：2026-09-29  
范围：对照 Infinite Canvas 固定提交 `67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e` 的 Chrome 网页素材采集说明，补充 FLV 直链识别和本机素材保存类型。上游说明：[Chrome Local Asset Importer](https://github.com/hero8152/Infinite-Canvas/blob/67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e/tools/chrome-local-asset-importer/README.md)。

## 实现

- 当前页扫描识别 `.flv` 直链，并将其计入视频候选项。
- 来源 MIME 是 `video/x-flv` 或 MIME 缺失但文件名以 `.flv` 结尾时，扩展可按 FLV 类型处理；单项仍使用原始文件下载，多项行为继续使用 ZIP。
- 本机 `/api/chrome-import` 与素材存储层接受 `video/x-flv`，写入本机素材库后保留视频类型。
- 不读取、保存或输出任何 API Key；不向第三方提交生成任务或素材。

## 验收结果

- `npm run check`：通过；另对 `lib/workspace.mjs` 执行 `node --check`：通过。
- `npm test`：330 项通过，0 项失败。
- 隔离 Chrome 页面扫描：24 个断言通过，扫描到 11 项候选素材、其中 5 项视频；测试中的外部域名请求全部拦截。
- Chrome 导入 API：2 项通过，包含 FLV MIME 保存路径。
- 服务重启后 `/api/health` 返回 `0.61.0`；`agentConfigured=false`，保留 1 个项目，生成任务数为 0。

## 尚未验收

- FLV 接口测试使用隔离测试字节验证类型和保存路径，不证明样本是可播放的真实 FLV 媒体。
- 扩展没有安装到用户 Chrome；真实网页权限提示、浏览器下载和不同 Chrome/系统的 FLV 解码能力尚未验收。
- HLS/DASH 仅识别并标注，暂不下载或合并分片。代码已含 data URL 图片和 blob 媒体读取路径（blob 上限20 MiB），扫描测试覆盖两类 URL；但由于扩展未安装到用户 Chrome，真实页面读取、下载和导入尚未端到端验收。DRM、网络请求嗅探、智能分类和受浏览器权限限制的跨域框架仍未完整支持；Photoshop 连接器与 CLI 集成也仍未实现。
- Infinite Canvas、LibTV、RunningHub 等参考项目的全部功能尚未完全整合；真实云账户、模型、GPU 和生成质量未验收。
