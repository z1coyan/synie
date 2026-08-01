/// <reference types="bun" />

import { describe, expect, test } from 'bun:test'
import { createInternalEmail, prepareFirstUser } from './model'

describe('首管理员输入', () => {
  test('trim display username 并生成 lowercase 唯一键', () => {
    expect(prepareFirstUser({ username: '  Admin用户  ', password: 'secret' })).toEqual({
      ok: true,
      value: {
        username: 'Admin用户',
        usernameKey: 'admin用户',
        password: 'secret',
        name: null,
      },
    })
  })

  test('按 Unicode code point 接受 1/64 字符并拒绝 0/65 字符', () => {
    expect(prepareFirstUser({ username: '😀', password: 'x' }).ok).toBe(true)
    expect(prepareFirstUser({ username: '界'.repeat(64), password: 'x' }).ok).toBe(true)
    expect(prepareFirstUser({ username: '  ', password: 'x' })).toMatchObject({
      ok: false,
      fields: { username: ['不能为空且长度不能超过 64'] },
    })
    expect(prepareFirstUser({ username: '😀'.repeat(65), password: 'x' })).toMatchObject({
      ok: false,
      fields: { username: ['不能为空且长度不能超过 64'] },
    })
  })

  test('password/name 保持 legacy 边界', () => {
    expect(prepareFirstUser({ username: 'a', password: '' })).toMatchObject({
      ok: false,
      fields: { password: ['不能为空且长度不能超过 1024'] },
    })
    expect(
      prepareFirstUser({ username: 'a', password: 'x', name: '名'.repeat(65) }),
    ).toMatchObject({ ok: false, fields: { name: ['长度不能超过 64'] } })
  })
})

describe('Better Auth 内部邮箱', () => {
  test('只使用 mutation 内随机值且不包含 username', () => {
    const email = createInternalEmail(() => '123E4567-E89B-12D3-A456-426614174000')
    expect(email).toBe('123e4567e89b12d3a456426614174000@internal.syn.ie')
    expect(email).not.toContain('admin')
  })
})
