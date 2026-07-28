# settings

- **引擎** `createSingleRowSetting`：单行表 get/update + 审计 diff（业务域声明约 20 行）
- **platform 持有**：`sys_setting`（系统/行情）
- **业务域持有**：
  - `sal_setting` → `modules/trading/settings.ts`（供应链）
  - `mfg_setting` → `modules/manufacturing/settings.ts`
  - `acc_setting` → `modules/finance/settings.ts`
- 组合根注入三域服务 → `createSettingsService(db, domain)` 门面
- 端点：`GET/PATCH /api/v1/settings/{system,finance,supply-chain,production}`
- 密钥字段（OCR Secret）write-only，审计脱敏
