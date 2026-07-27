# 04 — HTTP 层 helper 收敛与 Server 瘦身

**What to build:** 纯结构收敛，不改变任何 API 行为。之后维护者看到的是：HTTP 包有且仅有一个共享 helpers 文件，listBody/listParts/可空更新/decimal 解析等通用助手不再散落在 market、inventory、gljournal 等不相关文件里；`Server` 直接内嵌依赖结构体，不再存在 Dependencies、Server 字段、New() 拷贝三份必须手工同步的清单；鉴权后的 actor 由路由门面层显式传入内部实现函数，包内不再有 80+ 处 `actor, _ :=` 吞错写法；列表类 handler 通过一个泛型 queryList 助手收敛到几行（权限检查、解码、查询、响应组装各一处实现），「listBody → 各领域 ListQuery」的最后一步不再每个 handler 手写一遍。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 共享 helper 集中于单一文件（含从 market/inventory/gljournal 等文件迁入的项），原位置无残留副本
- [ ] `Server` 内嵌 `Dependencies`，`New()` 的逐字段拷贝删除；编译期契约断言保留
- [ ] `actor, _ :=` 吞错全部消除，内部函数显式接收 actor；`financeBankingActor` 等自由函数改为方法
- [ ] 泛型 queryList 助手落地，主要列表 handler 迁移；销售/采购对称的门面方法如可表驱动则一并收敛
- [ ] `server.go` 中错置的币种等 handler 移入对应领域文件；匿名重复声明的 listBody 结构消除
- [ ] go test ./... 全绿，API 行为零变化（响应体、状态码、错误格式逐端点保持一致）
