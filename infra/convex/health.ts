import { composeEnv, expectedConvexVersion, log, runCompose, waitForHttp } from './lib.ts'

type ComposeConfig = {
  services?: Record<string, { image?: string }>
}

export async function checkInfra(
  options: { env?: NodeJS.ProcessEnv } = {},
) {
  const env = options.env ?? composeEnv()
  const version = expectedConvexVersion(env)
  const configResult = await runCompose(['config', '--format', 'json'], {
    capture: true,
    env,
  })
  const config = JSON.parse(configResult.stdout) as ComposeConfig
  const backendImage = config.services?.['convex-backend']?.image
  const dashboardImage = config.services?.['convex-dashboard']?.image
  const expectedBackend = `ghcr.io/get-convex/convex-backend:${version}`
  const expectedDashboard = `ghcr.io/get-convex/convex-dashboard:${version}`
  if (backendImage !== expectedBackend || dashboardImage !== expectedDashboard) {
    throw new Error(
      `Convex 镜像不一致：backend=${backendImage ?? 'missing'}, dashboard=${dashboardImage ?? 'missing'}`,
    )
  }

  const convexUser = env.CONVEX_POSTGRES_USER ?? 'convex'
  await runCompose(
    [
      'exec',
      '-T',
      'convex-postgres',
      'pg_isready',
      '-U',
      convexUser,
      '-d',
      'convex_self_hosted',
    ],
    { env },
  )
  const convexPort = env.CONVEX_PORT ?? '3210'
  const dashboardPort = env.CONVEX_DASHBOARD_PORT ?? '6791'
  const minioPort = env.MINIO_API_PORT ?? '9000'
  const versionResponse = await waitForHttp(
    'Convex backend',
    `http://127.0.0.1:${convexPort}/version`,
  )
  const actualVersion = (await versionResponse.text()).trim()
  if (actualVersion !== version) {
    throw new Error(`Convex /version=${actualVersion}，预期 ${version}`)
  }
  await waitForHttp('Convex dashboard', `http://127.0.0.1:${dashboardPort}`)
  await waitForHttp('MinIO', `http://127.0.0.1:${minioPort}/minio/health/live`)

  await runCompose(['run', '--rm', '--no-deps', 'minio-init', 'verify'], { env })

  const origin = env.SYNIE_PRODUCT_FILES_CORS_ORIGIN ?? 'http://localhost:3000'
  const corsResponse = await fetch(
    `http://127.0.0.1:${minioPort}/synie-product-files/__synie_cors_probe__`,
    {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'content-type,x-amz-checksum-sha256',
      },
    },
  )
  const allowedOrigin = corsResponse.headers.get('access-control-allow-origin')
  if (!corsResponse.ok || allowedOrigin !== origin) {
    throw new Error(
      `MinIO CORS preflight 失败：status=${corsResponse.status}, allow-origin=${allowedOrigin ?? 'missing'}`,
    )
  }

  const internalCorsResponse = await fetch(
    `http://127.0.0.1:${minioPort}/convex-modules/__synie_cors_probe__`,
    {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'PUT',
      },
    },
  )
  if (internalCorsResponse.headers.has('access-control-allow-origin')) {
    throw new Error('Convex 内部 bucket 意外暴露浏览器 CORS capability')
  }

  const anonymousProductRead = await fetch(
    `http://127.0.0.1:${minioPort}/synie-product-files/__synie_private_probe__`,
  )
  if (anonymousProductRead.status !== 403 && anonymousProductRead.status !== 404) {
    throw new Error(`产品 bucket 匿名读取未被拒绝：HTTP ${anonymousProductRead.status}`)
  }

  const logs = await runCompose(['logs', '--no-color', 'convex-backend'], {
    capture: true,
    env,
  })
  const output = `${logs.stdout}\n${logs.stderr}`
  if (!/Connected to Postgres database: convex-self-hosted/.test(output)) {
    throw new Error('Convex 日志未确认连接 PostgreSQL')
  }
  if (!/S3 \{.*\} storage is configured\./.test(output)) {
    throw new Error('Convex 日志未确认启用 S3 storage')
  }
  if (/falling back to local storage|SQLite/i.test(output)) {
    throw new Error('Convex 日志显示回退 SQLite/local storage')
  }

  log(`基础设施健康：PostgreSQL 17、MinIO、Convex ${version}、dashboard`)
}

if (import.meta.main) {
  checkInfra().catch((error) => {
    console.error('[synie:convex] 健康检查失败:', error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
