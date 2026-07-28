# todo

待办：从源单据状态推导的物化提醒（横切，不引流程引擎）——随源状态自动
出现/关闭/复活，用户侧仅已读与个人忽略。生产者为对账确认→开票/收票。

- 行为参考：`.scratch/todo-facility/spec.md` 与 server-go `systemops`
- 生产者：`modules/trading/reconciliation`（confirm/unconfirm + closeFromInvoice/reopenFromInvoice）
- 消费 API：`GET /todos/unread-count`、`POST /todos/query`、`POST /todos/{id}/read|dismiss`
- 实现工单：`.scratch/ts-backend-rewrite/issues/09-invoices-todo.md`
