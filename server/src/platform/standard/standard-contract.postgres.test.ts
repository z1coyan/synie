/**
 * 标准动作合同测试：对每个标准派生资源跑同一组断言。
 *
 * 合同（写一次，所有接入资源免费继承）：
 * - create 落库并写 create 审计
 * - update 有差异才落库+审计；无差异直接返回现值（updated_at 不动、无审计）
 * - delete 写 destroy 审计；之后 get 即 not_found
 * - 批量动作单事务全成全败（一行失败全量回滚）
 * - 授权决策 fail-closed：无授权 actor 在决策层即 deny（与路由 guard 同一路径）
 * - update schema 不含 createOnly 字段
 *
 * 新资源迁入标准派生后在 CASES 里加一行描述符即可。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import { createGlEngine } from '~/engines/gl/index.ts'
import { createInventoryEngine } from '~/engines/inventory/index.ts'
import { createJournalService } from '~/modules/accounting/journal-service.ts'
import { createAccountService } from '~/modules/base/account-service.ts'
import { createCurrencyService } from '~/modules/base/currency-service.ts'
import { createUnitService } from '~/modules/base/unit-service.ts'
import { createBankAccountService } from '~/modules/finance/banking-accounts.ts'
import { createExpenseService } from '~/modules/finance/expense-service.ts'
import { createPayrollService } from '~/modules/hr/payroll-service.ts'
import { createDepartmentService } from '~/modules/iam/department-service.ts'
import { createInstrumentService } from '~/modules/base/market/index.ts'
import { createMaterialCategoryService } from '~/modules/inventory/category-service.ts'
import { createMaterialService } from '~/modules/inventory/material-service.ts'
import { createMasterService } from '~/modules/manufacturing/master-service.ts'
import { createOutputService } from '~/modules/manufacturing/output-service.ts'
import { createPartyAddressService } from '~/modules/party/address-service.ts'
import { createCustomerService, createEmployeeService, createSupplierService } from '~/modules/party/party-service.ts'
import { buildNumberingCatalog } from '~/platform/numbering/catalog.ts'
import { createNumberingService } from '~/platform/numbering/service.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { createAuthzEnforcer } from '~/platform/authz/enforce.ts'
import { testActor } from '~/platform/authz/testing.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import type { StandardService } from './service.ts'
import { deriveWireSchemas } from './wire.ts'

const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10)

/** 从随机串派生 n 位大写字母（ISO 编码等格式约束字段用） */
function letters(n: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const seed = crypto.randomUUID().replace(/-/g, '')
  let out = ''
  for (let i = 0; i < n; i++) out += alphabet[seed.charCodeAt(i) % 26]!
  return out
}

interface ContractCase {
  title: string
  resource: string
  make: (db: ReturnType<typeof createDb>, registry: ReturnType<typeof createSealedResourceRegistry>) => StandardService
  /** 每次调用生成一份可创建载荷（相互不撞唯一约束） */
  valid: () => Record<string, unknown>
  /** 对任意现值都构成差异的补丁 */
  patch: () => Record<string, unknown>
}

