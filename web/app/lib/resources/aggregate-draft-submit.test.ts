import { describe, expect, test } from 'bun:test'
import { assertAggregateDraftReady } from './aggregate-draft-submit'

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
})
