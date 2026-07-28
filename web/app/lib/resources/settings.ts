import { api, apiData } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import { gridMeta } from './meta'
import type { ResourceClient } from './types'

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

export interface AccountingSetting {
  id: string
  ocrAccessKeyId?: string | null
  insertedAt: string
  updatedAt: string
}

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

type SingletonGetter = () => Promise<Row>
type SingletonUpdater = (input: Record<string, unknown>) => Promise<Row>

function singletonClient(
  resource: string,
  get: SingletonGetter,
  update: SingletonUpdater,
): ResourceClient {
  return {
    id: `rest:${resource}`,
    async meta() {
      return gridMeta(
      await apiData<import("@synie/shared").ResourceMetaDocument>(
        api.meta.resources[':name'].$get({
            param: { name: resource },
          }),
        ),
      )
    },
    async query() {
      const value = await get()
      return { count: 1, results: [value] }
    },
    async get(id) {
      const value = await get()
      return value.id === id ? value : null
    },
    async create() {
      throw new Error('全局单行设置不支持新增')
    },
    update(_id, input) {
      return update(input)
    },
    async delete() {
      throw new Error('全局单行设置不支持删除')
    },
  }
}

export function getSalesSetting() {
  return apiData<SalesSetting>(api.settings['supply-chain'].$get())
}

export function updateSalesSetting(input: Record<string, unknown>) {
  return apiData<SalesSetting>(api.settings['supply-chain'].$patch({ json: input as never }))
}

export function getManufacturingSetting() {
  return apiData<ManufacturingSetting>(api.settings.production.$get())
}

export function updateManufacturingSetting(input: Record<string, unknown>) {
  return apiData<ManufacturingSetting>(api.settings.production.$patch({ json: input as never }))
}

export function getAccountingSetting() {
  return apiData<AccountingSetting>(api.settings.finance.$get())
}

export function updateAccountingSetting(input: Record<string, unknown>) {
  return apiData<AccountingSetting>(api.settings.finance.$patch({ json: input as never }))
}

export function getAccountingOCRConfigured() {
  return apiData<{ configured: boolean }>(api.settings.finance['ocr-configured'].$get())
}

export function getSystemSetting() {
  return apiData<SystemSetting>(api.settings.system.$get())
}

export function updateSystemSetting(input: Record<string, unknown>) {
  return apiData<SystemSetting>(api.settings.system.$patch({ json: input as never }))
}

export const salesSettingClient = singletonClient(
  'salSettings',
  async () => (await getSalesSetting()) as unknown as Row,
  async (input) => (await updateSalesSetting(input)) as unknown as Row,
)

export const manufacturingSettingClient = singletonClient(
  'mfgSettings',
  async () => (await getManufacturingSetting()) as unknown as Row,
  async (input) => (await updateManufacturingSetting(input)) as unknown as Row,
)

export const accountingSettingClient = singletonClient(
  'accSettings',
  async () => (await getAccountingSetting()) as unknown as Row,
  async (input) => (await updateAccountingSetting(input)) as unknown as Row,
)

export const systemSettingClient = singletonClient(
  'sysSettings',
  async () => (await getSystemSetting()) as unknown as Row,
  async (input) => (await updateSystemSetting(input)) as unknown as Row,
)
