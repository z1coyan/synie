# Web Go-only 切流收官

Status: ready-for-agent

## 背景

Go 已覆盖 100 个资源及专用操作；前端已在两批提交中引入 OpenAPI client、ResourceClient registry，并切换绝大多数页面，但共享组件仍保留 GraphQL 回退，初始化向导与若干已废弃旧组件仍引用 `gqlFetch`，Vite 仍代理 `/graphql` 与 Elixir `/api`。

## 目标

- 产品与开发流量仅访问 Go `/api/v1`。
- Grid、Drawer、RemoteSelect、EditableTable、CSV 与动作不再具有 GraphQL 回退。
- 初始化向导和仍在使用的专用流程改用 Go REST；已被 REST 页面实现替代的旧组件删除。
- 文件上传、下载、附件全部由 Go 提供。
- 删除 `/graphql`、`BACKEND_PORT`、GraphQL codegen、生成物与依赖。
- Elixir `backend/` 保留作参考，不在本议题删除。
- JWT 不兼容旧 Phoenix token；切流后用户须重新登录。

## 非目标

- 不改变业务规则或页面交互。
- 不删除 `backend/`。
- 不推送远端分支或创建 PR。

## 实施批次

1. **共享 seam 收口**：资源 registry 成为唯一默认解析入口；移除 Grid/Drawer/RemoteSelect/EditableTable/CSV/动作 GraphQL fallback；缺失注册 fail-fast。
2. **专用流程**：迁移 setup；复核银行导入、对账、OCR 新实现，删除无调用旧实现；补齐 registry 漏项。
3. **Go-only 收官**：删除 GraphQL client/codegen/生成物/依赖与 Vite Elixir 代理；更新文件路径注释和项目说明。
4. **验收**：前端 check/typecheck/test/build；Go Playwright 全量及受影响 UI E2E；`server/go test ./...`；Elixir 不启动时全站可用。

## 验收标准

- `web/app` 生产代码不存在 `gqlFetch`、GraphQL operation 或动态 GraphQL 字面量构造。
- `web/vite.config.ts` 只代理 `/api/v1` 到 Go，不含 `/graphql`、Elixir `/api`、`BACKEND_PORT`。
- `web/app/graphql/`、`web/codegen.ts`、GraphQL codegen scripts/dependencies 删除。
- 所有页面使用的资源可由 registry 解析；缺失资源明确报错，不静默回退。
- 文件流量只走 `/api/v1/files*`。
- JWT 切流重登要求在迁移/README 文档明确记录。
- 验证命令全部通过；若环境阻塞，记录命令、错误和未验证范围。

## 文档影响

这是传输层与部署路径变更，不改变业务规则，因此不改产品规则正文或 `CONTEXT.md` 术语；更新迁移设计现状、README/开发启动说明及本验收记录。若实施中发现用户可见规则变化，再同步对应产品文档与 `CONTEXT.md`。
