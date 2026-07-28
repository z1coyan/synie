# 架构深化（arch-deepening）

## 背景

2026-07-28 Go → Bun/TS 迁移完成后的首轮架构评审产出 10 个深化候选（A–J）。
评审报告：`/tmp/architecture-review-20260728-204901.html`（临时文件，结论已沉淀到本目录工单）。

**第一轮已落地 A / B / C（4 个 commit，勿重做、勿回退）：**

| Commit | 内容 |
|--------|------|
| `6a729bb` | A · branded `TrxHandle`（src/db/tx.ts），`withTx` 唯一产口；gl/inventory 引擎写方法只收 `TrxHandle`，裸 db 编译期被拒 |
| `a8c2710` | C · `listFromSource`/`mapWriteError` 归位 `src/db/`（list.ts / dberr.ts），platform→modules 运行时 import 归零 |
| `4917a83` | B · ① accounting 内部 seam `createAndAuditJournal(trx,…)`（无权限闸，调用方已鉴权）；② `modules/trading/posting.ts` 履约过账骨架 `auditFulfillmentInTx`/`voidFulfillmentInTx`，销售发货/采购入库/委外入库已迁入 |
| `e7c7eb3` | BIFF8 fixture 收回 `server/src/modules/finance/testdata/`，测试套件恢复全绿 |

**必须沿用的既定形状**：过账 = `withTx` 入口 + 骨架/seam 编排 + 引擎只收 `TrxHandle`；
跨域协作 = type-only import + 组合根 `Pick<>` 注入（先例：invoice→reconciliation、
banking-recon→journals）；模块 = 工厂闭包（禁 class）；金额 = `@synie/shared` decimal；
动态筛选只走 filterbuild；错误 = `ApiError`。

## 验证基线（任何改动必须保持全绿）

```bash
cd server && bun run typecheck
SYNIE_TEST_DATABASE_URL=$(python3 -c "
import re; u=re.search(r'^DATABASE_URL=(.+)$', open('.env').read(), re.M).group(1).strip().strip('\"').strip(\"'\');
print(re.sub(r'/[^/?]+(\?|$)', r'/synie_test\1', u))") bun test
# 当前 226/226 通过；synie_test 库已建好并迁移过
```

## 工单

1. `01-posting-skeleton-rollout` — B 收尾：其余过账路径迁入骨架/seam
2. `02-table-ownership-seams` — I · 跨模块表所有权收口
3. `03-printing-decouple` — D · printing 与业务域脱钩 + 删死代码
4. `04-split-giant-factories` — E · 拆巨型工厂隐藏聚合
5. `05-platform-business-knowledge` — F · 业务知识回吐出 platform
6. `06-pure-core-extraction` — J · 最重不变量提纯出 PG
7. `07-engine-interface-slimming` — G · 引擎 interface 瘦身（小，适合穿插）
8. `08-permission-check-convention` — H · 权限双检成文（先讨论后动手）

## 附录 A：顺手删除清单（均通过删除测试，随最近工单顺带清除）

- `order.service history()`（order/service.ts:841-903）——CONTEXT.md:157 已宣布被
  scm/orderflow 视图取代（删前确认前端已切）
- `AppDeps.marketInstruments` deprecated 别名（app.ts:110-111）
- `env.ts LOG_LEVEL`——解析了但全仓无消费方
- market 4 处 legacy 兼容别名（market/service.ts:988-999、routes.ts:359-364）
- `printing/service.ts:361-369` 两分支抛出相同 ApiError 的死分支
- `accounting/journal-service.ts` 的 `void idx` 死参数（validateLineShape）

## 附录 B：次要观察（不够格立工单，碰到顺手修）

- `listQuerySchema` 在 6+ 个 routes 各自重复定义且口径不一（limit min 0 vs 1）——单点化到 platform/http
- 三态补丁 presence 散在 3 个 handler 重解析 raw body（settings/files/printing routes）——service interface 应学会表达「未传/显式 null」
- `ops-routes.ts:391,433` 承兑 PATCH 用 `z.record(z.unknown())` 整包透传，绕过 zValidator 白名单
- `auth/routes.ts:21` 限流桶直取 x-forwarded-for 首跳，伪造 header 即可绕过限流
- `bank-parser.ts:727` `class CompoundFile` 违反禁 class 约定；内部英文 Error 文案（:752 等）会落进用户可见的导入失败列
- `ObjectStorage.put(key, sourcePath)` 按 local adapter 塑形 interface，50MB 文件被迫磁盘往返（files/service.ts:140-149）
- `todo/service.ts:336-339` 客户端排序被静默丢弃（fail-closed 破例，应 400 或修 CTE）——与工单 05 合并处理
- finance 域全量原生 `sql`` + Record<string,unknown>` 硬转 vs 其他域 typed builder——一仓两套 DB 边界纪律
- `buildApp` 知道 trading 28 个子路由名（app.ts:329-359）——宽 mounts 对象

## 工作纪律

- 每完成一项：typecheck + 全套测试保持 226/226 绿，单独 commit（conventional commits，中文描述，参照 git log 风格）。
- 业务规则若变，同步 `docs/产品文档/` 对应篇与 `CONTEXT.md`（根 AGENTS.md 约定）。
- 架构红线：platform 不 import modules/engines；engines 不 import modules；
  事实表只能经引擎写；过账必须单事务（引擎写方法只收 `TrxHandle`）。
- 用 module/interface/implementation/depth/seam/adapter/leverage/locality 词汇讨论设计；
  新 seam 需要两个 adapter 证明（YAGNI）。
