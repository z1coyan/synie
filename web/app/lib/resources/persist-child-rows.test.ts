import { describe, expect, test } from 'bun:test'
import {
  persistChildRows,
  rowChangedByKeys,
  type ChildRowWriter,
} from './persist-child-rows'
import type { Row } from '~/components/synie-data-grid/types'

function row(partial: Record<string, unknown>): Row {
  return partial as Row
}

function fakeClient(opts?: {
  failDelete?: string[]
  failCreate?: boolean
  failUpdate?: string[]
}): ChildRowWriter & {
  ops: Array<{ op: string; id?: string; body?: unknown }>
} {
  const ops: Array<{ op: string; id?: string; body?: unknown }> = []
  const failDelete = new Set(opts?.failDelete ?? [])
  const failUpdate = new Set(opts?.failUpdate ?? [])
  return {
    ops,
    async create(input) {
      ops.push({ op: 'create', body: input })
      if (opts?.failCreate) throw new Error('create failed')
      return { id: 'new' }
    },
    async update(id, input) {
      ops.push({ op: 'update', id, body: input })
      if (failUpdate.has(id)) throw new Error('update failed')
      return { id }
    },
    async delete(id) {
      ops.push({ op: 'delete', id })
      if (failDelete.has(id)) throw new Error('delete failed')
    },
  }
}

describe('rowChangedByKeys', () => {
  test('任一键 String 化不等即变更；null/undefined 视同空串', () => {
    const changed = rowChangedByKeys(['qty', 'remarks'])
    expect(changed(row({ qty: 1, remarks: null }), row({ qty: 1, remarks: '' }))).toBe(
      false,
    )
    expect(changed(row({ qty: 1 }), row({ qty: 2 }))).toBe(true)
    expect(changed(row({ qty: 1, remarks: 'a' }), row({ qty: 1, remarks: 'b' }))).toBe(
      true,
    )
  })
})

describe('persistChildRows', () => {
  test('删缺失 → 建新增 → 改变更；无差异不 update', async () => {
    const client = fakeClient()
    const snapshot = [
      row({ id: 'a', idx: 1, qty: 1 }),
      row({ id: 'b', idx: 2, qty: 2 }),
      row({ id: 'c', idx: 3, qty: 3 }),
    ]
    const current = [
      row({ id: 'a', idx: 1, qty: 1 }),
      row({ id: 'c', idx: 3, qty: 9 }),
      row({ id: 'local:1', idx: 4, qty: 4 }),
    ]
    const errors = await persistChildRows({
      current,
      snapshot,
      client,
      compareKeys: ['qty'],
      parentIdField: 'docId',
      parentId: 'doc-1',
      inputOf: (r) => ({ idx: r.idx, qty: r.qty }),
    })
    expect(errors).toEqual([])
    // 删全做完后，按 current 顺序：存量改 / 本地建 交错
    expect(client.ops).toEqual([
      { op: 'delete', id: 'b' },
      { op: 'update', id: 'c', body: { idx: 3, qty: 9 } },
      { op: 'create', body: { docId: 'doc-1', idx: 4, qty: 4 } },
    ])
  })

  test('skipDelete 跳过级联行；错误文案用默认第 N 行', async () => {
    const client = fakeClient({ failDelete: ['x'] })
    const errors = await persistChildRows({
      current: [],
      snapshot: [
        row({ id: 'x', idx: 1, parentId: 'p1' }),
        row({ id: 'y', idx: 2, parentId: 'p2' }),
      ],
      client,
      compareKeys: ['qty'],
      inputOf: () => ({}),
      skipDelete: (old) => old.parentId === 'p2',
    })
    expect(client.ops).toEqual([{ op: 'delete', id: 'x' }])
    expect(errors).toEqual(['第1行:delete failed'])
  })

  test('自定义 rowLabel 与 create 失败收集', async () => {
    const client = fakeClient({ failCreate: true })
    const errors = await persistChildRows({
      current: [row({ id: 'local:z', idx: 7, name: '步骤甲' })],
      snapshot: [],
      client,
      compareKeys: ['name'],
      inputOf: (r) => ({ name: r.name }),
      rowLabel: (r) => String(r.name ?? '行'),
    })
    expect(errors).toEqual(['步骤甲:create failed'])
  })

  test('无 compareKeys/changed 时存量行一律 update', async () => {
    const client = fakeClient()
    await persistChildRows({
      current: [row({ id: 'a', idx: 1, qty: 1 })],
      snapshot: [row({ id: 'a', idx: 1, qty: 1 })],
      client,
      inputOf: (r) => ({ qty: r.qty }),
    })
    expect(client.ops).toEqual([{ op: 'update', id: 'a', body: { qty: 1 } }])
  })
})
