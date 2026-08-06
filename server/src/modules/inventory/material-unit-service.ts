/**
 * 物料单位转换（`via(invMaterials, material_id)`：判定递归母物料，不设独立权限点）
 * ——标准子行派生服务。
 *
 * CRUD/审计/授权（母单锁 + 递归可达性）由 `platform/standard` 的子行内核按 meta 派生；
 * 列表/单条/写后返回的物料名与单位名 join 投影由内核 projection 复刻。
 *
 * 本文件只留领域不变量（钩子）：换算系数必须大于零、单位不能是物料默认单位自身、
 * 单位必须存在。
 *
 * 路由仍手写在 `master-routes.ts`：写路径「持 base.material:update 或 :create 均可」的
 * anyOf 语义（旧 requireAnyPermission，`test/sweep-inventory-manufacturing` 锁定）
 * 标准子行路由表达不了，故按动作弹射保留路由层。
 */
import { decimal, isDecimalString } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import { createStandardChildService, type StandardChildService } from '~/platform/standard/child.ts'
import { MATERIAL_RESOURCE } from './material-service.ts'

export interface MaterialUnit {
  id: string
  factor: string
  insertedAt: Date
  updatedAt: Date
  materialId: string
  unitId: string
  material: { id: string; name: string; symbol?: string | null }
  unit: { id: string; name: string; symbol?: string | null }
  [key: string]: unknown
}

export const MATERIAL_UNIT_RESOURCE = 'invMaterialUnits'

/** 列表与单条共用同一份投影（别名与 listAuthorized 的 alias 必须逐字一致） */
const ALIAS = 'material_unit'
const SOURCE = sql`
  FROM (
    SELECT mu.id, mu.factor, mu.inserted_at, mu.updated_at, mu.material_id, mu.unit_id,
           m.name AS material_name,
           u.name AS unit_name, u.symbol AS unit_symbol
    FROM inv_material_unit mu
    JOIN inv_material m ON m.id = mu.material_id
    JOIN bas_unit u ON u.id = mu.unit_id
  ) material_unit
`
const SELECT_EXTRA = sql`material_name, unit_name, unit_symbol`

export function createMaterialUnitService(
  db: Kysely<Database>,
  registry: Registry,
): StandardChildService<MaterialUnit> {
  return createStandardChildService<MaterialUnit>({
    db,
    registry,
    resource: MATERIAL_UNIT_RESOURCE,
    parent: { resource: MATERIAL_RESOURCE, fkField: 'materialId', notFound: '物料不存在' },
    notFound: '物料单位转换不存在',
    defaultOrder: sql`"id" ASC`,
    projection: { source: SOURCE, alias: ALIAS, selectExtra: SELECT_EXTRA, mapExtra },
    // 子行无自己的名称列：审计标签取投影出的单位名（与迁移前逐字一致）
    recordLabel: (item) => {
      const unit = item.unit as { name?: unknown } | undefined
      return unit?.name === undefined || unit.name === null ? null : String(unit.name)
    },
    writeErrors: [{ code: '23505', message: '同一物料同一单位只能有一行转换' }],
    hooks: {
      validate: ({ draft }) => {
        const factor = String(draft.factor ?? '')
        // 历史口径：decimal.isPositive() 对 0 为真，故 0 仍可入库（见 README 跟进项）
        if (!isDecimalString(factor) || !decimal(factor).isPositive()) {
          throw ApiError.validation('物料单位转换参数不合法', { factor: ['必须大于零'] })
        }
      },
      beforeWrite: async (trx, { draft, parent }) => {
        await validateUnitChoice(trx, parent, String(draft.unitId))
      },
    },
  })
}

export type MaterialUnitService = ReturnType<typeof createMaterialUnitService>

/** 投影附加列 → wire 嵌套引用对象（物料/单位） */
function mapExtra(r: Record<string, unknown>): Record<string, unknown> {
  return {
    material: { id: String(r.material_id), name: String(r.material_name) },
    unit: {
      id: String(r.unit_id),
      name: String(r.unit_name),
      symbol: r.unit_symbol == null ? null : String(r.unit_symbol),
    },
  }
}

/** 转换单位不能是物料默认单位自身，且必须存在（母物料已由内核锁定并带入） */
async function validateUnitChoice(
  db: DbHandle,
  parent: Record<string, unknown>,
  unitId: string,
): Promise<void> {
  if (String(parent.defaultUnitId) === unitId) {
    throw ApiError.validation('物料单位转换参数不合法', {
      unitId: ['不能选择默认单位自身'],
    })
  }
  const unit = await db.selectFrom('bas_unit').select('id').where('id', '=', unitId).executeTakeFirst()
  if (!unit) {
    throw ApiError.validation('物料单位转换参数不合法', { unitId: ['单位不存在'] })
  }
}
