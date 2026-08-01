import { describe, expect, test } from 'bun:test'
import {
  aggregateDraftId,
  aggregateDraftRows,
  journalDraftLine,
  stockCountDraftRow,
  stockMovementDraftRow,
} from './aggregate-draft-rows'

describe('库存与会计 AggregateDraft 行契约', () => {
  test('完整 loadDraft 集合不受旧 200 行分页上限影响', () => {
    const items = Array.from({ length: 237 }, (_, index) => ({
      id: `item-${index + 1}`,
      idx: index + 1,
    }))
    expect(aggregateDraftRows({ id: 'doc-1', items }, 'items', '库存单')).toEqual(items)
  })

  test('缺集合、坏行或坏头 id 均 fail-closed', () => {
    expect(() => aggregateDraftRows({ id: 'doc-1' }, 'items', '库存单')).toThrow(
      '缺少完整 items 集合',
    )
    expect(() =>
      aggregateDraftRows({ id: 'doc-1', items: [{ qty: '1' }] }, 'items', '库存单'),
    ).toThrow('第 1 行缺少 id')
    expect(() => aggregateDraftId({ items: [] }, '库存单')).toThrow('草稿响应缺少 id')
  })

  test('替换库存移动行保留存量 id，本地 id 不越过 mutation 边界', () => {
    const fields = {
      idx: 3,
      materialId: 'material-1',
      unitId: 'unit-1',
      qty: '2.5',
      remark: null,
    }
    expect(stockMovementDraftRow({ id: 'stored-item', ...fields })).toEqual({
      id: 'stored-item',
      ...fields,
    })
    expect(stockMovementDraftRow({ id: 'local:new-item', ...fields })).toEqual(fields)
  })

  test('盘点行与凭证行同样只携带声明字段并保留存量 id', () => {
    expect(stockCountDraftRow({
      id: 'count-item-1',
      materialId: 'material-1',
      unitId: 'unit-1',
      countedQuantity: '9',
      bookQuantity: '10',
      materialName: '不应回传的快照',
    })).toEqual({
      id: 'count-item-1',
      materialId: 'material-1',
      unitId: 'unit-1',
      countedQuantity: '9',
      remark: null,
    })

    expect(journalDraftLine({
      id: 'journal-line-1',
      idx: 1,
      accountId: 'account-1',
      debit: '100',
      credit: '0',
      currencyId: 'server-owned',
    })).toEqual({
      id: 'journal-line-1',
      idx: 1,
      accountId: 'account-1',
      debit: '100',
      credit: '0',
      partyType: null,
      partyId: null,
      remarks: null,
    })
  })

  test('mutation 权威响应 id 可直接交给保存并审核', () => {
    expect(aggregateDraftId({ id: 'saved-1', items: [] }, '库存单')).toBe('saved-1')
  })
})
