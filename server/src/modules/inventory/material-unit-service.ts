import { decimal, isDecimalString, type ListQuery } from '@synie/shared'
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
import { ApiError } from '~/platform/http/errors.ts'
import { mapWriteError } from '~/db/dberr.ts'
import { listFromSource } from '~/db/list.ts'
import { toDate, wireDecimal } from './helpers.ts'
import { materialUnitResourceMeta } from './meta.ts'

export interface MaterialUnit {
  id: string
  factor: string
  insertedAt: Date
  updatedAt: Date
  materialId: string
  unitId: string
  material: { id: string; name: string; symbol?: string | null }
  unit: { id: string; name: string; symbol?: string | null }
}

const AUDIT = ['factor', 'material_id', 'unit_id'] as const
const META = materialUnitResourceMeta()

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

export function createMaterialUnitService(db: Kysely<Database>) {
  async function get(id: string): Promise<MaterialUnit> {
    const rows = await sql<Record<string, unknown>>`
      SELECT id, factor, inserted_at, updated_at, material_id, unit_id,
             material_name, unit_name, unit_symbol
      ${SOURCE} WHERE id = ${id}::uuid
    `.execute(db)
    if (rows.rows.length === 0) throw new ApiError('not_found', '物料单位转换不存在')
    return mapRow(rows.rows[0]!)
  }

  async function list(query: Partial<ListQuery>) {
    return listFromSource({
      db,
      resource: META,
      source: SOURCE,
      select: sql`SELECT id, factor, inserted_at, updated_at, material_id, unit_id,
        material_name, unit_name, unit_symbol`,
      defaultOrder: sql`"id" ASC`,
      query,
      mapRow,
    })
  }

  async function create(
    actor: Actor,
    input: { materialId: string; unitId: string; factor: string },
  ): Promise<MaterialUnit> {
    const factor = validateFactor(input.factor)
    if (!input.materialId || !input.unitId) {
      throw ApiError.validation('物料单位转换参数不合法', {
        materialId: ['不能为空'],
        unitId: ['不能为空'],
      })
    }
    return withTx(db, async (trx) => {
      await validateUnitChoice(trx, input.materialId, input.unitId)
      try {
        const row = await trx
          .insertInto('inv_material_unit')
          .values({
            material_id: input.materialId,
            unit_id: input.unitId,
            factor,
          })
          .returningAll()
          .executeTakeFirstOrThrow()
        const item = await getInTx(trx, row.id)
        await writeAudit(trx, actor, {
          resource: 'inv_material_unit',
          recordId: item.id,
          recordLabel: item.unit.name,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(snap(item), AUDIT),
        })
        return item
      } catch (err) {
        throw mapWriteError(err, '创建物料单位转换失败', [
          { code: '23505', message: '同一物料同一单位只能有一行转换' },
        ])
      }
    })
  }

  async function update(
    actor: Actor,
    id: string,
    input: { unitId?: string; factor?: string },
  ): Promise<MaterialUnit> {
    return withTx(db, async (trx) => {
      const locked = await trx
        .selectFrom('inv_material_unit')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', '物料单位转换不存在')
      const before = await getInTx(trx, id)
      const unitId = input.unitId ?? before.unitId
      const factor = input.factor != null ? validateFactor(input.factor) : before.factor
      await validateUnitChoice(trx, before.materialId, unitId)
      if (unitId === before.unitId && factor === before.factor) return before
      try {
        await trx
          .updateTable('inv_material_unit')
          .set({
            unit_id: unitId,
            factor,
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', id)
          .execute()
      } catch (err) {
        throw mapWriteError(err, '更新物料单位转换失败', [
          { code: '23505', message: '同一物料同一单位只能有一行转换' },
        ])
      }
      const updated = await getInTx(trx, id)
      await writeAudit(trx, actor, {
        resource: 'inv_material_unit',
        recordId: id,
        recordLabel: updated.unit.name,
        actionType: 'update',
        actionName: 'update',
        changes: auditDiff(snap(before), snap(updated), AUDIT),
      })
      return updated
    })
  }

  async function remove(actor: Actor, id: string): Promise<void> {
    await withTx(db, async (trx) => {
      const locked = await trx
        .selectFrom('inv_material_unit')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', '物料单位转换不存在')
      const item = await getInTx(trx, id)
      await trx.deleteFrom('inv_material_unit').where('id', '=', id).execute()
      await writeAudit(trx, actor, {
        resource: 'inv_material_unit',
        recordId: id,
        recordLabel: item.unit.name,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(snap(item), AUDIT),
      })
    })
  }

  return { get, list, create, update, remove }
}

export type MaterialUnitService = ReturnType<typeof createMaterialUnitService>

async function getInTx(db: DbHandle, id: string): Promise<MaterialUnit> {
  const rows = await sql<Record<string, unknown>>`
    SELECT id, factor, inserted_at, updated_at, material_id, unit_id,
           material_name, unit_name, unit_symbol
    ${SOURCE} WHERE id = ${id}::uuid
  `.execute(db)
  if (rows.rows.length === 0) throw new ApiError('not_found', '物料单位转换不存在')
  return mapRow(rows.rows[0]!)
}

function mapRow(r: Record<string, unknown>): MaterialUnit {
  const factor = wireDecimal(String(r.factor)) ?? String(r.factor)
  return {
    id: String(r.id),
    factor,
    insertedAt: toDate(r.inserted_at),
    updatedAt: toDate(r.updated_at),
    materialId: String(r.material_id),
    unitId: String(r.unit_id),
    material: { id: String(r.material_id), name: String(r.material_name) },
    unit: {
      id: String(r.unit_id),
      name: String(r.unit_name),
      symbol: r.unit_symbol == null ? null : String(r.unit_symbol),
    },
  }
}

function snap(item: MaterialUnit): Record<string, unknown> {
  return {
    factor: item.factor,
    material_id: item.materialId,
    unit_id: item.unitId,
  }
}

function validateFactor(raw: string): string {
  if (!isDecimalString(raw) || !decimal(raw).isPositive()) {
    throw ApiError.validation('物料单位转换参数不合法', { factor: ['必须大于零'] })
  }
  return wireDecimal(raw) ?? raw
}

async function validateUnitChoice(
  db: DbHandle,
  materialId: string,
  unitId: string,
): Promise<void> {
  const mat = await db
    .selectFrom('inv_material')
    .select(['id', 'default_unit_id'])
    .where('id', '=', materialId)
    .executeTakeFirst()
  if (!mat) {
    throw ApiError.validation('物料单位转换参数不合法', { materialId: ['物料不存在'] })
  }
  if (mat.default_unit_id === unitId) {
    throw ApiError.validation('物料单位转换参数不合法', {
      unitId: ['不能选择默认单位自身'],
    })
  }
  const unit = await db.selectFrom('bas_unit').select('id').where('id', '=', unitId).executeTakeFirst()
  if (!unit) {
    throw ApiError.validation('物料单位转换参数不合法', { unitId: ['单位不存在'] })
  }
}
