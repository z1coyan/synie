# printing

xlsx 模板打印/导出：占位符抽取校验 + 循环区行复制 + 批量拼接 + soffice PDF。

- zip+XML 最小侵入（`fflate`），**禁止 exceljs**
- 字段目录自 `meta.Registry` 派生（业务 Meta 由各域注册；platform 无 stub / 无业务表查询）
- DocBuilder 经 `registerDocBuilder` 由业务域装配（`sales.order` → `modules/trading/order/docbuilder.ts`）
- PDF converter 由组合根注入（`SOFFICE_*` 见 `env.ts`）
- 端点：
  - `POST /api/v1/system/printing/templates` 等模板 CRUD
  - `GET /api/v1/printing/resources` / `field-catalog` / `templates`
  - `POST /api/v1/printing/render`（模板+单据→PDF/xlsx 文件流）
