# 0.64 验收记录

日期：2026-09-30  
范围：参照 Infinite Canvas 固定提交 `67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e` 的 Codex、Gemini CLI 与即梦 CLI 本机状态接口。上游入口见 [CLI README](https://github.com/hero8152/Infinite-Canvas/blob/67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e/CLI/README.md) 与 [固定版服务端](https://github.com/hero8152/Infinite-Canvas/blob/67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e/main.py)。

## 实现

- 新增 `GET /api/codex/status`、`GET /api/gemini-cli/status`、`GET /api/jimeng/status`。
- 在原有“本机诊断与文件位置”面板展示三个 CLI 的本机状态。
- 只查找 PATH 或显式环境变量里的程序文件；支持 Windows `PATHEXT` 和 Gemini/Antigravity 命令名；WSL 即梦模式只报告 WSL 入口，不伪装成已检测 WSL 内程序。
- 不执行任何 CLI，不读取登录凭据，不探测登录状态，不查询即梦积分，不安装或启动服务。

## 验收结果

- 新增的 4 项本机 CLI 状态专项测试通过，覆盖 PATH 查找、Windows 扩展名、显式路径、WSL 即梦状态边界。
- `npm test`：339 项通过，0 项失败。
- `npm run check`：通过。
- 正式本机服务 API 检查：`/api/health` 返回版本 `0.64.0`；三个状态接口和 `/api/diagnostics` 均返回 200。
- 隔离浏览器检查通过：从“API 平台与模型”打开诊断，三条 CLI 状态均显示、边界说明可见、无页面错误。
- 正式服务仍保留 1 个项目、0 个任务；本轮没有调用模型、发送素材或新增生成任务。

## 尚未实现

- CLI 版本检测、登录/帮助/安装操作和实际调用仍未接入。
- Codex/Gemini 对话与生图、即梦图片/视频生成、额度查询、任务轮询/恢复及结果入库尚未实现。
- 上游即梦状态接口会查询积分；镜场有意不在打开诊断时触发该账户查询。后续若实现，必须由用户主动点击并说明查询内容。
- 本机状态只证明程序文件可查找，不证明 CLI 能运行、已登录、账户有额度或模型可用。

