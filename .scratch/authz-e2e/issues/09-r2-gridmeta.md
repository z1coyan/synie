# 09 — R2 定点断言（表格元数据反射的 fail-closed 降级）

**What to build:** 极值主体下的表格元数据定点断言（定向场景，非全量矩阵）：反射机制不成为探测面或关联入口。复用 02 的极值主体生成器，补在既有表格元数据测试旁边。

**Blocked by:** 02 — 矩阵内核 tracer bullet.

**Status:** resolved

- [x] 请求白名单外资源的表格元数据得到报错，不泄露资源是否存在的差异信息
- [x] 无目标资源 read 码时，外键引用不产出、列降级为普通列
- [x] 多态外键变体按目标 read 权限逐个裁剪，仅剩授权变体
- [x] 能力清单（按钮显隐驱动）随主体权限正确过滤（元数据侧正向对照）
- [x] 极值主体复用 02 生成器，不另造

## Comments

落地:`apps/synie_web/test/synie_web/authz_matrix_gridmeta_test.exs`(经真实 HTTP 管线,
与机制级的 SchemaGridTest 互补)。四组定点:

- 白名单外:真实资源(salSetting)与纯虚构资源(noSuchGrid)的报错除回显名外逐字一致,
  存在性零差异信息;
- fk fail-closed:无 base.company:read 时 basCompanies.parentId 降级 string/无 ref/不可筛,
  持码正向对照携带 ref;
- 多态裁剪:accGlEntries.voucherId 八个变体,只持 sales.delivery:read 时恰剩 1 个变体,
  一个都不持时整列降级;
- capabilities:无码空、持 sys.role:update 恰好 ["update"]、super_admin 等于目录反射
  的全动作(去 read)。

极值主体复用 02 的 Subjects 生成器(真实用户/角色/授权链 + token,权限码经目录反射),
未另造主体构法。
