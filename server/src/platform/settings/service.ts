/**
 * 系统设置（sys_setting）+ SettingsService 组合门面。
 * sal/mfg/acc 业务设置声明在各业务域，经 createSettingsService 注入；
 * platform 不 import modules（仅结构类型接收）。
 */
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { withTx } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import { auditDiff, writeAudit } from '../audit/write.ts'
import type { Actor } from '../authz/actor.ts'
import { ApiError } from '../http/errors.ts'
import { createSingleRowSetting } from './single-row.ts'

export interface SalesSetting {
  id: string
  sampleItemMaxQty: number
  deliveryOvershipRatio: string
  spotItemMaxQty: number
  receiptOverreceiveRatio: string
  demandOverorderRatio: string
  insertedAt: Date
  updatedAt: Date
}

export interface ManufacturingSetting {
  id: string
  outputOverreceiveRatio: string
  insertedAt: Date
  updatedAt: Date
}

export interface AccountingSetting {
  id: string
  ocrAccessKeyId: string | null
  insertedAt: Date
  updatedAt: Date
}

export interface SystemSetting {
  id: string
  marketFetchScheduleEnabled: boolean
  marketFetchLastIntervalMinutes: number
  marketFetchSettlementEnabled: boolean
  marketFetchLastRunAt: Date | null
  marketFetchLastSummary: string | null
  insertedAt: Date
  updatedAt: Date
}

export interface SalesUpdate {
  sampleItemMaxQty?: number
  deliveryOvershipRatio?: string
  spotItemMaxQty?: number
  receiptOverreceiveRatio?: string
  demandOverorderRatio?: string
}

export interface ManufacturingUpdate {
  outputOverreceiveRatio?: string
}

export interface AccountingUpdate {
  ocrAccessKeyId?: string | null
  ocrAccessKeyIdPresent?: boolean
  ocrAccessKeySecret?: string
}

export interface SystemUpdate {
  marketFetchScheduleEnabled?: boolean
  marketFetchLastIntervalMinutes?: number
  marketFetchSettlementEnabled?: boolean
}

const SYS_AUDIT = [
  'market_fetch_schedule_enabled',
  'market_fetch_last_interval_minutes',
  'market_fetch_settlement_enabled',
] as const
const SYS_RUN_AUDIT = ['market_fetch_last_run_at', 'market_fetch_last_summary'] as const

/** 业务域设置服务结构（组合根注入；platform 不 import 具体模块） */
export interface SettingsDomainDeps {
  sales: {
    getSales(): Promise<SalesSetting>
    updateSales(actor: Actor, input: SalesUpdate): Promise<SalesSetting>
  }
  manufacturing: {
    getManufacturing(): Promise<ManufacturingSetting>
    updateManufacturing(actor: Actor, input: ManufacturingUpdate): Promise<ManufacturingSetting>
  }
  accounting: {
    getAccounting(): Promise<AccountingSetting>
    updateAccounting(actor: Actor, input: AccountingUpdate): Promise<AccountingSetting>
    ocrConfigured(): Promise<boolean>
  }
}

