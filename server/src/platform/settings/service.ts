/**
 * 系统设置（sys_setting）+ SettingsService 组合门面。
 * sal/mfg/acc 业务设置声明在各业务域，经 createSettingsService 注入；
 * platform 不 import modules（仅结构类型接收）。
 *
 * 授权由平台承担：路由挂 `guard(资源, 动作)`，本门面只收 Permit；
 * 调度/行情拉取链路的受信任读写走 `systemPermit`（spec §4，杀 null-actor 分支）。
 */
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { withTx } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import { auditDiff, writeAudit } from '../audit/write.ts'
import { auditFieldsOf, pickAuditFields } from '../audit/spec.ts'
import { SYS_RESOURCE_NAME, systemResourceMeta } from './meta.ts'
import type { Permit } from '../authz/core/index.ts'
import { systemPermit } from '../authz/core/index.ts'
import { ApiError } from '../http/errors.ts'
import { createSingleRowSetting } from './single-row.ts'
import { asDate } from '~/db/dates.ts'

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
  moldCategoryId: string | null
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
  fileReconLastRunAt: Date | null
  fileReconLastSummary: string | null
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

const SYS_AUDIT_ALL = auditFieldsOf(systemResourceMeta())
/** 行情拉取运行记录（record_market_fetch）动作的局部审计面 */
const SYS_RUN_AUDIT = pickAuditFields(SYS_AUDIT_ALL, [
  'market_fetch_last_run_at',
  'market_fetch_last_summary',
])
/** 文件存储对账运行记录（record_file_recon）动作的局部审计面 */
const SYS_FILE_RECON_AUDIT = pickAuditFields(SYS_AUDIT_ALL, [
  'file_recon_last_run_at',
  'file_recon_last_summary',
])
/** 系统设置常规更新审计面 = meta 全量白名单 − 运行记录字段 */
const SYS_AUDIT = SYS_AUDIT_ALL.filter(
  (name) => !SYS_RUN_AUDIT.includes(name) && !SYS_FILE_RECON_AUDIT.includes(name),
)

/** 业务域设置服务结构（组合根注入；platform 不 import 具体模块） */
export interface SettingsDomainDeps {
  sales: {
    getSales(permit: Permit): Promise<SalesSetting>
    updateSales(permit: Permit, input: SalesUpdate): Promise<SalesSetting>
  }
  manufacturing: {
    getManufacturing(permit: Permit): Promise<ManufacturingSetting>
    updateManufacturing(permit: Permit, input: ManufacturingUpdate): Promise<ManufacturingSetting>
  }
  accounting: {
    getAccounting(permit: Permit): Promise<AccountingSetting>
    updateAccounting(permit: Permit, input: AccountingUpdate): Promise<AccountingSetting>
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

  /** 调度运行摘要的共用写入器（行情拉取 / 文件对账同构：行锁 + 截断 + 局部审计） */
  function createRunRecorder(
    columns: { runAt: 'market_fetch_last_run_at' | 'file_recon_last_run_at'; summary: 'market_fetch_last_summary' | 'file_recon_last_summary' },
    auditFields: readonly string[],
    actionName: string,
    snap: (v: SystemSetting) => Record<string, unknown>,
  ) {
    return async function record(permit: Permit, summary: string): Promise<SystemSetting | null> {
      const runes = [...summary]
      if (runes.length > 500) summary = runes.slice(0, 500).join('')
      return withTx(db, async (trx) => {
        const row = await trx.selectFrom('sys_setting').selectAll().forUpdate().executeTakeFirst()
        if (!row) return null
        const before = mapSys(row as unknown as Record<string, unknown>)
        const updated = await trx
          .updateTable('sys_setting')
          .set({
            [columns.runAt]: sql`date_trunc('second', now() AT TIME ZONE 'utc')`,
            [columns.summary]: summary,
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', before.id)
          .returningAll()
          .executeTakeFirstOrThrow()
        const after = mapSys(updated as unknown as Record<string, unknown>)
        const changes = auditDiff(snap(before), snap(after), auditFields)
        if (Object.keys(changes).length > 0) {
          await writeAudit(trx, permit.actor, {
            resource: 'sys_setting',
            recordId: after.id,
            actionType: 'update',
            actionName,
            changes,
          })
        }
        return after
      })
    }
  }

  /** 写入上次行情拉取摘要（手动/定时共用；定时侧传 systemPermit） */
  const recordMarketFetch = createRunRecorder(
    { runAt: 'market_fetch_last_run_at', summary: 'market_fetch_last_summary' },
    SYS_RUN_AUDIT,
    'record_market_fetch',
    sysRunSnap,
  )

  /** 写入上次文件存储对账摘要（jobs/filesclean 调度侧传 systemPermit） */
  const recordFileRecon = createRunRecorder(
    { runAt: 'file_recon_last_run_at', summary: 'file_recon_last_summary' },
    SYS_FILE_RECON_AUDIT,
    'record_file_recon',
    sysFileReconSnap,
  )

  return {
    getSystem: (permit: Permit) => inner.get(permit),
    /** 调度/行情拉取的受信任配置读：主体显式为 system（不再是裸函数约定） */
    loadSystemConfig: () => inner.load(systemPermit(SYS_RESOURCE_NAME, 'read')),
    updateSystem: (permit: Permit, input: SystemUpdate) => inner.update(permit, input),
    recordMarketFetch,
    recordFileRecon,
  }
}

/**
 * 组合门面：业务域设置 + 系统设置，保持原 SettingsService 形状供 routes/market 使用。
 */
export function createSettingsService(db: Kysely<Database>, domain: SettingsDomainDeps) {
  const system = createSystemSettingService(db)
  return {
    getSales: (permit: Permit) => domain.sales.getSales(permit),
    updateSales: (permit: Permit, input: SalesUpdate) => domain.sales.updateSales(permit, input),
    getManufacturing: (permit: Permit) => domain.manufacturing.getManufacturing(permit),
    updateManufacturing: (permit: Permit, input: ManufacturingUpdate) =>
      domain.manufacturing.updateManufacturing(permit, input),
    getAccounting: (permit: Permit) => domain.accounting.getAccounting(permit),
    updateAccounting: (permit: Permit, input: AccountingUpdate) =>
      domain.accounting.updateAccounting(permit, input),
    ocrConfigured: () => domain.accounting.ocrConfigured(),
    getSystem: (permit: Permit) => system.getSystem(permit),
    /** 调度/行情拉取的受信任配置读：主体显式为 system */
    loadSystemConfig: () => system.loadSystemConfig(),
    updateSystem: (permit: Permit, input: SystemUpdate) => system.updateSystem(permit, input),
    recordMarketFetch: (permit: Permit, summary: string) =>
      system.recordMarketFetch(permit, summary),
    /** 文件存储对账摘要（jobs/filesclean 调度侧传 systemPermit） */
    recordFileRecon: (permit: Permit, summary: string) =>
      system.recordFileRecon(permit, summary),
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
    fileReconLastRunAt: row.file_recon_last_run_at
      ? asDate(row.file_recon_last_run_at as Date | string)
      : null,
    fileReconLastSummary: (row.file_recon_last_summary as string | null) ?? null,
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

function sysFileReconSnap(v: SystemSetting): Record<string, unknown> {
  return {
    file_recon_last_run_at: v.fileReconLastRunAt ? v.fileReconLastRunAt.toISOString() : null,
    file_recon_last_summary: v.fileReconLastSummary,
  }
}

