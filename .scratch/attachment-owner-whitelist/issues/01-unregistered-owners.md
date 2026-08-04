# 01 — 三个附件面板宿主未注册白名单，上传必败

**Status:** partial

## 进展（2026-08-03，随模具设计落地）

- `inv_material` 已补注册（`registerInventoryFileOwners`，`server/src/modules/inventory/index.ts`，`companyScoped: false`，装配于 `server/src/composition.ts`）——物料图纸/其他文件上传链路恢复，模具设计的图纸/附件槽位同此路径。
- `hr_employee`、`acc_bill` 未处理，验收项（逐宿主结论 + HTTP 集成测试）仍开放。

## 背景

附件宿主白名单（`server/src/platform/files/owner-registry.ts`，fail-closed）当前只注册了 4 个宿主：`sys_print_template`、`acc_bank_account`、`acc_bank_transaction`、`mfg_work_order`（装配点 `server/src/index.ts`）。

但前端有 3 个附件面板引用了**未注册**的宿主类型，上传/挂接路径会在 `resolveOwner` 被拒（「未知的宿主类型」）：

| 面板 | ownerType | 业务意图证据 | 入口 |
|------|-----------|--------------|------|
| 物料图纸 / 其他文件 | `inv_material` | CONTEXT.md「图纸」术语；工单创建靠 `syncDrawingAttachments` 从物料复制图纸挂接 | `web/app/routes/_app/scm/materials.tsx` |
| 员工证件照 | `hr_employee` | `party/meta.ts` 注释「身份证影像：Presentation Extension」 | `web/app/lib/resources/presentation/employee.tsx` |
| 票据票面影像 | `acc_bill` | `resource-classification.ts` 注释「票面影像附件」 | `web/app/lib/resources/presentation/accounting-presentations.tsx` |

列表查询不校验白名单，所以面板表现为「能打开、永远空、上传报错」——静默坏掉，且无 e2e/集成测试覆盖上传路径（制造模块测试直接 SQL 插 `sys_attachment` 当 fixture）。

`inv_material` 影响最大：图纸是有术语定义、被生产工单快照链路（`syncDrawingAttachments`，`server/src/modules/trading/common.ts`）依赖的功能，疑似自 TS 重写（`.scratch/ts-backend-rewrite`）起就传不上去。旧 Elixir 后端的 owner 白名单里条目更全（见 `plans/005-template-file-attachment.md` 中对 `owner_registry.ex` 的引用），疑似迁移丢注册。

## 要回答的问题

逐个宿主定性：**丢注册（补 `owners.register` 几行即可修）还是有意砍掉（删面板）？**

- `inv_material`：大概率丢注册——图纸链路下游（工单快照复制）还在运行，上游上传却断了。修复时需确认 `companyScoped` 语义：物料是全局主数据不分公司，注册时 `companyScoped` 应为 false。
- `hr_employee`：员工全局共享不分公司，同上。
- `acc_bill`：票据有公司维度，注册时 `companyScoped: true`。

## 验收

- 三个宿主逐个有明确结论（补注册 or 删面板），结论落在对应模块代码与注释里。
- 补注册的宿主各有一条上传→挂接→列表→下载的集成测试（走 HTTP API，不再用 SQL fixture 绕过）。
- 若确认删面板，同步清理前端面板、meta `form.kind` 与 `resource-classification.ts` 登记（客户附件 2026-08-02 已按此路径删除，可参照）。

## 关联

- 客户附件面板删除（2026-08-02，grilling 决策：业务不存在客户级文件场景）。
- 旧栈白名单参考：`plans/005-template-file-attachment.md`。
