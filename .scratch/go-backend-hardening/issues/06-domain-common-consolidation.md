# 06 — 领域层公共化：dberr + 泛型 List 执行器 + meta 助手上移

**What to build:** 纯结构收敛，不改变任何业务行为。之后每个领域模块不再各自复制五段样板：PG 错误码映射收敛到单一公共组件（各模块以「约束名→中文文案」表声明差异，23505/23503/23514 的映射逻辑只写一遍，消灭现有 5+ 份 writeError）；`filterbuild.Build` 之后的「只读事务 + count + 分页 + 逐行 scan」收敛为一个泛型 List 执行器，每个模块省约 40 行，且公司隔离过滤的 scopedWhere 不再有返回 2 值/3 值/布尔语义取反三种签名；meta 构建助手（字段/枚举/引用/标准动作集的快捷构造）上移为 `platform/meta` 的一等公民，三种 meta 写法（表驱动助手、另一套助手、纯字面量）至少统一助手部分。分页边界校验（1–200）随之单点化。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [x] 公共 PG 错误映射组件落地，各模块 writeError 删除并以约束名文案表替代；错误响应文案不回归（有测试）
- [x] 泛型 List 执行器落地，主要模块的 List 方法迁移；count 与列表同事务一致性保持
- [x] scopedWhere 全系统单一签名，空集合语义（无可见公司时返回空结果）有测试锁定
- [x] meta 构建助手进入 platform/meta，order/banking/hr-operations 三套私有助手收敛
- [x] pgtype 转换助手（text/date/timestamp/optionalText）公共化，4+ 份拷贝删除
- [x] 分页参数校验单点化，各模块重复边界检查删除
- [x] go test ./... 全绿，含真实 PG 集成测试

## Result

纯结构收敛，业务行为（错误文案、状态码、查询结果）保持不变。共 79 个文件改动（+1383/-3305），另新增 4 个公共包文件；未修改任何既有 `*_test.go`，未改动 internal/http、internal/platform/audit、internal/platform/settings、internal/platform/files、cmd/。

**新公共 API**

- `internal/platform/dberr`（dberr.go）：
  - `type Mapping struct { Code, Constraint, Message string; Validation, Bare bool }`——按声明顺序首个命中；`Code==""` 时按 `err.Error()` 包含 `Constraint` 匹配非 PG 错误（company/currency 的 "duplicate key" 兜底）；`Validation` → 400，否则 409；`Bare` → `apierror.New`（trading/reconciliation 历史行为）。
  - `func MapWrite(err error, fallback string, mappings ...Mapping) error`
  - `func GenericMappings() []Mapping`（banking / finance-documents / hr-operations 三包一致的通用表）
- `internal/db/listexec`（listexec.go）：
  - `func List[T any](ctx context.Context, spec Spec[T], query Query) (Result[T], error)`
  - `Spec[T]{Pool, Resource, Label, Source, Select, DefaultOrder, Tiebreaker, DefaultLimit, Actor, CompanyColumn, AdjustWhere, RawTail, Scan}`——只读事务（RepeatableRead ReadOnly）内 count+分页查询同事务一致；`Label` 生成与各模块历史逐字一致的五条错误文案；`Actor` 非 nil 时走 `filterbuild.ApplyCompanyFilter`（空集合→永假条件）；`RawTail` 保留 unit/market 的 rows.Err/commit 原样透传。
  - `func ValidatePage(limit, offset int) error`——分页边界（1–200/非负）单点。
- `internal/db/pgconv`（pgconv.go）：`Text/TextPtr/OptionalText/Date/DateAlways/DateUTC/Timestamp/TimestampAlways/NullableDate/OptionalDate/OptionalTime/DateValue`，按历史副本的细微语义差异（零值无效 vs 恒有效 vs UTC+恒有效）分别对应。
- `internal/platform/meta`（helpers.go）：`Field/IDField/ScalarField/EnumField/Ref/RefField/CRUDActions`，由 order（f/enumF/ref/withRef）与 banking、hr-operations（idField/scalar/enum/ref/crudActions）三套私有实现收敛，三包私有实现已删除并迁移；纯字面量模块未动。

**迁移规模**

- dberr：28 处 writeError/mapWriteError/databaseWriteError/marketWriteError/todoWriteError/writeErr/referenceError 副本全部改为 dberr 委托（每包一份 `[]dberr.Mapping` 文案表或内联表），错误文案逐模块对照迁移前保持不变；`dberr_test.go` 锁定映射顺序、Validation/Bare/duplicate-key 兜底与 GenericMappings 全部文案。
- listexec：27 个 List 方法迁移，覆盖 17 个包（base/account·company·currency·unit·market×2、hr/employee、inventory/material·materialcategory·materialunit·warehouse·stockentry·stockdoc×2·stockcount×2·stocktransfer×2、accounting/gljournal×2·glentry、finance/banking×6、purchase/supplier、sales/customer·companyaccountdefault）。gljournal 的行筛选 EXISTS 子句与 warehouse 的委外谓词经 `AdjustWhere` 注入；每包净减约 40 行脚手架。trading/fulfillment/manufacturing/finance-documents/systemops 等含投影或特殊流程的 List 未迁移（非“主要模块”），保留原样。
- scopedWhere：banking 的布尔取反版（possible）、gljournal 的 3 值版（empty）、stocktransfer 的 applyCompanyScope 全部删除；调用点随 List 迁移走 ApplyCompanyFilter 的永假条件空集合语义（count=0、results=[]，与原短路返回一致）。剩余包的 scopedWhere 均为同一 2 值签名。空集合语义由 `listexec_postgres_test.go`（真实 PG）与 filterbuild 既有 company isolation 测试双重锁定。
- pgconv：20 个包约 40 份 text/toText/fromText/textPtr/optionalText/optionalTimestamp/date/timestamp/nullableDate/optionalDate/optionalTime/dateValue 拷贝删除。
- 分页校验：迁移模块的重复边界检查（含 material 系 validatePage、banking validatePage、gljournal paginationError、market invalidPagination）全部删除，单点为 `listexec.ValidatePage`。

**行为差异说明（仅非法输入的字段粒度）**：分页校验单点后，当仅 offset 为负时，原“双键齐报”（banking、gljournal、stockdoc 等 B 形态）与原“只报 limit”（unit、market 的 C 形态）统一为按字段精确报告（`{"offset": [...]}`）；limit 越界时报错不变。无任何测试断言该内部细节，未改动测试。

**验证**：`go build ./...` 通过（internal/http 存在并行代理在途改动导致的临时编译错误，与本工单无关）；`SYNIE_TEST_DATABASE_URL=postgres://synie:synie@localhost:5441/synie_test go test ./internal/domain/... ./internal/db/... ./internal/platform/meta/... ./internal/platform/dberr/...` 全绿（含各包真实 PG 集成测试与 meta 快照测试）；`gofmt -l internal/` 为空；`go vet` 通过。新增测试：`dberr_test.go`、`listexec_test.go`（ValidatePage）、`listexec_postgres_test.go`（count/分页/公司隔离/空集合语义）。
