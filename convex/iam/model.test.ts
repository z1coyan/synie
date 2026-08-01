/// <reference types="bun" />

import { describe, expect, test } from 'bun:test'
import { createOneTimePassword, normalizeCompanyIds, prepareManagedUser } from './model'

describe('IAM 用户输入', () => {
  test('保持 Unicode 1..64 与大小写不敏感 username 语义', () => {
    expect(prepareManagedUser({ username: '  管理员A  ', name: '  张三  ' })).toEqual({
      ok: true,
      value: {
        username: '管理员A',
        usernameKey: '管理员a',
        name: '张三',
      },
    })
    expect(prepareManagedUser({ username: '😀' }).ok).toBe(true)
    expect(prepareManagedUser({ username: '界'.repeat(64) }).ok).toBe(true)
    expect(prepareManagedUser({ username: ' ' }).ok).toBe(false)
    expect(prepareManagedUser({ username: '界'.repeat(65) }).ok).toBe(false)
  })

  test('一次性密码为固定 128-bit URL-safe 文本', () => {
    const password = createOneTimePassword((target) => {
      target.set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 250, 255])
      return target
    })
    expect(password).toBe('AAECAwQFBgcICfr_')
    expect(password).not.toMatch(/[+/=]/)
  })

  test('公司授权 trim、去空、去重并稳定排序', () => {
    expect(normalizeCompanyIds([' b ', '', 'a', 'b'])).toEqual(['a', 'b'])
  })
})
