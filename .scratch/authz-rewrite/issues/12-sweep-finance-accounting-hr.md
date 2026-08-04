# 12 — 扫荡：finance / accounting / hr

**What to build:** 按 08 手册迁移 finance（发票/银行/报销/承兑/票据 OCR）、accounting（凭证/分录/科目角色）、hr（员工/考勤/薪资）。要点：两个 `requireAction` 包装与 `requireCompanyWrite` 删除；发票 reverseMode 动态动作码（S9）路由内派生后 guard；银行导入的 import-as-read 重载改 anyOf 声明；考勤导入分支条件权限（D8/e4）分支内二次取 Permit；跨资源 allOf 三处（对账、考勤+文件、挂接）走 guard allOf；hr 全局表（payroll/attendance 无 company_id）声明 global。

**Blocked by:** 08

**Status:** ready-for-agent

- [ ] 三模块全量迁移，本地包装删除
- [ ] S9/D8/allOf/import-as-read 特殊形态按归宿落地
- [ ] 相关集成/E2E 测试全绿；封路豁免清单清零（全库无豁免）

## Comments
