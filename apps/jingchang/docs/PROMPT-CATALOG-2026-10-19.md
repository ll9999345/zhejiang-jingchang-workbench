# 多提示词库、分组、反向词与整库恢复

镜场0.99.11新增“提示词库 → 库与分组管理”。旧列表、AI优化、编辑、历史恢复与变量填写入口保留。所有管理、保存、导出和恢复都是本机操作，不会因打开页面、套用模板或恢复备份而请求AI。

## 使用方法

1. 从左侧提示词入口打开旧列表，再点“库与分组管理”。首次可看到六个常用分组及十条本项目另写的示例；它们按需读取，首次查看不写入用户模板文件。已有模板按原分类显示，编号、文字与版本不改写。
2. 可新建/重命名多个库，在每个库中建组、改名。选择库会记住当前库。系统库保留，其名称与分组可调整。
3. “保存新提示词”填写名称、所属分组、正向词、反向词与适用场景。正向词描述要什么，反向词描述应避免什么；每类词最多20000个JavaScript字符，场景最多500字。保存本身不调用模型。
4. “使用提示词”沿用原来的变量填写，例如`{{hero}}`。正向和反向词中的变量一起询问；正向词追加到所选节点正文，反向词追加到节点反向词字段。没有选中节点时建立文本节点，不自动执行生成。具体生成路径是否使用反向词，仍由所选模型/工作流的字段绑定决定。
5. “编辑”“版本”“AI优化”回到原有编辑器。编辑会新增版本，反向词和场景一起保存与恢复；旧编辑器没有提交新字段时，服务会保留已有值。单条最多保留200个版本，达到上限会停止写入，保留旧历史。AI优化仍只在明确确认服务和预算后提交，结果先是草稿；本轮真实付费调用继续暂停。
6. 勾选提示词可跨库/组移动，或进入回收站再恢复。每批最多200条；移动和回收只改组织关系，不改提示词文件。回收一个分组时，条目移到同库剩余第一个分组，没有其他分组则转为未分组。恢复分组不会自动把这些条目搬回。回收库时保留其全部内容，恢复库后可继续使用。系统库不能回收。
7. 进入“备份与恢复”，导出全部库或当前库为`.jingchang-prompts`。包中保留正向词、反向词、场景、库、分组、回收状态和全部已有版本。它是全局提示词的独立备份；工程`.jingchang`、任务`.jhistory`和媒体整库备份不替代此文件。
8. 选择备份先本机检查，确认库数、条目数、版本数后勾选，再建立新库和新编号。现有模板不覆盖。恢复中断时，已写副本先保持不可见；读取原接收记录，刷新目录后确认继续。完成后重复读取/恢复原接收编号，不再复制模板。

未保存草稿会阻止切换管理界面或关闭。可刷新目录而保留草稿；若另一窗口已更新目录，先刷新再确认，服务不会用旧目录覆盖新状态。

## 数据与接口

- 原模板及版本继续存于`data/prompts/`。新字段是`negative`、`scene`；库分组的组织关系在`data/prompt-catalog.json`，旧组织快照为`data/prompt-catalog-history/`。
- 接收备份与固定恢复映射在`data/prompt-catalog-imports/`。复制完成后由单一目录提交启用，服务重启不自动恢复。未完成文件、原备份与旧版本不会自动删除。
- `GET /api/prompt-catalog`：库、分组与模板状态；`GET /api/prompt-catalog/export?libraryId=...`：当前库，省略参数导出全部。
- `POST /api/prompt-catalog/libraries/create|rename|archive|activate`：目录revision与对应库字段。创建带固定requestId。
- `POST /api/prompt-catalog/categories/create|rename|archive`：目录revision、libraryId与分组字段。
- `POST /api/prompt-catalog/items`：目录revision、固定requestId、libraryId、categoryId、title、text、negative、scene；重复原创建编号不再复制。
- `POST /api/prompt-catalog/items/move|archive`：目录revision、ids及目标库/组或archived状态。
- `POST /api/prompt-catalog/imports`：固定requestId与manifest；`GET /api/prompt-catalog/imports`、`GET /api/prompt-catalog/imports/:id`只读原接收记录；`POST /api/prompt-catalog/imports/:id/restore`使用最新目录revision与原fingerprint。
- `GET/POST/PUT /api/prompts`及旧版本/恢复/优化接口仍保留。新库管理中的真实分组与旧分类备注区分显示。

上限：100个库、每库200个分组、10000条模板、32MiB单个备份与12MiB目录。未支持的额外旧数据会阻止导出，原文件保留，不静默丢弃。目录和模板写入由同一服务进程内的锁协调；不控制其他独立程序直接写文件。

## 来源与验证边界

功能对照为用户指定[Infinite Canvas固定提交](https://github.com/hero8152/Infinite-Canvas/tree/67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e)，`main.py`16535–16716的多提示词库、分组、正/反向词、场景与批量管理，以及其模板目录用途。本轮新服务、界面与十条示例文案独立编写，没有移植上游代码、模板正文或Agent。固定源和LICENSE只保留为本地审阅依据，原声明没有修改。

本轮通过本机HTTP、Chrome桌面/390像素视口、键盘、低动态/无模糊、真实隔离进程强制退出后的原接收恢复，以及旧模板/AI优化回归。手机与旧机降级为浏览器模拟，实体设备未验收。管理功能不证明任意模型真正使用反向词或生成质量。未导入原版预设全文/平台参数建议，尚未适配直接读取上游原始`prompt_libraries.json`；全部参考能力、其他CLI与真实云/GPU/账单仍有待完成部分。