const CASES: ContractCase[] = [
  {
    title: '计量单位',
    resource: 'basUnits',
    make: (db, registry) => createUnitService(db, registry),
    valid: () => ({
      unitType: 'WEIGHT',
      name: `合同-${crypto.randomUUID().slice(0, 8)}`,
      symbol: `ct${crypto.randomUUID().slice(0, 8)}`,
      ratio: '2',
    }),
    patch: () => ({ name: `合同改-${crypto.randomUUID().slice(0, 8)}` }),
  },
  {
    title: '币种',
    resource: 'basCurrencies',
    make: (db, registry) => createCurrencyService(db, registry),
    valid: () => ({ name: `合同币-${crypto.randomUUID().slice(0, 8)}`, isoCode: letters(3) }),
    patch: () => ({ name: `合同币改-${crypto.randomUUID().slice(0, 8)}` }),
  },
  {
    title: '客户',
    resource: 'salCustomers',
    make: (db, registry) => createCustomerService(db, registry),
    valid: () => ({ code: `CT${crypto.randomUUID().slice(0, 8)}`, name: `合同客户-${crypto.randomUUID().slice(0, 8)}` }),
    patch: () => ({ name: `合同客户改-${crypto.randomUUID().slice(0, 8)}` }),
  },
  {
    title: '供应商',
    resource: 'purSuppliers',
    make: (db, registry) => createSupplierService(db, registry),
    valid: () => ({ code: `ST${crypto.randomUUID().slice(0, 8)}`, name: `合同供应商-${crypto.randomUUID().slice(0, 8)}` }),
    patch: () => ({ name: `合同供应商改-${crypto.randomUUID().slice(0, 8)}` }),
  },
  {
    title: '对手地址',
    resource: 'basPartyAddresses',
    make: (db, registry) => createPartyAddressService(db, registry),
    // isDefault 缺省：避免批量用例的两行撞默认地址部分唯一索引；OTHER 用途避开发货默认联动
    valid: () => ({
      partyType: 'CUSTOMER',
      partyId: contractPartyId,
      name: `合同地址-${crypto.randomUUID().slice(0, 8)}`,
      purpose: 'OTHER',
      province: '上海市',
      city: '市辖区',
      district: '黄浦区',
      address: `合同路 ${crypto.randomUUID().slice(0, 4)} 号`,
    }),
    patch: () => ({ name: `合同地址改-${crypto.randomUUID().slice(0, 8)}` }),
  },
  {
    title: '员工',
    resource: 'hrEmployees',
    make: (db, registry) =>
      createEmployeeService(db, createNumberingService(db, buildNumberingCatalog(registry), registry), registry),
    // 员工编号系统生成（ADR 2026-08-06-system-generated-numbering）：载荷不带 code
    valid: () => ({
      name: `合同员工-${crypto.randomUUID().slice(0, 8)}`,
      insuranceTypes: ['SOCIAL_INJURY'],
    }),
    patch: () => ({ name: `合同员工改-${crypto.randomUUID().slice(0, 8)}` }),
  },
  {
    title: '会计科目',
    resource: 'basAccounts',
    make: (db, registry) => createAccountService(db, registry),
    valid: () => ({
      code: `CA${crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`,
      name: `合同科目-${crypto.randomUUID().slice(0, 8)}`,
      direction: 'DEBIT',
      companyId: accountFixture.companyId,
    }),
    patch: () => ({ name: `合同科目改-${crypto.randomUUID().slice(0, 8)}` }),
  },
  {
    title: '物料分类',
    resource: 'invMaterialCategories',
    make: (db, registry) => createMaterialCategoryService(db, registry),
    valid: () => ({
      code: `CC${crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`,
      name: `合同分类-${crypto.randomUUID().slice(0, 8)}`,
    }),
    patch: () => ({ name: `合同分类改-${crypto.randomUUID().slice(0, 8)}` }),
  },
  {
    title: '物料',
    resource: 'invMaterials',
    make: (db, registry) =>
      createMaterialService(db, createNumberingService(db, buildNumberingCatalog(registry), registry), registry),
    // code 自动取号（夹具规则），载荷天然不撞
    valid: () => ({
      name: `合同料-${crypto.randomUUID().slice(0, 8)}`,
      categoryId: materialFixture.categoryId,
      defaultUnitId: materialFixture.unitId,
    }),
    patch: () => ({ name: `合同料改-${crypto.randomUUID().slice(0, 8)}` }),
  },
  {
    title: '行情品种',
    resource: 'basMarketInstruments',
    make: (db, registry) => createInstrumentService(db, registry),
    // code 全局唯一，10 位大写随机防撞
    valid: () => ({
      code: `CT${crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`,
      name: `合同品种-${crypto.randomUUID().slice(0, 8)}`,
      sourceType: 'EXCHANGE',
      defaultPriceKind: 'SETTLEMENT',
      currencyId: marketFixture.currencyId,
      unitId: marketFixture.unitId,
    }),
    patch: () => ({ name: `合同品种改-${crypto.randomUUID().slice(0, 8)}` }),
  },
  {
    title: '部门',
    resource: 'sysDepartments',
    make: (db, registry) =>
      createDepartmentService(db, createNumberingService(db, buildNumberingCatalog(registry), registry), registry),
    // 部门编码系统生成（夹具规则 sys.department）：载荷不带 code
    valid: () => ({
      companyId: accountFixture.companyId,
      name: `合同部门-${crypto.randomUUID().slice(0, 8)}`,
    }),
    patch: () => ({ name: `合同部门改-${crypto.randomUUID().slice(0, 8)}` }),
  },
  {
    title: '工序',
    resource: 'mfgOperations',
    make: (db, registry) =>
      createMasterService(db, createNumberingService(db, buildNumberingCatalog(registry), registry), registry)._operationsForContract(),
    // 工序编号系统生成（夹具规则 mfg.operation）
    valid: () => ({ name: `合同工序-${crypto.randomUUID().slice(0, 8)}` }),
    patch: () => ({ name: `合同工序改-${crypto.randomUUID().slice(0, 8)}` }),
  },
  {
    title: '生产入库单',
    resource: 'mfgOutputs',
    make: (db, registry) =>
      createOutputService(
        db,
        createNumberingService(db, buildNumberingCatalog(registry), registry),
        createInventoryEngine(),
        registry,
      )._headsForContract(),
    // 默认仓库可空（仅新建行预填）；入库日期缺省当日；单号系统生成
    valid: () => ({ companyId: accountFixture.companyId }),
    patch: () => ({ remarks: `合同入库改-${crypto.randomUUID().slice(0, 8)}` }),
  },
  {
    title: '会计凭证',
    resource: 'accGlJournals',
    make: (db, registry) =>
      createJournalService(
        db,
        createNumberingService(db, buildNumberingCatalog(registry), registry),
        createGlEngine(),
        registry,
      ),
    // 凭证号系统生成；草稿凭证无需分录行
    valid: () => ({ companyId: accountFixture.companyId, date: '2026-01-04' }),
    patch: () => ({ remarks: `合同凭证改-${crypto.randomUUID().slice(0, 8)}` }),
  },
  {
    title: '费用报销单',
    resource: 'accExpenseReports',
    make: (db, registry) =>
      createExpenseService(
        db,
        createNumberingService(db, buildNumberingCatalog(registry), registry),
        createGlEngine(),
        registry,
      )._reportsForContract(),
    // 员工与付款科目（同公司叶子启用）夹具；单号系统生成
    valid: () => ({
      companyId: accountFixture.companyId,
      expenseDate: '2026-01-05',
      employeeId: employeeIds[0]!,
      paymentAccountId: expenseFixture.accountId,
    }),
    patch: () => ({ remarks: `合同报销改-${crypto.randomUUID().slice(0, 8)}` }),
  },
  {
    title: '工资单',
    resource: 'hrPayrolls',
    make: (db, registry) => createPayrollService({ db, registry })._payrollsForContract(),
    // (员工,月份) 唯一索引：valid() 从员工池取一名未用过的员工
    valid: () => {
      const employeeId = payrollEmployeePool.shift()
      if (!employeeId) throw new Error('工资单员工池耗尽')
      return { employeeId, month: '2026-01' }
    },
    patch: () => ({ bonus: `${(Number(`0${crypto.randomUUID().replace(/\D/g, '')}`) % 900) + 100}.5` }),
  },
  {
    title: '员工借款',
    resource: 'hrEmployeeLoans',
    make: (db, registry) => createPayrollService({ db, registry })._loansForContract(),
    valid: () => ({
      employeeId: employeeIds[1]!,
      kind: 'BORROW',
      occurredOn: '2026-01-03',
      amount: '10',
    }),
    patch: () => ({ remarks: `合同借款改-${crypto.randomUUID().slice(0, 8)}` }),
  },
]

