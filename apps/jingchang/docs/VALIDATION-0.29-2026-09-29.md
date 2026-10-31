# 0.29 细节增强与放大验收

日期：2026-09-29。结果：本机功能与协议流程通过；真实 GPU / 云端模型的可用性和画质未验收。总体“所有参考功能都能用”的目标仍未完成。

## 本轮交付

- 图片节点、素材库和添加菜单中的专用增强面板，支持本机导图 / 上游图片、工作流导入和字段映射。
- 本地 0.1–1 强度控制，随机 / 固定 / 原工作流种子；保留采样器已有计算连线。
- ModelScope 单参考图编辑与合法 LoRA 混合，使用现有逐节点授权、异步任务查询和素材下载。
- SeedVR2 单独放大或增强后放大。2048 / 4096 是短边目标，长边上限4096；保留比例，实际尺寸以输出为准。
- 两个普通画布节点共用项目、任务中心和结果回填。第二步读取第一步输出，失败可先取回已完成结果；停止和重启后只查原任务，不重新上传或生成。
- 原图 / 本步骤输入对比，实际尺寸、滑杆 / 拖动 / 键盘、原始尺寸查看、两图下载。
- 第4版完整备份递归保留原图与中间结果，混合编辑 / 全景链校验、编号重映射，本机诊断报告缺失原图索引。

## 证据

全部自动化生成调用只发送给 `127.0.0.1` 的模拟服务器，图片为测试程序画出的合成小屋。没有调用真实 ComfyUI / ModelScope、安装模型、上传个人素材或产生费用。

| 检查 | 结果 | 文件 |
|---|---|---|
| 全量本地测试 | 227 / 227 | `artifacts/image-enhance-qa-1790625137258/tests.log` |
| 增强专项 | 12 / 12，包含在全量中 | 同目录 `enhance-tests.log` |
| 语法检查 | 通过 | 同目录 `check.log` |
| 增强浏览器 | 21项通过、0页面错误 | 同目录 `result.json` |
| LTX 浏览器回归 | 18项通过、0页面错误 | `artifacts/ltx-director-qa-1790625275530/result.json` |
| 正式服务 | 0.29.0，PID 23007，4768端口健康 | 增强验收目录 `live-verification.json` |
| 正式页面只读检查 | 打开增强面板通过，0写请求 / 0页面错误 | 同目录 `live-ui.json`、`live.png` |
| 正式数据保留 | 80份既有文件逐字节SHA-256未改变，浏览器检查后再次确认 | 同目录 `preservation-before.json` 与 `live-verification.json` |
| 本机诊断 | 1项目 / 0素材 / 0任务，无缺失引用；FFmpeg / FFprobe / 中文字体可用 | 同目录 `live-diagnostics.json` |

关键断言：强度0.65/0.76进入FloatConstant.value，KSampler.denoise连线保留；两个种子字段接收固定值；SeedVR2收到4096目标和4096上限；下游上传内容逐字节等于增强结果，而非原图。随机种子保存到持久任务与结果，同一请求编号不创建新任务。真实重启验收后提交总数与上传总数均保持2次。

备份分别验证只留下最终图片时仍收齐3张来源图片，以及完整流程恢复后可再执行。比较页明确显示模拟图的实际280×180、560×360和1120×720，不因选择4K而伪报4096输出。

已查看桌面设置、桌面对比、移动端对比与移动端ModelScope设置截图：`01-local-workflow-controls.png`、`02-original-output-compare.png`、`03-mobile-compare.png`、`04-mobile-cloud-settings.png`。测试中修正了重复按钮定位和等待回填完成的时序；最终完整浏览器流程通过。

## 参考依据与差距

- 固定版本 [enhance.html](https://github.com/hero8152/Infinite-Canvas/blob/67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e/static/enhance.html)：本地增强0.1–1、默认0.5，先增强再可选2K/4K放大，前后对比。该固定页面的实际生成处理器只执行本地分支；ModelScope增强需求另来自用户提供的快速入门3.6与根main.py的ModelScope图像接口，未把文档当作页面已实现的证明。
- 固定版 [Z-Image-Enhance.json](https://github.com/hero8152/Infinite-Canvas/blob/67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e/workflows/Z-Image-Enhance.json) / [upscale.json](https://github.com/hero8152/Infinite-Canvas/blob/67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e/workflows/upscale.json)：核对LoadImage、FloatConstant与SeedVR2字段和连线。没有把这两份文件或实现代码复制进产品，实际工作流由用户导入。
- [SeedVR2 官方插件文档](https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler)：resolution为短边目标、max_resolution为任一边的上限；同种子与同输入的可复现语义。真实尺寸和画质仍受工作流、模型与环境影响。
- [ModelScope 模型页 API 示例](https://modelscope.cn/models/black-forest-labs/FLUX.2-klein-base-4B)：核对参考图和LoRA混合权重契约；不代表用户账号的Klein或指定LoRA已开通。

当前没有已配置的真实 Agent 模型（健康检查 `agentConfigured:false`），也没有完成真实云账户与GPU验收。更多模型参数、原生多轮对话、云平台专用能力、条件循环及剪辑扩展等仍见 `INFINITE-CANVAS-PARITY.md`，没有标记全功能完成。
