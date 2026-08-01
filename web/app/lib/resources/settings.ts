import type { Row } from '~/components/synie-data-grid/types'
import type { ResourceClient } from './types'
import { financeOcrConfigured } from './finance-operations'
import { unboundResourceClient } from './unbound'

export interface SalesSetting {
  id: string
  sampleItemMaxQty: number
  deliveryOvershipRatio: string
  spotItemMaxQty: number
  receiptOverreceiveRatio: string
  demandOverorderRatio: string
  insertedAt: string
  updatedAt: string
}

export interface ManufacturingSetting {
  id: string
  outputOverreceiveRatio: string
  insertedAt: string
  updatedAt: string
}

export interface AccountingSetting { id: string; insertedAt: string; updatedAt: string }

export interface SystemSetting {
  id: string
  marketFetchScheduleEnabled: boolean
  marketFetchLastIntervalMinutes: 30 | 60 | 120
  marketFetchSettlementEnabled: boolean
  marketFetchLastRunAt?: string | null
  marketFetchLastSummary?: string | null
  insertedAt: string
  updatedAt: string
}

export const salesSettingClient = unboundResourceClient('salSettings')
export const manufacturingSettingClient = unboundResourceClient('mfgSettings')
export const accountingSettingClient = unboundResourceClient('accSettings')
export const systemSettingClient = unboundResourceClient('sysSettings')

async function singleton<T>(client: ResourceClient): Promise<T> {
  const page = await client.query({ profile: 'default', numItems: 1, cursor: null })
  const row = page.results[0]
  if (!row) throw new Error('设置尚未初始化')
  return row as T
}

async function updateSingleton<T>(client: ResourceClient, input: Record<string, unknown>): Promise<T> {
  const current = await singleton<Row>(client)
  if (!client.update) throw new Error('设置不支持更新')
  return await client.update(current.id, input) as T
}

export const getSalesSetting = () => singleton<SalesSetting>(salesSettingClient)
export const updateSalesSetting = (input: Record<string, unknown>) =>
  updateSingleton<SalesSetting>(salesSettingClient, input)
export const getManufacturingSetting = () => singleton<ManufacturingSetting>(manufacturingSettingClient)
export const updateManufacturingSetting = (input: Record<string, unknown>) =>
  updateSingleton<ManufacturingSetting>(manufacturingSettingClient, input)
export const getAccountingSetting = () => singleton<AccountingSetting>(accountingSettingClient)
export const updateAccountingSetting = (input: Record<string, unknown>) =>
  updateSingleton<AccountingSetting>(accountingSettingClient, input)
export const getSystemSetting = () => singleton<SystemSetting>(systemSettingClient)
export const updateSystemSetting = (input: Record<string, unknown>) =>
  updateSingleton<SystemSetting>(systemSettingClient, input)
export const getAccountingOCRConfigured = () => financeOcrConfigured()
