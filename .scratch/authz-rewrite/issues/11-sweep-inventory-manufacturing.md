# 11 — 扫荡：inventory 余量 / manufacturing 余量

**What to build:** 按 08 手册迁移 inventory 余量（物料/分类/单位转换/仓库——多为 global 或轻公司域）与 manufacturing 余量（BOM/工序/工艺模板/模具设计/委外相关——07 已迁需求单/工单/生产入库）。要点：`manufacturing/helpers.ts:requireCreateOrUpdate`（anyOf 形态）改 guard anyOf；mold-design 与物料 1:1 联动的跨资源写走各自 Permit；BOM 全局共享声明 `global`。

**Blocked by:** 07, 08

**Status:** done

- [x] 两模块余量资源迁移，本地包装删除
- [x] 相关集成测试全绿；封路豁免移除对应项

## Comments

### 实施落点

| 子域 | 服务 | 路由 | 备注 |
|---|---|---|---|
| 物料分类 | `inventory/category-service.ts` | `inventory/master-routes.ts`（挂 `/base`） | global 共享树；树锁 `pg_advisory_xact_lock` 保留 |
| 物料 | `inventory/material-service.ts` | 同上 | global；导出 `MATERIAL_RESOURCE` 供 mold-design/routes 复用 |
| 单位转换 | `inventory/material-unit-service.ts` | 同上 | via(invMaterials, material_id)；私有 `requireAnyPermission` 删除 |
| 仓库 | `inventory/warehouse-service.ts` | 同上 | 本批唯一 company 形态（4 写法公司闸的最后样本） |
| 工序 / 工艺模板 / 模板行 / BOM / 配料 / 路线 / 副产品 | `manufacturing/master-service.ts` | `manufacturing/routes.ts` | 全部 global 或 via(global)；3 个模块级 lock 函数折叠进闭包 |
| 模具设计 | `manufacturing/mold-design-service.ts` | 同上 | global；与物料 1:1 的跨资源写见下 |
| 装配 | `inventory/index.ts` / `manufacturing/index.ts` / `app.ts` | — | 四个服务构造末位收 `registry`；`inventoryMasterRoutes` deps 收 `authz` |
| 种子 | `setup/sampledata/{master,mfg,outsourced}.ts` | — | 一律 `permitFor(deps, actor, 资源, 动作)` 现取凭证 |

`manufacturing/helpers.ts`：`requirePermission` 再导出与 `requireCreateOrUpdate` 删除；顺带清掉 07/08 留下的死码
`parseFulfillmentWire` / `validFulfillment` / `setDemandItemStatus`（全库零消费者），`MFG_WRITE_MAPPINGS` 收回不导出，
`FulfillmentMethod` 类型导入随之删除。文件顶部补「鉴权不在本文件」的注释头（与 `inventory/helpers.ts` 同口径）。

### 声明形态与理由（声明本已存在，本轮复核 + 补理由注释）

| 资源 | 声明 | 理由 |
|---|---|---|
| `invMaterialCategories` / `invMaterials` | `{ kind: 'global' }` | 表无 `company_id`（全局共享主数据）。分类是全局共享树，树操作（改上级/改叶子标记）只有码级判定 |
| `invMaterialUnits` | `{ kind: 'via', parent: 'invMaterials', fk: 'material_id' }` | 「能不能看这一行」＝「能不能看这个物料」；via 的 `supportedScopes = []` 也避免与 `base.material` 前缀取交集 |
| `invWarehouses` | `{ kind: 'company' }` | 自带 `company_id`；仓库不按人/部门看，**故意不声明 owner/dept** |
| `mfgOperations` / `mfgProcessTemplates` / `mfgBoms` / `mfgMoldDesigns` | `{ kind: 'global' }` | **复核结论：四张表都无 `company_id` 列**（`db/types.d.ts` 与 `db/migrations/{00001,00005,00006,00015}` 逐一核过），工单描述点名的「BOM 声明 global」与现状一致，**无差异**。全公司共享一套工艺主数据 |
| `mfgProcessTemplateItems` / `mfgBomComponents` / `mfgBomRoutes` / `mfgBomByproducts` | `{ kind: 'via', parent, fk }` | 子行判定递归归宿 |

