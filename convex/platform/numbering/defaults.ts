import type { MutationCtx } from '../../_generated/server'
import { createNumberingRuleInMutation } from './service'
import type { NumberingSegment } from './model'

type DefaultRule = {
  resource: string
  name: string
  perCompany: boolean
  segments: NumberingSegment[]
}

const sequenceRule = (resource: string, name: string, prefix: string): DefaultRule => ({
  resource,
  name,
  perCompany: false,
  segments: [{ kind: 'text', value: `${prefix}-` }, { kind: 'sequence', padding: 4 }],
})

const documentRule = (
  resource: string,
  name: string,
  prefix: string,
  field: string,
): DefaultRule => ({
  resource,
  name,
  perCompany: true,
  segments: [
    { kind: 'text', value: `${prefix}-` },
    { kind: 'field', field, format: 'YYYYMMDD' },
    { kind: 'text', value: '-' },
    { kind: 'sequence', padding: 4 },
  ],
})

export const DEFAULT_NUMBERING_RULES: readonly DefaultRule[] = Object.freeze([
  {
    resource: 'inv.material',
    name: '物料编号',
    perCompany: false,
    segments: [
      { kind: 'field', field: 'category.code' },
      { kind: 'field', field: 'customer.code' },
      { kind: 'text', value: '-' },
      { kind: 'sequence', padding: 0 },
    ],
  },
  sequenceRule('hr.employee', '员工编号', 'H(E)'),
  sequenceRule('mfg.operation', '工序编号', 'M(O)'),
  sequenceRule('mfg.route_template', '工艺模板编号', 'M(T)'),
  sequenceRule('mfg.bom', 'BOM编号', 'M(B)'),
  documentRule('sales.order', '销售订单编号', 'S(O)', 'order_date'),
  documentRule('sales.quotation', '销售报价编号', 'S(Q)', 'quotation_date'),
  documentRule('sales.delivery', '销售发货编号', 'S(D)', 'delivery_date'),
  documentRule('sales.reconciliation', '销售对账编号', 'S(R)', 'posting_date'),
  documentRule('purchase.order', '采购订单编号', 'P(O)', 'order_date'),
  documentRule('purchase.quotation', '采购报价编号', 'P(Q)', 'quotation_date'),
  documentRule('purchase.receipt', '采购入库单编号', 'P(R)', 'receipt_date'),
  documentRule('purchase.reconciliation', '采购对账编号', 'P(C)', 'posting_date'),
  documentRule('purchase.outsourced_issue', '委外发料编号', 'P(OI)', 'issue_date'),
  documentRule('purchase.outsourced_receipt', '委外入库编号', 'P(OR)', 'receipt_date'),
  documentRule('inv.stock_doc', '手工出入库单编号', 'I(D)', 'doc_date'),
  documentRule('inv.stock_transfer', '手工调拨单编号', 'I(T)', 'doc_date'),
  documentRule('inv.stock_count', '库存盘点单编号', 'I(C)', 'posting_date'),
  documentRule('mfg.demand', '履约需求单编号', 'M(D)', 'demand_date'),
  documentRule('mfg.work_order', '生产工单编号', 'M(W)', 'need_date'),
  documentRule('mfg.output', '生产入库单编号', 'M(R)', 'output_date'),
  documentRule('acc.gl_journal', '会计凭证编号', 'A(J)', 'date'),
  documentRule('acc.vat_invoice', '增值税发票编号', 'A(I)', 'invoice_date'),
  documentRule('acc.bill_transaction', '承兑交易编号', 'A(B)', 'occurred_on'),
  documentRule('acc.expense_report', '费用报销编号', 'A(E)', 'expense_date'),
])

export async function seedDefaultNumberingRules(
  ctx: Pick<MutationCtx, 'db'>,
): Promise<void> {
  for (const rule of DEFAULT_NUMBERING_RULES) {
    const existing = await ctx.db.query('numberingRules').withIndex('by_resource_name', (query) =>
      query.eq('resource', rule.resource),
    ).first()
    if (existing) continue
    await createNumberingRuleInMutation(ctx, {
      ...rule,
      enabled: true,
    })
  }
}
