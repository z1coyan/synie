/**
 * 初始化向导服务（对齐 server-go/internal/platform/setup）。
 * - 事务级 Setup 锁（advisory xact lock + sys_setting FOR UPDATE）
 * - 首用户并发只允许一个成功
 * - complete：基础种子 → 可选示例数据 → 落 setup_completed_at（示例失败不落旗标）
 */
import { sql, type Kysely } from 'kysely'
import { withTx, type DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import { syncUserCredential } from '../auth/credentials.ts'
import { hashPassword } from '../auth/password.ts'
import type { TokenManager } from '../auth/token.ts'
import type { Actor } from '../authz/actor.ts'
import { ApiError } from '../http/errors.ts'

/** 示例数据摘要（wire 形状；实现在 modules/setup） */
export interface SampleSummary {
  customers: number
  suppliers: number
  materials: number
  employees: number
  salesQuotations: number
  purchaseQuotations: number
  salesOrders: number
  purchaseOrders: number
  salesDeliveries: number
  purchaseReceipts: number
  salesReconciliations: number
  purchaseReconciliations: number
  stockDocs: number
  stockTransfers: number
  stockCounts: number
  operations: number
  processTemplates: number
  boms: number
  bankAccounts: number
  bankTransactions: number
  glJournals: number
  expenseReports: number
  payrolls: number
  vatInvoices: number
  outsourcedOrders: number
  outsourcedIssues: number
  outsourcedReceipts: number
}

/** 与 Go setupLockKey 0x53594e4945534554（"SYNIESET"）一致 */
const SETUP_LOCK_KEY = BigInt('0x53594e4945534554')

const COMMON_CURRENCIES: ReadonlyArray<{ name: string; code: string; symbol: string }> = [
  { name: '人民币', code: 'CNY', symbol: '￥' },
  { name: '美元', code: 'USD', symbol: '$' },
  { name: '欧元', code: 'EUR', symbol: '€' },
  { name: '日元', code: 'JPY', symbol: '¥' },
  { name: '港币', code: 'HKD', symbol: 'HK$' },
  { name: '新台币', code: 'TWD', symbol: 'NT$' },
  { name: '英镑', code: 'GBP', symbol: '£' },
  { name: '韩元', code: 'KRW', symbol: '₩' },
  { name: '新加坡元', code: 'SGD', symbol: 'S$' },
  { name: '澳大利亚元', code: 'AUD', symbol: 'A$' },
  { name: '加拿大元', code: 'CAD', symbol: 'C$' },
  { name: '瑞士法郎', code: 'CHF', symbol: 'CHF' },
  { name: '澳门元', code: 'MOP', symbol: 'MOP$' },
  { name: '泰铢', code: 'THB', symbol: '฿' },
  { name: '马来西亚林吉特', code: 'MYR', symbol: 'RM' },
  { name: '印尼盾', code: 'IDR', symbol: 'Rp' },
  { name: '越南盾', code: 'VND', symbol: '₫' },
  { name: '菲律宾比索', code: 'PHP', symbol: '₱' },
  { name: '印度卢比', code: 'INR', symbol: '₹' },
  { name: '俄罗斯卢布', code: 'RUB', symbol: '₽' },
]

export interface SetupStatus {
  initialized: boolean
  hasUsers: boolean
}

export interface FirstUserInput {
  username: string
  name?: string | null
  password: string
}

export interface FirstUserResult {
  token: string
  expiresAt: Date
  user: { id: string; username: string; name: string | null }
}

export interface SetupServiceDeps {
  db: Kysely<Database>
  tokens: TokenManager
  /**
   * 可选示例数据种子（组合根注入 modules/setup.seedSampleData）。
   * 未注入时 complete(seedSample=true) → not_implemented。
   */
  seedSampleData?: ((actor: Actor, companyId: string) => Promise<SampleSummary>) | null
  /**
   * 基础域业务种子（物料分类等；组合根注入 modules/setup.seedMaterialCategories）。
   * 未注入时 complete 跳过业务表预置（仅 sys_* / bas_* 平台种子）。
   */
  seedMaterialCategories?: ((trx: DbHandle) => Promise<void>) | null
  uploadsRoot?: string
  now?: () => Date
}

export function createSetupService(deps: SetupServiceDeps) {
  const db = deps.db
  const tokens = deps.tokens
  const seedSampleData = deps.seedSampleData ?? null
  const seedMaterialCategories = deps.seedMaterialCategories ?? null
  const uploadsRoot = deps.uploadsRoot ?? process.env.UPLOADS_ROOT ?? 'uploads'
  const now = deps.now ?? (() => new Date())

  async function getStatus(): Promise<SetupStatus> {
    const row = await sql<{ initialized: boolean; has_users: boolean }>`
      SELECT
        EXISTS (SELECT 1 FROM sys_setting WHERE setup_completed_at IS NOT NULL) AS initialized,
        EXISTS (SELECT 1 FROM sys_user) AS has_users
    `.execute(db)
    const first = row.rows[0]
    return {
      initialized: Boolean(first?.initialized),
      hasUsers: Boolean(first?.has_users),
    }
  }

  async function createFirstUser(input: FirstUserInput): Promise<FirstUserResult> {
    const username = input.username.trim()
    const fields: Record<string, string[]> = {}
    if (!username || [...username].length > 64) {
      fields.username = ['不能为空且长度不能超过 64']
    }
    if (!input.password || input.password.length > 1024) {
      fields.password = ['不能为空且长度不能超过 1024']
    }
    if (input.name != null && [...input.name].length > 64) {
      fields.name = ['长度不能超过 64']
    }
    if (Object.keys(fields).length > 0) {
      throw ApiError.validation('首个管理员参数不合法', fields)
    }

    const hash = await hashPassword(input.password)
    const user = await withTx(db, async (trx) => {
      await lockSetup(trx)
      const { initialized, hasUsers } = await setupState(trx)
      if (initialized) {
        throw new ApiError('conflict', '系统已完成初始化')
      }
      if (hasUsers) {
        throw new ApiError('conflict', '已存在用户,请直接登录')
      }
      try {
        const inserted = await trx
          .insertInto('sys_user')
          .values({
            username,
            name: input.name ?? null,
            hashed_password: hash,
            super_admin: true,
            all_companies: true,
          })
          .returning(['id', 'username', 'name'])
          .executeTakeFirstOrThrow()
        // 同事务补建 better-auth 账号（cookie 通道可直接用首个管理员登录）
        await syncUserCredential(trx, { userId: inserted.id, hashedPassword: hash })
        return {
          id: inserted.id,
          username: String(inserted.username),
          name: inserted.name,
        }
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ApiError('conflict', '已存在用户,请直接登录', { cause: err })
        }
        throw new ApiError('internal', '创建首个管理员失败', { cause: err })
      }
    })

    try {
      const issued = await tokens.issue(user.id)
      return { token: issued.token, expiresAt: issued.expiresAt, user }
    } catch (err) {
      throw new ApiError('internal', '管理员已创建但签发登录态失败,请直接登录', { cause: err })
    }
  }

  async function seedCommonCurrencies(): Promise<number> {
    return withTx(db, async (trx) => {
      await lockSetup(trx)
      await rejectInitialized(trx)
      let created = 0
      for (const c of COMMON_CURRENCIES) {
        const result = await sql`
          INSERT INTO bas_currency (name, iso_code, symbol, active)
          VALUES (${c.name}, ${c.code}, ${c.symbol}, false)
          ON CONFLICT (iso_code) DO NOTHING
        `.execute(trx)
        created += Number(result.numAffectedRows ?? 0)
      }
      const hasCompanies = await sql<{ e: boolean }>`
        SELECT EXISTS (SELECT 1 FROM bas_company) AS e
      `.execute(trx)
      if (!hasCompanies.rows[0]?.e) {
        const codes = COMMON_CURRENCIES.map((c) => c.code)
        await sql`
          UPDATE bas_currency
          SET active = false, updated_at = now() AT TIME ZONE 'utc'
          WHERE iso_code = ANY(${codes}::text[]) AND active
        `.execute(trx)
      }
      return created
    })
  }

  async function activateBaseCurrency(currencyId: string): Promise<void> {
    await withTx(db, async (trx) => {
      await lockSetup(trx)
      await rejectInitialized(trx)
      const exists = await sql<{ e: boolean }>`
        SELECT EXISTS (SELECT 1 FROM bas_currency WHERE id = ${currencyId}::uuid) AS e
      `.execute(trx)
      if (!exists.rows[0]?.e) {
        throw new ApiError('not_found', '币种不存在')
      }
      const hasCompanies = await sql<{ e: boolean }>`
        SELECT EXISTS (SELECT 1 FROM bas_company) AS e
      `.execute(trx)
      if (hasCompanies.rows[0]?.e) {
        throw new ApiError('conflict', '已有公司,不可重新选择初始化本币')
      }
      await sql`
        UPDATE bas_currency
        SET active = (id = ${currencyId}::uuid),
            updated_at = now() AT TIME ZONE 'utc'
        WHERE active IS DISTINCT FROM (id = ${currencyId}::uuid)
      `.execute(trx)
    })
  }

  async function complete(
    actor: Actor,
    language: string,
    seedSample: boolean,
  ): Promise<{ sample?: SampleSummary }> {
    if (language !== 'zh-CN' && language !== 'en-US') {
      throw ApiError.validation('完成初始化参数不合法', {
        preferredLanguage: ['仅支持 zh-CN 或 en-US'],
      })
    }
    await completeBaseSeeds(actor, language)

    let sampleSummary: SampleSummary | undefined
    if (seedSample) {
      if (!seedSampleData) {
        throw new ApiError(
          'not_implemented',
          'Setup 尚未配置示例数据依赖,初始化未完成且完成旗标未写入',
        )
      }
      const companyId = await firstCompanyId()
      if (companyId) {
        sampleSummary = await seedSampleData(actor, companyId)
      }
    }

    await writeCompletedAt()
    return sampleSummary ? { sample: sampleSummary } : {}
  }

  async function completeBaseSeeds(actor: Actor, language: string): Promise<void> {
    await withTx(db, async (trx) => {
      await lockSetup(trx)
      await rejectInitialized(trx)
      const updated = await sql`
        UPDATE sys_user
        SET preferred_language = ${language},
            updated_at = now() AT TIME ZONE 'utc'
        WHERE id = ${actor.userId}::uuid
      `.execute(trx)
      if (Number(updated.numAffectedRows ?? 0) !== 1) {
        throw new ApiError('unauthorized', '当前用户不存在')
      }
      await seedLocalStorage(trx)
      await seedNumberingRules(trx)
      if (seedMaterialCategories) {
        await seedMaterialCategories(trx)
      }
      await seedUnits(trx)
      await seedBuiltinRoles(trx)
    })
  }

  async function writeCompletedAt(): Promise<void> {
    await withTx(db, async (trx) => {
      await lockSetup(trx)
      await rejectInitialized(trx)
      const completedAt = now().toISOString()
      const result = await sql`
        UPDATE sys_setting
        SET setup_completed_at = ${completedAt}::timestamptz,
            updated_at = now() AT TIME ZONE 'utc'
        WHERE setup_completed_at IS NULL
      `.execute(trx)
      if (Number(result.numAffectedRows ?? 0) !== 1) {
        throw new ApiError('conflict', '系统设置单行不存在或系统已完成初始化')
      }
    })
  }

  async function firstCompanyId(): Promise<string | null> {
    const row = await sql<{ id: string }>`
      SELECT id FROM bas_company ORDER BY inserted_at, id LIMIT 1
    `.execute(db)
    return row.rows[0]?.id ?? null
  }

  async function seedLocalStorage(trx: DbHandle): Promise<void> {
    try {
      // 幂等：已有 name=local 则跳过；若已有其他默认存储则本行 is_default=false
      await sql`
        INSERT INTO sys_storage (name, label, kind, root, builtin, is_default)
        SELECT 'local', '本地存储', 'local', ${uploadsRoot}, true,
               NOT EXISTS (SELECT 1 FROM sys_storage WHERE is_default)
        WHERE NOT EXISTS (SELECT 1 FROM sys_storage WHERE name = 'local')
      `.execute(trx)
    } catch (err) {
      throw new ApiError('internal', '预置本地存储失败', { cause: err })
    }
  }

  return {
    getStatus,
    createFirstUser,
    seedCommonCurrencies,
    activateBaseCurrency,
    complete,
    commonCurrencyCount: COMMON_CURRENCIES.length,
  }
}

