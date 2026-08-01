import { createFileRoute } from '@tanstack/react-router'
import { StockDocPage, type StockDocConfig } from '../-stock-doc'

export const Route = createFileRoute('/_app/scm/other-stock/docs')({
  component: StockDocsTab,
})

const CFG: StockDocConfig = {
  resource: 'invStockDocs',
  itemResource: 'invStockDocItems',
  label: '手工出入库单',
  itemLabel: '出入库行',
  createLabel: '新建出入库单',
  description:
    '仓管无上游单据直接录入的库存来源单据,入库/出库合一(期初建账也走它)。草稿可改可删,审核后按行派生库存分录(入库为正、出库为负),仅可作废。',
  docIdField: 'stockDocId',
  summaryPlaceholder: '货从哪来/到哪去(带入库存分录)',
}

function StockDocsTab() {
  return <StockDocPage cfg={CFG} />
}
