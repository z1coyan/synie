# 15 打印引擎

Status: ready-for-human
Blocked by: 01, 02

## 范围

1. **打印模板主数据**（名称/资源类型/模板 xlsx 挂接/默认唯一/上传即校验占位符对照字段清单，未知字段逐个点名拒绝）
2. **打印字段目录**（自 meta.Registry 派生：标量+计算字段+belongs_to 一层+party.name+has_many 循环区+`_seq`；禁嵌套循环上传即拒；敏感/主外键排除）
3. **渲染引擎**（zip+XML 最小侵入手术，禁止 exceljs 类全量重写库：含 `${...}` 单元格改 inline string；循环区按行数复制下移，0 行删整行；批量打印=N 块拼接+分页符；批量导出=多 sheet≤100；sheet 名=单号）
4. **PDF**（soffice headless 子进程+进程组超时杀+并发限制器，语义对齐 Go `pdf.go`；无 soffice 时打印报明确错误、导出不受影响）
5. **执行端点** `POST /api/v1/printing/render`（模板+单据→PDF/xlsx 文件流；鉴权）+ 销售订单装配首接（其余资源随域接入）

## 行为参考

`server-go/internal/platform/printing/`（render/xlsx/pdf/docbuilder + golden 测试）；`.scratch/print-engine/`、`docs/adr/2026-07-23-print-template.md`。

## 验收

- `verify-printing-rest.ts` 全绿
- Go golden 测试用例逐一对拍（占位符校验消息中文一致；循环区/批量/soffice 进程卫生）

## 非目标

不新增图片类占位符（图纸/Logo 留跟进先例）。

## Comments
- 2026-07-28 集成：主仓 cherry-pick 打印引擎；registerPrintingResources 置于业务域之后使 stub 跳过真实 Meta；catalog 60 前缀 / sales.order 25 字段。
- 2026-07-28 隔离 worktree 复验（grok-4.5）：`fflate` zip+XML、无 exceljs；printing 包 19 单测/集成绿（含 golden 占位符中文分类、soffice 进程卫生）；`:18091` `verify-printing-rest` 绿（resources=60 sales.order fields=25）；live `POST /printing/render` export→xlsx + print→pdf 对真实销售订单全绿。未改 server-go。
- 2026-07-28 补 remaining：`verify-printing-rest` 含 render export+print；printing 19 pass；`:18092` 活服务验收绿。无代码缺口。
- 2026-07-28 主工作区集成（grok-4.5 缺口）：cherry-pick 去重 `cf7b2d2`（公司默认过账科目 PG 集成）/`b0ba293`（04–07 编号 23505→conflict + inventory 自愈 + verify-inventory 停车编号）/`3f84ab7`（09–14 编号 conflict 测 + OCR 默认存储 + HR 编号腾空 + market fixture）/`bc43cef`（todo 忽略复位）/`4358af8`（printing render 冒烟）/`b8538aa`（setup 空库 e2e afterAll 超时）；合并重复 numberingWriteError；app/index/Meta/helpers 已完整装配，未改 server-go。
