import type { ListQuery } from '@synie/shared'
import { sql, type Expression, type Kysely, type SqlBool } from 'kysely'
import { buildListQuery } from '~/db/filterbuild.ts'
import { withTx, type DbHandle } from '~/db/tx.ts'
import type { DB as Database, Json } from '~/db/types.ts'
import { auditCreated, auditDestroyed, auditDiff, writeAudit } from '../audit/write.ts'
import type { Actor } from '../authz/actor.ts'
import { ApiError } from '../http/errors.ts'
import { loadCatalog, type NumberingCatalog } from './catalog.ts'
import { counterResourceMeta, ruleResourceMeta } from './meta.ts'

/** 对齐 server-go numberingWriteError：同一资源只能有一条启用规则 */
const ENABLED_PER_RESOURCE_MSG = '该资源已有启用的编号规则,同一资源只能启用一条'

function numberingWriteError(fallback: string, err: unknown): ApiError {
  if (err instanceof ApiError) return err
  const e = err as { code?: string } | null
  if (e && typeof e === 'object' && e.code === '23505') {
    return new ApiError('conflict', ENABLED_PER_RESOURCE_MSG, { cause: err })
  }
  return new ApiError('internal', fallback, { cause: err })
}

export interface Segment {
  type: string
  value?: string | null
  field?: string | null
  label?: string | null
  format?: string | null
  padding?: number | null
}

export interface Rule {
  id: string
  resource: string
  name: string
  segments: Segment[]
  perCompany: boolean
  enabled: boolean
  insertedAt: Date
  updatedAt: Date
}

export interface Counter {
  id: string
  ruleId: string
  scopeKey: string
  value: number
  insertedAt: Date
  updatedAt: Date
}

export interface CreateRuleInput {
  resource: string
  name: string
  segments: Segment[]
  perCompany?: boolean
  enabled?: boolean
}

export interface UpdateRuleInput {
  name?: string
  segments?: Segment[]
  perCompany?: boolean
  enabled?: boolean
}

const RULE_AUDIT = ['resource', 'name', 'segments', 'per_company', 'enabled'] as const
const COUNTER_AUDIT = ['value'] as const
const DATE_FORMAT_RE = /^(?:YYYY|YY|MM|DD)+$/

