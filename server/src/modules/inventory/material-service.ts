/**
 * 物料主档（全局共享，无公司列）——标准派生服务。
 *
 * CRUD/批量/审计/授权/自动编号全部由 `platform/standard` 按 meta 派生
 * （编号走 meta.numbering + 内核 numbering 选项，wire 未传 code 才取号）；
 * 列表与单条的分类/单位/客户 join 投影由内核 projection 复刻（写后同事务重载）。
 *
 * 本文件只留领域不变量（钩子）：
 * - 客户物料配对（非客户物料清空客户与客户料号；客户物料必须选客户）
 * - 引用完整性（分类须启用叶子、单位与客户须存在）
 * - 改默认单位/物料类型/客户约束的引用保护，删除前的库存分录保护与转换行级联
 */
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import { createStandardService, type StandardService } from '~/platform/standard/service.ts'
import { runeLen, trimOrNull } from './helpers.ts'
import { materialTypeOptions } from './meta.ts'

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
  [key: string]: unknown
}

export const MATERIAL_RESOURCE = 'invMaterials'

/** 列表与单条共用同一份投影（别名与 listAuthorized 的 alias 必须逐字一致） */
const ALIAS = 'material'
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
const SELECT_EXTRA = sql`category_code,category_name,unit_name,unit_symbol,customer_code,customer_name`

const MATERIAL_TYPES = new Set(materialTypeOptions.map((o) => o.value))

export function createMaterialService(
  db: Kysely<Database>,
  numbering: NumberingService,
  registry: Registry,
): StandardService<Material> {
  return createStandardService<Material>({
    db,
    registry,
    resource: MATERIAL_RESOURCE,
    notFound: '物料不存在',
    defaultOrder: sql`"code" ASC, "id" ASC`,
    numbering: { service: numbering, field: 'code' },
    projection: { source: SOURCE, alias: ALIAS, selectExtra: SELECT_EXTRA, mapExtra },
    writeErrors: [
      { code: '23505', constraint: 'inv_material_unique_code_index', message: '物料编号已存在' },
      { code: '23505', message: '物料唯一字段已存在' },
      { code: '23503', message: '物料已被引用或关联记录不存在' },
    ],
    hooks: {
      validate: ({ draft }) => normalizeMaterial(draft),
      beforeWrite: async (trx, { action, draft, before }) => {
        await validateRelations(trx, draft)
        if (action !== 'update' || !before) return
        const id = String(draft.id)
        if (draft.defaultUnitId !== before.defaultUnitId) {
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
          if (await hasStockEntry(trx, id)) {
            throw ApiError.validation('物料参数不合法', {
              defaultUnitId: ['物料已有库存分录,默认单位不可修改'],
            })
          }
        }
        if (draft.materialType !== before.materialType && (await hasStockEntry(trx, id))) {
          throw new ApiError('conflict', '物料已有库存分录,物料类型不可修改')
        }
        if (
          draft.isCustomerMaterial !== before.isCustomerMaterial ||
          draft.customerId !== before.customerId
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
      },
      beforeDelete: async (trx, { item }) => {
        const id = String(item.id)
        if (await hasStockEntry(trx, id)) {
          throw new ApiError('conflict', '物料已被库存分录引用,不能删除')
        }
        await trx.deleteFrom('inv_material_unit').where('material_id', '=', id).execute()
      },
    },
  })
}

export type MaterialService = ReturnType<typeof createMaterialService>

/** 投影附加列 → wire 嵌套引用对象（分类/默认单位/客户） */
function mapExtra(r: Record<string, unknown>): Record<string, unknown> {
  const categoryId = String(r.category_id)
  const defaultUnitId = String(r.default_unit_id)
  const customerId = r.customer_id == null ? null : String(r.customer_id)
  return {
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

/**
 * 领域规范化 + 不变量（原地改 draft）。
 * wire schema 已做 trim/长度/枚举校验；此处补服务直调路径（种子数据等）的同等约束。
 */
function normalizeMaterial(draft: Record<string, unknown>): void {
  const fields: Record<string, string[]> = {}
  const name = typeof draft.name === 'string' ? draft.name.trim() : ''
  draft.name = name
  draft.spec = trimOrNull(draft.spec as string | null | undefined)
  draft.customerPartNo = trimOrNull(draft.customerPartNo as string | null | undefined)
  if (draft.materialType !== undefined && draft.materialType !== null) {
    draft.materialType = String(draft.materialType).trim().toUpperCase()
    if (!MATERIAL_TYPES.has(String(draft.materialType))) {
      fields.materialType = ['只能为 STOCK(库存)/VIRTUAL(虚拟)/ASSET(资产)']
    }
  }
  // 非客户物料不留客户与客户料号（列上另有 customer_material_pair CHECK）
  if (draft.isCustomerMaterial !== true) {
    draft.customerId = null
    draft.customerPartNo = null
  }
  if (!name || runeLen(name) > 128) fields.name = ['不能为空且最多 128 个字符']
  if (draft.spec && runeLen(String(draft.spec)) > 128) fields.spec = ['最多 128 个字符']
  if (draft.customerPartNo && runeLen(String(draft.customerPartNo)) > 64) {
    fields.customerPartNo = ['最多 64 个字符']
  }
  if (!draft.categoryId) fields.categoryId = ['不能为空']
  if (!draft.defaultUnitId) fields.defaultUnitId = ['不能为空']
  if (draft.isCustomerMaterial === true && !draft.customerId) {
    fields.customerId = ['客户物料必须选择客户']
  }
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('物料参数不合法', fields)
  }
}

async function hasStockEntry(db: DbHandle, materialId: string): Promise<boolean> {
  const row = await db
    .selectFrom('inv_stock_entry')
    .select('id')
    .where('material_id', '=', materialId)
    .executeTakeFirst()
  return Boolean(row)
}

async function validateRelations(db: DbHandle, draft: Record<string, unknown>): Promise<void> {
  const cat = await db
    .selectFrom('inv_material_category')
    .select(['is_leaf', 'active'])
    .where('id', '=', String(draft.categoryId))
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
    .where('id', '=', String(draft.defaultUnitId))
    .executeTakeFirst()
  if (!unit) {
    throw ApiError.validation('物料参数不合法', { defaultUnitId: ['默认单位不存在'] })
  }
  if (draft.customerId) {
    const customer = await db
      .selectFrom('sal_customers')
      .select('id')
      .where('id', '=', String(draft.customerId))
      .executeTakeFirst()
    if (!customer) {
      throw ApiError.validation('物料参数不合法', { customerId: ['客户不存在'] })
    }
  }
}
