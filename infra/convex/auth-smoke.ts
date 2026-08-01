import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkInfra } from './health.ts'
import { isolatedComposeEnv, log, root, run, runCompose } from './lib.ts'

function safePort(name: string, fallback: number): string {
  const value = process.env[name] ?? String(fallback)
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error(`${name} 必须是 1024..65535 的端口`)
  }
  return String(port)
}

async function main() {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10)
  const prepareBrowserOnly = process.env.SYNIE_AUTH_SMOKE_PREPARE_BROWSER === '1'
  const project =
    process.env.SYNIE_AUTH_SMOKE_PROJECT?.trim() || `synie-plan002-auth-${suffix}`
  if (!/^[a-z0-9][a-z0-9_-]{5,80}$/.test(project)) {
    throw new Error('SYNIE_AUTH_SMOKE_PROJECT 不是安全的 Compose project name')
  }
  const convexPort = safePort('SYNIE_AUTH_SMOKE_CONVEX_PORT', 36_210)
  const sitePort = safePort('SYNIE_AUTH_SMOKE_SITE_PORT', 36_211)
  const env = isolatedComposeEnv({
    COMPOSE_PROJECT_NAME: project,
    CONVEX_POSTGRES_PORT: safePort('SYNIE_AUTH_SMOKE_CONVEX_POSTGRES_PORT', 35_442),
    MINIO_API_PORT: safePort('SYNIE_AUTH_SMOKE_MINIO_PORT', 39_100),
    MINIO_CONSOLE_PORT: safePort('SYNIE_AUTH_SMOKE_MINIO_CONSOLE_PORT', 39_101),
    CONVEX_PORT: convexPort,
    CONVEX_SITE_PORT: sitePort,
    CONVEX_DASHBOARD_PORT: safePort('SYNIE_AUTH_SMOKE_DASHBOARD_PORT', 36_791),
    CONVEX_CLOUD_ORIGIN: `http://127.0.0.1:${convexPort}`,
    CONVEX_SITE_ORIGIN: 'http://convex-backend:3211',
    SYNIE_CONVEX_PUBLIC_SITE_URL: `http://127.0.0.1:${sitePort}`,
    SYNIE_PRODUCT_FILES_CORS_ORIGIN: 'http://localhost:3000',
  })
  let started = false
  let deploymentEnv: NodeJS.ProcessEnv | undefined
  let spikeConfigured = false
  let envDirectory: string | undefined

  try {
    log(
      prepareBrowserOnly
        ? `启动隔离浏览器 E2E 栈 ${project}（显式保留运行态）`
        : `启动隔离认证烟测栈 ${project}（测试完成后停止容器并保留卷）`,
    )
    await runCompose(
      [
        'up',
        '-d',
        'convex-postgres',
        'minio',
        'minio-public',
        'minio-init',
        'convex-backend',
        'convex-dashboard',
      ],
      { env },
    )
    started = true
    await checkInfra({ env })

    const keyResult = await runCompose(
      ['exec', '-T', 'convex-backend', './generate_admin_key.sh'],
      { env, capture: true, sensitiveOutput: true },
    )
    const adminKey = keyResult.stdout.trim().split(/\r?\n/).at(-1)?.trim()
    if (!adminKey || adminKey.length < 32 || /\s/.test(adminKey)) {
      throw new Error('无法解析隔离 deployment admin key')
    }

    const spikeSecret = crypto.randomUUID() + crypto.randomUUID()
    const betterAuthSecret = crypto.randomUUID() + crypto.randomUUID()
    deploymentEnv = {
      ...env,
      CONVEX_SELF_HOSTED_PROJECT: project,
      CONVEX_SELF_HOSTED_URL: `http://127.0.0.1:${convexPort}`,
      CONVEX_SELF_HOSTED_SITE_URL: `http://127.0.0.1:${sitePort}`,
      CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey,
      VITE_CONVEX_URL: `http://127.0.0.1:${convexPort}`,
      VITE_CONVEX_SITE_URL: `http://127.0.0.1:${sitePort}`,
      VITE_SITE_URL: 'http://localhost:3000',
      SYNIE_AUTH_SPIKE_SECRET: spikeSecret,
      SYNIE_AUTH_SPIKE_AUTH_BASE_URL: `http://127.0.0.1:${sitePort}/api/auth`,
      SYNIE_AUTH_SPIKE_SITE_ORIGIN: 'http://localhost:3000',
      SYNIE_AUTH_SPIKE_COMPOSE_PROJECT: project,
    }

    envDirectory = mkdtempSync(join(tmpdir(), 'synie-convex-auth-env-'))
    const envFile = join(envDirectory, 'deployment.env')
    writeFileSync(
      envFile,
      `SITE_URL=http://localhost:3000\nBETTER_AUTH_SECRET=${betterAuthSecret}\n${
        prepareBrowserOnly ? '' : `SYNIE_AUTH_SPIKE_SECRET=${spikeSecret}\n`
      }`,
      { mode: 0o600 },
    )
    chmodSync(envFile, 0o600)
    await run(['bunx', 'convex', 'env', 'set', '--force', '--from-file', envFile], {
      cwd: root,
      env: deploymentEnv,
      sensitiveOutput: true,
    })
    spikeConfigured = !prepareBrowserOnly
    await run(['bunx', 'convex', 'dev', '--once', '--typecheck-components'], {
      cwd: root,
      env: deploymentEnv,
    })
    if (prepareBrowserOnly) {
      started = false
      log(
        `浏览器 E2E 栈已准备：project=${project} convex=http://127.0.0.1:${convexPort} site=http://127.0.0.1:${sitePort}`,
      )
      return
    }
    await run(['bun', 'scripts/verify-convex-auth-atomicity.ts'], {
      cwd: root,
      env: deploymentEnv,
    })
    log('Plan 002 self-hosted auth/IAM smoke 通过')
  } finally {
    if (spikeConfigured && deploymentEnv) {
      await run(
        ['bunx', 'convex', 'env', 'remove', 'SYNIE_AUTH_SPIKE_SECRET'],
        { cwd: root, env: deploymentEnv, allowFailure: true, sensitiveOutput: true },
      )
    }
    if (envDirectory) rmSync(envDirectory, { recursive: true, force: true })
    if (started) {
      await runCompose(['stop'], { env, allowFailure: true })
      log(`已停止 ${project}；卷保留，未执行 down -v`)
    }
  }
}

main().catch((error) => {
  console.error('[synie:convex] 认证烟测失败:', error instanceof Error ? error.message : error)
  process.exit(1)
})
