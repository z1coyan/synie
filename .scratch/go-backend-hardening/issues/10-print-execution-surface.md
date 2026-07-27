# 10 — 打印执行面补齐（Go 渲染 + 契约端点 + 前端接通）

**What to build:** 用户在 Go-only 部署下可以对单据执行打印/导出：请求走 OpenAPI 契约内的打印端点，Go 服务端完成 xlsx 模板渲染与 PDF 转换（soffice 管道随服务部署可用），前端打印入口从 Elixir 时代的 `/api/print` 暗管切换到契约客户端。当前「Web Go-only 切流已完成」声明下唯一的产品功能空洞被填上。

**Blocked by:** None — can start immediately

**开工前强制步骤：** 核对 `.scratch/print-engine/`、`.scratch/print-document-pipeline/`、`.scratch/print-pdf-deploy/`、`.scratch/print-universal-catalog/` 与 `plans/001-006` 的既有规划，明确本工单与它们的边界——若既有 spec 已覆盖执行面，本工单改为引用/合并该 spec 的剩余范围，不重复规划；核对结果记录在本文件 Comments 区。

**Status:** ready-for-agent

## Comments

**2026-07-27 边界核对结论（开工前强制步骤）** — 已通读 `.scratch/print-engine/`（map + issues 01-03）、`print-xlsx-engine`、`print-document-pipeline`、`print-pdf-deploy`、`print-universal-catalog`、`print-template-master` 各 spec 与 `plans/001-006`，并对照 Elixir 实现（`backend/apps/synie_core/lib/synie_core/printing/` 全部 + `synie_web/controllers/print_controller.ex`）。

既有规划已覆盖（本工单不重复规划，直接沿用其定案语义）：

- **引擎语义**（print-xlsx-engine + issues 01/02 + plans/001/002）：`render_pages`（多块顺序铺 + 块间分页符，按最大行号偏移）、`render_sheets`（每单 sheet + 名清洗/去重）、多循环区/`_seq`/0 行删模板行/mergeCell·打印区域·手工分页符顺移。Elixir 侧已 resolved，本工单按修复后语义移植 Go，不重做设计。
- **PDF 转换**（print-pdf-deploy + issue 03 + plans/006）：soffice 哑转换、独立 UserInstallation profile、`timeout(1)` 默认 TERM + `-k 5` 包裹、全局并发限流（默认 2）、错误契约（soffice_not_found/timeout/convert_failed/no_output）、导出路径不触 PDF。Go 转换器照搬该进程卫生约束。
- **编排/权限**（print-document-pipeline + plans/004）：print/batch_print/export 按资源权限码、批量 1..100、模板管理权限与单据打印权限解耦、记录级公司数据权限、文件名规则、中文错误文案。Go 门面照搬。
- **字段目录**（print-universal-catalog + plans/003/005）：Go 侧 `platform/printing` 已有捕获快照 `field_catalog.json`（60 资源/1223 头字段/28 循环区）与上传校验，本工单沿用快照；**快照合并进 meta.Registry 是工单 12，不做**。
- **模板主数据 CRUD/附件挂接**（print-template-master + plans/005）：Go 已完成，不在本工单。

本工单范围（据此裁剪）：

1. OpenAPI 新增 `POST /printing/render`（对齐 Elixir `POST /api/print`：body resource/ids/template_id/mode，响应**二进制文件流** + Content-Disposition 附件名，非 base64 JSON——以 Elixir PrintController 为准），oapi-codegen 重新生成并实现 handler。
2. Go 渲染器（`platform/printing` 新增文件）：render_pages/render_sheets 全语义移植，资源无关。
3. Go PDF 转换器：可注入接口 + soffice 实现，无 soffice 时返回明确错误（降级不崩溃）；渲染/导出路径不依赖 soffice。
4. 单据装配（DocBuilder）**本期只接 `sales.order`**（对齐 print-engine 先例与验收框；其余 59 资源返回明确「未接入」错误，装配 seam 留好），销售发货等资源接入是后续工单。
5. 前端 `print.ts` 的 `runTemplateOutput` 切契约客户端，`/api/print` 暗管清零。

明确不做：Docker 镜像内 LO（print-pdf-deploy 的部署半边，Elixir 时代产物）、异步批量、打印留痕、模板管理页改动、字段目录派生化（Go 沿用捕获快照）。

- [x] 既有打印规划边界核对完成并记录，本工单范围据此裁剪
- [x] OpenAPI 契约新增打印/渲染端点，服务端经 oapi-codegen 编译期绑定实现
- [x] Go 侧 xlsx 渲染（占位符填充、循环区）与 PDF 转换可用，与捕获的打印契约（字段目录 60 资源/1223 头字段/28 循环区）对齐
- [x] 前端打印/导出全部走契约客户端，`/api/print` 暗管清零
- [ ] 至少一个业务单据（建议销售订单，对齐 print-engine 先例）端到端打印验证通过（真实 PG + 浏览器）

## Result

