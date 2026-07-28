import { afterAll, describe, expect, test } from 'bun:test'
import { createDb } from '~/db/index.ts'
import { createAccountingSettingService } from '~/modules/finance/settings.ts'
import { createManufacturingSettingService } from '~/modules/manufacturing/settings.ts'
import { createSalesSettingService } from '~/modules/trading/settings.ts'
import { createSettingsService } from '~/platform/settings/index.ts'
import type { Actor } from '~/platform/authz/actor.ts'

const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（settings）', () => {
  const db = createDb(url!)
  const settings = createSettingsService(db, {
    sales: createSalesSettingService(db),
    manufacturing: createManufacturingSettingService(db),
    accounting: createAccountingSettingService(db),
  })
  const actor: Actor = {
    userId: crypto.randomUUID(),
    username: 'settings-test',
    name: null,
    superAdmin: true,
    allCompanies: true,
    permissions: new Set(),
    companyIds: [],
  }

  afterAll(async () => {
    await db.destroy()
  })

  test('读写供应链/生产设置 + 比例校验', async () => {
    const sales = await settings.getSales(actor)
    expect(sales.sampleItemMaxQty).toBeGreaterThan(0)
    const updated = await settings.updateSales(actor, {
      sampleItemMaxQty: sales.sampleItemMaxQty === 97 ? 98 : 97,
      deliveryOvershipRatio: '0.07',
      demandOverorderRatio: '0.05',
    })
    expect(updated.demandOverorderRatio).toBe('0.05')
    // 还原部分字段
    await settings.updateSales(actor, {
      sampleItemMaxQty: sales.sampleItemMaxQty,
      deliveryOvershipRatio: sales.deliveryOvershipRatio,
      demandOverorderRatio: sales.demandOverorderRatio,
    })

    await expect(
      settings.updateSystem(actor, { marketFetchLastIntervalMinutes: 15 }),
    ).rejects.toMatchObject({ code: 'validation' })
  })

  test('财务 OCR 密钥 write-only 与 configured', async () => {
    const secret = `s-${crypto.randomUUID()}`
    const updated = await settings.updateAccounting(actor, {
      ocrAccessKeyId: `k-${crypto.randomUUID().slice(0, 8)}`,
      ocrAccessKeyIdPresent: true,
      ocrAccessKeySecret: secret,
    })
    expect(updated.ocrAccessKeyId?.startsWith('k-')).toBe(true)
    expect(JSON.stringify(updated)).not.toContain(secret)
    expect(await settings.ocrConfigured()).toBe(true)
  })
})
