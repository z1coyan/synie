import type { ResourceMeta } from '../meta/types.ts'

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

/** 仅系统设置 Meta；sal/mfg/acc 由业务域自行注册 */
export function systemResourceMeta(): ResourceMeta {
  return {
    name: SYS_RESOURCE_NAME,
    permissionPrefix: 'sys.setting',
    permissionLabel: '系统设置',
    table: 'sys_setting',
    fields: [
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
    print: true,
    audit: { enabled: true },
    actions: [
      { key: 'read', label: '查看', scope: 'both' },
      { key: 'update', label: '编辑', scope: 'row' },
    ],
    form: {
      exclude: ['id', 'marketFetchLastRunAt', 'marketFetchLastSummary', 'insertedAt', 'updatedAt'],
    },
  }
}

export function allSettingResourceMetas(): ResourceMeta[] {
  return [systemResourceMeta()]
}
