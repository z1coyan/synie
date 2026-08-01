/// <reference types="bun" />

import { describe, expect, test } from 'bun:test'
import {
  removeOwnerAttachments,
  replaceMaterialDrawingSnapshot,
} from './drawingSnapshots'

type Attachment = {
  _id: string
  fileId: string
  ownerType: string
  ownerId: string
  category: string
  companyId: string | null
  insertedAt: number
}

function context(seed: Attachment[]) {
  const rows = new Map(seed.map((row) => [row._id, row]))
  let sequence = 0
  const calls: Array<{ table: string; index: string; equals: Array<[string, unknown]> }> = []
  return {
    rows,
    calls,
    ctx: {
      db: {
        normalizeId(table: string, id: string) {
          return table === 'materials' && (id === 'material-1' || id === 'deleted-material') ? id : null
        },
        async get(id: string) {
          return id === 'material-1' ? { _id: id } : null
        },
        query(table: string) {
          return {
            withIndex(index: string, configure: (query: { eq: (field: string, value: unknown) => unknown }) => unknown) {
              const call = { table, index, equals: [] as Array<[string, unknown]> }
              const query = {
                eq(field: string, value: unknown) {
                  call.equals.push([field, value])
                  return query
                },
              }
              configure(query)
              calls.push(call)
              return {
                async take(limit: number) {
                  return [...rows.values()].filter((row) => call.equals.every(([field, value]) =>
                    row[field as keyof Attachment] === value,
                  )).slice(0, limit)
                },
              }
            },
          }
        },
        async delete(id: string) { rows.delete(id) },
        async insert(table: string, value: Omit<Attachment, '_id'>) {
          if (table !== 'attachments') throw new Error(`unexpected table ${table}`)
          const id = `inserted-${++sequence}`
          rows.set(id, { _id: id, ...value })
          return id
        },
      },
    },
  }
}

function attachment(
  id: string,
  fileId: string,
  ownerType: string,
  ownerId: string,
  category = 'drawing',
): Attachment {
  return { _id: id, fileId, ownerType, ownerId, category, companyId: null, insertedAt: 1 }
}

describe('物料图纸挂接快照', () => {
  test('保存行时整删旧 drawing 并复制物料当前 drawing，其他槽位不受影响', async () => {
    const state = context([
      attachment('source-1', 'file-a', 'inv_material', 'material-1'),
      attachment('source-2', 'file-b', 'inv_material', 'material-1'),
      attachment('source-default', 'file-c', 'inv_material', 'material-1', 'default'),
      attachment('old-target', 'file-old', 'sal_order_item', 'line-1'),
      attachment('target-default', 'file-keep', 'sal_order_item', 'line-1', 'default'),
    ])

    await replaceMaterialDrawingSnapshot(state.ctx as never, {
      materialId: 'material-1',
      ownerType: 'sal_order_item',
      ownerId: 'line-1',
      companyId: 'company-1',
    })

    const target = [...state.rows.values()].filter((row) =>
      row.ownerType === 'sal_order_item' && row.ownerId === 'line-1',
    )
    expect(target.map((row) => [row.fileId, row.category, row.companyId]).sort()).toEqual([
      ['file-a', 'drawing', 'company-1'],
      ['file-b', 'drawing', 'company-1'],
      ['file-keep', 'default', null],
    ])
    expect(state.calls).toEqual([
      {
        table: 'attachments', index: 'by_owner',
        equals: [['ownerType', 'sal_order_item'], ['ownerId', 'line-1']],
      },
      {
        table: 'attachments', index: 'by_owner',
        equals: [['ownerType', 'inv_material'], ['ownerId', 'material-1']],
      },
    ])
  })

  test('删除宿主时清理自己的全部挂接，不影响其他宿主', async () => {
    const state = context([
      attachment('drawing', 'file-a', 'pur_receipt_item', 'line-1'),
      attachment('default', 'file-b', 'pur_receipt_item', 'line-1', 'default'),
      attachment('other', 'file-c', 'pur_receipt_item', 'line-2'),
    ])

    await removeOwnerAttachments(state.ctx as never, 'pur_receipt_item', 'line-1')

    expect([...state.rows.keys()]).toEqual(['other'])
  })

  test('不存在的物料 fail closed，不先删除既有快照', async () => {
    const state = context([
      attachment('old-target', 'file-old', 'mfg_work_order', 'work-order-1'),
    ])

    await expect(replaceMaterialDrawingSnapshot(state.ctx as never, {
      materialId: 'deleted-material',
      ownerType: 'mfg_work_order',
      ownerId: 'work-order-1',
      companyId: 'company-1',
    })).rejects.toThrow('图纸快照物料不存在')
    expect(state.rows.has('old-target')).toBe(true)
    expect(state.calls).toEqual([])
  })

  test('替换后超过单宿主 200 个附件时显式拒绝且不删旧快照', async () => {
    const target = Array.from({ length: 200 }, (_, index) =>
      attachment(
        `target-${index}`,
        `target-file-${index}`,
        'sal_order_item',
        'line-1',
        index === 0 ? 'drawing' : 'default',
      ),
    )
    const state = context([
      ...target,
      attachment('source-1', 'source-file-1', 'inv_material', 'material-1'),
      attachment('source-2', 'source-file-2', 'inv_material', 'material-1'),
    ])

    await expect(replaceMaterialDrawingSnapshot(state.ctx as never, {
      materialId: 'material-1',
      ownerType: 'sal_order_item',
      ownerId: 'line-1',
      companyId: 'company-1',
    })).rejects.toThrow('最多挂接 200 个附件')
    expect(state.rows.has('target-0')).toBe(true)
    expect([...state.rows.values()].filter((row) => row.ownerId === 'line-1')).toHaveLength(200)
  })

  test('物料来源超过 20 张图纸时拒绝扇出且保留目标快照', async () => {
    const state = context([
      attachment('old-target', 'file-old', 'mfg_work_order', 'work-order-1'),
      ...Array.from({ length: 21 }, (_, index) =>
        attachment(`source-${index}`, `file-${index}`, 'inv_material', 'material-1'),
      ),
    ])

    await expect(replaceMaterialDrawingSnapshot(state.ctx as never, {
      materialId: 'material-1',
      ownerType: 'mfg_work_order',
      ownerId: 'work-order-1',
      companyId: 'company-1',
    })).rejects.toThrow('图纸槽位最多挂接 20 个附件')
    expect(state.rows.has('old-target')).toBe(true)
  })
})
