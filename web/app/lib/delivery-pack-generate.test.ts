import { describe, expect, test } from 'bun:test'
import {
  generateItemsFromPack,
  microsTimesScaled,
  microsToString,
  parseMicros,
  parseScaled,
  qtyDivFactorToMicros,
  type FifoCandidate,
} from './delivery-pack-generate'

// ---- 精度原语 ----

describe('parseMicros / microsToString', () => {
  test('整数与小数互转', () => {
    expect(parseMicros('120')).toBe(120_000_000n)
    expect(parseMicros('0.333333')).toBe(333_333n)
    expect(parseMicros(1.5)).toBe(1_500_000n)
    expect(microsToString(120_000_000n)).toBe('120')
    expect(microsToString(333_333n)).toBe('0.333333')
    expect(microsToString(1_500_000n)).toBe('1.5')
  })

  test('超 6 位截断;非法输入按 0', () => {
    expect(parseMicros('0.123456789')).toBe(123_456n)
    expect(parseMicros('abc')).toBe(0n)
    expect(parseMicros(null)).toBe(0n)
  })
})

describe('microsTimesScaled(生成行数量 = 分摊 base × 系数,精确串)', () => {
  test('整数系数与分数系数', () => {
    // 10 base × 3 = 30(如 1 默认单位 = 3 该单位)
    expect(microsTimesScaled(10_000_000n, 3n, 0)).toBe('30')
    // 10 base × 0.5 = 5
    expect(microsTimesScaled(10_000_000n, 5n, 1)).toBe('5')
    // 0.333333 base × 3 = 0.999999(有限精确,无浮点尾巴)
    expect(microsTimesScaled(333_333n, 3n, 0)).toBe('0.999999')
  })

  test('回算无损:qty ÷ factor 四舍五入恰好回到分摊 base(服务端重算口径)', () => {
    const share = parseMicros('0.333333')
    const qty = microsTimesScaled(share, 3n, 0) // "0.999999"
    const back = qtyDivFactorToMicros(parseScaled(qty), parseScaled('3'))
    expect(back).toBe(share)
  })
})

describe('qtyDivFactorToMicros(装箱行 base 的本地推算)', () => {
  test('默认单位 factor=1 原值;HALF_UP 舍入', () => {
    expect(qtyDivFactorToMicros(parseScaled('12.5'), parseScaled('1'))).toBe(12_500_000n)
    // 1 ÷ 3 = 0.3333335 → 0.333334(HALF_UP)
    expect(qtyDivFactorToMicros(parseScaled('1'), parseScaled('3'))).toBe(333_333n)
    expect(qtyDivFactorToMicros(parseScaled('2'), parseScaled('3'))).toBe(666_667n)
  })
})

// ---- FIFO 分摊 ----

function cand(partial: Partial<FifoCandidate> & { orderItemId: string }): FifoCandidate {
  return {
    orderDate: '2026-07-01',
    orderNo: 'SO-001',
    materialId: 'M1',
    unitId: 'U1',
    unitName: '件',
    currencyCode: 'CNY',
    remainingMicros: 100_000_000n,
    factorNum: 1n,
    factorScale: 0,
    orderQty: '100',
    materialCode: 'F(P)-1',
    materialName: '铜网',
    materialSpec: null,
    customerPartNo: null,
    ...partial,
  }
}

function pack(materialId: string, packed: string, label = materialId) {
  return { materialId, label, packedMicros: parseMicros(packed) }
}

