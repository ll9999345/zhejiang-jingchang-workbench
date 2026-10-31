# 网页版 GPT-6 开屏接入留痕

日期：2026-10-09。来源聊天：<https://chatgpt.com/c/6ac7e2f7-0938-83e9-84bd-05f18e5c21d0>。

原始文件来自 `/Users/mjd-ppps/Downloads/Zhejiang_FieldNotes_Interactive_Preview.html`。本目录保存其完整副本和接入前的真实首页 `index.before.html`，SHA-256 见 `SHA256SUMS`。原预览未附独立许可声明；本记录注明来源，不新增许可断言。

## 提取范围

- `opening.css`：原预览第二段 style（原文件 172–431 行），保持样式、文案编排与章节动效。
- `terrain.js`：原预览第一段 script（478–699 行），保持原 WebGL2 / Canvas2D 地形与释放逻辑。
- `opening.js`：原预览第二段 script（700–957 行），保留品牌叙事、内嵌 SVG、虹膜交接、跳过、重播、会话标记和低动态静态页。
- 第一段 style 与第三段 script 属于假演示 UI / 假项目交互，未作为真实项目资源引用。

完整源副本只用于追溯。真实首页仅引用三个提取文件，并在现有 `studio.js` 之后加载两个脚本。首页的原业务节点、ID、脚本与引用保持接入前字节内容；测试用去除三条新引用后的全文比较验证这一点。

## 最小可靠性修正

控制脚本新增 Tab / Shift+Tab 的焦点限制，当前模式只有一个可见操作按钮。Escape 与 Tab 在捕获阶段处理，退出后移除事件监听。低动态手动重播先应用静态模式，再聚焦可见的“进入工作台”，避免聚焦已隐藏的“跳过片头”。原样提取内容的 SHA-256 在 `extraction.json`，两处修正的完整差异在 `opening-accessibility.diff`。

## 本地验证

静态审查：2 段 style、3 段 script；只选取指定 3 个资源。选取内容未发现 fetch、XHR、WebSocket、sendBeacon、外部 import 或动态代码执行。4 张内嵌 SVG 均成功解析，未发现 script、foreignObject、外部 href 或事件属性。

已通过：

- `node --check backlot/ui/opening/terrain.js`
- `node --check backlot/ui/opening/opening.js`
- `node --test tests/backlot/web_opening.test.cjs`：6 / 6

行为测试使用隔离 DOM / renderer 测试夹具，涵盖真实初始化契约、首访 / 会话 / off / 非项目库边界、Tab 和 Escape、低动态可见焦点、结束 / 重播 / 隐藏 / 页面退出资源释放及首页字节保留。它们不替代真实浏览器渲染、GPU 或业务验收。真实浏览器结果由主控记录到项目答辩证据。

原设计的默认行为：每个浏览器会话在项目库自动播放一次；`?opening=always` 可强制再次播放，`?opening=off` 关闭自动播放。系统低动态设置关闭自动播放，顶部重播按钮仍可打开静态入口。
