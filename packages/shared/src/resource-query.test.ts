import { describe, expect, test } from 'bun:test'
import type { ResourceCursorQuery, ResourcePage } from './resource-query'

describe('resource cursor contract', () => {
  test('cursor is opaque and count is optional', () => {
    const query: ResourceCursorQuery = {
      profile: 'default',
      numItems: 20,
      cursor: 'not-a-uuid/opaque==',
    }
    const page: ResourcePage<{ id: string }> = {
      results: [{ id: 'opaque-id' }],
      pageInfo: { continueCursor: null, isDone: true },
    }
    expect(query.cursor).toBe('not-a-uuid/opaque==')
    expect(page.totalCount).toBeUndefined()
  })
})