本批零 meta 改动（无新增/删除资源、无形态变更），故 `catalog-seal`（105）与形态分布（company 34 / global 35 / via 36）
两处快照**不变**；`menu-permission-contract` 也不变（前缀集合没变）。`resource-authz.test.ts` 新增一例本批的
「global 只出 all / 仓库只出 all / 五个子行为 []」断言。

### 三个执行点的覆盖统计

旧原语调用点清零（`requirePermission` 47 / `requireCreateOrUpdate` 4 / `canAccessCompany` 4 / `companyScopeWhere` 3），换成：

- 路由 **65 个端点**逐个 `guard(资源, 动作)`（inventory 主数据 22 + manufacturing 主数据 43）。
- **13 条列表路径 `listAuthorized`**（分类/物料/单位转换/仓库/外协仓/模具设计 6 + master-service 的
  `listSimple`×3 与 `listChildren`×4），全部显式传 `alias`；master-service 的两个列表 helper 改成收
  `permit + target + table`，`alias` 恒等于表名（`FROM 表` 无别名），只有一处可写错。
- **单条/写前取行**：`loadAuthorizedFrom` 5 处（四个主数据 + 模具设计的 join 投影 get），
  `loadAuthorized` 覆盖 inventory 8 处写路径 + master-service 的 `rowOf/lockOperation/lockTemplate/lockBom`
  **31 个调用点** + mold-design 4 处。
- 写侧 **2 处 `assertCompanyWritable`**（仓库 create、`seed-defaults`）。
- `writeAudit(trx, actor, …)` → `permit.actor` 全量；`seedCompanyDefaultWarehouses(trx, permit.actor, …)` 同理。

**折叠的模块级 lock 函数（4 个 → 0）**

| 旧 | 调用点 | 新 |
|---|---|---|
| `master-service.ts:lockOperation(db,id)` | 3 | 闭包 `lockOperation(trx, permit, id)` = `loadAuthorized(forUpdate)` + mapper |
| `master-service.ts:lockTemplate(db,id)` | 2 | 闭包同上 |
| `master-service.ts:lockBom(db,id)` | 12 | 闭包同上（`!id` 的 400 校验保留） |
| `master-service.ts:lockExists(db,table,id,msg)` | 3 | 全部是 `mfg_process_template`，改 `lockTemplate`（授权 + 锁），加锁顺序仍是**母单先行** |

`mold-design-service.ts` 的两处裸 `forUpdate` 取行改 `loadAuthorized`，并新增伴生物料行的
`loadAuthorized(invMaterials, forUpdate)`——既是授权也是 1:1 伴生行的行锁（迁移前物料行**没有加锁**）。

### mold-design 跨资源写：选 guard allOf（07 模式），不选分支内 permitFor

判据是**条件性**：分支内 `permitFor` 适用于「请求体决定要不要动第二资源」（如 hr 考勤导入的自动建档分支），
而模具设计的 create/update/delete **每一次都必然连带写 `inv_material`**（1:1 伴生，无分支）。
静态可知的要求归声明式的路由 `allOf`（与工单 07「建工单必然读需求行 → `mfg.demand:read`」同形）：

```
POST   /mold-designs      → mfg.mold_design:create ∧ base.material:create
PATCH  /mold-designs/:id  → mfg.mold_design:update ∧ base.material:update
DELETE /mold-designs/:id  → mfg.mold_design:delete ∧ base.material:delete
```

`allOf` 的凭证范围取格上最小（保守），故一张凭证同时覆盖两资源的行级可达性，无需两张。
附加码从 `authz.targetOf(MATERIAL_RESOURCE).prefix` 拼，不写字面量。

同一判据下 `POST /boms/:id/apply-route-template` 也加了 `allOf: [mfg.route_template:read]`
（它把模板的行**拷进** BOM，是「读别的资源的行集」）。**划界**：纯 FK 存在性/合法性校验的读
（`ensureMaterial` / `ensureUnitAllowed` / `validateWarehouse` 等）**不**加附加码——那是全库口径，
其他模块同样如此，为它加码等于给每个外键都开一道门。

### 语义变化表（逐路径）

