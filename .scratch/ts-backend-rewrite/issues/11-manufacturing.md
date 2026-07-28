# 11 制造：BOM / 工艺 / 履约需求 / 工单 / 生产入库

Status: ready-for-human
Blocked by: 03

## 范围

1. **工序/工艺模板**（主数据；模板复制带入快照语义）
2. **BOM**（一物料多张+独立编号+可空方案名；配料行（单位限默认或转换；损耗率）；副产品行声明；路线行（工序引用+外协标记）；自引用校验/树展开检测环截断）
3. **履约需求单**（销售条目勾入+手工建单；占用口径=已确认未作废；已下单/已收投影；履约方式四选一；改方式下游校验；自动完成）
4. **生产工单**（一需求行至多一张未作废；未完成数量容器；完工回写）
5. **生产入库单**（行必挂工单；分次入库；超入比例容差；审核写正向库存分录并累加；第一期只数量账）

## 行为参考

`server-go/internal/domain/manufacturing/`；`.scratch/fulfillment-demand-production/spec.md`、`.scratch/demand-purchase-linkage/spec.md`；CONTEXT 制造词条。

## 验收

- `verify-manufacturing-rest.ts` 全绿
- 占用/投影/容差/完成联动测试

## Comments

- 2026-07-28：TS 实现 + Meta pr-2.17 金标；`verify-manufacturing-rest` 对 PORT=18111 TS 后端全绿（meta=24, cleanup=0）；PG 集成 5 项绿。

## 非目标

工序报工、生产成本总账（第一期不做）。
