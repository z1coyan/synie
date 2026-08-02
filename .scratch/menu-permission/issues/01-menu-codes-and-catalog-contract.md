# 01 — 菜单 code 与前后端目录契约

**What to build:** 让菜单项成为可寻址的配置目标：前端静态菜单的每个叶子项挂上稳定 code（约定 `menu.<模块 key>.<路径末段>`，`/` 取 `home`，如 `menu.scm.sales-orders`、`menu.dashboard.home`）；后端落地一份菜单目录（模块→组→项的 code + 中文标签），作为后续白名单 sync 的校验基准；契约测试对拍两侧——前端菜单声明的叶子 code 集合与后端目录的叶子 code 集合必须互等、标签非空、code 符合命名约定，漂移即 CI 红。本工单零行为变化：菜单渲染、路由、权限判定全部照旧。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 前端菜单声明全部叶子项带 code，命名符合约定且模块内唯一
- [ ] 后端菜单目录覆盖同一批模块/组/项（code + 中文标签），可从服务端代码引用
- [ ] 契约测试：两侧叶子 code 集合互等（任一方向缺/多即失败并报出差异清单）
- [ ] 契约测试：code 全部匹配 `menu.<模块>.<末段>` 约定、标签非空
- [ ] 应用外壳菜单渲染与现状逐项一致（零行为变化）
- [ ] `bun run test`（含新契约测试）通过
