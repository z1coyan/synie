/**
 * 公司（记账主体本身，无公司列 → global 形态）。
 *
 * 授权全由平台承担：路由挂 `guard(资源, 动作)`，本服务只收 Permit——
 * 列表 `listAuthorized`、单条 `loadAuthorizedFrom`（与列表共用投影）、写前 `loadAuthorized`。
 * 公司层级成环/本币启用是领域不变量，留在本文件。
 */
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
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import { mapWriteError } from '~/db/dberr.ts'
import { listAuthorized } from '~/db/list.ts'
import { loadAuthorized, loadAuthorizedFrom } from '~/db/load.ts'
import { COMPANY_RESOURCE_NAME, companyResourceMeta } from './meta.ts'
import { seedCompanyDefaultWarehouses } from './warehouse-seed.ts'

export interface Reference {
  id: string
  name: string
}

export interface Company {
  id: string
  code: string
  name: string
  shortName: string
  parentId: string | null
  baseCurrencyId: string
  parent: Reference | null
  baseCurrency: Reference
  insertedAt: Date
  updatedAt: Date
}

export interface CreateCompanyInput {
  code: string
  name: string
  shortName: string
  parentId?: string | null
  baseCurrencyId: string
}

export interface UpdateCompanyInput {
  name?: string
  shortName?: string
  parentId?: string | null
  parentIdPresent?: boolean
  baseCurrencyId?: string
}

const META = companyResourceMeta()
const AUDIT = auditFieldsOf(META)
const TABLE = META.table
const CODE_RE = /^[A-Za-z]{2}$/

const COMPANY_SOURCE = sql`
 FROM (
SELECT c.id, c.code, c.name, c.short_name, c.parent_id, c.base_currency_id,
       c.inserted_at, c.updated_at, p.name AS parent_name, currency.name AS base_currency_name
FROM bas_company AS c
LEFT JOIN bas_company AS p ON p.id = c.parent_id
JOIN bas_currency AS currency ON currency.id = c.base_currency_id
) AS company`
/** listAuthorized/loadAuthorizedFrom 的别名必须与 COMPANY_SOURCE 的 `AS company` 逐字一致 */
const COMPANY_ALIAS = 'company'
const COMPANY_SELECT = sql`SELECT id, code, name, short_name, parent_id, base_currency_id,
inserted_at, updated_at, parent_name, base_currency_name`

