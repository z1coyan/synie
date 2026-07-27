# 09 — 文件 owner 注册表改注册式

**What to build:** 附件归属关系（哪些领域资源可以挂文件、用什么权限前缀）从 platform 包中硬编码的 15 张表名清单，改为由各领域包向 files 注册自己的 ownerSpec（与 meta.Registry 同一范式）。此后新增一个可挂附件的领域资源不再需要修改 platform 层，platform→domain 的反向知识下渗被斩断。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [x] files 提供 ownerSpec 注册接口，15 个现有归属关系改由各领域包注册
- [x] platform/files 中不再出现任何领域表名或权限前缀字面量
- [x] 注册重复/缺失有防御（注册时校验或启动时 panic，同 meta.Registry 先例）
- [x] 现有文件上传/归属校验行为不变，相关测试全绿

## Result

- `internal/platform/files/owner_registry.go`：导出 `OwnerSpec{Table, PermissionPrefix, CompanyScoped}` 与 `RegisterOwner(ownerType, spec)`（重复注册/spec 不完整即 panic，同 MustRegister 先例），新增 `RegisteredOwners()` 快照供装配测试对拍；`resolveOwner` 与下载守卫改读注册表（`lookupOwner`），15 条硬编码清单移除。
- 15 条归属改由领域包声明 `FileOwnerSpecs()`：sales/customer、purchase/supplier、hr/employee、inventory/material、accounting/gljournal、finance/banking（2 条）、finance/documents（3 条）、trading/order（2 条，复用 sideSpec）、fulfillment/standard（2 条，复用 sideSpec）、platform/printing（sys_print_template）。
- 装配：`internal/app/metaregistry/file_owners.go` 新增 `RegisterFileOwners()` 集中注册；`cmd/synie/main.go` 在 `RegisterAll` 后调用，resolveOwner 使用前完成。
- 防御测试：files 包重复/不完整注册 panic 单测；metaregistry 15 条基线对拍装配测试（`TestRegisterFileOwnersMatchesBaseline`，清单对拍风格同 companyFilterRequired）；files 测试经 `owner_assembly_test.go` 的 init 走生产同款装配，包内无领域字面量。
- 验证：`go test ./internal/platform/files/ ./internal/app/metaregistry/`（含真实库 resolveOwner 行为测试）全绿；改动包 `go vet` 通过；全部改动 gofmt 干净。
- 遗留说明：`service.go` 的删除守卫仍直接查询 `sys_print_template`（platform/printing 的表，非本工单 15 条归属清单范围），如需斩断可另开工单做删除守卫钩子。
