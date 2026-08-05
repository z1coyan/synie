/**
 * 会计科目（公司域主数据）。
 *
 * 授权全由平台承担：路由挂 `guard(资源, 动作)`，本服务只收 Permit——
 * 列表 `listAuthorized`、单条 `loadAuthorizedFrom`（与列表共用投影）、
 * 写前取行 `loadAuthorized`、create/模板 `assertCompanyWritable`。
 * 树形成环/父子同公司/删父冲突是领域不变量，留在本文件。
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
import { mapWriteError } from '~/db/dberr.ts'
import { listAuthorized } from '~/db/list.ts'
import { assertCompanyWritable, loadAuthorized, loadAuthorizedFrom } from '~/db/load.ts'
import { ACCOUNT_RESOURCE_NAME, accountResourceMeta } from './meta.ts'
import templateData from './templates.json'

export interface Reference {
  id: string
  name: string
}

export interface Account {
  id: string
  code: string
  name: string
  direction: 'DEBIT' | 'CREDIT'
  isGroup: boolean
  active: boolean
  role: string | null
  parentId: string | null
  companyId: string
  currencyId: string | null
  parent: Reference | null
  company: Reference
  currency: Reference | null
  hasChildren: boolean
  insertedAt: Date
  updatedAt: Date
}

export interface CreateAccountInput {
  code: string
  name: string
  direction: string
  isGroup?: boolean
  active?: boolean
  role?: string | null
  parentId?: string | null
  companyId: string
  currencyId?: string | null
}

export interface UpdateAccountInput {
  name?: string
  direction?: string
  isGroup?: boolean
  active?: boolean
  role?: string | null
  rolePresent?: boolean
  parentId?: string | null
  parentIdPresent?: boolean
  currencyId?: string | null
  currencyIdPresent?: boolean
}

export interface TemplateResult {
  createdCount: number
}

const DIRECTIONS = new Set(['debit', 'credit'])
const ROLES = new Set([
  'unbilled_receivable',
  'receivable',
  'advance_received',
  'unbilled_payable',
  'payable',
  'other_payable',
  'advance_paid',
  'travel',
  'office',
  'entertainment',
  'transport',
  'other_expense',
])

const META = accountResourceMeta()
const AUDIT = auditFieldsOf(META)
const TABLE = META.table

const ACCOUNT_SOURCE = sql`
 FROM (
	SELECT a.id, a.code, a.name, a.direction, a.is_group, a.active, a.role,
	       a.parent_id, a.company_id, a.currency_id, a.inserted_at, a.updated_at,
	       p.name AS parent_name, c.name AS company_name, currency.name AS currency_name,
	       EXISTS(SELECT 1 FROM bas_account child WHERE child.parent_id = a.id) AS has_children
	FROM bas_account a
	LEFT JOIN bas_account p ON p.id = a.parent_id
	JOIN bas_company c ON c.id = a.company_id
	LEFT JOIN bas_currency currency ON currency.id = a.currency_id
) account`
/** listAuthorized/loadAuthorizedFrom 的别名必须与 ACCOUNT_SOURCE 的 `) account` 逐字一致 */
const ACCOUNT_ALIAS = 'account'
const ACCOUNT_SELECT = sql`SELECT id, code, name, direction, is_group, active, role,
parent_id, company_id, currency_id, inserted_at, updated_at,
parent_name, company_name, currency_name, has_children`

type TemplateEntry = {
  code: string
  name: string
  direction: string
  is_group: boolean
  parent: string | null
  role: string | null
}

const templates = templateData as Record<string, TemplateEntry[]>

