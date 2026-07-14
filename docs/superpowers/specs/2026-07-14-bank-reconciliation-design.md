# 银行流水对账 — 设计

日期:2026-07-14
状态:已确认(严格校验 / Chip+整行高亮 / 快速凭证极简内联表单)

## 目标

银行流水(`acc_bank_transaction`)与会计凭证(`acc_gl_journal`)做 m-n 金额对账:
一笔流水可由多张凭证分次对账,一张凭证也可对账多笔流水,双方对账金额均不得超过各自可用额度。
流水列表醒目区分未对账/部分对账/已对账;对账操作在抽屉中完成,支持关联已有凭证、
快速新建凭证并自动审核关联、查看关联凭证详情、解除对账。

## 数据模型

### 新资源 `SynieCore.Acc.BankReconciliation`(表 `acc_bank_reconciliation`)

- `belongs_to :company`(必填,冗余自流水,复用 CompanyScope 数据权限)
- `belongs_to :bank_transaction`(必填 → `acc_bank_transaction`)
- `belongs_to :journal`(必填 → `acc_gl_journal`)
- `amount :decimal`(对账金额,必填,> 0)
- `inserted_at` / `updated_at`
- identity:`[:bank_transaction_id, :journal_id]` 唯一(同一对流水-凭证仅一条记录)
- 接审计:`fragments: [SynieCore.Audit.Fragment]`;destroy 加 `require_atomic? false`
- actions:`create` / `read`(offset 分页)/ `destroy` / `quick_create`(见下),**不做 update**
  (改金额 = 解除后重新关联)

### 权限

- 流水资源 `permission_actions` 增加 `reconcile` 码 → `acc.bank_transaction:reconcile`
- `BankReconciliation` 为纯关联资源:`permission_prefix "acc.bank_transaction"`、
  `permission_actions []`(不进权限目录),策略借码:
  - read → `{HasPermission, as: "read"}` + CompanyScope
  - create / destroy / quick_create → `{HasPermission, as: "reconcile"}`
  - quick_create 额外要求 actor 具备 `acc.gl_journal:create` 与 `acc.gl_journal:audit`
- 前端补:`permission-labels.ts` ACTION_LABELS 增 `reconcile: '对账'`;
  `logs.tsx` 资源标签增 `accBankReconciliation`。

### 流水侧派生字段(`acc_bank_transaction` 增加)

- `has_many :reconciliations`
- 聚合 `reconciled_amount`:sum(reconciliations.amount),空集默认 0
- 计算 `unreconciled_amount` = (income 或 expense) − reconciled_amount
- 计算 `reconcile_status` 三态枚举:
  - `unreconciled` 未对账(reconciled_amount = 0)
  - `partial` 部分对账(0 < reconciled_amount < 流水金额)
  - `reconciled` 已对账(reconciled_amount = 流水金额)
- 实现优先用 Ash 表达式聚合/计算(可筛可排,GridMeta 反射为列);
  若 GridMeta 对计算列反射不可行,回退方案:落为持久化冗余列,
  由对账 create/destroy 的事务内(持锁)同步维护。

## 对账校验(严格模式)

`create` 在事务内先对流水行与凭证行 `SELECT ... FOR UPDATE` 加锁(照 `lock_journal`
范式,构建期预检仅为友好报错,事务内为权威复检),再校验:

1. 流水与凭证同公司;凭证状态必须为 `audited`
2. 流水所属银行账户必须已绑定会计科目(`bank_account.account_id` 非空),
   否则报错提示"请先为银行账户绑定会计科目"
3. **方向匹配**:收入流水(income)→ 凭证必须含该银行科目的**借方**行(debit > 0);
   支出流水(expense)→ 必须含**贷方**行(credit > 0)
4. `amount > 0`
5. **流水侧上限**:本流水全部对账金额合计 ≤ 流水金额(income 或 expense)
6. **凭证侧上限**:按「凭证 × 银行科目 × 方向」维度计算——
   可用额度 = 该凭证中(该银行科目、该方向)分录行金额合计
   − 该凭证已对账给其他流水中"银行账户绑定同一科目且方向相同"的对账金额合计。
   一张"借银行A科目 / 贷银行B科目"的内部转账凭证,可分别对 A 的收入流水与
   B 的支出流水,两侧额度互不挤占。

币种:银行账户绑定科目时已有校验(科目若指定币种须与账户币种一致),
分录行币种复制自科目,故对账双方币种天然一致,不再额外校验。

### 反向约束(防脏数据)

- `GlJournal.cancel`:存在对账关联时禁止取消(锁内复检),提示先解除对账
- `BankTransaction.destroy`:存在对账关联时禁止删除
- `BankTransaction.update`:修改后金额不得低于已对账金额;
  已有对账时禁止收/支换边
