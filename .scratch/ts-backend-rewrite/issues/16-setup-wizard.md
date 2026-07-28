# 16 setup 向导 + 全链示例数据

Status: ready-for-human
Blocked by: 06, 07, 08, 10, 11, 12, 13

## Comments

- 2026-07-28 子代理：实现 `/api/v1/setup/*`（status/first-user 公开；currencies/complete 超管）、事务级 Setup 锁与 first-user 并发互斥、基础幂等种子 + C01 全业务链示例数据（失败不落旗标）、`bun run db:seed:demo`；unit+PG 集成绿；补 `verify-setup-rest` 与 demo 冒烟。
- 2026-07-28 主工作区集成：cherry-pick 去重 `80f6783`（setup 向导+全链示例数据+app/index/helpers 装配）/ `da798aa`（verify-setup-rest + demo 冒烟）。与工单 17 的 minimal setup 冲突时保留本工单完整实现（含 sampledata 依赖注入）。装配：`createSetupService({db,tokens,sample})` → `buildApp({setup})` → `.route('/setup', setupRoutes(...))`；helpers 注入 setup。未改 server-go。
- 2026-07-28 独立全量验收：`:18090` `verify-setup-rest` demo 冒烟全绿（C01 + 销采/库存/凭证/银行）；setup PG（并发 first-user / complete 含示例 / C01 幂等）绿。加固：setup 集成 afterAll 清空种子避免污染共享 synie_test；numbering/market 集成在规则占满或无 admin 时自愈。
- 2026-07-28 隔离 worktree 复验（grok-4.5）：setup unit 3 + PG 集成 3 绿；`:18091` `verify-setup-rest` demo 冒烟绿（C01 + 销采/库存/凭证/银行列表）；装配仍为全量 sampledata（非 17 minimal）。未改 server-go。
- 2026-07-28 补 remaining：修 `verify-setup-rest` 空库路径 `init-template` 期望 201（非 200）；setup afterAll hook 超时放宽至 120s；空库库 `synie_setup_e2e` + `SYNIE_SETUP_E2E=1` 全路径（first-user 并发 409 / complete+示例 / demo 冒烟）绿；setup 6 pass。

- 2026-07-28 主工作区集成（grok-4.5 缺口）：cherry-pick 去重 `cf7b2d2`（公司默认过账科目 PG 集成）/`b0ba293`（04–07 编号 23505→conflict + inventory 自愈 + verify-inventory 停车编号）/`3f84ab7`（09–14 编号 conflict 测 + OCR 默认存储 + HR 编号腾空 + market fixture）/`bc43cef`（todo 忽略复位）/`4358af8`（printing render 冒烟）/`b8538aa`（setup 空库 e2e afterAll 超时）；合并重复 numberingWriteError；app/index/Meta/helpers 已完整装配，未改 server-go。
## 范围

1. **Setup 端点**（`/api/v1/setup/status|first-user|currencies|complete`；同一 PG 事务级 Setup 锁；首用户并发只允许一个成功，置 super_admin+all_companies 并返回 JWT；完成=写首选语言+幂等基础种子（编号规则/物料两级分类/机加工单位/存储接入）+可选示例数据+落 setup_completed_at；示例失败不落旗标）
2. **示例数据**（客户 C01 幂等：覆盖客商/物料/员工主数据、销售全链（报价→订单→发货→对账→发票结单）、采购全链、委外全链、库存三单、工序/工艺/BOM、银行流水、手工凭证、报销单、工资单、销/进项发票；近 3 个月日期分布）
3. demo 快捷种子（`bun run db:seed:demo`，等价旧 mix synie.demo：admin/admin123 + JT 公司 + 示例数据）

## 行为参考

`server-go/internal/platform/setup/`（含 sampledata）；CONTEXT「初始化向导」「示例数据」词条。

## 验收

- 空库端到端：migrate → setup/status → first-user → complete(含示例) → 登录 → 关键列表/单据冒烟
- 示例数据幂等（重复 complete 不产生重复 C01）
- 并发 first-user 仅一成功
- `bun run db:seed:demo` 可一键搭演示库（未初始化时）
- 活服务：`SYNIE_API_URL=... bun .scratch/migration/verify-setup-rest.ts`（demo 冒烟；空库全路径加 `SYNIE_SETUP_E2E=1`）

## 交付

- `server/src/platform/setup/`（service/routes/sampledata + unit/PG 集成）
- `server/db/seed-demo.ts` + `package.json` `db:seed:demo`
- `.scratch/migration/verify-setup-rest.ts`

## 非目标

不做向导 UI 改版（前端现状对齐即可）。

- 2026-07-28 独立全量验收（主工作区 grok-4.5）：`server typecheck` 绿；`SYNIE_TEST_DATABASE_URL=…synie_test bun test` 223 pass；`web typecheck` + `bun test` 92 pass；shared decimal 5 pass。活 API :18095 对独立库：17 个 `verify-*.ts` 全绿 + setup 空库 e2e（synie_setup_e2e）+ `verify-web-hc-api` 关键路径绿。修 verify 空库/setup 自愈（inventory 公司单位、printing 默认存储、accounting/quotation 编号规则临时停用）。未执行工单 18；未 push/reset；未改 server-go。
