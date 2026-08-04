# 03 — ResourceMeta.authz 声明与目录投影

**What to build:** `ResourceMeta` 新增 `authz` 块（company/global/via 三形态，见 spec §5），register 缺失即抛错（对齐 classification 先例）；seal 校验：声明列存在于 fields、`via.parent` 在目录内、global 资源确无 company_id 物理列、`recordGrants`/`dept` 声明列与 mode 合法。全量存量资源补声明（绝大多数为 `company` 或 `global`，`via` 首批：scm orderflow 投影、各子行 items 资源、`readPermissionsAny` 两处换代）。权限目录投影 `supportedScopes`（无 owner 声明无 self、无 dept 声明无 dept/deptTree）。本工单只声明不执行（执行点在 04）。

**Blocked by:** 01

**Status:** ready-for-human

- [x] authz 类型 + register/seal 校验（fail-closed，报错点名资源与缺失项）
- [x] 全量存量资源补 authz 声明；对照现状 list 侧「有无 extraWhere」清单核对 company/global 归类不漂移
- [x] readPermissionsAny 字段删除，两处消费者改 via.anyOf
- [x] permissionCatalog 携带 supportedScopes；ResourceDocument 暂不变（v3 在 14）
- [x] catalog 特征化测试更新（seal 报告、目录快照）

## Comments

2026-08-05 实施：类型在 `platform/meta/types.ts`，校验与派生在 `platform/meta/resource-authz.ts`
（register 期 assertValidAuthzDeclaration，seal 期 assertAuthzClosure，另出 resolveAuthzTarget 供执行面）。
103 个资源全部声明：company 33 / global 35 / via 35（分布快照进 resource-authz.test.ts 防漂移）。
`readPermissionsAny` 已删除，两处消费者换为 `authz.readAnyOf`——**与工单原文「改 via.anyOf」有意偏离**：
`scmOrderFlowItems` 是四类单据的 UNION 投影，没有单一 parent+fk，`via` 表达不了；
`hrAttendanceImports` 的 anyOf 是同资源 import-as-read 重载，也无宿主。故把码级组合子
（`readAnyOf`）与行级形态（company/global/via）拆成正交两维：`via` 只管「判定递归宿主」，
`readAnyOf` 只管「哪些码算可读」。声明即执行（guard 与文档投影同源），S2 的「声明而不执行」已消除。
`PermissionGroup` 增 `supportedScopes`（第一期全为 ['all']，owner/dept 声明随 06/07 落地后自动放开）。
