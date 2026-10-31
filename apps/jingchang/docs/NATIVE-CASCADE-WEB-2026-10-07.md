# 2026-10-07 · 智能串联正式接入网页

证据日期：2026-10-07（Asia/Shanghai）。此记录补充发送方生成、同级共享和循环中继的网页执行，不将全部 Infinite Canvas 功能或真实模型质量标为完成。

## 从哪里使用

1. 在浙江文旅工作台打开「自由画布」。正式地址为 `http://127.0.0.1:4750/canvas`，同源承载相邻镜场服务。
2. 打开已导入的原生智能画布，明确迁移发送节点的本机工作流、RunningHub、参考图接口或创作接口。原始参数保留；没有配置模型/工作流时不能生成。
3. 选择智能素材链的末端节点，或智能循环节点，打开编辑面板，点击 **「智能串联 · 检查并运行」**。此入口对应原生智能节点，不替换普通画布的「运行工作流」。
4. 检查发送方、接收方、步骤、生成次数和后端。外部接口仍逐步骤核对预算及发送范围；确认后才提交。
5. 完成后可展开 **「实际输入」**，核对提示词和素材引用，再点击 **「加入当前项目」**。停止时可取回已完成部分；有可查询原任务的情况可以继续。

## 本次真正接上的行为

| 触发 | 当前行为 |
| --- | --- |
| A 连到 B，再由 B 连到 C | A 使用自己的生成设置，新结果传入 B；B 使用自己的提示词与生成设置，把本次新结果传入 C |
| A 同时连到 B 与 D | 同级分支按原生首结果共享规则采用同一次生成；B/D 后续按各自设置继续，不把共享当成一次新生成 |
| 智能循环 | 使用原生计数、当前选中分支及串行/并行规则；循环中继保留，逐轮结果及实际请求有记录 |
| 预检后修改节点、连线或模板 | 版本/清单不一致时拒绝提交，需要重新检查 |
| 停止、断流或服务重启 | 查询原子任务原编号；找不到已接受的编号时不重复提交，同步图片接口不自动重发 |
| 运行途中用户编辑当前画布 | 旧任务结果可以单独取回；已修改的接收节点和连线不会被旧快照强制覆盖 |
| 分次取回后继续 | 仅追加未取回的新素材，保留第一次的接收节点及历史，不重复加入结果 |
| 发送方提示词缺失并采用原素材回退 | 明确记录原素材传递；不标成新生成、不虚增请求数；重复应用被阻止 |

## 代码与数据路径

- `lib/native-cascade-runner.mjs`：将既有清单/执行/子任务/请求模块接入生产路由；预检不提交，启动须版本和预检摘要一致；密钥仅留在运行闭包中。
- `lib/native-cascade-results.mjs`：核对原子任务真实状态和结果，受保护的接收节点回填、逐轮输出槽、独立结果节点、分次应用与去重。
- `lib/native-cascade-plan.mjs`、`lib/native-cascade-execution.mjs`、`lib/native-cascade-children.mjs`、`lib/native-cascade-requests.mjs`：沿用本机已有的原生解释与参数展开模块，本次没有下载新的执行引擎。
- `server.mjs`：只读 `native-cascade-plan`；既有 `canvas-run`、任务查询/停止/恢复及 `apply-generation` 按 `executionMode: native-cascade` 分流。旧模式保持。
- `public/native-canvas.js` / `app.js` / `native-cascade-ui.js`：节点入口、检查清单、授权、任务记录和实际输入详情；继续复用原任务中心、玻璃主题和文旅同源挂载。
- 父任务保留 `snapshot`、`cascadeProgram`、`cascadeState`；公开查询隐藏这些内部结构，暴露步骤和已核实产物。每步 `actualInput` 保存展开后的文字、引用、映射和未使用引用，不包含密钥。

自定义 ComfyUI 工作流如果只有一个素材字段，会使用首项；未使用的其它引用会留在任务记录中。外部预算是授权记录，不能替上游平台强制扣费限额。

## 2026-10-07 验证

以下命令在镜场目录使用已安装的 Node.js v24.18.0；`local-network-only.mjs` 将测试网络限制为本机。返回的 PNG/视频响应是合成测试数据，不能当成真实 AI 作品质量。

```sh
node --import ./tests/helpers/local-network-only.mjs --test --test-reporter=spec tests/native-cascade-runner.test.mjs tests/native-cascade-api.test.mjs
node --import ./tests/helpers/local-network-only.mjs --test --test-reporter=spec tests/native-cascade-plan.test.mjs tests/native-cascade-execution.test.mjs tests/native-cascade-children.test.mjs tests/native-cascade-requests.test.mjs
node --import ./tests/helpers/local-network-only.mjs --test --test-reporter=spec tests/canvas-cloud.test.mjs tests/canvas-images.test.mjs tests/canvas-runner.test.mjs tests/canvas-studio.test.mjs tests/native-branch-execution.test.mjs tests/native-cascade-media.test.mjs tests/native-cascade-prompt.test.mjs tests/native-loop-execution.test.mjs
```

分别 **16 / 66 / 76 项通过，共 158 项**。覆盖四类生成协议、按发送方参数和新素材生成、同级共享、数量展开、版本保护、暂停恢复、并行后端、原任务收据、防伪完成状态、部分结果回填和旧功能回归。另完成 9 个 JS 文件语法检查与文旅挂载辅助脚本语法检查。

浏览器使用生产 `web_api.canvas_module` 路由与正式主题，挂载隔离本机数据；实际点击节点 → 运行检查 → 确认 → 完成 → 展开实际输入 → 加入画布 → 刷新。4 个步骤、3 个实际合成请求、1 次共享、3 份新 PNG 保存，两个同级节点引用同一新素材；原始 PNG 可继续查看。浏览器 warning/error 日志为空。测试进程已停止，原始验收目录保留。

正式 4768 在无活动任务时重载，保留原始 `data`、模型设置和 7 个原项目；4750 同源健康接口及新增静态模块检查通过。服务版本观察为 0.99.3（同时存在其它任务的版本更新，不将其全部改动归于本次）。主库 2,278、镜场 176 份原项目 JSON（含历史）指纹一致：没有修改、删除或新增生产项目文件。未新增依赖、付费请求、外部发送或作品生产。

完整回执和修改前源码备份在相邻文旅库的 `artifacts/native-cascade-web-20261007-d520975b/`；截图、技术说明及 PPT 图注见 [答辩记录](../../浙江文旅AI视频引擎V2/docs/defense-evidence/records/2026-10-07-native-cascade-web/README.md)。

## 仍未完成

- 嵌套、反馈、退出、自动重复处理等复杂控制规则的完整原生等价行为。
- 本入口的 H3 / LTX / 增强 / 提示词列表混合串联。现在预检直接阻止；对应已有专用入口仍可在其原有范围使用。
- 全部参考项目逐仓库逐功能对齐、完整任务历史跨机器打包和上游素材库目录的完整互通。
- 真实 RunningHub / 视频 / 图片平台与 GPU 模型质量、账单及实体设备验收。本轮未消费 API 额度。
- 自动角色/镜头一致性评分与针对性修复、可编辑剪映工程、Photoshop 连接器、CLI 实际创作任务，不因本次串联而算完成。
