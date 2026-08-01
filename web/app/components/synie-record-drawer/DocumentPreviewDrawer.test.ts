import { describe, expect, test } from 'bun:test'
import type { ResourceDocument } from '@synie/shared'
import type { ResourceBinding } from '~/lib/resources/catalog'
import { createResourceQueryCache } from '~/lib/resources/catalog'
import { presentationFor } from '~/lib/resources/presentation'
import type { ResourceList, ResourceQuery } from '~/lib/resources/types'
import type { Row } from '../synie-data-grid/types'
import {
  documentPreviewLineQuery,
  type DocumentPreviewBindingResolver,
} from './DocumentPreviewDrawer'
import type { DocumentPreviewLineTable } from './document-preview'

function memoryBinding(
  resource: string,
  query: (input: ResourceQuery) => Promise<ResourceList>,
): ResourceBinding {
  return {
    resource,
    reader: {
      query,
      get: async () => null,
    },
    cache: createResourceQueryCache(resource, `memory:${resource}`),
    loadDocument: async () => ({}) as ResourceDocument,
  }
}

const done = (results: Row[]): ResourceList => ({
  results,
  pageInfo: { continueCursor: null, isDone: true },
})

function resolver(
  bindings: Record<string, ResourceBinding>,
): DocumentPreviewBindingResolver {
  return (resource) => {
    const binding = bindings[resource]
    if (!binding) throw new Error(`测试未注入 ${resource}`)
    return binding
  }
}

