# 02 — HTTP/领域层正确性修正包

**What to build:** 一批互相独立的小型正确性修正，合在一起交付以下行为保证：对单据提交一个拼写错误的动作名会得到明确的校验错误而不是静默作废单据；越权访问他公司数据时全系统统一表现为「资源不存在」（防探测），不再出现有的模块返回 403 有的返回 404 的分裂；待办未读计数不再要求一个语义错位的「创建发票」权限；服务端错误日志能看到底层根因（如 PG 约束名），而不是只有一句中文提示；请求参数绑定失败时错误消息能区分路径参数与查询参数。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [x] 订单状态迁移接口收到未知 action 时返回校验错误，绝不落入作废分支；补充对应测试
- [x] 公司越权响应全系统统一为 NotFound（含仓库等当前返回 Forbidden 的模块），行为有测试锁定
- [x] 待办未读计数端点改用与其只读语义匹配的权限码
- [x] apierror 的 Error() 输出包含 Cause 链，日志可定位根因；对外响应体不变（不泄露内部细节）
- [x] 路由参数绑定错误处理器区分 path/query 来源，消息准确
- [x] 删除评审发现的不可达死代码（如订单汇率双重空判断）；硬编码默认税率外提为命名常量
- [x] 登录接口「JSON 解析失败按密码错误处理」的防枚举意图补充注释说明

## Result

1. **订单状态迁移防呆**：`server/internal/http/server_order.go` 的 `transitionOrder` 改为 audit/close/void 三个显式分支，未知 action 走 default 返回 `apierror.Validation`（字段 `action` 带出非法值），绝不落入 Void。测试 `TestTransitionOrderRejectsUnknownActionWithoutTouchingService`（400 且服务层零调用）与 `TestTransitionOrderDispatchesKnownActions`（三个 action 各分发一次）锁定。
2. **公司越权统一 NotFound**：全局核查 `CodeForbidden`×`CanAccessCompany` 组合后，「记录存在但属于他公司」的反例集中在 `server/internal/domain/inventory/warehouse/lifecycle.go` 的 Update/Delete（Get 本就经 `AppendCompanyFilter` 返回 NotFound），已改为 `NotFound「仓库不存在」`。其余模块单记录访问路径（order/quotation/stockdoc/stocktransfer/stockcount/stockentry/glentry 等）本已是 NotFound；create/list/report 类「目标公司不可访问」与操作权限类 Forbidden 不在本项范围（platform/files 归工单 09，未触碰）。新增 `lifecycle_postgres_test.go` 真实库测试锁定跨公司 Get/Update/Delete 均 NotFound 且数据未被改动。
3. **待办未读计数权限码**：权限目录中不存在可授权的待办自身 read 码（`_sysTodosInternal` 未注册进 catalog，`sys.todo:read` 无法经角色同步授予，使用会把非超管全部 403），故改用语义匹配的只读码 `acc.vat_invoice:read`；HTTP 层 `GetTodoUnreadCount` 与服务层 `UnreadCount` 同步替换（只换这一处，待办列表/已读/忽略仍按产品文档用 create 权限）。`service_postgres_test.go` 的 actor 助手改变参并补「仅 read 权限可读未读数」断言；`docs/产品文档/待办.md` 可见性一节已同步（CONTEXT.md 术语定义不变）。
4. **apierror.Error() 带 Cause**：有 Cause 时输出 `Message + ": " + Cause.Error()`，无 Cause 保持原样。对外响应体由 `writeError` 直接取 `appErr.Code/Message/Fields` 构造，不经过 `Error()`，格式不变；仅 5xx 服务端日志（`"error", err`）现在能看到 PG 根因。新增 `TestErrorIncludesCause`（含 errors.Is 链保持）。
5. **参数绑定错误区分 path/query**：oapi-codegen 的 `RequiredParamError`/`InvalidParamFormatError` 不携带来源，`bindingError` 借助 chi 路由模式判断参数名是否出现在路径中，分别返回「请求路径参数不合法」(fields.path) /「请求查询参数不合法」(fields.query)。
6. **小修**：删除 `order.go` `normalizeCurrency` 中 `exchangeRate == nil` 提前返回后的不可达同条件分支，并移除随之 unused 的 `requireExplicit` 形参（两处调用点同步）；`item.go` 默认税率外提为命名包级变量 `defaultItemTaxRate`（0.13，注释注明增值税 13%）；`Login` JSON 解析失败分支补防枚举注释。

验证：`go build ./...`、`go vet` 与 `SYNIE_TEST_DATABASE_URL=... go test ./internal/http/ ./internal/platform/apierror/ ./internal/domain/inventory/warehouse/ ./internal/domain/trading/order/ ./internal/domain/systemops/` 全部通过（含真实库用例，非 skip）；改动文件均过 gofmt。