| 路径 | 旧 | 新 |
|---|---|---|
| **仓库 `GET/PATCH/DELETE /base/warehouses/:id`：跨公司** | `not_found`（`update`/`remove` 里 `!locked \|\| !canAccessCompany` 已是 404）；`get` 是「零公司授权 → 404，否则按 `companyScopeWhere` 过滤」 | `not_found`（统一由 `loadAuthorized` / `loadAuthorizedFrom` 产出） |
| **仓库 `POST /base/warehouses`：目标公司未授权** | `forbidden`「无权在该公司下操作数据」（`warehouse-service.ts:168`） | `not_found`「公司不存在」 |
| **仓库 `POST /base/warehouses/seed-defaults`：目标公司未授权** | `forbidden`「无权在该公司下操作数据」（`warehouse-service.ts:133`） | `not_found`「公司不存在」 |
| 仓库 create：`name` 为空且公司未授权 | 先撞公司闸（报公司相关） | 400「不能为空且最多 128 个字符」（入参校验先于公司边界） |
| 仓库列表 / 外协仓列表：零公司授权 | `empty` 早退返回空列表 | 空列表（行过滤编译为 `false`，早退义务消失） |
| 仓库列表：跨公司行 | 按 `companyScopeWhere` 过滤（同） | 公司 ∧ 范围原子编译（同结果，声明驱动） |
| 物料/分类/工序/工艺模板/BOM/模具设计单条：id 不存在或不可达 | `not_found` | `not_found`（global 无行级收窄，**行为不变**） |
| 单位转换 / BOM 子行 / 模板行 单条读 | 直接按行 id 取 | via 链 EXISTS 递归归宿（归宿是 global，**实际行集不变**） |
| 单位转换 `POST/PATCH /base/material-units` | 服务内 `requireAnyPermission(update, create)` | 路由 guard `anyOf [base.material:update, base.material:create]`（**同码同语义**） |
| 单位转换 `DELETE /base/material-units/:id` | 服务内 `requireAnyPermission(update, delete)` | 路由 guard `anyOf [base.material:update, base.material:delete]`（同） |
| 模板行 / BOM 子行 `POST` | 服务内 `requireCreateOrUpdate(prefix)` | 路由 guard `anyOf [归宿:update, 归宿:create]`（同） |
| **模具设计 create/update/delete** | 只要 `mfg.mold_design:*` | **收紧**：∧ `base.material:create/update/delete`（缺码 `forbidden`） |
| **BOM `apply-route-template`** | 只要 `mfg.bom:update` | **收紧**：∧ `mfg.route_template:read` |
| BOM `activate` / `deactivate` | 服务内 `mfg.bom:update` | 路由 `guard(mfgBoms, 'update')`（meta 的 `permissionAction: 'update'`，**不新增权限码**） |
| 任一端点：缺动作码 | 服务层 `forbidden` | guard 产出 `forbidden`（403 唯一成因＝码不满足） |
| 各前缀 `supportedScopes` | `[all]` | `[all]`（未加 owner/dept 绑定，矩阵不新增档位） |

**未变**：本批 6 个 global 前缀没有公司边界，迁移前后可见行集完全一致；唯一有公司边界的是仓库，
其边界语义与迁移前等价（两处 `forbidden` 统一为 `not_found`）。

### 坑

1. **`loadAuthorized` 返回 `Record<string, unknown>`**：原来 `locked.is_leaf` / `locked.default_unit_id`
   这类 kysely 强类型比较会 TS 报错。两个办法——能用锁后重读的投影（`before.xxx`）就用它（material），
   只剩布尔/字符串比较的就 `Boolean(locked.x)` / `String(locked.x)`（category / warehouse 的 `lockTree`）。
2. **`assertActionDeclared` 查的是归宿资源**：`invMaterialUnits` 只声明了 `read`，但 `guard(资源,'update')`
   合法——它解析到归宿 `invMaterials` 的 crud。反过来 BOM 的 `activate/deactivate` 因为
   `permissionAction: 'update'` 而**不是**已声明动作，必须挂 `guard(…, 'update')`，写 `'activate'` 会 500。
3. **`anyOf` 会整体覆盖本资源的动作码**：`guard(资源, 'update', { anyOf })` 的 `'update'` 只用于
   `assertActionDeclared` 与凭证身份标记，真正的判定完全由 `anyOf` 给出——所以「create ∨ update」
   要把 update 也写进 `anyOf`，不能只写 create。
