import { createFileRoute } from '@tanstack/react-router'
import { StockDocPage, type StockDocConfig } from './-stock-doc'

export const Route = createFileRoute('/_app/scm/stock-docs')({
  component: StockDocsPage,
})

const CREATE_DOC = `
  mutation ($input: CreateInvStockDocInput!) {
    createInvStockDoc(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_DOC = `
  mutation ($id: ID!, $input: UpdateInvStockDocInput!) {
    updateInvStockDoc(id: $id, input: $input) { result { id } errors { message } }
  }
`
const CREATE_ITEM = `
  mutation ($input: CreateInvStockDocItemInput!) {
    createInvStockDocItem(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_ITEM = `
  mutation ($id: ID!, $input: UpdateInvStockDocItemInput!) {
    updateInvStockDocItem(id: $id, input: $input) { result { id } errors { message } }
  }
`
const DESTROY_ITEM = `
  mutation ($id: ID!) {
    destroyInvStockDocItem(id: $id) { errors { message } }
  }
`

const CFG: StockDocConfig = {
  resource: 'invStockDocs',
  itemResource: 'invStockDocItems',
  label: '手工出入库单',
  itemLabel: '出入库行',
  description:
    '仓管无上游单据直接录入的库存来源单据,入库/出库合一(期初建账也走它)。草稿可改可删,审核后按行派生库存分录(入库为正、出库为负),仅可作废。',
  docIdField: 'stockDocId',
  itemQuery: 'invStockDocItems',
  mutations: {
    createDoc: CREATE_DOC,
    updateDoc: UPDATE_DOC,
    createItem: CREATE_ITEM,
    updateItem: UPDATE_ITEM,
    destroyItem: DESTROY_ITEM,
  },
  resultKeys: {
    createDoc: 'createInvStockDoc',
    updateDoc: 'updateInvStockDoc',
    createItem: 'createInvStockDocItem',
    updateItem: 'updateInvStockDocItem',
    destroyItem: 'destroyInvStockDocItem',
  },
  summaryPlaceholder: '货从哪来/到哪去(带入库存分录)',
}

function StockDocsPage() {
  return <StockDocPage cfg={CFG} />
}