/** 地址描述符的往来主体夹具（beforeAll 填充；valid() 惰性读取） */
let contractPartyId = ''
/** 行情品种描述符的币种/单位夹具 */
const marketFixture = { currencyId: '', unitId: '' }
/** 物料描述符的分类/单位/编号规则夹具 */
const materialFixture = { categoryId: '', unitId: '', ruleId: '' }
/** 员工编号规则夹具（编号一律系统生成；共享库已有启用规则则复用） */
const employeeFixture = { ruleId: '' }
/** 会计科目描述符的公司夹具（裸插入，避开公司服务的建仓联动） */
const accountFixture = { companyId: '', currencyId: '' }
/** 员工夹具 id（裸插入；[0] 报销/发票共用、[1] 借款、其余进工资单池） */
const employeeIds: string[] = []
/** 工资单描述符的员工池（(员工,月份) 唯一，valid() 逐个消耗） */
const payrollEmployeePool: string[] = []
/** 报销单描述符的付款科目夹具（accountFixture 公司下的叶子启用科目） */
const expenseFixture = { accountId: '' }
/** 本 run 新插的编号规则 id（共享库已有启用规则则复用不记）；afterAll 清理 */
const insertedRuleIds: string[] = []
/** admin actor 的真实用户 id（created_by_id 外键盖章用；beforeAll 填充） */
let adminUserId = ''

