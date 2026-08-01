import { describe, expect, test } from 'bun:test'
import { hasAnySetupUsers } from './status'

describe('Setup public user presence', () => {
  test('只有应用用户与 Better Auth user/account 全空时才返回 false', () => {
    expect(hasAnySetupUsers(false, [], [])).toBe(false)
    expect(hasAnySetupUsers(true, [], [])).toBe(true)
    expect(hasAnySetupUsers(false, [{}], [])).toBe(true)
    expect(hasAnySetupUsers(false, [], [{}])).toBe(true)
  })
})
