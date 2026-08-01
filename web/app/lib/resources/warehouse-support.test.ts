import { describe, expect, test } from 'bun:test'
import type { ConvexReactClient } from 'convex/react'
import { loadWarehouseSupportContext, readAllWarehouseSupportRows } from './warehouse-support'

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

  test('只通过仓库专用接口加载四类最小候选，并固定每页 100', async () => {
    const calls: Array<Record<string, unknown>> = []
    const rowsByKind = {
      companies: [{ id: 'company-1', name: '公司一', code: 'C1' }],
      accounts: [{ id: 'account-1', name: '库存科目', code: '1405' }],
      suppliers: [{ id: 'supplier-1', name: '供应商一' }],
      parents: [{ id: 'warehouse-1', name: '总仓' }],
    }
    const client = {
      async query(_reference: unknown, rawArgs: unknown) {
        const args = rawArgs as { kind: keyof typeof rowsByKind; numItems: number; cursor: string | null; companyId?: string }
        calls.push(args)
        return {
          results: rowsByKind[args.kind],
          pageInfo: { continueCursor: null, isDone: true },
        }
      },
    } as unknown as ConvexReactClient

    const result = await loadWarehouseSupportContext(client, 'company-1')

    expect(result).toEqual({
      companies: [{ id: 'company-1', name: '公司一', code: 'C1' }],
      accounts: [{ id: 'account-1', name: '库存科目', code: '1405' }],
      suppliers: [{ id: 'supplier-1', name: '供应商一' }],
      parents: [{ id: 'warehouse-1', name: '总仓' }],
    })
    expect(calls.sort((left, right) => String(left.kind).localeCompare(String(right.kind)))).toEqual([
      { kind: 'accounts', numItems: 100, cursor: null, companyId: 'company-1' },
      { kind: 'companies', numItems: 100, cursor: null },
      { kind: 'parents', numItems: 100, cursor: null, companyId: 'company-1' },
      { kind: 'suppliers', numItems: 100, cursor: null },
    ])
  })
})
