import { describe, expect, test } from 'bun:test'
import { decimal, toDecimalString } from '@synie/shared'
import {
  createPublicMarketClient,
  ERR_NOT_AVAILABLE,
  normalizeLastSymbol,
  parseShfeSettlementPayload,
  parseSinaLastBody,
  pastSettlementWindow,
} from './fetch.ts'

describe('parseSinaLastBody', () => {
  test('解析新浪最新价与 asOf 日期', () => {
    const body = `var hq_str_nf_CU0="铜连续,010000,103100.000,103990.000,103000.000,0.000,103840.000,103880.000,103880.000,0.000,103720.000,11,1,183964.000,31080,沪,铜,2026-07-18,1";`
    const quote = parseSinaLastBody(body, 'nf_CU0')
    expect(toDecimalString(quote.price) as string).toBe('103880')
    expect(quote.asOfDate).toBe('2026-07-18')
  })

  test('无数据 / 无效价抛错', () => {
    expect(() => parseSinaLastBody('var hq_str_nf_X="";', 'nf_X')).toThrow(/无数据/)
    const short = `var hq_str_nf_X="a,b,c";`
    expect(() => parseSinaLastBody(short, 'nf_X')).toThrow(/缺少最新价/)
  })
})

describe('parseShfeSettlementPayload', () => {
  test('选持仓量最大合约结算价', () => {
    const payload = {
      o_curinstrument: [
        {
          PRODUCTGROUPID: 'cu',
          DELIVERYMONTH: '2608',
          SETTLEMENTPRICE: 103810,
          OPENINTEREST: 127472,
        },
        {
          PRODUCTGROUPID: 'cu',
          DELIVERYMONTH: '2609',
          SETTLEMENTPRICE: 103720,
          OPENINTEREST: 180125,
        },
      ],
    }
    const quote = parseShfeSettlementPayload(payload, 'cu')
    expect(quote.deliveryMonth).toBe('2609')
    expect(quote.openInterest).toBe(180125)
    expect(toDecimalString(quote.price) as string).toBe('103720')
  })

  test('无匹配品种组抛错', () => {
    expect(() =>
      parseShfeSettlementPayload({ o_curinstrument: [] }, 'cu'),
    ).toThrow(/无品种组/)
  })
})

describe('createPublicMarketClient inject fetch', () => {
  test('最新价走注入 fetch + 规范化 nf_ 前缀', async () => {
    // 字段 0..8；第 8 位为最新价（对齐新浪 hq 格式）
    const body = `var hq_str_nf_CU0="铜连续,a,b,c,d,e,f,g,999.5,i,j,k,l,m,n,o,p,2026-07-18";`
    const client = createPublicMarketClient({
      fetchImpl: async (url) => {
        expect(String(url)).toContain('nf_CU0')
        return new Response(body, { status: 200 })
      },
    })
    expect(normalizeLastSymbol('CU0')).toBe('nf_CU0')
    const quote = await client.fetchLast('CU0')
    expect(toDecimalString(quote.price) as string).toBe('999.5')
    expect(quote.asOfDate).toBe('2026-07-18')
  })

  test('结算 404 → ERR_NOT_AVAILABLE', async () => {
    const client = createPublicMarketClient({
      fetchImpl: async () => new Response('', { status: 404 }),
    })
    try {
      await client.fetchSettlement('cu', new Date(Date.UTC(2026, 6, 17)))
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBe(ERR_NOT_AVAILABLE)
    }
  })

  test('结算 JSON 解析与最大 OI', async () => {
    const payload = {
      o_curinstrument: [
        {
          PRODUCTGROUPID: 'cu',
          DELIVERYMONTH: '2608',
          SETTLEMENTPRICE: '100',
          OPENINTEREST: '10',
        },
        {
          PRODUCTGROUPID: 'cu',
          DELIVERYMONTH: '2609',
          SETTLEMENTPRICE: '200',
          OPENINTEREST: '99',
        },
      ],
    }
    const client = createPublicMarketClient({
      fetchImpl: async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    })
    const quote = await client.fetchSettlement('cu', new Date(Date.UTC(2026, 6, 17)))
    expect(quote.deliveryMonth).toBe('2609')
    expect(toDecimalString(quote.price) as string).toBe('200')
  })
})

describe('pastSettlementWindow', () => {
  test('上海 15:29 / 15:30 边界', () => {
    expect(pastSettlementWindow(new Date(Date.UTC(2026, 6, 17, 7, 29, 0)))).toBe(false)
    expect(pastSettlementWindow(new Date(Date.UTC(2026, 6, 17, 7, 30, 0)))).toBe(true)
  })
})

describe('decimal 价格 >0（对齐 shopspring IsPositive）', () => {
  test('0 不视为正价', () => {
    expect(decimal('0').greaterThan(0)).toBe(false)
    expect(decimal('0.01').greaterThan(0)).toBe(true)
  })
})