4. **别名回归在 global 资源上没有牙**：`compileRowFilter` 对「公司边界不适用 ∧ atoms 含 all」直接短路成
   `TRUE`，连 via 链都不编译。本批 13 条列表路径里只有仓库的 `warehouse` 别名可实证——已用
   「故意写成 `warehouse_typo` → 4 个用例转红」验过。其余别名靠与单条 `loadAuthorizedFrom` 共用
   同一份 `ALIAS/SOURCE/SELECT` 常量来防写错。
5. **`bas_unit` 夹具必填 `unit_type` 与 `ratio`**（不是 Generated），漏了会 23502。
6. **集成测试的角色要连 `update` 一起授**：只授 `read/create/delete` 时跨公司 PATCH 先撞码级判定给 403，
   验不到 404——码级先于行级是设计，但写用例时容易误判成回归。

### 测试数字

- `cd server && bun run typecheck` → 见下「typecheck 输出」；`cd web && bun run typecheck` 同样 0 error。
- 单文件：`src/modules/inventory/` **8 pass / 2 文件**；`src/modules/manufacturing/` **20 pass / 3 文件**；
  `src/platform/meta/` **54 pass / 4 文件**；`src/platform/setup/setup.integration.test.ts` **3 pass**
  （示例数据种子链路，验四个服务的 `permitFor` 接线）。
- 新增 `server/test/sweep-inventory-manufacturing.integration.test.ts`：**10 tests / 83 expect 全绿**，
  四角色（全量 / 只读 / 仅模具码 / 仅物料 create 码）× 两公司，全程走 HTTP：
  1. 13 条列表路径别名回归（本人可达的行必须在结果里）；
  2. 仓库跨公司 `GET/PATCH/DELETE` 全 404 + 列表不含 + 本公司同路径 200；
  3. create 到未授权公司 404、`name` 为空先 400、`seed-defaults` 跨公司 404；
  4. via 子行单条读 5 条 200 + 不存在的子行 404；
  5. 缺码 403（仓库 create / 分类 delete）+ 同角色读码 200 对照；
  6. 模具设计 allOf：缺 `base.material:create` → 403，补齐后非 403，读码单独成立；
  7. 单位转换 anyOf：只有 `base.material:create` 也能过码级判定，两码全无 → 403；
  8. 状态守卫 409（分类有下级、仓库有下级）；
  9. global 前缀矩阵只出 `all`（含仓库）；
  10. 零公司授权：global 主数据照读、公司域仓库列表空 + 单条 404（spec §5）。
- 全量：`SYNIE_TEST_DATABASE_URL=… bun test` → **586 tests / 85 files，582 pass，4 fail**。
  三个是既有基线红（hr `meta.grid` 形状 / printing `61 vs 64` / market `form.exclude` undefined），
  第四个是 `order-draft` 的并行截断偶发红（工单 10 已登记；单文件跑 **5 pass** 稳定全绿，已复验）。
  与本轮无关，一个没修。
- `web/app/lib/menu-permission-contract.test.ts` 3 pass（前缀集合未变）。
- 封路豁免：删 **7 行**（inventory 4：category / material / material-unit / warehouse；
  manufacturing 3：helpers / master-service / mold-design-service），`EXEMPT.size` 上限 **18 → 11**，三例全绿。

### typecheck 输出（原文）

```
$ cd server && bun run typecheck
$ tsc --noEmit
EXIT=0
```

```
$ cd web && bun run typecheck
$ tsc --noEmit
EXIT=0
```

### 未尽事项（不阻塞本单）

- **模具设计与 BOM 套模板的收紧要过一遍存量角色授权**：上线前确认「模具工程师」角色带
  `base.material:create/update/delete`、「工艺员」角色带 `mfg.route_template:read`，否则会突然 403。
- 前端 `capabilities={[...]}` 硬覆盖仍在（子行资源已能正确投影），按计划留工单 14；
  跨公司从 403 变 404 的提示文案随工单 14 的 QueryState 收口。
- 剩余豁免 11 项全在工单 12 的范围内（accounting 2 / finance 7 / hr 2）。
- `mfg_setting` 的模具物料分类仍是「受信任读」（不检 `mfg.setting:read`），与其他单行配置读同口径，未动。
