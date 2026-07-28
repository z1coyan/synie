import type { ListQuery } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { withTx, type DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import {
  auditCreated,
  auditDestroyed,
  auditDiff,
  writeAudit,
} from '~/platform/audit/write.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import { canAccessCompany } from '~/platform/authz/actor.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { mapWriteError } from '~/db/dberr.ts'
import { companyScopeWhere, listFromSource } from '~/db/list.ts'
import { seedCompanyDefaultWarehouses } from '../base/warehouse-seed.ts'
import { runeLen, toDate } from './helpers.ts'
import { warehouseResourceMeta } from './meta.ts'

export interface Warehouse {
  id: string
  name: string
  isLeaf: boolean
  active: boolean
  isOutsourced: boolean
  partyType: string | null
  partyId: string | null
  allowNegative: boolean
  insertedAt: Date
  updatedAt: Date
  companyId: string
  parentId: string | null
  accountId: string | null
  company: { id: string; name: string; code?: string | null }
  parent: { id: string; name: string } | null
  account: { id: string; name: string; code?: string | null } | null
  hasChildren: boolean
}

const AUDIT = [
  'name',
  'is_leaf',
  'active',
  'is_outsourced',
  'party_type',
  'party_id',
  'allow_negative',
  'company_id',
  'parent_id',
  'account_id',
] as const

const META = warehouseResourceMeta()

const SOURCE = sql`
  FROM (
    SELECT w.id,w.name,w.is_leaf,w.active,w.is_outsourced,w.party_type,w.party_id,
           w.allow_negative,w.inserted_at,w.updated_at,w.company_id,w.parent_id,w.account_id,
           company.code AS company_code,company.name AS company_name,
           parent.name AS parent_name,account.code AS account_code,account.name AS account_name,
           EXISTS(SELECT 1 FROM inv_warehouse child WHERE child.parent_id=w.id) AS has_children
    FROM inv_warehouse w
    JOIN bas_company company ON company.id=w.company_id
    LEFT JOIN inv_warehouse parent ON parent.id=w.parent_id
    LEFT JOIN bas_account account ON account.id=w.account_id
  ) warehouse
`

export function createWarehouseService(db: Kysely<Database>) {
  async function get(actor: Actor, id: string): Promise<Warehouse> {
    const scope = companyScopeWhere(actor, 'company_id')
    if (scope.empty) throw new ApiError('not_found', '仓库不存在')
    const whereExtra = scope.where ? sql` AND ${scope.where}` : sql``
    const rows = await sql<Record<string, unknown>>`
      SELECT id,name,is_leaf,active,is_outsourced,party_type,party_id,
             allow_negative,inserted_at,updated_at,company_id,parent_id,account_id,
             company_code,company_name,parent_name,account_code,account_name,has_children
      ${SOURCE} WHERE id = ${id}::uuid ${whereExtra}
    `.execute(db)
    if (rows.rows.length === 0) throw new ApiError('not_found', '仓库不存在')
    return mapRow(rows.rows[0]!)
  }

  async function list(actor: Actor, query: Partial<ListQuery>) {
    const scope = companyScopeWhere(actor, 'company_id')
    if (scope.empty) return { count: 0, results: [] as Warehouse[] }
    return listFromSource({
      db,
      resource: META,
      source: SOURCE,
      select: sql`SELECT id,name,is_leaf,active,is_outsourced,party_type,party_id,
        allow_negative,inserted_at,updated_at,company_id,parent_id,account_id,
        company_code,company_name,parent_name,account_code,account_name,has_children`,
      defaultOrder: sql`"name" ASC, "id" ASC`,
      query,
      extraWhere: scope.where,
      mapRow,
    })
  }

  /** 指定协作方的外协仓列表（对齐 Go ListOutsourced） */
  async function listOutsourced(
    actor: Actor,
    partyType: string,
    partyId: string,
    query: Partial<ListQuery>,
  ) {
    const normalized = partyType.trim().toLowerCase()
    if (normalized !== 'supplier' && normalized !== 'company') {
      throw ApiError.validation('外协仓查询参数不合法', {
        partyType: ['只能为 SUPPLIER 或 COMPANY'],
      })
    }
    if (!partyId) {
      throw ApiError.validation('外协仓查询参数不合法', {
        partyId: ['不能为空'],
      })
    }
    const scope = companyScopeWhere(actor, 'company_id')
    if (scope.empty) return { count: 0, results: [] as Warehouse[] }
    const partyWhere = sql`is_outsourced = true AND party_type = ${normalized} AND party_id = ${partyId}::uuid`
    const extraWhere = scope.where ? sql`${scope.where} AND ${partyWhere}` : partyWhere
    return listFromSource({
      db,
      resource: META,
      source: SOURCE,
      select: sql`SELECT id,name,is_leaf,active,is_outsourced,party_type,party_id,
        allow_negative,inserted_at,updated_at,company_id,parent_id,account_id,
        company_code,company_name,parent_name,account_code,account_name,has_children`,
      defaultOrder: sql`"name" ASC, "id" ASC`,
      query,
      extraWhere,
      mapRow,
    })
  }

  /** 幂等初始化公司默认三仓（对齐 Go SeedDefaults） */
  async function seedDefaults(actor: Actor, companyId: string): Promise<number> {
    if (!canAccessCompany(actor, companyId)) {
      throw new ApiError('forbidden', '无权在该公司下操作数据')
    }
    return withTx(db, async (trx) => {
      const company = await trx
        .selectFrom('bas_company')
        .select('code')
        .where('id', '=', companyId)
        .executeTakeFirst()
      if (!company) {
        throw ApiError.validation('初始化默认仓库参数不合法', {
          companyId: ['公司不存在'],
        })
      }
      return seedCompanyDefaultWarehouses(trx, actor, companyId, company.code)
    })
  }

  async function create(
    actor: Actor,
    input: {
      name: string
      isLeaf?: boolean
      active?: boolean
      isOutsourced?: boolean
      partyType?: string | null
      partyId?: string | null
      allowNegative?: boolean
      companyId: string
      parentId?: string | null
      accountId?: string | null
    },
  ): Promise<Warehouse> {
    const normalized = normalizeCreate(input)
    if (!canAccessCompany(actor, normalized.companyId)) {
      throw new ApiError('forbidden', '无权在该公司下操作数据')
    }
    return withTx(db, async (trx) => {
      await lockTree(trx, normalized.companyId)
      await validateRelations(trx, null, normalized)
      try {
        const row = await trx
          .insertInto('inv_warehouse')
          .values({
            name: normalized.name,
            is_leaf: normalized.isLeaf,
            active: normalized.active,
            is_outsourced: normalized.isOutsourced,
            allow_negative: normalized.allowNegative,
            company_id: normalized.companyId,
            parent_id: normalized.parentId,
            account_id: normalized.accountId,
            party_type: normalized.partyType ? normalized.partyType.toLowerCase() : null,
            party_id: normalized.partyId,
          })
          .returningAll()
          .executeTakeFirstOrThrow()
        const item = await getInTx(trx, row.id)
        await writeAudit(trx, actor, {
          resource: 'inv_warehouse',
          recordId: item.id,
          recordLabel: item.name,
          companyId: item.companyId,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(snap(item), AUDIT),
        })
        return item
      } catch (err) {
        throw mapWriteError(err, '创建仓库失败', [
          {
            code: '23505',
            constraint: 'inv_warehouse_unique_name_per_company_index',
            message: '仓库名称已存在',
          },
          { code: '23505', message: '仓库唯一字段已存在' },
        ])
      }
    })
  }

  async function update(
    actor: Actor,
    id: string,
    input: {
      name?: string
      isLeaf?: boolean
      active?: boolean
      isOutsourced?: boolean
      partyType?: string | null
      partyTypePresent?: boolean
      partyId?: string | null
      partyIdPresent?: boolean
      allowNegative?: boolean
      parentId?: string | null
      parentIdPresent?: boolean
      accountId?: string | null
      accountIdPresent?: boolean
    },
  ): Promise<Warehouse> {
    return withTx(db, async (trx) => {
      const locked = await trx
        .selectFrom('inv_warehouse')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked || !canAccessCompany(actor, locked.company_id)) {
        throw new ApiError('not_found', '仓库不存在')
      }
      await lockTree(trx, locked.company_id)
      const before = await getInTx(trx, id)
      const draft = {
        name: input.name ?? before.name,
        isLeaf: input.isLeaf ?? before.isLeaf,
        active: input.active ?? before.active,
        isOutsourced: input.isOutsourced ?? before.isOutsourced,
        partyType: input.partyTypePresent ? (input.partyType ?? null) : before.partyType,
        partyId: input.partyIdPresent ? (input.partyId ?? null) : before.partyId,
        allowNegative: input.allowNegative ?? before.allowNegative,
        companyId: before.companyId,
        parentId: input.parentIdPresent ? (input.parentId ?? null) : before.parentId,
        accountId: input.accountIdPresent ? (input.accountId ?? null) : before.accountId,
      }
      const normalized = normalizeCreate(draft)
      await validateRelations(trx, id, normalized)
      if (normalized.isLeaf !== locked.is_leaf) {
        if (normalized.isLeaf) {
          const child = await trx
            .selectFrom('inv_warehouse')
            .select('id')
            .where('parent_id', '=', id)
            .executeTakeFirst()
          if (child) {
            throw ApiError.validation('仓库参数不合法', {
              isLeaf: ['存在下级仓库,不能改为叶子仓库'],
            })
          }
        } else {
          const stock = await trx
            .selectFrom('inv_stock_entry')
            .select('id')
            .where('warehouse_id', '=', id)
            .executeTakeFirst()
          if (stock) {
            throw ApiError.validation('仓库参数不合法', {
              isLeaf: ['仓库已有库存分录,不能改为非叶子'],
            })
          }
        }
      }
      const after = { ...before, ...normalized }
      const changes = auditDiff(snap(before), snap(after), AUDIT)
      if (Object.keys(changes).length === 0) return before
      try {
        await trx
          .updateTable('inv_warehouse')
          .set({
            name: normalized.name,
            is_leaf: normalized.isLeaf,
            active: normalized.active,
            is_outsourced: normalized.isOutsourced,
            allow_negative: normalized.allowNegative,
            parent_id: normalized.parentId,
            account_id: normalized.accountId,
            party_type: normalized.partyType ? normalized.partyType.toLowerCase() : null,
            party_id: normalized.partyId,
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', id)
          .execute()
      } catch (err) {
        throw mapWriteError(err, '更新仓库失败', [
          {
            code: '23505',
            constraint: 'inv_warehouse_unique_name_per_company_index',
            message: '仓库名称已存在',
          },
        ])
      }
      const updated = await getInTx(trx, id)
      await writeAudit(trx, actor, {
        resource: 'inv_warehouse',
        recordId: id,
        recordLabel: updated.name,
        companyId: updated.companyId,
        actionType: 'update',
        actionName: 'update',
        changes,
      })
      return updated
    })
  }

  async function remove(actor: Actor, id: string): Promise<void> {
    await withTx(db, async (trx) => {
      const locked = await trx
        .selectFrom('inv_warehouse')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked || !canAccessCompany(actor, locked.company_id)) {
        throw new ApiError('not_found', '仓库不存在')
      }
      await lockTree(trx, locked.company_id)
      const child = await trx
        .selectFrom('inv_warehouse')
        .select('id')
        .where('parent_id', '=', id)
        .executeTakeFirst()
      if (child) throw new ApiError('conflict', '存在下级仓库,不能删除')
      const stock = await trx
        .selectFrom('inv_stock_entry')
        .select('id')
        .where('warehouse_id', '=', id)
        .executeTakeFirst()
      if (stock) throw new ApiError('conflict', '仓库已有库存分录,不能删除')
      const item = await getInTx(trx, id)
      await trx.deleteFrom('inv_warehouse').where('id', '=', id).execute()
      await writeAudit(trx, actor, {
        resource: 'inv_warehouse',
        recordId: id,
        recordLabel: item.name,
        companyId: item.companyId,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(snap(item), AUDIT),
      })
    })
  }

  return { get, list, listOutsourced, seedDefaults, create, update, remove }
}

export type WarehouseService = ReturnType<typeof createWarehouseService>

async function getInTx(db: DbHandle, id: string): Promise<Warehouse> {
  const rows = await sql<Record<string, unknown>>`
    SELECT id,name,is_leaf,active,is_outsourced,party_type,party_id,
           allow_negative,inserted_at,updated_at,company_id,parent_id,account_id,
           company_code,company_name,parent_name,account_code,account_name,has_children
    ${SOURCE} WHERE id = ${id}::uuid
  `.execute(db)
  if (rows.rows.length === 0) throw new ApiError('not_found', '仓库不存在')
  return mapRow(rows.rows[0]!)
}

function mapRow(r: Record<string, unknown>): Warehouse {
  const companyId = String(r.company_id)
  const parentId = r.parent_id == null ? null : String(r.parent_id)
  const accountId = r.account_id == null ? null : String(r.account_id)
  const partyType = r.party_type == null ? null : String(r.party_type).toUpperCase()
  return {
    id: String(r.id),
    name: String(r.name),
    isLeaf: Boolean(r.is_leaf),
    active: Boolean(r.active),
    isOutsourced: Boolean(r.is_outsourced),
    partyType,
    partyId: r.party_id == null ? null : String(r.party_id),
    allowNegative: Boolean(r.allow_negative),
    insertedAt: toDate(r.inserted_at),
    updatedAt: toDate(r.updated_at),
    companyId,
    parentId,
    accountId,
    company: {
      id: companyId,
      name: String(r.company_name),
      code: r.company_code == null ? null : String(r.company_code),
    },
    parent: parentId && r.parent_name != null ? { id: parentId, name: String(r.parent_name) } : null,
    account:
      accountId && r.account_name != null
        ? {
            id: accountId,
            name: String(r.account_name),
            code: r.account_code == null ? null : String(r.account_code),
          }
        : null,
    hasChildren: Boolean(r.has_children),
  }
}

function snap(item: Warehouse): Record<string, unknown> {
  return {
    name: item.name,
    is_leaf: item.isLeaf,
    active: item.active,
    is_outsourced: item.isOutsourced,
    party_type: item.partyType ? item.partyType.toLowerCase() : null,
    party_id: item.partyId,
    allow_negative: item.allowNegative,
    company_id: item.companyId,
    parent_id: item.parentId,
    account_id: item.accountId,
  }
}

interface NormalizedWarehouse {
  name: string
  isLeaf: boolean
  active: boolean
  isOutsourced: boolean
  partyType: string | null
  partyId: string | null
  allowNegative: boolean
  companyId: string
  parentId: string | null
  accountId: string | null
}

function normalizeCreate(input: {
  name: string
  isLeaf?: boolean
  active?: boolean
  isOutsourced?: boolean
  partyType?: string | null
  partyId?: string | null
  allowNegative?: boolean
  companyId: string
  parentId?: string | null
  accountId?: string | null
}): NormalizedWarehouse {
  let partyType = input.partyType ? input.partyType.trim().toUpperCase() : null
  if (partyType === '') partyType = null
  const result: NormalizedWarehouse = {
    name: input.name.trim(),
    isLeaf: input.isLeaf ?? true,
    active: input.active ?? true,
    isOutsourced: input.isOutsourced ?? false,
    partyType,
    partyId: input.partyId ?? null,
    allowNegative: input.allowNegative ?? false,
    companyId: input.companyId,
    parentId: input.parentId ?? null,
    accountId: input.accountId ?? null,
  }
  const fields: Record<string, string[]> = {}
  if (!result.name || runeLen(result.name) > 128) fields.name = ['不能为空且最多 128 个字符']
  if (!result.companyId) fields.companyId = ['不能为空']
  if (result.isOutsourced && (!result.partyType || !result.partyId)) {
    fields.partyId = ['外协仓必须绑定协作方']
  }
  if (!result.isOutsourced && (result.partyType || result.partyId)) {
    fields.partyId = ['非外协仓不能绑定协作方']
  }
  if (result.partyType && result.partyType !== 'SUPPLIER' && result.partyType !== 'COMPANY') {
    fields.partyType = ['协作方类型只能为供应商或内部公司']
  }
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('仓库参数不合法', fields)
  }
  return result
}

