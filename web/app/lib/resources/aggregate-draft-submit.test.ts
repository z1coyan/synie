import { describe, expect, test } from 'bun:test'
import type { AggregateDraftAdapter } from './catalog/types'
import {
  assertAggregateDraftReady,
  submitAggregateDraft,
} from './aggregate-draft-submit'

describe('Aggregate Draft 提交门控', () => {
  test('create 可从显式空集合开始', () => {
    expect(() => assertAggregateDraftReady('create', false)).not.toThrow()
  })

  test('edit 在明细 pending/failed 时不调用 replace', async () => {
    let replaceCalled = false
    const submit = async (detailLoaded: boolean) => {
      assertAggregateDraftReady('edit', detailLoaded, '订单明细')
      replaceCalled = true
    }

    await expect(submit(false)).rejects.toThrow(
      '订单明细尚未完整加载，不能提交整单替换',
    )
    expect(replaceCalled).toBe(false)
  })

  test('edit 仅在权威草稿完整加载后放行', () => {
    expect(() =>
      assertAggregateDraftReady('edit', true, '订单明细'),
    ).not.toThrow()
  })

  test('create/edit 各只发一次聚合 mutation，并返回保存并审核所需 id', async () => {
    const calls: Array<{ operation: string; id?: string; input: unknown }> = []
    const adapter: AggregateDraftAdapter = {
      async loadDraft() {
        throw new Error('提交不应额外 load')
      },
      async createDraft(input) {
        calls.push({ operation: 'create', input })
        return { id: 'created-1', items: [] }
      },
      async replaceDraft(id, input) {
        calls.push({ operation: 'replace', id, input })
        return { id, items: [] }
      },
    }
    const createInput = { companyId: 'company-1', items: [{ qty: '1' }] }
    const editInput = { companyId: 'company-1', items: [{ id: 'item-1', qty: '2' }] }

    await expect(submitAggregateDraft(adapter, 'create', null, createInput, '库存单')).resolves.toBe('created-1')
    await expect(submitAggregateDraft(adapter, 'edit', 'stored-1', editInput, '库存单')).resolves.toBe('stored-1')
    expect(calls).toEqual([
      { operation: 'create', input: createInput },
      { operation: 'replace', id: 'stored-1', input: editInput },
    ])
  })

  test('edit 缺 id 时 mutation 前失败', async () => {
    let called = false
    const adapter: AggregateDraftAdapter = {
      async loadDraft() { return { id: 'unused' } },
      async createDraft() { return { id: 'unused' } },
      async replaceDraft() {
        called = true
        return { id: 'unused' }
      },
    }
    await expect(submitAggregateDraft(adapter, 'edit', null, { items: [] }, '凭证')).rejects.toThrow(
      '凭证缺少待替换记录 id',
    )
    expect(called).toBe(false)
  })
})
