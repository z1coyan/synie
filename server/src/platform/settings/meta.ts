import type { ResourceMeta } from '../meta/types.ts'

export const SALES_RESOURCE_NAME = 'salSettings'
export const MFG_RESOURCE_NAME = 'mfgSettings'
export const ACC_RESOURCE_NAME = 'accSettings'
export const SYS_RESOURCE_NAME = 'sysSettings'

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

function settingMeta(
  name: string,
  prefix: string,
  label: string,
  table: string,
  fields: ResourceMeta['fields'],
  exclude: string[],
  extras?: Partial<ResourceMeta>,
): ResourceMeta {
  return {
    name,
    permissionPrefix: prefix,
    permissionLabel: label,
    table,
    fields,
    print: true,
    audit: { enabled: true },
    actions: [
      { key: 'read', label: '查看', scope: 'both' },
      { key: 'update', label: '编辑', scope: 'row' },
    ],
    form: { exclude },
    ...extras,
  }
}

export function salesResourceMeta(): ResourceMeta {
  return settingMeta(
    SALES_RESOURCE_NAME,
    'sales.setting',
    '供应链设置',
    'sal_setting',
    [
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
    ['id', 'insertedAt', 'updatedAt'],
    { printHead: true },
  )
}

export function manufacturingResourceMeta(): ResourceMeta {
  return settingMeta(
    MFG_RESOURCE_NAME,
    'mfg.setting',
    '生产设置',
    'mfg_setting',
    [
      field('id', 'id', 'uuid', 'id', true, false),
      field(
        'output_overreceive_ratio',
        'outputOverreceiveRatio',
        'decimal',
        '生产入库超入比例(小数,0=禁超入,0.05=5%,上限 1)',
        true,
        true,
      ),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', true, true),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', true, true),
    ],
    ['id', 'insertedAt', 'updatedAt'],
  )
}

export function accountingResourceMeta(): ResourceMeta {
  const meta = settingMeta(
    ACC_RESOURCE_NAME,
    'acc.setting',
    '财务设置',
    'acc_setting',
    [
      field('id', 'id', 'uuid', 'id', true, false),
      field('ocr_access_key_id', 'ocrAccessKeyId', 'string', '阿里云 OCR AccessKey ID', true, true),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', true, true),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', true, true),
    ],
    ['id', 'insertedAt', 'updatedAt'],
  )
  meta.audit = { enabled: true, sensitiveFields: ['ocr_access_key_secret'] }
  return meta
}

export function systemResourceMeta(): ResourceMeta {
  return settingMeta(
    SYS_RESOURCE_NAME,
    'sys.setting',
    '系统设置',
    'sys_setting',
    [
      field('id', 'id', 'uuid', 'id', true, false),
      field(
        'market_fetch_schedule_enabled',
        'marketFetchScheduleEnabled',
        'boolean',
        '启用行情定时拉取',
        true,
        true,
      ),
      field(
        'market_fetch_last_interval_minutes',
        'marketFetchLastIntervalMinutes',
        'integer',
        '最新价拉取间隔(分钟,30/60/120)',
        true,
        true,
      ),
      field(
        'market_fetch_settlement_enabled',
        'marketFetchSettlementEnabled',
        'boolean',
        '启用日终结算自动补拉',
        true,
        true,
      ),
      field(
        'market_fetch_last_run_at',
        'marketFetchLastRunAt',
        'datetime',
        '上次行情拉取完成时刻',
        true,
        true,
      ),
      field(
        'market_fetch_last_summary',
        'marketFetchLastSummary',
        'string',
        '上次行情拉取结果摘要',
        true,
        true,
      ),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', true, true),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', true, true),
    ],
    ['id', 'marketFetchLastRunAt', 'marketFetchLastSummary', 'insertedAt', 'updatedAt'],
  )
}

export function allSettingResourceMetas(): ResourceMeta[] {
  return [salesResourceMeta(), manufacturingResourceMeta(), accountingResourceMeta(), systemResourceMeta()]
}
