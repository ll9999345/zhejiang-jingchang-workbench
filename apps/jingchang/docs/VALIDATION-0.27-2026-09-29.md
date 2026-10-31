# 0.27 图片机位与 ModelScope 编辑验收

日期：2026-09-29。运行版本：0.27.0。本轮完成本机功能与模拟协议验收，整体整合目标仍未完成。

## 本轮交付

- 图片节点和素材库均可进入机位面板：上传/选择参考图、平面透视示意、水平角/俯仰/距离、拖动/方向键/滚轮、预设景别、逐项重置和补充提示词。
- 机位保存在图片节点 `params.cameraAngle`，保留原始补充文字；画布运行、动态语言模型文字、直接图片上下文及直接 ComfyUI 运行均带入机位指令。
- ComfyUI 可在面板导入 API 工作流、选择真实文字与图片字段；ModelScope 支持本地图片 data URI 编辑。普通创作台与画布绑定也支持最多3张 ModelScope 参考图。
- 取消后可在服务重启后查询原任务，不重交生成；没有编号的不确定提交仍停止。结果回到同一项目，源图、机位和绑定保留；复制、撤销和完整备份可恢复。
- 修复旧窗口延迟关闭事件清空新窗口密钥，以及生成结果遮住原节点的问题。结果现在放在既有节点下方，原节点位置不变。

## 验证记录

| 检查 | 结果 | 证据 |
|---|---|---|
| 全量本地测试 | 202/202通过 | [完整日志](../artifacts/camera-angle-qa-1790621285100/full-test-suite.log) |
| 结果排布修复后相关复测 | 33/33通过；含新增机位8项、混合创作、循环和语言模型 | [复测日志](../artifacts/camera-angle-qa-1790621285100/integration-retest.log) |
| 语法检查 | 全部通过，包含三个新增前端模块 | [检查日志](../artifacts/camera-angle-qa-1790621285100/syntax-check.log) |
| 机位与ModelScope浏览器验收 | 20项通过；真实Chrome、隔离工作区、本机模拟服务 | [结果](../artifacts/camera-angle-qa-1790621285100/result.json) |
| 原生创作混合链回归 | 19项通过；含图片→视频→Comfy、服务重启恢复、密钥不落盘 | [结果](../artifacts/canvas-studio-qa-1790621039755/result.json) |
| 正式本机服务 | 健康检查0.27.0、机位入口打开、无浏览器错误、无写请求 | [服务记录](../artifacts/camera-angle-qa-1790621285100/live-verification.json)、[浏览器记录](../artifacts/camera-angle-qa-1790621285100/live-ui.json) |
| 原有数据保全 | 更新前后80份既有数据文件SHA-256相同，排除进程号与运行日志 | 同上服务记录 |
| 本机诊断 | 无缺失素材或悬空引用；1个项目、0素材、0任务 | [诊断](../artifacts/camera-angle-qa-1790621285100/live-diagnostics.json) |

全量测试运行后，在浏览器中发现并修复窗口与节点排布问题；随后重跑33项受影响逻辑测试和完整39项浏览器流程。截图已实际查看，修复了预览纹理的明显接缝和手机预览文字过小问题，最终机位浏览器流程重新通过20项。

主要截图：[机位面板](../artifacts/camera-angle-qa-1790621285100/01-angle-controls.png)、[ModelScope结果](../artifacts/camera-angle-qa-1790621285100/02-modelscope-result.png)、[ComfyUI结果](../artifacts/camera-angle-qa-1790621285100/03-comfy-result.png)、[手机布局](../artifacts/camera-angle-qa-1790621285100/04-mobile.png)、[普通创作台三图编辑](../artifacts/camera-angle-qa-1790621285100/05-modelscope-three-images.png)。这些生成结果来自本机模拟接口，不是云端模型效果样张。

## 功能依据与限制

- [Infinite Canvas固定基准的angle.html](https://github.com/hero8152/Infinite-Canvas/blob/67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e/static/angle.html)：角度范围、距离范围、参考图平面预览和本地/云端生成流程。实现独立编写，未复制上游代码、素材或模型。
- [Qwen官方ModelScope API示例](https://www.modelscope.ai/models/Qwen/Qwen-Image-Edit-2511)：`image_url`数组支持本地图片data URI；[ModelScope官方社区说明](https://modelscope.csdn.net/691c36ee82fbe0098caca391.html)说明多图编辑。
- 预览是平面投影，不是三维重建；生成模型需要自行具备视角编辑能力。未安装大型模型或LoRA，未进行真实GPU生成、云端调用或向第三方发送素材。
- 真实ModelScope账户、模型权限、供应商费用、机位准确性和主体一致性仍未验收。本机Agent语言模型仍未配置。
- 其他参考功能的未完成项仍见[基准差距表](INFINITE-CANVAS-PARITY.md)；本轮没有把总体目标标记完成。
