# Synie

项目使用Tanstack Start + Hero UI + GraphQL为主要技术栈

## 项目守则

- 前端所有非幂等请求都要有回馈，使用Hero UI的Toast作为反馈组件
- 所有请求均要进行错误处理，有合适的报错信息方便排查
- 尽可能使用组件库已有的组件进行开发而不是自己使用html+tailwindcss搭建

## 移动端适配

- 断点：`lg`（1024px）为桌面/移动分界，全站统一（AppShell 双列菜单、登录页品牌栏均以此切换），不要引入别的分界点。
- 移动端不保留持久侧栏：导航收进左侧 Drawer（`@heroui/react` 的 `Drawer.Backdrop` 受控模式），顶栏汉堡按钮触发；菜单项跳转后必须关闭抽屉。
- 用户身份入口：桌面在图标栏底部、移动端在顶栏右侧，复用 `app-shell.tsx` 里的 `UserMenu`，不要另行实现。
- 新页面默认响应式：内容留白用 `px-4 sm:px-6 lg:px-8` 节奏；卡片/表单网格从手机单列起步（`grid-cols-1 sm:grid-cols-2 …`）；宽内容（表格等）允许容器内横向滚动，页面本身不得出现横向滚动条。
- 触控目标不小于 40px；图标按钮必须带 `aria-label`（桌面配 Tooltip）。
- 验收标准：390px 视口下无横向滚动，能完成 登录 → 导航 → 业务操作 → 退出 全流程。

## HeroUI Pro

项目持有 HeroUI Pro 许可，技术栈为 React 19 + `@heroui/react` v3 + `@heroui-pro/react`（均已安装）。开发 UI 时优先复用组件库，而不是从零搭建。

- 基础组件从 `@heroui/react` 导入，Pro 组件（图表、DataGrid、AppLayout、Sidebar、AI 界面等）从 `@heroui-pro/react` 导入；动手前先查有无现成实现（MCP `heroui-pro` 或 https://heroui.pro/components ）。
- v3 关键约定：子组件用点号（`Card.Header`、`Sheet.Content`）；交互用 `onPress` 不用 `onClick`；无 `HeroUIProvider`；没有 v2 的数字色阶 token（`primary-500` 等），语义色是 `accent`/`success`/`danger`；样式定制用 Tailwind className，不再有 `radius`/`color` 这类 props。
- 品牌色在 `web/app.css` 通过 `--accent` / `--accent-foreground` CSS 变量覆盖。
- AI 辅助开发依赖：`heroui-pro` MCP server 和 `heroui-react-pro` / `heroui-pro-design-taste` 两个 Agent Skills（安装方式见根目录 README「HeroUI Pro」一节）。
- Token 管理：`HEROUI_PERSONAL_TOKEN`（个人，本地 MCP/skills 用）、`HEROUI_AUTH_TOKEN`（团队 CI/CD 用），存放在仓库根目录 `.env`（已 gitignore），不得提交或写进代码。
