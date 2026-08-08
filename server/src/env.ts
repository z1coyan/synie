import { z } from 'zod'

/**
 * 环境配置（对齐 server-go platform/config 的行为）：
 * - DATABASE_URL 优先，缺省时由 PG* 分件拼装
 * - AUTH_SECRET 至少 32 字节
 * - AUTH_TOKEN_TTL 为 数字+单位（s/m/h/d），默认 168h
 */
const TTL_RE = /^(\d+)([smhd])$/
const TTL_UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 }

const envSchema = z
  .object({
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
    /**
     * 对外可达的应用根 URL（浏览器访问的 origin，非 API 直连端口）。
     * 本地 dev 一般为 http://localhost:3000；生产为反代后的站点 origin。
     * better-auth 用它作为 fallback / 单 host 时的 baseURL；启用 Logto 时必填。
     */
    BETTER_AUTH_URL: z.string().url().optional(),
    /**
     * 额外允许的浏览器 Host（host:port，逗号分隔；支持 *.ts.net 通配）。
     * 局域网 / Tailscale 多入口访问时用；会与 BETTER_AUTH_URL 的 host 合并进 dynamic baseURL。
     * 例：100.93.251.66:3000,home-n5pro:3000,*.ts.net
     */
    BETTER_AUTH_ALLOWED_HOSTS: z.string().optional(),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    /** 5xx 错误上报 webhook（通用 POST JSON 摘要）；不配则不启用 */
    ERROR_REPORT_WEBHOOK_URL: z.string().url().optional(),
    /** LibreOffice soffice 可执行路径；空则走 PATH 中的 soffice */
    SOFFICE_PATH: z.string().optional(),
    /** PDF 转换超时（毫秒），默认 120000 */
    SOFFICE_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
    /** soffice 最大并发，默认 2 */
    SOFFICE_MAX_CONCURRENCY: z.coerce.number().int().positive().optional(),
    /** Logto OIDC（三项要么全有要么全无；缺省即不启用 Logto 登录） */
    LOGTO_ISSUER: z.string().url().optional(),
    LOGTO_CLIENT_ID: z.string().min(1).optional(),
    LOGTO_CLIENT_SECRET: z.string().min(1).optional(),
    /** 文件存储对账（jobs/filesclean）：总开关，默认开 */
    FILE_RECON_ENABLED: z.enum(['0', '1', 'true', 'false', 'yes', 'no', 'on', 'off']).optional(),
    /** 演练模式：只报告不删除孤儿对象，默认 true（安全默认；确认无误后显式置 false） */
    FILE_RECON_DRY_RUN: z.enum(['0', '1', 'true', 'false', 'yes', 'no', 'on', 'off']).optional(),
    /** 每日运行时刻（上海时区小时，0-23），默认 3 */
    FILE_RECON_RUN_HOUR: z.coerce.number().int().min(0).max(23).default(3),
    /** 孤儿宽限（小时）：新于此时间的对象视为进行中上传，默认 24 */
    FILE_RECON_ORPHAN_GRACE_HOURS: z.coerce.number().positive().default(24),
  })
  .superRefine((raw, ctx) => {
    const present = [raw.LOGTO_ISSUER, raw.LOGTO_CLIENT_ID, raw.LOGTO_CLIENT_SECRET].filter(
      (v) => v !== undefined,
    ).length
    if (present !== 0 && present !== 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['LOGTO_ISSUER'],
        message: 'LOGTO_ISSUER / LOGTO_CLIENT_ID / LOGTO_CLIENT_SECRET 必须同时设置或同时缺省',
      })
    }
    if (present === 3 && !raw.BETTER_AUTH_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BETTER_AUTH_URL'],
        message:
          '启用 Logto 时必须设置 BETTER_AUTH_URL（浏览器访问的应用 origin，如 http://localhost:3000），否则 OAuth redirect_uri 会落到 API 端口导致 cookie 与回调错位',
      })
    }
  })

/** Logto OIDC 配置（env 三件套齐备时存在） */
export interface LogtoEnv {
  issuer: string
  clientId: string
  clientSecret: string
}

