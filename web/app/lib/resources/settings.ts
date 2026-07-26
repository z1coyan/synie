import type { components } from '../api/schema'
import { apiClient, apiData } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import { gridMeta } from './meta'
import type { ResourceClient } from './types'

export type SalesSetting = components['schemas']['SalesSetting']
export type ManufacturingSetting = components['schemas']['ManufacturingSetting']
export type AccountingSetting = components['schemas']['AccountingSetting']
export type SystemSetting = components['schemas']['SystemSetting']

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
        await apiData(
          apiClient.GET('/meta/resources/{name}', {
            params: { path: { name: resource } },
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
  return apiData(apiClient.GET('/settings/supply-chain'))
}

export function updateSalesSetting(input: components['schemas']['SalesSettingUpdate']) {
  return apiData(apiClient.PATCH('/settings/supply-chain', { body: input }))
}

export function getManufacturingSetting() {
  return apiData(apiClient.GET('/settings/production'))
}

export function updateManufacturingSetting(
  input: components['schemas']['ManufacturingSettingUpdate'],
) {
  return apiData(apiClient.PATCH('/settings/production', { body: input }))
}

export function getAccountingSetting() {
  return apiData(apiClient.GET('/settings/finance'))
}

export function updateAccountingSetting(input: components['schemas']['AccountingSettingUpdate']) {
  return apiData(apiClient.PATCH('/settings/finance', { body: input }))
}

export function getAccountingOCRConfigured() {
  return apiData(apiClient.GET('/settings/finance/ocr-configured'))
}

export function getSystemSetting() {
  return apiData(apiClient.GET('/settings/system'))
}

export function updateSystemSetting(input: components['schemas']['SystemSettingUpdate']) {
  return apiData(apiClient.PATCH('/settings/system', { body: input }))
}

export const salesSettingClient = singletonClient(
  'salSettings',
  async () => (await getSalesSetting()) as Row,
  async (input) =>
    (await updateSalesSetting(input as components['schemas']['SalesSettingUpdate'])) as Row,
)

export const manufacturingSettingClient = singletonClient(
  'mfgSettings',
  async () => (await getManufacturingSetting()) as Row,
  async (input) =>
    (await updateManufacturingSetting(
      input as components['schemas']['ManufacturingSettingUpdate'],
    )) as Row,
)

export const accountingSettingClient = singletonClient(
  'accSettings',
  async () => (await getAccountingSetting()) as Row,
  async (input) =>
    (await updateAccountingSetting(
      input as components['schemas']['AccountingSettingUpdate'],
    )) as Row,
)

export const systemSettingClient = singletonClient(
  'sysSettings',
  async () => (await getSystemSetting()) as Row,
  async (input) =>
    (await updateSystemSetting(input as components['schemas']['SystemSettingUpdate'])) as Row,
)
