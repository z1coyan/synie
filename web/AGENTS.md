# Synie

项目使用Tanstack Start + Hero UI + GraphQL为主要技术栈

## 项目守则

- 前端所有非幂等请求都要有回馈，使用Hero UI的Toast作为反馈组件
- 所有请求均要进行错误处理，有合适的报错信息方便排查
- 尽可能使用组件库已有的组件进行开发而不是自己使用html+tailwindcss搭建
- 表单/筛选控件一律用 HeroUI(Pro) 现成组件（日期用 DatePicker/DateRangePicker、数值用 NumberField、下拉用 Select 等），不要包装浏览器原生 input；有已封装的业务组件时优先复用业务组件

## 业务数据页标准组件

- 数据列表一律用 `SynieDataGrid`（`~/components/synie-data-grid/`）；数据详情、新增、编辑一律用 `SynieRecordDrawer`（`~/components/synie-record-drawer/`）三态抽屉，不要自造表格或表单。
- 字段行为（必填/只读 `edit`/条件显隐 `visible`/栅格 `cols`/默认值）通过 `fields` override 声明，提交 mutation 写在页面 `onSubmit` 回调；接入范例见 `routes/_app/system/roles.tsx`。
- 启用/停用等状态类开关不进创建/编辑表单（表单 `exclude` 掉，新建由后端默认值兜底）：状态翻转用独立入口（表格行动作、详情页按钮）显式触发；仅记录固有属性的布尔（如叶子分类、基准单位）仍属表单字段。
- 父表单内的子条目（单据行、明细行等）一律用 `SynieEditableTable`（`~/components/synie-editable-table/`）：表格纯展示，增改一律走二级 `SynieRecordDrawer`，不做行内编辑；`items`/`onChange` 受控、组件不发写请求，父表单提交时一并持久化，新增行 id 带 `local:` 前缀（`isLocalRow` 判别）。
- 组件能力不够时先扩组件再用，不要在页面里绕过它手搭。
- 外键单元格/字段默认渲染为可点 link，点击开全局速览抽屉（`FkPreviewProvider` 已挂 `_app` 布局，页面零接线）；资源级抽屉通用定制（label/fields 等）写在 `synie-record-drawer/registry.ts`，页面用 `{...drawerConfig('资源名')}` 引用同一份再按需覆盖。
- 一切文件上传/下载必须走 `~/lib/files.ts`（REST `/api/files`），不要在页面自写 fetch/FormData；记录附件 UI 一律用 `SynieAttachmentPanel`（`~/components/synie-attachment-panel/`）挂 SynieRecordDrawer 的 `extraContent`，传 ownerType（graphql type 名）/ownerId；固定单图槽位（证件照等）用同目录 `SynieImageAttachment`，一个 category 一张图。
- 图片全屏预览一律用 `SyniePreview`（`~/components/synie-preview/`）：受控 `isOpen/onOpenChange`，`items` 传 `fileId`（经鉴权懒加载）或 `src`，内建下载/旋转/缩放/循环切换，抽屉/对话框内打开层级自然正确；不要自造 lightbox。缩略图用同目录 `FileThumb`；表格图片列用 DataGrid 列 override `image`（`true`=列值即 file id，或 `{ fileId(row), keepText }`），缩略图点击即全屏预览、同列循环；行记录的图片附件列用 DataGrid `attachmentImages={{ ownerType, category?, label? }}`（虚拟列，点开该行全部图片，与抽屉附件面板同 queryKey 联动刷新）。

## 移动端适配

- 所有页面需考虑移动端适配，桌面/移动断点统一为 `lg`（1024px）。

## HeroUI Pro

项目持有 HeroUI Pro 许可，技术栈为 React 19 + `@heroui/react` v3 + `@heroui-pro/react`（均已安装）。开发 UI 时优先复用组件库，而不是从零搭建。

- 基础组件从 `@heroui/react` 导入，Pro 组件（图表、DataGrid、AppLayout、Sidebar、AI 界面等）从 `@heroui-pro/react` 导入；动手前先查有无现成实现（MCP `heroui-pro` 或 https://heroui.pro/components ）。
- v3 关键约定：子组件用点号（`Card.Header`、`Sheet.Content`）；交互用 `onPress` 不用 `onClick`；无 `HeroUIProvider`；没有 v2 的数字色阶 token（`primary-500` 等），语义色是 `accent`/`success`/`danger`；样式定制用 Tailwind className，不再有 `radius`/`color` 这类 props。
- 品牌色在 `web/app.css` 通过 `--accent` / `--accent-foreground` CSS 变量覆盖。
- AI 辅助开发依赖：`heroui-pro` MCP server 和 `heroui-react-pro` / `heroui-pro-design-taste` 两个 Agent Skills（安装方式见根目录 README「HeroUI Pro」一节）。
- Token 管理：`HEROUI_PERSONAL_TOKEN`（个人，本地 MCP/skills 用）、`HEROUI_AUTH_TOKEN`（团队 CI/CD 用），存放在仓库根目录 `.env`（已 gitignore），不得提交或写进代码。
