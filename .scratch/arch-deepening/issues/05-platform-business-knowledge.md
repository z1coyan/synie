# 05 F · 业务知识回吐出 platform

Status: done

## 问题

platform 层硬编码领域知识，红线「platform 不 import 业务域」虽已在
运行时 import 层面恢复（第一轮 C），但以下越层仍在：

- `platform/todo/service.ts:248-283,373,429`：硬编码 finance 权限码
  （`acc.vat_invoice:create`）与 sal_customers/pur_supplier/acc_vat_invoice
  三张业务表；:336-339 客户端排序被静默丢弃（fail-closed 破例）。
- `platform/settings/service.ts`：拥有 sal_setting/mfg_setting/acc_setting
  三张业务域设置表；4 组 get/update 逐行同构（~120 行/组）。
- `platform/setup/sampledata/`（~2500 行）：跨 9 域的业务编排住 platform
  （Go 布局里属 domain/setup），type-only import 9 个业务服务。
- `platform/numbering/service.ts:320-323`：直查 bas_company 取公司编码，
  绕过自己的 catalog lookup 机制。

## 方向

- todo：泛化 `TodoSource` registry（生产者注册 sourceType→权限码/圈人 SQL/
  结单判定，仿 OwnerRegistry），platform 只留 state/查询骨架；或诚实归入
  finance（承认它是开票待办）。排序静默丢弃一并修（400 或修 CTE 加前缀）。
- settings：platform 沉淀 `createSingleRowSetting({table,meta,validate,…})`
  引擎，sal/mfg/acc 三份声明迁回各自业务域（新增一类设置 ~120 行→~20 行）。
- sampledata 移到 `modules/setup`（或组合根层），platform/setup 只留
  向导状态机。
- numbering 走回 catalog lookup。

## 验收

- `grep -rn 'sal_\|pur_\|acc_\|hr_\|inv_\|mfg_' src/platform --include='*.ts'`
  中业务表名只剩 sys_* 与必要的类型引用；
- 第二类待办接入零改动 platform；
- typecheck + 全套测试绿。
