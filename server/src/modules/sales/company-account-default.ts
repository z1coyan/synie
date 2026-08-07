/**
 * 公司默认过账科目（一公司一行四槽）——标准派生服务 + 单公司读端点（手写）。
 *
 * CRUD/审计/授权由 platform/standard 按 meta 派生，本文件只声明领域不变量（钩子）：
 * 公司存在、四槽科目须同公司/叶子/启用/角色相符。
 *
 * 动作词表沿用共享前缀 `sales.setting` 的 read/update（创建端点由 update 门控，
 * 不新增权限码），故标准路由（要求 create/delete/batch 全词表）不适用——
 * 路由按动作弹射保持手写，只有 wire schema/DTO 从 meta 派生。
 * `getByCompany` 是按公司取单行的空壳读端点（非标准词表），同样保留手写。
 */
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { compileRowFilter } from '~/db/authz-sql.ts'
import { ident } from '~/db/ident.ts'
import type { DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { ResourceMeta } from '~/platform/meta/types.ts'
import { mapRow as mapStandardRow, physicalFields } from '~/platform/standard/fields.ts'
import { createStandardService, type StandardService } from '~/platform/standard/service.ts'

export interface CompanyAccountDefault {
  id: string
  companyId: string
  deliveryDebitAccountId: string | null
  deliveryCreditAccountId: string | null
  receiptDebitAccountId: string | null
  receiptCreditAccountId: string | null
  insertedAt: Date
  updatedAt: Date
  [key: string]: unknown
}

export const DEFAULT_RESOURCE = 'salCompanyAccountDefaults'

const TABLE = 'sal_company_account_default'

export function companyAccountDefaultMeta(): ResourceMeta {
  const companyResource = 'basCompanies'
  const accountResource = 'basAccounts'
  const nameField = 'name'
  return {
    name: DEFAULT_RESOURCE,
    classification: { presentation: 'none', interactive: false, note: '公司科目默认只读投影 / 嵌入设置' },
    permissionPrefix: 'sales.setting',
    permissionLabel: '供应链设置',
    label: '公司默认过账科目',
    table: 'sal_company_account_default',
    authz: { kind: 'company' },
    // 一公司一行：记录标签即公司（审计 record_label 口径）
    lookup: { labelField: 'companyId' },
    fields: [
      {
        name: 'id',
        apiName: 'id',
        dbColumn: 'id',
        type: 'uuid',
        label: 'id',
        readonly: true,
        sortable: true,
      },
      {
        name: 'inserted_at',
        apiName: 'insertedAt',
        dbColumn: 'inserted_at',
        type: 'datetime',
        label: '创建时间',
        readonly: true,
        filterable: true,
        sortable: true,
      },
      {
        name: 'updated_at',
        apiName: 'updatedAt',
        dbColumn: 'updated_at',
        type: 'datetime',
        label: '更新时间',
        readonly: true,
        filterable: true,
        sortable: true,
      },
      {
        name: 'company_id',
        apiName: 'companyId',
        dbColumn: 'company_id',
        type: 'fk',
        label: '公司',
        required: true,
        createOnly: true,
        filterable: true,
        ref: { resource: companyResource, relation: 'company', labelField: nameField },
      },
      {
        name: 'delivery_debit_account_id',
        apiName: 'deliveryDebitAccountId',
        dbColumn: 'delivery_debit_account_id',
        type: 'fk',
        label: '销售发货默认借方科目(未开票应收)',
        nullable: true,
        filterable: true,
        ref: { resource: accountResource, relation: 'deliveryDebitAccount', labelField: nameField },
      },
      {
        name: 'delivery_credit_account_id',
        apiName: 'deliveryCreditAccountId',
        dbColumn: 'delivery_credit_account_id',
        type: 'fk',
        label: '销售发货默认贷方科目',
        nullable: true,
        filterable: true,
        ref: { resource: accountResource, relation: 'deliveryCreditAccount', labelField: nameField },
      },
      {
        name: 'receipt_debit_account_id',
        apiName: 'receiptDebitAccountId',
        dbColumn: 'receipt_debit_account_id',
        type: 'fk',
        label: '采购入库默认借方科目',
        nullable: true,
        filterable: true,
        ref: { resource: accountResource, relation: 'receiptDebitAccount', labelField: nameField },
      },
      {
        name: 'receipt_credit_account_id',
        apiName: 'receiptCreditAccountId',
        dbColumn: 'receipt_credit_account_id',
        type: 'fk',
        label: '采购入库默认贷方科目(未开票应付)',
        nullable: true,
        filterable: true,
        ref: { resource: accountResource, relation: 'receiptCreditAccount', labelField: nameField },
      },
    ],
    // 权限目录复用共享前缀 sales.setting（salSettings 已声明同两码）：此处声明只为
    // 让 guard 有唯一动作事实源，不新增任何权限码；创建端点沿用 update 门控。
    actions: [
      { key: 'read', label: '查看', scope: 'both' },
      { key: 'update', label: '编辑', scope: 'row' },
    ],
    form: {
      exclude: ['id', 'insertedAt', 'updatedAt'],
      fields: { companyId: { required: true, edit: 'createOnly' } },
    },
    audit: { enabled: true },
  }
}

export interface CompanyAccountDefaultService extends StandardService<CompanyAccountDefault> {
  /** 按公司取单行；未配置与公司不可达同样落空壳（不泄露存在性） */
  getByCompany(permit: Permit, companyId: string): Promise<CompanyAccountDefault>
}

export function createCompanyAccountDefaultService(
  db: Kysely<Database>,
  registry: Registry,
): CompanyAccountDefaultService {
  const target = registry.authzTarget(DEFAULT_RESOURCE)
  const standard = createStandardService<CompanyAccountDefault>({
    db,
    registry,
    resource: DEFAULT_RESOURCE,
    notFound: '公司默认过账科目不存在',
    defaultOrder: sql`"company_id" ASC, "id" ASC`,
    writeErrors: [
      { code: '23505', message: '该公司已有默认过账科目配置' },
      { code: '23503', message: '公司默认过账科目已被业务数据引用' },
    ],
    hooks: {
      beforeWrite: async (trx, { action, draft }) => {
        if (action === 'create') await validateCompany(trx, String(draft.companyId))
        await validateAccounts(trx, draft)
      },
    },
  })

  const SELECT = sql`SELECT ${sql.join(physicalFields(standard.meta).map((f) => sql.id(f.dbColumn)))}`

  async function getByCompany(permit: Permit, companyId: string): Promise<CompanyAccountDefault> {
    // 按公司取单行：行过滤即公司边界，未授权公司与「尚未配置」同样落到空壳（不泄露存在性）
    const where = compileRowFilter(permit, target, TABLE)
    const found = await sql<Record<string, unknown>>`
      ${SELECT} FROM ${ident(TABLE)}
      WHERE ${ident(TABLE)}.company_id = ${companyId}::uuid AND ${where}
    `.execute(db)
    const row = found.rows[0]
    // 无配置时返回空壳（对齐 Go GetCompanyAccountDefaults：id 空、科目空、公司保留）
    if (!row) {
      return {
        id: '',
        companyId,
        deliveryDebitAccountId: null,
        deliveryCreditAccountId: null,
        receiptDebitAccountId: null,
        receiptCreditAccountId: null,
        insertedAt: new Date(0),
        updatedAt: new Date(0),
      }
    }
    return mapStandardRow(standard.meta, row) as CompanyAccountDefault
  }

  return { ...standard, getByCompany }
}

async function validateCompany(trx: DbHandle, companyId: string) {
  const row = await trx
    .selectFrom('bas_company')
    .select('id')
    .where('id', '=', companyId)
    .executeTakeFirst()
  if (!row) {
    throw ApiError.validation('公司默认过账科目参数不合法', { companyId: ['公司不存在'] })
  }
}

/** 四槽科目不变量：须同公司、叶子、启用；发货借/入库贷两槽还须角色相符 */
async function validateAccounts(trx: DbHandle, draft: Record<string, unknown>) {
  const companyId = String(draft.companyId)
  const rules: ReadonlyArray<{ field: string; role: string }> = [
    { field: 'deliveryDebitAccountId', role: 'unbilled_receivable' },
    { field: 'deliveryCreditAccountId', role: '' },
    { field: 'receiptDebitAccountId', role: '' },
    { field: 'receiptCreditAccountId', role: 'unbilled_payable' },
  ]
  for (const rule of rules) {
    const id = draft[rule.field]
    if (typeof id !== 'string' || !id) continue
    const acc = await trx
      .selectFrom('bas_account')
      .select(['company_id', 'is_group', 'active', 'role'])
      .where('id', '=', id)
      .executeTakeFirst()
    if (!acc) {
      throw ApiError.validation('公司默认过账科目参数不合法', { [rule.field]: ['科目不存在'] })
    }
    if (acc.company_id !== companyId) {
      throw ApiError.validation('公司默认过账科目参数不合法', {
        [rule.field]: ['科目不属于本公司'],
      })
    }
    if (acc.is_group) {
      throw ApiError.validation('公司默认过账科目参数不合法', {
        [rule.field]: ['不能选择汇总科目'],
      })
    }
    if (!acc.active) {
      throw ApiError.validation('公司默认过账科目参数不合法', { [rule.field]: ['科目已停用'] })
    }
    if (rule.role && (!acc.role || acc.role.toLowerCase() !== rule.role)) {
      throw ApiError.validation('公司默认过账科目参数不合法', {
        [rule.field]: ['科目角色不符合默认过账要求'],
      })
    }
  }
}
