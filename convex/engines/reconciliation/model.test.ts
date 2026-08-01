import { expect, test } from 'bun:test'
import { glProjectionModel, inventoryProjectionModel } from './model'

test('facts 可确定性重建库存日/月/current，cancel facts 被排除', () => {
  const rows = [
    { companyId: 'c', warehouseId: 'w', materialId: 'm', postingDate: '2026-07-01', signedBaseQty: 10n, cancelled: false },
    { companyId: 'c', warehouseId: 'w', materialId: 'm', postingDate: '2026-07-02', signedBaseQty: -3n, cancelled: false },
    { companyId: 'c', warehouseId: 'w', materialId: 'm', postingDate: '2026-07-03', signedBaseQty: -9n, cancelled: true },
  ]
  expect([...inventoryProjectionModel(rows).current.values()]).toEqual([7n])
})

test('GL model 将 reverse 当事实、cancel 排除并维护 party 维度', () => {
  const base = { companyId: 'c', accountId: 'a', postingDate: '2026-07-01', partyType: 'customer', partyId: 'p', cancelled: false }
  const rows = [
    { ...base, debit: 10n, credit: 0n },
    { ...base, debit: -10n, credit: 0n },
  ]
  const model = glProjectionModel(rows)
  expect([...model.accountDaily.values()]).toEqual([{ debit: 0n, credit: 0n }])
  expect(model.partyDaily.size).toBe(1)
})
