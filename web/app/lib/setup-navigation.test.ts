import { describe, expect, test } from 'bun:test'
import { shouldRedirectLoginToSetup } from './setup-navigation'

describe('login setup navigation', () => {
  test('空部署进入 setup 创建首管理员', () => {
    expect(
      shouldRedirectLoginToSetup({ initialized: false, hasUsers: false }),
    ).toBe(true)
  })

  test('已有首管理员但未完成时保留 login 以便认证续做', () => {
    expect(
      shouldRedirectLoginToSetup({ initialized: false, hasUsers: true }),
    ).toBe(false)
  })

  test('已完成初始化时不由 login 重定向到 setup', () => {
    expect(
      shouldRedirectLoginToSetup({ initialized: true, hasUsers: true }),
    ).toBe(false)
    expect(
      shouldRedirectLoginToSetup({ initialized: true, hasUsers: false }),
    ).toBe(false)
  })
})
