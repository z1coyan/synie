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
- 2026-07-28 集成：主仓 cherry-pick 制造域（含 Meta/数量 wire 修复）；挂载 /manufacturing；PG 集成 5 项全绿。
- 2026-07-28 独立全量验收：`:18090` `verify-manufacturing-rest` → `ok meta=24 permissionFirst=82 … stockProjectionRollback=1 cleanup=0`。无修复。
- 2026-07-28 isolation worktree（grok-4.5 fix-08-11）：制造主数据/需求/工单/生产入库全量实现；PG 集成 5 项绿；`:18121` `verify-manufacturing-rest` → `ok meta=24 permissionFirst=82 parentPermissions=18 global=3 scoped=2 crud=12 demandActions=5 salesOccupancy=1 concurrentConfirm=1 concurrentWorkOrder=1 outputAuditVoid=2 concurrentAudit=1 stockProjectionRollback=1 graphql=0 cleanup=0`。无代码修复。

- 2026-07-28 主工作区集成（grok-4.5 缺口）：cherry-pick 去重 `cf7b2d2`（公司默认过账科目 PG 集成）/`b0ba293`（04–07 编号 23505→conflict + inventory 自愈 + verify-inventory 停车编号）/`3f84ab7`（09–14 编号 conflict 测 + OCR 默认存储 + HR 编号腾空 + market fixture）/`bc43cef`（todo 忽略复位）/`4358af8`（printing render 冒烟）/`b8538aa`（setup 空库 e2e afterAll 超时）；合并重复 numberingWriteError；app/index/Meta/helpers 已完整装配，未改 server-go。
## 非目标

工序报工、生产成本总账（第一期不做）。
