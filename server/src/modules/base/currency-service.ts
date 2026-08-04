import type { ListQuery } from '@synie/shared'
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
import { auditFieldsOf } from '~/platform/audit/spec.ts'
import { requirePermission, type Actor } from '~/platform/authz/actor.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { mapWriteError } from '~/db/dberr.ts'
import { listFromSource } from '~/db/list.ts'
import { currencyResourceMeta } from './meta.ts'

export interface Currency {
  id: string
  name: string
  isoCode: string
  symbol: string | null
  active: boolean
  insertedAt: Date
  updatedAt: Date
}

export interface CreateCurrencyInput {
  name: string
  isoCode: string
  symbol?: string | null
  active?: boolean
}

export interface UpdateCurrencyInput {
  name?: string
  /** present=true 表示请求体含 symbol 键（可显式 null 清空） */
  symbol?: string | null
  symbolPresent?: boolean
  active?: boolean
}

const AUDIT = auditFieldsOf(currencyResourceMeta())
const ISO_RE = /^[A-Z]{3}$/

export function createCurrencyService(db: Kysely<Database>) {
  async function get(actor: Actor, id: string): Promise<Currency> {
    requirePermission(actor, 'base.currency:read')
    const row = await db.selectFrom('bas_currency').selectAll().where('id', '=', id).executeTakeFirst()
    if (!row) throw new ApiError('not_found', '货币不存在')
    return mapRow(row)
  }

  async function list(
    actor: Actor,
    query: Partial<ListQuery>,
  ): Promise<{ count: number; results: Currency[] }> {
    requirePermission(actor, 'base.currency:read')
    return listFromSource({
      db,
      resource: currencyResourceMeta(),
      source: sql` FROM bas_currency`,
      select: sql`SELECT id, name, iso_code, symbol, active, inserted_at, updated_at`,
      defaultOrder: sql`"iso_code" ASC, "id" ASC`,
      query,
      mapRow: (r) =>
        mapRow({
          id: String(r.id),
          name: String(r.name),
          iso_code: String(r.iso_code),
          symbol: r.symbol == null ? null : String(r.symbol),
          active: Boolean(r.active),
          inserted_at: r.inserted_at as Date,
          updated_at: r.updated_at as Date,
        }),
    })
  }

  async function create(actor: Actor, input: CreateCurrencyInput): Promise<Currency> {
    requirePermission(actor, 'base.currency:create')
    const normalized = validateCreate(input)
    const active = input.active ?? true
    return withTx(db, async (trx) => {
      try {
        const row = await trx
          .insertInto('bas_currency')
          .values({
            name: normalized.name,
            iso_code: normalized.isoCode,
            symbol: normalized.symbol,
            active,
          })
          .returningAll()
          .executeTakeFirstOrThrow()
        const item = mapRow(row)
        await writeAudit(trx, actor, {
          resource: 'bas_currency',
          recordId: item.id,
          recordLabel: item.name,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(snapshot(item), AUDIT),
        })
        return item
      } catch (err) {
        throw mapWriteError(err, '创建货币失败', [
          { code: '23505', message: 'ISO 编码已存在' },
        ])
      }
    })
  }

  async function update(actor: Actor, id: string, input: UpdateCurrencyInput): Promise<Currency> {
    requirePermission(actor, 'base.currency:update')
    validateUpdate(input)
    return withTx(db, async (trx) => {
      const locked = await trx
        .selectFrom('bas_currency')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', '货币不存在')
      const before = mapRow(locked)
      const after: Currency = {
        ...before,
        name: input.name !== undefined ? input.name.trim() : before.name,
        symbol: input.symbolPresent
          ? input.symbol === null || input.symbol === undefined
            ? null
            : input.symbol.trim()
          : before.symbol,
        active: input.active ?? before.active,
      }
      if (input.name !== undefined) {
        if (!after.name) {
          throw ApiError.validation('币种参数不合法', { name: ['不能为空'] })
        }
        if ([...after.name].length > 64) {
          throw ApiError.validation('币种参数不合法', { name: ['最多 64 个字符'] })
        }
      }
      if (input.symbolPresent && after.symbol !== null && [...after.symbol].length > 8) {
        throw ApiError.validation('币种参数不合法', { symbol: ['最多 8 个字符'] })
      }
      const changes = auditDiff(snapshot(before), snapshot(after), AUDIT)
      if (Object.keys(changes).length === 0) return before

      if (before.active && !after.active) {
        const referenced = await trx
          .selectFrom('bas_company')
          .select('id')
          .where('base_currency_id', '=', id)
          .executeTakeFirst()
        if (referenced) {
          throw ApiError.validation('币种参数不合法', {
            active: ['已被公司引用为本币,不可停用'],
          })
        }
      }

      try {
        const updated = await trx
          .updateTable('bas_currency')
          .set({
            name: after.name,
            symbol: after.symbol,
            active: after.active,
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow()
        const item = mapRow(updated)
        await writeAudit(trx, actor, {
          resource: 'bas_currency',
          recordId: item.id,
          recordLabel: item.name,
          actionType: 'update',
          actionName: 'update',
          changes,
        })
        return item
      } catch (err) {
        throw mapWriteError(err, '更新货币失败', [
          { code: '23505', message: 'ISO 编码已存在' },
        ])
      }
    })
  }

  async function remove(actor: Actor, id: string): Promise<void> {
    requirePermission(actor, 'base.currency:delete')
    await withTx(db, async (trx) => {
      const locked = await trx
        .selectFrom('bas_currency')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', '货币不存在')
      const item = mapRow(locked)
      try {
        await trx.deleteFrom('bas_currency').where('id', '=', id).execute()
      } catch (err) {
        throw mapWriteError(err, '删除货币失败', [
          { code: '23503', message: '货币已被业务数据引用,不可删除' },
        ])
      }
      await writeAudit(trx, actor, {
        resource: 'bas_currency',
        recordId: item.id,
        recordLabel: item.name,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(snapshot(item), AUDIT),
      })
    })
  }

  return { get, list, create, update, remove }
}

export type CurrencyService = ReturnType<typeof createCurrencyService>

function validateCreate(input: CreateCurrencyInput): {
  name: string
  isoCode: string
  symbol: string | null
} {
  const name = input.name.trim()
  const isoCode = input.isoCode.trim()
  const fields: Record<string, string[]> = {}
  if (!name) fields.name = ['不能为空']
  else if ([...name].length > 64) fields.name = ['最多 64 个字符']
  if (!ISO_RE.test(isoCode)) fields.isoCode = ['必须是 ISO 4217 三位大写字母编码']
  let symbol: string | null = null
  if (input.symbol !== undefined && input.symbol !== null) {
    symbol = input.symbol.trim()
    if ([...symbol].length > 8) fields.symbol = ['最多 8 个字符']
  }
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('币种参数不合法', fields)
  }
  return { name, isoCode, symbol }
}

function validateUpdate(input: UpdateCurrencyInput): void {
  const fields: Record<string, string[]> = {}
  if (input.name !== undefined) {
    const value = input.name.trim()
    if (!value) fields.name = ['不能为空']
    else if ([...value].length > 64) fields.name = ['最多 64 个字符']
  }
  if (input.symbolPresent && input.symbol !== null && input.symbol !== undefined) {
    if ([...input.symbol.trim()].length > 8) fields.symbol = ['最多 8 个字符']
  }
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('币种参数不合法', fields)
  }
}

function mapRow(row: {
  id: string
  name: string
  iso_code: string
  symbol: string | null
  active: boolean
  inserted_at: Date | string
  updated_at: Date | string
}): Currency {
  return {
    id: row.id,
    name: row.name,
    isoCode: row.iso_code,
    symbol: row.symbol,
    active: row.active,
    insertedAt: toDate(row.inserted_at),
    updatedAt: toDate(row.updated_at),
  }
}

function snapshot(item: Currency): Record<string, unknown> {
  return {
    name: item.name,
    iso_code: item.isoCode,
    symbol: item.symbol,
    active: item.active,
  }
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}