**2026-07-27 交付。** 边界核对结论见上方 Comments：既有 spec 已定案全部语义，本工单只做 Go 移植与接通，未重复规划。

**改动文件**

- 契约：`contracts/openapi/openapi.yaml`（新增 `POST /printing/render` + `PrintRenderRequest`），重新生成 `server/internal/http/gen/api.gen.go` 与 `web/app/lib/api/schema.d.ts`（`make generate` 全量跑过，sqlc 无漂移）。
- Go 打印平台（`server/internal/platform/printing/`）：
  - 新增 `renderer.go`——渲染引擎全语义移植（render_pages/render_sheets、多循环区、`_seq`、0 行删模板行、mergeCell/打印区域/手工分页符顺移、批量块按最大行号偏移、sheet 名清洗去重）；
  - 新增 `pdf.go`——soffice 哑转换（独立 profile、`timeout(1)` TERM+`-k 5` 包裹、全局并发上限默认 2、`SOFFICE_PATH`/`SOFFICE_TIMEOUT_MS`/`SOFFICE_MAX_CONCURRENCY` 配置、错误契约 soffice_not_found/timeout/no_output/convert_failed）；
  - 新增 `docbuilder.go`（装配 seam + 格式化/枚举标签口径）、`docbuilder_sales_order.go`（销售订单装配，本期唯一接入资源）、`render.go`（编排门面 Service.Render：权限 print/batch_print/export、批量 1..100、模板资源匹配、中文错误映射）；
  - 改 `service.go`（Service 增加 builders/converter 两字段与 NewService 默认注册，最小改动）。
- HTTP：新增 `server/internal/http/server_print_render.go`（`RenderPrintOutput`，二进制文件流 + Content-Disposition，编译期接口绑定满足）；server.go/既有 server_*.go 零改动。
- 前端：`web/app/lib/print.ts` 的 `runTemplateOutput` 改走契约客户端 `apiClient.POST('/printing/render', { parseAs: 'blob' })`，`/api/print` 暗管清零（全仓 grep 确认）；调用方 `TemplatePrintDialog.tsx` 签名不变无需改动。
- 文档：`CONTEXT.md`「模板打印/模板导出」词条、`docs/产品文档/系统管理.md」打印模板节各补一句执行面现状。

**设计要点**

- 渲染器与 Elixir 版同算法同正则（Go RE2 无 lookbehind，ref 匹配改为「边界字符捕获回填」等价实现）；值一律文本 inline string 落格，格式由单元格 Excel 格式承载；只处理第一个 sheet，其余 part 原样重打包。
- PDF 转换器做成可注入接口（`PDFConverter`），Service 默认从 env 构造 soffice 实现；无 soffice 时返回「PDF 转换服务不可用（未找到 LibreOffice）…」明确错误，导出 xlsx 路径完全不触转换器。
- 装配层按资源注册 `DocBuilder`（Elixir 靠 Ash 内省全资源通用，Go 无对应物故逐资源接入）；sales.order 一条头查询 + 一条条目查询，键名与捕获 field_catalog.json 对齐，枚举渲染中文标签（草稿/常规订单/客户/固定价等）、布尔 是/否、空值归空串；记录级公司数据权限 fail-closed（越公司读报「部分单据不存在或无权查看」）。
- 未接入的其余 59 资源：`501 not_implemented`「资源 X 的模板打印暂未接入」，seam 已留好（注册 DocBuilder 即接入）。

**验证结果（均已本地通过）**

- `go test ./internal/platform/printing/`（含真实 PG `SYNIE_TEST_DATABASE_URL`）全绿：渲染器单测 6 例（头字段/sharedStrings/循环区展开/merge·分页符·打印区域顺移/批量块偏移/多 sheet 导出/空 docs 与非法模板）；PDF 转换器 6 例（假 soffice 成功/失败/无产出/缺路径降级/超时真杀进程组 ~1.1s/并发限流串行证据）；PG 集成 `TestPostgresSalesOrderRender`——真实造销售订单两单三条目 → 上传模板 → 单条导出断言关键单元格（单号/公司名/客户名/中文状态/条目行）、批量导出 sheet 名、打印路径 stub 转换器断言渲染产物与 PDF 输出、soffice 缺失降级文案、无权限 403、越公司 404、批量 101 拒绝。
- `go build ./internal/http/` 通过（编译期接口绑定）；`go test ./internal/http/ -run Print` 通过。
- `make generate` 重新生成无漂移；gofmt 干净。
- 前端 `bun run typecheck` 与 `bun run build` 均通过。

**未验证项**

- 浏览器端端到端（真实打开 PDF 预览/下载 xlsx）未做——需要起完整 Go 服务 + 前端联调，对应验收框第 5 条的「+ 浏览器」部分保持未勾。
- 真实 LibreOffice 转换未验证（本机未装 soffice）；进程卫生与降级已由假可执行测试覆盖，真实 LO 转换建议在部署环境抽验。
- 销售发货单等其余资源装配未接入（后续工单）。
