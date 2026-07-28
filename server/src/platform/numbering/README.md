# numbering（骨架）

编号规则 + 计数器：绑定单据类型的自动取号（固定文本/记录字段/序号段组合），
每单据至多一条启用；管理员可校正计数器且必须留审计。
- 行为参考：`server-go/internal/platform/numbering/`
- 表：`sys_numbering_rule` / `sys_numbering_counter`
- 实现工单：`.scratch/ts-backend-rewrite/issues/01-platform-completion.md`
