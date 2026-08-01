/// <reference types="bun" />

import { describe, expect, test } from 'bun:test'
import type { Doc, Id } from '../_generated/dataModel'
import { actorFromRows } from './actor'

function user(overrides: Partial<Doc<'appUsers'>> = {}): Doc<'appUsers'> {
  return {
    _id: 'app-user' as Id<'appUsers'>,
    _creationTime: 1,
    authUserId: 'auth-user',
    usernameKey: 'user',
    username: 'User',
    name: null,
    enabled: true,
    superAdmin: false,
    allCompanies: false,
    ...overrides,
  }
}

describe('Actor live projection', () => {
  test('未知、停用或未映射 app user 一律 fail-closed', () => {
    expect(() => actorFromRows(null, [], [])).toThrow('登录状态已失效')
    expect(() => actorFromRows(user({ enabled: false }), [], [])).toThrow('登录状态已失效')
  })

  test('只合并启用角色，并立即反映角色启停与授权变化', () => {
    const before = actorFromRows(
      user(),
      [
        { enabled: true, permissions: ['sales.order:read'] },
        { enabled: false, permissions: ['secret:*'] },
      ],
      ['company-b', 'company-a', 'company-a'],
    )
    expect([...before.permissions]).toEqual(['sales.order:read'])
    expect(before.companyIds).toEqual(['company-a', 'company-b'])

    const after = actorFromRows(
      user(),
      [{ enabled: true, permissions: ['sales.order:update'] }],
      ['company-b'],
    )
    expect([...after.permissions]).toEqual(['sales.order:update'])
    expect(after.companyIds).toEqual(['company-b'])
  })
})
