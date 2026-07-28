# settings

四个单行表资源：`sys_setting` / `acc_setting` / `sal_setting` / `mfg_setting`。
- 端点：`GET/PATCH /api/v1/settings/{system,finance,supply-chain,production}`
- 密钥字段（OCR Secret）write-only，审计脱敏
- 行为参考：`server-go/internal/platform/settings/`
