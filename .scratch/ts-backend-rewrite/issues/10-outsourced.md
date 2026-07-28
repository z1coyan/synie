# 10 委外：订单配置 / 发料 / 入库

Status: ready-for-human
Blocked by: 07, 11

## 范围

1. **委外订单条目配置**（成品 BOM 引用可空快照代入：理论耗用=净用量×(1+损耗率)×条目数量代入发料清单、单位产出量×条目数量代入副产物清单；代入后与 BOM 脱钩可改）
2. **委外发料单**（必挂发料清单行；调出仓≠外协仓；外协仓限绑定当前对手；审核：调出仓负+外协仓正+已发料量累加；超发不硬拦仅展示）
3. **委外入库单**（镜像采购入库财务行为；成品入仓+材料扣减（按比例带出可改，外协仓负向不过总账）+副产物入仓（数量无金额）；审核累加已收并复用入库超收比例；已对账数量进采购对账条目池）
4. 外协仓主数据面（is_outsourced 绑定协作方校验）

## 行为参考

`server-go/internal/domain/fulfillment/`（委外单据）；`.scratch/outsourced-purchase/spec.md`；CONTEXT 委外词条。

## 验收

- `verify-fulfillment-rest.ts`（委外段）全绿
- 三类库存分录同事务；比例带出与手改；作废全回滚

## 非目标

工序级外协单据流（CONTEXT 明确不在本期）。

## Comments

### 2026-07-28 验收

- 实现：`server/src/modules/trading/outsourced/*`（替换头 CRUD 占位）；`order/projection.ts` 增 `postOutsourcedIssue` / `requireOutsourced`。
- 已复用：订单条目 BOM/发料清单/副产物/`expandBom`；外协仓 `warehouse-service`；对账池委外入库行。
- 测试：`typecheck`；`outsourced.postgres.test.ts`（发料/入库生命周期 + BOM 展开口径）；投影单测/PG。
- `verify-fulfillment-rest.ts` 对 TS 服务（`SYNIE_API_URL`）全绿：meta=20 permissionFirst=10 queries=10 heads=4（含委外发料/入库头）。

### 2026-07-28 主工作区集成

- cherry-pick `ea0649a`（委外发料/入库完整 CRUD/审核/作废/投影）/ `edfe9d8`（验收记录）；trading 路由与 Meta 装配已在候选提交内挂载。
- 验证：`bunx tsc --noEmit` 绿；`SYNIE_TEST_DATABASE_URL=… bun test` 209 pass（含 outsourced.postgres + projection）；`verify-fulfillment-rest` against :18083 → `ok: meta=20 permissionFirst=10 queries=10 heads=4`。
- 无新增业务代码冲突；与工单 09 文件面无重叠。
- 2026-07-28 独立全量验收：`:18090` `verify-fulfillment-rest` → `ok meta=20 permissionFirst=10 queries=10 heads=4`；outsourced.postgres（发料/入库三库存+投影+作废回滚 + BOM 展开）随 bun test 绿。无修复。