export interface Env {
  port: number
  host: string
  databaseUrl: string
  authSecret: string
  tokenTtlSeconds: number
  /** 浏览器可达的应用 origin；启用 Logto 时必有 */
  betterAuthUrl?: string
  /**
   * better-auth 允许的 Host 列表（含 BETTER_AUTH_URL 推导的 host + BETTER_AUTH_ALLOWED_HOSTS）。
   * 多于 1 个时走 dynamic baseURL，按请求 Host 拼 OAuth redirect_uri。
   */
  betterAuthAllowedHosts: string[]
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  /** 5xx 错误上报 webhook URL；undefined 即不启用 */
  errorReportWebhookUrl?: string
  sofficePath?: string
  sofficeTimeoutMs?: number
  sofficeMaxConcurrency?: number
  logto?: LogtoEnv
  /** 文件存储对账调度（jobs/filesclean）配置 */
  fileRecon: {
    enabled: boolean
    dryRun: boolean
    runHour: number
    orphanGraceMs: number
  }
}

/** 解析枚举式布尔环境变量（缺省走 fallback） */
function parseBoolFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  return value === '1' || value === 'true' || value === 'yes' || value === 'on'
}

/** 解析 BETTER_AUTH_ALLOWED_HOSTS + BETTER_AUTH_URL.host；去重保序 */
export function parseBetterAuthAllowedHosts(
  betterAuthUrl: string | undefined,
  allowedHostsRaw: string | undefined,
): string[] {
  const hosts: string[] = []
  const push = (raw: string) => {
    const h = raw.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
    if (h && !hosts.includes(h)) hosts.push(h)
  }
  let fallbackPort = '3000'
  let fallbackIsLoopback = false
  if (betterAuthUrl) {
    try {
      const u = new URL(betterAuthUrl)
      push(u.host)
      fallbackPort = u.port || (u.protocol === 'https:' ? '443' : '80')
      const hn = u.hostname.toLowerCase()
      fallbackIsLoopback = hn === 'localhost' || hn === '127.0.0.1' || hn === '::1'
    } catch {
      /* BETTER_AUTH_URL 已由 zod url 校验 */
    }
  }
  if (allowedHostsRaw) {
    for (const part of allowedHostsRaw.split(',')) push(part)
  }
  // 本地 loopback 入口常互换，BETTER_AUTH_URL 是 localhost 时一并放行 127.0.0.1
  if (hosts.some((h) => h.startsWith('localhost'))) {
    push(`127.0.0.1:${fallbackPort}`)
  }
  // dev 便利：BETTER_AUTH_URL 落在 loopback 时，自动放行局域网 / Tailscale 同端口入口
  // （生产公网 origin 不扩；额外主机名仍写 BETTER_AUTH_ALLOWED_HOSTS）
  if (fallbackIsLoopback) {
    for (const pattern of [
      `10.*.*.*:${fallbackPort}`,
      `192.168.*.*:${fallbackPort}`,
      `172.*.*.*:${fallbackPort}`, // 覆盖 172.16/12；略宽于 RFC1918，仅 dev
      `100.*.*.*:${fallbackPort}`, // Tailscale CGNAT 100.64/10
      `*.ts.net:${fallbackPort}`,
    ]) {
      push(pattern)
    }
  }
  return hosts
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

  const betterAuthUrl = raw.BETTER_AUTH_URL?.replace(/\/+$/, '')
  return {
    port: raw.PORT,
    host: raw.HOST,
    databaseUrl,
    authSecret: raw.AUTH_SECRET,
    tokenTtlSeconds: ttlSeconds,
    betterAuthUrl,
    betterAuthAllowedHosts: parseBetterAuthAllowedHosts(
      betterAuthUrl,
      raw.BETTER_AUTH_ALLOWED_HOSTS,
    ),
    logLevel: raw.LOG_LEVEL,
    errorReportWebhookUrl: raw.ERROR_REPORT_WEBHOOK_URL,
    sofficePath: raw.SOFFICE_PATH,
    sofficeTimeoutMs: raw.SOFFICE_TIMEOUT_MS,
    sofficeMaxConcurrency: raw.SOFFICE_MAX_CONCURRENCY,
    logto:
      raw.LOGTO_ISSUER && raw.LOGTO_CLIENT_ID && raw.LOGTO_CLIENT_SECRET
        ? {
            issuer: raw.LOGTO_ISSUER,
            clientId: raw.LOGTO_CLIENT_ID,
            clientSecret: raw.LOGTO_CLIENT_SECRET,
          }
        : undefined,
    fileRecon: {
      enabled: parseBoolFlag(raw.FILE_RECON_ENABLED, true),
      dryRun: parseBoolFlag(raw.FILE_RECON_DRY_RUN, true),
      runHour: raw.FILE_RECON_RUN_HOUR,
      orphanGraceMs: raw.FILE_RECON_ORPHAN_GRACE_HOURS * 3600_000,
    },
  }
}
