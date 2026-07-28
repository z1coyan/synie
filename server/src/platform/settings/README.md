# settings（骨架）

单行表全局配置模式（sys_setting / acc_setting / sal_setting / mfg_setting）：
种子行恒存在、只改不增删；密钥字段 write-only（只写不回读）。
- 行为参考：`server-go/internal/platform/settings/`
- API 形状：`GET/PATCH /api/v1/{sys,acc,sales,mfg}/setting`（无 list/create/delete）
- 实现工单：`.scratch/ts-backend-rewrite/issues/01-platform-completion.md`