run('标准动作合同（postgres）', () => {
  const db = createDb(url!)
  const registry = createSealedResourceRegistry()
  const authz = createAuthzEnforcer(registry)
  /** table → 已创建 id（清理用） */
  const created: Array<{ table: string; id: string }> = []

  function permitOf(actor: Actor, resource: string, action: string): Permit {
    const decision = authz.decideFor(actor, resource, action)
    if (decision.outcome !== 'permit') throw new Error(`夹具应当 permit：${resource}:${action}`)
    return decision.permit
  }

  // beforeAll 落真实 sys_user 后重挂 userId（created_by_id 外键盖章）；测试体运行时读取
  let admin = testActor({ username: `std-contract-${suffix}`, superAdmin: true, allCompanies: true })

  async function auditCount(table: string, recordId: string, actionType: string): Promise<number> {
    const rows = await db
      .selectFrom('sys_audit_log')
      .select('id')
      .where('resource', '=', table)
      .where('record_id', '=', recordId)
      .where('action_type', '=', actionType)
      .execute()
    return rows.length
  }

  /** 同资源唯一启用规则：共享库已有则复用，否则新插（text 前缀 + seq）并记清理 */
  async function ensureNumberingRule(resource: string, prefix: string, name: string): Promise<void> {
    const existing = await sql<{ id: string }>`
      SELECT id FROM sys_numbering_rule WHERE resource = ${resource} AND enabled
    `.execute(db)
    if (existing.rows.length > 0) return
    // segments 须内联字面量：绑参会被驱动 JSON 编码成字符串型 jsonb，渲染为空（与上方物料/员工先例同形）
    const segments = sql.raw(`ARRAY['{"type":"text","value":"${prefix}"}'::jsonb, '{"type":"seq","padding":6}'::jsonb]`)
    const rule = await sql<{ id: string }>`
      INSERT INTO sys_numbering_rule(resource, name, segments, per_company, enabled)
      VALUES (${resource}, ${name}, ${segments}, false, true)
      RETURNING id
    `.execute(db)
    insertedRuleIds.push(rule.rows[0]!.id)
  }

  beforeAll(async () => {
    const row = await sql<{ id: string }>`
      INSERT INTO sal_customers(code, name) VALUES (${`PC${suffix}`}, ${`合同地址主体-${suffix}`}) RETURNING id
    `.execute(db)
    contractPartyId = row.rows[0]!.id
    const cur = await sql<{ id: string }>`
      INSERT INTO bas_currency(name, iso_code) VALUES (${`合同行情币-${suffix}`}, ${letters(3)}) RETURNING id
    `.execute(db)
    marketFixture.currencyId = cur.rows[0]!.id
    const unit = await sql<{ id: string }>`
      INSERT INTO bas_unit(unit_type, is_base, name, symbol, ratio)
      VALUES ('quantity', false, ${`合同行情单位-${suffix}`}, ${`ct${suffix.slice(0, 6)}`}, 1) RETURNING id
    `.execute(db)
    marketFixture.unitId = unit.rows[0]!.id
    const category = await sql<{ id: string }>`
      INSERT INTO inv_material_category(code, name, is_leaf, active)
      VALUES (${`CTC-${suffix}`}, ${`合同分类-${suffix}`}, true, true) RETURNING id
    `.execute(db)
    materialFixture.categoryId = category.rows[0]!.id
    const mUnit = await sql<{ id: string }>`
      INSERT INTO bas_unit(unit_type, is_base, name, symbol, ratio)
      VALUES ('quantity', false, ${`合同料单位-${suffix}`}, ${`mt${suffix.slice(0, 6)}`}, 1) RETURNING id
    `.execute(db)
    materialFixture.unitId = mUnit.rows[0]!.id
    const acctCur = await sql<{ id: string }>`
      INSERT INTO bas_currency(name, iso_code) VALUES (${`合同科目币-${suffix}`}, ${letters(3)}) RETURNING id
    `.execute(db)
    accountFixture.currencyId = acctCur.rows[0]!.id
    const acctCompany = await sql<{ id: string }>`
      INSERT INTO bas_company(code, name, short_name, base_currency_id)
      VALUES (${letters(2) + suffix.slice(4, 8).toUpperCase()}, ${`合同科目公司-${suffix}`}, ${`科目司-${suffix.slice(0, 4)}`}, ${accountFixture.currencyId}::uuid)
      RETURNING id
    `.execute(db)
    accountFixture.companyId = acctCompany.rows[0]!.id
    // 物料自动取号规则（同资源唯一启用；共享库已有则复用，不新插）
    const existing = await sql<{ id: string }>`
      SELECT id FROM sys_numbering_rule WHERE resource = 'base.material' AND enabled
    `.execute(db)
    if (existing.rows.length > 0) {
      materialFixture.ruleId = ''
    } else {
      const rule = await sql<{ id: string }>`
        INSERT INTO sys_numbering_rule(resource, name, segments, per_company, enabled)
        VALUES ('base.material', ${`合同料规则-${suffix}`},
                ARRAY['{"type":"text","value":"CT-"}'::jsonb, '{"type":"seq","padding":6}'::jsonb],
                false, true) RETURNING id
      `.execute(db)
      materialFixture.ruleId = rule.rows[0]!.id
    }
    // 员工自动取号规则（同资源唯一启用；共享库已有则复用，不新插）
    const employeeRule = await sql<{ id: string }>`
      SELECT id FROM sys_numbering_rule WHERE resource = 'hr.employee' AND enabled
    `.execute(db)
    if (employeeRule.rows.length > 0) {
      employeeFixture.ruleId = ''
    } else {
      const rule = await sql<{ id: string }>`
        INSERT INTO sys_numbering_rule(resource, name, segments, per_company, enabled)
        VALUES ('hr.employee', ${`合同员规则-${suffix}`},
                ARRAY['{"type":"text","value":"CE-"}'::jsonb, '{"type":"seq","padding":6}'::jsonb],
                false, true) RETURNING id
      `.execute(db)
      employeeFixture.ruleId = rule.rows[0]!.id
    }
    // 其余编号规则（部门/工序/入库单/报销单/凭证）：同资源唯一启用，有则复用
    await ensureNumberingRule('sys.department', 'CD-', `合同部门规则-${suffix}`)
    await ensureNumberingRule('mfg.operation', 'CO-', `合同工序规则-${suffix}`)
    await ensureNumberingRule('mfg.output', 'CU-', `合同入库规则-${suffix}`)
    await ensureNumberingRule('acc.expense_report', 'CE-', `合同报销规则-${suffix}`)
    await ensureNumberingRule('acc.gl_journal', 'CJ-', `合同凭证规则-${suffix}`)
    // admin 的真实用户行：报销/入库/凭证等服务的 created_by_id 盖章有 sys_user 外键
    const user = await sql<{ id: string }>`
      INSERT INTO sys_user(username, hashed_password) VALUES (${`std-contract-${suffix}`}, 'contract-fixture') RETURNING id
    `.execute(db)
    adminUserId = user.rows[0]!.id
    admin = testActor({ username: `std-contract-${suffix}`, superAdmin: true, allCompanies: true, userId: adminUserId })
    // 员工夹具（裸插入：报销对象/发票对手/借款/工资单池共用 8 名）
    for (let i = 0; i < 8; i += 1) {
      const emp = await sql<{ id: string }>`
        INSERT INTO hr_employees(code, name) VALUES (${`PE${suffix}${i}`}, ${`合同员工夹具-${suffix}-${i}`}) RETURNING id
      `.execute(db)
      employeeIds.push(emp.rows[0]!.id)
    }
    payrollEmployeePool.push(...employeeIds.slice(2))
    // 报销单付款科目（accountFixture 公司下叶子启用；清理随该公司的科目整批删除）
    const payAccount = await sql<{ id: string }>`
      INSERT INTO bas_account(code, name, direction, company_id)
      VALUES (${`PA${suffix.toUpperCase()}`}, ${`合同付款科目-${suffix}`}, 'DEBIT', ${accountFixture.companyId}::uuid)
      RETURNING id
    `.execute(db)
    expenseFixture.accountId = payAccount.rows[0]!.id
  })

  afterAll(async () => {
    for (const entry of created.reverse()) {
      await db.deleteFrom('sys_audit_log').where('resource', '=', entry.table).where('record_id', '=', entry.id).execute()
      await db
        .deleteFrom(entry.table as 'bas_unit')
        .where('id', '=', entry.id)
        .execute()
    }
    await db.deleteFrom('bas_party_address').where('party_id', '=', contractPartyId).execute()
    await db.deleteFrom('sal_customers').where('id', '=', contractPartyId).execute()
    await db.deleteFrom('bas_market_instrument').where('currency_id', '=', marketFixture.currencyId).execute()
    await db.deleteFrom('bas_unit').where('id', '=', marketFixture.unitId).execute()
    await db.deleteFrom('bas_currency').where('id', '=', marketFixture.currencyId).execute()
    await db.deleteFrom('inv_material').where('category_id', '=', materialFixture.categoryId).execute()
    await db.deleteFrom('inv_material_category').where('id', '=', materialFixture.categoryId).execute()
    await db.deleteFrom('bas_unit').where('id', '=', materialFixture.unitId).execute()
    if (materialFixture.ruleId) {
      await db.deleteFrom('sys_numbering_rule').where('id', '=', materialFixture.ruleId).execute()
    }
    if (employeeFixture.ruleId) {
      await db.deleteFrom('sys_numbering_rule').where('id', '=', employeeFixture.ruleId).execute()
    }
    await db.deleteFrom('bas_account').where('company_id', '=', accountFixture.companyId).execute()
    await db.deleteFrom('bas_company').where('id', '=', accountFixture.companyId).execute()
    await db.deleteFrom('bas_currency').where('id', '=', accountFixture.currencyId).execute()
    if (employeeIds.length > 0) {
      await db.deleteFrom('hr_employees').where('id', 'in', employeeIds).execute()
    }
    for (const ruleId of insertedRuleIds) {
      await db.deleteFrom('sys_numbering_rule').where('id', '=', ruleId).execute()
    }
    if (adminUserId) {
      await db.deleteFrom('sys_user').where('id', '=', adminUserId).execute()
    }
    await db.destroy()
  })

  describe('公司域路径（银行账户）：边界 fail-closed + 审计 company_id + 引用钩子', () => {
    const bankAccounts = createBankAccountService(db, registry)
    let companyA = ''
    let companyB = ''
    let currencyId = ''

    /** 公司夹具裸插入：本合同只验公司边界语义，不经公司服务（避免联动种子） */
    async function insertCompany(name: string): Promise<string> {
      const result = await sql<{ id: string }>`
        INSERT INTO bas_company(code, name, short_name, base_currency_id)
        VALUES (${letters(2) + suffix.slice(0, 4).toUpperCase()}, ${name}, ${name}, ${currencyId}::uuid)
        RETURNING id
      `.execute(db)
      return result.rows[0]!.id
    }

    beforeAll(async () => {
      const cur = await sql<{ id: string }>`
        INSERT INTO bas_currency(name, iso_code) VALUES (${`合同夹具币-${suffix}`}, ${letters(3)})
        RETURNING id
      `.execute(db)
      currencyId = cur.rows[0]!.id
      companyA = await insertCompany(`合同公司A-${suffix}`)
      companyB = await insertCompany(`合同公司B-${suffix}`)
    })

    afterAll(async () => {
      await db.deleteFrom('acc_bank_account').where('company_id', 'in', [companyA, companyB]).execute()
      await db.deleteFrom('bas_company').where('id', 'in', [companyA, companyB]).execute()
      await db.deleteFrom('bas_currency').where('id', '=', currencyId).execute()
    })

    const scoped = () =>
      testActor({
        username: `std-scoped-${suffix}`,
        companyIds: [companyA],
        permissions: [
          'acc.bank_account:read',
          'acc.bank_account:create',
          'acc.bank_account:update',
          'acc.bank_account:delete',
        ],
      })

    function payload(companyId: string): Record<string, unknown> {
      return {
        alias: `合同户-${crypto.randomUUID().slice(0, 8)}`,
        bankName: '合同银行',
        holderName: '合同持有人',
        accountNo: `62${crypto.randomUUID().replace(/\D/g, '').slice(0, 10)}`,
        companyId,
        currencyId,
      }
    }

    test('本公司可建；审计带 company_id；列表只见本公司', async () => {
      const actor = scoped()
      const item = await bankAccounts.create(permitOf(actor, 'accBankAccounts', 'create'), payload(companyA))
      created.push({ table: 'acc_bank_account', id: item.id })
      expect(item.companyId).toBe(companyA)

      const audit = await db
        .selectFrom('sys_audit_log')
        .select(['company_id'])
        .where('resource', '=', 'acc_bank_account')
        .where('record_id', '=', item.id)
        .where('action_type', '=', 'create')
        .executeTakeFirst()
      expect(audit?.company_id).toBe(companyA)

      const listed = await bankAccounts.list(permitOf(actor, 'accBankAccounts', 'read'), { limit: 200, offset: 0 })
      expect(listed.results.every((r) => r.companyId === companyA)).toBe(true)
    })

    test('越公司边界创建 → not_found（不泄露存在性）', async () => {
      const actor = scoped()
      await expect(
        bankAccounts.create(permitOf(actor, 'accBankAccounts', 'create'), payload(companyB)),
      ).rejects.toMatchObject({ code: 'not_found' })
    })

    test('引用钩子：货币不存在 → validation', async () => {
      const actor = scoped()
      await expect(
        bankAccounts.create(permitOf(actor, 'accBankAccounts', 'create'), {
          ...payload(companyA),
          currencyId: crypto.randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'validation' })
    })
  })

  for (const c of CASES) {
    describe(c.title, () => {
      const service = c.make(db, registry)
      const table = service.meta.table
      const track = (id: string) => created.push({ table, id })

      test('update schema 不含 createOnly 字段；create/update 均拒绝未知键', () => {
        const schemas = deriveWireSchemas(service.meta, service.stampedColumns)
        const createOnly = service.meta.fields.filter((f) => f.createOnly).map((f) => f.apiName)
        for (const apiName of createOnly) {
          expect(schemas.update.safeParse({ [apiName]: 'X' }).success).toBe(false)
        }
        expect(schemas.create.safeParse({ __bogus: 1 }).success).toBe(false)
        expect(schemas.update.safeParse({ __bogus: 1 }).success).toBe(false)
      })

      test('无授权 actor 决策层即 deny（fail-closed）', () => {
        const nobody = testActor({ username: `std-nobody-${suffix}` })
        for (const action of ['read', 'create', 'update', 'delete']) {
          expect(authz.decideFor(nobody, c.resource, action).outcome).not.toBe('permit')
        }
      })

      test('create 落库+审计；get/list 可见', async () => {
        const item = await service.create(permitOf(admin, c.resource, 'create'), c.valid())
        track(item.id)
        expect(item.id).toBeTruthy()
        expect(await auditCount(table, item.id, 'create')).toBe(1)

        const got = await service.get(permitOf(admin, c.resource, 'read'), item.id)
        expect(got.id).toBe(item.id)
        const listed = await service.list(permitOf(admin, c.resource, 'read'), { limit: 200, offset: 0 })
        expect(listed.results.some((r) => r.id === item.id)).toBe(true)
      })

      test('update 有差异才审计；无差异不落库', async () => {
        const item = await service.create(permitOf(admin, c.resource, 'create'), c.valid())
        track(item.id)
        const patch = c.patch()
        const updated = await service.update(permitOf(admin, c.resource, 'update'), item.id, patch)
        expect(await auditCount(table, item.id, 'update')).toBe(1)

        // 同一补丁再来一次：无差异，返回现值，不写审计不碰 updated_at
        const noop = await service.update(permitOf(admin, c.resource, 'update'), item.id, patch)
        expect(await auditCount(table, item.id, 'update')).toBe(1)
        expect((noop.updatedAt as Date).getTime()).toBe((updated.updatedAt as Date).getTime())
      })

      test('delete 落 destroy 审计；之后 not_found', async () => {
        const item = await service.create(permitOf(admin, c.resource, 'create'), c.valid())
        track(item.id)
        await service.remove(permitOf(admin, c.resource, 'delete'), item.id)
        expect(await auditCount(table, item.id, 'destroy')).toBe(1)
        await expect(service.get(permitOf(admin, c.resource, 'read'), item.id)).rejects.toMatchObject({
          code: 'not_found',
        })
      })

      test('批量单事务全成全败', async () => {
        const a = await service.create(permitOf(admin, c.resource, 'create'), c.valid())
        const b = await service.create(permitOf(admin, c.resource, 'create'), c.valid())
        track(a.id)
        track(b.id)

        // 一行不存在 → 全量回滚，a 仍在
        const ghost = crypto.randomUUID()
        await expect(
          service.bulkRemove(permitOf(admin, c.resource, 'delete'), [a.id, ghost]),
        ).rejects.toMatchObject({ code: 'not_found' })
        const still = await service.get(permitOf(admin, c.resource, 'read'), a.id)
        expect(still.id).toBe(a.id)

        // 批量更新逐行审计
        const items = await service.bulkUpdate(permitOf(admin, c.resource, 'update'), [a.id, b.id], c.patch())
        expect(items).toHaveLength(2)
        expect(await auditCount(table, a.id, 'update')).toBe(1)
        expect(await auditCount(table, b.id, 'update')).toBe(1)

        // 全部存在 → 批量删除成功
        const count = await service.bulkRemove(permitOf(admin, c.resource, 'delete'), [a.id, b.id])
        expect(count).toBe(2)
        expect(await auditCount(table, a.id, 'destroy')).toBe(1)
      })
    })
  }
})
