import { z } from 'zod'

/**
 * 环境配置（对齐 server-go platform/config 的行为）：
 * - DATABASE_URL 优先，缺省时由 PG* 分件拼装
 * - AUTH_SECRET 至少 32 字节
 * - AUTH_TOKEN_TTL 为 数字+单位（s/m/h/d），默认 168h
 */
const TTL_RE = /^(\d+)([smhd])$/
const TTL_UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 }

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().min(1).default('0.0.0.0'),
  DATABASE_URL: z.string().min(1).optional(),
  PGHOST: z.string().default('localhost'),
  PGPORT: z.coerce.number().int().min(1).max(65535).default(5432),
  PGUSER: z.string().default('postgres'),
  PGPASSWORD: z.string().optional(),
  PGDATABASE: z.string().optional(),
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET 至少需要 32 字节'),
  AUTH_TOKEN_TTL: z.string().regex(TTL_RE, 'AUTH_TOKEN_TTL 必须是 数字+单位（s/m/h/d），如 168h').default('168h'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /** LibreOffice soffice 可执行路径；空则走 PATH 中的 soffice */
  SOFFICE_PATH: z.string().optional(),
  /** PDF 转换超时（毫秒），默认 120000 */
  SOFFICE_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  /** soffice 最大并发，默认 2 */
  SOFFICE_MAX_CONCURRENCY: z.coerce.number().int().positive().optional(),
})

export interface Env {
  port: number
  host: string
  databaseUrl: string
  authSecret: string
  tokenTtlSeconds: number
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  sofficePath?: string
  sofficeTimeoutMs?: number
  sofficeMaxConcurrency?: number
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('；')
    throw new Error(`环境配置无效：${detail}`)
  }
  const raw = parsed.data

  let databaseUrl = raw.DATABASE_URL
  if (!databaseUrl) {
    if (!raw.PGDATABASE) {
      throw new Error('必须设置 DATABASE_URL 或 PGDATABASE')
    }
    const auth = raw.PGPASSWORD
      ? `${encodeURIComponent(raw.PGUSER)}:${encodeURIComponent(raw.PGPASSWORD)}`
      : encodeURIComponent(raw.PGUSER)
    databaseUrl = `postgres://${auth}@${raw.PGHOST}:${raw.PGPORT}/${raw.PGDATABASE}?sslmode=disable`
  }

  const ttlMatch = TTL_RE.exec(raw.AUTH_TOKEN_TTL)
  const ttlSeconds = Number(ttlMatch![1]) * TTL_UNIT_SECONDS[ttlMatch![2]!]!

  return {
    port: raw.PORT,
    host: raw.HOST,
    databaseUrl,
    authSecret: raw.AUTH_SECRET,
    tokenTtlSeconds: ttlSeconds,
    logLevel: raw.LOG_LEVEL,
    sofficePath: raw.SOFFICE_PATH,
    sofficeTimeoutMs: raw.SOFFICE_TIMEOUT_MS,
    sofficeMaxConcurrency: raw.SOFFICE_MAX_CONCURRENCY,
  }
}
