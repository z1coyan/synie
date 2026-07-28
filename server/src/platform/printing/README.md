# printing

xlsx 模板打印/导出：占位符抽取校验 + 循环区行复制 + 批量拼接 + soffice PDF。

- zip+XML 最小侵入（`fflate`），**禁止 exceljs**
- 字段目录自 `meta.Registry` 派生
- 端点：
  - `POST /api/v1/system/printing/templates` 等模板 CRUD
  - `GET /api/v1/printing/resources` / `field-catalog` / `templates`
  - `POST /api/v1/printing/render`（模板+单据→PDF/xlsx 文件流）
- 首接装配：`sales.order`
- 行为参考：`server-go/internal/platform/printing/`
- 工单：`.scratch/ts-backend-rewrite/issues/15-printing-engine.md`
