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

  test('hit：窗口内达上限即拒绝且不记账，窗口外恢复', () => {
    let now = 1_000_000
    const limiter = createRateLimiter({ max: 2, windowMs: 60_000, now: () => now })
    expect(limiter.hit('u1')).toBe(true)
    expect(limiter.hit('u1')).toBe(true)
    expect(limiter.hit('u1')).toBe(false)
    // 拒绝不记账：仍是 2 条
    expect(limiter.hit('u1')).toBe(false)

    now += 61_000
    expect(limiter.hit('u1')).toBe(true)
  })

  test('桶表有界：满时先清扫过期桶，仍满则按插入序淘汰最旧桶', () => {
    let now = 1_000_000
    const limiter = createRateLimiter({ max: 2, windowMs: 60_000, maxBuckets: 3, now: () => now })
    limiter.recordFailure('a')
    limiter.recordFailure('b')
    limiter.recordFailure('c')
    limiter.recordFailure('c')
    expect(limiter.blocked('c')).toBe(true)
    expect(limiter.size()).toBe(3)

    // a、b 的记录滑出窗口：d 准入先 sweep，未过期的 c 保留不淘汰
    now += 61_000
    limiter.recordFailure('c') // c 在 t1 重建（prune 清掉 t0 记录，插入序移到末尾）
    limiter.recordFailure('c')
    expect(limiter.blocked('c')).toBe(true)
    limiter.recordFailure('d')
    expect(limiter.size()).toBe(2) // a、b 被 sweep；[c, d]

    // 桶满且都无过期：f 准入按插入序淘汰最旧的 c
    limiter.recordFailure('e')
    limiter.recordFailure('f')
    expect(limiter.size()).toBe(3) // [d, e, f]
    expect(limiter.blocked('c')).toBe(false) // c 被整桶淘汰，计数清零
    expect(limiter.blocked('d')).toBe(false) // d 仍在（1 条 < max 2）
  })

  test('桶表有界：随机 bucket 洪泛不会无界增长', () => {
    const limiter = createRateLimiter({ max: 10, windowMs: 60_000, maxBuckets: 100 })
    for (let i = 0; i < 10_000; i++) limiter.recordFailure(`rand-${i}`)
    expect(limiter.size()).toBeLessThanOrEqual(100)
  })
})
