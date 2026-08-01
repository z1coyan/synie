import { describe, expect, test } from 'bun:test'
import { preparePrintBaseline } from './printing-smoke-fixtures'

describe('preparePrintBaseline', () => {
  test('uses one hundred distinct persisted records for the upper-bound print baseline', async () => {
    let nextId = 3
    const ids = await preparePrintBaseline(
      [{ id: 'order-1' }, { id: 'order-2' }],
      async () => ({ id: `order-${nextId++}` }),
    )

    expect(ids).toHaveLength(100)
    expect(new Set(ids).size).toBe(100)
    expect(nextId).toBe(101)
  })

  test('fails closed when the fixture factory returns a duplicate record', async () => {
    await expect(preparePrintBaseline(
      [{ id: 'order-1' }, { id: 'order-2' }],
      async () => ({ id: 'order-2' }),
    )).rejects.toThrow('100 条打印基线 fixture 必须互不重复')
  })
})
