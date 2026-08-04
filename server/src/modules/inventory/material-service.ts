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
import { auditFieldsOf } from '~/platform/audit/spec.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import { mapWriteError } from '~/db/dberr.ts'
import { listFromSource } from '~/db/list.ts'
import {requirePermission,  runeLen, toDate, trimOrNull } from './helpers.ts'
import { materialResourceMeta } from './meta.ts'

export interface MaterialRef {
  id: string
  name: string
  code?: string | null
  symbol?: string | null
}

export interface Material {
  id: string
  code: string
  materialType: string
  name: string
  spec: string | null
  customerPartNo: string | null
  isCustomerMaterial: boolean
  active: boolean
  insertedAt: Date
  updatedAt: Date
  categoryId: string
  defaultUnitId: string
  customerId: string | null
  category: MaterialRef
  defaultUnit: MaterialRef
  customer: MaterialRef | null
}

const AUDIT = auditFieldsOf(materialResourceMeta())

const META = materialResourceMeta()

const SOURCE = sql`
  FROM (
    SELECT m.id,m.code,m.material_type,m.name,m.spec,m.customer_part_no,m.is_customer_material,m.active,
           m.inserted_at,m.updated_at,m.category_id,m.default_unit_id,m.customer_id,
           category.code AS category_code,category.name AS category_name,
           unit.name AS unit_name,unit.symbol AS unit_symbol,
           customer.code AS customer_code,customer.name AS customer_name
    FROM inv_material m
    JOIN inv_material_category category ON category.id=m.category_id
    JOIN bas_unit unit ON unit.id=m.default_unit_id
    LEFT JOIN sal_customers customer ON customer.id=m.customer_id
  ) material
`

