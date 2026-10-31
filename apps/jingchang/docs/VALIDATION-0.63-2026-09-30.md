# 0.63 验收记录

日期：2026-09-30  
范围：对照 Infinite Canvas 固定提交 `67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e` 的 Chrome 采集器 XHR/fetch 媒体请求发现能力；固定版说明见 [Chrome Local Asset Importer](https://github.com/hero8152/Infinite-Canvas/blob/67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e/tools/chrome-local-asset-importer/README.md)。

## 实现

- 采集面板增加“监听网络视频（60秒）”。用户点击后才请求可选的 `webRequest` 权限和最多12个扫描时已知的网页来源；权限声明不是安装时必需权限。
- 后台只处理当前标签页的 `media`、`xmlhttprequest`、`other` 响应，并确认其请求来源、发起页面和捕获有效期均符合本次授权范围。
- 只读媒体响应 URL 与 `Content-Type` 来发现 MP4、WebM、MOV、M4V、FLV 和 HLS/DASH 清单；过滤失败响应、登录 HTML、无关二进制及常见分片类型。
- 不读请求/响应正文、Cookie 或鉴权头；包含临时签名参数的候选 URL 只在扩展后台/面板内存中暂存。用户选中导入时，素材才会被发送到镜场本机服务；下载/导入沿用既有的用户确认流程。面板关闭、手动停止或60秒到期会终止监听并清除候选。

## 验收结果

- `npm run check`、`npm run check:chrome-importer`、`node --check lib/workspace.mjs`：通过。
- 网络响应分类与授权范围测试：5项通过；后台 worker 授权/停止模拟：1项通过；Chrome 导入 API：2项通过。
- 隔离 Chrome 页面扫描：25个断言通过，11项候选素材；测试拦截示例外部域名请求。
- `npm test`：335项通过，0项失败。
- 正式本机服务健康检查：版本 `0.63.0`，`agentConfigured=false`，保留1个项目，生成任务数为0。
- 未使用 API Key、没有调用模型、访问第三方素材或把素材上传至第三方。

## 尚未验收与限制

- 扩展没有安装到用户 Chrome；隔离 Playwright Chrome 未暴露扩展后台 worker，因此不能据此确认浏览器实际加载。真实 `webRequest` 权限提示、Chrome 响应事件和真实网页下载/导入尚未端到端验证。当前授权会保留在 Chrome 扩展权限设置中，用户可在 Chrome 管理扩展页撤销；本功能的监听自身在面板关闭或计时结束后停止。
- 监听权限最多覆盖扫描时已知的12个来源，因此未知或页面运行时才出现的 CDN 请求可能漏检；未获权限的请求不会被观察。MSE 分片、DRM 视频和不支持的分片格式不能因此变成可下载的视频。
- 智能分类、Photoshop 连接器与 CLI 集成仍未实现；Infinite Canvas、LibTV、RunningHub 等参考项目的全部功能仍未整合完成。
