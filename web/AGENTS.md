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
- 组件能力不够时先扩组件再用，不要在页面里绕过它手搭。
- 一切文件上传/下载必须走 `~/lib/files.ts`（REST `/api/files`），不要在页面自写 fetch/FormData；记录附件 UI 一律用 `SynieAttachmentPanel`（`~/components/synie-attachment-panel/`）挂 SynieRecordDrawer 的 `extraContent`，传 ownerType（graphql type 名）/ownerId。

## 移动端适配

- 所有页面需考虑移动端适配，桌面/移动断点统一为 `lg`（1024px）。

## HeroUI Pro

项目持有 HeroUI Pro 许可，技术栈为 React 19 + `@heroui/react` v3 + `@heroui-pro/react`（均已安装）。开发 UI 时优先复用组件库，而不是从零搭建。

- 基础组件从 `@heroui/react` 导入，Pro 组件（图表、DataGrid、AppLayout、Sidebar、AI 界面等）从 `@heroui-pro/react` 导入；动手前先查有无现成实现（MCP `heroui-pro` 或 https://heroui.pro/components ）。
- v3 关键约定：子组件用点号（`Card.Header`、`Sheet.Content`）；交互用 `onPress` 不用 `onClick`；无 `HeroUIProvider`；没有 v2 的数字色阶 token（`primary-500` 等），语义色是 `accent`/`success`/`danger`；样式定制用 Tailwind className，不再有 `radius`/`color` 这类 props。
- 品牌色在 `web/app.css` 通过 `--accent` / `--accent-foreground` CSS 变量覆盖。
- AI 辅助开发依赖：`heroui-pro` MCP server 和 `heroui-react-pro` / `heroui-pro-design-taste` 两个 Agent Skills（安装方式见根目录 README「HeroUI Pro」一节）。
- Token 管理：`HEROUI_PERSONAL_TOKEN`（个人，本地 MCP/skills 用）、`HEROUI_AUTH_TOKEN`（团队 CI/CD 用），存放在仓库根目录 `.env`（已 gitignore），不得提交或写进代码。
