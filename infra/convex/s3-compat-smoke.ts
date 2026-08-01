import { composeEnv, log, runCompose } from './lib.ts'
import { verifyS3Compatibility } from './s3-compat.ts'

function safePort(name: string, fallback: number): string {
  const value = process.env[name] ?? String(fallback)
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new Error(`${name} 必须是 1024..65535 的端口`)
  return String(port)
}

async function main() {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10)
  const project = process.env.SYNIE_S3_COMPAT_PROJECT?.trim() || `synie-s3-compat-${suffix}`
  if (!/^[a-z0-9][a-z0-9_-]{5,80}$/.test(project)) throw new Error('SYNIE_S3_COMPAT_PROJECT 不是安全的 Compose project name')
  const apiPort = safePort('SYNIE_S3_COMPAT_API_PORT', 39_250)
  const consolePort = safePort('SYNIE_S3_COMPAT_CONSOLE_PORT', 39_251)
  const corsOrigin = 'http://127.0.0.1:4303'
  const accessKeyId = 'synie-local'
  const secretAccessKey = 'synie-local-development-only'
  const env = composeEnv({
    COMPOSE_PROJECT_NAME: project,
    MINIO_API_PORT: apiPort,
    MINIO_CONSOLE_PORT: consolePort,
    AWS_ACCESS_KEY_ID: accessKeyId,
    AWS_SECRET_ACCESS_KEY: secretAccessKey,
    SYNIE_PRODUCT_FILES_CORS_ORIGIN: corsOrigin,
  })
  let started = false
  try {
    log(`启动隔离 S3 compatibility 栈 ${project}（结束后停止容器并保留卷）`)
    await runCompose(['up', '-d', 'minio', 'minio-public', 'minio-init'], { env })
    started = true
    await checkInfraStorage(env)
    const report = await verifyS3Compatibility({
      internalEndpoint: `http://127.0.0.1:${apiPort}`,
      publicEndpoint: `http://127.0.0.1:${apiPort}`,
      region: 'us-east-1',
      accessKeyId,
      secretAccessKey,
      bucket: 'synie-product-files',
      corsOrigin,
    })
    log(`S3 compatibility 全绿：${report.checks.join('、')}`)
  } finally {
    if (started) {
      await runCompose(['stop', 'minio-public', 'minio'], { env, allowFailure: true })
      log(`已停止 ${project}；卷保留，未执行 down -v`)
    }
  }
}

async function checkInfraStorage(env: NodeJS.ProcessEnv): Promise<void> {
  const apiPort = env.MINIO_API_PORT ?? '9000'
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${apiPort}/minio/health/live`)
      if (response.ok) break
    } catch {
      // container is still starting
    }
    if (attempt === 89) throw new Error('隔离 MinIO 未就绪')
    await Bun.sleep(1_000)
  }
  await runCompose(['run', '--rm', '--no-deps', 'minio-init', 'verify'], { env })
}

main().catch((error) => {
  console.error('[synie:s3-compat] 失败:', error instanceof Error ? error.message : error)
  process.exit(1)
})
