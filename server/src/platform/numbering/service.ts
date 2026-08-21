/**
 * 编号规则 / 计数器。
 *
 * 授权全由平台承担：路由挂 `guard(资源, 动作)`，本服务只收 Permit。
 * 计数器与规则共用 `sys.numbering_rule` 权限前缀（计数器 meta 无独立 actions），
 * 故路由一律按规则资源取凭证——与迁移前的门控码逐字一致。
 * `next/nextInTx` 是跨域取号基础设施，不经权限（调用方业务码覆盖）。
 *
 * 规则 CRUD 走标准动作内核（createStandardService；segments 的 jsonb[] 编解码
 * 在 meta 字段 codec 声明）；计数器是 via 派生资源（内核不收 via），其读/校正
 * 与取号/目录留手写。
 */
import type { ListQuery } from '@synie/shared'
import { sql, type Kysely } from 'kysely'
import { listFromSource } from '~/db/list.ts'
import { toReadSpec } from '~/platform/meta/read-spec.ts'
import { withTx, type DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import { auditDiff, writeAudit } from '../audit/write.ts'
import { auditFieldsOf } from '../audit/spec.ts'
import { loadAuthorized } from '~/db/load.ts'
import type { Permit } from '../authz/core/index.ts'
import { ApiError } from '../http/errors.ts'
import type { Registry } from '../meta/registry.ts'
import { createStandardService, type StandardHookContext } from '../standard/service.ts'
import type { NumberingCatalog } from './catalog.ts'
import { asDate } from '~/db/dates.ts'
import {
  COUNTER_RESOURCE_NAME,
  RULE_RESOURCE_NAME,
  counterResourceMeta,
  normalizeSegments,
  type Segment,
} from './meta.ts'

export type { Segment } from './meta.ts'

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

export interface Rule {
  id: string
  resource: string
  name: string
  segments: Segment[]
  perCompany: boolean
  enabled: boolean
  insertedAt: Date
  updatedAt: Date
  [key: string]: unknown
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

const COUNTER_AUDIT = auditFieldsOf(counterResourceMeta())
const DATE_FORMAT_RE = /^(?:YYYY|YY|MM|DD)+$/

export function createNumberingService(
  db: Kysely<Database>,
  catalog: NumberingCatalog,
  registry: Registry,
) {
  const counterTarget = registry.authzTarget(COUNTER_RESOURCE_NAME)

  // 规则 CRUD 标准派生：审计三型/无差异早退/授权锁行由内核承接（语义逐字来自手写实现）
  const rules = createStandardService<Rule>({
    db,
    registry,
    resource: RULE_RESOURCE_NAME,
    defaultOrder: sql`inserted_at DESC, id ASC`,
    writeErrors: [{ code: '23505', message: ENABLED_PER_RESOURCE_MSG }],
    hooks: { validate: validateRuleDraft },
  })

  /**
   * 段校验（纯函数，不碰库）。create 落库前 trim 并补缺省（历史 create 口径：
   * perCompany/enabled 缺省 true、resource/name 去空白）；update 保持原始形
   * （历史 update 不 trim，校验用 trim 后值、落库用原值）。
   */
  function validateRuleDraft({ action, draft }: StandardHookContext): void {
    if (action === 'create') {
      if (typeof draft.resource === 'string') draft.resource = draft.resource.trim()
      if (typeof draft.name === 'string') draft.name = draft.name.trim()
      if (draft.perCompany === undefined) draft.perCompany = true
      if (draft.enabled === undefined) draft.enabled = true
    }
    validateCreate(
      {
        resource: String(draft.resource ?? ''),
        name: String(draft.name ?? ''),
        segments: (draft.segments as Segment[] | undefined) ?? [],
      },
      catalog,
    )
  }

  /**
   * 内核内部错误兜底文案是「保存{label}失败」，且审计等管线内异常不经 mapWriteError；
   * 统一过一遍历史 numberingWriteError，对齐逐动作文案与 23505 → conflict。
   */
  function translateRuleWriteError(fallback: string, err: unknown): ApiError {
    if (err instanceof ApiError && err.code !== 'internal') return err
    const cause = err instanceof ApiError ? (err.cause ?? err) : err
    return numberingWriteError(fallback, cause)
  }

  async function numberableResources(permit: Permit) {
    void permit
    return catalog.publicResources()
  }

  async function getRule(permit: Permit, id: string): Promise<Rule> {
    return rules.get(permit, id)
  }

  async function listRules(
    permit: Permit,
    query: Partial<ListQuery>,
  ): Promise<{ count: number; results: Rule[] }> {
    // 全局资源（无公司维度）：guard 已完成码级判定，行筛选编译为空集
    return rules.list(permit, query)
  }

  async function create(permit: Permit, input: CreateRuleInput): Promise<Rule> {
    try {
      return await rules.create(permit, { ...input })
    } catch (err) {
      throw translateRuleWriteError('创建编号规则失败', err)
    }
  }

  async function updateRule(permit: Permit, id: string, input: UpdateRuleInput): Promise<Rule> {
    try {
      return await rules.update(permit, id, { ...input })
    } catch (err) {
      throw translateRuleWriteError('更新编号规则失败', err)
    }
  }

  async function deleteRule(permit: Permit, id: string): Promise<void> {
    try {
      await rules.remove(permit, id)
    } catch (err) {
      // 历史 deleteRule 不包写错误：内部错误还原为原始异常（onError 统一 500 固定文案）
      if (err instanceof ApiError && err.code === 'internal' && err.cause) throw err.cause
      throw err
    }
  }

  async function getCounter(permit: Permit, id: string): Promise<Counter> {
    const row = await loadAuthorized({
      db,
      permit,
      target: counterTarget,
      table: 'sys_numbering_counter',
      id,
      notFoundMessage: '编号计数器不存在',
    })
    return mapCounter(row as never)
  }

  async function listCounters(
    permit: Permit,
    query: Partial<ListQuery>,
  ): Promise<{ count: number; results: Counter[] }> {
    // 全局资源（无公司维度）：guard 已完成码级判定，列表无需行筛选
    void permit
    return listFromSource({
      db,
      resource: toReadSpec(counterResourceMeta()),
      source: sql`FROM sys_numbering_counter`,
      select: sql`SELECT *`,
      defaultOrder: sql`scope_key ASC, id ASC`,
      query,
      mapRow: (row) => mapCounter(row as never),
    })
  }

  async function updateCounter(permit: Permit, id: string, value: number): Promise<Counter> {
    if (value < 0) {
      throw ApiError.validation('计数器参数不合法', { value: ['不能小于 0'] })
    }
    return withTx(db, async (trx) => {
      const row = await loadAuthorized({
        db: trx,
        permit,
        target: counterTarget,
        table: 'sys_numbering_counter',
        id,
        forUpdate: true,
        notFoundMessage: '编号计数器不存在',
      })
      const before = mapCounter(row as never)
      const updated = await trx
        .updateTable('sys_numbering_counter')
        .set({ value, updated_at: sql`(now() AT TIME ZONE 'utc')` })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow()
      const after = mapCounter(updated)
      const changes = auditDiff(counterSnap(before), counterSnap(after), COUNTER_AUDIT)
      if (Object.keys(changes).length > 0) {
        await writeAudit(trx, permit.actor, {
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

  /**
   * create 链路编号唯一入口：编号一律由系统按启用规则生成。
   * provided 非空（调用方手填）即 422，不做静默覆盖；field 用于校验错误定位（对齐表单字段名）。
   */
  async function assigned(input: {
    resource: string
    field: string
    provided?: string | null
    values?: Record<string, unknown>
  }): Promise<string> {
    return withTx(db, (trx) => assignedInTx(trx, input))
  }

  async function assignedInTx(
    handle: DbHandle,
    input: {
      resource: string
      field: string
      provided?: string | null
      values?: Record<string, unknown>
    },
  ): Promise<string> {
    if (input.provided?.trim()) {
      throw ApiError.validation('编号由系统生成,不接受手填', {
        [input.field]: ['编号由系统生成,不接受手填'],
      })
    }
    return nextInTx(handle, { resource: input.resource, values: input.values })
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
    if (!ruleRow) {
      throw new ApiError('conflict', '未配置启用的编号规则,请先在 系统管理 → 编号规则 配置并启用')
    }
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
    assigned,
    assignedInTx,
    /** 标准动作合同套件接入点（同 mfg/payroll 先例） */
    _rulesForContract: () => rules,
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

/** jsonb[] 写入的编解码已收编进 meta 字段 codec（segmentsCodec），内核写管线消费 */

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
  field: {
    sourceField: string
    lookup?: { table: string; valueColumn: string }
    polyLookup?: {
      discriminatorField: string
      variants: Array<{ value: string; table: string; valueColumn: string }>
    }
  },
  values: Record<string, unknown>,
): Promise<unknown> {
  const value = values[field.sourceField]
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return null

  if (field.polyLookup) {
    const discRaw = values[field.polyLookup.discriminatorField]
    if (discRaw === undefined || discRaw === null) return null
    const disc = String(discRaw).toLowerCase()
    const variant = field.polyLookup.variants.find((v) => v.value.toLowerCase() === disc)
    if (!variant) return null
    const result = await sql<{ v: string | null }>`
      SELECT ${sql.raw(variant.valueColumn)}::text AS v
      FROM ${sql.raw(variant.table)}
      WHERE id = ${value}::uuid
    `.execute(db)
    return result.rows[0]?.v ?? null
  }

  if (!field.lookup) return value
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

function counterSnap(counter: Counter): Record<string, unknown> {
  return { value: counter.value }
}

