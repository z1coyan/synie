# 15 打印引擎

Status: ready-for-agent
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
