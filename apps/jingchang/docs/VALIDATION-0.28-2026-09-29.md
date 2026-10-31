# 0.28 LTX 导演时间线验收

日期：2026-09-29。正式服务：0.28.0。本轮完成时间线编辑和本机协议验收，总体功能整合仍未完成。

## 交付范围

- 画布新增LTX入口，视频节点可编辑原时间线。支持导入API工作流、选择导演节点、全局/分段提示词、文字/图片片段和音轨、参考强度、音频入点、帧/秒显示、尺寸、帧率、压缩、缩放方式和普通工作流参数。
- 拖动移动与两侧裁切、播放位置切分、片段复制、撤销/重做、缩放、素材与音频预览、从项目分镜导入。项目分镜的视频保留描述，图片与配音成为参考；剪辑入出点不自动转换。
- 后端编译真实LTX参数，检查重叠、分隔符、输出范围、Guide连接、媒体格式与音频实际时长。空隙与输出截断按固定基准语义处理，截止后的媒体和禁用音轨不发送。
- 上游生成图片可进入时间片段；图片/音频在同一任务内去重上传，批次复用。图像路径、音频路径写入时间线对应字段，不把项目素材ID冒充后端文件名。
- 保存、任务停止/恢复、结果入项目、选区复制、完整备份导入复用现有系统。源时间线保留，原任务恢复不再次上传或提交。不确定提交/上传不自动重试。

## 测试与正式服务

| 检查 | 结果 | 证据 |
|---|---|---|
| 全量回归 | 212/212通过 | [全量日志](../artifacts/ltx-director-qa-1790622971767/full-test-suite.log) |
| 后续边界及集成复测 | 34/34通过，包括LTX全部13项、选区复制、完整备份、有界循环 | [复测日志](../artifacts/ltx-director-qa-1790622971767/integration-retest.log) |
| 语法检查 | 全部通过；后续改动模块另行检查 | [日志](../artifacts/ltx-director-qa-1790622971767/syntax-check.log) |
| LTX浏览器流程 | 18项通过，0页面错误 | [结果](../artifacts/ltx-director-qa-1790622971767/result.json) |
| 原图片机位流程回归 | 20项通过，0页面错误 | [结果](../artifacts/camera-angle-qa-1790623029502/result.json) |
| 正式服务 | 0.28.0健康检查、LTX入口实际打开、0写请求、0页面错误 | [服务](../artifacts/ltx-director-qa-1790622971767/live-verification.json)、[浏览器](../artifacts/ltx-director-qa-1790622971767/live-ui.json) |
| 数据保全 | 80份原有数据文件SHA-256不变，排除运行日志和进程号 | 同上服务记录；正式浏览器检查后再次核对 |
| 诊断 | 1项目、0素材、0任务；无缺失素材/文件引用 | [诊断](../artifacts/ltx-director-qa-1790622971767/live-diagnostics.json) |

全量测试运行后，补了上游先生成参考图、批次种子、纯文字、新版起止字段、音频越界和删除上游仍可保存等边界。新增3项测试后重跑34项相关测试；没有把212项日志描述成后续215项全集重新运行。浏览器发现手机刻度拥挤后调整了刻度密度，再次完整通过18项。

浏览器使用独立Chrome进程与隔离工作区，真正重启本机测试服务后恢复同一LTX任务，核对上游提交仍为1次、素材上传仍为2份、查询编号唯一。正式用户项目没有加入测试素材或任务。

已查看截图：[编辑面板](../artifacts/ltx-director-qa-1790622971767/01-timeline-editor.png)、[视频结果](../artifacts/ltx-director-qa-1790622971767/02-result.png)、[手机布局](../artifacts/ltx-director-qa-1790622971767/03-mobile.png)。结果视频是本机模拟服务返回的合成样本，用于检验媒体下载/预览，不是LTX模型效果。

## 依据与未完成项

- 固定基准：[Infinite Canvas ltx-director-timeline.js](https://github.com/hero8152/Infinite-Canvas/blob/67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e/static/js/ltx-director-timeline.js)与[LTXDirectorv2-API.json](https://github.com/hero8152/Infinite-Canvas/blob/67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e/workflows/LTXDirectorv2-API.json)。已读取具体片段、音频、分段长度和提示词序列化实现。
- 补充核对原节点作者的[ltx_director.py](https://github.com/WhatDreamsCost/WhatDreamsCost-ComfyUI/blob/main/ltx_director.py)：imageFile/audioFile、音频trimStart、guide_data与新增起止字段。该主分支不是本项目功能基准；只兼容已核对字段，不承诺新版全部motion/retake功能。
- 本项目独立实现；没有复制上游源代码、工作流、模型或插件到产品。测试工作流是自建最小协议夹具，不是可用于GPU生成的模型工作流。
- 未安装LTX模型、自定义节点或GPU环境；未进行真实LTX生成、第三方素材上传或付费调用。工作流模型兼容性、画质、主体一致性、运镜及音画同步仍待真实环境验收。本机Agent语言模型仍未配置。
- 音频波形、时间线多选/吸附、完整快捷键、其它版本插件字段仍未对齐。其余整合缺口继续以[功能基准表](INFINITE-CANVAS-PARITY.md)为准，总体目标保持进行中。
