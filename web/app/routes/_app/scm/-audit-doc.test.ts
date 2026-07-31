import { describe, expect, test } from 'bun:test'
import { createResourceQueryCache } from '~/lib/resources/catalog'
import {
  auditDocItemsQueryKey,
  type AuditDocBindingResolver,
} from './-audit-doc'

describe('AuditDoc ResourceBinding cache seam', () => {
  test('条目查询使用 items binding grid prefix，invalidateGrid 可命中', async () => {
    const cache = createResourceQueryCache(
      'mfgOutputItems',
      'memory:mfgOutputItems',
    )
    const resolveBinding: AuditDocBindingResolver = (resource) => {
      if (resource !== 'mfgOutputItems') {
        throw new Error(`测试未注入 ${resource}`)
      }
      return { cache }
    }
    const queryKey = auditDocItemsQueryKey(
      'mfgOutputItems',
      'output-1',
      resolveBinding,
    )

    expect(queryKey).toEqual([
      'gridRows',
      'memory:mfgOutputItems',
      'mfgOutputItems',
      'auditDocItems',
      'output-1',
    ])

    let matched = false
    await cache.invalidateGrid({
      invalidateQueries: async ({ queryKey: prefix }) => {
        matched = prefix.every(
          (part, index) => queryKey[index] === part,
        )
      },
    })
    expect(matched).toBe(true)
  })
})
