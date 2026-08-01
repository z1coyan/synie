/// <reference types="bun" />

import { describe, expect, test } from 'bun:test'
import type { Id } from '../_generated/dataModel'
import { actorToMe } from './me'

describe('iam/me wire projection', () => {
  test('稳定排序并且只暴露 Actor 业务字段', () => {
    const appUserId = 'app-user-id' as Id<'appUsers'>
    const result = actorToMe({
      userId: appUserId,
      username: '管理员',
      name: null,
      superAdmin: false,
      allCompanies: false,
      permissions: new Set(['z:read', 'a:write']),
      companyIds: ['company-z', 'company-a'],
    })

    expect(result).toEqual({
      user: { id: appUserId, username: '管理员', name: null },
      superAdmin: false,
      allCompanies: false,
      permissions: ['a:write', 'z:read'],
      companyIds: ['company-a', 'company-z'],
    })
    expect('email' in result.user).toBe(false)
  })
})
