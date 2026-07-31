# Typed Hono transport 与 wire codec

Status: ready-for-agent

## 目标

加深 Hono transport adapter，集中响应/错误解析和通用 wire codec，同时保留各资源 module 对业务 Row/Input 类型的所有权。

## 验收

- 不新增 GraphQL、OpenAPI codegen 或平行请求路径。
- Hono client 的类型信息不再被通用 `Response` 提前抹除。
- 重复的 query body、日期/金额 codec 有单一 implementation。
- transport interface 有独立行为测试。

## Comments

- 等第一波核心 seam 稳定后分派，避免与 ResourceBinding 改造同时触碰同一 adapter。
- 2026-07-31 调研：当前 `apiData<T>(Promise<Response>)` 在 interface 处抹掉 Hono `ClientResponse<Body, Status, Format>`；Hono 4.12 已提供 typed `ClientResponse`/`parseResponse`，但其 `DetailedError` 不符合项目 `APIError` envelope，改造需保留项目错误语义而不是直接替换。
- 当前资源 adapter 至少重复 14 组 query/list body 与 8 组 decimal input codec；迁移应先建立单一 implementation，再按业务域替换，避免新旧 helper 长期并存。
- 2026-07-31：ResourceBinding 迁移完成后分派给 `binding_cache`；先迁移非 aggregate 资源，quotation/fulfillment 等当前并发文件留到集成阶段。
- 2026-07-31 设计里程碑：typed `apiData` 从 Hono `ClientResponse<Body, Status, Format>` 过滤 2xx Body，运行时解析下沉到最小 response port，production response 与测试 fake 共穿同一 seam；错误仍构造项目 `APIError`。query/list 与 decimal/date codec 收进单一 resource wire module，资源保留自身 Row/Input 类型。
- 2026-07-31：19 个非 aggregate 资源文件完成迁移：显式 `apiData<T>` 148→0、重复 query/list helper 10→0、decimal helper 4→0；动态 Form `as never` 保持显式，没有用泛型断言隐藏。typed response、APIError 与 wire codec tests 共 151 pass，check/typecheck/diff check 通过。
- 2026-07-31：同时修复兼容 transport 硬编码 `rest:${resource}` 导致 custom/memory cache identity 分裂的问题；production、memory、custom Adapter 测试覆盖 identity 一致。剩余 helper/legacy 调用只在 fulfillment/orders/quotations/reconciliations 四个 aggregate 文件。
- 2026-07-31：fulfillment/orders/quotations/reconciliations 收尾后 production `apiData<T>` 与本地 query/decimal helper 均清零，旧泛型 overload 已删除。运行时对声明 JSON 的空/畸形 body fail-fast、content-type 大小写不敏感，并对错误 envelope 做最小 shape 校验；订单历史字段漂移由 Hono 推断暴露并修正。
- 2026-07-31：终验确认 response 类型与 list/decimal/date wire codec 已形成单一 implementation。动态 Catalog 表单的 request body 边界仍有可见 `as never`，保留为后续逐资源收窄请求 contract 的明确债务；本次未用更大的泛型断言掩盖它。
