# 0.90 Infinite Canvas 原生工作流文件互通验收

日期：2026-10-01。正式本机服务 **0.90.0**，单一监听 PID **75627**，地址 `http://127.0.0.1:4768/`。正式任务0、原生接收记录0、素材库条目0；测试素材和模板仅在独立验收目录。本轮没有真实付费调用、第三方素材上传或公开部署，整体整合目标仍未完成。

入口：素材 →「库与分组管理」→ 工作流分组 →「导入画布工作流文件」。原生JSON/ZIP先检查预览，再明确保存和插入已有项目。画布选中节点 →「保存工作流」也提供原生导出。

## 固定基准与文件契约

固定提交 `67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e`。核对[普通画布文件保存](https://github.com/hero8152/Infinite-Canvas/blob/67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e/static/js/canvas.js#L14858)、[智能画布导入](https://github.com/hero8152/Infinite-Canvas/blob/67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e/static/js/smart-canvas.js#L17435)与[后端JSON/ZIP资源契约](https://github.com/hero8152/Infinite-Canvas/blob/67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e/main.py#L16275)。只读参考源码，独立实现，没有运行上游Python或调用第三方Agent。

| 已读来源 | 大小 | SHA-256 |
|---|---:|---|
| 固定版main.py缓存 | 880740 bytes | `2e0b1f0903d809715d92a982b849674a59292e7a89f3c2b7dbc44fd130080e8e` |
| [canvas.js](../artifacts/reference-0.90-20261001/canvas.js) | 786332 bytes | `a1e2dd0ba845ededca8a4351d0889e3569bab46479715408d22d2512482de1ed` |
| [smart-canvas.js](../artifacts/reference-0.90-20261001/smart-canvas.js) | 963471 bytes | `5a5fc55e1f8a47a47904e767341d59b831b6cdebd503365bcf95037efc178a84` |

普通`infinite-canvas-workflow`和智能`infinite-smart-canvas-workflow`v1包含节点、from/to连线和resources清单。上游ZIP使用Deflate并写入资源原件；全局API平台和ComfyUI表单配置没有完整打包，因此外部平台/工作流编号不能自动变成本机可用配置。

本轮进一步核实固定版`minimax`/`smart-minimax`专用节点及H3分段时间轴，已加入功能缺口。通用视频、RunningHub或LTX能力不能据此标记H3时间轴已实现。

## 完成的本机链路

- 原生JSON/ZIP、裸节点数组、嵌套workflow、UTF-8 BOM接收。原始文档、节点未知参数、连线额外参数、分组成员、有序输入和全部打包媒体保留；不读取宿主机源路径或下载外部素材。内嵌合法base64媒体变成本机文件。
- 先预览数量、来源类型与配置/语义缺口，不发布条目、不建项目或生成。相同接收编号只接受相同原件和名称；实际进程重启后，界面可读取原完成记录并恢复预览。
- 明确保存至工作流库，v23独立包、实际下载和原有插入收据复用。插入已有项目后，节点、连线、分组和资源编号重映射，原内容保留。完整v23工程备份也能恢复原生元数据、成员、素材与本机绑定，旧v1–v22继续可读。
- 原生JSON/ZIP导出保留来源节点编号，未知参数中的引用仍指向来源节点；重复来源编号要求分别导出。全部媒体按本次路径打包，并校验原始SHA-256和CRC。含本机素材时JSON导出拒绝，要求ZIP。
- 节点检查栏显示原始参数、全部图片/视频/音频和可切换预览；缺失素材可明确关联当前项目已有文件，不擅自替换其它节点。
- 普通生成节点经实际绑定编辑器选择本机模板、检查参数并确认迁移后才可执行。已迁移配置用`.jingchang`保存，原生导出拒绝假装等价转换。普通直接生图、ComfyUI单节点及整体画布计划都有待适配检查。
- 明确运行时，原生提示词进入本机模拟ComfyUI真实请求；首份同类型结果关联回未改的源节点，全部结果另建可见输出节点。源节点的初始文字/素材/参数指纹独立保存，避免被运行中变化的快照误判；运行期间用户编辑保留。
- 复制、断线、移出节点同步处理原生成组和有序输入；导出不会留下已移出的成员。有聚合/多素材语义的运行检查使用实际连线，新连线不能沿用旧标记绕过检查。

新增`native-canvas`接收/转换/有界ZIP读取/ZIP导出模块和界面；更新备份、素材库、画布工具、生成计划、结果应用及HTTP路由。正式工作区没有加入验收夹具。

依赖评估曾在项目`node_modules`安装`unzipper@0.12.5`，安装日志保留；其异常ZIP流未可靠结束，最终改用Node自带zlib的有界读取。最终package/lock不新增该运行时依赖，已安装文件保留，未执行卸载或删除。记录：[dependency-install.log](../artifacts/acceptance-0.90-20261001/dependency-install.log)、[dependency-final-lock.log](../artifacts/acceptance-0.90-20261001/dependency-final-lock.log)。

## 验证结果

汇总：[result.json](../artifacts/acceptance-0.90-20261001/result.json)。

| 检查 | 结果 | 证据 |
|---|---|---|
| 最终全量自动测试 | **521/521通过**，0失败、0跳过，125482ms | [full-tests-release.log](../artifacts/acceptance-0.90-20261001/full-tests-release.log) |
| 新增原生工作流专项 | **22项纳入全量**：Stored/Deflate/ZIP64、往返原字节、接收幂等/重启、凭据拒绝、CRC/目录/路径/截断/超声明大小、JSON形态、全部媒体、缺口阻断、直接提交防护、复制/断线/成员/顺序、原节点回填和完整v23恢复 | [native-canvas.test.mjs](../tests/native-canvas.test.mjs) |
| 新增原生浏览器 | **13项通过**，真实文件选择器、接收/发布分离、进程重启、v23保存、原生下载、既有项目插入、绑定迁移、一次模拟执行与回填、多素材/缺失文件修复、MiniMax明确阻断、390px布局 | [result.json](../artifacts/native-canvas-qa-1790849423059/result.json) |
| 选区工作流回归 | **21项通过** | [result.json](../artifacts/canvas-fragments-qa-1790849545788/result.json) |
| 素材库回归 | **15项通过** | [result.json](../artifacts/asset-catalog-qa-1790849545494/result.json) |
| 画布交互回归 | **24项通过**，含复制粘贴、连线、删除/撤销及手机菜单 | [result.json](../artifacts/canvas-interactions-qa-1790849631763/result.json) |
| Alt拖动回归 | **3项通过** | [canvas-alt-drag-browser.log](../artifacts/acceptance-0.90-20261001/canvas-alt-drag-browser.log) |
| 语法检查 | 通过 | [full-syntax.log](../artifacts/acceptance-0.90-20261001/full-syntax.log) |
| 正式服务HTTP检查 | 0.90.0，原入口/模块/新API均可访问，原项目1、任务0、库条目0 | [live-smoke.json](../artifacts/acceptance-0.90-20261001/live-smoke.json) |
| 正式只读Chrome检查 | **4项通过**，新文件入口可见，读取空记录无发布/插入，0写请求/外部请求/页面错误，原项目校验值不变 | [live-browser-smoke.json](../artifacts/acceptance-0.90-20261001/live-browser-smoke.json) |
| 原有业务数据 | **87/87文件SHA-256不变**，0新增/缺失；排除且未改写server.pid | [data-preservation-0.90-result.json](../artifacts/data-preservation-0.90-result.json) |
| 本机服务更新 | 核对原PID51050/命令/目录/单监听/0活动任务后SIGTERM，启动单一PID75627 | [runtime-0.90-20261001-102218.json](../artifacts/runtime-0.90-20261001-102218.json) |

隔离浏览器合计 **76项**，另有4项正式只读检查。所有模拟请求仅向本机回环服务，Chrome限制外部请求；原生新增流程在明确执行后提交一次ComfyUI，不读真实密钥或运行真实GPU。

已视觉检查[桌面预览](../artifacts/native-canvas-qa-1790849423059/01-native-preview.png)、[智能多素材检查栏](../artifacts/native-canvas-qa-1790849423059/02-smart-media.png)和[390px预览](../artifacts/native-canvas-qa-1790849423059/03-mobile-native-preview.png)。窗口能纵向滚动，无横向越界；正式新入口截图见[live-native-entry.png](../artifacts/acceptance-0.90-20261001/live-native-entry.png)。

早期失败日志、夹具和部分文件全部保留，不计作通过。实际修复包括损坏ZIP流结束、读取原生接收记录后菜单关闭、浏览器共享模块路由，以及原生节点结果回填使用独立初始指纹。测试读取POST上传响应的Chrome缓存错误改为在UI确认后读取持久预览；它不代表应用数据丢失。最终自动测试和浏览器检查通过后没有修改产品代码。

## 必须保留的边界

这是**原生文件互通和部分节点迁移**，并非全部原生执行语义完成。MiniMax H3时间轴、原生循环、智能提示词拆分/LLM、提示词组和分组聚合、输出接收整组结果、多素材向下游传整组仍未适配；原始资料保留，执行明确阻止。普通节点重新绑定是迁移到镜场自身的配置，不承诺原平台所有参数逐项等价。

仅支持已写本地头大小的Stored/Deflate ZIP及相应ZIP64字段，不接收数据描述符/加密/符号链接/特殊或未知非媒体文件。配置≤12MiB、资源≤1000份/合计4GiB、单文件沿用媒体类型上限；这些是本机限制，不证明上游所有文件兼容。真实4GiB原生包尚未验收，ZIP64证据是小文件强制字段夹具；0.85大文件传输的旧证据不能替代本轮新解析/导出分支。

没有在原软件界面实际运行本轮导出的ZIP，没有第二台物理电脑迁移、真实GPU/平台账号权限/费用/质量验收。原生平台配置、模型、插件、凭据、任务与授权不随文件转移。中断和失败的隔离文件保留，不释放磁盘。

独立整库备份、批量/自动分类、CLI真实生成、PS连接器、其他参考GitHub逐功能审计和真实云/GPU能力仍待补齐。`agentConfigured:false`只说明对话Agent状态，不表示用户已有火山视频配置不存在；旧Seedance历史也不是新镜场链路的真实验收。
