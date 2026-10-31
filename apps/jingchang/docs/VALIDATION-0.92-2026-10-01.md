# 0.92 RunningHub H3 专用时间轴验收

日期：2026-10-01。正式本机服务为 **0.92.0**，单一监听 PID **13878**，地址 `http://127.0.0.1:4768/`，既有项目1、正式任务0。功能完成本机协议、Chrome及FFmpeg检查；正式服务、页面和原数据核对通过。没有付费调用、第三方素材上传、真实模型/GPU或公开部署。整体整合目标未完成。

入口：画布「＋」→「MiniMax H3 时间轴」，或视频节点检查栏→「MiniMax H3 分段时间轴」，选择「RunningHub」。API JSON导入只保存本机；在线查询须明确站点／编号和查询授权，生成另行确认。

固定来源：[提交67f49e4](https://github.com/hero8152/Infinite-Canvas/commit/67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e)的普通/智能H3与main.py 12644起。校验缓存大小／SHA-256见[reference-sources.json](../artifacts/acceptance-0.92-20261001/reference-sources.json)。未运行上游代码。参考[RunningHub高级提交](https://www.runninghub.cn/runninghub-api-doc-cn/api-425749013)和[上传说明](https://www.runninghub.ai/runninghub-api-doc-en/api-425761099)，整图 `workflow` 字段依固定上游形态实现；真实端点/账号接受性仍未验证。

## 实现

- 双引擎时间轴，独立片段、全局和逐段9图3视频3音频参考；切换／解除绑定保留已有片段、参考、裁切、结果和抽屉。
- 导入或授权查询实际H3整图，匹配真实参数和媒体输入，不虚构云节点。按类型/顺序选择已有槽位，移除未选可选参考的私有分支，保留共享依赖；必选缺失和共用输入拒绝。原模板保留。
- 逐节点整图/素材/字段/预算确认，生成当前段及上游；真实本机多部分上传后，平台文件标识同时进入字段和整图。重复请求去重，回复不确定不自动重发。
- 原编号停止/重建/服务重启恢复，已提交素材和整图不重发。结果按未改的原片段输入及绑定版本保护回填，并保留独立结果。
- 原生云端H3明确迁移，保留源参数。v25工程和选中工作流备份保持完整图/profile/绑定和全部素材，恢复/子图/复制重映射；云H3裁切导出使用真实本机FFmpeg独立快照。
- 正常云页面也显示整图范围，查询更新其对应整图而保留H3配置；普通无整图的模型/应用/工作流保持原协议。新功能未增加运行时依赖。

## 验证结果

汇总：[result.json](../artifacts/acceptance-0.92-20261001/result.json)。测试集合有重叠，不相加。

| 检查 | 结果 | 证据 |
|---|---|---|
| 全量自动检查 | **559/559通过**，0失败/跳过，71147ms；最后追加带认证地址的图校验前执行 | [full-tests-release.log](../artifacts/acceptance-0.92-20261001/full-tests-release.log) |
| 最终H3/云/原生专项 | **75/75通过**，0失败/跳过，10245ms；包括认证地址拒绝、全部新图功能、预算/范围、素材上传、动态参考、回填、恢复、v25及真实FFmpeg | [graph-credentials-final.log](../artifacts/acceptance-0.92-20261001/graph-credentials-final.log) |
| 最终语法 | 通过，退出0；未新增运行时依赖 | [full-syntax-final.log](../artifacts/acceptance-0.92-20261001/full-syntax-final.log) |
| RH隔离Chrome | **14项通过**，真正服务重启及原编号恢复、手机、原生迁移、普通云页面及重拉整图；本机模拟提交2次/上传4份/查询工作流2次，0外部请求 | [result.json](../artifacts/minimax-rh-qa-1790859265216/result.json) |
| ComfyUI H3浏览器回归 | **18项通过**，真实FFmpeg裁切拼接及服务重启；本机模拟提交1次/上传3份 | [result.json](../artifacts/minimax-h3-qa-1790858841428/result.json) |
| 原生画布浏览器回归 | **13项通过**，独立JSON/ZIP、真实媒体、迁移/恢复和手机 | [result.json](../artifacts/native-canvas-qa-1790859478277/result.json) |
| 普通混合画布浏览器回归 | **11项通过**，本机→普通云→本机、授权、停止/恢复和密钥不落盘 | [result.json](../artifacts/mixed-canvas-qa-1790859538414/result.json) |
| 正式服务HTTP与只读Chrome | **5项浏览器检查通过**，各HTTP地址200；无写请求/外部请求/页面错误，项目1/任务0 | [HTTP](../artifacts/acceptance-0.92-20261001/live-smoke.json)、[Chrome](../artifacts/acceptance-0.92-20261001/live-browser-smoke.json) |
| 数据保护 | **87/87原业务文件SHA-256不变**，新增/缺失/变化0，PID标记未编辑 | [结果](../artifacts/data-preservation-0.92-result.json) |
| 本机运行收据 | 正式0.92.0，PID13878，唯一监听4768；重启前逐项核对目录、命令、监听、无任务和文件校验 | [运行收据](../artifacts/runtime-0.92-20261001T130816Z.json) |

源码、测试和浏览器验证均在当前镜场项目完成，测试媒体、模板和任务只在隔离目录。正式页面截图为[RunningHub入口](../artifacts/acceptance-0.92-20261001/live-h3-entry.png)。

首次全量558/559通过；新增测试未带必填 `overrides:[]`，先触发一般参数检查。补正后最终全量559/559和相关专项通过。前两次RH浏览器脚本分别在模拟提交数量断言和已关闭弹窗的点击处退出，落盘原任务与已完成检查保留；调整等待条件后完整链路通过，未把失败结果作通过证据。旧日志及失败目录保留。

### 凭据与模型边界

工作流字段、图内容和带认证地址拒绝保存；本次真实查询/生成密钥只留在请求内存，执行或查询后清空。测试使用自有合成标识，检查未进入持久化目录，不是生产Key。正式健康报告 `agentConfigured:false,model:null` 仅指主Agent语言模型未配置，不代表用户已有的火山账号/视频凭据不存在；本轮未使用它们调用服务。

## 未完成边界

真实RunningHub端点是否接受整张图、账号权限、余额及H3模型/GPU效果仍未验收；无真实付费生成或第三方上传。H3专用循环参数及其它原生循环/拆分/聚合/整组传递、独立整库备份等整体缺口继续保留。