export type SetupService = ReturnType<typeof createSetupService>

async function lockSetup(trx: DbHandle): Promise<void> {
  try {
    await sql`SELECT pg_advisory_xact_lock(${SETUP_LOCK_KEY})`.execute(trx)
    await sql`SELECT id FROM sys_setting ORDER BY id LIMIT 1 FOR UPDATE`.execute(trx)
  } catch (err) {
    throw new ApiError('internal', '获取初始化锁失败', { cause: err })
  }
}

async function setupState(trx: DbHandle): Promise<{ initialized: boolean; hasUsers: boolean }> {
  const row = await sql<{ initialized: boolean; has_users: boolean }>`
    SELECT
      EXISTS (SELECT 1 FROM sys_setting WHERE setup_completed_at IS NOT NULL) AS initialized,
      EXISTS (SELECT 1 FROM sys_user) AS has_users
  `.execute(trx)
  return {
    initialized: Boolean(row.rows[0]?.initialized),
    hasUsers: Boolean(row.rows[0]?.has_users),
  }
}

async function rejectInitialized(trx: DbHandle): Promise<void> {
  const { initialized } = await setupState(trx)
  if (initialized) {
    throw new ApiError('conflict', '系统已完成初始化')
  }
}

interface NumberingRuleSeed {
  resource: string
  name: string
  perCompany: boolean
  segments: string
}

