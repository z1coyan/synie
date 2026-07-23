# 01 — 路径式占位符端到端打通（头字段 + 单循环）

**What to build:** 销售订单/发货单模板可用路径键上传并正确导出——`${company.name}`、`${party.name}`（对手名称）、枚举字段中文标签、计算字段（如 `gross_total`）、belongs_to 一层路径。明细 `${items.*}` 保持 v1 单循环行为。字段清单改为 Ash 内省派生（排除 id/外键/时间戳，含计算字段，集中枚举标签表，party 解析统一规则），装配器改通用，v1 手写清单与逐资源子句删除。旧拍平键、技术列、二层下钻、嵌套循环、多循环区上传均被拒并点名（多循环区在 02 放开）。

**Blocked by:** None — can start immediately

**Status:** resolved

- [ ] 销售订单模板用 `${company.name}`/`${party.name}`/枚举状态/`${gross_total}` 上传校验通过，导出值正确（公司名、对手名、中文状态、金额）
- [ ] 明细 `${items.*}`（含 `_seq`、0 条目删行、mergeCell 顺移）行为与 v1 一致
- [ ] 旧拍平键（如 `company_name`）上传被拒，报错逐个点名
- [ ] 技术列（id/外键/inserted_at/updated_at）不进派生清单，含其占位符被拒
- [ ] belongs_to 一层路径合法；第二层下钻被拒并点名
- [ ] 嵌套循环（循环区目标资源自身的 has_many）被拒并点名
- [ ] 同一模板多于一个循环区被拒（本票显式拒绝，02 放开）
- [ ] FieldCatalog 公开接口（resources/get/field_names/item_names/validate_placeholders）不变；手写 @catalogs 与逐资源装配子句删除
- [ ] RendererTest 与 TemplateAndExportTest 全绿
