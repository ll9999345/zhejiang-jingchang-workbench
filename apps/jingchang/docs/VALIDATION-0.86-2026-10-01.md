# 0.86 Midjourney操作与备份验收

2026-10-01。以用户指定的Infinite Canvas固定提交`67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e`为主要基准，按公开功能和请求契约独立实现Midjourney链路；没有调用LibTV/RunningHub的Agent，也没有复制该项目的实现代码。

## 本轮交付

- 14种操作：文生图/参考图生成、多图融合、图片编辑、选图放大、普通/微调/大幅变体、重新生成、缩放/平移扩图、局部重绘入口/遮罩补参、轻度/强度重塑。
- 速度、文生图版本、自定义1–99宽:高、图片序号、扩图倍数/方向、原任务编号及可选按钮编号。局部重绘入口按单图任务处理，不发送选图序号。
- 创作台和普通画布图片节点均可配置。多图融合可无提示词，固定或本轮上游图片传入；输出1–4份图片均保存并可回填、下载。
- 两步重绘独立授权。`MODAL`保存为`awaiting_input`，停止查询和下游执行；继续按钮只载入新编号/原目的地。白色区域遮罩转换为alpha，原生alpha PNG保持原字节。
- 任务编号一致性、未知状态/失败、停止后恢复、重启与当前连接改变后仍查原快照、重复提交去重、平台按钮纯文字展示。
- v19完整备份。创作台、节点绑定和本机参考图片恢复到新编号，不迁移凭据/任务/执行授权，也不会自动提交。
- 更正对照表：固定根后端唯一`fileData`是9936行的图片URL，没有发现Gemini File API上传实现，故不再将该能力列为此固定版已核实的复刻要求。

## 验收证据

| 检查 | 结果与证据 |
|---|---|
| 全量自动测试 | **457/457通过**，无失败/跳过，119.14秒；[日志](../artifacts/acceptance-0.86-20261001/automatic-tests.log) |
| Midjourney补充测试 | **9/9通过**，覆盖14种操作、原图字节、自定义7:5、1/4图、四宫格回退、可选按钮编号、两步遮罩真实alpha像素、错误/矛盾编号、断流不重发、画布停止/仅查询恢复、独立空白工作区v19恢复；[日志](../artifacts/acceptance-0.86-20261001/midjourney-tests.log) |
| Midjourney浏览器 | **13项通过**：实际连接/操作表单、390px确认/绑定表单、生成→单图放大→重绘入口→遮罩补参、四图解码/下载/回填、重启/原地址恢复、画布/备份导入、按钮转义、无外部请求；[结果](../artifacts/midjourney-qa-1790829753953/result.json) |
| 原有火山配置回归 | **13项通过**，只用合成凭据及官方URL映射到本机服务；[结果](../artifacts/ark-credentials-qa-1790829227752/result.json) |
| 原有混合画布回归 | **19项通过**，Gemini图片→方舟首帧视频→ComfyUI媒体传递、停止/实际重启/原任务恢复、结果解码播放和回填；[结果](../artifacts/canvas-studio-qa-1790829227555/result.json) |
| 语法 | `npm run check`通过；最后表单样式修正后的目标文件也再次检查，最终完整检查通过；[日志](../artifacts/acceptance-0.86-20261001/syntax-check.log) |
| 既有数据 | **88/88份文件SHA-256不变**，无新增/缺失业务文件；[结果](../artifacts/data-preservation-0.86-result.json) |
| 正式服务 | **0.86.0**，127.0.0.1:4768，PID17025；[运行记录](../artifacts/runtime-0.86-20261001-124537.json) |

浏览器合计45项。Midjourney验收只向本机模拟接口提交5次：融合、单图放大、重绘入口、遮罩补参、画布融合；原图片为本机生成的240×160 PNG，遮罩另用2×1黑白PNG核对真实alpha像素。四份结果不代表云端画质，旧式单张四宫格也不拆成四个独立结果。普通画布动态参考使用上游首份结果，所有输出仍保留可下载/回填。

前两次浏览器运行因测试脚本用错“添加参考”和项目库“导入备份”的入口定位而未完成；已按现有页面入口修正并完整重跑。视觉检查还发现通用画幅标签的CSS覆盖`hidden`，已修正为Midjourney只显示自定义画幅，390px复验通过。失败记录保留，没有删除测试目录或修改正式数据。

Midjourney浏览器进程与其Node服务均限制为本机网络。火山回归只将合成凭据用于映射到自有loopback的固定官方地址；其余混合画布也使用本机模拟接口。所有任务输出下载不带API Key，任务/项目/备份/浏览器存储和服务日志中没有测试凭据；没有提取用户的钥匙串密钥、向第三方发送用户素材或做付费生成。

## 功能依据与范围

固定版本根后端`main.py`的14051–14363行含操作表、生成/二次操作/补参及任务查询。缓存源文件880740字节，SHA-256为`2e0b1f0903d809715d92a982b849674a59292e7a89f3c2b7dbc44fd130080e8e`；见[汇总收据](../artifacts/acceptance-0.86-20261001/result.json)。此外只读核对APIMart官方[操作总览](https://docs.apimart.ai/cn/api-reference/images/midjourney/generation)、[查询](https://docs.apimart.ai/cn/api-reference/images/midjourney/query)、[重绘入口](https://docs.apimart.ai/cn/api-reference/images/midjourney/inpaint)和[补参](https://docs.apimart.ai/cn/api-reference/images/midjourney/modal)。

实际平台版本、按钮是否有效、模型权限、费用、排队/超时、图片质量均未验收。本机尺寸/字节限制仍适用，不能将大文件素材库上限当作生成模型的输入上限。原任务编号需同一服务/账号权限。镜场使用用户填写的目的地，不自动改为另一地址；Midjourney不会读取或借用火山已有密钥。

更新前按监听PID、命令、工作目录、0.85健康状态及空任务列表确认属于本项目，随后正常停止该空闲进程，启动一个独立0.86服务。没有停止或修改文旅后端、安装依赖、删除文件或覆盖个人数据。正式任务为0；`agentConfigured:false`/`model:null`仅表示本机规划语言模型未配置。火山状态为`configured:true/source:macos-keychain/checkedWithoutReadingSecret:true`，只证明存在配置。

全部参考项目整合目标仍未完成；当前缺口以[功能对照](FEATURES.md)及[固定版对照](INFINITE-CANVAS-PARITY.md)为准，不能把本轮Midjourney接线及本机测试当作真实云端或整套Agent已验收。
