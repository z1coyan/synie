/**
 * 供应链设置（sal_setting）：样品/超发/零星/超收/需求超下单。
 * 使用 platform createSingleRowSetting 引擎。
 */
import { Decimal, decimal, isDecimalString, toDecimalString } from '@synie/shared'
import type { Kysely } from 'kysely'
import type { DB as Database } from '~/db/types.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { ResourceMeta } from '~/platform/meta/types.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { createSingleRowSetting } from '~/platform/settings/single-row.ts'

export const SALES_RESOURCE_NAME = 'salSettings'

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

export interface SalesUpdate {
  sampleItemMaxQty?: number
  deliveryOvershipRatio?: string
  spotItemMaxQty?: number
  receiptOverreceiveRatio?: string
  demandOverorderRatio?: string
}

const SALES_AUDIT = [
  'sample_item_max_qty',
  'delivery_overship_ratio',
  'spot_item_max_qty',
  'receipt_overreceive_ratio',
  'demand_overorder_ratio',
] as const

export function salesResourceMeta(): ResourceMeta {
  return {
    name: SALES_RESOURCE_NAME,
    permissionPrefix: 'sales.setting',
    permissionLabel: '供应链设置',
    table: 'sal_setting',
    fields: [
      field('id', 'id', 'uuid', 'id', true, false),
      field('sample_item_max_qty', 'sampleItemMaxQty', 'integer', '样品订单条目数量上限', true, true),
      field(
        'delivery_overship_ratio',
        'deliveryOvershipRatio',
        'decimal',
        '发货超发比例(小数,0=禁超发,0.05=5%,上限 1)',
        true,
        true,
      ),
      field('spot_item_max_qty', 'spotItemMaxQty', 'integer', '零星订单条目数量上限', true, true),
      field(
        'receipt_overreceive_ratio',
        'receiptOverreceiveRatio',
        'decimal',
        '入库超收比例(小数,0=禁超收,0.05=5%,上限 1)',
        true,
        true,
      ),
      field(
        'demand_overorder_ratio',
        'demandOverorderRatio',
        'decimal',
        '需求超下单比例(小数,0=禁超下单,0.05=5%,上限 1)',
        true,
        true,
      ),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', true, true),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', true, true),
    ],
    print: true,
    printHead: true,
    audit: { enabled: true },
    actions: [
      { key: 'read', label: '查看', scope: 'both' },
      { key: 'update', label: '编辑', scope: 'row' },
    ],
    form: { exclude: ['id', 'insertedAt', 'updatedAt'] },
  }
}

export function registerTradingSettingResources(registry: Registry): void {
  registry.register(salesResourceMeta())
}

export function createSalesSettingService(db: Kysely<Database>) {
  const inner = createSingleRowSetting<SalesSetting, SalesUpdate>(db, {
    table: 'sal_setting',
    resource: 'sal_setting',
    notFoundMessage: '供应链设置不存在',
    mapRow: mapSales,
    auditFields: SALES_AUDIT,
    merge(before, input) {
      const after: SalesSetting = {
        ...before,
        sampleItemMaxQty: input.sampleItemMaxQty ?? before.sampleItemMaxQty,
        deliveryOvershipRatio: input.deliveryOvershipRatio ?? before.deliveryOvershipRatio,
        spotItemMaxQty: input.spotItemMaxQty ?? before.spotItemMaxQty,
        receiptOverreceiveRatio: input.receiptOverreceiveRatio ?? before.receiptOverreceiveRatio,
        demandOverorderRatio: input.demandOverorderRatio ?? before.demandOverorderRatio,
      }
      validateSales(after)
      return {
        after,
        set: {
          sample_item_max_qty: after.sampleItemMaxQty,
          delivery_overship_ratio: after.deliveryOvershipRatio,
          spot_item_max_qty: after.spotItemMaxQty,
          receipt_overreceive_ratio: after.receiptOverreceiveRatio,
          demand_overorder_ratio: after.demandOverorderRatio,
        },
        beforeSnap: salesSnap(before),
        afterSnap: salesSnap(after),
      }
    },
  })
  return {
    getSales: () => inner.get(),
    updateSales: (actor: Parameters<typeof inner.update>[0], input: SalesUpdate) =>
      inner.update(actor, input),
  }
}

export type SalesSettingService = ReturnType<typeof createSalesSettingService>

function field(
  dbName: string,
  apiName: string,
  type: ResourceMeta['fields'][number]['type'],
  label: string,
  sortable: boolean,
  filterable: boolean,
): ResourceMeta['fields'][number] {
  return {
    name: dbName,
    apiName,
    dbColumn: dbName,
    type,
    label,
    sortable,
    filterable,
  }
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

function validateRatio(fieldName: string, label: string, value: string): void {
  if (!isDecimalString(value)) {
    throw ApiError.validation('小数格式不合法', { [fieldName]: ['必须是十进制字符串'] })
  }
  const d = decimal(value)
  if (d.isNegative() || d.greaterThan(1)) {
    throw ApiError.validation(`${label}须在 0 到 1 之间`, { [fieldName]: ['须在 0 到 1 之间'] })
  }
}

function mapSales(row: Record<string, unknown>): SalesSetting {
  return {
    id: String(row.id),
    sampleItemMaxQty: Number(row.sample_item_max_qty),
    deliveryOvershipRatio: wireDecimal(row.delivery_overship_ratio as string | number),
    spotItemMaxQty: Number(row.spot_item_max_qty),
    receiptOverreceiveRatio: wireDecimal(row.receipt_overreceive_ratio as string | number),
    demandOverorderRatio: wireDecimal(row.demand_overorder_ratio as string | number),
    insertedAt: asDate(row.inserted_at as Date | string),
    updatedAt: asDate(row.updated_at as Date | string),
  }
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

function wireDecimal(value: string | number | Decimal): string {
  return toDecimalString(decimal(value))
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}
