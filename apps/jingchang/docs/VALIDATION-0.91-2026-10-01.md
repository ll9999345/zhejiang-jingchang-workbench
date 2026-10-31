# 0.91 MiniMax H3 本机分段时间轴验收

日期：2026-10-01。正式本机服务 **0.91.0**，单一监听 PID **99803**，地址 `http://127.0.0.1:4768/`。既有项目1、正式任务0；验收文件、模板和模拟任务仅在隔离目录。本轮没有付费调用、第三方素材上传、模型安装或公开部署。整体整合目标仍未完成。

入口：画布底部「＋」→「MiniMax H3 时间轴」，或视频节点检查栏 →「MiniMax H3 分段时间轴」。已有绑定可从「编辑工作流绑定」重新打开。未绑定时可先保存时间轴；生成需要用户已准备的本机 ComfyUI H3 API 工作流、模型和自定义节点。

## 固定基准与实际模型边界

依据用户指定 Infinite Canvas 固定提交 `67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e` 的[普通画布](https://github.com/hero8152/Infinite-Canvas/blob/67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e/static/js/canvas.js)、[智能画布](https://github.com/hero8152/Infinite-Canvas/blob/67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e/static/js/smart-canvas.js)、[MiniMax_H3.json](https://github.com/hero8152/Infinite-Canvas/blob/67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e/workflows/MiniMax_H3.json) 与[字段配置](https://github.com/hero8152/Infinite-Canvas/blob/67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e/workflows/MiniMax_H3.config.json)。只读核对其行为和字段，独立实现本机模块，未运行上游程序。

固定图使用本地 `minimax_h3_ref2va_pruned_int8_convrot.safetensors`、CLIP/VAE、采样器及 SaveVideo。此本机模式不是 MiniMax 商业 API 插件，不能只凭产品名增加付费云端步骤。实际运行仍取决于用户导入的完整工作流与 ComfyUI 环境。

| 来源缓存 | 大小 | SHA-256 |
|---|---:|---|
| [H3 API JSON](../artifacts/reference-0.91-20261001/MiniMax_H3.json) | 5279 bytes | `693a0440052b868b140813bdee318d5a4a17684297955c3d21e722cd12ec9c98` |
| [字段配置](../artifacts/reference-0.91-20261001/MiniMax_H3.config.json) | 1779 bytes | `ad3e3a1783c24ffea2dc2cbad7e137d1e4af4c6824511c278cfee0245c9ad082` |

普通/智能画布源码此前的缓存校验值见0.90记录。本轮新增来源收据见 [reference-sources.json](../artifacts/acceptance-0.91-20261001/reference-sources.json)。

## 实现范围

- 1–64个独立片段：提示词、0.5–60秒时长、画幅、百万像素、种子、裁切入出点。可添加、复制、移出、拖动起点、调整右边缘、重排、连续排列、撤销/重做和键盘微调；重叠及无效编辑恢复到原有效值。
- 片段/全局明确参考最多9图、3视频、3音频；控制次序、移出、跨片段拖动引用。同类重复拒绝；引用当前项目素材或同类型相连上游。空参考可继承上游，智能原生配置保留按类型回退规则。
- 播放头、缩放、静音、本机视频预览、历史结果选择与素材抽屉。视频预览被限制在自身面板内，不遮挡时间轴；390px窗口将横向滚动保留在轨道内部。
- 导入本机API JSON后校验真正的 `MiniMaxH3ReferenceToVideo` 及实际相连提示词、ResolutionSelector、时长表达式/PrimitiveFloat和RandomNoise。按控件隐藏/范围限制复查；受控编译 LoadImage、LoadVideo→GetVideoComponents、LoadAudio 及15个参考槽位，保留原模板。
- 「生成当前段」只规划该节点与相连上游；其它分支不提交。确认运行后使用既有本机上传/提交/查询链路。停止、真正重启服务后恢复原 promptId，不重新上传、提交或自动重试不确定结果。
- 结果加入项目时，未改片段、绑定、全局参考、节点文字和上游输入才回填对应片段；所有输出保留为独立结果节点。改选其它片段或仅改裁切不会把结果写入错误片段。
- 当前段/全部片段导出生成独立渲染快照，用真实FFmpeg按顺序拼接视频结果的裁切区间，采用项目画幅/帧率与静音设置。未完成或源区间越界拒绝；原项目分镜、片段和素材保留。
- 普通/智能原生H3读取原始片段及本机素材，核对并明确确认迁移后启用本机绑定，原始参数保留。原生数字节点0的动态引用与生成输出的nodeId分别处理。
- v24工程/选中工作流备份包含全局和逐段参考、全部历史结果、抽屉与模板；恢复、子图插入和复制重映射内部编号。尚未绑定的时间轴同样携带。镜场H3时间轴的原生JSON/ZIP导出明确拒绝，避免静默丢失已编辑片段；未编辑/未迁移的原生H3仍可原样回存。

新增共享H3核心、编辑器与编译/导出模块，接入现有画布计划、生成、结果应用、项目校验、子图/复制、备份及HTTP服务。未新增运行时依赖，正式数据没有加入测试模型、媒体或模板。

## 验证结果

汇总：[result.json](../artifacts/acceptance-0.91-20261001/result.json)。

| 检查 | 结果 | 证据 |
|---|---|---|
| 全量自动检查基线 | **540/540通过**，0失败/跳过，124335ms；在最后的原生导出保护新增测试前执行 | [full-tests-release.log](../artifacts/acceptance-0.91-20261001/full-tests-release.log) |
| 最终H3与原生专项 | **42/42通过**：20项H3与22项原生，包括新导出保护、实际图契约、9/3/3槽位、上传/结果/输入保护、焦点范围、停止/恢复/幂等、原生迁移、v24和真实FFmpeg | [h3-native-final.log](../artifacts/acceptance-0.91-20261001/h3-native-final.log) |
| H3完整隔离Chrome | **18项通过**，三类参考、片段拖动/重排/回退/撤销、实际重启及原编号恢复、对应回填、预览边界、真实裁切拼接、手机布局与原生迁移；模拟提交1、上传3，0第三方请求 | [result.json](../artifacts/minimax-h3-qa-1790853767039/result.json) |
| 收尾重新打开专项 | **4项通过**，从此前失败夹具的复制项目经真实指针点击普通绑定入口，再打开专用入口；2段及参数保留，普通按钮不新增专用DOM属性，0写请求/外部请求/页面错误 | [result.json](../artifacts/h3-reopen-qa-1790854755912/result.json) |
| 原生文件浏览器回归 | **13项通过**，0页面错误/外部请求；尚未迁移H3仍要求专用迁移 | [result.json](../artifacts/native-canvas-qa-1790853447659/result.json) |
| LTX浏览器回归 | **25项通过**，0页面错误 | [result.json](../artifacts/ltx-director-qa-1790853451903/result.json) |
| 最终语法检查 | 通过，退出0 | [full-syntax-final.log](../artifacts/acceptance-0.91-20261001/full-syntax-final.log) |
| 正式服务HTTP | 0.91.0，入口/共享模块/模板及项目路由均200，项目1/任务0 | [live-smoke.json](../artifacts/acceptance-0.91-20261001/live-smoke.json) |
| 正式只读Chrome | **4项通过**，新入口/未绑定编辑器可开关，0写请求/外部请求/页面错误 | [live-browser-smoke.json](../artifacts/acceptance-0.91-20261001/live-browser-smoke.json) |
| 原有业务数据 | **87/87文件SHA-256不变**，0新增/缺失；server.pid排除且未改写 | [data-preservation-0.91-result.json](../artifacts/data-preservation-0.91-result.json) |
| 服务更新 | 核对原PID75627的命令/目录/单监听/0活动任务后仅TERM此进程，启动单一PID99803 | [runtime receipt](../artifacts/runtime-0.91-20261001T114032Z.json) |

42项专项与540项全量有重叠，不能相加为不同测试总数。最后的新增导出保护由专项覆盖；为避免无收益的重型重复，本轮未再跑一遍全量或完整渲染浏览器链路。完整浏览器通过后新增的引用解析由单元专项验证，按钮路由改动由轻量重开专项及正式页面检查验证。

已视觉检查[桌面结果预览](../artifacts/minimax-h3-qa-1790853767039/02-results.png)、[手机时间轴](../artifacts/minimax-h3-qa-1790853767039/03-mobile.png)、[收尾重新打开](../artifacts/h3-reopen-qa-1790854755912/01-reopened.png)与[正式入口](../artifacts/acceptance-0.91-20261001/live-h3-entry.png)。

早期失败日志、夹具和截图全部保留，不计作通过。实际修复含异步保存/关窗的验收同步、视频预览越界，以及普通编辑按钮被临时加专用属性后导致选择器重复。完整浏览器重复检查曾在滚动后的点击超时；未证实其根因，不能声称该超时已被某个代码改动彻底解决。随后使用保留失败项目的副本，在最终代码上验证两条入口均可真实点击重开；没有绕过点击、修改原业务项目或重新生成。本机实时检查脚本的一次失败为把原生fetch的ok属性写成方法，修正脚本后通过，未改产品逻辑。

## 尚未完成的验收和功能

RunningHub专用H3路径的字段、可选输入和云工作流适配仍未实现；已有普通RunningHub或专用模型功能不能替代。H3专用循环字段尚未接入；当前H3步骤不承诺处于循环区域内可执行。真实H3权重、自定义节点、GPU、分辨率/时长支持、推理速度与画质均未验收。

本机参考上限与图字段契约不等于真实模型支持所有媒体、尺寸和时长。每段历史最多100份、抽屉最多1000份；图片≤10MiB、音视频≤150MiB、单次映射合计≤300MiB、输出接收≤150MiB。此为本机限制，不能据此宣称大视频或完整源软件兼容。导出采用项目设置、顺序拼接裁切结果，不保留时间轴空白间隔。

原生循环、智能提示词拆分/LLM、分组聚合及整组输入输出、独立整库备份、批量分类、CLI真实生成、PS连接器和其它参考仓库的完整逐功能审计仍待补齐；真实云账号/权限/收费与第二台物理电脑迁移仍需独立验收。

`agentConfigured:false`仅是对话Agent状态，不代表用户已有火山配置不存在。旧Seedance历史与已检测本机凭据不替代新链路验收，也不构成本轮付费或发送素材授权。
