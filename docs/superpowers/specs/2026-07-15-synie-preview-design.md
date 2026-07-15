# SyniePreview 通用图片预览 设计

2026-07-15。后台任务自主定型:需求已足够具体,取舍记录于此与 PR 描述。

## 目标

通用全屏图片预览(lightbox)组件 `SyniePreview`:右上工具栏(下载/旋转/缩放/关闭),左右箭头循环切换,滚轮缩放,支持在 Sheet(抽屉)/Modal(对话框)内打开且层级正确。

## 方案取舍

- **选定:HeroUI Modal 组装**。受控 `Modal.Backdrop` + `Container size="full"` + 透明化 `Dialog`。HeroUI 浮层 portal 到 body、后开者在 DOM 后面天然置顶(与 FkPreview 叠抽屉同机制),焦点陷阱/scroll lock/ESC/进退场动画全部复用。
- 否决:引第三方 lightbox 库(违反"优先组件库组装"守则、多一个依赖);自建 fixed 高 z-index overlay(丢失 Modal 的可访问性设施,层级需手工管理)。

## API

```tsx
interface SyniePreviewItem {
  src?: string      // 直接可渲染地址(objectURL 等);与 fileId 二选一
  fileId?: string   // sys_file id,组件内部 fetchFileBlob 鉴权懒加载当前张
  filename?: string // 下载保存名/底部标签
}
interface SyniePreviewProps {
  items: SyniePreviewItem[]
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  initialIndex?: number // 每次打开定位到该张
}
```

- `fileId` 形态查询 key 复用 `['fileBlob', id]`(与 SynieImageAttachment 共享缓存),下载走 `downloadFile`(带鉴权);`src` 形态锚点下载。
- 交互:方向键/箭头按钮循环切换;滚轮与 +/- 按钮缩放(0.25–8 倍);拖拽平移;旋转 90° 步进;切图重置视图;点空白处关闭;底部「n / N · filename」。

## 落地整合

- `blobUrl(blob)` helper 从 SynieImageAttachment 上移至 `~/lib/files.ts` 共享。
- `SynieImageAttachment` 放大预览改用 SyniePreview(单张,带下载/旋转,验证抽屉内层级)。
- `SynieAttachmentPanel` 图片类附件文件名可点,打开 SyniePreview 并携全部图片附件循环切换。
- `web/CLAUDE.md`(=AGENTS.md)标准组件节补一行使用规范。
