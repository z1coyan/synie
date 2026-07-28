#!/usr/bin/env bun
/**
 * 一键本地开发启动：
 * 1. 确保 server/.env
 * 2. docker compose up -d postgres 并等待就绪
 * 3. 执行 SQL 迁移（不 seed）
 * 4. turbo 并行启动 @synie/server + synie-web
 *
 * 用法：
 *   bun run dev
 *   bun run dev -- --no-docker   # 已有本机 PG 时跳过 compose
 *
 * 管理员 / 示例数据请走初始化向导；开发复位：bun run db:reset
 */
import { copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { $ } from 'bun'

const root = join(import.meta.dir, '..')
process.chdir(root)

const args = new Set(process.argv.slice(2))
const noDocker = args.has('--no-docker')

const DEFAULT_DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://synie:synie@localhost:5441/synie?sslmode=disable'

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

async function waitPostgres(maxAttempts = 60) {
  for (let i = 1; i <= maxAttempts; i++) {
    const r =
      await $`docker compose exec -T postgres pg_isready -U synie -d synie`.quiet().nothrow()
    if (r.exitCode === 0) {
      log('PostgreSQL 就绪')
      return
    }
    if (i === maxAttempts) {
      throw new Error('等待 PostgreSQL 超时，请检查 docker compose logs postgres')
    }
    await Bun.sleep(500)
  }
}

async function main() {
  log(`仓库根目录 ${root}`)
  ensureServerEnv()

  process.env.DATABASE_URL = DEFAULT_DATABASE_URL
  process.env.AUTH_SECRET ??= 'local-development-secret-change-me-32-bytes'

  if (!noDocker) {
    log('启动 PostgreSQL（docker compose up -d postgres）…')
    const up = await $`docker compose up -d postgres`.nothrow()
    if (up.exitCode !== 0) {
      throw new Error(
        'docker compose 启动 postgres 失败。确认 Docker 已运行，或使用: bun run dev -- --no-docker',
      )
    }
    await waitPostgres()
  } else {
    log('跳过 Docker（--no-docker），使用已有 DATABASE_URL')
  }

  log('执行数据库迁移（不 seed）…')
  const mig = await $`bun run --filter @synie/server db:migrate`.nothrow()
  if (mig.exitCode !== 0) {
    throw new Error('迁移失败，请检查 DATABASE_URL 与 Postgres')
  }

  log('Turbo 并行启动 server(:8080) + web(:3000)…')
  log('  API healthz → http://localhost:8080/api/v1/healthz')
  log('  前端        → http://localhost:3000  （/api/v1 代理到 8080）')
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
