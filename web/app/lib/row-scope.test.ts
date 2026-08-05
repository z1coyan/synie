/**
 * 行级本地判定对拍（工单 14）：rowInScope 跑 contracts/fixtures/authz/row_scope_cases.json。
 * 与服务端 decide fixtures（decide_cases.json）同源的客户端求值侧。
 */
import { describe, expect, test } from 'bun:test'
import cases from '../../../contracts/fixtures/authz/row_scope_cases.json' with { type: 'json' }
import type { DataScope, ResourceDocumentAuthz } from '@synie/shared'
import { rowInScope } from './row-scope'

interface FixtureCase {
  name: string
  me: { userId: string | null; deptId: string | null; deptSubtreeIds: string[] }
  dims: { ownerId?: string; deptId?: string }
  scope: DataScope
  row: Record<string, unknown>
  expect: boolean
}

describe('rowInScope fixtures 对拍', () => {
  const fixture = cases as unknown as { version: number; cases: FixtureCase[] }

  test('夹具非空且版本已知', () => {
    expect(fixture.version).toBe(1)
    expect(fixture.cases.length).toBeGreaterThanOrEqual(8)
  })

  for (const c of fixture.cases) {
    test(c.name, () => {
      expect(rowInScope(c.scope, c.row, c.dims as ResourceDocumentAuthz, c.me)).toBe(c.expect)
    })
  }
})
