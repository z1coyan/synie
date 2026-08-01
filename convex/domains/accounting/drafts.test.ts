import { describe, expect, test } from 'bun:test'
import { deriveJournalLineAccount } from './drafts'

function context(account: Record<string, unknown> | null) {
  return {
    db: {
      normalizeId(table: string, id: string) {
        expect(table).toBe('accounts')
        return id === 'account-1' ? id : null
      },
      async get(id: string) {
        return id === 'account-1' ? account : null
      },
    },
  }
}

describe('会计凭证 AggregateDraft 行科目快照', () => {
  test('create 与 replace 都忽略客户端币种，并从当前科目强制派生', async () => {
    const account = {
      companyId: 'company-1',
      currencyId: 'currency-usd',
      isGroup: false,
      active: true,
    }
    const ctx = context(account)

    await expect(deriveJournalLineAccount(ctx as never, {
      companyId: 'company-1',
    }, {
      accountId: 'account-1',
      currencyId: 'client-forged-currency',
    })).resolves.toEqual({ currencyId: 'currency-usd' })

    account.currencyId = 'currency-eur'
    await expect(deriveJournalLineAccount(ctx as never, {
      companyId: 'company-1',
    }, {
      id: 'line-1',
      accountId: 'account-1',
      currencyId: 'stale-currency',
    })).resolves.toEqual({ currencyId: 'currency-eur' })
  })

  test('本币科目的空币种也由服务端明确写回 null', async () => {
    await expect(deriveJournalLineAccount(context({
      companyId: 'company-1',
      currencyId: null,
      isGroup: false,
      active: true,
    }) as never, { companyId: 'company-1' }, { accountId: 'account-1' }))
      .resolves.toEqual({ currencyId: null })
  })

  test('建行时拒绝跨公司、汇总或停用科目', async () => {
    for (const [account, message] of [
      [{ companyId: 'company-2', currencyId: null, isGroup: false, active: true }, '科目必须属于凭证所在公司'],
      [{ companyId: 'company-1', currencyId: null, isGroup: true, active: true }, '汇总科目不能入账'],
      [{ companyId: 'company-1', currencyId: null, isGroup: false, active: false }, '停用科目不能入账'],
    ] as const) {
      await expect(deriveJournalLineAccount(
        context(account) as never,
        { companyId: 'company-1' },
        { accountId: 'account-1' },
      )).rejects.toThrow(message)
    }
  })
})
