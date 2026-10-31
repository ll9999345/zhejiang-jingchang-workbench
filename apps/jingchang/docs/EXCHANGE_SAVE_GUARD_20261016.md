# 2026-10-16 文旅交换前的保存保护

`public/exchange-save-guard.js`由`public/app.js`安装。仅对实际本机嵌入父窗口响应保存确认；不传递工程内容、密钥或媒体。先执行现有save，等待写入后才回复。编辑弹窗、版本冲突或工程切换阻断交换。

配套文旅`backlot/ui/canvas.js`先确认保存，再导入或切换父页面作品；等待时阻止iframe输入，超时不强制刷新。兼容4750挂载画布和4768独立iframe。

6项保护测试、两种实际浏览器交接各4项通过。文旅本机初剪与镜场剪辑/真实MP4播放下载分别9、17项通过；未调用云模型，未修改原作品。

完整收据、失败复现、截图与限制见：
`/Users/mjd-ppps/生视频/浙江文旅AI视频引擎V2/docs/defense-evidence/records/2026-10-16-canvas-save-handoff/README.md`
