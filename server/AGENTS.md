# server/（Bun + Hono + Kysely）

- 第一语言中文（文档/用户可见文案）；标识符英文。
- 平坦主数据资源一律用 `platform/standard` 派生（meta 声明 + 领域钩子，见 `docs/系统架构/adr/2026-08-06-standard-actions-kernel.md`）；钩子只做不变量与行内充实，跨资源流程留手写服务；动作复杂化按动作弹射回手写。
- 聚合单据（头+子行整单草稿）用 `createAggregateService` 派生 load/create/replaceDraft（见 `docs/系统架构/adr/2026-08-07-aggregate-document-kernel.md`）；新聚合 = 描述符 + 钩子 + 合同 CASES 加行；跨资源效果走 transition effect，不进聚合钩子。
- 本目录是**产品后端**；历史 Go 实现已归档（git tag `server-go-final`），禁止把 Go 形态机械搬成 class。
- 编码约定、技术栈定案、命令见 `server/README.md`，开工前必读。
- 业务规则变更须同步 `docs/业务模块/` 与 `docs/术语表.md`（根 AGENTS.md 约定）。
