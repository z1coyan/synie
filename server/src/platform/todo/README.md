# todo

待办：从源单据状态推导的物化提醒（横切，不引流程引擎）——随源状态自动
出现/关闭/复活，用户侧仅已读与个人忽略。

- 行为参考：`docs/业务模块/待办.md` 与 ADR `docs/系统架构/adr/2026-07-25-todo-facility.md`
- 生产者：`modules/trading/reconciliation`（confirm/unconfirm + closeFromInvoice/reopenFromInvoice）
- 消费 API：`GET /todos/unread-count`、`POST /todos/query`、`POST /todos/{id}/read|dismiss`
- **源注册表** `TodoSourceRegistry`（仿 OwnerRegistry）：
  - 业务域 `registerSource(sourceType, { actionPermissions, unreadPermissions, draftLink? })`
  - 业务域 `registerParty(partyType, { table, nameColumn })`
  - platform 只留 state/查询骨架；第二类待办接入零改 platform
  - 装配：`registerFinanceTodoSources` + `registerPartyTodoSources`（见 `index.ts`）
- 客户端排序经 filterbuild 白名单，CTE 外层加 `todo.` 前缀（不再静默丢弃）
