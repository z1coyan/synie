import { createHash } from 'node:crypto'
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { checkInfra } from './health.ts'
import { exportSnapshot, requireSafeOutputDirectory } from './backup.ts'
import {
  composeEnv,
  composeProjectName,
  isolatedComposeEnv,
  localConvexEnv,
  log,
  run,
  runCompose,
} from './lib.ts'
import { assertFreshComposeProject, importSnapshot, requireTargetProject } from './restore.ts'

const SMOKE_MARKER = 'plan-001-file-v1'
const SMOKE_FILE_TEXT =
  'Synie Convex restore smoke\nmarker=plan-001-file-v1\n数据库记录与文件存储必须逐字节恢复。\n'
const SMOKE_FILE_BYTES = new TextEncoder().encode(SMOKE_FILE_TEXT)
const SMOKE_FILE_SHA256 = '0a29e15e939a65999b75c750727a892b4f3382a6ea6aa123726d0166e9bc2935'
const PRODUCT_OBJECT_KEY = 'files/restore-smoke/plan-006-product-file.bin'
const PRODUCT_FILE_TEXT =
  'Synie product S3 restore smoke\nmarker=plan-006-product-file-v1\nConvex 元数据与产品对象必须配对恢复。\n'
const PRODUCT_FILE_BYTES = new TextEncoder().encode(PRODUCT_FILE_TEXT)
const PRODUCT_FILE_SHA256 = 'a620e67d54c84b2aa4948563d60b2db1fc5a58bcd3a2ded3139cb4263ad98a62'
const PRODUCT_CONTENT_TYPE = 'application/octet-stream'
const PRODUCT_BUCKET = 'synie-product-files'

type ConvexJsonBytes = { $bytes: string }

type FixtureResult = {
  marker: string
  storageId: string
  expectedSha256: string
  contentType: string
  bytes: Uint8Array
}

type ProductFixtureResult = {
  fileId: string
  objectKey: string
  expectedSha256: string
  size: number
  contentType: string
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function deploymentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const {
    CONVEX_DEPLOYMENT: _deployment,
    CONVEX_DEPLOY_KEY: _deployKey,
    ...selfHostedEnv
  } = env
  return selfHostedEnv
}

function productS3Client(endpoint: string, env: NodeJS.ProcessEnv): S3Client {
  return new S3Client({
    region: env.SYNIE_S3_REGION ?? 'us-east-1',
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID ?? 'synie-local',
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? 'synie-local-development-only',
    },
  })
}

function checksumBase64(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64')
}

function parseFixtureResult(raw: string, label: string): FixtureResult {
  const value = JSON.parse(raw) as Record<string, unknown>
  const encoded = value.bytes as Partial<ConvexJsonBytes> | undefined
  if (
    value.marker !== SMOKE_MARKER ||
    typeof value.storageId !== 'string' ||
    typeof value.expectedSha256 !== 'string' ||
    typeof value.contentType !== 'string' ||
    typeof encoded?.$bytes !== 'string'
  ) {
    throw new Error(`${label} 恢复演练函数返回无效`)
  }
  return {
    marker: value.marker,
    storageId: value.storageId,
    expectedSha256: value.expectedSha256,
    contentType: value.contentType,
    bytes: Buffer.from(encoded.$bytes, 'base64'),
  }
}

async function deployFunctions(env: NodeJS.ProcessEnv, label: string) {
  log(`部署当前 Convex functions 到 ${label}`)
  await run(['bunx', 'convex', 'deploy', '--typecheck', 'enable'], {
    env: deploymentEnv(env),
  })
}

async function runFixtureFunction(
  env: NodeJS.ProcessEnv,
  functionName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const result = await run(
    ['bunx', 'convex', 'run', functionName, JSON.stringify(args)],
    { capture: true, env: deploymentEnv(env) },
  )
  return result.stdout.trim()
}

async function writeSourceFixture(env: NodeJS.ProcessEnv) {
  await runFixtureFunction(env, 'internal.infraRestore.writeFixture', {
    marker: SMOKE_MARKER,
    bytes: { $bytes: Buffer.from(SMOKE_FILE_BYTES).toString('base64') },
    expectedSha256: SMOKE_FILE_SHA256,
  })
}

async function registerProductFixture(env: NodeJS.ProcessEnv) {
  await runFixtureFunction(env, 'internal.infraRestore.registerProductFixture', {
    marker: SMOKE_MARKER,
    objectKey: PRODUCT_OBJECT_KEY,
    expectedSha256: PRODUCT_FILE_SHA256,
    size: PRODUCT_FILE_BYTES.byteLength,
    contentType: PRODUCT_CONTENT_TYPE,
  })
}