export function createNumberingService(db: Kysely<Database>, catalog: NumberingCatalog = loadCatalog()) {
  async function numberableResources() {
    return catalog.publicResources()
  }

  async function getRule(id: string): Promise<Rule> {
    const row = await db.selectFrom('sys_numbering_rule').selectAll().where('id', '=', id).executeTakeFirst()
    if (!row) throw new ApiError('not_found', '编号规则不存在')
    return mapRule(row)
  }

  async function listRules(query: Partial<ListQuery>): Promise<{ count: number; results: Rule[] }> {
    const limit = query.limit === undefined || query.limit === 0 ? 20 : query.limit
    const offset = query.offset ?? 0
    if (limit < 1 || limit > 200 || offset < 0) {
      throw ApiError.validation('分页参数不合法', { limit: ['必须在 1 到 200 之间'] })
    }
    const built = buildListQuery(ruleResourceMeta(), {
      limit,
      offset,
      search: query.search,
      sort: query.sort,
      filter: query.filter,
    })
    let countQ = db.selectFrom('sys_numbering_rule').select(db.fn.countAll<string>().as('count'))
    if (built.where) countQ = countQ.where(built.where as Expression<SqlBool>)
    const count = Number((await countQ.executeTakeFirstOrThrow()).count)

    let rowsQ = db.selectFrom('sys_numbering_rule').selectAll()
    if (built.where) rowsQ = rowsQ.where(built.where as Expression<SqlBool>)
    if (built.orderBy) rowsQ = rowsQ.orderBy(built.orderBy as never).orderBy('id')
    else rowsQ = rowsQ.orderBy('inserted_at', 'desc').orderBy('id')
    const rows = await rowsQ.limit(limit).offset(offset).execute()
    return { count, results: rows.map(mapRule) }
  }

  async function create(actor: Actor, input: CreateRuleInput): Promise<Rule> {
    validateCreate(input, catalog)
    const perCompany = input.perCompany ?? true
    const enabled = input.enabled ?? true
    try {
      return await withTx(db, async (trx) => {
        const inserted = await insertRule(trx, {
          resource: input.resource.trim(),
          name: input.name.trim(),
          segments: input.segments,
          perCompany,
          enabled,
        })
        await writeAudit(trx, actor, {
          resource: 'sys_numbering_rule',
          recordId: inserted.id,
          recordLabel: inserted.name,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(ruleSnap(inserted), RULE_AUDIT),
        })
        return inserted
      })
    } catch (err) {
      throw numberingWriteError('创建编号规则失败', err)
    }
  }

  async function updateRule(actor: Actor, id: string, input: UpdateRuleInput): Promise<Rule> {
    try {
      return await withTx(db, async (trx) => {
        const row = await trx
          .selectFrom('sys_numbering_rule')
          .selectAll()
          .where('id', '=', id)
          .forUpdate()
          .executeTakeFirst()
        if (!row) throw new ApiError('not_found', '编号规则不存在')
        const before = mapRule(row)
        const after: Rule = {
          ...before,
          name: input.name !== undefined ? input.name : before.name,
          segments: input.segments ?? before.segments,
          perCompany: input.perCompany ?? before.perCompany,
          enabled: input.enabled ?? before.enabled,
        }
        validateCreate(
          {
            resource: after.resource,
            name: after.name,
            segments: after.segments,
            perCompany: after.perCompany,
            enabled: after.enabled,
          },
          catalog,
        )
        const changes = auditDiff(ruleSnap(before), ruleSnap(after), RULE_AUDIT)
        if (Object.keys(changes).length === 0) return before
        const updated = await updateRuleRow(trx, id, after)
        await writeAudit(trx, actor, {
          resource: 'sys_numbering_rule',
          recordId: id,
          recordLabel: updated.name,
          actionType: 'update',
          actionName: 'update',
          changes,
        })
        return updated
      })
    } catch (err) {
      throw numberingWriteError('更新编号规则失败', err)
    }
  }

  async function deleteRule(actor: Actor, id: string): Promise<void> {
    await withTx(db, async (trx) => {
      const row = await trx
        .selectFrom('sys_numbering_rule')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!row) throw new ApiError('not_found', '编号规则不存在')
      const rule = mapRule(row)
      await trx.deleteFrom('sys_numbering_rule').where('id', '=', id).execute()
      await writeAudit(trx, actor, {
        resource: 'sys_numbering_rule',
        recordId: id,
        recordLabel: rule.name,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(ruleSnap(rule), RULE_AUDIT),
      })
    })
  }

  async function getCounter(id: string): Promise<Counter> {
    const row = await db.selectFrom('sys_numbering_counter').selectAll().where('id', '=', id).executeTakeFirst()
    if (!row) throw new ApiError('not_found', '编号计数器不存在')
    return mapCounter(row)
  }

  async function listCounters(query: Partial<ListQuery>): Promise<{ count: number; results: Counter[] }> {
    const limit = query.limit === undefined || query.limit === 0 ? 20 : query.limit
    const offset = query.offset ?? 0
    if (limit < 1 || limit > 200 || offset < 0) {
      throw ApiError.validation('分页参数不合法', { limit: ['必须在 1 到 200 之间'] })
    }
    const built = buildListQuery(counterResourceMeta(), {
      limit,
      offset,
      search: query.search,
      sort: query.sort,
      filter: query.filter,
    })
    let countQ = db.selectFrom('sys_numbering_counter').select(db.fn.countAll<string>().as('count'))
    if (built.where) countQ = countQ.where(built.where as Expression<SqlBool>)
    const count = Number((await countQ.executeTakeFirstOrThrow()).count)

    let rowsQ = db.selectFrom('sys_numbering_counter').selectAll()
    if (built.where) rowsQ = rowsQ.where(built.where as Expression<SqlBool>)
    if (built.orderBy) rowsQ = rowsQ.orderBy(built.orderBy as never).orderBy('id')
    else rowsQ = rowsQ.orderBy('scope_key').orderBy('id')
    const rows = await rowsQ.limit(limit).offset(offset).execute()
    return { count, results: rows.map(mapCounter) }
  }

  async function updateCounter(actor: Actor, id: string, value: number): Promise<Counter> {
    if (value < 0) {
      throw ApiError.validation('计数器参数不合法', { value: ['不能小于 0'] })
    }
    return withTx(db, async (trx) => {
      const row = await trx
        .selectFrom('sys_numbering_counter')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!row) throw new ApiError('not_found', '编号计数器不存在')
      const before = mapCounter(row)
      const updated = await trx
        .updateTable('sys_numbering_counter')
        .set({ value, updated_at: sql`(now() AT TIME ZONE 'utc')` })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow()
      const after = mapCounter(updated)
      const changes = auditDiff(counterSnap(before), counterSnap(after), COUNTER_AUDIT)
      if (Object.keys(changes).length > 0) {
        await writeAudit(trx, actor, {
          resource: 'sys_numbering_counter',
          recordId: id,
          recordLabel: after.scopeKey,
          actionType: 'update',
          actionName: 'update',
          changes,
        })
      }
      return after
    })
  }

  /** 取号服务（过账链路用 withTx 传 trx 时可用 nextInTx） */
  async function next(input: { resource: string; values?: Record<string, unknown> }): Promise<string> {
    return withTx(db, (trx) => nextInTx(trx, input))
  }

  async function nextInTx(
    handle: DbHandle,
    input: { resource: string; values?: Record<string, unknown> },
  ): Promise<string> {
    const definition = catalog.resource(input.resource)
    if (!definition) {
      throw ApiError.validation('取号参数不合法', { resource: ['未知的绑定资源'] })
    }
    const ruleRow = await handle
      .selectFrom('sys_numbering_rule')
      .selectAll()
      .where('resource', '=', input.resource)
      .where('enabled', '=', true)
      .executeTakeFirst()
    if (!ruleRow) throw new ApiError('conflict', '未配置启用的编号规则')
    const rule = mapRule(ruleRow)
    const values = input.values ?? {}
    const parts: Array<{ text?: string; sequence?: boolean }> = []
    for (const segment of rule.segments) {
      if (segment.type === 'text') {
        parts.push({ text: segment.value ?? '' })
      } else if (segment.type === 'seq') {
        parts.push({ sequence: true })
      } else if (segment.type === 'field') {
        const field = definition.byPath.get(segment.field ?? '')
        if (!field) continue
        const resolved = await resolveField(handle, field, values)
        if (resolved === null || resolved === undefined || String(resolved) === '') continue
        parts.push({ text: renderField(resolved, segment.format ?? null, field.type) })
      }
    }
    let scopeText = ''
    for (const part of parts) {
      if (!part.sequence) scopeText += part.text ?? ''
    }
    let scopeKey = scopeText
    if (rule.perCompany) {
      const companyId = typeof values.company_id === 'string' ? values.company_id : null
      if (!companyId) {
        throw ApiError.validation('无法自动取号', {
          companyId: ['规则按公司计数,单据缺少公司或公司无编码'],
        })
      }
      // 走 catalog 的 company.code lookup，不直查业务表
      const companyCodeField = definition.byPath.get('company.code')
      if (!companyCodeField?.lookup) {
        throw ApiError.validation('无法自动取号', {
          companyId: ['规则按公司计数,但编号目录缺少 company.code 字段'],
        })
      }
      const companyCode = await resolveField(handle, companyCodeField, values)
      if (companyCode === null || companyCode === undefined || !String(companyCode).trim()) {
        throw ApiError.validation('无法自动取号', {
          companyId: ['规则按公司计数,单据缺少公司或公司无编码'],
        })
      }
      scopeKey = `${String(companyCode).trim()}|${scopeText}`
    }
    const sequence = await incrementCounter(handle, rule.id, scopeKey)
    let padding = 4
    for (const segment of rule.segments) {
      if (segment.type === 'seq' && segment.padding !== undefined && segment.padding !== null) {
        padding = segment.padding
        break
      }
    }
    let result = ''
    for (const part of parts) {
      if (!part.sequence) {
        result += part.text ?? ''
        continue
      }
      let value = String(sequence)
      if (padding > 0 && value.length < padding) {
        value = '0'.repeat(padding - value.length) + value
      }
      result += value
    }
    return result
  }

  return {
    numberableResources,
    getRule,
    listRules,
    create,
    updateRule,
    deleteRule,
    getCounter,
    listCounters,
    updateCounter,
    next,
    nextInTx,
  }
}

