import type { ResourceMeta } from '~/platform/meta/types.ts'
import type { Registry } from '~/platform/meta/registry.ts'

export const INSTRUMENT_RESOURCE_NAME = 'basMarketInstruments'
export const PERMISSION_PREFIX = 'base.market_instrument'

const SOURCE_TYPES = [
  { value: 'EXCHANGE', label: '交易所序列' },
  { value: 'SPOT_INDEX', label: '现货指数' },
  { value: 'OTHER', label: '其他' },
] as const

const PRICE_KINDS = [
  { value: 'SETTLEMENT', label: '结算价' },
  { value: 'AVERAGE', label: '均价' },
  { value: 'LAST', label: '最新价' },
] as const

export function instrumentResourceMeta(): ResourceMeta {
  return {
    name: INSTRUMENT_RESOURCE_NAME,
    permissionPrefix: PERMISSION_PREFIX,
    permissionLabel: '行情品种',
    table: 'bas_market_instrument',
    fields: [
      { name: 'id', apiName: 'id', dbColumn: 'id', type: 'uuid', label: 'id', readonly: true, sortable: true },
      {
        name: 'code',
        apiName: 'code',
        dbColumn: 'code',
        type: 'string',
        label: '编码',
        required: true,
        createOnly: true,
        filterable: true,
        sortable: true,
      },
      {
        name: 'name',
        apiName: 'name',
        dbColumn: 'name',
        type: 'string',
        label: '名称',
        required: true,
        filterable: true,
        sortable: true,
      },
      {
        name: 'source_type',
        apiName: 'sourceType',
        dbColumn: 'source_type',
        type: 'enum',
        label: '来源类型',
        required: true,
        createOnly: true,
        enumOptions: [...SOURCE_TYPES],
        filterable: true,
        sortable: true,
      },
      {
        name: 'default_price_kind',
        apiName: 'defaultPriceKind',
        dbColumn: 'default_price_kind',
        type: 'enum',
        label: '默认价种',
        required: true,
        enumOptions: [...PRICE_KINDS],
        filterable: true,
        sortable: true,
      },
      {
        name: 'active',
        apiName: 'active',
        dbColumn: 'active',
        type: 'boolean',
        label: '启用',
        filterable: true,
        sortable: true,
      },
      {
        name: 'fetch_enabled',
        apiName: 'fetchEnabled',
        dbColumn: 'fetch_enabled',
        type: 'boolean',
        label: '启用拉取',
        filterable: true,
        sortable: true,
      },
      {
        name: 'currency_id',
        apiName: 'currencyId',
        dbColumn: 'currency_id',
        type: 'uuid',
        label: '货币',
        required: true,
        filterable: true,
        sortable: true,
      },
      {
        name: 'unit_id',
        apiName: 'unitId',
        dbColumn: 'unit_id',
        type: 'uuid',
        label: '单位',
        required: true,
        filterable: true,
        sortable: true,
      },
      {
        name: 'inserted_at',
        apiName: 'insertedAt',
        dbColumn: 'inserted_at',
        type: 'datetime',
        label: '创建时间',
        readonly: true,
        filterable: true,
        sortable: true,
      },
      {
        name: 'updated_at',
        apiName: 'updatedAt',
        dbColumn: 'updated_at',
        type: 'datetime',
        label: '更新时间',
        readonly: true,
        filterable: true,
        sortable: true,
      },
    ],
    actions: [
      { key: 'read', label: '查看', scope: 'both' },
      { key: 'create', label: '新增', scope: 'both' },
      { key: 'update', label: '编辑', scope: 'row' },
      { key: 'delete', label: '删除', scope: 'row', isDanger: true },
    ],
    form: { exclude: ['id', 'insertedAt', 'updatedAt'] },
    print: true,
    audit: { enabled: true },
    destroyMutation: 'destroyBasMarketInstrument',
  }
}

export function registerMarketResources(registry: Registry): void {
  registry.register(instrumentResourceMeta())
}
