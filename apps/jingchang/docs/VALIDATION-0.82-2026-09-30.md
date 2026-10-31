# 0.82 本地验收记录

日期：2026-09-30。正式本地服务已更新为0.82.0，地址为 `http://127.0.0.1:4768/`。本轮补齐火山素材库的明确接口流程；**全功能整合目标仍未完成**，真实云账号、授权函、公网文件和生成质量未验收。

## 交付

- 画布资产页和创作台素材库均有“火山素材库”入口。打开入口只查本机记录，不自动联系火山或填入凭据。
- 按当前官方北京素材库地址实现AK/SK V4签名。创建AIGC素材组、按公网URL入库、原编号GetAsset查询、分页查看已有素材组/素材、保存到本项目。
- 入库前可关联当前项目本机MP4/MOV，实际检查大小、SHA-256、宽高、时长、平均帧率、音轨和解码。这个检查不证明公网文件相同，也不把本机文件自动托管到公网。
- 预览与单次发送分别确认。创建按项目/requestId去重；丢失连接、非JSON与重定向等不明确结果保留“待确认”，不跟随重定向或自动补发。HTTP200仍可能是素材处理Failed，不能视为成功。
- Processing素材不能引用。查询为Active后，可将 typed `asset://` 引用保存到Seedance 2.0多素材创作台，再经原有预算/原文件确认发起生成，下载并回填画布。
- AK/SK不保存到磁盘、日志或浏览器存储；每次完成后清空输入。平台返回的签名访问URL与原始错误正文不返回、不读取、不保存。
- 完整备份扩展到第16版，包含素材库状态、原平台编号和关联本机依赖，恢复时重映射本机编号。恢复记录标记需重新查询；不迁移云账号、凭据或公网托管。
- 修复刷新后过早打开使用记录时的加载时序。修复主画布样式影响素材库长表单滚动的问题，手机端表头保留、表单内部可滚动。

## 验证证据

| 检查 | 结果 / 证据 |
|---|---|
| 全量自动测试 | 413/413；`/tmp/jingchang-0.82-test-release.log` |
| 语法检查 | 通过；`/tmp/jingchang-0.82-check-release.log` |
| 新素材库浏览器链路 | 10项；`artifacts/ark-assets-qa-1790770900500/result.json` |
| 方舟多素材回归 | 12项；`artifacts/ark-reference-qa-1790770899404/result.json` |
| 创作画布回归 | 19项；`artifacts/canvas-studio-qa-1790770656168/result.json` |
| 图片API回归 | 10项；`artifacts/image-api-qa-1790770656694/result.json` |
| 浏览器合计 | 51项；新增素材库和方舟参考回归无页面异常/外部媒体请求，创作画布回归无页面异常 |
| 正式页面 | 内置浏览器实读：工作台渲染、3个原节点、资产页新入口、素材库打开、AK/SK空白、无素材库记录；未发起入库/查询/生成 |
| 正式服务 | `ok:true`、`version:0.82.0`、`agentConfigured:false`、`model:null`；无活动生成任务 |
| 原有数据 | 85份业务文件SHA-256逐一保持不变，无新增业务文件；`artifacts/data-preservation-0.82-before.json`、`artifacts/data-preservation-0.82-result.json` |

新增8项后端测试覆盖固定多字节签名向量、目的地限制、独立确认、指纹失效、并发去重、错误/不确定提交、真实媒体格式约束、原编号恢复、分页选取、凭据不落盘以及v16恢复/伪造旧格式拒绝。浏览器使用隔离数据目录、自己持有的loopback模拟服务、合成蓝色视频与合成音轨；模拟素材URI最终到达一次生成请求，返回的真实MP4能解码，并回填原画布。测试用字符串不代表用户提供了真实API Key或AK/SK。

![本机模拟服务中的素材可用与引用](/Users/mjd-ppps/生视频/镜场Agent/artifacts/ark-assets-qa-1790770900500/02-active.png)

## 参考与限制

本轮重新只读取主参考固定提交的根 `main.py`：880740 bytes，SHA-256 `2e0b1f0903d809715d92a982b849674a59292e7a89f3c2b7dbc44fd130080e8e`。核对素材库辅助实现及资产注册/查询入口，没有执行上游代码。

官方接口来源：[CreateAsset](https://docs.volcengine.com/docs/ark/create-asset-api?lang=zh)、[CreateAssetGroup](https://docs.volcengine.com/docs/ark/create-asset-group-api?lang=zh)、[GetAsset](https://docs.volcengine.com/docs/ark/get-asset-api?lang=zh)、[ListAssetGroups](https://docs.volcengine.com/docs/ark/list-asset-groups-api?lang=zh)、[ListAssets](https://docs.volcengine.com/docs/ark/list-assets-api?lang=zh)、[官方签名实现](https://github.com/volcengine/volc-sdk-golang/blob/main/base/sign.go)。

正式CreateAsset只支持公网URL，不支持Base64。镜场没有自动公网托管、图床上传或公开本机服务。CreateAssetGroup首次所需授权函和真人活体认证须用户在平台完成，本轮没有替用户签署、登录或接受协议。

本机视频检查上限150MB，比官方200MB更严格；图片/音频沿用本机现有格式和更小限额，未覆盖全部图片格式及16–30秒音频。未接入素材列表NextToken深分页、平台组/素材更新删除、Seedance 2.5完整参数。未经实际云端核实的手工asset URI，其格式、时长、账户和项目权限仍由上游检查。真实账户、费用、公网文件一致性、模型质量与所有其他参考项目逐项等价均不在此次本地证据中。
