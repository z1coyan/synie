# printing（骨架）

xlsx 模板打印/导出：占位符抽取校验 + 循环区行复制 + 批量拼接 + soffice PDF。
Go 版为零依赖 zip+XML 最小侵入手术（保留模板样式），TS 同样禁止引入
会重写整个 workbook 的库（exceljs 等）——用 JSZip/fflate + fast-xml-parser 同思路移植。
- 行为参考：`server-go/internal/platform/printing/`（render/xlsx/pdf/docbuilder + golden 测试）
- 端点：`POST /api/v1/printing/render`（模板+单据→PDF/xlsx 文件流）
- 实现工单：`.scratch/ts-backend-rewrite/issues/15-printing-engine.md`
