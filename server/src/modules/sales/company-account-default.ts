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
import {
  canAccessCompany,
  hasPermission,
  type Actor,
} from '~/platform/authz/actor.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { ResourceMeta } from '~/platform/meta/types.ts'
import { mapWriteError } from '../base/dberr.ts'
import { companyScopeWhere, listFromSource } from '../base/list.ts'

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

const AUDIT = [
  'company_id',
  'delivery_debit_account_id',
  'delivery_credit_account_id',
  'receipt_debit_account_id',
  'receipt_credit_account_id',
] as const

export function companyAccountDefaultMeta(): ResourceMeta {
  const companyResource = 'basCompanies'
  const accountResource = 'basAccounts'
  const nameField = 'name'
  return {
    name: 'salCompanyAccountDefaults',
    permissionPrefix: 'sales.setting',
    permissionLabel: '供应链设置',
    table: 'sal_company_account_default',
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
        name: 'company_id',
        apiName: 'companyId',
        dbColumn: 'company_id',
        type: 'fk',
        label: '公司',
        required: true,
        filterable: true,
        sortable: true,
        ref: { resource: companyResource, relation: 'company', labelField: nameField },
      },
      {
        name: 'delivery_debit_account_id',
        apiName: 'deliveryDebitAccountId',
        dbColumn: 'delivery_debit_account_id',
        type: 'fk',
        label: '发货借方科目',
        filterable: true,
        ref: { resource: accountResource, relation: 'deliveryDebitAccount', labelField: nameField },
      },
      {
        name: 'delivery_credit_account_id',
        apiName: 'deliveryCreditAccountId',
        dbColumn: 'delivery_credit_account_id',
        type: 'fk',
        label: '发货贷方科目',
        filterable: true,
        ref: { resource: accountResource, relation: 'deliveryCreditAccount', labelField: nameField },
      },
      {
        name: 'receipt_debit_account_id',
        apiName: 'receiptDebitAccountId',
        dbColumn: 'receipt_debit_account_id',
        type: 'fk',
        label: '入库借方科目',
        filterable: true,
        ref: { resource: accountResource, relation: 'receiptDebitAccount', labelField: nameField },
      },
      {
        name: 'receipt_credit_account_id',
        apiName: 'receiptCreditAccountId',
        dbColumn: 'receipt_credit_account_id',
        type: 'fk',
        label: '入库贷方科目',
        filterable: true,
        ref: { resource: accountResource, relation: 'receiptCreditAccount', labelField: nameField },
      },
      {
        name: 'inserted_at',
        apiName: 'insertedAt',
        dbColumn: 'inserted_at',
        type: 'datetime',
        label: '创建时间',
        readonly: true,
        sortable: true,
      },
      {
        name: 'updated_at',
        apiName: 'updatedAt',
        dbColumn: 'updated_at',
        type: 'datetime',
        label: '更新时间',
        readonly: true,
        sortable: true,
      },
    ],
    actions: [
      { key: 'read', label: '查看', scope: 'both' },
      { key: 'update', label: '编辑', scope: 'row' },
    ],
    audit: { enabled: true },
  }
}

export function createCompanyAccountDefaultService(db: Kysely<Database>) {
  async function get(actor: Actor, id: string): Promise<CompanyAccountDefault> {
    requireRead(actor)
    const row = await db
      .selectFrom('sal_company_account_default')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    if (!row || !canAccessCompany(actor, row.company_id)) {
      throw new ApiError('not_found', '公司默认过账科目不存在')
    }
    return mapRow(row)
  }

  async function getByCompany(actor: Actor, companyId: string): Promise<CompanyAccountDefault> {
    requireRead(actor)
    if (!canAccessCompany(actor, companyId)) {
      throw new ApiError('not_found', '公司默认过账科目不存在')
    }
    const row = await db
      .selectFrom('sal_company_account_default')
      .selectAll()
      .where('company_id', '=', companyId)
      .executeTakeFirst()
    if (!row) throw new ApiError('not_found', '公司默认过账科目不存在')
    return mapRow(row)
  }

  async function list(actor: Actor, query: Partial<ListQuery>) {
    requireRead(actor)
    const scope = companyScopeWhere(actor)
    if (scope.empty) return { count: 0, results: [] as CompanyAccountDefault[] }
    return listFromSource({
      db,
      resource: companyAccountDefaultMeta(),
      source: sql` FROM sal_company_account_default`,
      select: sql`SELECT id,company_id,delivery_debit_account_id,delivery_credit_account_id,
receipt_debit_account_id,receipt_credit_account_id,inserted_at,updated_at`,
      defaultOrder: sql`"company_id" ASC, "id" ASC`,
      query,
      extraWhere: scope.where,
      mapRow: (r) => mapRow(r as never),
    })
  }

  async function create(
    actor: Actor,
    input: {
      companyId: string
      deliveryDebitAccountId?: string | null
      deliveryCreditAccountId?: string | null
      receiptDebitAccountId?: string | null
      receiptCreditAccountId?: string | null
    },
  ): Promise<CompanyAccountDefault> {
    requireUpdate(actor)
    if (!input.companyId) {
      throw ApiError.validation('公司默认过账科目参数不合法', { companyId: ['必填'] })
    }
    if (!canAccessCompany(actor, input.companyId)) {
      throw new ApiError('not_found', '公司默认过账科目不存在')
    }
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
        await writeAudit(trx, actor, {
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
    actor: Actor,
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
    requireUpdate(actor)
    return withTx(db, async (trx) => {
      const locked = await trx
        .selectFrom('sal_company_account_default')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked || !canAccessCompany(actor, locked.company_id)) {
        throw new ApiError('not_found', '公司默认过账科目不存在')
      }
      const before = mapRow(locked)
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
        await writeAudit(trx, actor, {
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

function requireRead(actor: Actor) {
  if (!hasPermission(actor, 'sales.setting:read')) {
    throw new ApiError('forbidden', '无权限维护公司默认过账科目')
  }
}

function requireUpdate(actor: Actor) {
  if (!hasPermission(actor, 'sales.setting:update')) {
    throw new ApiError('forbidden', '无权限维护公司默认过账科目')
  }
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
