# 0.89 选中工作流保存与插入验收

日期：2026-10-01。正式服务 **0.89.0**，单一监听进程 PID **51050**，地址 `http://127.0.0.1:4768/`。正式任务0；没有向用户工作区加入测试素材、工作流或插入记录。

入口：画布选中节点 →「保存工作流」；素材页 →「库与分组管理」→ 工作流分组 →「插入当前画布」。本轮完成选区工作流的本机闭环，全部参考功能仍未完整整合。

## 基准与实现

继续核对 Infinite Canvas 固定提交 `67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e` 的 [画布工作流导入导出及保存](https://github.com/hero8152/Infinite-Canvas/blob/67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e/main.py#L16335-L16493)。缓存源码为880740字节，SHA-256为 `2e0b1f0903d809715d92a982b849674a59292e7a89f3c2b7dbc44fd130080e8e`，本轮重新核对一致。仅依据功能和文件契约独立实现，没有运行上游Python或调用第三方Agent。

- 所选1–1500节点、内部连线、分组成员交集、固定素材和绑定模板保存。动态绑定依赖选区外节点时明确报错，要求用户一并选择；不自动扩选，不保存未选镜头、消息、会话历史、密钥或授权。
- v22 `.jingchang` 独立模板包携带实际媒体及图片编辑、全景、增强、LoRA等必要依赖。已有v1–v21备份语义保留，普通工程继续使用所需最低版本。
- 插入当前项目，保留原节点、素材、镜头、消息、设置和相对位置；为新增节点、连线、分组、素材、ComfyUI模板和RunningHub配置重新编号。重映射画布引用，不改工作流内部字段、计算节点ID或LTX片段ID。
- 项目锁、修订和活动任务检查；容量/位置错误在复制前拒绝。相同请求固定原目标与位置，重复读取完成记录不增加副本或修订。
- 持久插入记录与资源计划。实际服务在提交前或提交后重启，读取只显示原记录；明确继续才恢复。已准备资源不重复制，已提交标记不再追加图谱；被修改的暂存模板或元数据不覆盖。
- 一次撤销/重做保留媒体及模板文件。关闭复制窗口继续编辑时，仅合并新增图谱和资源，原有编辑保留。编辑控件绑定原节点，修正旧文本框失焦误写新节点的实际缺陷。
- 工作流文件下载后，在另一镜场工作区的工作流分组通过真实文件选择器导入，再插入已有项目；不创建中间工程或自动生成。桌面及390px布局已检查。

新增 [canvas-fragments.mjs](../lib/canvas-fragments.mjs)，更新工程备份、素材库服务、HTTP路由、主画布及素材库界面。插入记录在 `data/asset-catalog/insertions/`，独立资源和继续计划在 `data/bundles/imports/`。本轮没有新增依赖。

## 验证结果

汇总：[acceptance-0.89-20261001/result.json](../artifacts/acceptance-0.89-20261001/result.json)。

| 检查 | 结果 | 证据 |
|---|---|---|
| 全量自动测试 | **499/499通过**，0失败、0跳过，最终修正后的代码 | [automatic-tests-release.log](../artifacts/acceptance-0.89-20261001/automatic-tests-release.log) |
| 选区工作流测试 | **16项纳入全量通过**：依赖闭包/外部依赖拒绝、各类绑定重映射、真实字节、版本、容量、冲突、活动任务、损坏/符号链接、原计划恢复、跨工作区和幂等 | [canvas-fragments.test.mjs](../tests/canvas-fragments.test.mjs) |
| 新增浏览器 | **21项通过**：保存、下载、实际PNG、双击防重复、撤销/重做、明确执行一次本机模拟Comfy链和回填、两次真实重启、后台编辑保护、文件导入、手机布局 | [result.json](../artifacts/canvas-fragments-qa-1790842520328/result.json) |
| 素材库回归 | **15项通过**：原收藏/组织/模板/快照/重启与恢复链路 | [result.json](../artifacts/asset-catalog-qa-1790842632873/result.json) |
| Alt拖动回归 | **3项通过**：组复制、连线规则和一次撤销 | [canvas-alt-drag-browser.log](../artifacts/acceptance-0.89-20261001/canvas-alt-drag-browser.log) |
| 原生创作画布回归 | **19项通过**：授权、混合图谱、停止、原任务查询和结果回填 | [result.json](../artifacts/canvas-studio-qa-1790842720063/result.json) |
| 提示词引用回归 | **7项通过**：键盘选择、保存、重载、移除引用及手机布局 | [result.json](../artifacts/prompt-mentions-qa-1790842720018/result.json) |
| 语法检查 | 通过 | [syntax-check-release.log](../artifacts/acceptance-0.89-20261001/syntax-check-release.log) |
| 既有数据 | **87/87业务文件SHA-256不变**，0新增、0缺失；排除且未改写运行标记`server.pid` | [data-preservation-0.89-result.json](../artifacts/data-preservation-0.89-result.json) |
| 正式服务 | 原目录/命令/空闲状态核对后正常SIGTERM，启动单一0.89服务；版本、页面、接口和零测试条目只读核对通过 | [runtime-0.89-20261001-082023.json](../artifacts/runtime-0.89-20261001-082023.json)、[live-smoke.json](../artifacts/acceptance-0.89-20261001/live-smoke.json) |

浏览器合计 **65项**。新增验收使用独立Chrome会话、独立工作区和本机模拟ComfyUI；真实PNG/WAV字节与浏览器解码、实际进程重启、文件选择器和两个工作区通过检查。模拟生成仅在明确执行时提交一次，不代表真实GPU或平台生成效果。

已视觉检查 [桌面保存](../artifacts/canvas-fragments-qa-1790842520328/01-saved-selection.png)、[插入图谱](../artifacts/canvas-fragments-qa-1790842520328/02-inserted-canvas.png)、[恢复记录](../artifacts/canvas-fragments-qa-1790842520328/03-recovered-insertions.png) 和 [390px导入窗口](../artifacts/canvas-fragments-qa-1790842520328/04-mobile-workflow.png)。窗口可纵向滚动，无横向越界。

浏览器排错发现：插入后选择新节点，旧输入控件失焦仍按当前选中编号处理，使新提示词被误写并多留一次撤销记录。已将控件绑定原节点，文字只通过实时编辑事件更新；最终测试同时断言原文字保留、新提示词未改和一次撤销移除本次图谱。早期失败日志、追踪和测试夹具保留，未计作通过。

## 边界与待完成项

当前工作流文件仍为镜场自身格式，**Infinite Canvas原生JSON/ZIP互通和独立整库备份尚未实现**。选中工作流不递归打包素材库中的整项目快照或其他项目条目。跨工作区测试在同一台电脑的独立目录完成，未在第二台物理电脑验收。

节点1500、连线5000、分组1500、12MiB清单和4GiB媒体合计是本机限制，不能视为上游等同限制的证据。本轮没有实际传输4GB选区包；大文件既有证据见0.85，不能混作本轮新分支验收。

批量视觉分类、资产库APIMart真人素材注册、其它参考项目逐功能审计，以及真实账号/权限/费用/质量和GPU验收继续保持未完成。回收与撤销保留文件，不释放磁盘。

本轮未读取真实密钥值，未进行真实模型请求、付费调用、第三方素材上传或公开部署。`agentConfigured:false`只说明对话Agent配置状态，不能据此认定用户已有火山视频配置不存在；旧Seedance生成历史也不代替新镜场的真实云验收。
