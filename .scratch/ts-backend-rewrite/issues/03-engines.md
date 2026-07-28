# 03 事实引擎：GL + 库存

Status: ready-for-agent
Blocked by: 02

## 范围

`server/src/engines/` 落地两个深模块（唯一写分录入口；禁止单据直写分录表）：

1. **gl**：`post/cancel/reverse/validateEntries`——借贷配平（容差 0）、科目存在且本公司启用非汇总、往来角色科目必须带对手（红字行豁免）、币种一致性；作废=标记不删行；红冲=原组取负对冲+标记已被红冲。
2. **inventory**：`post/cancel`——（仓×物料）advisory lock 串行化、数量带符号恒默认单位（6 位）、叶子仓校验、负库存校验（仓级 `allow_negative` 豁免；作废同样过校验）。

两引擎接口接 `DbHandle`（trx 由调用方传入），禁止自起事务、禁止 import modules/*。

## 行为参考

`server-go/internal/engines/gl/`；库存引擎在 `server-go/internal/domain/inventory/` 内（Stock 服务）。不变量语义见 CONTEXT「总账分录」「库存分录」「红冲」「允许负数库存」词条。

## 验收

- PG 集成不变量测试：配平拒绝/科目约束/对手缺失拒绝/作废幂等/红冲归零/负库存拒绝（含作废致负）/锁并发
- 引擎 API 被 04/05 工单直接消费，不再变更签名

## 非目标

不过金额到库存分录（估值未定案，维持只记数量）。