export function createAccountService(db: Kysely<Database>, registry: Registry) {
  const target = registry.authzTarget(ACCOUNT_RESOURCE_NAME)

  async function get(permit: Permit, id: string): Promise<Account> {
    return loadAuthorizedFrom({
      db,
      permit,
      target,
      alias: ACCOUNT_ALIAS,
      source: ACCOUNT_SOURCE,
      select: ACCOUNT_SELECT,
      id,
      mapRow: (r) => mapJoined(r as unknown as AccountRow),
      notFoundMessage: '会计科目不存在',
    })
  }

  async function list(
    permit: Permit,
    query: Partial<ListQuery>,
  ): Promise<{ count: number; results: Account[] }> {
    return listAuthorized({
      db,
      permit,
      target,
      alias: ACCOUNT_ALIAS,
      resource: META,
      source: ACCOUNT_SOURCE,
      select: ACCOUNT_SELECT,
      defaultOrder: sql`code ASC, id ASC`,
      query,
      mapRow: (r) => mapJoined(r as unknown as AccountRow),
    })
  }

  async function create(permit: Permit, input: CreateAccountInput): Promise<Account> {
    const normalized = normalizeCreate(input)
    validateInput(normalized)
    // 入参校验（400）先于公司边界（404）：错误语义唯一规则只管后者
    assertCompanyWritable(permit, normalized.companyId, '公司不存在')
    return withTx(db, async (trx) => {
      await lockTree(trx, normalized.companyId)
      await validateRelations(trx, normalized)
      const active = input.active ?? true
      try {
        const inserted = await trx
          .insertInto('bas_account')
          .values({
            code: normalized.code,
            name: normalized.name,
            direction: normalized.direction,
            is_group: normalized.isGroup,
            active,
            role: normalized.role,
            parent_id: normalized.parentId,
            company_id: normalized.companyId,
            currency_id: normalized.currencyId,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
        const item = await getAccount(trx, inserted.id)
        await writeAudit(trx, permit.actor, {
          resource: 'bas_account',
          recordId: item.id,
          recordLabel: item.name,
          companyId: item.companyId,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(snapshot(item), AUDIT),
        })
        return item
      } catch (err) {
        if (err instanceof ApiError) throw err
        throw mapWriteError(err, '创建会计科目失败', [
          { code: '23505', message: '同一公司内科目编码不能重复' },
        ])
      }
    })
  }

  async function update(permit: Permit, id: string, input: UpdateAccountInput): Promise<Account> {
    return withTx(db, async (trx) => {
      const locked = lockedRow(
        await loadAuthorized({
          db: trx,
          permit,
          target,
          table: TABLE,
          id,
          forUpdate: true,
          notFoundMessage: '会计科目不存在',
        }),
      )
      await lockTree(trx, locked.company_id)

      const afterInput: CreateAccountInput = {
        code: locked.code,
        name: input.name ?? locked.name,
        direction: input.direction ?? locked.direction,
        isGroup: input.isGroup ?? locked.is_group,
        active: input.active ?? locked.active,
        role: input.rolePresent ? (input.role ?? null) : locked.role,
        parentId: input.parentIdPresent ? (input.parentId ?? null) : locked.parent_id,
        companyId: locked.company_id,
        currencyId: input.currencyIdPresent
          ? (input.currencyId ?? null)
          : locked.currency_id,
      }
      const normalized = normalizeCreate(afterInput)
      validateInput(normalized)
      await validateRelations(trx, normalized)
      await validateNoCycle(trx, id, normalized.parentId)

      try {
        await trx
          .updateTable('bas_account')
          .set({
            name: normalized.name,
            direction: normalized.direction,
            is_group: normalized.isGroup,
            active: normalized.active ?? locked.active,
            role: normalized.role,
            parent_id: normalized.parentId,
            currency_id: normalized.currencyId,
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', id)
          .execute()
        const before = mapLocked(locked)
        const updated = await getAccount(trx, id)
        const changes = auditDiff(snapshot(before), snapshot(updated), AUDIT)
        if (Object.keys(changes).length > 0) {
          await writeAudit(trx, permit.actor, {
            resource: 'bas_account',
            recordId: id,
            recordLabel: updated.name,
            companyId: updated.companyId,
            actionType: 'update',
            actionName: 'update',
            changes,
          })
        }
        return updated
      } catch (err) {
        if (err instanceof ApiError) throw err
        throw mapWriteError(err, '更新会计科目失败', [
          { code: '23505', message: '同一公司内科目编码不能重复' },
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
          notFoundMessage: '会计科目不存在',
        }),
      )
      await lockTree(trx, locked.company_id)
      const child = await trx
        .selectFrom('bas_account')
        .select('id')
        .where('parent_id', '=', id)
        .executeTakeFirst()
      if (child) throw new ApiError('conflict', '存在子科目，不能删除')
      const item = mapLocked(locked)
      try {
        await trx.deleteFrom('bas_account').where('id', '=', id).execute()
      } catch (err) {
        throw mapWriteError(err, '删除会计科目失败', [
          { code: '23503', message: '会计科目已被引用，不能删除' },
        ])
      }
      await writeAudit(trx, permit.actor, {
        resource: 'bas_account',
        recordId: id,
        recordLabel: item.name,
        companyId: item.companyId,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(snapshot(item), AUDIT),
      })
    })
  }

  async function initializeTemplate(
    permit: Permit,
    companyId: string,
    template: string,
  ): Promise<TemplateResult> {
    const key = template.trim().toLowerCase()
    const entries = templates[key]
    if (!entries) {
      throw ApiError.validation('会计科目模板参数不合法', {
        template: ['仅支持 CAS/SMALL/INTL'],
      })
    }
    assertCompanyWritable(permit, companyId, '公司不存在')
    return withTx(db, async (trx) => {
      await lockTree(trx, companyId)
      const company = await trx
        .selectFrom('bas_company')
        .select('id')
        .where('id', '=', companyId)
        .executeTakeFirst()
      if (!company) {
        throw ApiError.validation('会计科目模板参数不合法', {
          companyId: ['公司不存在'],
        })
      }
      const existing = await trx
        .selectFrom('bas_account')
        .select(trx.fn.countAll<string>().as('count'))
        .where('company_id', '=', companyId)
        .executeTakeFirstOrThrow()
      if (Number(existing.count) !== 0) {
        throw new ApiError('conflict', '该公司已有会计科目，不能重复初始化')
      }

      const parentIds = new Map<string, string>()
      for (const entry of entries) {
        let parentId: string | null = null
        if (entry.parent) {
          const pid = parentIds.get(entry.parent)
          if (!pid) throw new ApiError('internal', '会计科目模板父子顺序不合法')
          parentId = pid
        }
        const role = entry.role ? entry.role.toLowerCase() : null
        try {
          const inserted = await trx
            .insertInto('bas_account')
            .values({
              code: entry.code,
              name: entry.name,
              direction: entry.direction.toLowerCase(),
              is_group: entry.is_group,
              active: true,
              role,
              parent_id: parentId,
              company_id: companyId,
            })
            .returningAll()
            .executeTakeFirstOrThrow()
          parentIds.set(inserted.code, inserted.id)
          const item = mapLocked(inserted)
          await writeAudit(trx, permit.actor, {
            resource: 'bas_account',
            recordId: item.id,
            recordLabel: item.name,
            companyId,
            actionType: 'create',
            actionName: 'init_from_template',
            changes: auditCreated(snapshot(item), AUDIT),
          })
        } catch (err) {
          if (err instanceof ApiError) throw err
          throw mapWriteError(err, '初始化会计科目失败', [
            { code: '23505', message: '同一公司内科目编码不能重复' },
          ])
        }
      }
      return { createdCount: entries.length }
    })
  }

  return { get, list, create, update, remove, initializeTemplate }
}

export type AccountService = ReturnType<typeof createAccountService>

export function normalizeCreate(input: CreateAccountInput): {
  code: string
  name: string
  direction: string
  isGroup: boolean
  active?: boolean
  role: string | null
  parentId: string | null
  companyId: string
  currencyId: string | null
} {
  const code = input.code.trim()
  const name = input.name.trim()
  const direction = input.direction.trim().toLowerCase()
  const isGroup = input.isGroup ?? false
  let role =
    input.role === undefined || input.role === null
      ? null
      : input.role.trim().toLowerCase()
  if (isGroup) role = null
  return {
    code,
    name,
    direction,
    isGroup,
    active: input.active,
    role,
    parentId: input.parentId ?? null,
    companyId: input.companyId,
    currencyId: input.currencyId ?? null,
  }
}

export function validateInput(input: {
  code: string
  name: string
  direction: string
  companyId: string
  role: string | null
}): void {
  const fields: Record<string, string[]> = {}
  if (!input.code || [...input.code].length > 32) {
    fields.code = ['不能为空且最多 32 个字符']
  }
  if (!input.name || [...input.name].length > 128) {
    fields.name = ['不能为空且最多 128 个字符']
  }
  if (!DIRECTIONS.has(input.direction)) {
    fields.direction = ['仅支持 DEBIT/CREDIT']
  }
  if (!input.companyId) fields.companyId = ['不能为空']
  if (input.role && !ROLES.has(input.role)) {
    fields.role = ['不是有效的科目角色']
  }
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('会计科目参数不合法', fields)
  }
}

/** loadAuthorized 返回裸行（平台层不承担领域投影）；写路径按需收窄列类型 */
function lockedRow(row: Record<string, unknown>): {
  id: string
  code: string
  name: string
  direction: string
  is_group: boolean
  active: boolean
  role: string | null
  parent_id: string | null
  company_id: string
  currency_id: string | null
  inserted_at: Date | string
  updated_at: Date | string
} {
  return row as never
}

async function lockTree(trx: DbHandle, companyId: string): Promise<void> {
  try {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${companyId}::text, 0))`.execute(trx)
  } catch (err) {
    throw new ApiError('internal', '锁定会计科目树失败', { cause: err })
  }
}

async function validateRelations(
  trx: DbHandle,
  input: {
    companyId: string
    parentId: string | null
    currencyId: string | null
    role: string | null
  },
): Promise<void> {
  const company = await trx
    .selectFrom('bas_company')
    .select('id')
    .where('id', '=', input.companyId)
    .executeTakeFirst()
  if (!company) {
    throw ApiError.validation('会计科目参数不合法', { companyId: ['公司不存在'] })
  }
  if (input.parentId) {
    const parent = await trx
      .selectFrom('bas_account')
      .select(['id', 'company_id'])
      .where('id', '=', input.parentId)
      .executeTakeFirst()
    if (!parent) {
      throw ApiError.validation('会计科目参数不合法', { parentId: ['父科目不存在'] })
    }
    if (parent.company_id !== input.companyId) {
      throw ApiError.validation('会计科目参数不合法', {
        parentId: ['父科目必须属于同一公司'],
      })
    }
  }
  if (input.currencyId) {
    const currency = await trx
      .selectFrom('bas_currency')
      .select(['id', 'iso_code'])
      .where('id', '=', input.currencyId)
      .executeTakeFirst()
    if (!currency) {
      throw ApiError.validation('会计科目参数不合法', { currencyId: ['币种不存在'] })
    }
    if (input.role && currency.iso_code.toUpperCase() !== 'CNY') {
      throw ApiError.validation('会计科目参数不合法', {
        role: ['外币科目不能设置标准科目角色'],
      })
    }
  }
}

async function validateNoCycle(
  trx: DbHandle,
  id: string,
  parentId: string | null,
): Promise<void> {
  if (!parentId) return
  if (parentId === id) {
    throw ApiError.validation('会计科目参数不合法', {
      parentId: ['不能选择自身或下级科目'],
    })
  }
  const result = await sql<{ cycle: boolean }>`
    WITH RECURSIVE descendants AS (
      SELECT id FROM bas_account WHERE parent_id = ${id}
      UNION ALL
      SELECT child.id
      FROM bas_account child
      JOIN descendants d ON child.parent_id = d.id
    )
    SELECT EXISTS(SELECT 1 FROM descendants WHERE id = ${parentId}) AS cycle
  `.execute(trx)
  if (result.rows[0]?.cycle) {
    throw ApiError.validation('会计科目参数不合法', {
      parentId: ['不能选择自身或下级科目'],
    })
  }
}

async function getAccount(trx: DbHandle, id: string): Promise<Account> {
  const result = await sql<AccountRow>`
    SELECT id, code, name, direction, is_group, active, role,
      parent_id, company_id, currency_id, inserted_at, updated_at,
      parent_name, company_name, currency_name, has_children
    ${ACCOUNT_SOURCE}
    WHERE id = ${id}
  `.execute(trx)
  const row = result.rows[0]
  if (!row) throw new ApiError('internal', '读取会计科目失败')
  return mapJoined(row)
}

interface AccountRow {
  id: string
  code: string
  name: string
  direction: string
  is_group: boolean
  active: boolean
  role: string | null
  parent_id: string | null
  company_id: string
  currency_id: string | null
  inserted_at: Date | string
  updated_at: Date | string
  parent_name: string | null
  company_name: string
  currency_name: string | null
  has_children: boolean
}

function mapJoined(row: AccountRow): Account {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    direction: row.direction.toUpperCase() as 'DEBIT' | 'CREDIT',
    isGroup: row.is_group,
    active: row.active,
    role: row.role?.toUpperCase() ?? null,
    parentId: row.parent_id,
    companyId: row.company_id,
    currencyId: row.currency_id,
    parent:
      row.parent_id && row.parent_name
        ? { id: row.parent_id, name: row.parent_name }
        : null,
    company: { id: row.company_id, name: row.company_name },
    currency:
      row.currency_id && row.currency_name
        ? { id: row.currency_id, name: row.currency_name }
        : null,
    hasChildren: row.has_children,
    insertedAt: toDate(row.inserted_at),
    updatedAt: toDate(row.updated_at),
  }
}

function mapLocked(row: {
  id: string
  code: string
  name: string
  direction: string
  is_group: boolean
  active: boolean
  role: string | null
  parent_id: string | null
  company_id: string
  currency_id: string | null
  inserted_at: Date | string
  updated_at: Date | string
}): Account {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    direction: row.direction.toUpperCase() as 'DEBIT' | 'CREDIT',
    isGroup: row.is_group,
    active: row.active,
    role: row.role?.toUpperCase() ?? null,
    parentId: row.parent_id,
    companyId: row.company_id,
    currencyId: row.currency_id,
    parent: null,
    company: { id: row.company_id, name: '' },
    currency: null,
    hasChildren: false,
    insertedAt: toDate(row.inserted_at),
    updatedAt: toDate(row.updated_at),
  }
}

function snapshot(item: Account): Record<string, unknown> {
  return {
    code: item.code,
    name: item.name,
    direction: item.direction.toLowerCase(),
    is_group: item.isGroup,
    active: item.active,
    role: item.role,
    parent_id: item.parentId,
    company_id: item.companyId,
    currency_id: item.currencyId,
  }
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}
