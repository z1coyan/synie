import { describe, expect, test } from 'bun:test'
import { readAllWarehouseSupportRows } from './warehouse-support'

describe('warehouse support option pagination', () => {
  test('每页最多 100，并在空页后继续沿 opaque cursor', async () => {
    const calls: Array<{ numItems: number; cursor: string | null }> = []
    const rows = await readAllWarehouseSupportRows(async (numItems, cursor) => {
      calls.push({ numItems, cursor })
      if (cursor === null) return {
        results: [],
        pageInfo: { continueCursor: 'options/next', isDone: false },
      }
      return {
        results: [{ id: 'option-1', name: '选项一' }],
        pageInfo: { continueCursor: null, isDone: true },
      }
    })
    expect(calls).toEqual([
      { numItems: 100, cursor: null },
      { numItems: 100, cursor: 'options/next' },
    ])
    expect(rows.map(row => row.id)).toEqual(['option-1'])
  })

  test('缺失或重复 cursor 时 fail-closed', async () => {
    await expect(readAllWarehouseSupportRows(async () => ({
      results: [],
      pageInfo: { continueCursor: null, isDone: false },
    }))).rejects.toThrow(/缺少 continueCursor/)

    await expect(readAllWarehouseSupportRows(async () => ({
      results: [],
      pageInfo: { continueCursor: 'same', isDone: false },
    }))).rejects.toThrow(/cursor 重复/)
  })
})
