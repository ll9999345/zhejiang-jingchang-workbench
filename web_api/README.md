# OpenMontage 任务 API

这是浙江文旅工作台使用的最薄 FastAPI 适配层。它只负责请求校验、费用闸门、任务状态代理和 SQLite 元数据持久化；真正的 Ark 请求仍由官方 `tools/video/seedance_ark.py` 完成。

## 安全边界

- `POST /api/tasks/estimate` 只调用 `SeedanceArkVideo.dry_run()`，不会提交任务，也不会发起外部请求。
- `POST /api/tasks` 先做一次 `dry_run`，再以 `task_action=create` 调用工具；只有请求带 `max_cost_cny`、预估费用不超过请求上限和服务端上限时才会提交。
- `GET /api/tasks/{task_id}` 和 `DELETE /api/tasks/{task_id}` 也必须带同一个 `X-Generation-Authorization` 请求头；只有估算和健康检查无需授权。
- 服务端上限由 `WEB_API_MAX_COST_CNY` 设置，默认 `50` CNY。
- 付费提交必须带请求头 `X-Generation-Authorization`，且完全等于环境变量 `WEB_API_PAID_AUTH_TOKEN`。变量缺失或不匹配都会拒绝提交。
- `GET /health` 只返回状态、数据库是否可用、工具可用性和“是否配置授权”的布尔值，不返回任何密钥。
- CORS 只允许 `WEB_ORIGIN`，默认 `http://127.0.0.1:3010`。
- SQLite 文件由 `WEB_API_DB_PATH` 指定；未设置时写入 `web_api/tasks.sqlite3`。任务重启后仍可查询。
- 请求中的 `api_key`、`token`、`authorization`、`secret`、`password`、`credential` 等敏感字段（包括额外字段和嵌套字段）只在当前 provider 调用中保留，不会写入 SQLite。

## 启动

在仓库根目录执行：

```bash
export WEB_API_PAID_AUTH_TOKEN='local-only-token'
uvicorn web_api.app:app --host 127.0.0.1 --port 3011
```

估算请求示例（无需授权头，不会付费）：

```bash
curl -sS http://127.0.0.1:3011/api/tasks/estimate \
  -H 'content-type: application/json' \
  -d '{"prompt":"一段浙江青瓷窑火的镜头","max_cost_cny":5,"model_variant":"mini","duration":5}'
```

提交请求示例：

```bash
curl -sS http://127.0.0.1:3011/api/tasks \
  -H 'content-type: application/json' \
  -H 'X-Generation-Authorization: local-only-token' \
  -d '{"prompt":"一段浙江青瓷窑火的镜头","max_cost_cny":5,"model_variant":"mini","duration":5}'
```

响应中的 `task_id` 是 Ark 返回的 provider task ID。之后：

```bash
curl -sS http://127.0.0.1:3011/api/tasks/TASK_ID
curl -sS http://127.0.0.1:3011/api/tasks/TASK_ID \
  -H 'X-Generation-Authorization: local-only-token'
curl -sS -X DELETE http://127.0.0.1:3011/api/tasks/TASK_ID \
  -H 'X-Generation-Authorization: local-only-token'
```

查询和取消只代理已有工具的 `query` / `cancel` 动作；API 不会把任何 provider 密钥写入 SQLite。

## 本地测试

测试使用内存 fake tool 和临时 SQLite 文件，不读取 keychain、不读取真实密钥、不调用外部 API：

```bash
cd web_api
uv venv --python 3.13 .venv
uv pip install --python .venv/bin/python -r requirements-dev.txt
.venv/bin/pytest -q
```

`uv` 是 Python 依赖和虚拟环境管理器；`pytest` 是测试运行器；`httpx` 在测试中通过 ASGI transport 直接调用本地 FastAPI 应用，不会启动网络端口。
