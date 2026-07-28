import { sign, verify } from 'hono/jwt'

const TOKEN_ISSUER = 'synie'

/**
 * 登录令牌：JWT HS256（KD16 定案；hono/jwt 走 Web Crypto，无 Node 依赖）。
 * claims 对齐 server-go：iss/sub/iat/nbf/exp/jti。
 */
export function createTokenManager(deps: { secret: string; ttlSeconds: number }) {
  const { secret, ttlSeconds } = deps

  async function issue(userId: string): Promise<{ token: string; expiresAt: Date }> {
    const now = Math.floor(Date.now() / 1000)
    const exp = now + ttlSeconds
    const token = await sign(
      { iss: TOKEN_ISSUER, sub: userId, iat: now, nbf: now, exp, jti: crypto.randomUUID() },
      secret,
      'HS256',
    )
    return { token, expiresAt: new Date(exp * 1000) }
  }

  /** 校验成功返回 userId；任何失败（签名/过期/形状）一律返回 null */
  async function verifyToken(raw: string): Promise<string | null> {
    try {
      const payload = await verify(raw, secret, 'HS256')
      if (payload.iss !== TOKEN_ISSUER || typeof payload.sub !== 'string') return null
      return payload.sub
    } catch {
      return null
    }
  }

  return { issue, verifyToken }
}

export type TokenManager = ReturnType<typeof createTokenManager>
