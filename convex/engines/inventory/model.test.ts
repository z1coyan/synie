import { describe, expect, test } from 'bun:test'
import { groupDeltas, normalizeLines, validateVoucher } from './model'

const wid = 'warehouse' as never
const mid = 'material' as never

describe('inventory 旧行为 oracle', () => {
  test('空分录拒绝', () => expect(() => normalizeLines([])).toThrow('库存过账校验失败'))
  test('凭证缺参拒绝', () => expect(() => validateVoucher({ type: '', id: '', no: '', companyId: '', postingDate: '' })).toThrow('库存过账参数不合法'))
  test('数量为零拒绝（触库前）', () => expect(() => normalizeLines([{ warehouseId: wid, materialId: mid, quantity: '0', direction: 'in' }])).toThrow('库存过账校验失败'))
  test('数量 6 位 half-up 且按仓物料聚合但保留原始行', () => {
    const lines = normalizeLines([
      { warehouseId: wid, materialId: mid, quantity: '1.0000004', direction: 'in' },
      { warehouseId: wid, materialId: mid, quantity: '0.2', direction: 'out' },
    ])
    expect(lines).toHaveLength(2)
    expect(groupDeltas(lines)[0]?.delta).toBe(800_000n)
  })
})
