#!/usr/bin/env bun
/**
 * 一键本地开发启动：
 * 1. 确保 server/.env
 * 2. 启动 legacy PostgreSQL + Convex PostgreSQL + MinIO + Convex backend/dashboard
 * 3. 执行 SQL 迁移（不 seed）
 * 4. turbo 并行启动 @synie/server + synie-web
 *
 * 用法：
 *   bun run dev
 *   bun run dev -- --no-docker   # 所有外部依赖均由操作者提供
 *
 * 管理员 / 示例数据请走初始化向导；开发复位：bun run db:reset
 */
import { copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { checkInfra } from '../infra/convex/health.ts'
import { runCompose, waitForHttp } from '../infra/convex/lib.ts'

const root = join(import.meta.dir, '..')
process.chdir(root)

const args = new Set(process.argv.slice(2))
const noDocker = args.has('--no-docker')

function log(msg: string) {
  console.log(`[synie:dev] ${msg}`)
}

function ensureServerEnv() {
  const envPath = join(root, 'server/.env')
  const example = join(root, 'server/.env.example')
  if (!existsSync(envPath)) {
    if (!existsSync(example)) {
      throw new Error('缺少 server/.env 与 server/.env.example')
    }
    copyFileSync(example, envPath)
    log('已从 server/.env.example 生成 server/.env')
  }
}

async function main() {
  log(`仓库根目录 ${root}`)
  ensureServerEnv()

  process.env.AUTH_SECRET ??= 'local-development-secret-change-me-32-bytes'

  if (!noDocker) {
    process.env.DATABASE_URL ??=
      `postgres://synie:synie@127.0.0.1:${process.env.SYNIE_POSTGRES_PORT ?? '5441'}/synie?sslmode=disable`
    log('启动 PostgreSQL、MinIO 与自托管 Convex…')
    await runCompose([
      'up',
      '-d',
      'postgres',
      'convex-postgres',
      'minio',
      'minio-public',
      'minio-init',
      'convex-backend',
      'convex-dashboard',
    ])
    await checkInfra({ includeLegacyPostgres: true })
  } else {
    const convexUrl = process.env.CONVEX_SELF_HOSTED_URL
    const convexSiteUrl = process.env.CONVEX_SELF_HOSTED_SITE_URL
    const s3InternalEndpoint = process.env.SYNIE_S3_INTERNAL_ENDPOINT
    const s3PublicEndpoint = process.env.SYNIE_S3_PUBLIC_ENDPOINT
    const missing = [
      ['DATABASE_URL', process.env.DATABASE_URL],
      ['CONVEX_SELF_HOSTED_URL', convexUrl],
      ['CONVEX_SELF_HOSTED_SITE_URL', convexSiteUrl],
      ['SYNIE_S3_INTERNAL_ENDPOINT', s3InternalEndpoint],
      ['SYNIE_S3_PUBLIC_ENDPOINT', s3PublicEndpoint],
      ['AWS_ACCESS_KEY_ID', process.env.AWS_ACCESS_KEY_ID],
      ['AWS_SECRET_ACCESS_KEY', process.env.AWS_SECRET_ACCESS_KEY],
    ].filter(([, value]) => !value).map(([name]) => name)
    if (missing.length > 0) {
      throw new Error(
        `--no-docker 缺少显式外部依赖配置：${missing.join('、')}`,
      )
    }
    if (!convexUrl || !s3PublicEndpoint) {
      throw new Error('--no-docker 外部依赖校验出现内部不一致')
    }
    log('跳过 Docker（--no-docker），检查操作者提供的 Convex 与 S3')
    await waitForHttp('外部 Convex', `${convexUrl.replace(/\/$/, '')}/version`)
    await waitForHttp('外部 S3', s3PublicEndpoint)
  }

  log('执行数据库迁移（不 seed）…')
  const mig = Bun.spawn(['bun', 'run', '--filter', '@synie/server', 'db:migrate'], {
    cwd: root,
    env: process.env,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if ((await mig.exited) !== 0) {
    throw new Error('迁移失败，请检查 DATABASE_URL 与 Postgres')
  }

  log('Turbo 并行启动 server(:8080) + web(:3000)…')
  log('  API healthz → http://localhost:8080/api/v1/healthz')
  log('  前端        → http://localhost:3000  （/api/v1 代理到 8080）')
  log('  Convex      → http://localhost:3210  （HTTP actions: 3211）')
  log('  Dashboard   → http://localhost:6791')
  log('  MinIO       → http://localhost:9000  （console: 9001）')
  log('  停止：Ctrl+C')

  // turbo 负责常驻 dev；继承当前 env（DATABASE_URL / AUTH_SECRET）
  const turbo = Bun.spawn(
    [
      'bunx',
      'turbo',
      'run',
      'dev',
      '--filter=@synie/server',
      '--filter=synie-web',
      '--ui=tui',
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL,
        AUTH_SECRET: process.env.AUTH_SECRET,
        // API：server/.env 或下列默认（HOST 默认 0.0.0.0）
        PORT: process.env.PORT ?? '8080',
        HOST: process.env.HOST ?? '0.0.0.0',
        // 前端端口独立，避免吃到 API 的 PORT
        WEB_PORT: process.env.WEB_PORT ?? '3000',
        WEB_HOST: process.env.WEB_HOST ?? process.env.HOST ?? '0.0.0.0',
        SYNIE_API_PORT: process.env.SYNIE_API_PORT ?? process.env.PORT ?? '8080',
      },
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    },
  )

  const shutdown = () => {
    try {
      turbo.kill()
    } catch {
      /* ignore */
    }
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  const code = await turbo.exited
  process.exit(code)
}

main().catch((err) => {
  console.error('[synie:dev] 失败:', err instanceof Error ? err.message : err)
  process.exit(1)
})
