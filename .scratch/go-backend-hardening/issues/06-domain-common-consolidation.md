# 06 — 领域层公共化：dberr + 泛型 List 执行器 + meta 助手上移

**What to build:** 纯结构收敛，不改变任何业务行为。之后每个领域模块不再各自复制五段样板：PG 错误码映射收敛到单一公共组件（各模块以「约束名→中文文案」表声明差异，23505/23503/23514 的映射逻辑只写一遍，消灭现有 5+ 份 writeError）；`filterbuild.Build` 之后的「只读事务 + count + 分页 + 逐行 scan」收敛为一个泛型 List 执行器，每个模块省约 40 行，且公司隔离过滤的 scopedWhere 不再有返回 2 值/3 值/布尔语义取反三种签名；meta 构建助手（字段/枚举/引用/标准动作集的快捷构造）上移为 `platform/meta` 的一等公民，三种 meta 写法（表驱动助手、另一套助手、纯字面量）至少统一助手部分。分页边界校验（1–200）随之单点化。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 公共 PG 错误映射组件落地，各模块 writeError 删除并以约束名文案表替代；错误响应文案不回归（有测试）
- [ ] 泛型 List 执行器落地，主要模块的 List 方法迁移；count 与列表同事务一致性保持
- [ ] scopedWhere 全系统单一签名，空集合语义（无可见公司时返回空结果）有测试锁定
- [ ] meta 构建助手进入 platform/meta，order/banking/hr-operations 三套私有助手收敛
- [ ] pgtype 转换助手（text/date/timestamp/optionalText）公共化，4+ 份拷贝删除
- [ ] 分页参数校验单点化，各模块重复边界检查删除
- [ ] go test ./... 全绿，含真实 PG 集成测试