export function createMaterialService(db: Kysely<Database>, numbering: NumberingService) {
  async function get(actor: Actor, id: string): Promise<Material> {
    requirePermission(actor, 'base.material:read')
    const rows = await sql<Record<string, unknown>>`
      SELECT id,code,material_type,name,spec,customer_part_no,is_customer_material,active,
             inserted_at,updated_at,category_id,default_unit_id,customer_id,
             category_code,category_name,unit_name,unit_symbol,customer_code,customer_name
      ${SOURCE} WHERE id = ${id}::uuid
    `.execute(db)
    if (rows.rows.length === 0) throw new ApiError('not_found', '物料不存在')
    return mapRow(rows.rows[0]!)
  }

  async function list(actor: Actor, query: Partial<ListQuery>) {
    requirePermission(actor, 'base.material:read')
    return listFromSource({
      db,
      resource: META,
      source: SOURCE,
      select: sql`SELECT id,code,material_type,name,spec,customer_part_no,is_customer_material,active,
        inserted_at,updated_at,category_id,default_unit_id,customer_id,
        category_code,category_name,unit_name,unit_symbol,customer_code,customer_name`,
      defaultOrder: sql`"code" ASC, "id" ASC`,
      query,
      mapRow,
    })
  }

  async function create(
    actor: Actor,
    input: {
      name: string
      materialType?: string
      spec?: string | null
      customerPartNo?: string | null
      isCustomerMaterial?: boolean
      active?: boolean
      categoryId: string
      defaultUnitId: string
      customerId?: string | null
    },
  ): Promise<Material> {
    requirePermission(actor, 'base.material:create')
    const normalized = normalizeCreate(input)
    return withTx(db, async (trx) => {
      await validateRelations(trx, normalized)
      const code = (
        await numbering.nextInTx(trx, {
          resource: 'inv.material',
          values: {
            name: normalized.name,
            spec: normalized.spec,
            customer_part_no: normalized.customerPartNo,
            is_customer_material: normalized.isCustomerMaterial,
            active: normalized.active,
            category_id: normalized.categoryId,
            default_unit_id: normalized.defaultUnitId,
            customer_id: normalized.customerId,
          },
        })
      ).trim()
      if (!code || runeLen(code) > 64) {
        throw ApiError.validation('物料参数不合法', {
          code: ['自动编号不能为空且最多 64 个字符'],
        })
      }
      try {
        const row = await trx
          .insertInto('inv_material')
          .values({
            code,
            material_type: normalized.materialType,
            name: normalized.name,
            spec: normalized.spec,
            customer_part_no: normalized.customerPartNo,
            is_customer_material: normalized.isCustomerMaterial,
            active: normalized.active,
            category_id: normalized.categoryId,
            default_unit_id: normalized.defaultUnitId,
            customer_id: normalized.customerId,
          })
          .returningAll()
          .executeTakeFirstOrThrow()
        const item = await getInTx(trx, row.id)
        await writeAudit(trx, actor, {
          resource: 'inv_material',
          recordId: item.id,
          recordLabel: item.name,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(snap(item), AUDIT),
        })
        return item
      } catch (err) {
        throw mapWriteError(err, '创建物料失败', [
          { code: '23505', constraint: 'inv_material_unique_code_index', message: '物料编号已存在' },
          { code: '23505', message: '物料唯一字段已存在' },
        ])
      }
    })
  }

  async function update(
    actor: Actor,
    id: string,
    input: {
      name?: string
      materialType?: string
      spec?: string | null
      specPresent?: boolean
      customerPartNo?: string | null
      customerPartNoPresent?: boolean
      isCustomerMaterial?: boolean
      active?: boolean
      categoryId?: string
      defaultUnitId?: string
      customerId?: string | null
      customerIdPresent?: boolean
    },
  ): Promise<Material> {
    requirePermission(actor, 'base.material:update')
    return withTx(db, async (trx) => {
      const locked = await trx
        .selectFrom('inv_material')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', '物料不存在')
      const before = await getInTx(trx, id)
      const draft = {
        name: input.name ?? before.name,
        materialType: input.materialType ?? before.materialType,
        spec: input.specPresent ? (input.spec ?? null) : before.spec,
        customerPartNo: input.customerPartNoPresent
          ? (input.customerPartNo ?? null)
          : before.customerPartNo,
        isCustomerMaterial: input.isCustomerMaterial ?? before.isCustomerMaterial,
        active: input.active ?? before.active,
        categoryId: input.categoryId ?? before.categoryId,
        defaultUnitId: input.defaultUnitId ?? before.defaultUnitId,
        customerId: input.customerIdPresent ? (input.customerId ?? null) : before.customerId,
      }
      const normalized = normalizeCreate(draft)
      await validateRelations(trx, normalized)
      if (normalized.defaultUnitId !== locked.default_unit_id) {
        const unit = await trx
          .selectFrom('inv_material_unit')
          .select('id')
          .where('material_id', '=', id)
          .executeTakeFirst()
        if (unit) {
          throw ApiError.validation('物料参数不合法', {
            defaultUnitId: ['存在单位转换行,不能修改默认单位,请先删除转换行'],
          })
        }
        const stock = await trx
          .selectFrom('inv_stock_entry')
          .select('id')
          .where('material_id', '=', id)
          .executeTakeFirst()
        if (stock) {
          throw ApiError.validation('物料参数不合法', {
            defaultUnitId: ['物料已有库存分录,默认单位不可修改'],
          })
        }
      }
      if (normalized.materialType !== locked.material_type) {
        const stock = await trx
          .selectFrom('inv_stock_entry')
          .select('id')
          .where('material_id', '=', id)
          .executeTakeFirst()
        if (stock) {
          throw new ApiError('conflict', '物料已有库存分录,物料类型不可修改')
        }
      }
      if (
        normalized.isCustomerMaterial !== locked.is_customer_material ||
        normalized.customerId !== (locked.customer_id ?? null)
      ) {
        const ref = await sql<{ exists: boolean }>`
          SELECT EXISTS(
            SELECT 1 FROM sal_order_item soi WHERE soi.material_id = ${id}::uuid
            UNION ALL
            SELECT 1 FROM sal_quotation_item sqi WHERE sqi.material_id = ${id}::uuid
          ) AS exists
        `.execute(trx)
        if (ref.rows[0]?.exists) {
          throw new ApiError('conflict', '物料已被报价或订单引用,不能修改客户约束')
        }
      }
      const afterBase = { ...before, ...normalized, code: before.code }
      const changes = auditDiff(snap(before), snap(afterBase), AUDIT)
      if (Object.keys(changes).length === 0) return before
      try {
        await trx
          .updateTable('inv_material')
          .set({
            name: normalized.name,
            material_type: normalized.materialType,
            spec: normalized.spec,
            customer_part_no: normalized.customerPartNo,
            is_customer_material: normalized.isCustomerMaterial,
            active: normalized.active,
            category_id: normalized.categoryId,
            default_unit_id: normalized.defaultUnitId,
            customer_id: normalized.customerId,
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', id)
          .execute()
      } catch (err) {
        throw mapWriteError(err, '更新物料失败', [
          { code: '23505', message: '物料唯一字段已存在' },
        ])
      }
      const updated = await getInTx(trx, id)
      await writeAudit(trx, actor, {
        resource: 'inv_material',
        recordId: id,
        recordLabel: updated.name,
        actionType: 'update',
        actionName: 'update',
        changes,
      })
      return updated
    })
  }

  async function remove(actor: Actor, id: string): Promise<void> {
    requirePermission(actor, 'base.material:delete')
    await withTx(db, async (trx) => {
      const locked = await trx
        .selectFrom('inv_material')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', '物料不存在')
      const stock = await trx
        .selectFrom('inv_stock_entry')
        .select('id')
        .where('material_id', '=', id)
        .executeTakeFirst()
      if (stock) throw new ApiError('conflict', '物料已被库存分录引用,不能删除')
      const item = await getInTx(trx, id)
      try {
        await trx.deleteFrom('inv_material_unit').where('material_id', '=', id).execute()
        await trx.deleteFrom('inv_material').where('id', '=', id).execute()
      } catch (err) {
        throw mapWriteError(err, '删除物料失败', [
          { code: '23503', message: '物料已被引用或关联记录不存在' },
        ])
      }
      await writeAudit(trx, actor, {
        resource: 'inv_material',
        recordId: id,
        recordLabel: item.name,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(snap(item), AUDIT),
      })
    })
  }

  return { get, list, create, update, remove }
}

export type MaterialService = ReturnType<typeof createMaterialService>

async function getInTx(db: DbHandle, id: string): Promise<Material> {
  const rows = await sql<Record<string, unknown>>`
    SELECT id,code,material_type,name,spec,customer_part_no,is_customer_material,active,
           inserted_at,updated_at,category_id,default_unit_id,customer_id,
           category_code,category_name,unit_name,unit_symbol,customer_code,customer_name
    ${SOURCE} WHERE id = ${id}::uuid
  `.execute(db)
  if (rows.rows.length === 0) throw new ApiError('not_found', '物料不存在')
  return mapRow(rows.rows[0]!)
}

function mapRow(r: Record<string, unknown>): Material {
  const categoryId = String(r.category_id)
  const defaultUnitId = String(r.default_unit_id)
  const customerId = r.customer_id == null ? null : String(r.customer_id)
  return {
    id: String(r.id),
    code: String(r.code),
    materialType: String(r.material_type),
    name: String(r.name),
    spec: r.spec == null ? null : String(r.spec),
    customerPartNo: r.customer_part_no == null ? null : String(r.customer_part_no),
    isCustomerMaterial: Boolean(r.is_customer_material),
    active: Boolean(r.active),
    insertedAt: toDate(r.inserted_at),
    updatedAt: toDate(r.updated_at),
    categoryId,
    defaultUnitId,
    customerId,
    category: {
      id: categoryId,
      name: String(r.category_name),
      code: String(r.category_code),
    },
    defaultUnit: {
      id: defaultUnitId,
      name: String(r.unit_name),
      symbol: r.unit_symbol == null ? null : String(r.unit_symbol),
    },
    customer:
      customerId && r.customer_name != null
        ? {
            id: customerId,
            name: String(r.customer_name),
            code: r.customer_code == null ? null : String(r.customer_code),
          }
        : null,
  }
}

function snap(item: {
  code: string
  materialType: string
  name: string
  spec: string | null
  customerPartNo: string | null
  isCustomerMaterial: boolean
  active: boolean
  categoryId: string
  defaultUnitId: string
  customerId: string | null
}): Record<string, unknown> {
  return {
    code: item.code,
    material_type: item.materialType,
    name: item.name,
    spec: item.spec,
    customer_part_no: item.customerPartNo,
    is_customer_material: item.isCustomerMaterial,
    active: item.active,
    category_id: item.categoryId,
    default_unit_id: item.defaultUnitId,
    customer_id: item.customerId,
  }
}

interface NormalizedMaterial {
  name: string
  materialType: string
  spec: string | null
  customerPartNo: string | null
  isCustomerMaterial: boolean
  active: boolean
  categoryId: string
  defaultUnitId: string
  customerId: string | null
}

const MATERIAL_TYPES = ['STOCK', 'VIRTUAL', 'ASSET'] as const

function normalizeCreate(input: {
  name: string
  materialType?: string
  spec?: string | null
  customerPartNo?: string | null
  isCustomerMaterial?: boolean
  active?: boolean
  categoryId: string
  defaultUnitId: string
  customerId?: string | null
}): NormalizedMaterial {
  let isCustomerMaterial = input.isCustomerMaterial ?? false
  let customerId = input.customerId ?? null
  let customerPartNo = trimOrNull(input.customerPartNo)
  if (!isCustomerMaterial) {
    customerId = null
    customerPartNo = null
  }
  const result: NormalizedMaterial = {
    name: input.name.trim(),
    materialType: (input.materialType ?? 'STOCK').trim().toUpperCase(),
    spec: trimOrNull(input.spec),
    customerPartNo,
    isCustomerMaterial,
    active: input.active ?? true,
    categoryId: input.categoryId,
    defaultUnitId: input.defaultUnitId,
    customerId,
  }
  const fields: Record<string, string[]> = {}
  if (!(MATERIAL_TYPES as readonly string[]).includes(result.materialType)) {
    fields.materialType = ['只能为 STOCK(库存)/VIRTUAL(虚拟)/ASSET(资产)']
  }
  if (!result.name || runeLen(result.name) > 128) fields.name = ['不能为空且最多 128 个字符']
  if (result.spec && runeLen(result.spec) > 128) fields.spec = ['最多 128 个字符']
  if (result.customerPartNo && runeLen(result.customerPartNo) > 64) {
    fields.customerPartNo = ['最多 64 个字符']
  }
  if (!result.categoryId) fields.categoryId = ['不能为空']
  if (!result.defaultUnitId) fields.defaultUnitId = ['不能为空']
  if (result.isCustomerMaterial && !result.customerId) {
    fields.customerId = ['客户物料必须选择客户']
  }
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('物料参数不合法', fields)
  }
  return result
}

async function validateRelations(db: DbHandle, input: NormalizedMaterial): Promise<void> {
  const cat = await db
    .selectFrom('inv_material_category')
    .select(['is_leaf', 'active'])
    .where('id', '=', input.categoryId)
    .executeTakeFirst()
  if (!cat) {
    throw ApiError.validation('物料参数不合法', { categoryId: ['物料分类不存在'] })
  }
  if (!cat.is_leaf || !cat.active) {
    throw ApiError.validation('物料参数不合法', {
      categoryId: ['物料只能挂启用的叶子分类'],
    })
  }
  const unit = await db
    .selectFrom('bas_unit')
    .select('id')
    .where('id', '=', input.defaultUnitId)
    .executeTakeFirst()
  if (!unit) {
    throw ApiError.validation('物料参数不合法', { defaultUnitId: ['默认单位不存在'] })
  }
  if (input.customerId) {
    const customer = await db
      .selectFrom('sal_customers')
      .select('id')
      .where('id', '=', input.customerId)
      .executeTakeFirst()
    if (!customer) {
      throw ApiError.validation('物料参数不合法', { customerId: ['客户不存在'] })
    }
  }
}