describe('generateItemsFromPack', () => {
  test('单候选足额:生成一行,数量随订单条目单位系数折算', () => {
    const r = generateItemsFromPack({
      packs: [pack('M1', '60', 'F(P)-1 铜网')],
      candidates: [cand({ orderItemId: 'OI1', factorNum: 3n, unitName: '箱' })],
      existing: [],
    })
    expect(r.unallocated).toEqual([])
    expect(r.mismatched).toEqual([])
    expect(r.lines).toHaveLength(1)
    expect(r.lines[0]).toMatchObject({
      orderItemId: 'OI1',
      qty: '180', // 60 base × 3
      baseQty: '60',
      orderNo: 'SO-001',
      unitName: '箱',
    })
  })

  test('FIFO 跨订单:按订单日期升序装满再扣下一条,可拆多行', () => {
    const r = generateItemsFromPack({
      packs: [pack('M1', '150')],
      candidates: [
        cand({ orderItemId: 'OI-new', orderDate: '2026-07-20', orderNo: 'SO-002' }),
        cand({ orderItemId: 'OI-old', orderDate: '2026-07-01', orderNo: 'SO-001' }),
      ],
      existing: [],
    })
    expect(r.lines.map((l) => [l.orderItemId, l.baseQty])).toEqual([
      ['OI-old', '100'],
      ['OI-new', '50'],
    ])
    expect(r.unallocated).toEqual([])
  })

  test('尾差只分不超:超剩余部分进 unallocated,不压进末行', () => {
    const r = generateItemsFromPack({
      packs: [pack('M1', '120', 'F(P)-1 铜网')],
      candidates: [cand({ orderItemId: 'OI1' })], // 仅剩 100
      existing: [],
    })
    expect(r.lines).toHaveLength(1)
    expect(r.lines[0]!.baseQty).toBe('100')
    expect(r.unallocated).toEqual([
      {
        materialId: 'M1',
        label: 'F(P)-1 铜网',
        reason: 'shortfall',
        packed: '120',
        allocated: '100',
        remainder: '20',
      },
    ])
  })

  test('零候选:一行不生,报 no-candidate', () => {
    const r = generateItemsFromPack({
      packs: [pack('M1', '10')],
      candidates: [cand({ orderItemId: 'OI1', materialId: 'M2' })],
      existing: [],
    })
    expect(r.lines).toEqual([])
    expect(r.unallocated[0]).toMatchObject({ reason: 'no-candidate', remainder: '10' })
  })

  test('币种锁定:既有行定币,异币种候选排除;全异币种报 currency-mismatch', () => {
    const r = generateItemsFromPack({
      packs: [pack('M1', '10'), pack('M2', '5')],
      candidates: [
        cand({ orderItemId: 'OI-usd', materialId: 'M1', currencyCode: 'USD' }),
        cand({ orderItemId: 'OI-cny', materialId: 'M1', currencyCode: 'CNY' }),
        cand({ orderItemId: 'OI-usd2', materialId: 'M2', currencyCode: 'USD' }),
      ],
      existing: [{ materialId: 'M3', label: '既有', baseMicros: 1_000_000n, currencyCode: 'CNY' }],
    })
    // M1 只用 CNY 候选
    expect(r.lines.map((l) => l.orderItemId)).toEqual(['OI-cny'])
    // M2 只有 USD 候选 → currency-mismatch
    expect(r.unallocated).toEqual([
      expect.objectContaining({ reason: 'currency-mismatch', materialId: 'M2', currencyCode: 'CNY' }),
    ])
    // M3 有既有一条无装箱行 → 第③组提醒
    expect(r.mismatched).toEqual([
      { materialId: 'M3', label: '既有', itemsBase: '1', packedBase: '0' },
    ])
  })

  test('无既有行时以最早候选定整单币种', () => {
    const r = generateItemsFromPack({
      packs: [pack('M1', '10'), pack('M2', '5')],
      candidates: [
        cand({ orderItemId: 'OI1', materialId: 'M1', orderDate: '2026-07-02', currencyCode: 'USD' }),
        cand({ orderItemId: 'OI2', materialId: 'M2', orderDate: '2026-07-01', currencyCode: 'USD' }),
        cand({ orderItemId: 'OI3', materialId: 'M2', orderDate: '2026-07-03', currencyCode: 'CNY' }),
      ],
      existing: [],
    })
    // 最早候选 OI2 是 USD → 整单锁 USD,M2 的 CNY 候选被排除
    expect(r.lines.map((l) => l.orderItemId).sort()).toEqual(['OI1', 'OI2'])
    expect(r.unallocated).toEqual([])
  })

  test('增量语义:已有条目的物料整物料跳过,对不上进 mismatched', () => {
    const r = generateItemsFromPack({
      packs: [pack('M1', '80', '铜网'), pack('M2', '10', '铜板')],
      candidates: [cand({ orderItemId: 'OI1', materialId: 'M1' }), cand({ orderItemId: 'OI2', materialId: 'M2' })],
      existing: [{ materialId: 'M1', label: '铜网', baseMicros: 50_000_000n, currencyCode: 'CNY' }],
    })
    // M1 跳过生成;M2 照常生成
    expect(r.lines.map((l) => l.materialId)).toEqual(['M2'])
    expect(r.mismatched).toEqual([
      { materialId: 'M1', label: '铜网', itemsBase: '50', packedBase: '80' },
    ])
  })

  test('已有条目且与装箱恰好相等:不提醒不生成', () => {
    const r = generateItemsFromPack({
      packs: [pack('M1', '50', '铜网')],
      candidates: [cand({ orderItemId: 'OI1' })],
      existing: [{ materialId: 'M1', label: '铜网', baseMicros: 50_000_000n, currencyCode: 'CNY' }],
    })
    expect(r.lines).toEqual([])
    expect(r.mismatched).toEqual([])
    expect(r.unallocated).toEqual([])
  })

  test('同物料同单多条目(不同单位):按条目 id 兜底序,系数各自折算', () => {
    const r = generateItemsFromPack({
      packs: [pack('M1', '120')],
      candidates: [
        cand({ orderItemId: 'OI-b', remainingMicros: 100_000_000n, factorNum: 1n }),
        cand({ orderItemId: 'OI-a', remainingMicros: 100_000_000n, factorNum: 3n }),
      ],
      existing: [],
    })
    expect(r.lines.map((l) => [l.orderItemId, l.qty])).toEqual([
      ['OI-a', '300'], // 100 × 3
      ['OI-b', '20'], // 20 × 1
    ])
  })

  test('空装箱输入:不生成不报错', () => {
    const r = generateItemsFromPack({ packs: [], candidates: [cand({ orderItemId: 'OI1' })], existing: [] })
    expect(r).toEqual({ lines: [], unallocated: [], mismatched: [] })
  })
})
