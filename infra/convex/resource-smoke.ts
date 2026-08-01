import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkInfra } from './health.ts'
import { isolatedComposeEnv, log, root, run, runCompose } from './lib.ts'
import { resourceSmokeHostWebEnv } from './resource-smoke-env.ts'

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
  const project = process.env.SYNIE_RESOURCE_SMOKE_PROJECT?.trim() || `synie-plan003-resources-${suffix}`
  if (!/^[a-z0-9][a-z0-9_-]{5,80}$/.test(project)) {
    throw new Error('SYNIE_RESOURCE_SMOKE_PROJECT 不是安全的 Compose project name')
  }
  const convexPort = safePort('SYNIE_RESOURCE_SMOKE_CONVEX_PORT', 37_210)
  const sitePort = safePort('SYNIE_RESOURCE_SMOKE_SITE_PORT', 37_211)
  const webPort = safePort('SYNIE_RESOURCE_SMOKE_WEB_PORT', 4_303)
  const webOrigin = `http://127.0.0.1:${webPort}`
  const minioPort = safePort('SYNIE_RESOURCE_SMOKE_MINIO_PORT', 39_200)
  const env = isolatedComposeEnv({
    COMPOSE_PROJECT_NAME: project,
    CONVEX_POSTGRES_PORT: safePort('SYNIE_RESOURCE_SMOKE_CONVEX_POSTGRES_PORT', 37_442),
    MINIO_API_PORT: minioPort,
    MINIO_CONSOLE_PORT: safePort('SYNIE_RESOURCE_SMOKE_MINIO_CONSOLE_PORT', 39_201),
    CONVEX_PORT: convexPort,
    CONVEX_SITE_PORT: sitePort,
    CONVEX_DASHBOARD_PORT: safePort('SYNIE_RESOURCE_SMOKE_DASHBOARD_PORT', 37_791),
    CONVEX_CLOUD_ORIGIN: `http://127.0.0.1:${convexPort}`,
    CONVEX_SITE_ORIGIN: 'http://convex-backend:3211',
    SYNIE_CONVEX_PUBLIC_SITE_URL: `http://127.0.0.1:${sitePort}`,
    SYNIE_PRODUCT_FILES_CORS_ORIGIN: webOrigin,
  })
  let started = false
  let spikeConfigured = false
  let deploymentEnv: NodeJS.ProcessEnv | undefined
  let tempDirectory: string | undefined

  try {
    log(`启动隔离资源烟测栈 ${project}（测试后停止容器并保留卷）`)
    await runCompose([
      'up', '-d', 'convex-postgres', 'minio', 'minio-public', 'minio-init',
      'convex-backend', 'convex-dashboard',
    ], { env })
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

    const resourceSecret = crypto.randomUUID() + crypto.randomUUID()
    const betterAuthSecret = crypto.randomUUID() + crypto.randomUUID()
    tempDirectory = mkdtempSync(join(tmpdir(), 'synie-convex-resources-'))
    const envFile = join(tempDirectory, 'deployment.env')
    const resultFile = join(tempDirectory, 'resource-result.json')
    const s3AccessKey = env.AWS_ACCESS_KEY_ID ?? 'synie-local'
    const s3SecretKey = env.AWS_SECRET_ACCESS_KEY ?? 'synie-local-development-only'
    writeFileSync(
      envFile,
      [
        `SITE_URL=${webOrigin}`,
        `BETTER_AUTH_SECRET=${betterAuthSecret}`,
        `SYNIE_RESOURCE_SPIKE_SECRET=${resourceSecret}`,
        'SYNIE_S3_INTERNAL_ENDPOINT=http://minio:9000',
        `SYNIE_S3_PUBLIC_ENDPOINT=http://127.0.0.1:${minioPort}`,
        'SYNIE_S3_REGION=us-east-1',
        `SYNIE_S3_ACCESS_KEY_ID=${s3AccessKey}`,
        `SYNIE_S3_SECRET_ACCESS_KEY=${s3SecretKey}`,
        'SYNIE_PRODUCT_FILES_BUCKET=synie-product-files',
        '',
      ].join('\n'),
      { mode: 0o600 },
    )
    chmodSync(envFile, 0o600)

    deploymentEnv = resourceSmokeHostWebEnv(
      {
        ...env,
        CONVEX_SELF_HOSTED_PROJECT: project,
        CONVEX_SELF_HOSTED_URL: `http://127.0.0.1:${convexPort}`,
        CONVEX_SELF_HOSTED_SITE_URL: `http://127.0.0.1:${sitePort}`,
        CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey,
        E2E_CONVEX_USERNAME: '资源验收管理员',
        E2E_CONVEX_PASSWORD: 'Convex-resource-E2E-only-password',
        SYNIE_RESOURCE_SPIKE_SECRET: resourceSecret,
        SYNIE_RESOURCE_RESULT_FILE: resultFile,
      },
      { convexPort, sitePort, webPort },
    )
    await run(['bunx', 'convex', 'env', 'set', '--force', '--from-file', envFile], {
      cwd: root, env: deploymentEnv, sensitiveOutput: true,
    })
    spikeConfigured = true
    await run(['bunx', 'convex', 'dev', '--once', '--typecheck-components'], {
      cwd: root, env: deploymentEnv,
    })
    await run(['bunx', 'playwright', 'test', '--config=convex-resources.playwright.config.ts'], {
      cwd: join(root, 'web'), env: deploymentEnv,
    })
    log('Plan 003 self-hosted ResourceBinding smoke 通过')
  } finally {
    if (spikeConfigured && deploymentEnv) {
      await run(['bunx', 'convex', 'env', 'remove', 'SYNIE_RESOURCE_SPIKE_SECRET'], {
        cwd: root, env: deploymentEnv, allowFailure: true, sensitiveOutput: true,
      })
    }
    if (tempDirectory) rmSync(tempDirectory, { recursive: true, force: true })
    if (started) {
      await runCompose(['stop'], { env, allowFailure: true })
      log(`已停止 ${project}；卷保留，未执行 down -v`)
    }
  }
}

main().catch((error) => {
  console.error('[synie:convex] 资源烟测失败:', error instanceof Error ? error.message : error)
  process.exit(1)
})