export type NumberingService = ReturnType<typeof createNumberingService>

function validateCreate(input: CreateRuleInput, catalog: NumberingCatalog): void {
  const resource = input.resource.trim()
  const name = input.name.trim()
  const definition = catalog.resource(resource)
  const fields: Record<string, string[]> = {}
  if (!definition) fields.resource = ['未知的绑定资源']
  if (!name || [...name].length > 64) fields.name = ['规则名称必填且最多 64 个字符']
  if (!input.segments.length) fields.segments = ['至少需要一个编号段']
  else if (definition) {
    const message = validateSegments(input.segments, definition)
    if (message) fields.segments = [message]
  }
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('编号规则参数不合法', fields)
  }
}

function validateSegments(
  segments: Segment[],
  resource: NonNullable<ReturnType<NumberingCatalog['resource']>>,
): string {
  let sequenceCount = 0
  for (const segment of segments) {
    switch (segment.type) {
      case 'text':
        if (!segment.value) return '固定文本段不能为空'
        break
      case 'seq': {
        sequenceCount++
        const padding = segment.padding ?? 4
        if (padding < 0 || padding > 12) return '序号位数须在 0~12 之间(0=不补零)'
        break
      }
      case 'field': {
        if (!segment.field) return '编号段格式不正确'
        const field = resource.byPath.get(segment.field)
        if (!field) return `编号字段 ${segment.field} 在绑定资源上不存在`
        const isDate = field.type === 'date' || field.type === 'datetime'
        if (isDate && (!segment.format || !DATE_FORMAT_RE.test(segment.format))) {
          return `日期字段 ${segment.field} 须选择格式(YYYY/YY/MM/DD 组合)`
        }
        if (!isDate && segment.format) return `字段 ${segment.field} 不是日期,不能设格式`
        break
      }
      default:
        return '编号段格式不正确'
    }
  }
  if (sequenceCount !== 1) return '序号段必须恰好一个'
  return ''
}

