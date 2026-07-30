# 04 — 以最小 ResourceReadSpec 收口动态查询

**What to build:** 在查询行为完全不变的前提下，让动态筛选、排序和搜索只依赖 sealed Catalog 派生的字段白名单。SQL source、select、join、公司范围和默认排序继续由领域查询显式拥有。

**Blocked by:** 03 — 以 sealed Catalog 并行投影 v1 与 v2.

Status: resolved

- [x] ResourceReadSpec 只包含字段名、数据库列、类型、枚举和 filter/sort/search capability。
- [x] filterbuild 与列表查询不再接收完整 ResourceMeta 或 ResourceDefinition。
- [x] SQL source、select、join、固定业务条件、公司范围和默认排序没有进入 Catalog。
- [x] 自由搜索只使用声明为 searchable 的字符串字段，并保持迁移前搜索结果。
- [x] 未知字段、非法枚举、非法多态引用和不可排序字段继续 fail-closed。
- [x] 工单 01 发现的查询侧 resource factory 重建全部迁移，定义注册入口除外。
- [x] 打印专用 Catalog 改用更窄的打印领域名称，打印字段仍从 sealed Catalog 派生。
- [x] 没有新增通用 SELECT builder 或 Meta 驱动写入。
- [x] 查询、打印、类型检查和数据库集成测试全部通过。

## Answer

- `ResourceReadSpec`：`server/src/platform/meta/read-spec.ts`（`toReadSpec`）
- `buildListQuery` 仅接受 ReadSpec；调用方经 `toReadSpec(meta)`
- `listFromSource` 可收 Meta 或 ReadSpec
- 打印：`ResourceCatalog` → `PrintResourceCatalog`

## Comments
