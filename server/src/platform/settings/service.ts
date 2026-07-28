import { Decimal, decimal, isDecimalString, toDecimalString } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { withTx } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import { auditDiff, writeAudit } from '../audit/write.ts'
import type { Actor } from '../authz/actor.ts'
import { ApiError } from '../http/errors.ts'
import { allSettingResourceMetas } from './meta.ts'

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

const SALES_AUDIT = [
  'sample_item_max_qty',
  'delivery_overship_ratio',
  'spot_item_max_qty',
  'receipt_overreceive_ratio',
  'demand_overorder_ratio',
] as const
const MFG_AUDIT = ['output_overreceive_ratio'] as const
const ACC_AUDIT = ['ocr_access_key_id', 'ocr_access_key_secret'] as const
const SYS_AUDIT = [
  'market_fetch_schedule_enabled',
  'market_fetch_last_interval_minutes',
  'market_fetch_settlement_enabled',
] as const

export function createSettingsService(db: Kysely<Database>) {
  async function getSales(): Promise<SalesSetting> {
    const row = await db.selectFrom('sal_setting').selectAll().executeTakeFirst()
    if (!row) throw new ApiError('not_found', '供应链设置不存在')
    return mapSales(row)
  }

  async function getManufacturing(): Promise<ManufacturingSetting> {
    const row = await db.selectFrom('mfg_setting').selectAll().executeTakeFirst()
    if (!row) throw new ApiError('not_found', '生产设置不存在')
    return mapMfg(row)
  }

  async function getAccounting(): Promise<AccountingSetting> {
    const row = await db.selectFrom('acc_setting').selectAll().executeTakeFirst()
    if (!row) throw new ApiError('not_found', '财务设置不存在')
    return mapAcc(row)
  }

  async function getSystem(): Promise<SystemSetting> {
    const row = await db.selectFrom('sys_setting').selectAll().executeTakeFirst()
    if (!row) throw new ApiError('not_found', '系统设置不存在')
    return mapSys(row)
  }

  async function ocrConfigured(): Promise<boolean> {
    const row = await db
      .selectFrom('acc_setting')
      .select(['ocr_access_key_id', 'ocr_access_key_secret'])
      .executeTakeFirst()
    if (!row) return false
    return !!(row.ocr_access_key_id?.trim() && row.ocr_access_key_secret?.trim())
  }

  async function updateSales(actor: Actor, input: SalesUpdate): Promise<SalesSetting> {
    return withTx(db, async (trx) => {
      const row = await trx.selectFrom('sal_setting').selectAll().forUpdate().executeTakeFirst()
      if (!row) throw new ApiError('not_found', '供应链设置不存在')
      const before = mapSales(row)
      const after: SalesSetting = {
        ...before,
        sampleItemMaxQty: input.sampleItemMaxQty ?? before.sampleItemMaxQty,
        deliveryOvershipRatio: input.deliveryOvershipRatio ?? before.deliveryOvershipRatio,
        spotItemMaxQty: input.spotItemMaxQty ?? before.spotItemMaxQty,
        receiptOverreceiveRatio: input.receiptOverreceiveRatio ?? before.receiptOverreceiveRatio,
        demandOverorderRatio: input.demandOverorderRatio ?? before.demandOverorderRatio,
      }
      validateSales(after)
      const changes = auditDiff(salesSnap(before), salesSnap(after), SALES_AUDIT)
      if (Object.keys(changes).length === 0) return before
      const updated = await trx
        .updateTable('sal_setting')
        .set({
          sample_item_max_qty: after.sampleItemMaxQty,
          delivery_overship_ratio: after.deliveryOvershipRatio,
          spot_item_max_qty: after.spotItemMaxQty,
          receipt_overreceive_ratio: after.receiptOverreceiveRatio,
          demand_overorder_ratio: after.demandOverorderRatio,
          updated_at: sql`(now() AT TIME ZONE 'utc')`,
        })
        .where('id', '=', after.id)
        .returningAll()
        .executeTakeFirstOrThrow()
      const result = mapSales(updated)
      await writeAudit(trx, actor, {
        resource: 'sal_setting',
        recordId: result.id,
        actionType: 'update',
        actionName: 'update',
        changes,
      })
      return result
    })
  }

  async function updateManufacturing(actor: Actor, input: ManufacturingUpdate): Promise<ManufacturingSetting> {
    return withTx(db, async (trx) => {
      const row = await trx.selectFrom('mfg_setting').selectAll().forUpdate().executeTakeFirst()
      if (!row) throw new ApiError('not_found', '生产设置不存在')
      const before = mapMfg(row)
      const after: ManufacturingSetting = {
        ...before,
        outputOverreceiveRatio: input.outputOverreceiveRatio ?? before.outputOverreceiveRatio,
      }
      validateRatio('outputOverreceiveRatio', '生产入库超入比例', after.outputOverreceiveRatio)
      const changes = auditDiff(mfgSnap(before), mfgSnap(after), MFG_AUDIT)
      if (Object.keys(changes).length === 0) return before
      const updated = await trx
        .updateTable('mfg_setting')
        .set({
          output_overreceive_ratio: after.outputOverreceiveRatio,
          updated_at: sql`(now() AT TIME ZONE 'utc')`,
        })
        .where('id', '=', after.id)
        .returningAll()
        .executeTakeFirstOrThrow()
      const result = mapMfg(updated)
      await writeAudit(trx, actor, {
        resource: 'mfg_setting',
        recordId: result.id,
        actionType: 'update',
        actionName: 'update',
        changes,
      })
      return result
    })
  }

  async function updateAccounting(actor: Actor, input: AccountingUpdate): Promise<AccountingSetting> {
    return withTx(db, async (trx) => {
      const row = await trx.selectFrom('acc_setting').selectAll().forUpdate().executeTakeFirst()
      if (!row) throw new ApiError('not_found', '财务设置不存在')
      const before = mapAcc(row)
      let keyId = before.ocrAccessKeyId
      let secret = row.ocr_access_key_secret
      if (input.ocrAccessKeyIdPresent) {
        keyId = input.ocrAccessKeyId ?? null
      }
      if (input.ocrAccessKeySecret !== undefined && input.ocrAccessKeySecret !== '') {
        secret = input.ocrAccessKeySecret
      }
      if (keyId !== null && [...keyId].length > 128) {
        throw ApiError.validation('OCR AccessKey ID 不能超过 128 个字符', {
          ocrAccessKeyId: ['不能超过 128 个字符'],
        })
      }
      if (secret !== null && [...secret].length > 128) {
        throw ApiError.validation('OCR AccessKey Secret 不能超过 128 个字符', {
          ocrAccessKeySecret: ['不能超过 128 个字符'],
        })
      }
      const after: AccountingSetting = { ...before, ocrAccessKeyId: keyId }
      const beforeSnap = accSnap(before, row.ocr_access_key_secret)
      const afterSnap = accSnap(after, secret)
      const changes = auditDiff(beforeSnap, afterSnap, ACC_AUDIT)
      if (Object.keys(changes).length === 0) return before
      const updated = await trx
        .updateTable('acc_setting')
        .set({
          ocr_access_key_id: keyId,
          ocr_access_key_secret: secret,
          updated_at: sql`(now() AT TIME ZONE 'utc')`,
        })
        .where('id', '=', after.id)
        .returningAll()
        .executeTakeFirstOrThrow()
      const result = mapAcc(updated)
      await writeAudit(trx, actor, {
        resource: 'acc_setting',
        recordId: result.id,
        actionType: 'update',
        actionName: 'update',
        changes,
        sensitiveFields: sensitiveFieldsFor('acc_setting'),
      })
      return result
    })
  }

  async function updateSystem(actor: Actor, input: SystemUpdate): Promise<SystemSetting> {
    return withTx(db, async (trx) => {
      const row = await trx.selectFrom('sys_setting').selectAll().forUpdate().executeTakeFirst()
      if (!row) throw new ApiError('not_found', '系统设置不存在')
      const before = mapSys(row)
      const after: SystemSetting = {
        ...before,
        marketFetchScheduleEnabled: input.marketFetchScheduleEnabled ?? before.marketFetchScheduleEnabled,
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
      const changes = auditDiff(sysSnap(before), sysSnap(after), SYS_AUDIT)
      if (Object.keys(changes).length === 0) return before
      const updated = await trx
        .updateTable('sys_setting')
        .set({
          market_fetch_schedule_enabled: after.marketFetchScheduleEnabled,
          market_fetch_last_interval_minutes: after.marketFetchLastIntervalMinutes,
          market_fetch_settlement_enabled: after.marketFetchSettlementEnabled,
          updated_at: sql`(now() AT TIME ZONE 'utc')`,
        })
        .where('id', '=', after.id)
        .returningAll()
        .executeTakeFirstOrThrow()
      const result = mapSys(updated)
      await writeAudit(trx, actor, {
        resource: 'sys_setting',
        recordId: result.id,
        actionType: 'update',
        actionName: 'update',
        changes,
      })
      return result
    })
  }

  return {
    getSales,
    getManufacturing,
    getAccounting,
    getSystem,
    ocrConfigured,
    updateSales,
    updateManufacturing,
    updateAccounting,
    updateSystem,
  }
}

export type SettingsService = ReturnType<typeof createSettingsService>

function sensitiveFieldsFor(table: string): string[] | undefined {
  for (const meta of allSettingResourceMetas()) {
    if (meta.table === table) return meta.audit?.sensitiveFields
  }
  return undefined
}

function validateSales(value: SalesSetting): void {
  if (value.sampleItemMaxQty <= 0) {
    throw ApiError.validation('样品条目数量上限必须大于零', { sampleItemMaxQty: ['必须大于零'] })
  }
  if (value.spotItemMaxQty <= 0) {
    throw ApiError.validation('零星条目数量上限必须大于零', { spotItemMaxQty: ['必须大于零'] })
  }
  validateRatio('deliveryOvershipRatio', '发货超发比例', value.deliveryOvershipRatio)
  validateRatio('receiptOverreceiveRatio', '入库超收比例', value.receiptOverreceiveRatio)
  validateRatio('demandOverorderRatio', '需求超下单比例', value.demandOverorderRatio)
}

function validateRatio(field: string, label: string, value: string): void {
  if (!isDecimalString(value)) {
    throw ApiError.validation('小数格式不合法', { [field]: ['必须是十进制字符串'] })
  }
  const d = decimal(value)
  if (d.isNegative() || d.greaterThan(1)) {
    throw ApiError.validation(`${label}须在 0 到 1 之间`, { [field]: ['须在 0 到 1 之间'] })
  }
}

function mapSales(row: {
  id: string
  sample_item_max_qty: string | number | bigint
  delivery_overship_ratio: string
  spot_item_max_qty: string | number | bigint
  receipt_overreceive_ratio: string
  demand_overorder_ratio: string
  inserted_at: Date | string
  updated_at: Date | string
}): SalesSetting {
  return {
    id: row.id,
    sampleItemMaxQty: Number(row.sample_item_max_qty),
    deliveryOvershipRatio: wireDecimal(row.delivery_overship_ratio),
    spotItemMaxQty: Number(row.spot_item_max_qty),
    receiptOverreceiveRatio: wireDecimal(row.receipt_overreceive_ratio),
    demandOverorderRatio: wireDecimal(row.demand_overorder_ratio),
    insertedAt: asDate(row.inserted_at),
    updatedAt: asDate(row.updated_at),
  }
}

function mapMfg(row: {
  id: string
  output_overreceive_ratio: string
  inserted_at: Date | string
  updated_at: Date | string
}): ManufacturingSetting {
  return {
    id: row.id,
    outputOverreceiveRatio: wireDecimal(row.output_overreceive_ratio),
    insertedAt: asDate(row.inserted_at),
    updatedAt: asDate(row.updated_at),
  }
}

function mapAcc(row: {
  id: string
  ocr_access_key_id: string | null
  inserted_at: Date | string
  updated_at: Date | string
}): AccountingSetting {
  return {
    id: row.id,
    ocrAccessKeyId: row.ocr_access_key_id,
    insertedAt: asDate(row.inserted_at),
    updatedAt: asDate(row.updated_at),
  }
}

function mapSys(row: {
  id: string
  market_fetch_schedule_enabled: boolean
  market_fetch_last_interval_minutes: number
  market_fetch_settlement_enabled: boolean
  market_fetch_last_run_at: Date | string | null
  market_fetch_last_summary: string | null
  inserted_at: Date | string
  updated_at: Date | string
}): SystemSetting {
  return {
    id: row.id,
    marketFetchScheduleEnabled: row.market_fetch_schedule_enabled,
    marketFetchLastIntervalMinutes: row.market_fetch_last_interval_minutes,
    marketFetchSettlementEnabled: row.market_fetch_settlement_enabled,
    marketFetchLastRunAt: row.market_fetch_last_run_at ? asDate(row.market_fetch_last_run_at) : null,
    marketFetchLastSummary: row.market_fetch_last_summary,
    insertedAt: asDate(row.inserted_at),
    updatedAt: asDate(row.updated_at),
  }
}

function wireDecimal(value: string | number | Decimal): string {
  return toDecimalString(decimal(value))
}

function salesSnap(v: SalesSetting): Record<string, unknown> {
  return {
    sample_item_max_qty: v.sampleItemMaxQty,
    delivery_overship_ratio: v.deliveryOvershipRatio,
    spot_item_max_qty: v.spotItemMaxQty,
    receipt_overreceive_ratio: v.receiptOverreceiveRatio,
    demand_overorder_ratio: v.demandOverorderRatio,
  }
}

function mfgSnap(v: ManufacturingSetting): Record<string, unknown> {
  return { output_overreceive_ratio: v.outputOverreceiveRatio }
}

function accSnap(v: AccountingSetting, secret: string | null): Record<string, unknown> {
  return {
    ocr_access_key_id: v.ocrAccessKeyId,
    ocr_access_key_secret: secret,
  }
}

function sysSnap(v: SystemSetting): Record<string, unknown> {
  return {
    market_fetch_schedule_enabled: v.marketFetchScheduleEnabled,
    market_fetch_last_interval_minutes: v.marketFetchLastIntervalMinutes,
    market_fetch_settlement_enabled: v.marketFetchSettlementEnabled,
  }
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}
