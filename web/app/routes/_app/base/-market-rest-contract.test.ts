import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveSource } from '~/components/synie-remote-select/remote-query'

const source = readFileSync(join(import.meta.dirname, 'market.tsx'), 'utf8')

const FORBIDDEN_GRAPHQL_MARKERS = [
  'gqlFetch',
  'myPermissions',
  'basMarketChartInstruments',
  'basMarketPriceSeries',
  'createBasMarketPricePoint',
  'createBasMarketInstrument',
  'updateBasMarketInstrument',
  'refreshBasMarketPricePoints',
] as const

describe('行情页 REST 迁移契约', () => {
  test('页面不含旧 GraphQL operation', () => {
    for (const marker of FORBIDDEN_GRAPHQL_MARKERS) {
      expect(source).not.toContain(marker)
    }
  })

  test('Meta 请求成功本身代表 read 权限', () => {
    expect(source).toContain('const canPriceRead = priceMeta.data != null')
    expect(source).toContain('const canInstrumentRead = instrumentMeta.data != null')
    expect(source).not.toContain("capabilities ?? []).includes('read')")
  })

  test('两个 Grid 与两个 Drawer 均消费 Catalog Basic Form transport', () => {
    expect(source).toContain("useCatalogBasicForm('basMarketPricePoints'")
    expect(source).toContain("useCatalogBasicForm('basMarketInstruments'")
    expect(source).toContain('client={priceForm.client}')
    expect(source).toContain('client={instrumentForm.client}')
    expect(source.match(/resource="basMarketPricePoints"\s+client=\{marketPricePointClient\}/g)).toHaveLength(1)
    expect(source.match(/resource="basMarketInstruments"\s+client=\{marketInstrumentClient\}/g)).toHaveLength(1)
  })

  test('行情相关远程选择器从 shared resolver 获得 REST client', () => {
    expect(resolveSource({ resource: 'basMarketInstruments' })?.client?.id).toBe(
      'rest:basMarketInstruments',
    )
    expect(resolveSource({ resource: 'basCurrencies' })?.client?.id).toBe(
      'rest:basCurrencies',
    )
    expect(resolveSource({ resource: 'basUnits' })?.client?.id).toBe('rest:basUnits')
  })
})
