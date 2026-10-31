# 0.74 LTX 剪贴板图片导入验收

日期：2026-09-30

依据 Infinite Canvas 固定提交的 [LTX Director 剪贴板粘贴处理](https://github.com/hero8152/Infinite-Canvas/blob/67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e/static/js/ltx-director-timeline.js#L3876-L3903)，在鼠标停留于导演编辑区时读取剪贴板图片并导入时间线。镜场仅接收 PNG/JPEG/WebP、单张不超过10MB，时间线最多64个画面片段。新片段从播放位置开始；若与已有片段冲突，则顺延到后续空位。批量粘贴先预检容量和空位，导入与插入合并为一次可撤销的本地编辑；提示词或文件输入等控件有焦点时不会拦截普通粘贴。

验收结果：

- `npm run test:ltx-director-browser`：25 项隔离 Chromium 检查通过，包含系统剪贴板事件、项目素材导入、播放位置后的片段创建、冲突避让和单次撤销。
- `node --test tests/ltx-director.test.mjs`：14/14 通过。
- `npm test`：357/357 通过；`npm run check`：通过。
- 未读取 API Key、调用 ComfyUI、真实生成模型或使用 GPU。

范围限制：此功能补齐的是 LTX 编辑器中的本地剪贴板图片路径；不会因此证明外部 LTX 插件、模型或 GPU 可运行。其他 GitHub 参考仓库仍未逐仓逐功能审核。
