# 01 平台层补全：settings / numbering / audit / files

Status: ready-for-human
Blocked by: 无

## 范围

在既有骨架上补全四个平台模块（编码约定见 `server/README.md`，一律工厂闭包）：

1. **settings**：`sys_setting`/`acc_setting`/`sal_setting`/`mfg_setting` 四个单行表资源——`GET/PATCH /api/v1/settings/{supply-chain,production,finance,system}`（无 list/create/delete；种子行恒存在；密钥字段 write-only 只写不回读；对齐 OpenAPI/Go，非旧 issue 草稿路径）。
2. **numbering**：编号规则 CRUD + 取号服务（固定文本/记录字段/序号段组合；序号按段渲染结果及公司隐含范围独立计数；padding 0 不补零、1..12 补零；字段段空则省略）+ 计数器校正（必留审计）+ 删规则级联删计数器。
3. **audit**：字段级写操作留痕（旧值→新值，只增不改不删）；敏感字段不落值（Meta `audit.sensitiveFields` 驱动）；提供 service 钩子供各域 create/update/delete 调用；查询面 `POST /system/audit-logs/query` + `GET /system/audit-logs/{id}`。
4. **files**：`sys_file`（不可变、≤50MB、SHA-256）+ `sys_storage` 存储接入点（本地/S3 兼容；全局恰一个默认，切换串行化；访问密钥只写不回读）+ `sys_attachment` 挂接（宿主白名单 fail-closed，公司归属固化；有挂接不可删；列表/下载按公司范围+宿主读权限）。

## 行为参考

`server-go/internal/platform/{settings,numbering,audit,files}/`（服务与 SQL）；wire 形状对齐 `contracts/openapi/openapi.yaml` 对应端点。

## 验收

- `SYNIE_API_URL=http://localhost:8081/api/v1 bun .scratch/migration/verify-settings-rest.ts` 与 `verify-numbering-rest.ts` 全绿（脚本 env 名顺带泛化：新增 `SYNIE_API_URL`，保留 `GO_API_URL` 兼容）
- audit/files 的 bun 单测 + PG 集成测试（`SYNIE_TEST_DATABASE_URL`）
- `bun test` + `bunx tsc --noEmit` 绿；路由链式挂载（ApiType 不断链）

## 非目标

不做 OCR 配置面以外的 OCR 调用实现（随发票工单 09）；不做 S3 multipart 高级特性（对齐 Go 现状即可）。

## Comments

- 2026-07-28 集成代理：合并分片 audit→files→settings/numbering/装配（去重 monorepo 分片提交；`app.ts`/`index.ts` 链式挂载 settings/numbering/files/storages/audit-logs；Meta 注册四模块；`helpers.ts` 提供完整平台装配；verify-settings/numbering `SYNIE_API_URL` 已泛化）。验证：`bun run typecheck` 绿；`SYNIE_TEST_DATABASE_URL=…synie_test bun test` 52 pass；活 API（PORT=8081 对 synie_test）`verify-settings-rest` meta=4 API=4 audit=4 secret=[FILTERED]；`verify-numbering-rest` resources=25 fields=695 全绿。遗留：业务域 `FileOwnerSpecs` 随各域落地注册 OwnerRegistry；S3/OSS 对象实读写仅对齐 Go 现状（local 完整 + presign）。
- 2026-07-28 独立验收（阶段 A）：对照 OpenAPI 路径与权限先于 zValidator；`bun run typecheck` 绿；全量 `SYNIE_TEST_DATABASE_URL=…synie_test bun test` 99 pass（含 files/settings/numbering/audit 单测与 PG 集成）；活 API（PORT=18083）`verify-settings-rest` meta=4 API=4 audit=4 secret=[FILTERED]；`verify-numbering-rest` resources=25 fields=695 全绿。无代码缺陷需修。
- 2026-07-28 隔离 worktree 复验（grok-4.5）：对照硬约束（工厂闭包/decimal/DbHandle/filterbuild/ApiError/Hono 链式+zValidator/Meta/wire）；`bun run typecheck` 绿；`SYNIE_TEST_DATABASE_URL=…5441/synie_test bun test test/ src/engines src/modules/base|iam|party|sales` 118 pass（含 settings/numbering/files/audit 集成与权限矩阵）。活 API PORT=18092：`verify-settings-rest` meta=4 API=4 audit=4 secret=[FILTERED]；`verify-numbering-rest` resources=25 fields=695 全绿。无代码变更；未改 server-go；未 push。
- 2026-07-28 补 remaining 复验：`bun run typecheck` 绿；相关 suite 120 pass；活 API :18093 `verify-settings`/`verify-numbering` 全绿。验收闭环，无平台层缺口。
- 2026-07-28 主工作区集成（grok-4.5 缺口）：cherry-pick 去重 `cf7b2d2`（公司默认过账科目 PG 集成）/`b0ba293`（04–07 编号 23505→conflict + inventory 自愈 + verify-inventory 停车编号）/`3f84ab7`（09–14 编号 conflict 测 + OCR 默认存储 + HR 编号腾空 + market fixture）/`bc43cef`（todo 忽略复位）/`4358af8`（printing render 冒烟）/`b8538aa`（setup 空库 e2e afterAll 超时）；合并重复 numberingWriteError；app/index/Meta/helpers 已完整装配，未改 server-go。
