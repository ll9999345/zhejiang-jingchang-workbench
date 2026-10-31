# 0.31 LoRA 文件与 RunningHub 上传验收

日期：2026-09-29。正式本机服务 `http://127.0.0.1:4768/` 已运行0.31.0，PID41486。原有项目1个、素材0份、任务0条；升级与只读界面检查后，原有80份数据文件逐项SHA-256不变（排除服务日志和PID文件）。

## 本轮交付

- LoRA专用页面、本地分块导入、safetensors结构校验、MD5/SHA-256、全局文件管理及当前项目关联。单文件上限2GiB、文件头16MiB；检查余量，空间不足时不开始创建副本。原文件及失败中间文件不自动清理。
- 官方协议的取得上传地址与实际上传分为两次确认。展示精确平台和存储origin；签名URL仅留在内存，最多5分钟。流式PUT发送原字节，不向存储服务转发API Key；没有自动重试或隐式续传。
- 上传请求先持久化，再发送。重复确认不重复上传；停止、断网、拒绝、重定向、进程重启均不会伪装成成功。重启使未使用地址过期，保留成功记录与不确定上传。
- 工作流发现保留RHLoraLoader节点类型；上传记录可选入对应文字字段。AI应用不提供节点类型时要求用户核对。生成与整个画布预检核对文件、记录、项目和平台，强制使用成功记录的fileName，不重复上传LoRA，不将其当成图片或上游提示词。
- 第6版备份迁移本机文件、成功记录和工作流映射；恢复时重编号，标注历史来源及权限未联网验证。全包上限4GiB、普通媒体合计仍为512MiB。旧v1–v5可读。
- 资产页、任务中心、LoRA缺失引用诊断及使用/报错文档已接入。修复跨项目文件默认选择和平台地址改动导致的输入焦点丢失。

## 验证证据

主要证据目录：`artifacts/runninghub-loras-qa-1790630432735/`。

| 检查 | 结果与文件 |
|---|---|
| 全量自动测试 | 253/253通过，`full-tests.log`；其中LoRA专项12项 |
| 语法检查 | 通过，`syntax-check.log` |
| LoRA浏览器 | 15项通过，`result.json`；包含实际服务进程重启、跨项目恢复、实际PUT原字节、取消和无自动重发 |
| 标准模型浏览器回归 | 21项通过，`standard-models-regression.json`；原件位于`artifacts/runninghub-models-qa-1790630135023/` |
| 旧应用/工作流回归 | 9项通过，`cloud-workflows-regression.json`；原件位于`artifacts/cloud-workflows-qa-1790630136203/` |
| 旧完整备份回归 | 13项通过，`bundle-regression.json`；原件位于`artifacts/bundle-qa-1790629983297/` |
| 桌面/手机视觉检查 | `01-storage-confirmation.png`、`02-completed-upload.png`、`03-bound-lora-field.png`、`04-mobile-restored-receipt.png`；已查看上传确认、绑定与手机恢复页面，390px无横向溢出 |
| 正式服务只读检查 | `live-ui.json`、`live-verification.json`、`live-diagnostics.json`：主画布节点数与实际项目一致、LoRA页正常打开、0页面错误、0写请求、无缺失引用 |
| 原数据保护 | `preservation-before.json`、`final-preservation.json`：80份既有文件不变 |

本轮浏览器功能与云端请求验收使用独立数据目录、纯合成的87字节safetensors容器和本机模拟平台/存储服务。浏览器测试服务器加载`tests/helpers/local-network-only.mjs`，禁止外部请求；没有向真实RunningHub上传文件或提交生成，也没有新增依赖或安装模型。TLS公网分支、真实账户权限、实际LoRA生成及2GiB大文件性能未实测。

正式服务的截图在0.30两次失败后，本轮没有重复该方法；本轮正式服务通过DOM/API只读验收，视觉验收使用隔离服务的真实浏览器PNG，不把两者混为同一证据。

## 本轮失败与修复

1. Mac临时目录存在系统路径别名，最初文件校验错误拒绝合法路径。改为以工作区真实根目录校验文件路径，仍拒绝素材符号链接。
2. 浏览器发现全局文件列表按时间排列时会选中其他项目的文件，导致当前项目上传按钮禁用。改为优先选择当前项目文件，用户仍可显式复用全局文件。
3. 新增平台地址change事件重画参数，焦点切到参数时元素被替换，输入文字落入地址栏。改为只更新LoRA选项的可用状态，不替换参数元素；标准模型回归保留地址和数值断言。网络只到本机，错误地址在提交前拒绝。
4. 测试中的资产页选择器命中两个按钮；改用明确的“资产管理”入口。选项禁用状态的工具判断与DOM不符，通过独立浏览器检查确认属性正确后，测试改读原生disabled属性。未以这些测试故障降低业务断言。

## 来源与未完成边界

- [RunningHub LoRA上传官方文档](https://www.runninghub.cn/runninghub-api-doc-en/api-425761100)：POST `/api/openapi/getLoraUploadUrl`，再PUT原文件；仅供RHLoraLoader使用。文档读取为只读协议核对。
- [safetensors官方格式实现](https://github.com/safetensors/safetensors/blob/main/safetensors/src/tensor.rs)：头长度、UTF-8 JSON、数据类型/形状/偏移校验。本项目独立实现容器检查，不执行模型代码。

仍未达到所有参考项目功能完全整合。主要待补项仍有原生多轮语言/音视频理解、RunningHub文字/三维及独立真人资产转换、条件/反馈循环、更多ComfyUI节点和局域网/认证后端、角色/分镜一致性、Agent质量审核与修复等。正式服务`agentConfigured:false`；本机语言模型和真实GPU/云端账户验收仍未完成。详见`FEATURES.md`和`INFINITE-CANVAS-PARITY.md`。
