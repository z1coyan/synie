import { describe, expect, test } from 'bun:test'
import { paginateCompanyAccountDefaults } from './companyAccountDefaults'

const actor = {
  userId: 'user-1', username: 'tester', name: 'Tester',
  superAdmin: false, allCompanies: false,
  companyIds: ['company-2'], permissions: new Set<string>(),
}

describe('company account defaults pagination', () => {
  test('受限用户过滤当前页但保留服务端 opaque cursor', async () => {
    const calls: unknown[] = []
    const db = {
      query() {
        return {
          withIndex() {
            return {
              async paginate(options: unknown) {
                calls.push(options)
                return {
                  page: [
                    { _id: 'defaults-1', companyId: 'company-1', deliveryDebitAccountId: null, deliveryCreditAccountId: null, receiptDebitAccountId: null, receiptCreditAccountId: null, insertedAt: 1, updatedAt: 1 },
                    { _id: 'defaults-2', companyId: 'company-2', deliveryDebitAccountId: null, deliveryCreditAccountId: null, receiptDebitAccountId: null, receiptCreditAccountId: null, insertedAt: 2, updatedAt: 2 },
                  ],
                  continueCursor: 'defaults/next',
                  isDone: false,
                }
              },
            }
          },
        }
      },
    } as never

    const result = await paginateCompanyAccountDefaults(db, actor, {
      numItems: 100,
      cursor: 'defaults/current',
    })
    expect(calls).toEqual([{ numItems: 100, cursor: 'defaults/current' }])
    expect(result.results.map(row => row.id)).toEqual(['defaults-2'])
    expect(result.pageInfo).toEqual({ continueCursor: 'defaults/next', isDone: false })
  })

  test('超过资源单页上限时在访问数据库前失败', async () => {
    let queried = false
    const db = { query() { queried = true; throw new Error('unexpected') } } as never
    await expect(paginateCompanyAccountDefaults(db, actor, {
      numItems: 101,
      cursor: null,
    })).rejects.toThrow(/1\.\.100/)
    expect(queried).toBe(false)
  })
})
