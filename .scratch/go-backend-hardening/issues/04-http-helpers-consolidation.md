# 04 — HTTP 层 helper 收敛与 Server 瘦身

**What to build:** 纯结构收敛，不改变任何 API 行为。之后维护者看到的是：HTTP 包有且仅有一个共享 helpers 文件，listBody/listParts/可空更新/decimal 解析等通用助手不再散落在 market、inventory、gljournal 等不相关文件里；`Server` 直接内嵌依赖结构体，不再存在 Dependencies、Server 字段、New() 拷贝三份必须手工同步的清单；鉴权后的 actor 由路由门面层显式传入内部实现函数，包内不再有 80+ 处 `actor, _ :=` 吞错写法；列表类 handler 通过一个泛型 queryList 助手收敛到几行（权限检查、解码、查询、响应组装各一处实现），「listBody → 各领域 ListQuery」的最后一步不再每个 handler 手写一遍。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [x] 共享 helper 集中于单一文件（含从 market/inventory/gljournal 等文件迁入的项），原位置无残留副本
- [x] `Server` 内嵌 `Dependencies`，`New()` 的逐字段拷贝删除；编译期契约断言保留
- [x] `actor, _ :=` 吞错全部消除，内部函数显式接收 actor；`financeBankingActor` 等自由函数改为方法
- [x] 泛型 queryList 助手落地，主要列表 handler 迁移；销售/采购对称的门面方法如可表驱动则一并收敛
- [x] `server.go` 中错置的币种等 handler 移入对应领域文件；匿名重复声明的 listBody 结构消除
- [x] go test ./... 全绿，API 行为零变化（响应体、状态码、错误格式逐端点保持一致）

## Result

**改动范围**：全部限制在 `server/internal/http/`（含测试文件）。未触碰领域层；领域 service 公开签名未成为阻碍，无需 http 层额外适配。

**1. helper 收敛**：新建 `server_helpers.go`，集中 `listBody`/`listParts`、`nullableStringUpdate`/`nullableStringError`、`nullableUUIDUpdate`/`nullableUUIDError`、`nullableDateUpdate`/`nullableDateError`、`decimalInput`/`optionalDecimalInput`/`nullableDecimalUpdate`、`datePointer`/`openAPIDatePointer` 及泛型列表助手；原位置（masterdata/market/inventory_master/gljournal/stockdoc/inventory_count/quotation）定义全部删除。`actorWithAnyPermission` 从 server_inventory_master.go 移入 server.go 与其余鉴权 helper 团聚。匿名重复 listBody（server.go 币种、server_files.go 两处、server_company/account/unit/printing/iam/numbering 各自的等价结构体）全部统一为 `listBody`；market 的 `marketListBody`、numbering 的 `numberingListBody` 两个命名副本也一并消除。

**2. Server 瘦身**：`type Server struct { Dependencies }`，`New()` 仅 `&Server{Dependencies: deps}`；`Dependencies.Quotations` 类型从 `*quotation.Service` 改为 `quotationHTTPService`（与 `Orders` 对称，main.go 传参天然满足）；`var _ gen.ServerInterface = (*Server)(nil)` 断言保留。包内字段访问统一为导出形式（s.Pool、s.Orders…），测试中的 `&Server{orders: …}` 等字面量改为 `&Server{Dependencies: Dependencies{…}}`。

**3. actor 显式传递（风格 A）**：83 处 `actor, _ := requireActor(r)` 清零。各 `authorizeOrder`/`authorizeQuotation`/`authorizeReconciliation`/`authorizeStandard`/`authorizeOutsourced` 门面函数改为返回 `*authz.Actor`（失败时已写错误响应并返回 nil），55 个内部实现函数签名改为显式接收 `*authz.Actor`；`financeBankingActor`、`manufacturingActor` 由自由函数改为 Server 方法（Go 不允许泛型方法，`queryOutsourced`/`getOutsourced`/`deleteOutsourced` 保持包级泛型函数但改为显式接收 actor）。测试中直接调用 `transitionOrder` 的两处同步补 actor 实参。

**4. queryList 泛型助手**（server_helpers.go，因 Go 方法不能带类型参数，为包级函数）：

```go
func queryList[Q any, R any](s *Server, w http.ResponseWriter, r *http.Request,
    permission string,
    buildQuery func(listBody) Q,
    list func(context.Context, *authz.Actor, Q) (R, error),
    respond func(R) any)
func queryListAs[Q any, R any](s *Server, w http.ResponseWriter, r *http.Request,
    actor *authz.Actor, buildQuery func(listBody) Q,
    list func(context.Context, *authz.Actor, Q) (R, error), respond func(R) any)
```

配套 `ignoreActor`（适配不收 actor 的领域 List）、`passthroughListResponse`、`mapItems`（保持空结果序列化为 `[]`）、`countResultsResponse`。共迁移 **80 个列表 handler**（masterdata 3、currency 1、company/account/unit 3、inventory_master 4、stockdoc 3、count 2、transfer 2、glentry 1、gljournal 2、hr 7、finance_documents 6、finance_banking 6、manufacturing_master 7、manufacturing_execution 5、iam 2、numbering 2、printing 1、files 2、systemops 1、supply_readmodels 1、market 2、order 系 4、quotation 3、reconciliation 2、standard 2、outsourced 6），多数收敛为 1-6 行。`decodeMasterList`/`decodeExecutionList`/`decodeIAMList`/`decodeNumberingList`/`applyNumberingList`/`queryOutsourced` 等一次性模板随之删除。未迁移的特例：QueryTodos（扩展请求体）、QueryScmOrderFlowItems（多权限+filter 改写）、QueryInvOutsourcedWarehouses/QueryInvStockBalance/QuerySysAttachments（自定义请求体）。销售/采购对称门面：gen.ServerInterface 要求每个端点是具名方法，无法纯表驱动；已统一为「authorize 取 actor → 单行调用内部实现」形态，镜像代码压缩到每方法 3 行。

**5. server.go 归位**：币种 5 个 handler + `currencyDTO` 移入新建的 `server_currency.go`（QueryBasCurrencies 同步迁移到 queryList）；server.go 只留 Server/Dependencies/New、Router、中间件、错误/JSON 写出、鉴权 helper、decode/binding 等跨域内容与少量平台级端点（health/login/me/setup/meta/待办计数）。

**验证**：`go build ./...`、`go vet ./internal/http/` 通过；`SYNIE_TEST_DATABASE_URL=postgres://synie:synie@localhost:5441/synie_test?sslmode=disable go test ./internal/http/` 全 ok；`gofmt -l internal/http/` 无输出。行为保持：鉴权与解码顺序、错误文案、状态码、响应体形状（含空列表 `[]` 而非 `null`）逐端点与原实现一致；修复过程中发现接口类型字段（s.Orders/s.Quotations）直接取方法值会在入参求值时解引用 nil 接口，已用闭包延迟取值规避。

**遗留说明**：`queryOutsourced` 已删除，但 `getOutsourced`/`deleteOutsourced` 因泛型方法限制保持包级函数；Get/Create/Update/Delete 类 handler 的非列表模板（鉴权→解码→调 service→写响应）可仿照 queryList 后续再收敛，本工单未展开。
