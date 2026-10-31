# 0.75 验收：RunningHub 文字结果

## 改动

- 将固定 RunningHub 模型目录中的 51 个 `output_type:string` 项纳入可配置目录；原有独立真人资产等能力限制仍会阻止需要额外转换的型号。
- 查询器接受 `results[].text`，以及没有内嵌文字时的结果 URL。URL 下载沿用本机 SSRF 防护，仅允许公共 HTTPS 或测试/本地回环地址；响应限制 4 MiB、UTF-8、文字 MIME 与 200,000 字符，结果保存为 `text/plain` / `.txt`。
- 云任务可预览和下载文字，并能把结果加入主画布作为文字节点。RunningHub `string` 模型可绑定文本或剧本节点，运行后将完整文字传给后续云节点。
- 子结果按索引记录；失败恢复时查询原任务，跳过已保存结果，不会重新提交生成。
- 保留旧任务回填路径；新文字文件加入项目资产库时不生成错误的图片节点。

## 验证

- `node --test tests/runninghub-models.test.mjs tests/cloud-workflows.test.mjs tests/canvas-cloud.test.mjs`：31/31 通过。
- `node tests/runninghub-models-browser.mjs`：22 项隔离 Chromium 检查通过，覆盖模型筛选、内嵌文字和 TXT 结果呈现/回填，以及既有图像/视频/音频及动态画布回归。
- `npm run check`：语法检查通过。
- 所有新请求都指向本机模拟 RunningHub 服务，使用合成测试密钥与内容。未读取用户 API Key，未向真实 RunningHub 或模型服务发送请求，没有真实计费/质量验收。

浏览器产物：`artifacts/runninghub-models-qa-1790716707517/`。

协议依据：[RunningHub 查询任务结果 V2](https://www.runninghub.cn/runninghub-api-doc-cn/api-425767306)、[官方任务响应 schema](https://www.runninghub.cn/runninghub-api-doc-cn/schema-252329734)。官方模型请求/查询示例仍不能证明每个目录型号的实际行为。

## 未完成

三维结果、独立真人资产转换，以及目录型号逐项账号权限、费用和真实生成行为仍未实现或验收。本次不代表用户之前提供的其他 GitHub 项目功能都已完成。
