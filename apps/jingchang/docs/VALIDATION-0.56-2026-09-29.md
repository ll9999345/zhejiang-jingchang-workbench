# 0.56 验收记录

日期：2026-09-29

## 本轮改动

- 新增 `GET /api/assets/page`，支持全局或当前项目范围、素材类型、分类、名称/标签搜索和偏移分页；返回当前页、筛选后的总数、源范围总数和分类选项。页面每次最多请求48项，接口上限为100项。
- 旧 `GET /api/assets` 保留，兼容对话素材引用等原有调用。
- 素材列表不再为翻页、筛选和搜索下载整份素材元数据。全局图片预览会先打开当前素材，再后台补齐完整列表用于跨页切换。
- 修正元数据保存后的重复列表刷新请求。

## 验收结果

- `npm test`：326/326 通过。
- `npm run check`：通过。
- `node --test tests/assets-page.test.mjs`：1/1 通过，覆盖分页、类型/分类/搜索、项目范围、无效参数、未知项目及旧路由兼容。
- `node tests/assets-pagination-browser.mjs`：9项浏览器检查通过；100份隔离素材、分页筛选、搜索、预览跨页导航和手机宽度均通过，记录到0次外部请求。
- `node tests/media-viewer-browser.mjs`：13项通过；媒体预览、批次切换、尺寸/提示词、下载、定位和手机滑动通过，记录到0次供应商请求。
- `node tests/media-viewer-zoom-browser.mjs`：7项通过。
- `node tests/prompt-mentions-browser.mjs`：7项通过。
- `node --check public/app.js` 与 `node --check server.mjs`：通过。
- 本地服务重启后健康检查为 `0.56.0`；原有项目仍为1个、生成任务为0个，项目素材分页接口返回HTTP 200。Agent 未配置。

测试数据使用临时隔离工作区；没有读取或使用真实 API Key，也没有向模型或第三方服务提交任务。

## 边界与未完成项

- 全局分页查询仍会扫描磁盘素材元数据文件；持久化索引及真正的虚拟滚动未实现。
- Infinite Canvas 与其他参考项目仍有明确未完成项，包括 CLI、Chrome/Photoshop 连接器、条件/反馈执行、部分原生多模态协议，以及真实账户、云模型和 GPU 验收。不能据本地测试宣称全部功能已复刻。
