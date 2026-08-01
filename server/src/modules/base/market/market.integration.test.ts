import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createDb } from '~/db/index.ts'
import type { Kysely } from 'kysely'
import type { DB as Database } from '~/db/types.ts'
import { createMarketService } from './service.ts'
import { createAccountingSettingService } from '~/modules/finance/settings.ts'
import { createManufacturingSettingService } from '~/modules/manufacturing/settings.ts'
import { createSalesSettingService } from '~/modules/trading/settings.ts'
import { createSettingsService } from '~/platform/settings/service.ts'
import { buildTestApp, testDatabaseUrl } from '../../../../test/helpers.ts'
import type { Actor } from '~/platform/authz/actor.ts'

const dbUrl = testDatabaseUrl()

describe.skipIf(!dbUrl)('market integration', () => {
  let db: Kysely<Database>
  let app: Awaited<ReturnType<typeof buildTestApp>>
  let token: string
  let actor: Actor
  let currencyId: string
  let unitId: string
  let unitId2: string
  const createdInstruments: string[] = []
  const createdPoints: string[] = []

  beforeAll(async () => {
    db = createDb(dbUrl!)
    app = await buildTestApp(db)

    const tryLogin = async (username: string, password: string) => {
      const res = await app.request('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      if (!res.ok) return null
      return (await res.json()) as { token: string; user: { id: string; username: string } }
    }

    let body =
      (await tryLogin(
        process.env.E2E_ADMIN_USERNAME ?? 'admin',
        process.env.E2E_ADMIN_PASSWORD ?? 'admin123',
      )) ?? (await tryLogin('admin', 'admin123'))

    // 共享测试库可能被 setup 清空；自建超管 + 币种/单位 fixture
    if (!body) {
      const { hashPassword } = await import('~/platform/auth/password.ts')
      const password = 'admin123'
      const hashed = await hashPassword(password)
      await db
        .insertInto('sys_user')
        .values({
          username: 'admin',
          name: 'market-integration-admin',
          hashed_password: hashed,
          super_admin: true,
          all_companies: true,
        })
        .onConflict((oc) =>
          oc.column('username').doUpdateSet({
            hashed_password: hashed,
            super_admin: true,
            all_companies: true,
          }),
        )
        .execute()
      body = await tryLogin('admin', password)
    }
    expect(body).toBeTruthy()
    token = body!.token
    actor = {
      userId: body!.user.id,
      username: body!.user.username,
      name: null,
      superAdmin: true,
      allCompanies: true,
      permissions: new Set(['*']),
      companyIds: [],
    }

    // 共享库可能被 setup 清空后残留 inactive 币种；优先启用已有 CNY/任意币种
    let cur = await db
      .selectFrom('bas_currency')
      .select(['id'])
      .where('active', '=', true)
      .executeTakeFirst()
    if (!cur) {
      const existing = await db
        .selectFrom('bas_currency')
        .select(['id'])
        .where('iso_code', '=', 'CNY')
        .executeTakeFirst()
      if (existing) {
        cur = await db
          .updateTable('bas_currency')
          .set({ active: true })
          .where('id', '=', existing.id)
          .returning(['id'])
          .executeTakeFirstOrThrow()
      } else {
        cur = await db
          .insertInto('bas_currency')
          .values({
            name: '人民币',
            iso_code: 'CNY',
            symbol: '¥',
            active: true,
          })
          .returning(['id'])
          .executeTakeFirstOrThrow()
      }
    }
    let units = await db.selectFrom('bas_unit').select(['id']).limit(2).execute()
    if (units.length < 2) {
      const suffix = crypto.randomUUID().slice(0, 6)
      // 共享库可能已有 quantity 基准单位（唯一索引 bas_unit_unique_base_per_type_index）
      const hasBase = await db
        .selectFrom('bas_unit')
        .select(['id'])
        .where('unit_type', '=', 'quantity')
        .where('is_base', '=', true)
        .executeTakeFirst()
      const toInsert: Array<{
        unit_type: string
        is_base: boolean
        name: string
        symbol: string
        ratio: string
      }> = []
      if (!hasBase) {
        toInsert.push({
          unit_type: 'quantity',
          is_base: true,
          name: `件-${suffix}`,
          symbol: `pcs${suffix}`,
          ratio: '1',
        })
      }
      // 再补非基准单位直到总数 ≥ 2
      let projected = units.length + toInsert.length
      let i = 0
      while (projected < 2) {
        toInsert.push({
          unit_type: 'quantity',
          is_base: false,
          name: `个-${suffix}-${i}`,
          symbol: `ge${suffix}${i}`,
          ratio: '1',
        })
        projected++
        i++
      }
      if (toInsert.length > 0) {
        await db.insertInto('bas_unit').values(toInsert).execute()
      }
      units = await db.selectFrom('bas_unit').select(['id']).limit(2).execute()
    }
    if (!cur || units.length < 2) throw new Error('需要启用币种与至少两个单位种子')
    currencyId = cur.id
    unitId = units[0]!.id
    unitId2 = units[1]!.id
  })

  afterAll(async () => {
    for (const id of createdPoints) {
      await db.deleteFrom('bas_market_price_point').where('id', '=', id).execute()
    }
    for (const id of createdInstruments) {
      await db.deleteFrom('bas_market_price_point').where('instrument_id', '=', id).execute()
      await db.deleteFrom('bas_market_instrument').where('id', '=', id).execute()
    }
    await db.destroy()
  })

  function authHeaders() {
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    }
  }

  test('品种 CRUD + 价点唯一/作废重录 + 取价 + 序列', async () => {
    const settings = createSettingsService(db, {
      sales: createSalesSettingService(db),
      manufacturing: createManufacturingSettingService(db),
      accounting: createAccountingSettingService(db),
    })
    const market = createMarketService(db, { settings })
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()
    const code = `T14${suffix}`

    const inst = await market.createInstrument(actor, {
      code,
      name: `工单14-${suffix}`,
      sourceType: 'EXCHANGE',
      defaultPriceKind: 'SETTLEMENT',
      currencyId,
      unitId,
    })
    createdInstruments.push(inst.id)
    expect(inst.active).toBe(true)
    expect(inst.fetchEnabled).toBe(false)
    expect(inst.externalLastCode).toBeNull()

    const point = await market.createPricePoint(actor, {
      instrumentId: inst.id,
      observedAt: new Date('2024-02-03T04:05:06Z'),
      price: '101.25',
    })
    createdPoints.push(point.id)
    expect(point.priceKind).toBe('SETTLEMENT')
    expect(point.source).toBe('MANUAL')
    expect(point.currencyId).toBe(currencyId)

    await expect(
      market.createPricePoint(actor, {
        instrumentId: inst.id,
        observedAt: new Date('2024-02-03T04:05:06Z'),
        price: '199',
        priceKind: 'SETTLEMENT',
      }),
    ).rejects.toMatchObject({ code: 'conflict' })

    const voided = await market.voidPricePoint(actor, point.id)
    expect(voided.isVoided).toBe(true)

    const rerecorded = await market.createPricePoint(actor, {
      instrumentId: inst.id,
      observedAt: new Date('2024-02-03T04:05:06Z'),
      price: '102.5',
    })
    createdPoints.push(rerecorded.id)

    const quote = await market.takeQuote(inst.id, new Date('2024-02-03T12:00:00Z'), null)
    expect(quote.price).toBe('102.5')
    expect(quote.priceKind).toBe('SETTLEMENT')

    const later = await market.createPricePoint(actor, {
      instrumentId: inst.id,
      observedAt: new Date('2024-02-04T04:05:06Z'),
      price: '103',
    })
    createdPoints.push(later.id)

    const series = await market.priceSeries(
      actor,
      [inst.id],
      'SETTLEMENT',
      new Date('2024-02-03T04:05:06Z'),
      new Date('2024-02-04T04:05:06Z'),
    )
    expect(series.priceKind).toBe('settlement')
    expect(series.series[0]?.points.map((p) => p.price)).toEqual(['102.5', '103'])

    await expect(market.deleteInstrument(actor, inst.id)).rejects.toMatchObject({
      code: 'conflict',
    })

    // HTTP 面：query + meta
    const listed = await app.request('/api/v1/base/market-instruments/query', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ limit: 50, offset: 0, search: code }),
    })
    expect(listed.status).toBe(200)
    const listBody = (await listed.json()) as { count: number; results: Array<{ code: string }> }
    expect(listBody.results.some((r) => r.code === code)).toBe(true)

    const meta = await app.request('/api/v1/meta/resources/basMarketInstruments', {
      headers: authHeaders(),
    })
    expect(meta.status).toBe(200)
    const metaBody = (await meta.json()) as {
      form?: { exclude?: string[] }
      grid: { columns: Array<{ name: string }> }
    }
    expect(metaBody.form?.exclude?.sort()).toEqual(['id', 'insertedAt', 'updatedAt'].sort())
    expect(metaBody.grid.columns.some((c) => c.name === 'externalLastCode')).toBe(true)

    const cross = await market.createInstrument(actor, {
      code: `${code}X`,
      name: `跨单位-${suffix}`,
      sourceType: 'EXCHANGE',
      defaultPriceKind: 'SETTLEMENT',
      currencyId,
      unitId: unitId2,
    })
    createdInstruments.push(cross.id)
    await expect(
      market.priceSeries(
        actor,
        [inst.id, cross.id],
        'SETTLEMENT',
        new Date('2024-02-03T04:05:06Z'),
        new Date('2024-02-04T04:05:06Z'),
      ),
    ).rejects.toMatchObject({ code: 'validation' })

    // 空刷新写摘要
    const refreshRes = await app.request('/api/v1/base/market-price-points/refresh', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ instrumentId: crypto.randomUUID() }),
    })
    expect(refreshRes.status).toBe(200)
    const refreshBody = (await refreshRes.json()) as { count: number; items: unknown[] }
    expect(refreshBody).toEqual({ count: 0, items: [] })
    const sys = await settings.loadSystemConfig()
    expect(sys.marketFetchLastSummary).toBe('手动刷新: 成功0 跳过0 失败0')
    expect(sys.marketFetchLastRunAt).not.toBeNull()

    // 注入假客户端刷新：最新价 + 结算价（上海 16:00 → 过结算窗）
    const fetchInst = await market.createInstrument(actor, {
      code: `${code}F`,
      name: `拉取-${suffix}`,
      sourceType: 'EXCHANGE',
      defaultPriceKind: 'SETTLEMENT',
      fetchEnabled: true,
      externalLastCode: 'CU0',
      externalProductGroup: 'cu',
      currencyId,
      unitId,
    })
    createdInstruments.push(fetchInst.id)
    const now = new Date(Date.UTC(2026, 6, 17, 8, 0, 45)) // 上海 16:00
    const { decimal: d } = await import('@synie/shared')
    const refresh = await market.refresh(
      actor,
      fetchInst.id,
      now,
      {
        fetchLast: async () => ({
          price: d('88888'),
          asOfDate: '2026-07-17',
        }),
      },
      {
        fetchSettlement: async () => ({
          price: d('77000'),
          deliveryMonth: '2609',
          openInterest: 100,
        }),
      },
    )
    expect(refresh.count).toBe(2)
    expect(refresh.items.map((i) => i.status)).toEqual(['ok', 'ok'])
    for (const item of refresh.items) {
      if (item.pricePointId) createdPoints.push(item.pricePointId)
    }
    // 同分钟再刷最新价应 skip
    const again = await market.refreshLasts(actor, fetchInst.id, now, {
      fetchLast: async () => {
        throw new Error('should not call')
      },
    })
    expect(again.items[0]?.status).toBe('skipped')
  })
})
