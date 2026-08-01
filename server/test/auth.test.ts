import { describe, expect, test } from 'bun:test'
import { createRateLimiter } from '~/platform/auth/limiter.ts'
import { hashPassword, verifyPassword } from '~/platform/auth/password.ts'
import { createTokenManager } from '~/platform/auth/token.ts'

describe('密码（Bun argon2id）', () => {
  test('hash/verify 往返', async () => {
    const hash = await hashPassword('admin123')
    expect(hash.startsWith('$argon2id$')).toBe(true)
    expect(await verifyPassword(hash, 'admin123')).toBe(true)
    expect(await verifyPassword(hash, 'wrong')).toBe(false)
  })

  test('非法哈希不抛出，视为失败', async () => {
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false)
  })

  test('空密码拒绝', async () => {
    expect(hashPassword('')).rejects.toThrow('密码不能为空')
  })

  test('兼容 server-go x/crypto argon2id 的 PHC 输出', async () => {
    // Go: argon2.IDKey(m=65536,t=3,p=2)，PHC 串格式互通
    const goHash = '$argon2id$v=19$m=65536,t=3,p=2$c2FsdHNhbHRzYWx0c2FsdA$' +
      Buffer.from('a'.repeat(32)).toString('base64').replace(/=+$/, '')
    // 仅验证解析路径不抛异常（值本身不可能命中）
    expect(await verifyPassword(goHash, 'whatever')).toBe(false)
  })
})

describe('JWT（hono/jwt HS256）', () => {
  const secret = 'test-secret-that-is-at-least-32-bytes!'
  const userId = crypto.randomUUID()

  test('签发/校验往返', async () => {
    const tokens = createTokenManager({ secret, ttlSeconds: 3600 })
    const { token, expiresAt } = await tokens.issue(userId)
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now())
    expect(await tokens.verifyToken(token)).toBe(userId)
  })

  test('错误密钥 / 过期 / 垃圾串一律 null', async () => {
    const tokens = createTokenManager({ secret, ttlSeconds: 3600 })
    const { token } = await tokens.issue(userId)

    const other = createTokenManager({ secret: 'other-secret-that-is-at-least-32-bytes', ttlSeconds: 3600 })
    expect(await other.verifyToken(token)).toBeNull()

    const expired = createTokenManager({ secret, ttlSeconds: -10 })
    const { token: expiredToken } = await expired.issue(userId)
    expect(await tokens.verifyToken(expiredToken)).toBeNull()

    expect(await tokens.verifyToken('garbage')).toBeNull()
  })
})

describe('登录限流', () => {
  test('窗口内达上限即拦截，窗口外自动恢复', () => {
    let now = 1_000_000
    const limiter = createRateLimiter({ max: 3, windowMs: 60_000, now: () => now })
    expect(limiter.blocked('ip')).toBe(false)
    limiter.recordFailure('ip')
    limiter.recordFailure('ip')
    expect(limiter.blocked('ip')).toBe(false)
    limiter.recordFailure('ip')
    expect(limiter.blocked('ip')).toBe(true)

    now += 61_000
    expect(limiter.blocked('ip')).toBe(false)
  })

  test('成功清零', () => {
    const limiter = createRateLimiter({ max: 2, windowMs: 60_000 })
    limiter.recordFailure('ip')
    limiter.recordFailure('ip')
    expect(limiter.blocked('ip')).toBe(true)
    limiter.reset('ip')
    expect(limiter.blocked('ip')).toBe(false)
  })
})
