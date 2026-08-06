# ADR：票据 OCR（发票 + 承兑）

2026-07-15。发票与承兑「接收」创建动线：上传图片 → 阿里云 OCR 预填 → 人工核对保存；识别图保存后挂为附件。

- 凭证落 `acc_setting` 单行（敏感字段权限控读）；`accOcrConfigured` 不暴露密钥内容。
- 手写 OpenAPI V3 签名 + Req，无官方 Elixir SDK；权限复用 create，不新增 OCR 专用权限码。
- 不做批量导入台账、识别历史；承兑接口仅图片，发票可含 PDF/OFD。