async function seedNumberingRules(trx: DbHandle): Promise<void> {
  const rules: NumberingRuleSeed[] = [
    {
      resource: 'inv.material',
      name: '物料编号',
      perCompany: false,
      segments: `[{"type":"field","field":"category.code","label":"物料分类·分类编号"},{"type":"field","field":"customer.code","label":"所属客户(仅客户物料)·客户编号"},{"type":"text","value":"-"},{"type":"seq","padding":0}]`,
    },
    {
      resource: 'hr.employee',
      name: '员工编号',
      perCompany: false,
      segments: `[{"type":"text","value":"H(E)-"},{"type":"seq","padding":4}]`,
    },
    {
      resource: 'mfg.operation',
      name: '工序编号',
      perCompany: false,
      segments: `[{"type":"text","value":"M(O)-"},{"type":"seq","padding":4}]`,
    },
    {
      resource: 'mfg.route_template',
      name: '工艺模板编号',
      perCompany: false,
      segments: `[{"type":"text","value":"M(T)-"},{"type":"seq","padding":4}]`,
    },
    {
      resource: 'mfg.bom',
      name: 'BOM编号',
      perCompany: false,
      segments: `[{"type":"text","value":"M(B)-"},{"type":"seq","padding":4}]`,
    },
  ]
  const docs: Array<{ resource: string; name: string; prefix: string; field: string; label: string }> =
    [
      { resource: 'sales.order', name: '销售订单编号', prefix: 'S(O)', field: 'order_date', label: '订单日期' },
      {
        resource: 'sales.quotation',
        name: '销售报价编号',
        prefix: 'S(Q)',
        field: 'quotation_date',
        label: '报价日期',
      },
      {
        resource: 'sales.delivery',
        name: '销售发货编号',
        prefix: 'S(D)',
        field: 'delivery_date',
        label: '发货日期',
      },
      {
        resource: 'sales.reconciliation',
        name: '销售对账编号',
        prefix: 'S(R)',
        field: 'posting_date',
        label: '业务日期',
      },
      {
        resource: 'purchase.order',
        name: '采购订单编号',
        prefix: 'P(O)',
        field: 'order_date',
        label: '订单日期',
      },
      {
        resource: 'purchase.quotation',
        name: '采购报价编号',
        prefix: 'P(Q)',
        field: 'quotation_date',
        label: '报价日期',
      },
      {
        resource: 'purchase.receipt',
        name: '采购入库单编号',
        prefix: 'P(R)',
        field: 'receipt_date',
        label: '入库日期',
      },
      {
        resource: 'purchase.reconciliation',
        name: '采购对账编号',
        prefix: 'P(C)',
        field: 'posting_date',
        label: '业务日期',
      },
      {
        resource: 'purchase.outsourced_issue',
        name: '委外发料编号',
        prefix: 'P(OI)',
        field: 'issue_date',
        label: '发料日期',
      },
      {
        resource: 'purchase.outsourced_receipt',
        name: '委外入库编号',
        prefix: 'P(OR)',
        field: 'receipt_date',
        label: '入库日期',
      },
      {
        resource: 'inv.stock_doc',
        name: '手工出入库单编号',
        prefix: 'I(D)',
        field: 'doc_date',
        label: '业务日期',
      },
      {
        resource: 'inv.stock_transfer',
        name: '手工调拨单编号',
        prefix: 'I(T)',
        field: 'doc_date',
        label: '业务日期',
      },
      {
        resource: 'inv.stock_count',
        name: '库存盘点单编号',
        prefix: 'I(C)',
        field: 'posting_date',
        label: '业务日期',
      },
      {
        resource: 'mfg.demand',
        name: '履约需求单编号',
        prefix: 'M(D)',
        field: 'demand_date',
        label: '业务日期',
      },
      {
        resource: 'mfg.work_order',
        name: '生产工单编号',
        prefix: 'M(W)',
        field: 'need_date',
        label: '需求日',
      },
      {
        resource: 'mfg.output',
        name: '生产入库单编号',
        prefix: 'M(R)',
        field: 'output_date',
        label: '入库日期',
      },
      {
        resource: 'acc.gl_journal',
        name: '会计凭证编号',
        prefix: 'A(J)',
        field: 'date',
        label: '凭证日期',
      },
      {
        resource: 'acc.vat_invoice',
        name: '增值税发票编号',
        prefix: 'A(I)',
        field: 'invoice_date',
        label: '开票日期',
      },
      {
        resource: 'acc.bill_transaction',
        name: '承兑交易编号',
        prefix: 'A(B)',
        field: 'occurred_on',
        label: '发生日期',
      },
      {
        resource: 'acc.expense_report',
        name: '费用报销编号',
        prefix: 'A(E)',
        field: 'expense_date',
        label: '费用日期',
      },
    ]
  for (const doc of docs) {
    const segments = `[{"type":"text","value":"${doc.prefix}-"},{"type":"field","field":"${doc.field}","format":"YYYYMMDD","label":"${doc.label}"},{"type":"text","value":"-"},{"type":"seq","padding":4}]`
    rules.push({
      resource: doc.resource,
      name: doc.name,
      perCompany: true,
      segments,
    })
  }
  for (const rule of rules) {
    try {
      // 字面量注入 jsonb[]（与 numbering.service segmentsArraySql 同口径，避免驱动把 text 当标量）
      const literal = rule.segments.replace(/'/g, "''")
      await sql`
        INSERT INTO sys_numbering_rule (resource, name, segments, per_company, enabled)
        SELECT ${rule.resource}, ${rule.name},
               ${sql.raw(`ARRAY(SELECT value FROM jsonb_array_elements('${literal}'::jsonb))`)},
               ${rule.perCompany}, true
        WHERE NOT EXISTS (SELECT 1 FROM sys_numbering_rule WHERE resource = ${rule.resource})
      `.execute(trx)
    } catch (err) {
      throw new ApiError('internal', '预置编号规则失败', { cause: err })
    }
  }
}

async function seedUnits(trx: DbHandle): Promise<void> {
  const units: Array<{
    unitType: string
    wantBase: boolean
    name: string
    symbol: string
    ratio: string
  }> = [
    { unitType: 'length', wantBase: true, name: '毫米', symbol: 'mm', ratio: '1' },
    { unitType: 'length', wantBase: false, name: '微米', symbol: 'μm', ratio: '0.001' },
    { unitType: 'length', wantBase: false, name: '厘米', symbol: 'cm', ratio: '10' },
    { unitType: 'length', wantBase: false, name: '米', symbol: 'm', ratio: '1000' },
    { unitType: 'length', wantBase: false, name: '英寸', symbol: 'in', ratio: '25.4' },
    { unitType: 'area', wantBase: true, name: '平方毫米', symbol: 'mm²', ratio: '1' },
    { unitType: 'area', wantBase: false, name: '平方厘米', symbol: 'cm²', ratio: '100' },
    { unitType: 'area', wantBase: false, name: '平方米', symbol: 'm²', ratio: '1000000' },
    { unitType: 'weight', wantBase: false, name: '克', symbol: 'g', ratio: '0.000001' },
    { unitType: 'quantity', wantBase: true, name: '件', symbol: 'pcs', ratio: '1' },
    { unitType: 'quantity', wantBase: false, name: '只', symbol: '只', ratio: '1' },
    { unitType: 'quantity', wantBase: false, name: '个', symbol: '个', ratio: '1' },
    { unitType: 'quantity', wantBase: false, name: '套', symbol: '套', ratio: '1' },
    { unitType: 'quantity', wantBase: false, name: '台', symbol: '台', ratio: '1' },
    { unitType: 'quantity', wantBase: false, name: '片', symbol: '片', ratio: '1' },
    { unitType: 'quantity', wantBase: false, name: '根', symbol: '根', ratio: '1' },
    { unitType: 'quantity', wantBase: false, name: '支', symbol: '支', ratio: '1' },
    { unitType: 'quantity', wantBase: false, name: '块', symbol: '块', ratio: '1' },
    { unitType: 'quantity', wantBase: false, name: '张', symbol: '张', ratio: '1' },
    { unitType: 'quantity', wantBase: false, name: '箱', symbol: '箱', ratio: '1' },
    { unitType: 'quantity', wantBase: false, name: '包', symbol: '包', ratio: '1' },
    { unitType: 'quantity', wantBase: false, name: '卷', symbol: '卷', ratio: '1' },
    { unitType: 'quantity', wantBase: false, name: '捆', symbol: '捆', ratio: '1' },
    { unitType: 'quantity', wantBase: false, name: '打', symbol: '打', ratio: '12' },
    { unitType: 'quantity', wantBase: false, name: '次', symbol: '次', ratio: '1' },
    { unitType: 'quantity', wantBase: false, name: '项', symbol: '项', ratio: '1' },
  ]
  for (const u of units) {
    try {
      await sql`
        INSERT INTO bas_unit (unit_type, is_base, name, symbol, ratio)
        SELECT ${u.unitType},
               (${u.wantBase} AND NOT EXISTS (
                 SELECT 1 FROM bas_unit WHERE unit_type = ${u.unitType} AND is_base
               )),
               ${u.name}, ${u.symbol}, ${u.ratio}::numeric
        ON CONFLICT (symbol) DO NOTHING
      `.execute(trx)
    } catch (err) {
      throw new ApiError('internal', '预置计量单位失败', { cause: err })
    }
  }
}

/**
 * 内置销售业务员角色（sales）的逐码授权清单。
 * 与权限目录（Registry 派生）对齐；新增权限点不自动授予（fail-closed）。
 */
export const SALES_ROLE_PERMISSIONS: ReadonlyArray<string> = [
  // 销售订单：完整权限
  'sales.order:create',
  'sales.order:read',
  'sales.order:update',
  'sales.order:delete',
  'sales.order:audit',
  'sales.order:close',
  'sales.order:void',
  'sales.order:print',
  'sales.order:export',
  'sales.order:batch_print',
  // 销售发货单：完整权限
  'sales.delivery:create',
  'sales.delivery:read',
  'sales.delivery:update',
  'sales.delivery:delete',
  'sales.delivery:audit',
  'sales.delivery:void',
  'sales.delivery:print',
  'sales.delivery:export',
  'sales.delivery:batch_print',
  // 销售对账单：完整权限
  'sales.reconciliation:create',
  'sales.reconciliation:read',
  'sales.reconciliation:update',
  'sales.reconciliation:delete',
  'sales.reconciliation:confirm',
  'sales.reconciliation:unconfirm',
  'sales.reconciliation:audit',
  'sales.reconciliation:void',
  // 销售报价单：完整权限
  'sales.quotation:create',
  'sales.quotation:read',
  'sales.quotation:update',
  'sales.quotation:delete',
  'sales.quotation:audit',
  'sales.quotation:void',
  // 客户：完整权限
  'base.customer:create',
  'base.customer:read',
  'base.customer:update',
  'base.customer:delete',
  // 地址：客户抽屉内维护收发货/办公地址
  'base.party_address:create',
  'base.party_address:read',
  'base.party_address:update',
  'base.party_address:delete',
  // 履约需求单：完整权限
  'mfg.demand:create',
  'mfg.demand:read',
  'mfg.demand:update',
  'mfg.demand:delete',
  'mfg.demand:confirm',
  'mfg.demand:close',
  'mfg.demand:void',
  // 物料：只读
  'base.material:read',
  // 库存分录：只读（库存余额视图复用同一码）
  'inv.stock_entry:read',
  // 仓库：只读
  'base.warehouse:read',
  // 会计科目：只读
  'base.account:read',
  // 币种：只读
  'base.currency:read',
  // 计量单位：只读
  'base.unit:read',
]

/**
 * 内置销售业务员角色（sales）的菜单白名单（ADR 2026-08-01 角色菜单白名单）。
 * 与 SALES_ROLE_PERMISSIONS 对应的销售链导航入口；admin 不种子（空 = 不限制）。
 * 仅随初始化完成动作种子（幂等）；老环境不写行，内置角色菜单维持全可见。
 */
export const SALES_ROLE_MENUS: ReadonlyArray<string> = [
  // 工作台：着陆页
  'menu.dashboard.home',
  // 销售管理·交易：销售链
  'menu.sales.quotations',
  'menu.sales.orders',
  'menu.sales.deliveries',
  'menu.sales.reconciliations',
  // 库存管理：库存只读视图
  'menu.inv.balance',
  'menu.inv.stock-entries',
  // 生产管理·计划：履约需求单
  'menu.mfg.demands',
  // 基础数据：客户完整 + 主数据只读
  'menu.base.customers',
  'menu.base.materials',
  'menu.base.warehouses',
  'menu.base.accounts',
  'menu.base.currencies',
  'menu.base.units',
]

/**
 * 预置内置角色（幂等；ADR 2026-07-29 由迁移种子改归 setup 完成动作）：
 * - admin：全域通配 `*` 授权，新权限点自动覆盖；菜单白名单恒空（不限制）；
 * - sales：销售业务员，逐码授权（SALES_ROLE_PERMISSIONS）+ 菜单白名单（SALES_ROLE_MENUS）。
 * 授权仅补 builtin 角色行，界面创建的同名普通角色不被接管。
 */
async function seedBuiltinRoles(trx: DbHandle): Promise<void> {
  try {
    await sql`
      INSERT INTO sys_role (code, name, enabled, builtin)
      SELECT 'admin', '管理员', true, true
      WHERE NOT EXISTS (SELECT 1 FROM sys_role WHERE code = 'admin')
    `.execute(trx)
    await sql`
      INSERT INTO sys_role_permission (role_id, permission)
      SELECT r.id, '*'
      FROM sys_role r
      WHERE r.code = 'admin' AND r.builtin
        AND NOT EXISTS (
          SELECT 1 FROM sys_role_permission rp WHERE rp.role_id = r.id AND rp.permission = '*'
        )
    `.execute(trx)

    await sql`
      INSERT INTO sys_role (code, name, enabled, builtin)
      SELECT 'sales', '销售业务员', true, true
      WHERE NOT EXISTS (SELECT 1 FROM sys_role WHERE code = 'sales')
    `.execute(trx)
    for (const permission of SALES_ROLE_PERMISSIONS) {
      await sql`
        INSERT INTO sys_role_permission (role_id, permission)
        SELECT r.id, ${permission}
        FROM sys_role r
        WHERE r.code = 'sales' AND r.builtin
          AND NOT EXISTS (
            SELECT 1 FROM sys_role_permission rp
            WHERE rp.role_id = r.id AND rp.permission = ${permission}
          )
      `.execute(trx)
    }
    for (const menuCode of SALES_ROLE_MENUS) {
      await sql`
        INSERT INTO sys_role_menu (role_id, menu_code)
        SELECT r.id, ${menuCode}
        FROM sys_role r
        WHERE r.code = 'sales' AND r.builtin
          AND NOT EXISTS (
            SELECT 1 FROM sys_role_menu rm
            WHERE rm.role_id = r.id AND rm.menu_code = ${menuCode}
          )
      `.execute(trx)
    }
  } catch (err) {
    throw new ApiError('internal', '预置内置角色失败', { cause: err })
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: string; cause?: { code?: string } }
  return e.code === '23505' || e.cause?.code === '23505'
}
