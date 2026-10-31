# 0.62 验收记录

日期：2026-09-30  
范围：对照 Infinite Canvas 固定提交 `67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e` 的 Chrome 素材采集器跨 frame 扫描能力，增加可选的跨域 iframe 来源授权。

## 实现

- 扩展设置增加“扫描跨域 iframe”选项，默认关闭并保存在扩展本地设置中。
- 勾选时，扫描当前网页的主 frame 并提取其直接 iframe 的 HTTP/HTTPS 来源；重复来源合并，最多请求12个站点的可选权限。
- 用户拒绝授权或浏览器无法提供该权限时，仍继续扫描当前可访问的页面框架。
- 没有新增静态网页访问权限；既有 `http://*/*` / `https://*/*` 仅为可选权限声明，只有用户明确开启此选项后才请求 iframe 来源权限。

## 验收结果

- `npm run check` 与 `node --check lib/workspace.mjs`：通过。
- `npm test`：330 项通过，0 项失败。
- 隔离 Chrome 页面扫描：25 个断言通过，11 项候选素材；iframe 来源重复去重并只输出允许的 HTTP/HTTPS 主机模式。测试拦截所有示例外部域名请求。
- Chrome 导入 API：2 项通过。
- 本机服务健康检查：版本 `0.62.0`，`agentConfigured=false`，保留1个项目，生成任务数为0。
- 未使用 API Key、没有调用模型或访问第三方素材。

## 尚未验收

- 扩展未安装到用户 Chrome，因此实际权限弹窗、跨域 frame 注入和素材导入仍未端到端验证。
- 站点最多请求12个，范围为主页面直接列出的 frame 来源；被网站策略、Chrome 扩展策略或权限拒绝的 frame 仍不可扫描。
- 网络请求嗅探、模型智能分类、HLS/DASH 分片下载/合并、Photoshop 连接器和 CLI 集成仍未实现。Infinite Canvas 与其他参考项目的全部功能整合仍未完成。
