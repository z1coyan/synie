# server/（Bun + Hono + Kysely）

- 第一语言中文（文档/用户可见文案）；标识符英文。
- 平坦主数据资源一律用 `platform/standard` 派生（meta 声明 + 领域钩子，见 `docs/系统架构/adr/2026-08-06-standard-actions-kernel.md`）；钩子只做不变量与行内充实，跨资源流程留手写服务；动作复杂化按动作弹射回手写（同挂载点先注册手写端点，同路径先注册胜出）。guard 超出一词一码（跨资源 allOf、子行写 anyOf 等封闭词表内组合子）不是弹射理由：用 `standardRoutes`/`standardChildRoutes` 的 `guards` 端点级覆盖声明。
- 聚合单据（头+子行整单草稿）用 `createAggregateService` 派生 load/create/replaceDraft（见 `docs/系统架构/adr/2026-08-07-aggregate-document-kernel.md`）；新聚合 = 描述符 + 钩子 + 合同 CASES 加行；跨资源效果走 transition effect，不进聚合钩子。合同适配（`_aggregateForContract` 的 toPayload+present 包装）用内核 `withAggregateWireAdapter` 装配，不再逐方法手包。
- wire 呈现与草稿 zod 也从 meta 派生（D8 后续「类型级 wire 派生」）：`platform/standard/present.ts` `derivePresenter`（键集/键序/规范化规则归 meta，模块只留 fields 并集/改序与 values 计算列钩子）、`wire.ts` `deriveDraftObject`/`deriveDraftSchemas`（类型/格式约束归 meta，草稿专属差异=逐字段补丁/字面量条目）。wire 字节冻结（D8）：迁移前后用 `server/scripts/wire-equiv-dump.ts` dump 对拍，键集/键序/值零差异才算完。
- 本目录是**产品后端**；历史 Go 实现已归档（git tag `server-go-final`），禁止把 Go 形态机械搬成 class。
- 编码约定、技术栈定案、命令见 `server/README.md`，开工前必读。
- 业务规则变更须同步 `docs/业务模块/` 与 `docs/术语表.md`（根 AGENTS.md 约定）。