- 中间表外键不做级联删除(依赖上述校验兜底,DB reference 保持默认限制行为)

### 剩余额度查询

提供查询(generic action):入参(凭证 id, 流水 id),返回该组合的剩余可对账额度
min(流水未对账金额, 凭证侧该科目该方向剩余额度),供前端选中凭证后预填默认对账金额。

## 快速新增凭证并关联(`quick_create`)

后端事务性组合动作(避免前端串多个 mutation 中途失败留脏数据):

1. 锁流水,复检银行账户已绑科目、金额 ≤ 流水未对账余额
2. 创建凭证草稿:凭证号走既有 AutoNumber;两行分录——
   收入流水:借 银行科目 / 贷 对方科目;支出流水反向;金额相等
3. 走既有 `audit` 流程审核过账(GL.post!)
4. 创建对账记录(金额 = 凭证金额)
5. 任一步失败整体回滚

入参:`bank_transaction_id`、`counter_account_id`(对方科目,必填,须同公司+启用+非汇总,
复用 GL.validate_entries 的科目校验)、`amount`(默认流水未对账余额,可改,> 0 且
≤ 流水未对账余额)、`summary`(摘要,默认取流水摘要)、`posting_date`
(凭证/过账日期,默认流水交易日)。

## 前端

### 流水列表页(`bank-transactions.tsx`)

- `GRID_COLUMNS` 增加 `reconcileStatus`(enum Chip:未对账=danger、部分对账=warning、
  已对账=success)与 `unreconciledAmount` 列;状态列可筛选
- **SynieDataGrid 扩展**:新增 `rowClassName?: (row) => string | undefined` prop
  (一次性小改动),本页对未完成对账的行加浅警示底色
- `rowActions` 增加"对账"(capability `reconcile`),**所有行可点**
  (已对账的行进抽屉可查看/解除)

### 对账抽屉(新组件 `ReconcileDrawer`)

- 顶部流水概要:方向、金额、已对账/未对账金额、银行账户、对方户名、摘要
- **关联记录列表**:SynieDataGrid(`accBankReconciliations` + fixedFilter 本流水),
  列:凭证(fk link,点击自动叠出凭证速览抽屉——满足"查看凭证详情")、对账金额、
  创建时间;行操作"解除"(capability `reconcile`,确认框)
- **关联已有凭证**:RemoteDialogSelect 表格弹窗选凭证
  (`accGlJournals`,`labelField="voucherNo"`,过滤:同公司 + AUDITED +
  经 lines 关系过滤"含该银行科目方向行");选中后调剩余额度查询预填对账金额,
  可改,确认后创建对账记录
- **快速新增凭证**:内联极简表单(对方科目 RemoteSelect + 金额 + 摘要 + 日期),
  提交调 quick_create;区域显隐按三码齐备门控
  (`reconcile` + `acc.gl_journal` 的 `create`/`audit` 能力,
  凭证能力经 gridMeta(accGlJournals).capabilities 获取)

### 登记杂项

- GridMeta `@resources` 白名单增 `accBankReconciliations`
- 抽屉 `registry.ts` 增对账资源条目
- domain `synie_core.ex` 注册资源 + list 查询(offset 分页)+
  create / quickCreate / destroy mutations

## 测试

后端 ExUnit:

- create 校验各分支:跨公司、凭证非 audited、账户未绑科目、方向不符、
  金额 ≤ 0、流水侧超额、凭证侧超额(含同凭证双银行科目各自独立额度)
- 同一对流水-凭证唯一约束
- quick_create 成功路径(凭证已审核 + 分录生成 + 关联建立)与失败回滚
  (对方科目非法时凭证不残留)
- GlJournal.cancel 有对账时被拒;BankTransaction 删除/改金额/换边的禁止逻辑
- 权限:无 reconcile 码不可创建/解除;quick_create 缺凭证 create/audit 码被拒

前端 E2E(照 GL 页惯例):建流水 → 对账抽屉关联已有凭证(预填金额)→ 解除 →
快速新增凭证(自动审核+关联)→ 列表状态列/行高亮变化 → 点凭证 fk 速览。

## 范围外(跟进项)

- 自动匹配建议(按金额/日期/对方户名猜测凭证)
- 批量对账、对账报表/对账单
- 凭证列表反向展示已对账金额列
- 银行流水导入时自动对账
- 终审遗留:账户改绑科目与对账创建在亚秒级并发交错的理论漂移窗口——把
  `Reconcile.ledger_account_id` 改为 FOR UPDATE 锁读账户行即可关死(顺序操作路径已有守卫)