async function validateRelations(
  db: DbHandle,
  id: string | null,
  input: NormalizedWarehouse,
): Promise<void> {
  if (input.parentId) {
    if (id && input.parentId === id) {
      throw ApiError.validation('仓库参数不合法', { parentId: ['上级仓库不能选择自身'] })
    }
    const parent = await db
      .selectFrom('inv_warehouse')
      .select(['company_id', 'is_leaf'])
      .where('id', '=', input.parentId)
      .executeTakeFirst()
    if (!parent) {
      throw ApiError.validation('仓库参数不合法', { parentId: ['上级仓库不存在'] })
    }
    if (parent.company_id !== input.companyId) {
      throw ApiError.validation('仓库参数不合法', { parentId: ['上级仓库不属于本公司'] })
    }
    if (parent.is_leaf) {
      throw ApiError.validation('仓库参数不合法', {
        parentId: ['上级仓库是叶子仓库,不能挂子仓库'],
      })
    }
  }
  if (input.accountId) {
    const acc = await db
      .selectFrom('bas_account')
      .select(['company_id', 'is_group', 'currency_id'])
      .where('id', '=', input.accountId)
      .executeTakeFirst()
    if (!acc) {
      throw ApiError.validation('仓库参数不合法', { accountId: ['关联科目不存在'] })
    }
    if (acc.company_id !== input.companyId) {
      throw ApiError.validation('仓库参数不合法', { accountId: ['关联科目不属于本公司'] })
    }
    if (acc.is_group) {
      throw ApiError.validation('仓库参数不合法', { accountId: ['汇总科目不能作为关联科目'] })
    }
    if (acc.currency_id != null) {
      throw ApiError.validation('仓库参数不合法', { accountId: ['外币科目不能作为关联科目'] })
    }
  }
  if (input.partyType && input.partyId) {
    if (input.partyType === 'COMPANY') {
      if (input.partyId === input.companyId) {
        throw ApiError.validation('仓库参数不合法', { partyId: ['协作方不能是本公司'] })
      }
      const exists = await db
        .selectFrom('bas_company')
        .select('id')
        .where('id', '=', input.partyId)
        .executeTakeFirst()
      if (!exists) {
        throw ApiError.validation('仓库参数不合法', { partyId: ['协作方不存在'] })
      }
    } else {
      const exists = await db
        .selectFrom('pur_supplier')
        .select('id')
        .where('id', '=', input.partyId)
        .executeTakeFirst()
      if (!exists) {
        throw ApiError.validation('仓库参数不合法', { partyId: ['协作方不存在'] })
      }
    }
  }
}

async function lockTree(db: DbHandle, companyId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${companyId}::text, 0))`.execute(db)
}
