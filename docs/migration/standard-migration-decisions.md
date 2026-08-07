# 标准动作内核全量迁移·行为变更决策日志

迁移分支:`meta-engine-full-migration`(base=`worktree-meta-engine-kernel`,PR #52 之上)。
铁律:红测试=显式决策点;每一条有意的行为变更在此记一行(资源/旧行为/新行为/理由)。
删测试只允许两种理由:已被合同套件(`standard-contract.postgres.test.ts` + `standard-v2.postgres.test.ts`)覆盖、或本表有记录的废弃。

| 资源 | 旧行为 | 新行为 | 理由 |
|------|--------|--------|------|
| salCustomers | 审计 resource 键写 `sal_customer`(单数字面量) | 写 `sal_customers`(meta.table) | 旧值是 party 模块偏离全站「审计键=表名」约定的本地写法;内核统一走 meta.table。仅影响 sys_audit_log 行,无 wire 字段 |
| salCustomers/purSuppliers/basPartyAddresses | 长度/必填违规由服务层 422(`参数不合法`,如「不能为空且最多 32 个字符」) | 由路由层 meta 派生 zod 422(`请求参数错误`,空与超长拆成两条文案) | 约束进 meta 是标准派生的唯一事实源;code/status/字段键不变,仅文案措辞 |
| salCustomers/purSuppliers/basPartyAddresses | 无批量端点 | 新增 `POST /bulk-update`、`/bulk-delete`(新权限码 `…:batch_update/batch_delete`) | 标准词表要求完整动作面;纯增量,存量 URL 逐字不变 |
| hrEmployees | — | 整资源弹射保留手写 | 内核不支持 enumArray(insuranceTypes);autoCreateForAttendance 是跨域 seam。待内核补 enumArray 后再迁 |
| basMarketInstruments | 枚举入参小写也接受(服务 toLowerCase) | z.enum 只收大写,422 | meta 枚举是唯一事实源;web 恒发大写 |
| basMarketInstruments | 长度/必填违规服务层 422(`行情品种参数不合法`) | 路由层派生 zod 422(`请求参数错误`) | 约束进 meta;code/status/字段键不变,仅文案 |
| basMarketInstruments | 未映射写错误兜底文案 `保存行情数据失败` | `保存行情品种失败`/`删除行情品种失败` | 内核按 label 派生;仅 500 兜底可见 |
| basMarketInstruments | 无批量端点 | 新增 bulk-update/bulk-delete(+batch_* 权限码) | 标准词表;纯增量 |
| basMarketPricePoints | — | 整资源弹射保留手写 | 四条硬阻断:datetime wire 类型内核不支持;currencyId/unitId 由品种带出的只读 NOT NULL 列;create-only+void 词表(无 update/delete 是语义而非缺失);void 旧语义 422 且 is_voided 是布尔非状态枚举 |
| salCompanyAccountDefaults | 路由手写 zod+dto | 服务层标准派生;**路由保持手写**(getByCompany 单行读+create 由 update 门控) | 共享 sales.setting 前缀仅 read/update 两码;换标准路由需扩 4 权限码+角色数据迁移,超迁移授权范围 |
| salCompanyAccountDefaults | 跨公司创建 404 `公司不存在` | `公司默认过账科目不存在` | 内核统一 assertCompanyWritable(permit, id, notFound);更严格的不泄露存在性 |
| salCompanyAccountDefaults | 无差异 PATCH 仍复校科目引用(可 422) | 无差异直接返回现值 200 | 内核合同:无差异不落库不审计;引用校验属 beforeWrite |
| salCompanyAccountDefaults | 审计 record_label 为公司 UUID(手写) | meta 加 lookup.labelField='companyId' 保持同口径 | 内核 labelField 推导对无 name/code 资源得 null;显式声明冻结旧行为 |
| sysStorages | — | 整资源弹射,零改动 | 安全阻断:secret_access_key 是 write-only 明文凭证列,标准派生读侧 wire 会吐原文(领域测试钉死不得含密钥);内核缺 writeOnly 字段原语。批量动作对凭证资源属攻击面扩张,故意不声明 |
| invMaterials | create 传 code → 400 未知键 | 接受可选 code(传了跳过取号) | 内核 numbering 契约;web 表单 code 只读不会送 |
| invMaterials | 长度/必填违规服务层 422 | 路由层派生 zod 422(文案拆分) | 约束进 meta;code/status/字段键不变 |
| invMaterials | 无批量端点 | +bulk-update/bulk-delete(+batch_* 码) | 标准词表;纯增量 |
| invMaterials | 无差异 PATCH 仍跑引用校验(可 422) | 无差异直接返回现值 | 内核合同:无差异不落库先于钩子 |
| invMaterials | 未映射 DB 错文案`创建/更新/删除物料失败` | `保存物料失败` | 内核按 label 统一兜底;已映射约束文案逐字保留 |
| invMaterialUnits | create 传不存在 materialId → 422 validation | 404 not_found`物料不存在` | 子行内核经 loadAuthorized 解析母单,遵「行级不命中→not_found 不泄露存在性」;无测试覆盖旧口径 |
| invMaterialUnits | 路由 anyOf(base.material:update∨create) 守卫 | **路由保留手写**(服务已迁子行内核) | standardChildRoutes 的 guard 表达不了 anyOf;有 sweep 测试锁定该语义 |
| (内核) | toDbValue 枚举无条件小写 | FieldMeta.enumStorage:'upper' 逃生舱 | inv_material.material_type 库内大写+CHECK 白名单,禁改迁移;正解是数据迁移后删逃生舱 |
| invMaterialCategories | 父校验文案`上级分类…` | `上级物料分类…`(按 label 派生);「上级分类是叶子分类,不能挂子分类」经 onParent 逐字冻结 | 内核 tree 文案按 label;code/字段键不变 |
| invMaterialCategories | 只挡父=自身,可造环 | 递归 CTE 挡后代成环 422 | 内核 tree 通则,严格更强 |
| invMaterialCategories | update 未改 parentId 也复校父;校验序「父→叶子翻转」 | 只在移动时校验父;序变「叶子翻转→父」(同时违规时报错字段 parentId→isLeaf) | 内核 resolveParent 只在移动触发 |
| invMaterialCategories | 无批量端点;长度校验服务层文案 | +bulk 端点(+batch_* 码);校验进 meta 派生 zod | 标准词表;与 invMaterials 同款 |
| sysDepartments | create 传 enabled → 400 未知键 | 接受可选 enabled(缺省库 default true) | enabled 是可写列,派生 schema 必收;web 表单不送(启停走行动作) |
| sysDepartments | 跨公司 create → `公司不存在` | `部门不存在` | 内核统一 assertCompanyWritable 文案;更严格不泄露存在性 |
| sysDepartments | 父校验「停用」先于「后代成环」 | 成环先于停用(停用入 onParent) | 内核内置校验先行;仅同时违规时文案不同 |
| sysDepartments | 长度违规服务层文案;兜底`创建/更新部门失败` | meta 派生 zod 文案;`保存部门失败` | 与全波先例同款;**路由保留手写**(仅 4 码,批量需角色数据迁移,树形批量删除语义待独立决策) |
| basCompanies/basAccounts | 路由 *Present 布尔 | zod 可选字段天然 present-key;**路由保留手写**(嵌套 wire 显式 DTO 保 hc 类型链,批量码需角色迁移) | 语义等价 |
| basCompanies | 成环文案`上级公司不能是自身或其下级公司`/`公司层级存在循环` | `上级公司不能选择自身`/`上级公司不能是自身的下级` | 内核树文案;code/字段键不变 |
| basCompanies | 删有下级→FK 冲突同文案 | 树保护先于 DELETE,同 code 同文案 | 拦截点前移,wire 不变 |
| basCompanies | 建仓种子(create 联动) | afterWrite 钩子原样调 seedCompanyDefaultWarehouses,顺序一致 | 按任务要求冻结 |
| basAccounts | initializeTemplate 三套模板整树建账 | **弹射保留手写**,与内核 CRUD 共用 `bas_account:<公司>` 树锁互斥 | 非标准词表动作 |
| basAccounts | 越公司边界 create 404`公司不存在` | `会计科目不存在` | 内核统一文案 |
| basAccounts | 父校验文案`父科目…` | `上级会计科目…`(按 label 派生) | 内核树文案;字段键不变 |
| basAccounts | 审计快照 role 存大写 | 存小写(与库内一致) | 内核 snapshot 走 toDbValue;仅 sys_audit_log 可见 |
| basAccounts/basCompanies | 长度/枚举违规服务层文案;兜底`创建/更新…失败` | meta 派生 zod;`保存…失败` | 全波先例同款 |
| hrEmployees | 弹射(波1) | **已迁**(内核 enumArray 落地后);autoCreateForAttendance 保留手写挂在派生服务对象上 | 弹射原因已消除 |
| hrEmployees | 审计 resource 写 hr_employee(单数,含考勤 seam) | 两处统一 hr_employees(meta.table) | 一表一键;salCustomers 先例;历史审计行需数据迁移另议 |
| hrEmployees | create 接受 code:null;dailyWage 空串→null | code:null→422(缺省/''仍取号);空串→422(null 清空照旧) | 列 NOT NULL 不可 nullable;decimalStringSchema 不收空串;web 不发这两种载荷 |
| hrEmployees | 取号在 create 事务外 | 事务内 nextInTx,失败连号回滚 | 内核 numbering 契约 |
| hrEmployees | 无批量端点 | +bulk 端点(+batch_* 码) | 标准词表 |
| invStockDocs/Transfers/Counts | skeleton 编排审核/作废 | 单头迁内核 workflow(audit/void、ship/receive、approve/cancel),effect 只调引擎;**create 与行资源弹射**(内核缺服务端派生插入列 G1/子行派生列更新 G2);**路由保留手写**(date wire 口径分裂 G3+词表门槛 G4) | 守卫文案/盖章/审计 actionName 逐字冻结 |
| invStockDocs/Transfers/Counts | 审计 changes 里日期列出 ISO | 出 YYYY-MM-DD(toDbValue 规范形) | 仅 sys_audit_log 内容;无 wire 字段 |
| invStockTransfers | shipped_at/received_at 由 JS new Date() 写入 | (now() AT TIME ZONE 'utc') | 与 audited_at 同口径;非 UTC 主机旧值会漂 |
| invStockDocs/Transfers/Counts | 无差异 PATCH 仍复校(可 422);delete DB 错裸 500 | 无差异返回现值;`删除X失败`兜底 | 内核合同与兜底 |
| accGlJournals | skeleton 例外(createAndAuditJournal 无闸 seam) | 单头迁内核 workflow(audit 带 postingDate 输入/cancel),行迁子内核(derivedFields 币种);list 弹射(EXISTS 行筛选,内核缺 extraWhere);createAndAuditJournal 弹射(外部 trx seam) | 守卫文案逐字;路由保留手写(单挂载点混载 gl-entries/报表+词表门槛) |
| accGlJournals | submitted_at 由 JS new Date() 写 | (now() AT TIME ZONE 'utc') | 与盖章列同口径 |
| accGlJournals | 审计 changes 内 status/party_type 大写 | 库内小写(snapshot 走 toDbValue) | 仅 sys_audit_log 可见 |
| accGlJournals | 行越母单可达 404`会计凭证行不存在` | 404`会计凭证不存在` | 子行内核先解析母单;invMaterialUnits 先例 |
| accGlJournals | create 长度 422 先于公司边界 404 | 公司边界 404 先于长度 422 | 内核 create 内置 assertCompanyWritable 先行 |
| hrPayrolls/hrEmployeeLoans | 手写 CRUD | CRUD 迁内核(工资单投影 paid_total/派生金额 insertColumns+afterWrite 补写;借款 created_by_id 盖章不声明 owner) | 发放核算(锁内核算+跨资源 effects)、按月生成、月汇总、balances 聚合弹射保留手写;路由保留手写(词表门槛+派生列不可暴露成可写) |
| hrPayrolls | 十进制字段空串当 0 | 空串 422 | 内核 normalizeInput 先跑 decimal;web 恒回填 |
| hrPayrolls | 无差异 PATCH 仍 UPDATE(bump updated_at) | 返回现值不落库 | 内核合同 |
| hrPayrolls/hrEmployeeLoans | 数值/日期非法服务层文案 | 路由 zod`请求参数错误`;负数校验留钩子文案逐字 | 约束进 schema |
| hrPayrolls | meta 大量列谎称 readonly(实际 PATCH 可写) | 修正为可写;month/employeeId 改 required+createOnly | meta 成唯一事实源 |
| salQuotations/purQuotations | 审核/作废走 flipDocStatusInTx | 内核 workflow 两转移(effect=条目非空+梯度完整校验);flipDocStatusInTx 全库零消费方 | 守卫文案/盖章/actionName 逐字冻结 |
| salQuotations/purQuotations | 整单聚合 create/update(头+条目+档位单事务) | **弹射保留手写**(单行端点为 withTx 包装);价格档孙级弹射(子行内核仅一层) | 内核动作自开事务,无在途事务变体——交易域五聚合写资源的唯一硬阻断 |
| salQuotations/purQuotations | delete 先审计后 DELETE;兜底`删除报价单失败` | 内核序(先 DELETE 后审计);兜底`删除{销售/采购}报价单失败` | 内核合同;409 文案冻结 |
| accExpenseReports(+行)/accVatInvoices/accBillTransactions | skeleton 编排 | 单头迁内核 workflow(audit 带 postingDate/void/红冲 reverse),行迁子内核;accBills/accBillHoldings 整弹射(EXISTS 派生可见性,内核无 extraWhere);交易 create 弹射(billAttrs 联动建档) | 守卫/文案/actionName 冻结;路由保留手写 |
| finance 四资源 | 删除审计写 delete/delete | destroy/destroy | 全站 60 处已是 destroy,finance 是仅有偏离;仅 sys_audit_log 值 |
| accVatInvoices/accBillTransactions | audit.exclude 含可写列(OCR 抬头/红冲号/remarks 等 13+1 列) | exclude 收窄至三个盖章列,审计面只增不减 | **内核丢写缺陷诱因**:无差异判定曾按审计白名单算——已根治(见内核条目) |
| (内核) | 无差异判定按审计白名单算 diff(可写列被 exclude 时 PATCH 丢写) | 按可写列判定;审计白名单只管审计记录(写落库但审计面无变化时不写审计行) | 判官级缺陷,finance 代理发现;合同测试钉死 |
| accVatInvoices | meta items 谎称 readonly | 可写(jsonb[] postgres.js 双向直通) | meta 唯一事实源 |
| accExpenseReports/VatInvoices | 审核先翻状态再调引擎 | 先引擎再翻状态 | 内核 transition 顺序;GL 引擎不读单头 |
| finance 三单据 | 取号 values 手拼(posting_date 口径特殊) | 仍在 beforeWrite 手拼(不用 options.numbering) | 单号逐字不变优先 |
| mfgOutputs/mfgOutputItems | skeleton 编排 | 单头迁 workflow(audit/void,effect=引擎+工单投影回写),行迁子内核(derivedFields 工单快照);两处 list 与路由弹射(extraWhere 缺失/词表门槛/行 DELETE 用 update 码+allOf) | 文案/actionName 冻结 |
| mfgOutputs | 服务返回 status 小写 | wire 大写(HTTP 经 upper() 不变) | 内核 wire 口径 |
| mfgOutputs | 跨公司 create 404`公司不存在` | `生产入库单不存在` | 内核统一文案先例 |
| mfgMoldDesigns | — | 整资源弹射,零改动 | 1:1 伴生物料的编排实体(级联建/删物料+双审计面);update 入参是 join 列,内核 normalizeInput 会丢弃 |

## 合入 main 时与 feat(numbering)（bfbf764b「单据编号一律系统生成」）的语义对齐（2026-08-07）

| 资源/层 | 迁移分支行为 | 合并后行为 | 依据 |
|---------|--------------|------------|------|
| 内核 numbering | 未提供自动取号,显式传入跳过 | 编号一律系统生成:wire 层 readonly 挡手填,服务层传非空值 400「编号由系统生成,不接受手填」 | ADR 2026-08-06-system-generated-numbering |
| 内核 insertRow | 编号字段可写,随 draft 落库 | readonly 编号字段经 extraCols 落库(与树 path 同形态);可写编号字段照旧,勿重复 | 内核缺陷修复(readonly 列被可写列集跳过致 NOT NULL 违约) |
| expense/invoice | beforeWrite 钩子手拼取号 values | 改用内核 numbering 选项(values 按 draft 全量派生,expense_date/invoice_date 键名天然一致) | 消除键名错配地雷;assigned 语义统一 |
| journal 内部 seam | createAndAuditJournal 跳过式取号 | assignedInTx(内部调用方传号同样 400) | 与 bfbf764b 对齐;无调用方传号 |
| 库存三单据/bill 手写 create | 跳过式取号 | assignedInTx(HEAD 侧原样采纳,含 occurred_on 键名修正) | 同上 |
| 员工/部门/物料/凭证/completion 等 meta | 编号字段 required/可写 | readonly + maxLength(readonly 胜出) | 编号系统生成的结构化表达 |
| 员工 update code 键 | 服务层 422「编辑不可清空」 | readonly 键被内核静默忽略,编号不动(断言改为验证不变) | wire 层已由 strict schema 挡;服务层丢弃即幂等 |
| 各测试夹具 | 手填编号(员工/部门/物料/库存/制造/报价/内核 v2 夹具) | 全部改系统取号;合同套件补 hr.employee 规则夹具 | 判官对齐新政策 |
