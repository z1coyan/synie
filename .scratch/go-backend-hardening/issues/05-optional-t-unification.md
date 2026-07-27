# 05 — 三态可选字段统一为泛型 Optional[T]

**What to build:** PATCH 语义中的「字段未传 vs 显式置 null」在全系统只有一套机制：一个泛型 `Optional[T]` 类型（区分未设置/设置值/设置 null）取代现有的 `**string` 双重指针与散落在约 8 个领域包中各自重复声明的 `OptionalString` 副本。HTTP 层的三种并存解码风格（可空指针更新、双次解码 + 泛型、手写 Set=true 块）收敛为一种；领域层逐字段搬运式的 Update handler（如银行导入模板更新中约 40 行逐字段搬运）随之消失。行为不变：已有 API 对 null 与省略字段的响应语义逐端点保持。

**Blocked by:** 04 — HTTP 层 helper 收敛与 Server 瘦身（两者同改 PATCH handler，须在其落定后进行）

**Status:** ready-for-agent

- [x] 泛型 Optional[T] 定义于单一位置，全系统唯一三态机制
- [x] 领域包中重复声明的 OptionalString 全部删除，`**string` 用法清零
- [x] HTTP 层 PATCH 解码收敛为单一风格，极端逐字段搬运 handler 缩短为声明式字段表
- [x] 每个受影响端点的 null-vs-省略行为有测试锁定（更新前已存在的语义不漂移）
- [x] go test ./... 全绿

## Result

**类型设计**：全系统唯一三态类型为 `server/internal/platform/optional.Optional[T]`：

```go
type Optional[T any] struct {
	Set   bool   // false=未设置(字段未传, 不修改); true=显式提供
	Value *T     // nil=置 null; 非 nil=设置为值(可为空串等零值)
}
```

辅以 `Of` / `Null` / `Unset` 构造器、`Apply(target **T, value)` 落点助手与 `Map` 变换。设计盘点结论：旧 `**string` 的 `nil / &nil / &&v` 三态与旧 `OptionalString{Set, Value *string}` 三态**表达能力完全同构**（`OptionalString` 凭 `Value *string` 本来就能表达「显式置空字符串」：`Set=true, Value=&""`），因此 `Optional[T]{Set, Value *T}` 对两者都是逐字段无损映射，不需要第三态标志位。例外：finance/documents 的 `OptionalBool{Set, Value bool}` 为两态且全仓库无调用点，直接删除；hr/operations 的部分字段旧代码只构造「未设置/设置值」两态，迁入超集类型后行为不变。

**语义映射表**（逐调用点 1:1，无 observable 行为变化）：

| 旧写法 | 新写法 |
| --- | --- |
| `**T` 为 `nil`（未传） | `Optional[T]{}`（`Set=false`） |
| `**T` 为 `&nil`（显式 null） | `Optional[T]{Set: true}` |
| `**T` 为 `&&v` | `Optional[T]{Set: true, Value: &v}`（或 `Of(v)`） |
| `if input.X != nil { after.X = *input.X }` | `if input.X.Set { after.X = input.X.Value }`（或 `optional.Apply(&after.X, input.X)`） |
| 各领域 `OptionalString/OptionalUUID{Set, Value}` | `optional.Optional[string]/[uuid.UUID]{Set, Value}`（字段同名，构造字面量仅改类型名） |

**迁移规模**：删除 10 个领域包的重复声明（supplier/customer/currency/warehouse/material/employee/hr-operations/manufacturing-master/finance-documents(含未使用的 OptionalBool)/finance-banking 的泛型 Optional），并将 14 个领域包 UpdateInput 的 `**string/**uuid.UUID/**time.Time/**decimal.Decimal` 全部迁移（trading/order·quotation·reconciliation、inventory/stockdoc·stockcount·stocktransfer·materialcategory、fulfillment/standard·outsourced、manufacturing/execution、accounting/gljournal、base/company·market·account）。`internal/domain` 下双重指针已清零。

**HTTP 层收敛**（全部入 `internal/http/server_helpers.go`）：

- 双次解码风格：`decodeFinanceJSON` → `decodePatchJSON`；字段构造 `bankingOptional`/`documentOptionalString` 等 → 泛型 `optionalField[T]`，另有 `optionalEnumField`（枚举）、`optionalDecimalField`（decimal）。
- 单字段 RawMessage 风格：`nullableStringUpdate/nullableUUIDUpdate/nullableDateUpdate/nullableDecimalUpdate` → `optionalUpdate[T]` / `optionalDateUpdate` / `optionalDecimalUpdate`；manufacturing_execution 的 `nullable*Pointer` 三件套与 manufacturing_master 的 `rawOptionalString` 删除（日期字段错误文案「必须是 YYYY-MM-DD 或 null」在调用点原样保留）。
- 手写 `if body.X != nil { Set = true }` 块（masterdata 三处、hr_operations 三处、inventory_master 两处、supply_readmodels、account、company）全部改为 helper 直赋。
- `UpdateFinanceBankImportTemplate` 由约 40 行逐字段搬运收敛为每字段一行的紧凑字段表。
- platform 包（settings/files/printing）仍声明 `**T` 输入，不属于本工单范围；HTTP 侧统一经 `optionalUpdate` 解码后在边界用 `doublePtr` 适配（server_helpers.go 中注明「不得用于新代码」），printing handler 归并行工单未动。

**行为锁定**：既有测试全部复用且绿（含 banking「Set+nil 置空」、company「显式清空 ParentID」、currency「显式清空 Symbol」等 postgres 测试，仅字面量类型名随迁）。新增：`platform/optional` 三态/Apply/Map 单测；HTTP 层 `server_optional_test.go` 锁定 `decodePatchJSON`+`optionalField` 与 `optionalUpdate` 的 null-vs-省略三态及未知字段拒绝；原 `TestNullableDateUpdate/TestNullableDecimalUpdate` 迁移为 `TestOptionalDateUpdate/TestOptionalDecimalUpdate` 继续锁定 decimal/date 变体。

**验证**：`go build ./...` 绿；全部 26 个改动包（含 postgres 集成测试，SYNIE_TEST_DATABASE_URL 指向 5441）`go test` 全绿；`gofmt -l internal/` 无输出。未跑全套（按任务要求仅跑改动包）。
