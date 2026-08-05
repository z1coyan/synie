import { decimal, isDecimalString, toDecimalString, type ListQuery } from '@synie/shared'
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
import type { Permit } from '~/platform/authz/core/index.ts'
import { systemPermit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { SettingsService } from '~/platform/settings/service.ts'
import { mapWriteError } from '~/db/dberr.ts'
import { listAuthorized } from '~/db/list.ts'
import { findAuthorized, loadAuthorized } from '~/db/load.ts'
import {
  compactError,
  createPublicMarketClient,
  ERR_NOT_AVAILABLE,
  pastSettlementWindow,
  type LastPriceClient,
  type SettlementPriceClient,
} from './fetch.ts'
import {
  INSTRUMENT_RESOURCE_NAME,
  PRICE_POINT_RESOURCE_NAME,
  instrumentResourceMeta,
  pricePointResourceMeta,
} from './meta.ts'

export type PriceKindWire = 'SETTLEMENT' | 'AVERAGE' | 'LAST'
export type SourceTypeWire = 'EXCHANGE' | 'SPOT_INDEX' | 'OTHER'
export type PriceSourceWire = 'MANUAL' | 'FETCH'

export interface MarketInstrument {
  id: string
  code: string
  name: string
  sourceType: SourceTypeWire
  defaultPriceKind: PriceKindWire
  active: boolean
  fetchEnabled: boolean
  externalLastCode: string | null
  externalProductGroup: string | null
  note: string | null
  currencyId: string
  unitId: string
  insertedAt: Date
  updatedAt: Date
}

export interface MarketPricePoint {
  id: string
  observedAt: Date
  price: string
  priceKind: PriceKindWire
  source: PriceSourceWire
  isVoided: boolean
  note: string | null
  instrumentId: string
  currencyId: string
  unitId: string
  insertedAt: Date
  updatedAt: Date
}

export interface InstrumentCreate {
  code: string
  name: string
  sourceType: string
  defaultPriceKind: string
  active?: boolean
  fetchEnabled?: boolean
  externalLastCode?: string | null
  externalProductGroup?: string | null
  note?: string | null
  currencyId: string
  unitId: string
}

export interface InstrumentUpdate {
  name?: string
  defaultPriceKind?: string
  active?: boolean
  fetchEnabled?: boolean
  externalLastCode?: string | null
  externalLastCodePresent?: boolean
  externalProductGroup?: string | null
  externalProductGroupPresent?: boolean
  note?: string | null
  notePresent?: boolean
}

export interface PricePointCreate {
  observedAt: Date
  price: string
  priceKind?: string | null
  source?: string | null
  note?: string | null
  instrumentId: string
}

export interface ChartInstrument {
  id: string
  instrumentId: string
  code: string
  name: string
  currencyId: string
  unitId: string
  currencyCode: string | null
  unitName: string | null
  /** 库内小写价类，与 Go/OpenAPI series 契约一致 */
  defaultPriceKind: string
}

export interface SeriesPoint {
  observedAt: Date
  price: string
}

export interface InstrumentSeries extends ChartInstrument {
  points: SeriesPoint[]
}

export interface PriceSeries {
  priceKind: string
  from: Date
  to: Date
  series: InstrumentSeries[]
}

export interface RefreshItem {
  instrumentId: string
  code: string
  kind: string
  status: 'ok' | 'skipped' | 'error'
  message: string | null
  pricePointId: string | null
}

export interface RefreshResult {
  items: RefreshItem[]
  count: number
}

const INSTRUMENT_META = instrumentResourceMeta()
const POINT_META = pricePointResourceMeta()
const INSTRUMENT_TABLE = INSTRUMENT_META.table
const POINT_TABLE = POINT_META.table

const INSTRUMENT_AUDIT = auditFieldsOf(INSTRUMENT_META)

const POINT_AUDIT = auditFieldsOf(POINT_META)

/**
 * 调度器的系统主体凭证（spec §4：杀 null-actor 分支）。
 * 价点无 created_by_id 外键，可安全用 system 主体落库；调度器在 jobs 侧构造。
 */
export function marketSchedulerPermit(): Permit {
  return systemPermit(PRICE_POINT_RESOURCE_NAME, 'create')
}

const WRITE_MAPPINGS = [
  { code: '23505', constraint: 'market_instrument_unique_code', message: '行情品种编码已存在' },
  {
    code: '23505',
    constraint: 'market_price_point_unique_active_point',
    message: '该品种、观测时刻与价类的有效价点已存在',
  },
  { code: '23503', message: '关联的币种、计量单位或行情品种不存在' },
] as const

export interface MarketServiceDeps {
  settings: SettingsService
  registry: Registry
}

/**
 * 行情品种 / 价点 / 取价 / 拉取。
 * 工厂闭包；写路径 withTx + 审计；金额走 shared decimal。
 */
export function createMarketService(db: Kysely<Database>, deps: MarketServiceDeps) {
  const { settings } = deps
  const instrumentTarget = deps.registry.authzTarget(INSTRUMENT_RESOURCE_NAME)
  const pointTarget = deps.registry.authzTarget(PRICE_POINT_RESOURCE_NAME)

  // ── 品种 ──────────────────────────────────────────────

  async function getInstrument(permit: Permit, id: string): Promise<MarketInstrument> {
    const row = await loadAuthorized({
      db,
      permit,
      target: instrumentTarget,
      table: INSTRUMENT_TABLE,
      id,
      notFoundMessage: '行情品种不存在',
    })
    return mapInstrument(row as never)
  }

  async function listInstruments(
    permit: Permit,
    query: Partial<ListQuery>,
  ): Promise<{ count: number; results: MarketInstrument[] }> {
    return listAuthorized({
      db,
      permit,
      target: instrumentTarget,
      alias: INSTRUMENT_TABLE,
      resource: INSTRUMENT_META,
      source: sql` FROM bas_market_instrument`,
      select: sql`SELECT id,code,name,source_type,default_price_kind,active,fetch_enabled,
external_last_code,external_product_group,note,currency_id,unit_id,inserted_at,updated_at`,
      defaultOrder: sql`"code" ASC, "id" ASC`,
      query,
      mapRow: (r) =>
        mapInstrument({
          id: String(r.id),
          code: String(r.code),
          name: String(r.name),
          source_type: String(r.source_type),
          default_price_kind: String(r.default_price_kind),
          active: Boolean(r.active),
          fetch_enabled: Boolean(r.fetch_enabled),
          external_last_code: r.external_last_code == null ? null : String(r.external_last_code),
          external_product_group:
            r.external_product_group == null ? null : String(r.external_product_group),
          note: r.note == null ? null : String(r.note),
          currency_id: String(r.currency_id),
          unit_id: String(r.unit_id),
          inserted_at: r.inserted_at as Date,
          updated_at: r.updated_at as Date,
        }),
    })
  }

  async function createInstrument(
    permit: Permit,
    input: InstrumentCreate,
  ): Promise<MarketInstrument> {
    const normalized = normalizeInstrument(
      input.code,
      input.name,
      input.sourceType,
      input.defaultPriceKind,
    )
    validateOptionalLengths(
      input.externalLastCode,
      32,
      'externalLastCode',
      input.externalProductGroup,
      16,
      'externalProductGroup',
      input.note,
      255,
      'note',
    )
    const missing: Record<string, string[]> = {}
    if (!input.currencyId) missing.currencyId = ['不能为空']
    if (!input.unitId) missing.unitId = ['不能为空']
    if (Object.keys(missing).length > 0) {
      throw ApiError.validation('行情品种参数不合法', missing)
    }
    const active = input.active ?? true
    const fetchEnabled = input.fetchEnabled ?? false
    return withTx(db, async (trx) => {
      try {
        const row = await trx
          .insertInto('bas_market_instrument')
          .values({
            code: normalized.code,
            name: normalized.name,
            source_type: normalized.sourceType,
            default_price_kind: normalized.priceKind,
            active,
            fetch_enabled: fetchEnabled,
            external_last_code: emptyToNull(input.externalLastCode),
            external_product_group: emptyToNull(input.externalProductGroup),
            note: emptyToNull(input.note),
            currency_id: input.currencyId,
            unit_id: input.unitId,
          })
          .returningAll()
          .executeTakeFirstOrThrow()
        const item = mapInstrument(row)
        await writeAudit(trx, permit.actor, {
          resource: 'bas_market_instrument',
          recordId: item.id,
          recordLabel: item.name,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(instrumentSnapshot(item), INSTRUMENT_AUDIT),
        })
        return item
      } catch (err) {
        throw mapWriteError(err, '保存行情数据失败', WRITE_MAPPINGS)
      }
    })
  }

  async function updateInstrument(
    permit: Permit,
    id: string,
    input: InstrumentUpdate,
  ): Promise<MarketInstrument> {
    return withTx(db, async (trx) => {
      const locked = await loadAuthorized({
        db: trx,
        permit,
        target: instrumentTarget,
        table: INSTRUMENT_TABLE,
        id,
        forUpdate: true,
        notFoundMessage: '行情品种不存在',
      })
      const before = mapInstrument(locked as never)

      let name = before.name
      let kind = before.defaultPriceKind.toLowerCase()
      let active = before.active
      let fetchEnabled = before.fetchEnabled
      let externalLast = before.externalLastCode
      let externalGroup = before.externalProductGroup
      let note = before.note

      if (input.name !== undefined) name = input.name.trim()
      if (input.defaultPriceKind !== undefined) {
        kind = input.defaultPriceKind.trim().toLowerCase()
      }
      if (input.active !== undefined) active = input.active
      if (input.fetchEnabled !== undefined) fetchEnabled = input.fetchEnabled
      if (input.externalLastCodePresent) {
        externalLast = input.externalLastCode ?? null
      }
      if (input.externalProductGroupPresent) {
        externalGroup = input.externalProductGroup ?? null
      }
      if (input.notePresent) {
        note = input.note ?? null
      }

      if (!name || [...name].length > 64 || !validPriceKind(kind)) {
        throw ApiError.validation('行情品种参数不合法', {
          name: ['不能为空且最多 64 个字符'],
          defaultPriceKind: ['仅支持 SETTLEMENT/AVERAGE/LAST'],
        })
      }
      validateOptionalLengths(
        externalLast,
        32,
        'externalLastCode',
        externalGroup,
        16,
        'externalProductGroup',
        note,
        255,
        'note',
      )

      try {
        const updated = await trx
          .updateTable('bas_market_instrument')
          .set({
            name,
            default_price_kind: kind,
            active,
            fetch_enabled: fetchEnabled,
            external_last_code: emptyToNull(externalLast),
            external_product_group: emptyToNull(externalGroup),
            note: emptyToNull(note),
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow()
        const item = mapInstrument(updated)
        const changes = auditDiff(
          instrumentSnapshot(before),
          instrumentSnapshot(item),
          INSTRUMENT_AUDIT,
        )
        if (Object.keys(changes).length > 0) {
          await writeAudit(trx, permit.actor, {
            resource: 'bas_market_instrument',
            recordId: item.id,
            recordLabel: item.name,
            actionType: 'update',
            actionName: 'update',
            changes,
          })
        }
        return item
      } catch (err) {
        throw mapWriteError(err, '保存行情数据失败', WRITE_MAPPINGS)
      }
    })
  }

  async function deleteInstrument(permit: Permit, id: string): Promise<void> {
    await withTx(db, async (trx) => {
      const locked = await loadAuthorized({
        db: trx,
        permit,
        target: instrumentTarget,
        table: INSTRUMENT_TABLE,
        id,
        forUpdate: true,
        notFoundMessage: '行情品种不存在',
      })
      const item = mapInstrument(locked as never)
      const hasPoints = await trx
        .selectFrom('bas_market_price_point')
        .select('id')
        .where('instrument_id', '=', id)
        .executeTakeFirst()
      if (hasPoints) {
        throw new ApiError('conflict', '品种下已有行情价点,请停用而非删除')
      }
      try {
        await trx.deleteFrom('bas_market_instrument').where('id', '=', id).execute()
        await writeAudit(trx, permit.actor, {
          resource: 'bas_market_instrument',
          recordId: item.id,
          recordLabel: item.name,
          actionType: 'destroy',
          actionName: 'destroy',
          changes: auditDestroyed(instrumentSnapshot(item), INSTRUMENT_AUDIT),
        })
      } catch (err) {
        throw mapWriteError(err, '保存行情数据失败', WRITE_MAPPINGS)
      }
    })
  }

  // ── 价点 ──────────────────────────────────────────────

  async function getPricePoint(permit: Permit, id: string): Promise<MarketPricePoint> {
    const row = await loadAuthorized({
      db,
      permit,
      target: pointTarget,
      table: POINT_TABLE,
      id,
      notFoundMessage: '行情价点不存在',
    })
    return mapPoint(row as never)
  }

  async function listPricePoints(
    permit: Permit,
    query: Partial<ListQuery>,
  ): Promise<{ count: number; results: MarketPricePoint[] }> {
    return listAuthorized({
      db,
      permit,
      target: pointTarget,
      alias: POINT_TABLE,
      resource: POINT_META,
      source: sql` FROM bas_market_price_point`,
      select: sql`SELECT id,observed_at,price,price_kind,source,is_voided,note,
instrument_id,currency_id,unit_id,inserted_at,updated_at`,
      defaultOrder: sql`"observed_at" DESC, "id" ASC`,
      query,
      mapRow: (r) =>
        mapPoint({
          id: String(r.id),
          observed_at: r.observed_at as Date,
          price: String(r.price),
          price_kind: String(r.price_kind),
          source: String(r.source),
          is_voided: Boolean(r.is_voided),
          note: r.note == null ? null : String(r.note),
          instrument_id: String(r.instrument_id),
          currency_id: String(r.currency_id),
          unit_id: String(r.unit_id),
          inserted_at: r.inserted_at as Date,
          updated_at: r.updated_at as Date,
        }),
    })
  }

  async function createPricePoint(
    permit: Permit,
    input: PricePointCreate,
  ): Promise<MarketPricePoint> {
    const missing: Record<string, string[]> = {}
    if (!input.observedAt || Number.isNaN(input.observedAt.getTime())) {
      missing.observedAt = ['不能为空']
    }
    if (!input.instrumentId) missing.instrumentId = ['不能为空']
    if (Object.keys(missing).length > 0) {
      throw ApiError.validation('行情价点参数不合法', missing)
    }
    if (!isDecimalString(input.price.trim())) {
      throw ApiError.validation('价格格式不合法', { price: ['必须是十进制字符串'] })
    }
    const price = decimal(input.price.trim())
    // decimal.js isPositive 含 0；对齐 shopspring IsPositive（>0）
    if (!price.greaterThan(0)) {
      throw ApiError.validation('价格必须大于 0', { price: ['必须大于 0'] })
    }
    let source = 'manual'
    if (input.source != null) {
      source = input.source.trim().toLowerCase()
    }
    if (source !== 'manual' && source !== 'fetch') {
      throw ApiError.validation('行情价点参数不合法', {
        source: ['仅支持 MANUAL/FETCH'],
      })
    }
    validateOptionalLengths(input.note, 255, 'note')

    return withTx(db, async (trx) => {
      const inst = await trx
        .selectFrom('bas_market_instrument')
        .select(['currency_id', 'unit_id', 'default_price_kind'])
        .where('id', '=', input.instrumentId)
        .executeTakeFirst()
      if (!inst) {
        throw ApiError.validation('行情品种不存在', {
          instrumentId: ['行情品种不存在'],
        })
      }
      let kind = inst.default_price_kind
      if (input.priceKind != null && input.priceKind.trim() !== '') {
        kind = input.priceKind.trim().toLowerCase()
      }
      if (!validPriceKind(kind)) {
        throw ApiError.validation('行情价点参数不合法', {
          priceKind: ['仅支持 SETTLEMENT/AVERAGE/LAST'],
        })
      }
      try {
        const row = await trx
          .insertInto('bas_market_price_point')
          .values({
            // timestamp without time zone 存 UTC 墙钟；须 sql.raw 字面量，参数化会经驱动按本地时区转换
            observed_at: sql.raw(`'${utcWallString(input.observedAt)}'::timestamp`),
            price: toDecimalString(price),
            price_kind: kind,
            source,
            note: emptyToNull(input.note),
            instrument_id: input.instrumentId,
            currency_id: inst.currency_id,
            unit_id: inst.unit_id,
          })
          .returningAll()
          .executeTakeFirstOrThrow()
        const item = mapPoint(row)
        await writeAudit(trx, permit.actor, {
          resource: 'bas_market_price_point',
          recordId: item.id,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(pointSnapshot(item), POINT_AUDIT),
        })
        return item
      } catch (err) {
        throw mapWriteError(err, '保存行情数据失败', WRITE_MAPPINGS)
      }
    })
  }

  async function voidPricePoint(permit: Permit, id: string): Promise<MarketPricePoint> {
    return withTx(db, async (trx) => {
      const locked = await loadAuthorized({
        db: trx,
        permit,
        target: pointTarget,
        table: POINT_TABLE,
        id,
        forUpdate: true,
        notFoundMessage: '行情价点不存在',
      })
      const before = mapPoint(locked as never)
      if (before.isVoided) {
        throw ApiError.validation('价点已作废', { isVoided: ['价点已作废'] })
      }
      try {
        const updated = await trx
          .updateTable('bas_market_price_point')
          .set({
            is_voided: true,
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', id)
          .where('is_voided', '=', false)
          .returningAll()
          .executeTakeFirstOrThrow()
        const item = mapPoint(updated)
        const changes = auditDiff(pointSnapshot(before), pointSnapshot(item), POINT_AUDIT)
        await writeAudit(trx, permit.actor, {
          resource: 'bas_market_price_point',
          recordId: item.id,
          actionType: 'update',
          actionName: 'void',
          changes,
        })
        return item
      } catch (err) {
        throw mapWriteError(err, '保存行情数据失败', WRITE_MAPPINGS)
      }
    })
  }

  // ── 取价 ──────────────────────────────────────────────

  /**
   * ≤ at 的最近一条未作废价点；priceKind 缺省回落品种默认。
   * 无点 → not_found；品种不存在 → not_found（instrument）。
   *
   * 跨模块受信任读（定价链路取行情）：主体显式为 system（systemPermit），
   * 取代「裸函数即受信任」的隐式约定；调用方的业务码覆盖鉴权。
   */
  async function takeQuote(
    instrumentId: string,
    at: Date,
    priceKind?: string | null,
  ): Promise<MarketPricePoint> {
    const trusted = systemPermit(INSTRUMENT_RESOURCE_NAME, 'read')
    const instRow = await findAuthorized({
      db,
      permit: trusted,
      target: instrumentTarget,
      table: INSTRUMENT_TABLE,
      id: instrumentId,
    })
    if (!instRow) throw new ApiError('not_found', '行情品种不存在')
    const inst = { default_price_kind: String(instRow.default_price_kind) }
    let kind = inst.default_price_kind
    if (priceKind != null && priceKind.trim() !== '') {
      kind = priceKind.trim().toLowerCase()
    }
    if (!validPriceKind(kind)) {
      throw ApiError.validation('行情价点参数不合法', {
        priceKind: ['仅支持 SETTLEMENT/AVERAGE/LAST'],
      })
    }
    const atLit = sql.raw(`'${utcWallString(at)}'::timestamp`)
    const row = await sql<{
      id: string
      observed_at: Date | string
      price: string
      price_kind: string
      source: string
      is_voided: boolean
      note: string | null
      instrument_id: string
      currency_id: string
      unit_id: string
      inserted_at: Date | string
      updated_at: Date | string
    }>`
      SELECT id, observed_at, price, price_kind, source, is_voided, note,
             instrument_id, currency_id, unit_id, inserted_at, updated_at
      FROM bas_market_price_point
      WHERE instrument_id = ${instrumentId}::uuid
        AND price_kind = ${kind}
        AND is_voided = false
        AND observed_at <= ${atLit}
      ORDER BY observed_at DESC
      LIMIT 1
    `.execute(db)
    const first = row.rows[0]
    if (!first) throw new ApiError('not_found', '无有效行情价点')
    return mapPoint(first)
  }

  // ── 图区 ──────────────────────────────────────────────

  async function chartInstruments(permit: Permit): Promise<ChartInstrument[]> {
    // 图区是跨行聚合投影：码级门控由路由 guard 承担，行过滤不适用（global 资源无公司列）
    void permit
    const rows = await sql<{
      id: string
      code: string
      name: string
      currency_id: string
      unit_id: string
      currency_code: string | null
      unit_name: string | null
      default_price_kind: string
    }>`
      SELECT i.id, i.code, i.name, i.currency_id, i.unit_id, c.iso_code AS currency_code,
             u.name AS unit_name, i.default_price_kind
      FROM bas_market_instrument i
      LEFT JOIN bas_currency c ON c.id = i.currency_id
      LEFT JOIN bas_unit u ON u.id = i.unit_id
      WHERE i.active = true
      ORDER BY i.code
    `.execute(db)
    return rows.rows.map((r) => ({
      id: r.id,
      instrumentId: r.id,
      code: r.code,
      name: r.name,
      currencyId: r.currency_id,
      unitId: r.unit_id,
      currencyCode: r.currency_code,
      unitName: r.unit_name,
      defaultPriceKind: r.default_price_kind,
    }))
  }

  async function priceSeries(
    permit: Permit,
    ids: string[],
    priceKind: string,
    from: Date,
    to: Date,
  ): Promise<PriceSeries> {
    void permit
    const unique: string[] = []
    const seen = new Set<string>()
    for (const id of ids) {
      if (!id || seen.has(id)) continue
      seen.add(id)
      unique.push(id)
    }
    const kind = priceKind.trim().toLowerCase()
    if (!validPriceKind(kind)) {
      throw ApiError.validation('参数无效', {
        priceKind: ['仅支持 SETTLEMENT/AVERAGE/LAST'],
      })
    }
    const missing: Record<string, string[]> = {}
    if (!from || Number.isNaN(from.getTime())) missing.from = ['不能为空']
    if (!to || Number.isNaN(to.getTime())) missing.to = ['不能为空']
    if (Object.keys(missing).length > 0) {
      throw ApiError.validation('行情序列参数不合法', missing)
    }
    if (unique.length > 6) {
      throw ApiError.validation('最多同时对比 6 个品种', {
        instrumentIds: ['最多同时对比 6 个品种'],
      })
    }
    if (from.getTime() > to.getTime()) {
      throw ApiError.validation('结束时间不能早于开始时间', {
        to: ['结束时间不能早于开始时间'],
      })
    }
    const result: PriceSeries = {
      priceKind: kind,
      from: new Date(from.toISOString()),
      to: new Date(to.toISOString()),
      series: [],
    }
    if (unique.length === 0) return result

    const instRows = await sql<{
      id: string
      code: string
      name: string
      currency_id: string
      unit_id: string
      currency_code: string | null
      unit_name: string | null
      default_price_kind: string
    }>`
      SELECT i.id, i.code, i.name, i.currency_id, i.unit_id, c.iso_code AS currency_code,
             u.name AS unit_name, i.default_price_kind
      FROM bas_market_instrument i
      LEFT JOIN bas_currency c ON c.id = i.currency_id
      LEFT JOIN bas_unit u ON u.id = i.unit_id
      WHERE i.id = ANY(${unique}::uuid[])
    `.execute(db)

    const found = new Map<string, ChartInstrument>()
    for (const r of instRows.rows) {
      found.set(r.id, {
        id: r.id,
        instrumentId: r.id,
        code: r.code,
        name: r.name,
        currencyId: r.currency_id,
        unitId: r.unit_id,
        currencyCode: r.currency_code,
        unitName: r.unit_name,
        defaultPriceKind: r.default_price_kind,
      })
    }
    if (found.size !== unique.length) {
      throw ApiError.validation('部分行情品种不存在', {
        instrumentIds: ['部分行情品种不存在'],
      })
    }
    const first = found.get(unique[0]!)!
    for (const id of unique.slice(1)) {
      const x = found.get(id)!
      if (x.currencyId !== first.currencyId || x.unitId !== first.unitId) {
        throw ApiError.validation('勾选品种必须同一币种与计量单位,无法同图对比', {
          instrumentIds: ['勾选品种必须同一币种与计量单位'],
        })
      }
    }

    const fromLit = sql.raw(`'${utcWallString(from)}'::timestamp`)
    const toLit = sql.raw(`'${utcWallString(to)}'::timestamp`)
    const pointRows = await sql<{
      instrument_id: string
      observed_at: Date | string
      price: string
    }>`
      SELECT instrument_id, observed_at, price
      FROM bas_market_price_point
      WHERE instrument_id = ANY(${unique}::uuid[])
        AND price_kind = ${kind}
        AND is_voided = false
        AND observed_at >= ${fromLit}
        AND observed_at <= ${toLit}
      ORDER BY observed_at
    `.execute(db)

    const byId = new Map<string, SeriesPoint[]>()
    for (const p of pointRows.rows) {
      const list = byId.get(p.instrument_id) ?? []
      list.push({
        observedAt: asUtcTimestamp(p.observed_at),
        price: toDecimalString(decimal(String(p.price))),
      })
      byId.set(p.instrument_id, list)
    }
    for (const id of unique) {
      const chart = found.get(id)!
      result.series.push({
        ...chart,
        points: byId.get(id) ?? [],
      })
    }
    return result
  }

  // ── 拉取 ──────────────────────────────────────────────

  async function refresh(
    permit: Permit,
    instrumentId: string | null | undefined,
    now = new Date(),
    lastClient?: LastPriceClient,
    settlementClient?: SettlementPriceClient,
  ): Promise<RefreshResult> {
    const client = lastClient ?? createPublicMarketClient()
    const settleClient = settlementClient ?? createPublicMarketClient()
    const instruments = await fetchableInstruments(instrumentId ?? null)
    const system = await settings.loadSystemConfig()
    const trySettlement =
      system.marketFetchSettlementEnabled && pastSettlementWindow(now)
    const items: RefreshItem[] = []
    for (const instrument of instruments) {
      items.push(await fetchLast(permit, instrument, now, client))
      if (trySettlement) {
        items.push(await fetchSettlement(permit, instrument, now, settleClient))
      }
    }
    const result: RefreshResult = { items, count: items.length }
    await settings.recordMarketFetch(permit, summarizeRefresh('手动刷新', items))
    return result
  }

  async function refreshLasts(
    permit: Permit,
    instrumentId: string | null | undefined,
    now: Date,
    lastClient?: LastPriceClient,
  ): Promise<RefreshResult> {
    const client = lastClient ?? createPublicMarketClient()
    const instruments = await fetchableInstruments(instrumentId ?? null)
    const items: RefreshItem[] = []
    for (const instrument of instruments) {
      items.push(await fetchLast(permit, instrument, now, client))
    }
    const result: RefreshResult = { items, count: items.length }
    if (items.length > 0) {
      await settings.recordMarketFetch(permit, summarizeRefresh('定时最新价', items))
    }
    return result
  }

  async function refreshSettlements(
    permit: Permit,
    instrumentId: string | null | undefined,
    now: Date,
    settlementClient?: SettlementPriceClient,
  ): Promise<RefreshResult> {
    const client = settlementClient ?? createPublicMarketClient()
    const instruments = await fetchableInstruments(instrumentId ?? null)
    const items: RefreshItem[] = []
    for (const instrument of instruments) {
      items.push(await fetchSettlement(permit, instrument, now, client))
    }
    const result: RefreshResult = { items, count: items.length }
    if (items.length > 0) {
      await settings.recordMarketFetch(permit, summarizeRefresh('定时结算价', items))
    }
    return result
  }

  async function fetchableInstruments(id: string | null): Promise<MarketInstrument[]> {
    let q = db
      .selectFrom('bas_market_instrument')
      .selectAll()
      .where('active', '=', true)
      .where('fetch_enabled', '=', true)
    if (id) q = q.where('id', '=', id)
    const rows = await q.orderBy('code', 'asc').execute()
    return rows.map(mapInstrument)
  }

  async function fetchLast(
    permit: Permit,
    instrument: MarketInstrument,
    now: Date,
    client: LastPriceClient,
  ): Promise<RefreshItem> {
    if (!instrument.externalLastCode?.trim()) {
      return refreshItem(instrument, 'last', 'error', '未配置外部最新价代码', null)
    }
    const observedAt = truncateToMinute(now)
    if (await hasActivePoint(instrument.id, observedAt, 'last')) {
      return refreshItem(instrument, 'last', 'skipped', '本分钟已有最新价', null)
    }
    const code = instrument.externalLastCode.trim()
    try {
      const quote = await client.fetchLast(code)
      let note = `sina ${code}`
      if (quote.asOfDate) note += ` @${quote.asOfDate}`
      const point = await createPricePoint(permit, {
        instrumentId: instrument.id,
        observedAt,
        price: toDecimalString(quote.price),
        priceKind: 'LAST',
        source: 'FETCH',
        note,
      })
      return refreshItem(instrument, 'last', 'ok', '', point.id)
    } catch (err) {
      return refreshItem(instrument, 'last', 'error', compactError(err), null)
    }
  }

  async function fetchSettlement(
    permit: Permit,
    instrument: MarketInstrument,
    now: Date,
    client: SettlementPriceClient,
  ): Promise<RefreshItem> {
    if (!instrument.externalProductGroup?.trim()) {
      return refreshItem(instrument, 'settlement', 'error', '未配置外部品种组', null)
    }
    const shanghai = new Date(now.getTime() + 8 * 60 * 60 * 1000)
    const tradeDate = new Date(
      Date.UTC(shanghai.getUTCFullYear(), shanghai.getUTCMonth(), shanghai.getUTCDate()),
    )
    // 结算观测时刻：上海交易日 15:00 → UTC 07:00
    const observedAt = new Date(
      Date.UTC(tradeDate.getUTCFullYear(), tradeDate.getUTCMonth(), tradeDate.getUTCDate(), 7, 0, 0),
    )
    if (await hasActivePoint(instrument.id, observedAt, 'settlement')) {
      return refreshItem(instrument, 'settlement', 'skipped', '当日结算价已存在', null)
    }
    const group = instrument.externalProductGroup.trim()
    try {
      const quote = await client.fetchSettlement(group, tradeDate)
      const note = `shfe ${group}${quote.deliveryMonth} main OI=${quote.openInterest}`
      const point = await createPricePoint(permit, {
        instrumentId: instrument.id,
        observedAt,
        price: toDecimalString(quote.price),
        priceKind: 'SETTLEMENT',
        source: 'FETCH',
        note,
      })
      return refreshItem(instrument, 'settlement', 'ok', '', point.id)
    } catch (err) {
      if (err === ERR_NOT_AVAILABLE) {
        return refreshItem(instrument, 'settlement', 'skipped', '日数据尚未发布或非交易日', null)
      }
      return refreshItem(instrument, 'settlement', 'error', compactError(err), null)
    }
  }

  async function hasActivePoint(
    instrumentId: string,
    observedAt: Date,
    kind: string,
  ): Promise<boolean> {
    const atLit = sql.raw(`'${utcWallString(observedAt)}'::timestamp`)
    const row = await sql<{ id: string }>`
      SELECT id FROM bas_market_price_point
      WHERE instrument_id = ${instrumentId}::uuid
        AND observed_at = ${atLit}
        AND price_kind = ${kind}
        AND is_voided = false
      LIMIT 1
    `.execute(db)
    return row.rows[0] !== undefined
  }

  return {
    getInstrument,
    listInstruments,
    createInstrument,
    updateInstrument,
    deleteInstrument,
    getPricePoint,
    listPricePoints,
    createPricePoint,
    voidPricePoint,
    takeQuote,
    chartInstruments,
    priceSeries,
    refresh,
    refreshLasts,
    refreshSettlements,
    // 兼容旧命名
    list: listInstruments,
    get: getInstrument,
  }
}

export type MarketService = ReturnType<typeof createMarketService>
/** @deprecated 使用 MarketService */
export type MarketInstrumentService = MarketService

/** 兼容旧工厂名：需注入 settings */
export function createMarketInstrumentService(
  db: Kysely<Database>,
  deps: MarketServiceDeps,
): MarketService {
  return createMarketService(db, deps)
}

// ── 纯函数：取价规则（供单测，不落库） ──────────────────

export interface QuoteCandidate {
  observedAt: Date
  isVoided: boolean
  priceKind: string
  price: string
  id: string
}

/**
 * 取价纯规则：在候选价点中找 ≤ at 且同价类、未作废的最近点。
 * priceKind 为空时用 defaultKind。
 */
export function resolveQuote(
  candidates: readonly QuoteCandidate[],
  at: Date,
  priceKind: string | null | undefined,
  defaultKind: string,
): QuoteCandidate | null {
  const kind = (priceKind?.trim() ? priceKind.trim() : defaultKind).toLowerCase()
  let best: QuoteCandidate | null = null
  for (const c of candidates) {
    if (c.isVoided) continue
    if (c.priceKind.toLowerCase() !== kind) continue
    if (c.observedAt.getTime() > at.getTime()) continue
    if (!best || c.observedAt.getTime() > best.observedAt.getTime()) best = c
  }
  return best
}

// ── helpers ─────────────────────────────────────────────

function mapInstrument(row: {
  id: string
  code: string
  name: string
  source_type: string
  default_price_kind: string
  active: boolean
  fetch_enabled: boolean
  external_last_code: string | null
  external_product_group: string | null
  note: string | null
  currency_id: string
  unit_id: string
  inserted_at: Date | string
  updated_at: Date | string
}): MarketInstrument {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    sourceType: row.source_type.toUpperCase() as SourceTypeWire,
    defaultPriceKind: row.default_price_kind.toUpperCase() as PriceKindWire,
    active: row.active,
    fetchEnabled: row.fetch_enabled,
    externalLastCode: row.external_last_code,
    externalProductGroup: row.external_product_group,
    note: row.note,
    currencyId: row.currency_id,
    unitId: row.unit_id,
    insertedAt: asUtcTimestamp(row.inserted_at),
    updatedAt: asUtcTimestamp(row.updated_at),
  }
}

function mapPoint(row: {
  id: string
  observed_at: Date | string
  price: string | number
  price_kind: string
  source: string
  is_voided: boolean
  note: string | null
  instrument_id: string
  currency_id: string
  unit_id: string
  inserted_at: Date | string
  updated_at: Date | string
}): MarketPricePoint {
  return {
    id: row.id,
    observedAt: asUtcTimestamp(row.observed_at),
    price: toDecimalString(decimal(String(row.price))),
    priceKind: row.price_kind.toUpperCase() as PriceKindWire,
    source: row.source.toUpperCase() as PriceSourceWire,
    isVoided: row.is_voided,
    note: row.note,
    instrumentId: row.instrument_id,
    currencyId: row.currency_id,
    unitId: row.unit_id,
    insertedAt: asUtcTimestamp(row.inserted_at),
    updatedAt: asUtcTimestamp(row.updated_at),
  }
}

function normalizeInstrument(
  code: string,
  name: string,
  sourceType: string,
  priceKind: string,
): { code: string; name: string; sourceType: string; priceKind: string } {
  code = code.trim()
  name = name.trim()
  sourceType = sourceType.trim().toLowerCase()
  priceKind = priceKind.trim().toLowerCase()
  const fields: Record<string, string[]> = {}
  if (!code || [...code].length > 32) fields.code = ['不能为空且最多 32 个字符']
  if (!name || [...name].length > 64) fields.name = ['不能为空且最多 64 个字符']
  if (sourceType !== 'exchange' && sourceType !== 'spot_index' && sourceType !== 'other') {
    fields.sourceType = ['仅支持 EXCHANGE/SPOT_INDEX/OTHER']
  }
  if (!validPriceKind(priceKind)) {
    fields.defaultPriceKind = ['仅支持 SETTLEMENT/AVERAGE/LAST']
  }
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('行情品种参数不合法', fields)
  }
  return { code, name, sourceType, priceKind }
}

function validPriceKind(value: string): boolean {
  return value === 'settlement' || value === 'average' || value === 'last'
}

function validateOptionalLengths(...values: unknown[]): void {
  const fields: Record<string, string[]> = {}
  for (let i = 0; i < values.length; i += 3) {
    const value = values[i] as string | null | undefined
    const max = values[i + 1] as number
    const field = values[i + 2] as string
    if (value != null && [...value].length > max) {
      fields[field] = [`不能超过 ${max} 个字符`]
    }
  }
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('行情参数不合法', fields)
  }
}

function instrumentSnapshot(x: MarketInstrument): Record<string, unknown> {
  return {
    code: x.code,
    name: x.name,
    source_type: x.sourceType.toLowerCase(),
    default_price_kind: x.defaultPriceKind.toLowerCase(),
    active: x.active,
    fetch_enabled: x.fetchEnabled,
    external_last_code: x.externalLastCode,
    external_product_group: x.externalProductGroup,
    note: x.note,
    currency_id: x.currencyId,
    unit_id: x.unitId,
  }
}

function pointSnapshot(x: MarketPricePoint): Record<string, unknown> {
  return {
    observed_at: x.observedAt.toISOString(),
    price: x.price,
    price_kind: x.priceKind.toLowerCase(),
    source: x.source.toLowerCase(),
    is_voided: x.isVoided,
    note: x.note,
    instrument_id: x.instrumentId,
    currency_id: x.currencyId,
    unit_id: x.unitId,
  }
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value == null) return null
  return value
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

/**
 * bas_market_* 的 timestamp without time zone 语义为 UTC 墙钟（与 Go pgx 一致）。
 * postgres.js 会把无时区 timestamp 按进程本地时区解析成 Date，需把本地墙钟重解为 UTC。
 */
function asUtcTimestamp(value: Date | string): Date {
  if (typeof value === 'string') {
    const normalized = value.includes('T') ? value : value.replace(' ', 'T')
    if (normalized.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(normalized)) {
      return new Date(normalized)
    }
    return new Date(`${normalized}Z`)
  }
  return new Date(
    Date.UTC(
      value.getFullYear(),
      value.getMonth(),
      value.getDate(),
      value.getHours(),
      value.getMinutes(),
      value.getSeconds(),
      value.getMilliseconds(),
    ),
  )
}

/** UTC 墙钟字符串，写入 timestamp without time zone */
function utcWallString(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

function truncateToMinute(now: Date): Date {
  const d = new Date(now.getTime())
  d.setUTCSeconds(0, 0)
  return d
}

function refreshItem(
  instrument: MarketInstrument,
  kind: string,
  status: RefreshItem['status'],
  message: string,
  pricePointId: string | null,
): RefreshItem {
  return {
    instrumentId: instrument.id,
    code: instrument.code,
    kind,
    status,
    message: message === '' ? null : message,
    pricePointId,
  }
}

function summarizeRefresh(label: string, items: RefreshItem[]): string {
  let okCount = 0
  let skippedCount = 0
  let errorCount = 0
  let hint = ''
  for (const item of items) {
    if (item.status === 'ok') okCount++
    else if (item.status === 'skipped') skippedCount++
    else if (item.status === 'error') {
      errorCount++
      if (!hint && item.message) hint = ` 失败例 ${item.code}:${item.message}`
    }
  }
  return `${label}: 成功${okCount} 跳过${skippedCount} 失败${errorCount}${hint}`
}
