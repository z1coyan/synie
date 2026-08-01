import { describe, expect, test } from 'bun:test'
import {
  candidateProjectionRows,
  paginateDomainCandidateRows,
  resolveDomainCandidateProfile,
} from './candidates'
import { assertExpenseInvoiceAvailableForItem, listDomainRecords } from './records'

const actor = {
  userId: 'user-1',
  username: 'admin',
  name: 'Admin',
  superAdmin: false,
  allCompanies: false,
  companyIds: ['company-1'],
  permissions: new Set<string>(),
}

const emptyCtx = { db: {} } as never

function stored(
  id: string,
  resource: string,
  data: Record<string, unknown>,
  options: { companyId?: string | null; parentId?: string | null; status?: string | null } = {},
) {
  return {
    _id: id,
    _creationTime: 1,
    resource,
    companyId: options.companyId ?? (typeof data.companyId === 'string' ? data.companyId : null),
    parentId: options.parentId ?? null,
    status: options.status ?? (typeof data.status === 'string' ? data.status : null),
    sortKey: '',
    searchText: '',
    decimalValues: {},
    data,
    insertedAt: 1,
    updatedAt: 1,
  }
}

function relatedCtx(documents: Record<string, ReturnType<typeof stored>>) {
  return {
    db: {
      normalizeId(_table: string, id: string) { return documents[id] ? id : null },
      async get(id: string) { return documents[id] ?? null },
    },
  } as never
}