/** jsonb[] 写入：将段数组编成字面量，避免驱动把 text 再 JSON 编码成标量 */
function segmentsArraySql(segments: Segment[]) {
  const literal = JSON.stringify(segments).replace(/'/g, "''")
  return sql.raw(`ARRAY(SELECT value FROM jsonb_array_elements('${literal}'::jsonb))`)
}

async function insertRule(
  db: DbHandle,
  input: { resource: string; name: string; segments: Segment[]; perCompany: boolean; enabled: boolean },
): Promise<Rule> {
  const result = await sql<{
    id: string
    resource: string
    name: string
    segments: Json
    per_company: boolean
    enabled: boolean
    inserted_at: Date
    updated_at: Date
  }>`
    INSERT INTO sys_numbering_rule (resource, name, segments, per_company, enabled)
    VALUES (
      ${input.resource},
      ${input.name},
      ${segmentsArraySql(input.segments)},
      ${input.perCompany},
      ${input.enabled}
    )
    RETURNING id, resource, name, to_json(segments) AS segments, per_company, enabled, inserted_at, updated_at
  `.execute(db)
  const row = result.rows[0]
  if (!row) throw new ApiError('internal', '创建编号规则失败')
  return mapRule(row)
}

async function updateRuleRow(db: DbHandle, id: string, rule: Rule): Promise<Rule> {
  const result = await sql<{
    id: string
    resource: string
    name: string
    segments: Json
    per_company: boolean
    enabled: boolean
    inserted_at: Date
    updated_at: Date
  }>`
    UPDATE sys_numbering_rule
    SET name = ${rule.name},
        segments = ${segmentsArraySql(rule.segments)},
        per_company = ${rule.perCompany},
        enabled = ${rule.enabled},
        updated_at = (now() AT TIME ZONE 'utc')
    WHERE id = ${id}::uuid
    RETURNING id, resource, name, to_json(segments) AS segments, per_company, enabled, inserted_at, updated_at
  `.execute(db)
  const row = result.rows[0]
  if (!row) throw new ApiError('not_found', '编号规则不存在')
  return mapRule(row)
}

async function incrementCounter(db: DbHandle, ruleId: string, scopeKey: string): Promise<number> {
  const result = await sql<{ value: string }>`
    INSERT INTO sys_numbering_counter (rule_id, scope_key, value)
    VALUES (${ruleId}::uuid, ${scopeKey}, 1)
    ON CONFLICT (rule_id, scope_key)
    DO UPDATE SET value = sys_numbering_counter.value + 1,
                  updated_at = (now() AT TIME ZONE 'utc')
    RETURNING value::text AS value
  `.execute(db)
  return Number(result.rows[0]?.value ?? 0)
}

async function resolveField(
  db: DbHandle,
  field: { sourceField: string; lookup?: { table: string; valueColumn: string } },
  values: Record<string, unknown>,
): Promise<unknown> {
  const value = values[field.sourceField]
  if (value === undefined || value === null) return null
  if (!field.lookup) return value
  if (typeof value !== 'string') return null
  const result = await sql<{ v: string | null }>`
    SELECT ${sql.raw(field.lookup.valueColumn)}::text AS v
    FROM ${sql.raw(field.lookup.table)}
    WHERE id = ${value}::uuid
  `.execute(db)
  return result.rows[0]?.v ?? null
}

function renderField(value: unknown, format: string | null, type: string): string {
  if (type !== 'date' && type !== 'datetime') {
    if (format) throw new ApiError('validation', '编号字段格式仅适用于日期')
    return String(value)
  }
  const date = parseDate(value)
  if (!date || !format) throw new ApiError('validation', '编号日期字段值不合法')
  return format
    .replaceAll('YYYY', String(date.getUTCFullYear()))
    .replaceAll('YY', String(date.getUTCFullYear()).slice(-2))
    .replaceAll('MM', String(date.getUTCMonth() + 1).padStart(2, '0'))
    .replaceAll('DD', String(date.getUTCDate()).padStart(2, '0'))
}

function parseDate(value: unknown): Date | null {
  if (value instanceof Date) return value
  if (typeof value !== 'string') return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

function mapRule(row: {
  id: string
  resource: string
  name: string
  segments: unknown
  per_company: boolean
  enabled: boolean
  inserted_at: Date | string
  updated_at: Date | string
}): Rule {
  return {
    id: row.id,
    resource: row.resource,
    name: row.name,
    segments: normalizeSegments(row.segments),
    perCompany: row.per_company,
    enabled: row.enabled,
    insertedAt: asDate(row.inserted_at),
    updatedAt: asDate(row.updated_at),
  }
}

function normalizeSegments(raw: unknown): Segment[] {
  if (!Array.isArray(raw)) return []
  return raw.map((item) => {
    const s = item as Record<string, unknown>
    return {
      type: String(s.type ?? ''),
      value: (s.value as string | null | undefined) ?? null,
      field: (s.field as string | null | undefined) ?? null,
      label: (s.label as string | null | undefined) ?? null,
      format: (s.format as string | null | undefined) ?? null,
      padding: typeof s.padding === 'number' ? s.padding : s.padding == null ? null : Number(s.padding),
    }
  })
}

function mapCounter(row: {
  id: string
  rule_id: string
  scope_key: string
  value: string | number | bigint
  inserted_at: Date | string
  updated_at: Date | string
}): Counter {
  return {
    id: row.id,
    ruleId: row.rule_id,
    scopeKey: row.scope_key,
    value: Number(row.value),
    insertedAt: asDate(row.inserted_at),
    updatedAt: asDate(row.updated_at),
  }
}

function ruleSnap(rule: Rule): Record<string, unknown> {
  return {
    resource: rule.resource,
    name: rule.name,
    segments: rule.segments,
    per_company: rule.perCompany,
    enabled: rule.enabled,
  }
}

function counterSnap(counter: Counter): Record<string, unknown> {
  return { value: counter.value }
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}
