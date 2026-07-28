import { decimal, isDecimalString, type ListQuery } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { withTx } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import {
  auditCreated,
  auditDestroyed,
  auditDiff,
  writeAudit,
} from '~/platform/audit/write.ts'
import { requirePermission, type Actor } from '~/platform/authz/actor.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { mapWriteError } from '~/db/dberr.ts'
import { listFromSource } from '~/db/list.ts'
import { unitResourceMeta } from './meta.ts'

export type UnitTypeWire = 'LENGTH' | 'AREA' | 'WEIGHT' | 'QUANTITY'
const UNIT_TYPES = new Set(['length', 'area', 'weight', 'quantity'])

export interface Unit {
  id: string
  unitType: UnitTypeWire
  isBase: boolean
  name: string
  symbol: string
  ratio: string
  insertedAt: Date
  updatedAt: Date
}

export interface CreateUnitInput {
  unitType: string
  isBase?: boolean
  name: string
  symbol: string
  ratio: string
}

export interface UpdateUnitInput {
  unitType?: string
  isBase?: boolean
  name?: string
  symbol?: string
  ratio?: string
}

const AUDIT = ['unit_type', 'is_base', 'name', 'symbol', 'ratio'] as const

export function createUnitService(db: Kysely<Database>) {
  async function get(actor: Actor, id: string): Promise<Unit> {
    requirePermission(actor, 'base.unit:read')
    const row = await db.selectFrom('bas_unit').selectAll().where('id', '=', id).executeTakeFirst()
    if (!row) throw new ApiError('not_found', '计量单位不存在')
    return mapRow(row)
  }

  async function list(
    actor: Actor,
    query: Partial<ListQuery>,
  ): Promise<{ count: number; results: Unit[] }> {
    requirePermission(actor, 'base.unit:read')
    return listFromSource({
      db,
      resource: unitResourceMeta(),
      source: sql` FROM bas_unit`,
      select: sql`SELECT id, unit_type, is_base, name, symbol, ratio, inserted_at, updated_at`,
      defaultOrder: sql`"unit_type", "name", "id"`,
      query,
      mapRow: (r) =>
        mapRow({
          id: String(r.id),
          unit_type: String(r.unit_type),
          is_base: Boolean(r.is_base),
          name: String(r.name),
          symbol: String(r.symbol),
          ratio: String(r.ratio),
          inserted_at: r.inserted_at as Date,
          updated_at: r.updated_at as Date,
        }),
    })
  }

  async function create(actor: Actor, input: CreateUnitInput): Promise<Unit> {
    requirePermission(actor, 'base.unit:create')
    const isBase = input.isBase ?? false
    const normalized = normalize(input.unitType, input.name, input.symbol, input.ratio, isBase)
    return withTx(db, async (trx) => {
      try {
        const row = await trx
          .insertInto('bas_unit')
          .values({
            unit_type: normalized.unitType,
            is_base: isBase,
            name: normalized.name,
            symbol: normalized.symbol,
            ratio: normalized.ratio,
          })
          .returningAll()
          .executeTakeFirstOrThrow()
        const item = mapRow(row)
        await writeAudit(trx, actor, {
          resource: 'bas_unit',
          recordId: item.id,
          recordLabel: item.name,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(snapshot(item), AUDIT),
        })
        return item
      } catch (err) {
        throw mapWriteError(err, '保存计量单位失败', [
          { code: '23505', constraint: 'base_per_type', message: '该类型已存在基准单位' },
          { code: '23505', message: '单位符号已存在' },
        ])
      }
    })
  }

  async function update(actor: Actor, id: string, input: UpdateUnitInput): Promise<Unit> {
    requirePermission(actor, 'base.unit:update')
    return withTx(db, async (trx) => {
      const locked = await trx
        .selectFrom('bas_unit')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', '计量单位不存在')
      const before = mapRow(locked)
      const unitType = input.unitType ?? before.unitType
      const name = input.name ?? before.name
      const symbol = input.symbol ?? before.symbol
      const ratio = input.ratio ?? before.ratio
      const isBase = input.isBase ?? before.isBase
      const normalized = normalize(unitType, name, symbol, ratio, isBase)
      try {
        const row = await trx
          .updateTable('bas_unit')
          .set({
            unit_type: normalized.unitType,
            is_base: isBase,
            name: normalized.name,
            symbol: normalized.symbol,
            ratio: normalized.ratio,
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow()
        const item = mapRow(row)
        const changes = auditDiff(snapshot(before), snapshot(item), AUDIT)
        if (Object.keys(changes).length > 0) {
          await writeAudit(trx, actor, {
            resource: 'bas_unit',
            recordId: id,
            recordLabel: item.name,
            actionType: 'update',
            actionName: 'update',
            changes,
          })
        }
        return item
      } catch (err) {
        throw mapWriteError(err, '保存计量单位失败', [
          { code: '23505', constraint: 'base_per_type', message: '该类型已存在基准单位' },
          { code: '23505', message: '单位符号已存在' },
        ])
      }
    })
  }

  async function remove(actor: Actor, id: string): Promise<void> {
    requirePermission(actor, 'base.unit:delete')
    await withTx(db, async (trx) => {
      const locked = await trx
        .selectFrom('bas_unit')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', '计量单位不存在')
      const item = mapRow(locked)
      try {
        await trx.deleteFrom('bas_unit').where('id', '=', id).execute()
      } catch (err) {
        throw mapWriteError(err, '保存计量单位失败', [
          { code: '23503', message: '计量单位已被业务数据引用,不可删除' },
        ])
      }
      await writeAudit(trx, actor, {
        resource: 'bas_unit',
        recordId: id,
        recordLabel: item.name,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(snapshot(item), AUDIT),
      })
    })
  }

  return { get, list, create, update, remove }
}

export type UnitService = ReturnType<typeof createUnitService>

/** 导出供单测 */
export function normalize(
  unitType: string,
  name: string,
  symbol: string,
  ratio: string,
  isBase: boolean,
): { unitType: string; name: string; symbol: string; ratio: string } {
  const t = unitType.trim().toLowerCase()
  const n = name.trim()
  const s = symbol.trim()
  const fields: Record<string, string[]> = {}
  if (!UNIT_TYPES.has(t)) fields.unitType = ['仅支持 LENGTH/AREA/WEIGHT/QUANTITY']
  if (!n || [...n].length > 32) fields.name = ['不能为空且最多 32 个字符']
  if (!s || [...s].length > 16) fields.symbol = ['不能为空且最多 16 个字符']
  const ratioStr = ratio.trim()
  if (!isDecimalString(ratioStr)) {
    fields.ratio = ['换算比例必须大于 0']
  } else {
    const d = decimal(ratioStr)
    // decimal.js isPositive() 对 0 仍可能为 true（符号位 +），用 gt(0) 判严格正
    if (!d.gt(0)) {
      fields.ratio = ['换算比例必须大于 0']
    } else if (isBase && !d.equals(1)) {
      fields.ratio = ['基准单位换算比例必须为 1']
    }
  }
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('计量单位参数不合法', fields)
  }
  return {
    unitType: t,
    name: n,
    symbol: s,
    ratio: decimal(ratioStr).toFixed(),
  }
}

function mapRow(row: {
  id: string
  unit_type: string
  is_base: boolean
  name: string
  symbol: string
  ratio: string | number
  inserted_at: Date | string
  updated_at: Date | string
}): Unit {
  return {
    id: row.id,
    unitType: row.unit_type.toUpperCase() as UnitTypeWire,
    isBase: row.is_base,
    name: row.name,
    symbol: row.symbol,
    ratio: decimal(String(row.ratio)).toFixed(),
    insertedAt: row.inserted_at instanceof Date ? row.inserted_at : new Date(row.inserted_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
  }
}

function snapshot(item: Unit): Record<string, unknown> {
  return {
    unit_type: item.unitType.toLowerCase(),
    is_base: item.isBase,
    name: item.name,
    symbol: item.symbol,
    ratio: item.ratio,
  }
}
