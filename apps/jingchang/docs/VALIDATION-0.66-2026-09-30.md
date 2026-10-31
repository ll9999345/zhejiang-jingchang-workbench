# 0.66 验收记录

日期：2026-09-30  
范围：继续对照 Infinite Canvas 固定提交 `67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e` 的 LTX Director 时间线能力。本次补齐本机音频波形、片段多选/组移动及吸附。

## 实现

- 时间线上可用 Cmd/Ctrl 点击多选片段，Shift 点击追加选择；拖动时整组移动，并在碰撞时拒绝整次移动，可撤销。
- 默认吸附到其它片段边缘、播放头和输出截止位置，可关闭吸附。
- 新增 `GET /api/assets/:assetId/waveform`，只接受项目中已存在的本机音频素材，返回 640 个归一化峰值。使用本机 FFmpeg/FFprobe，不发送音频内容到外部服务；并发最多 2 项，缓存最多 128 项。
- 服务健康接口版本从 `package.json` 动态读取，避免发布版本与健康检查显示不一致。

## 验收结果

- `npm test`：345 项通过，0 项失败。
- `npm run check` 与 `npm run check:chrome-importer`：通过。
- `node tests/ltx-director-browser.mjs`：20 项真实本机浏览器检查通过，覆盖波形可见像素、两段组移动/撤销和片段边缘吸附。
- 正式本机服务 `/api/health` 返回 `version: 0.66.0`、`agentConfigured: false`；`/api/jobs` 为空。现有浏览器工作台已刷新至该版本。
- 波形测试使用本机生成的音频样本；没有调用 Astra、其他模型、第三方服务、云账户或付费生成接口，也没有上传用户素材。

## 尚未完成

本轮仅验收时间线交互和本机波形处理，不等于真实 LTX 工作流、模型/GPU 生成质量已验证。完整 LTX 快捷键与其它插件版本字段仍待对照；Infinite Canvas 的其它未实现项和 LibTV、RunningHub 等参考范围仍未全部盘点/整合。总差距见 `FEATURES.md` 与 `INFINITE-CANVAS-PARITY.md`。