describe('Document Preview ResourceBinding seam', () => {
  test('标准子表查询可替换 memory Reader，并使用该 binding 的 grid key', async () => {
    const calls: ResourceQuery[] = []
    const lineBinding = memoryBinding('invStockDocItems', async (input) => {
      calls.push(input)
      return done([{ id: 'line-1', qty: '2' }])
    })
    const table: DocumentPreviewLineTable = {
      title: '出入库行',
      resource: 'invStockDocItems',
      parentIdField: 'stockDocId',
    }

    const query = documentPreviewLineQuery(
      table,
      'invStockDocs',
      'doc-1',
      resolver({ invStockDocItems: lineBinding }),
    )

    expect(query.queryKey).toEqual([
      'gridRows',
      'memory:invStockDocItems',
      'invStockDocItems',
      'documentPreview',
      'invStockDocs',
      'doc-1',
    ])
    await expect(query.queryFn()).resolves.toEqual({
      results: [{ id: 'line-1', qty: '2' }],
    })
    expect(calls).toEqual([
      {
        profile: 'default',
        numItems: 100,
        cursor: null,
        sort: { column: 'idx', direction: 'ascending' },
        fixedFilter: {
          stockDocId: {
            kind: 'fk',
            op: 'in',
            values: ['doc-1'],
            labels: [],
          },
        },
      },
    ])
  })

  test('binding.invalidateGrid 的 scope 能命中 preview query key', async () => {
    const lineBinding = memoryBinding('mfgOutputItems', async () => done([]))
    const query = documentPreviewLineQuery(
      {
        title: '入库条目',
        resource: 'mfgOutputItems',
        parentIdField: 'outputId',
      },
      'mfgOutputs',
      'output-1',
      resolver({ mfgOutputItems: lineBinding }),
    )
    let matched = false

    await lineBinding.cache.invalidateGrid({
      invalidateQueries: async ({ queryKey }) => {
        matched = queryKey.every(
          (part, index) => query.queryKey[index] === part,
        )
      },
    })

    expect(matched).toBe(true)
  })

  test('默认 200 行上限按 Convex 单页 100 行限制游标拉取', async () => {
    const calls: Array<Pick<ResourceQuery, 'numItems' | 'cursor'>> = []
    const lineBinding = memoryBinding('mfgOutputItems', async (input) => {
      calls.push({ numItems: input.numItems, cursor: input.cursor })
      if (input.numItems > 100) {
        throw new Error('每页条数必须是 1..100 的整数')
      }
      return input.cursor == null
        ? {
            results: [{ id: 'line-1' }],
            pageInfo: { continueCursor: 'next/opaque', isDone: false },
          }
        : {
            results: [{ id: 'line-2' }],
            pageInfo: { continueCursor: null, isDone: true },
          }
    })

    const table = presentationFor('mfgOutputs').documentPreview?.lineTables[0]
    if (!table) throw new Error('生产入库单缺少速览子表配置')
    const query = documentPreviewLineQuery(
      table,
      'mfgOutputs',
      'output-1',
      resolver({ mfgOutputItems: lineBinding }),
    )

    await expect(query.queryFn()).resolves.toEqual({
      results: [{ id: 'line-1' }, { id: 'line-2' }],
    })
    expect(calls).toEqual([
      { numItems: 100, cursor: null },
      { numItems: 100, cursor: 'next/opaque' },
    ])
  })

  test('委外入库两项两段 loader 也只解析注入的 Reader', async () => {
    const calls: Array<{ resource: string; input: ResourceQuery }> = []
    const items = memoryBinding('purOutsourcedReceiptItems', async (input) => {
      calls.push({ resource: 'purOutsourcedReceiptItems', input })
      return done([{ id: 'item-1' }, { id: 'item-2' }])
    })
    const materials = memoryBinding(
      'purOutsourcedReceiptItemMaterials',
      async (input) => {
        calls.push({ resource: 'purOutsourcedReceiptItemMaterials', input })
        const parent = input.fixedFilter?.receiptItemId as
          | { values?: string[] }
          | undefined
        return done([{ id: `material-${parent?.values?.[0] ?? 'unscoped'}` }])
      },
    )
    const byproducts = memoryBinding(
      'purOutsourcedReceiptItemByproducts',
      async (input) => {
        calls.push({ resource: 'purOutsourcedReceiptItemByproducts', input })
        const parent = input.fixedFilter?.receiptItemId as
          | { values?: string[] }
          | undefined
        return done([{ id: `byproduct-${parent?.values?.[0] ?? 'unscoped'}` }])
      },
    )
    const resolve = resolver({
      purOutsourcedReceiptItems: items,
      purOutsourcedReceiptItemMaterials: materials,
      purOutsourcedReceiptItemByproducts: byproducts,
    })
    const tables = presentationFor(
      'purOutsourcedReceipts',
    ).documentPreview!.lineTables.filter((table) => table.load)

    expect(tables.map((table) => table.resource)).toEqual([
      'purOutsourcedReceiptItemMaterials',
      'purOutsourcedReceiptItemByproducts',
    ])
    const results: Array<{ results: Row[] }> = []
    for (const table of tables) {
      results.push(
        await documentPreviewLineQuery(
          table,
          'purOutsourcedReceipts',
          'receipt-1',
          resolve,
        ).queryFn(),
      )
    }

    expect(results).toEqual([
      {
        results: [{ id: 'material-item-1' }, { id: 'material-item-2' }],
      },
      {
        results: [{ id: 'byproduct-item-1' }, { id: 'byproduct-item-2' }],
      },
    ])
    expect(calls.map(({ resource }) => resource)).toEqual([
      'purOutsourcedReceiptItems',
      'purOutsourcedReceiptItemMaterials',
      'purOutsourcedReceiptItemMaterials',
      'purOutsourcedReceiptItems',
      'purOutsourcedReceiptItemByproducts',
      'purOutsourcedReceiptItemByproducts',
    ])
    for (const call of calls) expect(call.input.numItems).toBeLessThanOrEqual(100)
    for (const call of calls.filter(({ resource }) => resource === 'purOutsourcedReceiptItems')) {
      expect(call.input.fixedFilter).toEqual({
        receiptId: {
          kind: 'fk',
          op: 'in',
          values: ['receipt-1'],
          labels: [],
        },
      })
    }
    for (const call of calls.filter(
      ({ resource }) =>
        resource.endsWith('Materials') || resource.endsWith('Byproducts'),
    )) {
      const parent = call.input.fixedFilter?.receiptItemId as
        | { values?: string[] }
        | undefined
      expect(parent?.values).toHaveLength(1)
      const parentId = parent?.values?.[0]
      expect(parentId).toBeDefined()
      expect(['item-1', 'item-2']).toContain(parentId as string)
      expect(call.input.filter).toBeUndefined()
    }
  })
})
