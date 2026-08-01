# ADR：Convex 事实引擎、冲突文档与 generation 投影

2026-07-31，状态：已实施。本文固定编号、正式审计、库存和总账在 Convex 中的事务边界，作为后续
业务单据 mutation 的唯一事实引擎。旧 PostgreSQL 引擎保留为迁移期行为 oracle，Plan 008 删除。

## 决策

事实是权威、投影可重建。库存写入 append-only `stockEntries`，作废只标记；总账写入 `glEntries`，
reverse 新增成对反向事实并关联原事实，cancel 标记而不删除。金额按 2 位、base 数量按 6 位转换为
scaled signed `int64`，加法先检查溢出，运行时不出现 float。

库存的并发不变量收敛到 `(generation, company, warehouse, material)` 唯一索引读取的
`inventoryCurrentBalances` 文档。所有同 key 出库先读同一稳定文档，依赖 Convex serializable OCC
自动重试；重试后看到余额不足的 mutation 以 conflict 结束。不同 key 不共享锁或 singleton。

截至日查询不扫描事实：完整历史月读取 `inventoryMonthlyDeltas`，目标月读取最多 31 个
`inventoryDailyDeltas`；总账账户和往来维度采用同样的月/日桶。sealed profile 将 200 年历史上界固定
为 2,400 月桶，当前月固定为 31 日桶。此边界远低于 32,000 scanned documents，且与事实行数无关。

`DomainMutationCtx` 是事实写 helper 的 capability：只有 mutation 边界能创建，接口不暴露 action
能力。posting 固定顺序为“加载/校验 → 受控投影 → 库存 → 可选总账 → head → audit”，全过程只提交
一次。架构测试禁止 `convex/engines/**` 使用网络、scheduler、嵌套 mutation 或 Node runtime。

编号规则从 bundle-time sealed Catalog 解析字段。`(ruleId, scopeKey)` counter 是 OCC 冲突文档，取号、
head 和 audit 同一 mutation；只有成功提交才消耗号码。正式审计也只接受 `DomainMutationCtx`，递归过滤
password、secret、token、内部 email 和 credential。编码后超过 64 KiB 的 changes 在同一 audit 文档
写字段摘要和截断标记，不改成异步漏审计。

## 预算与重建

每个写入口在首个数据库写入前计算 reads、writes 与估算 bytes。集中安全线为 30,000 reads、15,000
writes、15 MiB read、15 MiB write，保守低于平台硬限制；各业务域不得复制魔法数字。当前合法单据
没有新增用户可感知规模限制，故未修改产品规则文档。

projection rebuild 由 internal action 分页读取不可变事实，每 256 行进入幂等 chunk mutation，写入
`active + 1` generation。会话记录覆盖的 chunk/source row 数；全部覆盖后才由单 mutation 同时标记验证
并切 active generation。旧 generation 保留，用户不会看见半重建。verify 以 live facts 离线模型与
current/day/month/account/party 投影逐 key 对拍；CI/self-host smoke 会故意破坏 current，确认能精确报告
并在重建切换后恢复一致。

## 真实 self-hosted 证据

隔离 PostgreSQL 17 + MinIO + Convex 栈的 2026-07-31 基准结果：

- 100 个同 scope 并发取号提交 100 个唯一号码；随后故障 mutation 不耗号，下一成功号码连续；
- 先入库 10 后发起 50 个同 key 并发出库，严格为 10 成功、40 库存不足，最终 facts/current 相同；
- 编号并发端到端 P95 476ms，热点库存 P95 211ms，均低于 CI 8s 环境门槛；
- 2016-01-01 至 2025-12-31 共 3,653 个每日 movement，截至日只扫描 119 月桶 + 31 日桶；
- GL post/reverse/cancel 全过程 projection 与 live facts 对拍；重复 reverse conflict、重复 cancel no-op；
- posting 六个阶段逐点抛错均无 facts、projection、head 或 audit 半状态；成功链敏感值不落库；
- 破坏 current 后 verify 报 mismatch，新 generation 重建并原子切换后重新 100% 对拍。

## 后果

- 后续业务域只能组合 facade，不得直接写事实表；新增 projection 必须同时提供 update、verify、rebuild。
- 热点性能先调整真正的不变量粒度和索引，不用全局锁，也不先调大 self-host 并发参数。
- generation 算法变化必须新建、验证、切换；禁止原地混用月/日桶算法。
- 外部 I/O 必须在事务外 action 完成，再以结果进入独立领域 mutation；不能参与同一过账提交。