describe('domain candidate projection profiles', () => {
  test('银行账户仅把本公司启用记录投影到固定候选 key', async () => {
    const rows = await candidateProjectionRows(emptyCtx, 'accBankAccounts', 'bank-1', {
      companyId: 'company-1',
      alias: '基本户',
      active: true,
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ profile: 'bankAccountActive', recordId: 'bank-1' })

    expect(await candidateProjectionRows(emptyCtx, 'accBankAccounts', 'bank-1', {
      companyId: 'company-1', alias: '基本户', active: false,
    })).toEqual([])
  })

  test('候选 profile 参数必须完整、类型正确且不接受额外字段', async () => {
    expect(resolveDomainCandidateProfile(actor, 'accBankAccounts', {
      candidateProfile: 'bankAccountActive', companyId: 'company-1', active: true,
    })).toMatchObject({ profile: 'bankAccountActive' })
    expect(() => resolveDomainCandidateProfile(actor, 'accBankAccounts', {
      candidateProfile: 'bankAccountActive', companyId: 'company-1',
    })).toThrow()
    expect(() => resolveDomainCandidateProfile(actor, 'accBankAccounts', {
      candidateProfile: 'bankAccountActive', companyId: 'company-1', active: true, status: 'AUDITED',
    })).toThrow()
    expect(() => resolveDomainCandidateProfile(actor, 'accBankAccounts', {
      candidateProfile: 'bankAccountActive', companyId: 'company-1', active: 'true',
    })).toThrow()
  })

  test('报价有效区间按 segment key 投影，区间内命中且边界外不命中', async () => {
    const rows = await candidateProjectionRows(emptyCtx, 'salQuotationItems', 'quote-1', {
      companyId: 'company-1', partyType: 'CUSTOMER', partyId: 'customer-1',
      currencyId: 'currency-1', quotationStatus: 'AUDITED', materialCode: 'M-001',
      quotationDate: '2026-07-01', validUntil: '2026-07-31',
    })
    const inside = resolveDomainCandidateProfile(actor, 'salQuotationItems', {
      candidateProfile: 'quotationItemValid', companyId: 'company-1',
      partyType: 'CUSTOMER', partyId: 'customer-1', currencyId: 'currency-1',
      orderDate: '2026-07-31',
    })
    const outside = resolveDomainCandidateProfile(actor, 'salQuotationItems', {
      candidateProfile: 'quotationItemValid', companyId: 'company-1',
      partyType: 'CUSTOMER', partyId: 'customer-1', currencyId: 'currency-1',
      orderDate: '2026-08-01',
    })
    expect(rows.filter((row) => inside.keys.includes(row.key))).toHaveLength(1)
    expect(rows.filter((row) => outside.keys.includes(row.key))).toHaveLength(0)
  })

  test('repair 可从旧报价父单与委外订单回溯缺失的受控快照', async () => {
    const ctx = relatedCtx({
      quotation: stored('quotation', 'salQuotations', {
        companyId: 'company-1', partyType: 'CUSTOMER', partyId: 'customer-1',
        currencyId: 'currency-1', quotationDate: '2026-07-01', validUntil: '2026-07-31',
      }, { companyId: 'company-1', status: 'AUDITED' }),
      orderItem: stored('orderItem', 'purOrderItems', { orderId: 'order' }, { companyId: 'company-1', parentId: 'order' }),
      order: stored('order', 'purOrders', {
        companyId: 'company-1', partyType: 'SUPPLIER', partyId: 'supplier-1',
        orderNo: 'PO-1', isOutsourced: true,
      }, { companyId: 'company-1', status: 'AUDITED' }),
    })
    const quotationRows = await candidateProjectionRows(ctx, 'salQuotationItems', 'quote-item', {
      quotationId: 'quotation', materialCode: 'M-1',
    })
    const materialRows = await candidateProjectionRows(ctx, 'purOrderItemMaterials', 'material-line', {
      orderItemId: 'orderItem', remainingIssueQty: '2',
    })
    expect(quotationRows.length).toBeGreaterThan(0)
    expect(materialRows).toHaveLength(1)
  })

  test('需求行只有在父需求已确认且仍有可安排量时进入工单候选', async () => {
    const confirmed = relatedCtx({
      demand: stored('demand', 'mfgDemands', {}, { companyId: 'company-1', status: 'CONFIRMED' }),
    })
    const draft = relatedCtx({
      demand: stored('demand', 'mfgDemands', {}, { companyId: 'company-1', status: 'DRAFT' }),
    })
    const wire = {
      demandId: 'demand', companyId: 'company-1', status: 'PENDING',
      remainingArrangeableQty: '1', needDate: '2026-08-01', materialCode: 'M-1',
    }
    expect(await candidateProjectionRows(confirmed, 'mfgDemandItems', 'demand-item', wire)).toHaveLength(1)
    expect(await candidateProjectionRows(draft, 'mfgDemandItems', 'demand-item', wire)).toEqual([])
  })

  test('发票占用检查排除自身、允许已作废报销单，并拒绝另一张活动报销单', async () => {
    const references = [{
      sourceResource: 'accExpenseReportItems', sourceRecordId: 'item-1', field: 'invoiceId',
      targetResource: 'accVatInvoices', targetRecordId: 'invoice-1',
    }]
    const documents = {
      'item-1': stored('item-1', 'accExpenseReportItems', {
        kind: 'INVOICED', reportId: 'report-1', companyId: 'company-1', invoiceId: 'invoice-1',
        summary: null, amount: null, expenseAccountId: null,
      }, { companyId: 'company-1', parentId: 'report-1' }),
      'report-1': stored('report-1', 'accExpenseReports', {
        employeeId: 'employee-1',
      }, { companyId: 'company-1', status: 'DRAFT' }),
      'report-current': stored('report-current', 'accExpenseReports', {
        employeeId: 'employee-1',
      }, { companyId: 'company-1', status: 'DRAFT' }),
      'invoice-1': stored('invoice-1', 'accVatInvoices', {
        direction: 'INBOUND', partyType: 'EMPLOYEE', partyId: 'employee-1',
      }, { companyId: 'company-1', status: 'AUDITED' }),
    }
    const ctx = {
      db: {
        normalizeId(_table: string, id: string) { return id in documents ? id : null },
        async get(id: keyof typeof documents) { return documents[id] ?? null },
        query(table: string) {
          expect(table).toBe('domainReferences')
          return {
            withIndex(_name: string, configure: (q: { eq: (field: string, value: unknown) => unknown }) => unknown) {
              const equals: Array<[string, unknown]> = []
              const q = { eq(field: string, value: unknown) { equals.push([field, value]); return q } }
              configure(q)
              return {
                async collect() {
                  return references.filter((row) => equals.every(([field, value]) => row[field as keyof typeof row] === value))
                },
              }
            },
          }
        },
      },
    } as never

    const ownWire = {
      idx: 1, kind: 'INVOICED', reportId: 'report-1', companyId: 'company-1', invoiceId: 'invoice-1',
      summary: null, amount: null, expenseAccountId: null,
    }
    const newWire = { ...ownWire, reportId: 'report-current' }
    await expect(assertExpenseInvoiceAvailableForItem(ctx, 'item-1', ownWire)).resolves.toBeUndefined()
    await expect(assertExpenseInvoiceAvailableForItem(ctx, 'item-2', newWire)).rejects.toThrow('已被其他报销单引用')
    documents['report-1'].status = 'VOIDED'
    await expect(assertExpenseInvoiceAvailableForItem(ctx, 'item-2', newWire)).resolves.toBeUndefined()
  })

  test('损坏的报销反向引用 fail-closed，不把发票重新暴露为候选', async () => {
    const ctx = {
      db: {
        normalizeId() { return null },
        async get() { return null },
        query(table: string) {
          expect(table).toBe('domainReferences')
          return {
            withIndex(_name: string, configure: (q: { eq: (field: string, value: unknown) => unknown }) => unknown) {
              const q = { eq() { return q } }
              configure(q)
              return { async collect() { return [{
                sourceResource: 'accExpenseReportItems', sourceRecordId: 'missing-item', field: 'invoiceId',
                targetResource: 'accVatInvoices', targetRecordId: 'invoice-1',
              }] } }
            },
          }
        },
      },
    } as never
    expect(await candidateProjectionRows(ctx, 'accVatInvoices', 'invoice-1', {
      companyId: 'company-1', direction: 'INBOUND', partyType: 'EMPLOYEE', partyId: 'employee-1',
      status: 'AUDITED', docNo: 'INV-1',
    })).toEqual([])
  })

  test('public list 边界保持候选 key 与 opaque cursor，不退化成闭包表扫描', async () => {
    const projections = (await Promise.all([
      candidateProjectionRows(emptyCtx, 'accBankAccounts', 'bank-1', { companyId: 'company-1', alias: 'A户', active: true }),
      candidateProjectionRows(emptyCtx, 'accBankAccounts', 'bank-2', { companyId: 'company-1', alias: 'B户', active: true }),
      candidateProjectionRows(emptyCtx, 'accBankAccounts', 'other', { companyId: 'company-2', alias: '外部户', active: true }),
    ])).flat().map((row, index) => ({ ...row, resource: 'accBankAccounts', _id: `projection-${index}`, _creationTime: index }))
    const documents = {
      'bank-1': stored('bank-1', 'accBankAccounts', { alias: 'A户', active: true }, { companyId: 'company-1' }),
      'bank-2': stored('bank-2', 'accBankAccounts', { alias: 'B户', active: true }, { companyId: 'company-1' }),
      other: stored('other', 'accBankAccounts', { alias: '外部户', active: true }, { companyId: 'company-2' }),
    }
    const calls: Array<{ table: string; equals: Array<[string, unknown]> }> = []
    const ctx = {
      db: {
        normalizeId(_table: string, id: string) { return id in documents ? id : null },
        async get(id: keyof typeof documents) { return documents[id] ?? null },
        query(table: string) {
          const call = { table, equals: [] as Array<[string, unknown]> }
          calls.push(call)
          return {
            withIndex(name: string, configure: (q: {
              eq: (field: string, value: unknown) => unknown
              gt: (field: string, value: unknown) => unknown
            }) => unknown) {
              expect(table).toBe('domainCandidateRows')
              expect(name).toBe('by_resource_profile_key_sort')
              let after: string | null = null
              const q = {
                eq(field: string, value: unknown) { call.equals.push([field, value]); return q },
                gt(field: string, value: unknown) { expect(field).toBe('sortValue'); after = String(value); return q },
              }
              configure(q)
              return {
                async take(limit: number) {
                  const selected = projections.filter((row) =>
                    call.equals.every(([field, value]) => row[field as keyof typeof row] === value) &&
                    (after === null || row.sortValue > after),
                  ).sort((left, right) => left.sortValue.localeCompare(right.sortValue))
                  return selected.slice(0, limit)
                },
              }
            },
          }
        },
      },
    } as never
    const listActor = { ...actor, permissions: new Set(['acc.bank_account:read']) }
    const queryArgs = { candidateProfile: 'bankAccountActive', companyId: 'company-1', active: true }
    const first = await listDomainRecords(ctx, listActor as never, 'accBankAccounts', { numItems: 1, args: queryArgs })
    const second = await listDomainRecords(ctx, listActor as never, 'accBankAccounts', {
      numItems: 1, cursor: first.pageInfo.continueCursor, args: queryArgs,
    })
    expect(first.results.map((row) => row.id)).toEqual(['bank-1'])
    expect(second.results.map((row) => row.id)).toEqual(['bank-2'])
    expect(first.pageInfo.continueCursor).toStartWith('candidate:')
    expect(calls.every((call) => call.table === 'domainCandidateRows')).toBe(true)
    expect(calls.every((call) => call.equals.some(([field, value]) => field === 'key' && typeof value === 'string'))).toBe(true)
  })

  test('search profile 同样保持完整候选 key', async () => {
    const row = (await candidateProjectionRows(emptyCtx, 'accBankAccounts', 'bank-1', {
      companyId: 'company-1', alias: '工资专户', active: true,
    }))[0]!
    const calls: Array<Array<[string, unknown]>> = []
    const ctx = {
      db: {
        query(table: string) {
          expect(table).toBe('domainCandidateRows')
          return {
            withSearchIndex(name: string, configure: (q: {
              search: (field: string, value: string) => unknown
              eq: (field: string, value: unknown) => unknown
            }) => unknown) {
              expect(name).toBe('search_text')
              const equals: Array<[string, unknown]> = []
              calls.push(equals)
              const q = {
                search(field: string, value: string) { expect([field, value]).toEqual(['searchText', '工资']); return q },
                eq(field: string, value: unknown) { equals.push([field, value]); return q },
              }
              configure(q)
              return { async paginate() { return { page: [{ ...row, resource: 'accBankAccounts' }], continueCursor: '', isDone: true } } }
            },
          }
        },
      },
    } as never
    const result = await paginateDomainCandidateRows(ctx, actor as never, 'accBankAccounts', {
      numItems: 10,
      search: '工资',
      args: { candidateProfile: 'bankAccountActive', companyId: 'company-1', active: true },
    })
    expect(result.page).toHaveLength(1)
    expect(calls[0]).toEqual([
      ['resource', 'accBankAccounts'], ['profile', 'bankAccountActive'], ['key', row.key],
    ])
  })

  test('候选查询实现不得使用 post-filter 或候选表全表 collect', async () => {
    const source = await Bun.file('convex/domains/shared/candidates.ts').text()
    expect(source).not.toContain('.filter(')
    expect(source).not.toMatch(/query\('domainCandidateRows'\)(?![\s\S]{0,100}withIndex)[\s\S]{0,100}\.collect\(/)
  })
})
