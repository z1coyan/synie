# 05 — 三态可选字段统一为泛型 Optional[T]

**What to build:** PATCH 语义中的「字段未传 vs 显式置 null」在全系统只有一套机制：一个泛型 `Optional[T]` 类型（区分未设置/设置值/设置 null）取代现有的 `**string` 双重指针与散落在约 8 个领域包中各自重复声明的 `OptionalString` 副本。HTTP 层的三种并存解码风格（可空指针更新、双次解码 + 泛型、手写 Set=true 块）收敛为一种；领域层逐字段搬运式的 Update handler（如银行导入模板更新中约 40 行逐字段搬运）随之消失。行为不变：已有 API 对 null 与省略字段的响应语义逐端点保持。

**Blocked by:** 04 — HTTP 层 helper 收敛与 Server 瘦身（两者同改 PATCH handler，须在其落定后进行）

**Status:** ready-for-agent

- [ ] 泛型 Optional[T] 定义于单一位置，全系统唯一三态机制
- [ ] 领域包中重复声明的 OptionalString 全部删除，`**string` 用法清零
- [ ] HTTP 层 PATCH 解码收敛为单一风格，极端逐字段搬运 handler 缩短为声明式字段表
- [ ] 每个受影响端点的 null-vs-省略行为有测试锁定（更新前已存在的语义不漂移）
- [ ] go test ./... 全绿
