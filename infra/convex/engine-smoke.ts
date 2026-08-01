import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkInfra } from './health.ts'
import { isolatedComposeEnv, log, root, run, runCompose } from './lib.ts'

function safePort(name: string, fallback: number): string {
  const value = process.env[name] ?? String(fallback)
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new Error(`${name} 必须是 1024..65535 的端口`)
  return String(port)
}

async function main() {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10)
  const project = process.env.SYNIE_ENGINE_SMOKE_PROJECT?.trim() || `synie-plan004-engines-${suffix}`
  if (!/^[a-z0-9][a-z0-9_-]{5,80}$/.test(project)) throw new Error('SYNIE_ENGINE_SMOKE_PROJECT 不是安全的 Compose project name')
  const convexPort = safePort('SYNIE_ENGINE_SMOKE_CONVEX_PORT', 38_210)
  const sitePort = safePort('SYNIE_ENGINE_SMOKE_SITE_PORT', 38_211)
  const env = isolatedComposeEnv({
    COMPOSE_PROJECT_NAME: project,
    CONVEX_POSTGRES_PORT: safePort('SYNIE_ENGINE_SMOKE_CONVEX_POSTGRES_PORT', 38_442),
    MINIO_API_PORT: safePort('SYNIE_ENGINE_SMOKE_MINIO_PORT', 39_300),
    MINIO_CONSOLE_PORT: safePort('SYNIE_ENGINE_SMOKE_MINIO_CONSOLE_PORT', 39_301),
    CONVEX_PORT: convexPort,
    CONVEX_SITE_PORT: sitePort,
    CONVEX_DASHBOARD_PORT: safePort('SYNIE_ENGINE_SMOKE_DASHBOARD_PORT', 38_791),
    CONVEX_CLOUD_ORIGIN: `http://127.0.0.1:${convexPort}`,
    CONVEX_SITE_ORIGIN: 'http://convex-backend:3211',
    SYNIE_CONVEX_PUBLIC_SITE_URL: `http://127.0.0.1:${sitePort}`,
    SYNIE_PRODUCT_FILES_CORS_ORIGIN: 'http://localhost:3000',
  })
  let started = false
  let secretConfigured = false
  let deploymentEnv: NodeJS.ProcessEnv | undefined
  let tempDirectory: string | undefined
  try {
    log(`启动隔离事实引擎烟测栈 ${project}（测试后停止容器并保留卷）`)
    await runCompose(['up', '-d', 'convex-postgres', 'minio', 'minio-public', 'minio-init', 'convex-backend', 'convex-dashboard'], { env })
    started = true
    await checkInfra({ env })
    const keyResult = await runCompose(['exec', '-T', 'convex-backend', './generate_admin_key.sh'], {
      env, capture: true, sensitiveOutput: true,
    })
    const adminKey = keyResult.stdout.trim().split(/\r?\n/).at(-1)?.trim()
    if (!adminKey || adminKey.length < 32 || /\s/.test(adminKey)) throw new Error('无法解析隔离 deployment admin key')
    const engineSecret = crypto.randomUUID() + crypto.randomUUID()
    const betterAuthSecret = crypto.randomUUID() + crypto.randomUUID()
    tempDirectory = mkdtempSync(join(tmpdir(), 'synie-convex-engines-'))
    const envFile = join(tempDirectory, 'deployment.env')
    writeFileSync(envFile, `SITE_URL=http://localhost:3000\nBETTER_AUTH_SECRET=${betterAuthSecret}\nSYNIE_ENGINE_SPIKE_SECRET=${engineSecret}\n`, { mode: 0o600 })
    chmodSync(envFile, 0o600)
    deploymentEnv = {
      ...env,
      CONVEX_SELF_HOSTED_PROJECT: project,
      CONVEX_SELF_HOSTED_URL: `http://127.0.0.1:${convexPort}`,
      CONVEX_SELF_HOSTED_SITE_URL: `http://127.0.0.1:${sitePort}`,
      CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey,
      SYNIE_ENGINE_SPIKE_SECRET: engineSecret,
    }
    await run(['bunx', 'convex', 'env', 'set', '--force', '--from-file', envFile], { cwd: root, env: deploymentEnv, sensitiveOutput: true })
    secretConfigured = true
    await run(['bunx', 'convex', 'dev', '--once', '--typecheck-components'], { cwd: root, env: deploymentEnv })
    await run(['bun', 'scripts/verify-convex-engines.ts'], { cwd: root, env: deploymentEnv })
    log('Plan 004 self-hosted facts/OCC/projection smoke 通过')
  } finally {
    if (secretConfigured && deploymentEnv) {
      await run(['bunx', 'convex', 'env', 'remove', 'SYNIE_ENGINE_SPIKE_SECRET'], { cwd: root, env: deploymentEnv, allowFailure: true, sensitiveOutput: true })
    }
    if (tempDirectory) rmSync(tempDirectory, { recursive: true, force: true })
    if (started) {
      await runCompose(['stop'], { env, allowFailure: true })
      log(`已停止 ${project}；卷保留，未执行 down -v`)
    }
  }
}

main().catch((error) => {
  console.error('[synie:convex] 事实引擎烟测失败:', error instanceof Error ? error.message : error)
  process.exit(1)
})
