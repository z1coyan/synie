export type NumberingField = {
  sourceField: string
  type: 'string' | 'date' | 'datetime'
  lookup?: 'companyCode' | 'materialCategoryCode' | 'customerCode'
}

export type NumberingResource = { fields: Readonly<Record<string, NumberingField>> }

const commonFields = {
  doc_no: { sourceField: 'doc_no', type: 'string' },
  posting_date: { sourceField: 'posting_date', type: 'date' },
  'company.code': { sourceField: 'company_id', type: 'string', lookup: 'companyCode' },
} as const

const documentFields = (dates: readonly string[]) => ({
  fields: Object.freeze({
    ...commonFields,
    ...Object.fromEntries(dates.map((field) => [field, { sourceField: field, type: 'date' as const }])),
  }),
})

/**
 * Sealed at bundle time. Plan 005 adds each document prefix here as its owner is
 * migrated; runtime values can never select a table or column.
 */
export const NUMBERING_CATALOG = Object.freeze({
  'engine.document': { fields: commonFields },
  'inv.material': {
    fields: {
      'category.code': { sourceField: 'category_id', type: 'string', lookup: 'materialCategoryCode' },
      'customer.code': { sourceField: 'customer_id', type: 'string', lookup: 'customerCode' },
    },
  },
  'hr.employee': {
    fields: {
      code: { sourceField: 'code', type: 'string' },
      name: { sourceField: 'name', type: 'string' },
      attendance_no: { sourceField: 'attendance_no', type: 'string' },
    },
  },
  'mfg.operation': { fields: { code: { sourceField: 'code', type: 'string' }, name: { sourceField: 'name', type: 'string' } } },
  'mfg.route_template': { fields: { code: { sourceField: 'code', type: 'string' }, name: { sourceField: 'name', type: 'string' } } },
  'mfg.bom': { fields: { code: { sourceField: 'code', type: 'string' }, material_id: { sourceField: 'material_id', type: 'string' } } },
  'sales.order': documentFields(['order_date']),
  'sales.quotation': documentFields(['quotation_date', 'valid_until']),
  'sales.delivery': documentFields(['delivery_date', 'posting_date']),
  'sales.reconciliation': documentFields(['posting_date']),
  'purchase.order': documentFields(['order_date']),
  'purchase.quotation': documentFields(['quotation_date', 'valid_until']),
  'purchase.receipt': documentFields(['receipt_date', 'posting_date']),
  'purchase.reconciliation': documentFields(['posting_date']),
  'purchase.outsourced_issue': documentFields(['issue_date']),
  'purchase.outsourced_receipt': documentFields(['receipt_date', 'posting_date']),
  'inv.stock_doc': documentFields(['doc_date']),
  'inv.stock_transfer': documentFields(['doc_date']),
  'inv.stock_count': documentFields(['posting_date']),
  'mfg.demand': documentFields(['demand_date']),
  'mfg.work_order': documentFields(['need_date']),
  'mfg.output': documentFields(['output_date']),
  'acc.gl_journal': documentFields(['date', 'posting_date']),
  'gl.voucher': documentFields(['date', 'posting_date']),
  'acc.vat_invoice': documentFields(['invoice_date', 'posting_date']),
  'acc.bill_transaction': documentFields(['occurred_on', 'posting_date']),
  'acc.expense_report': documentFields(['expense_date', 'posting_date']),
}) satisfies Readonly<Record<string, NumberingResource>>

export function numberingResource(resource: string): NumberingResource | undefined {
  return NUMBERING_CATALOG[resource as keyof typeof NUMBERING_CATALOG]
}
