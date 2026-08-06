# ADR：restTransport 工厂收口资源 wire 形状、requireWriter 收口写能力收窄

2026-08-01，状态：已实施。本 ADR 是
[`2026-07-31-frontend-deep-module-seams.md`](./2026-07-31-frontend-deep-module-seams.md)
的延续——深模块 ADR 落地后，transport 层仍保留着它本想消灭的每资源样板。

## 背景

深模块收口后，`web/app/lib/resources/` 下仍有约 80 个逐资源手写的 REST client
（registry 装配 182 个 client 符号），问题集中在三点：

- 每个 client 的 query/get/create/update/delete 五方法逐行雷同（30–56 行/个），
  URL 形状本就是服务端 meta 与 Hono 路由树已经编码的约定；
- 这批手写 client 把 hc 全链路类型用 352 处 `as Row`、185 处 `as never` 抹掉，
  再在 resource-wire 重建泛型 codec，并残留一批从未使用的死类型别名；
- `RecordWriter` 方法按能力可选，页面用 `in` 收窄 + 抛错防御（30 处、13 个页面），
  同一资源的能力事实被每个调用点重复声明。

迁移期 codemod（`scripts/hc-*.mjs`）的存在本身说明样板已经痛到需要机械维护，
但治标方式不是生成更多样板，而是让约定只写一遍。

## 决策

### 1. restTransport 工厂成为标准 REST wire 形状的唯一 implementation

`restTransport(resource, endpoints, options?)` 生成标准五方法 transport，
id 恒为 `rest:${resource}`（与查询缓存身份同一约定）。options 只声明真正的
资源级差异：`strictListLabel` / `listOptions`（列表口径）、`decimalFields` /
`decimalOptions` / `dateTimeFields`（写 body wire 转换）、`capabilities`
（写能力子集）。

能力声明与端点形状在编译期关联（`RestEndpointsFor<C>` /
`RestTransportFor<C>`）：未声明 `capabilities` 时端点必须具备全部写动词且
返回完整 `ResourceClient`；声明子集后类型只要求实际存在的动词，未声明为
false 的写方法在返回类型上必然存在。response 只要求 `ApiResponseAdapter`
seam（真实 ClientResponse 与测试 fake 同形），`as Row` 等 wire 断言集中在
工厂一个文件内。声明了能力却缺动词的手写 fake 在模块装配期 fail-closed。

### 2. 偏离标准形状的资源手写或组合，不扩工厂表达力

单例设置（`settings.ts`）、非 `:id` 读取路径（`fileClient` 走 `:id/metadata`）、
封闭创建集合（行情价点）继续手写；仅个别方法偏离的（用户创建解包 `{user}`、
工资单创建零值回填）用 `{...restTransport(...), create(...)}` 组合覆盖。
工厂不为长尾加 hook——长尾显形为代码比显形为配置选项更可读。

### 3. requireWriter 收口写能力收窄

`requireWriter(binding, 'create' | 'update' | 'delete', label)` 一行返回
必然存在的写函数，不支持时按既有页面口径（`{label} 不支持 {op}`）抛错。
页面不再出现 `in` 收窄三连与 `if (!binding.writer) throw` 冗余守卫。

## 否决方案

- **按资源 codegen client**：把机械维护换成机械生成，90 个文件仍在，
  且新增一条 codegen 流水线；约定足以覆盖的形状不需要生成物。
- **OpenAPI/GraphQL 化**：违反既有技术栈定案（架构守卫已禁止）。
- **工厂提供 transform/mapResponse hook**：会把每个资源的长尾差异重新塞回
  配置，组合覆盖在调用处更直白。
- **保留页面 in 收窄**：能力事实重复声明，且报错口径逐页漂移。

## 后果

- 22 个资源文件净删约 2,700 行；`as never` 185→35、`as Row` 352→32，
  剩余均在命令 Adapter、自定义查询与聚合草稿的领域代码内。
- 新资源接入从"抄一个 client 改五遍"变为一行工厂调用 + 按需选项；
  偏离形态显式标注「偏离标准形状」注释。
- 页面写操作一行 `requireWriter`，30 处收窄样板与 12 处冗余守卫删除。
- 已知让渡：部分能力资源的端点-能力关联在 hc proxy 运行时不可探测，
  靠编译期关联 + 各领域 e2e API 测试兜底；请求 body 的逐资源精确类型
  （替代边界 `as never`）仍是后续逐资源收窄的债务，口径同深模块 ADR。

## 实施记录

- `web/app/lib/resources/rest-transport.ts` 落地工厂与编译期能力关联；
  `rest-transport.test.ts` 覆盖列表口径、wire 转换、能力子集与装配期守卫。
- `catalog/require-writer.ts` 落地并经 catalog 桶导出；13 个页面 codemod 迁移。
- `settings.ts`（单例）、`fileClient`/行情价点（非标准形状）确认保留手写；
  `userClient`/`payrollClient` 以组合覆盖迁移。
