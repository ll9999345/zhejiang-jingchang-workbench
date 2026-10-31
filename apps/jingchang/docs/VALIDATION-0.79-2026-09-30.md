# 0.79 验收：RunningHub 三维 GLB 与本机查看

日期：2026-09-30。

## 本轮交付

- 固定官方目录的16项三维型号开放参数配置，复用文字、开关、整数、枚举和有序多图片输入；独立真人资产转换仍保持不可运行。目录可配置项合计416项，不代表每个型号已完成真实平台验收。
- RunningHub查询返回的 `3d` 或 `glb` 输出可以下载并保存为自包含GLB 2.0原文件，最多64MiB。检查实际头、版本、长度、JSON/BIN段、网格和本地资源范围；错误格式、外部纹理/缓冲资源和含本次密钥的结果不会进入素材库。
- 云工作流结果可预览、下载和放入场景节点；场景节点可以绑定三维标准模型，按原有逐节点服务/预算/字段授权运行，输出类型不匹配在提交前拒绝。没有把三维文件标记成图片。
- 本机GLB导入接入素材库和「三维」筛选，上传后不触发任何模型请求。新读取接口检查普通文件、大小和实际内容，拒绝符号链接与被改变的文件。
- 独立本机预览提供旋转、平移、缩放、复位、线框和原文件下载；桌面、390px手机均可使用。three.js 0.186.1以免费MIT项目内依赖安装于 `node_modules/three`，所需浏览器模块及许可证保存于 `public/vendor/three`，不依赖CDN。
- 中断后保留原RunningHub任务编号；用户明确恢复只查询原任务和重新下载，不重新生成。结果文件保存后使用既有结果判重。
- v14完整备份保留三维原文件、场景关联和模型绑定，导入重映射后可继续查看。旧格式保留原有能力；删去三维输出标记不能伪装为旧版配置。GLB内容在备份导出和导入时重新校验。

## 验证结果

- `npm test`：389/389通过；`npm run check`通过。新增8项三维文件/目录/原任务恢复/画布/备份与伪旧版拒绝测试，保留全部既有回归。
- 三维浏览器10项通过，验证真实本机GLB渲染、旋转后的画面变化、线框/复位、原字节下载、手机控制和布局、场景回填、画布执行、v14备份、实际隔离服务重启与原任务恢复、错误文件拒绝和密钥不落盘。
- 既有RunningHub标准模型浏览器22项回归通过，保留图片、视频、音频、文字、字段参数、上传、授权、绑定、备份与手机流程。
- 正式服务 `/api/health` 返回0.79.0、`agentConfigured:false`、`model:null`，正式任务0。原有85份业务文件逐份SHA-256校对不变，无新增正式业务文件。

## 留存证据

- 三维浏览器：`artifacts/model3d-qa-1790751194156/result.json`。同目录包含桌面/手机预览截图、实际下载的合成GLB和完整备份。
- 既有RunningHub回归：`artifacts/runninghub-models-qa-1790750807032/result.json`。
- 数据保护：`artifacts/data-preservation-0.79-before.json`、`artifacts/data-preservation-0.79-result.json`。

## 尚未完成

所有生成请求仅发给本机模拟服务，使用合成GLB、图片和测试密钥，没有调用真实RunningHub、使用用户API Key、付费或上传用户素材。实际账号权限、16型号的真实输出类型和三维质量仍待具体服务、预算和发送范围授权后验收。

当前仅接收自包含GLB 2.0；OBJ/FBX/STL/ZIP、外部纹理文件、压缩网格解码、动画播放控制、三维编辑和三维生成输入尚未实现。目录开放参数不等于所有三维结果格式通用。

其他GitHub参考仓库尚未逐仓逐功能验收；独立真人资产、方舟/APIMart更多能力、条件/反馈/嵌套循环、CLI任务及真实云/GPU仍有缺口。整体整合目标未完成。

字段/查询结构依据固定的[官方模型目录](https://github.com/HM-RunningHub/ComfyUI_RH_OpenAPI/blob/8f9c858e7e631a1c1c49df0c4defd77fdd690dd4/models_registry.json)、[任务查询处理](https://github.com/HM-RunningHub/ComfyUI_RH_OpenAPI/blob/8f9c858e7e631a1c1c49df0c4defd77fdd690dd4/core/task.py)与[官方三维接口](https://www.runninghub.cn/runninghub-api-doc-en/api-448184464)；本机文件格式与查看使用[glTF 2.0规范](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html)和[three.js](https://threejs.org/docs/)。本轮没有运行或移植上游插件代码，GLB支持范围是镜场自身的明确约束。
