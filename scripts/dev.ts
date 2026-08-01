#!/usr/bin/env bun
/**
 * 唯一本地开发入口：
 * 1. 启动 PostgreSQL 17 + MinIO + 自托管 Convex + dashboard
 * 2. 校验基础设施并在首次启动时安全生成本地 admin key
 * 3. 并行启动 Convex function watcher 与 TanStack Start
 *
 * 用法：
 *   bun run dev
 *   bun run dev -- --no-docker   # 全部自托管 Convex/S3 依赖由操作者提供
 *
 * 停止本地基础设施使用 `bun run infra:down`；该命令不删除 volume。
 */
import { checkInfra } from '../infra/convex/health.ts'
import {
  localConvexEnv,
  log as infraLog,
  run,
  runCompose,
  waitForHttp,
} from '../infra/convex/lib.ts'

const args = new Set(process.argv.slice(2))
const noDocker = args.has('--no-docker')

function log(message: string) {
  console.log(`[synie:dev] ${message}`)
}

function requiredExternalEnvironment(env: NodeJS.ProcessEnv): string[] {
  return [
    'CONVEX_SELF_HOSTED_URL',
    'CONVEX_SELF_HOSTED_SITE_URL',
    'CONVEX_SELF_HOSTED_ADMIN_KEY',
    'VITE_CONVEX_URL',
    'VITE_CONVEX_SITE_URL',
    'SYNIE_S3_INTERNAL_ENDPOINT',
    'SYNIE_S3_PUBLIC_ENDPOINT',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
  ].filter((name) => !env[name])
}

async function assertExternalS3Reachable(endpoint: string): Promise<void> {
  let lastError = ''
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(endpoint, { redirect: 'manual' })
      if (response.status < 500) return
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await Bun.sleep(1_000)
  }
  throw new Error(`外部 S3 不可达 (${endpoint}): ${lastError}`)
}

async function ensureLocalCredentials(): Promise<NodeJS.ProcessEnv> {
  let env = localConvexEnv()
  if (env.CONVEX_SELF_HOSTED_URL && env.CONVEX_SELF_HOSTED_ADMIN_KEY) return env

  log('首次启动：生成本地 Convex admin key…')
  await run(['bun', 'run', 'convex:bootstrap'])
  env = localConvexEnv()
  if (!env.CONVEX_SELF_HOSTED_URL || !env.CONVEX_SELF_HOSTED_ADMIN_KEY) {
    throw new Error('convex:bootstrap 未生成完整的 .env.local')
  }
  return env
}

async function main() {
  if (!noDocker) {
    log('启动自托管 Convex、PostgreSQL 与 MinIO…')
    await runCompose([
      'up',
      '-d',
      'convex-postgres',
      'minio',
      'minio-public',
      'minio-init',
      'convex-backend',
      'convex-dashboard',
    ])
    await checkInfra()
  }

  const env = noDocker ? localConvexEnv() : await ensureLocalCredentials()
  if (noDocker) {
    const missing = requiredExternalEnvironment(env)
    if (missing.length > 0) {
      throw new Error(`--no-docker 缺少显式外部依赖配置：${missing.join('、')}`)
    }
    log('跳过 Docker，检查操作者提供的 Convex 与 S3…')
    await waitForHttp(
      '外部 Convex',
      `${env.CONVEX_SELF_HOSTED_URL!.replace(/\/$/, '')}/version`,
    )
    await assertExternalS3Reachable(env.SYNIE_S3_PUBLIC_ENDPOINT!)
  }

  const webPort = env.WEB_PORT ?? '3000'
  const convexUrl = env.VITE_CONVEX_URL ?? env.CONVEX_SELF_HOSTED_URL
  const convexSiteUrl = env.VITE_CONVEX_SITE_URL ?? env.CONVEX_SELF_HOSTED_SITE_URL
  const dashboardPort = env.CONVEX_DASHBOARD_PORT ?? '6791'
  const minioPort = env.MINIO_API_PORT ?? '9000'
  const minioConsolePort = env.MINIO_CONSOLE_PORT ?? '9001'

  log('启动 Convex function watcher 与 TanStack Start…')
  log(`  Web       → http://127.0.0.1:${webPort}`)
  log(`  Convex    → ${convexUrl}`)
  log(`  Auth site → ${convexSiteUrl}`)
  if (!noDocker) {
    log(`  Dashboard → http://127.0.0.1:${dashboardPort}`)
    log(`  MinIO     → http://127.0.0.1:${minioPort} (console: ${minioConsolePort})`)
  }
  log('  停止：Ctrl+C')

  const children = [
    {
      name: 'Convex watcher',
      process: Bun.spawn(['bunx', 'convex', 'dev'], {
        env,
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      }),
    },
    {
      name: 'TanStack Start',
      process: Bun.spawn(['bun', 'run', '--filter', 'synie-web', 'dev'], {
        env: {
          ...env,
          WEB_HOST: env.WEB_HOST ?? '0.0.0.0',
          WEB_PORT: webPort,
        },
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      }),
    },
  ]

  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    for (const child of children) {
      try {
        child.process.kill('SIGTERM')
      } catch {
        // 子进程可能已经退出。
      }
    }
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  const result = await Promise.race(
    children.map(async (child) => ({
      name: child.name,
      exitCode: await child.process.exited,
    })),
  )
  stop()
  await Promise.all(children.map((child) => child.process.exited))
  if (!stopping || result.exitCode !== 0) {
    throw new Error(`${result.name} 退出（code=${result.exitCode}）`)
  }
}

main().catch((error) => {
  infraLog(`开发环境启动失败：${error instanceof Error ? error.message : error}`)
  process.exit(1)
})
