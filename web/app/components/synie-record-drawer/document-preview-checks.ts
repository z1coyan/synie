// bun app/components/synie-record-drawer/document-preview-checks.ts
// 纯注册表 API + 侧效登记后的 8 类库存来源契约
import {
  getDocumentPreview,
  listDocumentPreviewKeys,
  registerDocumentPreview,
} from './document-preview'
import type { GridColumnMeta, Row } from '../synie-data-grid/types'
import { resolveVoucherPreviewTarget } from '../../routes/_app/scm/-stock-entry-preview'

function eq(a: unknown, b: unknown, msg: string) {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
}

// —— 纯 API ——
registerDocumentPreview('__test_preview__', {
  label: '测试',
  docNoField: 'docNo',
  head: { exclude: [], fields: {} },
  lineTables: [
    {
      title: '行',
      resource: 'xItems',
      client: { id: 'test', query: async () => ({ count: 0, results: [] }), get: async () => null },
      parentIdField: 'docId',
    },
  ],
})
eq(getDocumentPreview('__test_preview__')?.label, '测试', 'register/get')
eq(getDocumentPreview('__no_such__'), null, '未知资源 null')

// —— 生产登记（tsx 侧效）——
await import('./document-preview-registry')

const EXPECTED = [
  'invStockCounts',
  'invStockDocs',
  'invStockTransfers',
  'mfgOutputs',
  'purOutsourcedIssues',
  'purOutsourcedReceipts',
  'purReceipts',
  'salDeliveries',
].sort()

const keys = listDocumentPreviewKeys().filter((k) => k !== '__test_preview__')
eq(JSON.stringify(keys), JSON.stringify(EXPECTED), '8 类库存来源均已登记')

for (const resource of EXPECTED) {
  const config = getDocumentPreview(resource)
  if (!config) throw new Error(`${resource} 缺少单据速览配置`)
  if (!config.head.exclude?.includes('status')) {
    throw new Error(`${resource} 状态应只出现在标题区，不得重复进入头字段`)
  }
  for (const table of config.lineTables) {
    if (!table.columns?.includes('materialCode')) {
      throw new Error(`${resource}/${table.title} 必须以 materialCode 承载物料富单元格`)
    }
    if (table.columns.includes('materialId') || table.columns.includes('materialName')) {
      throw new Error(`${resource}/${table.title} 不得以 materialId/materialName 承载物料列`)
    }
  }
}

const outsourced = getDocumentPreview('purOutsourcedReceipts')
eq(outsourced?.lineTables.length, 3, '委外入库三表')
const delivery = getDocumentPreview('salDeliveries')
if (delivery?.lineTables.some((t) => /pack/i.test(t.resource))) {
  throw new Error('发货速览不得含装箱子表')
}
const countLines = getDocumentPreview('invStockCounts')?.lineTables[0]
eq(countLines?.sortColumn, 'insertedAt', '盘点行无 idx，须按 insertedAt 排序')

const voucherColumn: GridColumnMeta = {
  name: 'voucherId',
  type: 'fk',
  label: '来源单据',
  sortable: true,
  filterable: true,
  enumOptions: null,
  ref: {
    resource: null,
    relation: null,
    labelField: null,
    discriminator: 'voucherType',
    discriminatorType: 'string',
    // 模拟当前用户仅持 sales.delivery read：其它来源变体已被 ResourceDocument 裁剪。
    variants: [
      {
        value: 'sales.delivery',
        resource: 'salDeliveries',
        labelField: 'deliveryNo',
        label: '销售发货单',
      },
    ],
  },
}
eq(
  JSON.stringify(
    resolveVoucherPreviewTarget(voucherColumn, {
      id: 'entry-1',
      voucherType: 'sales.delivery',
    } as Row),
  ),
  JSON.stringify({ resource: 'salDeliveries', labelField: 'deliveryNo' }),
  '来源单号复用可见多态变体',
)
eq(
  resolveVoucherPreviewTarget(voucherColumn, {
    id: 'entry-2',
    voucherType: 'purchase.receipt',
  } as Row),
  null,
  '来源 read 被裁剪时单号退纯文本',
)

console.log('document-preview-checks: ok')
