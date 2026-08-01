import { describe, expect, test } from 'bun:test'
import type { FilterState } from '~/components/synie-data-grid/types'
import { resolveDomainCandidateQuery } from './candidate-query'
import type { ResourceQuery } from './types'

const fk = (value: string) => ({ kind: 'fk' as const, op: 'in' as const, values: [value], labels: [] })
const poly = (variant: string, value: string) => ({
  kind: 'polyFk' as const,
  op: 'in' as const,
  variant,
  values: [value],
  labels: [],
})
const one = (value: string) => ({ kind: 'enum' as const, values: [value] })
const gtZero = { kind: 'number' as const, op: 'gt' as const, value: '0' }

function query(filter: FilterState, extra: Partial<ResourceQuery> = {}): ResourceQuery {
  return { profile: 'lookup', numItems: 20, filter, ...extra }
}

describe('domain candidate query parser', () => {
  test('基础与财务候选只下发语义参数', () => {
    expect(resolveDomainCandidateQuery('accBankAccounts', query({
      companyId: fk('company-1'),
      active: { kind: 'bool', eq: true },
    }))).toEqual({
      candidateProfile: 'bankAccountActive',
      args: { companyId: 'company-1', active: true },
    })

    expect(resolveDomainCandidateQuery('accBankImportTemplates', query({
      bankAccountId: fk('bank-1'),
    }))).toEqual({
      candidateProfile: 'bankImportTemplateByAccount',
      args: { bankAccountId: 'bank-1' },
    })

    expect(resolveDomainCandidateQuery('accBillHoldings', query({
      companyId: fk('company-1'),
      bankAccountId: fk('bank-1'),
    }, { sort: { column: 'dueDate', direction: 'ascending' } }))).toEqual({
      candidateProfile: 'billHoldingByAccount',
      args: { companyId: 'company-1', bankAccountId: 'bank-1' },
    })

    expect(resolveDomainCandidateQuery('accVatInvoices', query({
      companyId: fk('company-1'),
      direction: one('INBOUND'),
      partyType: one('EMPLOYEE'),
      partyId: fk('employee-1'),
      status: one('AUDITED'),
    }))).toEqual({
      candidateProfile: 'expenseInvoice',
      args: { companyId: 'company-1', employeeId: 'employee-1' },
    })
  })

  test('发票关联对账单验证固定资格后剥离资格字段', () => {
    expect(resolveDomainCandidateQuery('salReconciliations', query({
      companyId: fk('company-1'),
      partyType: one('CUSTOMER'),
      partyId: fk('customer-1'),
      status: one('CONFIRMED'),
      reconciliationType: one('REGULAR'),
    }))).toEqual({
      candidateProfile: 'invoiceReconciliation',
      args: {
        companyId: 'company-1',
        partyType: 'CUSTOMER',
        partyId: 'customer-1',
      },
    })
  })

  test('发货、普通入库和委外入库候选合成明确委外标记', () => {
    const common: FilterState = {
      orderStatus: one('AUDITED'),
      companyId: fk('company-1'),
      partyType: one('SUPPLIER'),
      partyId: poly('SUPPLIER', 'supplier-1'),
      remainingBaseQty: gtZero,
    }
    expect(resolveDomainCandidateQuery('salOrderItems', query({
      ...common,
      partyType: one('CUSTOMER'),
      partyId: poly('CUSTOMER', 'customer-1'),
    }, { sort: { column: 'orderDate', direction: 'ascending' } }))).toEqual({
      candidateProfile: 'orderItemFulfillment',
      args: {
        companyId: 'company-1',
        partyType: 'CUSTOMER',
        partyId: 'customer-1',
        orderIsOutsourced: false,
      },
    })
    expect(resolveDomainCandidateQuery('purOrderItems', query(common))).toEqual({
      candidateProfile: 'orderItemFulfillment',
      args: {
        companyId: 'company-1',
        partyType: 'SUPPLIER',
        partyId: 'supplier-1',
        orderIsOutsourced: false,
      },
    })
    expect(resolveDomainCandidateQuery('purOrderItems', query({
      ...common,
      orderIsOutsourced: { kind: 'bool', eq: true },
    }))).toEqual({
      candidateProfile: 'orderItemFulfillment',
      args: {
        companyId: 'company-1',
        partyType: 'SUPPLIER',
        partyId: 'supplier-1',
        orderIsOutsourced: true,
      },
    })
  })

  test('委外发料候选验证审核、委外与剩余量资格', () => {
    expect(resolveDomainCandidateQuery('purOrderItemMaterials', query({
      orderStatus: one('AUDITED'),
      orderIsOutsourced: { kind: 'bool', eq: true },
      companyId: fk('company-1'),
      partyType: one('SUPPLIER'),
      partyId: poly('SUPPLIER', 'supplier-1'),
      remainingIssueQty: gtZero,
    }, { sort: { column: 'orderNo', direction: 'ascending' } }))).toEqual({
      candidateProfile: 'outsourcedMaterialIssue',
      args: {
        companyId: 'company-1',
        partyType: 'SUPPLIER',
        partyId: 'supplier-1',
      },
    })
  })

  test('有效报价把两端日期收敛为同一个 orderDate', () => {
    expect(resolveDomainCandidateQuery('purQuotationItems', query({
      quotationStatus: one('AUDITED'),
      companyId: fk('company-1'),
      partyType: one('SUPPLIER'),
      partyId: poly('SUPPLIER', 'supplier-1'),
      currencyId: fk('currency-1'),
      quotationDate: { kind: 'date', op: 'between', lte: '2026-08-01' },
      validUntil: { kind: 'date', op: 'between', gte: '2026-08-01' },
    }))).toEqual({
      candidateProfile: 'quotationItemValid',
      args: {
        companyId: 'company-1',
        partyType: 'SUPPLIER',
        partyId: 'supplier-1',
        currencyId: 'currency-1',
        orderDate: '2026-08-01',
      },
    })
  })

  test('常规与赠样对账行使用不同资格并保留可选币种', () => {
    expect(resolveDomainCandidateQuery('salDeliveryItems', query({
      deliveryStatus: one('AUDITED'),
      companyId: fk('company-1'),
      partyType: one('CUSTOMER'),
      partyId: poly('CUSTOMER', 'customer-1'),
      remainingReconcilableQty: gtZero,
      reconciliationType: one('REGULAR'),
      orderCurrencyCode: { kind: 'text', op: 'eq', value: 'CNY' },
      orderPrice: gtZero,
      orderType: one('REGULAR'),
    }, { sort: { column: 'deliveryDate', direction: 'ascending' } }))).toEqual({
      candidateProfile: 'reconciliationLine',
      args: {
        companyId: 'company-1',
        partyType: 'CUSTOMER',
        partyId: 'customer-1',
        reconciliationType: 'REGULAR',
        orderCurrencyCode: 'CNY',
      },
    })

    expect(resolveDomainCandidateQuery('purReceiptItems', query({
      receiptStatus: one('AUDITED'),
      companyId: fk('company-1'),
      partyType: one('SUPPLIER'),
      partyId: poly('SUPPLIER', 'supplier-1'),
      remainingReconcilableQty: gtZero,
      reconciliationType: one('GIFT_SAMPLE'),
    }))).toEqual({
      candidateProfile: 'reconciliationLine',
      args: {
        companyId: 'company-1',
        partyType: 'SUPPLIER',
        partyId: 'supplier-1',
        reconciliationType: 'GIFT_SAMPLE',
      },
    })
  })

  test('BOM 候选可选 ACTIVE 状态，普通列表不被误判', () => {
    expect(resolveDomainCandidateQuery('mfgBoms', query({
      materialId: fk('material-1'),
      status: one('ACTIVE'),
    }))).toEqual({
      candidateProfile: 'bomByMaterial',
      args: { materialId: 'material-1', status: 'ACTIVE' },
    })
    expect(resolveDomainCandidateQuery('mfgBoms', {
      profile: 'default', numItems: 20,
    })).toBeUndefined()
  })

  test('缺资格、多值、区间错配、错误排序与额外条件均 fail-closed', () => {
    expect(() => resolveDomainCandidateQuery('accBankAccounts', query({
      companyId: fk('company-1'),
    }))).toThrow(/缺少 active/)

    expect(() => resolveDomainCandidateQuery('salOrderItems', query({
      orderStatus: one('AUDITED'),
      companyId: fk('company-1'),
      partyType: one('CUSTOMER'),
      partyId: { ...poly('CUSTOMER', 'customer-1'), values: ['customer-1', 'customer-2'] },
      remainingBaseQty: gtZero,
    }))).toThrow(/单值多态外键/)

    expect(() => resolveDomainCandidateQuery('salQuotationItems', query({
      quotationStatus: one('AUDITED'),
      companyId: fk('company-1'),
      partyType: one('CUSTOMER'),
      partyId: poly('CUSTOMER', 'customer-1'),
      currencyId: fk('currency-1'),
      quotationDate: { kind: 'date', op: 'between', lte: '2026-08-01' },
      validUntil: { kind: 'date', op: 'between', gte: '2026-08-02' },
    }))).toThrow(/同一个订单日期/)

    expect(() => resolveDomainCandidateQuery('purReceiptItems', query({
      receiptStatus: one('AUDITED'),
      companyId: fk('company-1'),
      partyType: one('SUPPLIER'),
      partyId: poly('SUPPLIER', 'supplier-1'),
      remainingReconcilableQty: gtZero,
      reconciliationType: one('REGULAR'),
    }))).toThrow(/缺少 orderPrice/)

    expect(() => resolveDomainCandidateQuery('salOrderItems', query({
      orderStatus: one('AUDITED'),
      companyId: fk('company-1'),
      partyType: one('CUSTOMER'),
      partyId: poly('CUSTOMER', 'customer-1'),
      remainingBaseQty: gtZero,
      status: one('ACTIVE'),
    }))).toThrow(/status/)

    expect(() => resolveDomainCandidateQuery('salOrderItems', query({
      orderStatus: one('AUDITED'),
      companyId: fk('company-1'),
      partyType: one('CUSTOMER'),
      partyId: poly('CUSTOMER', 'customer-1'),
      remainingBaseQty: gtZero,
    }, { sort: { column: 'orderDate', direction: 'descending' } }))).toThrow(/ascending/)
  })
})