async function readProductMetadata(
  env: NodeJS.ProcessEnv,
  label: string,
): Promise<ProductFixtureResult> {
  const value = JSON.parse(
    await runFixtureFunction(env, 'internal.infraRestore.productFixture', {
      marker: SMOKE_MARKER,
    }),
  ) as Partial<ProductFixtureResult>
  if (
    typeof value.fileId !== 'string' ||
    value.objectKey !== PRODUCT_OBJECT_KEY ||
    value.expectedSha256 !== PRODUCT_FILE_SHA256 ||
    value.size !== PRODUCT_FILE_BYTES.byteLength ||
    value.contentType !== PRODUCT_CONTENT_TYPE
  ) {
    throw new Error(`${label} 产品文件元数据不一致`)
  }
  return value as ProductFixtureResult
}

async function putProductObject(
  endpoint: string,
  env: NodeJS.ProcessEnv,
  bytes: Uint8Array,
) {
  const client = productS3Client(endpoint, env)
  try {
    await client.send(new PutObjectCommand({
      Bucket: PRODUCT_BUCKET,
      Key: PRODUCT_OBJECT_KEY,
      Body: bytes,
      ContentLength: bytes.byteLength,
      ContentType: PRODUCT_CONTENT_TYPE,
      ChecksumSHA256: checksumBase64(PRODUCT_FILE_SHA256),
      Metadata: { sha256: PRODUCT_FILE_SHA256 },
    }))
  } finally {
    client.destroy()
  }
}

async function readAndVerifyProductObject(
  endpoint: string,
  env: NodeJS.ProcessEnv,
  label: string,
): Promise<Uint8Array> {
  const client = productS3Client(endpoint, env)
  try {
    const head = await client.send(new HeadObjectCommand({
      Bucket: PRODUCT_BUCKET,
      Key: PRODUCT_OBJECT_KEY,
      ChecksumMode: 'ENABLED',
    }))
    const expectedBase64 = checksumBase64(PRODUCT_FILE_SHA256)
    if (
      head.ContentLength !== PRODUCT_FILE_BYTES.byteLength ||
      head.ContentType !== PRODUCT_CONTENT_TYPE ||
      (head.ChecksumSHA256 !== expectedBase64 && head.Metadata?.sha256 !== PRODUCT_FILE_SHA256)
    ) {
      throw new Error(`${label} 产品对象 HEAD/checksum 不一致`)
    }
    const object = await client.send(new GetObjectCommand({
      Bucket: PRODUCT_BUCKET,
      Key: PRODUCT_OBJECT_KEY,
      ChecksumMode: 'ENABLED',
    }))
    const bytes = await object.Body?.transformToByteArray()
    if (!bytes || sha256(bytes) !== PRODUCT_FILE_SHA256) {
      throw new Error(`${label} 产品对象字节 SHA-256 不一致`)
    }
    return bytes
  } finally {
    client.destroy()
  }
}

async function readAndVerifyFixture(
  env: NodeJS.ProcessEnv,
  label: string,
): Promise<FixtureResult> {
  const result = parseFixtureResult(
    await runFixtureFunction(env, 'internal.infraRestore.readFixture', {
      marker: SMOKE_MARKER,
    }),
    label,
  )
  const actualSha256 = sha256(result.bytes)
  if (
    result.expectedSha256 !== SMOKE_FILE_SHA256 ||
    actualSha256 !== SMOKE_FILE_SHA256 ||
    !Buffer.from(result.bytes).equals(Buffer.from(SMOKE_FILE_BYTES))
  ) {
    throw new Error(
      `${label} 恢复演练记录/文件不一致：record=${result.expectedSha256}, bytes=${actualSha256}`,
    )
  }
  return result
}