export function createCompanyService(db: Kysely<Database>, numbering: NumberingService, registry: Registry) {
  const target = registry.authzTarget(COMPANY_RESOURCE_NAME)

  async function get(permit: Permit, id: string): Promise<Company> {
    return loadAuthorizedFrom({
      db,
      permit,
      target,
      alias: COMPANY_ALIAS,
      source: COMPANY_SOURCE,
      select: COMPANY_SELECT,
      id,
      mapRow: (r) => mapJoined(r as unknown as CompanyRow),
      notFoundMessage: '公司不存在',
    })
  }

  async function list(
    permit: Permit,
    query: Partial<ListQuery>,
  ): Promise<{ count: number; results: Company[] }> {
    return listAuthorized({
      db,
      permit,
      target,
      alias: COMPANY_ALIAS,
      resource: META,
      source: COMPANY_SOURCE,
      select: COMPANY_SELECT,
      defaultOrder: sql`"code" ASC, "id" ASC`,
      query,
      mapRow: (r) => mapJoined(r as unknown as CompanyRow),
    })
  }

  async function create(permit: Permit, input: CreateCompanyInput): Promise<Company> {
    const normalized = validateCreate(input)
    return withTx(db, async (trx) => {
      await validateCurrency(trx, normalized.baseCurrencyId)
      await validateParent(trx, null, normalized.parentId)
      try {
        const inserted = await trx
          .insertInto('bas_company')
          .values({
            code: normalized.code,
            name: normalized.name,
            short_name: normalized.shortName,
            parent_id: normalized.parentId,
            base_currency_id: normalized.baseCurrencyId,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
        const item = await getInTx(trx, inserted.id)
        await writeAudit(trx, permit.actor, {
          resource: 'bas_company',
          recordId: item.id,
          recordLabel: item.name,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(snapshot(item), AUDIT),
        })
        await seedCompanyDefaultWarehouses(trx, numbering, permit.actor, item.id, item.code)
        return item
      } catch (err) {
        if (err instanceof ApiError) throw err
        throw mapWriteError(err, '创建公司失败', [
          { code: '23505', message: '公司编号已存在' },
        ])
      }
    })
  }

  async function update(permit: Permit, id: string, input: UpdateCompanyInput): Promise<Company> {
    validateUpdate(input)
    return withTx(db, async (trx) => {
      const locked = lockedRow(
        await loadAuthorized({
          db: trx,
          permit,
          target,
          table: TABLE,
          id,
          forUpdate: true,
          notFoundMessage: '公司不存在',
        }),
      )
      const before = {
        id: locked.id,
        code: locked.code,
        name: locked.name,
        shortName: locked.short_name,
        parentId: locked.parent_id,
        baseCurrencyId: locked.base_currency_id,
        parent: null as Reference | null,
        baseCurrency: { id: locked.base_currency_id, name: '' },
        insertedAt: toDate(locked.inserted_at),
        updatedAt: toDate(locked.updated_at),
      }
      const after: typeof before = {
        ...before,
        name: input.name !== undefined ? input.name.trim() : before.name,
        shortName: input.shortName !== undefined ? input.shortName.trim() : before.shortName,
        parentId: input.parentIdPresent ? (input.parentId ?? null) : before.parentId,
        baseCurrencyId: input.baseCurrencyId ?? before.baseCurrencyId,
      }
      if (input.name !== undefined) validateNameField(after.name, 'name', 128)
      if (input.shortName !== undefined) validateNameField(after.shortName, 'shortName', 32)
      if (input.baseCurrencyId !== undefined && !input.baseCurrencyId) {
        throw ApiError.validation('公司参数不合法', { baseCurrencyId: ['不能为空'] })
      }
      await validateCurrency(trx, after.baseCurrencyId)
      await validateParent(trx, id, after.parentId)
      const changes = auditDiff(snapshot(before), snapshot(after), AUDIT)
      if (Object.keys(changes).length === 0) {
        return getInTx(trx, id)
      }
      try {
        await trx
          .updateTable('bas_company')
          .set({
            name: after.name,
            short_name: after.shortName,
            parent_id: after.parentId,
            base_currency_id: after.baseCurrencyId,
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', id)
          .execute()
        const item = await getInTx(trx, id)
        await writeAudit(trx, permit.actor, {
          resource: 'bas_company',
          recordId: item.id,
          recordLabel: item.name,
          actionType: 'update',
          actionName: 'update',
          changes,
        })
        return item
      } catch (err) {
        if (err instanceof ApiError) throw err
        throw mapWriteError(err, '更新公司失败', [
          { code: '23505', message: '公司编号已存在' },
        ])
      }
    })
  }

  async function remove(permit: Permit, id: string): Promise<void> {
    await withTx(db, async (trx) => {
      const locked = lockedRow(
        await loadAuthorized({
          db: trx,
          permit,
          target,
          table: TABLE,
          id,
          forUpdate: true,
          notFoundMessage: '公司不存在',
        }),
      )
      const item = {
        id: locked.id,
        code: locked.code,
        name: locked.name,
        shortName: locked.short_name,
        parentId: locked.parent_id,
        baseCurrencyId: locked.base_currency_id,
      }
      // 公司作为内部公司主体时的从属地址（多态无 FK；库内小写）
      await trx
        .deleteFrom('bas_party_address')
        .where('party_type', '=', 'company')
        .where('party_id', '=', id)
        .execute()
      try {
        await trx.deleteFrom('bas_company').where('id', '=', id).execute()
      } catch (err) {
        throw mapWriteError(err, '删除公司失败', [
          { code: '23503', message: '公司已被业务数据引用,不可删除' },
        ])
      }
      await writeAudit(trx, permit.actor, {
        resource: 'bas_company',
        recordId: item.id,
        recordLabel: item.name,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(
          {
            code: item.code,
            name: item.name,
            short_name: item.shortName,
            parent_id: item.parentId,
            base_currency_id: item.baseCurrencyId,
          },
          AUDIT,
        ),
      })
    })
  }

  return { get, list, create, update, remove }
}

export type CompanyService = ReturnType<typeof createCompanyService>

/** loadAuthorized 返回裸行（平台层不承担领域投影）；此处只做写路径需要的列收窄 */
function lockedRow(row: Record<string, unknown>): {
  id: string
  code: string
  name: string
  short_name: string
  parent_id: string | null
  base_currency_id: string
  inserted_at: Date | string
  updated_at: Date | string
} {
  return row as never
}

async function getInTx(trx: DbHandle, id: string): Promise<Company> {
  const row = await sql<CompanyRow>`
    SELECT id, code, name, short_name, parent_id, base_currency_id,
           inserted_at, updated_at, parent_name, base_currency_name
    ${COMPANY_SOURCE}
    WHERE id = ${id}
  `.execute(trx)
  const first = row.rows[0]
  if (!first) throw new ApiError('internal', '读取公司失败')
  return mapJoined(first)
}

async function validateCurrency(trx: DbHandle, id: string): Promise<void> {
  const row = await trx
    .selectFrom('bas_currency')
    .select('id')
    .where('id', '=', id)
    .where('active', '=', true)
    .executeTakeFirst()
  if (!row) {
    throw ApiError.validation('公司参数不合法', {
      baseCurrencyId: ['币种不存在或未启用'],
    })
  }
}

async function validateParent(
  trx: DbHandle,
  companyId: string | null,
  parentId: string | null,
): Promise<void> {
  const seen = new Set<string>()
  let current: string | null = parentId
  while (current) {
    if (companyId && current === companyId) {
      throw ApiError.validation('公司参数不合法', {
        parentId: ['上级公司不能是自身或其下级公司'],
      })
    }
    if (seen.has(current)) {
      throw ApiError.validation('公司参数不合法', { parentId: ['公司层级存在循环'] })
    }
    seen.add(current)
    const row = await trx
      .selectFrom('bas_company')
      .select('parent_id')
      .where('id', '=', current)
      .executeTakeFirst()
    if (!row) {
      throw ApiError.validation('公司参数不合法', { parentId: ['上级公司不存在'] })
    }
    current = row.parent_id
  }
}

function validateCreate(input: CreateCompanyInput): {
  code: string
  name: string
  shortName: string
  parentId: string | null
  baseCurrencyId: string
} {
  const code = input.code.trim()
  const name = input.name.trim()
  const shortName = input.shortName.trim()
  const fields: Record<string, string[]> = {}
  if (!CODE_RE.test(code)) fields.code = ['必须是恰好两位英文字母']
  if (!name) fields.name = ['不能为空']
  else if ([...name].length > 128) fields.name = ['最多 128 个字符']
  if (!shortName) fields.shortName = ['不能为空']
  else if ([...shortName].length > 32) fields.shortName = ['最多 32 个字符']
  if (!input.baseCurrencyId) fields.baseCurrencyId = ['不能为空']
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('公司参数不合法', fields)
  }
  return {
    code,
    name,
    shortName,
    parentId: input.parentId ?? null,
    baseCurrencyId: input.baseCurrencyId,
  }
}

function validateUpdate(input: UpdateCompanyInput): void {
  // 字段级校验在 apply 时做，此处仅预检
  void input
}

function validateNameField(value: string, field: string, max: number): void {
  if (!value) {
    throw ApiError.validation('公司参数不合法', { [field]: ['不能为空'] })
  }
  if ([...value].length > max) {
    throw ApiError.validation('公司参数不合法', { [field]: [`最多 ${max} 个字符`] })
  }
}

interface CompanyRow {
  id: string
  code: string
  name: string
  short_name: string
  parent_id: string | null
  base_currency_id: string
  inserted_at: Date | string
  updated_at: Date | string
  parent_name: string | null
  base_currency_name: string
}

function mapJoined(row: CompanyRow): Company {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    shortName: row.short_name,
    parentId: row.parent_id,
    baseCurrencyId: row.base_currency_id,
    parent:
      row.parent_id && row.parent_name
        ? { id: row.parent_id, name: row.parent_name }
        : null,
    baseCurrency: { id: row.base_currency_id, name: row.base_currency_name },
    insertedAt: toDate(row.inserted_at),
    updatedAt: toDate(row.updated_at),
  }
}

function snapshot(item: {
  code: string
  name: string
  shortName: string
  parentId: string | null
  baseCurrencyId: string
}): Record<string, unknown> {
  return {
    code: item.code,
    name: item.name,
    short_name: item.shortName,
    parent_id: item.parentId,
    base_currency_id: item.baseCurrencyId,
  }
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}