export function createSystemSettingService(db: Kysely<Database>) {
  const inner = createSingleRowSetting<SystemSetting, SystemUpdate>(db, {
    table: 'sys_setting',
    resource: 'sys_setting',
    notFoundMessage: '系统设置不存在',
    mapRow: mapSys,
    auditFields: SYS_AUDIT,
    merge(before, input) {
      const after: SystemSetting = {
        ...before,
        marketFetchScheduleEnabled:
          input.marketFetchScheduleEnabled ?? before.marketFetchScheduleEnabled,
        marketFetchLastIntervalMinutes:
          input.marketFetchLastIntervalMinutes ?? before.marketFetchLastIntervalMinutes,
        marketFetchSettlementEnabled:
          input.marketFetchSettlementEnabled ?? before.marketFetchSettlementEnabled,
      }
      if (![30, 60, 120].includes(after.marketFetchLastIntervalMinutes)) {
        throw ApiError.validation('最新价拉取间隔仅允许 30/60/120 分钟', {
          marketFetchLastIntervalMinutes: ['仅允许 30、60 或 120'],
        })
      }
      return {
        after,
        set: {
          market_fetch_schedule_enabled: after.marketFetchScheduleEnabled,
          market_fetch_last_interval_minutes: after.marketFetchLastIntervalMinutes,
          market_fetch_settlement_enabled: after.marketFetchSettlementEnabled,
        },
        beforeSnap: sysSnap(before),
        afterSnap: sysSnap(after),
      }
    },
  })

  /** 写入上次行情拉取摘要（手动/定时共用） */
  async function recordMarketFetch(
    actor: Actor | null,
    summary: string,
  ): Promise<SystemSetting | null> {
    const runes = [...summary]
    if (runes.length > 500) summary = runes.slice(0, 500).join('')
    return withTx(db, async (trx) => {
      const row = await trx.selectFrom('sys_setting').selectAll().forUpdate().executeTakeFirst()
      if (!row) return null
      const before = mapSys(row as unknown as Record<string, unknown>)
      const updated = await trx
        .updateTable('sys_setting')
        .set({
          market_fetch_last_run_at: sql`date_trunc('second', now() AT TIME ZONE 'utc')`,
          market_fetch_last_summary: summary,
          updated_at: sql`(now() AT TIME ZONE 'utc')`,
        })
        .where('id', '=', before.id)
        .returningAll()
        .executeTakeFirstOrThrow()
      const after = mapSys(updated as unknown as Record<string, unknown>)
      const changes = auditDiff(sysRunSnap(before), sysRunSnap(after), SYS_RUN_AUDIT)
      if (Object.keys(changes).length > 0) {
        await writeAudit(trx, actor, {
          resource: 'sys_setting',
          recordId: after.id,
          actionType: 'update',
          actionName: 'record_market_fetch',
          changes,
        })
      }
      return after
    })
  }

  return {
    getSystem: () => inner.get(),
    updateSystem: (actor: Actor, input: SystemUpdate) => inner.update(actor, input),
    recordMarketFetch,
  }
}

/**
 * 组合门面：业务域设置 + 系统设置，保持原 SettingsService 形状供 routes/market 使用。
 */
export function createSettingsService(db: Kysely<Database>, domain: SettingsDomainDeps) {
  const system = createSystemSettingService(db)
  return {
    getSales: () => domain.sales.getSales(),
    updateSales: (actor: Actor, input: SalesUpdate) => domain.sales.updateSales(actor, input),
    getManufacturing: () => domain.manufacturing.getManufacturing(),
    updateManufacturing: (actor: Actor, input: ManufacturingUpdate) =>
      domain.manufacturing.updateManufacturing(actor, input),
    getAccounting: () => domain.accounting.getAccounting(),
    updateAccounting: (actor: Actor, input: AccountingUpdate) =>
      domain.accounting.updateAccounting(actor, input),
    ocrConfigured: () => domain.accounting.ocrConfigured(),
    getSystem: () => system.getSystem(),
    updateSystem: (actor: Actor, input: SystemUpdate) => system.updateSystem(actor, input),
    recordMarketFetch: (actor: Actor | null, summary: string) =>
      system.recordMarketFetch(actor, summary),
  }
}

export type SettingsService = ReturnType<typeof createSettingsService>
export type SystemSettingService = ReturnType<typeof createSystemSettingService>

function mapSys(row: Record<string, unknown>): SystemSetting {
  return {
    id: String(row.id),
    marketFetchScheduleEnabled: Boolean(row.market_fetch_schedule_enabled),
    marketFetchLastIntervalMinutes: Number(row.market_fetch_last_interval_minutes),
    marketFetchSettlementEnabled: Boolean(row.market_fetch_settlement_enabled),
    marketFetchLastRunAt: row.market_fetch_last_run_at
      ? asDate(row.market_fetch_last_run_at as Date | string)
      : null,
    marketFetchLastSummary: (row.market_fetch_last_summary as string | null) ?? null,
    insertedAt: asDate(row.inserted_at as Date | string),
    updatedAt: asDate(row.updated_at as Date | string),
  }
}

function sysSnap(v: SystemSetting): Record<string, unknown> {
  return {
    market_fetch_schedule_enabled: v.marketFetchScheduleEnabled,
    market_fetch_last_interval_minutes: v.marketFetchLastIntervalMinutes,
    market_fetch_settlement_enabled: v.marketFetchSettlementEnabled,
  }
}

function sysRunSnap(v: SystemSetting): Record<string, unknown> {
  return {
    market_fetch_last_run_at: v.marketFetchLastRunAt ? v.marketFetchLastRunAt.toISOString() : null,
    market_fetch_last_summary: v.marketFetchLastSummary,
  }
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}