async function main() {
  if (sha256(SMOKE_FILE_BYTES) !== SMOKE_FILE_SHA256) {
    throw new Error('恢复演练 fixture 字节或固定 SHA-256 已漂移')
  }
  if (sha256(PRODUCT_FILE_BYTES) !== PRODUCT_FILE_SHA256) {
    throw new Error('产品文件恢复 fixture 字节或固定 SHA-256 已漂移')
  }
  const outputDirectory = requireSafeOutputDirectory(process.argv[2])
  const targetProject = requireTargetProject(process.argv[3])
  const sourceEnv = localConvexEnv()
  const sourceProject = sourceEnv.CONVEX_SELF_HOSTED_PROJECT
  if (!sourceProject) {
    throw new Error('缺少 CONVEX_SELF_HOSTED_PROJECT；请在当前源 stack 重新运行 convex:bootstrap')
  }
  const activeSourceProject = await composeProjectName(composeEnv())
  if (sourceProject !== activeSourceProject) {
    throw new Error(
      `源凭据属于 ${sourceProject}，当前 Compose project 是 ${activeSourceProject}；拒绝混用`,
    )
  }
  if (targetProject === sourceProject) {
    throw new Error('target project 必须与源 project 不同')
  }

  if (!sourceEnv.CONVEX_SELF_HOSTED_URL || !sourceEnv.CONVEX_SELF_HOSTED_ADMIN_KEY) {
    throw new Error('请先运行 bun run convex:bootstrap')
  }

  const targetConvexPort = process.env.RESTORE_CONVEX_PORT ?? '13210'
  const targetSitePort = process.env.RESTORE_CONVEX_SITE_PORT ?? '13211'
  const targetEnv = isolatedComposeEnv({
    COMPOSE_PROJECT_NAME: targetProject,
    CONVEX_POSTGRES_PORT: process.env.RESTORE_CONVEX_POSTGRES_PORT ?? '15442',
    MINIO_API_PORT: process.env.RESTORE_MINIO_API_PORT ?? '19000',
    MINIO_CONSOLE_PORT: process.env.RESTORE_MINIO_CONSOLE_PORT ?? '19001',
    CONVEX_PORT: targetConvexPort,
    CONVEX_SITE_PORT: targetSitePort,
    CONVEX_DASHBOARD_PORT: process.env.RESTORE_CONVEX_DASHBOARD_PORT ?? '16791',
    CONVEX_CLOUD_ORIGIN: `http://127.0.0.1:${targetConvexPort}`,
    CONVEX_SITE_ORIGIN: 'http://convex-backend:3211',
    SYNIE_S3_PUBLIC_ENDPOINT: `http://127.0.0.1:${process.env.RESTORE_MINIO_API_PORT ?? '19000'}`,
  })
  await assertFreshComposeProject(targetProject, targetEnv)

  const started = performance.now()
  await deployFunctions(sourceEnv, `source:${sourceProject}`)
  await writeSourceFixture(sourceEnv)
  const sourceProductEndpoint =
    sourceEnv.SYNIE_S3_PUBLIC_ENDPOINT ??
    `http://127.0.0.1:${sourceEnv.MINIO_API_PORT ?? '9000'}`
  await putProductObject(sourceProductEndpoint, sourceEnv, PRODUCT_FILE_BYTES)
  await registerProductFixture(sourceEnv)
  const sourceFixture = await readAndVerifyFixture(sourceEnv, `source:${sourceProject}`)
  await readProductMetadata(sourceEnv, `source:${sourceProject}`)
  const productBackupBytes = await readAndVerifyProductObject(
    sourceProductEndpoint,
    sourceEnv,
    `source:${sourceProject}`,
  )
  const sourceSnapshot = await exportSnapshot(outputDirectory)

  let targetStarted = false
  try {
    targetStarted = true
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
      { env: targetEnv },
    )
    await checkInfra({ env: targetEnv })
    const keyResult = await runCompose(
      ['exec', '-T', 'convex-backend', './generate_admin_key.sh'],
      { capture: true, env: targetEnv, sensitiveOutput: true },
    )
    const targetAdminKey = keyResult.stdout.trim().split(/\r?\n/).at(-1)?.trim()
    if (!targetAdminKey) throw new Error('无法生成目标 admin key')
    const targetUrl = `http://127.0.0.1:${targetConvexPort}`
    const targetDeploymentEnv = composeEnv({
      CONVEX_SELF_HOSTED_URL: targetUrl,
      CONVEX_SELF_HOSTED_ADMIN_KEY: targetAdminKey,
    })
    await deployFunctions(targetDeploymentEnv, `target:${targetProject}`)
    const targetProductEndpoint = `http://127.0.0.1:${process.env.RESTORE_MINIO_API_PORT ?? '19000'}`
    await putProductObject(targetProductEndpoint, targetEnv, productBackupBytes)
    await importSnapshot({
      snapshot: sourceSnapshot,
      targetProject,
      targetUrl,
      targetAdminKey,
    })

    const targetFixture = await readAndVerifyFixture(
      targetDeploymentEnv,
      `target:${targetProject}`,
    )
    await readProductMetadata(targetDeploymentEnv, `target:${targetProject}`)
    const targetProductBytes = await readAndVerifyProductObject(
      targetProductEndpoint,
      targetEnv,
      `target:${targetProject}`,
    )
    if (
      targetFixture.marker !== sourceFixture.marker ||
      targetFixture.expectedSha256 !== sourceFixture.expectedSha256 ||
      sha256(targetFixture.bytes) !== sha256(sourceFixture.bytes)
    ) {
      throw new Error('恢复后的数据库记录或文件字节 SHA-256 与源 deployment 不一致')
    }
    if (!Buffer.from(targetProductBytes).equals(Buffer.from(productBackupBytes))) {
      throw new Error('恢复后的产品 S3 对象字节与源对象不一致')
    }
    const seconds = ((performance.now() - started) / 1_000).toFixed(2)
    log(
      `恢复演练通过 source=${sourceProject} target=${targetProject} marker=${SMOKE_MARKER} convexFileSha256=${SMOKE_FILE_SHA256} productFileSha256=${PRODUCT_FILE_SHA256} productBytes=${PRODUCT_FILE_BYTES.byteLength} elapsed=${seconds}s`,
    )
  } finally {
    if (targetStarted) {
      await runCompose(['down', '--remove-orphans'], {
        env: targetEnv,
        allowFailure: true,
      })
      log(`已停止临时 stack ${targetProject}；未删除 volume`)
    }
  }
}

main().catch((error) => {
  console.error('[synie:convex] 恢复演练失败:', error instanceof Error ? error.message : error)
  process.exit(1)
})
