# 06 — 选择器模式与图片列的卡片呈现

**What to build:** 两类既有能力在卡片模式下的呈现：① 选择器模式（pick）——卡片单选点卡片即选、多选卡片上出勾选位，跨页（跨追加批次）累积选中复用现有 mergePick 语义，选择器场景本就无批量条，卡片模式不新增；② 图片列——image override 列与附件图片列在卡片上以缩略图呈现（附件列有图时作为卡片左侧首图），点击进全屏预览并循环切换，复用现有 SyniePreview 与查询缓存口径。两种行为在桌面表格形态下零变化。

**Blocked by:** 01 — 卡片流最小闭环

**Status:** ready-for-agent

- [x] pick=single 时点卡片即选中并回调 onPickChange；pick=multiple 时卡片勾选位可多选，追加加载后已选不丢（mergePick 语义）
- [x] 选择器模式的卡片工具栏与动作面与现状一致（无批量条、无多余动作）
- [x] image override 列在卡片摘要区呈现缩略图，点击全屏预览、同列图片循环切换
- [x] 附件图片列有图时卡片左侧显示首图缩略图（+N 计数），点击预览该行全部图片
- [x] 无图记录的图片位呈现与表格一致的占位（—），不留空白错位
- [x] 桌面表格的图片列与选择器行为零回归

## Comments

- 实现:cardMode 纳入 pick;CardList 增 selection 机制(single 点选/multiple 勾选位)与图片列缩略图(summaryValue),附件图片列经 renderLeading 进卡片首图位;AttachmentImagesCell 抽独立文件(表格/卡片共用),imageFileId/imageFilename 入 cells.tsx;图片预览 items 改从 displayRows(卡片=累积行)取。
- 注:pick 弹窗链路未做端到端冒烟(需驱动业务弹窗),逻辑与桌面 mergePick 同路径。
