/**
 * decide fixtures 对拍（工单 01）：服务端内核跑 contracts/fixtures/authz/decide_cases.json。
 * 前端行级本地判定在工单 14 消费同一份夹具，两端语义由此对齐。
 */
import { describe, expect, test } from 'bun:test'
import cases from '../../../../../contracts/fixtures/authz/decide_cases.json' with { type: 'json' }
import { decide, scopeSetOf, type Actor, type ScopeAtom, type ScopeSet } from './index.ts'

interface FixtureCase {
  name: string
  actor: {
    kind?: 'user' | 'system'
    superAdmin?: boolean
    companies: { all: boolean; ids: string[] }
    deptId?: string | null
    deptSubtreeIds?: string[]
    grants: Record<string, string[]>
  }
  requirement: { kind: 'one' | 'anyOf' | 'allOf'; codes: string[] }
  expect: Record<string, unknown>
}

function toActor(spec: FixtureCase['actor']): Actor {
  const grants = new Map<string, ScopeSet>()
  for (const [code, atoms] of Object.entries(spec.grants)) {
    grants.set(code, scopeSetOf(...(atoms as ScopeAtom[])))
  }
  return {
    kind: spec.kind ?? 'user',
    userId: 'u-fixture',
    username: 'fixture',
    name: null,
    superAdmin: spec.superAdmin ?? false,
    companies: spec.companies,
    deptId: spec.deptId ?? null,
    deptSubtreeIds: spec.deptSubtreeIds ?? [],
    grants,
  }
}

describe('decide fixtures 对拍', () => {
  const fixture = cases as unknown as { version: number; cases: FixtureCase[] }

  test('夹具非空且版本已知', () => {
    expect(fixture.version).toBe(1)
    expect(fixture.cases.length).toBeGreaterThan(10)
  })

  for (const c of fixture.cases) {
    test(c.name, () => {
      const decision = decide(toActor(c.actor), {
        resource: 'fixtureResource',
        action: 'fixtureAction',
        requirement: { kind: c.requirement.kind, codes: c.requirement.codes } as never,
      })
      if (c.expect.outcome === 'deny') {
        expect(decision).toEqual(c.expect as never)
      } else {
        if (decision.outcome !== 'permit') throw new Error(`应当 permit：${c.name}`)
        expect(decision.permit.rowFilter).toEqual(c.expect.rowFilter as never)
      }
    })
  }
})
