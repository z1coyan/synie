/**
 * 公司默认过账科目（一公司一行四槽）。
 *
 * 授权全由平台承担：路由挂 `guard(资源, 动作)`，本服务只收 Permit——
 * 列表 `listAuthorized`、单条 `loadAuthorized`（不命中一律 not_found）、
 * 创建 `assertCompanyWritable`。动作码沿用共享前缀 `sales.setting` 的 read/update，
 * 创建端点按现状由 update 门控（不新增权限码）。
 */
import type { ListQuery } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { withTx, type DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import {
  auditCreated,
  auditDiff,
  writeAudit,
} from '~/platform/audit/write.ts'
import { auditFieldsOf } from '~/platform/audit/spec.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { ResourceMeta } from '~/platform/meta/types.ts'
import { compileRowFilter } from '~/db/authz-sql.ts'
import { mapWriteError } from '~/db/dberr.ts'
import { ident } from '~/db/ident.ts'
import { listAuthorized } from '~/db/list.ts'
import { assertCompanyWritable, loadAuthorized } from '~/db/load.ts'

export interface CompanyAccountDefault {
  id: string
  companyId: string
  deliveryDebitAccountId: string | null
  deliveryCreditAccountId: string | null
  receiptDebitAccountId: string | null
  receiptCreditAccountId: string | null
  insertedAt: Date
  updatedAt: Date
}

export const DEFAULT_RESOURCE = 'salCompanyAccountDefaults'

const TABLE = 'sal_company_account_default'

/** 列表与单条共用同一份投影（alias 与 source 逐字一致） */
const DEFAULT_SOURCE = sql` FROM sal_company_account_default`
const DEFAULT_SELECT = sql`SELECT id,company_id,delivery_debit_account_id,delivery_credit_account_id,
receipt_debit_account_id,receipt_credit_account_id,inserted_at,updated_at`

const AUDIT = auditFieldsOf(companyAccountDefaultMeta())

export function companyAccountDefaultMeta(): ResourceMeta {
  const companyResource = 'basCompanies'
  const accountResource = 'basAccounts'
  const nameField = 'name'
  return {
    name: DEFAULT_RESOURCE,
    classification: { presentation: 'none', interactive: false, note: '公司科目默认只读投影 / 嵌入设置' },
    permissionPrefix: 'sales.setting',
    permissionLabel: '供应链设置',
    table: 'sal_company_account_default',
    authz: { kind: 'company' },
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
        filterable: true,
        ref: { resource: accountResource, relation: 'deliveryDebitAccount', labelField: nameField },
      },
      {
        name: 'delivery_credit_account_id',
        apiName: 'deliveryCreditAccountId',
        dbColumn: 'delivery_credit_account_id',
        type: 'fk',
        label: '销售发货默认贷方科目',
        filterable: true,
        ref: { resource: accountResource, relation: 'deliveryCreditAccount', labelField: nameField },
      },
      {
        name: 'receipt_debit_account_id',
        apiName: 'receiptDebitAccountId',
        dbColumn: 'receipt_debit_account_id',
        type: 'fk',
        label: '采购入库默认借方科目',
        filterable: true,
        ref: { resource: accountResource, relation: 'receiptDebitAccount', labelField: nameField },
      },
      {
        name: 'receipt_credit_account_id',
        apiName: 'receiptCreditAccountId',
        dbColumn: 'receipt_credit_account_id',
        type: 'fk',
        label: '采购入库默认贷方科目(未开票应付)',
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

export function createCompanyAccountDefaultService(db: Kysely<Database>, registry: Registry) {
  const target = registry.authzTarget(DEFAULT_RESOURCE)

  async function get(permit: Permit, id: string): Promise<CompanyAccountDefault> {
    const row = await loadAuthorized({
      db,
      permit,
      target,
      table: TABLE,
      id,
      notFoundMessage: '公司默认过账科目不存在',
    })
    return mapRow(row as never)
  }

  async function getByCompany(permit: Permit, companyId: string): Promise<CompanyAccountDefault> {
    // 按公司取单行：行过滤即公司边界，未授权公司与「尚未配置」同样落到空壳（不泄露存在性）
    const where = compileRowFilter(permit, target, TABLE)
    const found = await sql<Record<string, unknown>>`
      ${DEFAULT_SELECT}${DEFAULT_SOURCE}
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
    return mapRow(row as never)
  }

  async function list(permit: Permit, query: Partial<ListQuery>) {
    return listAuthorized({
      db,
      permit,
      target,
      alias: TABLE,
      resource: companyAccountDefaultMeta(),
      source: DEFAULT_SOURCE,
      select: DEFAULT_SELECT,
      defaultOrder: sql`"company_id" ASC, "id" ASC`,
      query,
      mapRow: (r) => mapRow(r as never),
    })
  }

  async function create(
    permit: Permit,
    input: {
      companyId: string
      deliveryDebitAccountId?: string | null
      deliveryCreditAccountId?: string | null
      receiptDebitAccountId?: string | null
      receiptCreditAccountId?: string | null
    },
  ): Promise<CompanyAccountDefault> {
    // 入参校验（400）先于公司边界（404）
    if (!input.companyId) {
      throw ApiError.validation('公司默认过账科目参数不合法', { companyId: ['必填'] })
    }
    assertCompanyWritable(permit, input.companyId)
    return withTx(db, async (trx) => {
      await validateCompany(trx, input.companyId)
      const item: Omit<CompanyAccountDefault, 'id' | 'insertedAt' | 'updatedAt'> & {
        id?: string
      } = {
        companyId: input.companyId,
        deliveryDebitAccountId: input.deliveryDebitAccountId ?? null,
        deliveryCreditAccountId: input.deliveryCreditAccountId ?? null,
        receiptDebitAccountId: input.receiptDebitAccountId ?? null,
        receiptCreditAccountId: input.receiptCreditAccountId ?? null,
      }
      await validateAccounts(trx, item as CompanyAccountDefault)
      try {
        const row = await trx
          .insertInto('sal_company_account_default')
          .values({
            company_id: item.companyId,
            delivery_debit_account_id: item.deliveryDebitAccountId,
            delivery_credit_account_id: item.deliveryCreditAccountId,
            receipt_debit_account_id: item.receiptDebitAccountId,
            receipt_credit_account_id: item.receiptCreditAccountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow()
        const created = mapRow(row)
        await writeAudit(trx, permit.actor, {
          resource: 'sal_company_account_default',
          recordId: created.id,
          recordLabel: created.companyId,
          companyId: created.companyId,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(snap(created), AUDIT),
        })
        return created
      } catch (err) {
        throw mapWriteError(err, '创建公司默认过账科目失败', [
          { code: '23505', message: '该公司已有默认过账科目配置' },
        ])
      }
    })
  }

  async function update(
    permit: Permit,
    id: string,
    input: {
      deliveryDebitAccountId?: string | null
      deliveryDebitPresent?: boolean
      deliveryCreditAccountId?: string | null
      deliveryCreditPresent?: boolean
      receiptDebitAccountId?: string | null
      receiptDebitPresent?: boolean
      receiptCreditAccountId?: string | null
      receiptCreditPresent?: boolean
    },
  ): Promise<CompanyAccountDefault> {
    return withTx(db, async (trx) => {
      // 锁行 + 公司闸折叠为一次授权取行
      const locked = await loadAuthorized({
        db: trx,
        permit,
        target,
        table: TABLE,
        id,
        forUpdate: true,
        notFoundMessage: '公司默认过账科目不存在',
      })
      const before = mapRow(locked as never)
      const after: CompanyAccountDefault = {
        ...before,
        deliveryDebitAccountId: input.deliveryDebitPresent
          ? (input.deliveryDebitAccountId ?? null)
          : before.deliveryDebitAccountId,
        deliveryCreditAccountId: input.deliveryCreditPresent
          ? (input.deliveryCreditAccountId ?? null)
          : before.deliveryCreditAccountId,
        receiptDebitAccountId: input.receiptDebitPresent
          ? (input.receiptDebitAccountId ?? null)
          : before.receiptDebitAccountId,
        receiptCreditAccountId: input.receiptCreditPresent
          ? (input.receiptCreditAccountId ?? null)
          : before.receiptCreditAccountId,
      }
      await validateAccounts(trx, after)
      const changes = auditDiff(snap(before), snap(after), AUDIT)
      if (Object.keys(changes).length === 0) return before
      try {
        const row = await trx
          .updateTable('sal_company_account_default')
          .set({
            delivery_debit_account_id: after.deliveryDebitAccountId,
            delivery_credit_account_id: after.deliveryCreditAccountId,
            receipt_debit_account_id: after.receiptDebitAccountId,
            receipt_credit_account_id: after.receiptCreditAccountId,
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow()
        const updated = mapRow(row)
        await writeAudit(trx, permit.actor, {
          resource: 'sal_company_account_default',
          recordId: updated.id,
          recordLabel: updated.companyId,
          companyId: updated.companyId,
          actionType: 'update',
          actionName: 'update',
          changes,
        })
        return updated
      } catch (err) {
        throw mapWriteError(err, '更新公司默认过账科目失败', [
          { code: '23503', message: '公司默认过账科目已被业务数据引用' },
        ])
      }
    })
  }

  return { get, getByCompany, list, create, update }
}

export type CompanyAccountDefaultService = ReturnType<typeof createCompanyAccountDefaultService>

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

async function validateAccounts(
  trx: DbHandle,
  item: {
    companyId: string
    deliveryDebitAccountId: string | null
    deliveryCreditAccountId: string | null
    receiptDebitAccountId: string | null
    receiptCreditAccountId: string | null
  },
) {
  const rules: Array<{ field: string; id: string | null; role: string }> = [
    { field: 'deliveryDebitAccountId', id: item.deliveryDebitAccountId, role: 'unbilled_receivable' },
    { field: 'deliveryCreditAccountId', id: item.deliveryCreditAccountId, role: '' },
    { field: 'receiptDebitAccountId', id: item.receiptDebitAccountId, role: '' },
    { field: 'receiptCreditAccountId', id: item.receiptCreditAccountId, role: 'unbilled_payable' },
  ]
  for (const rule of rules) {
    if (!rule.id) continue
    const acc = await trx
      .selectFrom('bas_account')
      .select(['company_id', 'is_group', 'active', 'role'])
      .where('id', '=', rule.id)
      .executeTakeFirst()
    if (!acc) {
      throw ApiError.validation('公司默认过账科目参数不合法', { [rule.field]: ['科目不存在'] })
    }
    if (acc.company_id !== item.companyId) {
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

function mapRow(row: {
  id: string
  company_id: string
  delivery_debit_account_id: string | null
  delivery_credit_account_id: string | null
  receipt_debit_account_id: string | null
  receipt_credit_account_id: string | null
  inserted_at: Date | string
  updated_at: Date | string
}): CompanyAccountDefault {
  return {
    id: row.id,
    companyId: row.company_id,
    deliveryDebitAccountId: row.delivery_debit_account_id,
    deliveryCreditAccountId: row.delivery_credit_account_id,
    receiptDebitAccountId: row.receipt_debit_account_id,
    receiptCreditAccountId: row.receipt_credit_account_id,
    insertedAt: row.inserted_at instanceof Date ? row.inserted_at : new Date(row.inserted_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
  }
}

function snap(item: CompanyAccountDefault): Record<string, unknown> {
  return {
    company_id: item.companyId,
    delivery_debit_account_id: item.deliveryDebitAccountId,
    delivery_credit_account_id: item.deliveryCreditAccountId,
    receipt_debit_account_id: item.receiptDebitAccountId,
    receipt_credit_account_id: item.receiptCreditAccountId,
  }
}
