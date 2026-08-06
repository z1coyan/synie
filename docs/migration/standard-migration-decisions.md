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
