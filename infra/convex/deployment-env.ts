import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { log, root, run, selfHostedConvexCliEnv } from './lib.ts'

const MANAGED_NAMES = new Set([
  'SITE_URL',
  'BETTER_AUTH_SECRET',
  'SYNIE_S3_INTERNAL_ENDPOINT',
  'SYNIE_S3_PUBLIC_ENDPOINT',
  'SYNIE_S3_REGION',
  'SYNIE_S3_ACCESS_KEY_ID',
  'SYNIE_S3_SECRET_ACCESS_KEY',
  'SYNIE_PRODUCT_FILES_BUCKET',
  'PRINT_WORKER_URL',
  'PRINT_WORKER_HMAC_SECRET',
  'SYNIE_OCR_ACCESS_KEY_ID',
  'SYNIE_OCR_ACCESS_KEY_SECRET',
])

type ComposeService = {
  environment?: Record<string, string | null>
}

export type DeploymentComposeConfig = {
  services?: Record<string, ComposeService>
}

export type LocalDeploymentInputs = {
  siteUrl: string
  s3InternalEndpoint: string
  s3PublicEndpoint: string
  s3Region: string
  s3AccessKeyId: string
  s3SecretAccessKey: string
  productFilesBucket: string
  printWorkerUrl: string
  printWorkerHmacSecret: string
}

function required(value: string | null | undefined, label: string): string {
  const normalized = value?.trim()
  if (!normalized) throw new Error(`${label} 不能为空`)
  return normalized
}

function normalizedOrigin(value: string, label: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label} 不是有效 URL`)
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`${label} 必须是无凭据的 HTTP(S) origin`)
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new Error(`${label} 只能包含 origin，不能包含路径、查询或片段`)
  }
  return url.origin
}

function envValue(
  service: ComposeService | undefined,
  name: string,
  label: string,
): string {
  return required(service?.environment?.[name], `${label}.${name}`)
}

/**
 * 从 Docker Compose 已解析配置取得必须与容器完全一致的本地 deployment 值。
 * 调用方不得打印 Compose config；其中含本地 secret。
 */
export function localDeploymentInputs(
  config: DeploymentComposeConfig,
  env: NodeJS.ProcessEnv = process.env,
): LocalDeploymentInputs {
  const backend = config.services?.['convex-backend']
  const web = config.services?.web
  const minio = config.services?.minio
  const backendHmac = envValue(
    backend,
    'PRINT_WORKER_HMAC_SECRET',
    'convex-backend',
  )
  const webHmac = envValue(web, 'PRINT_WORKER_HMAC_SECRET', 'web')
  if (backendHmac !== webHmac) {
    throw new Error('Web 与 Convex backend 的 PRINT_WORKER_HMAC_SECRET 不一致')
  }
  if (Buffer.byteLength(backendHmac, 'utf8') < 32) {
    throw new Error('PRINT_WORKER_HMAC_SECRET 必须至少 32 bytes')
  }

  const siteUrl = normalizedOrigin(
    web?.environment?.VITE_SITE_URL ??
      env.VITE_SITE_URL ??
      `http://127.0.0.1:${env.WEB_PORT ?? '3000'}`,
    'VITE_SITE_URL',
  )
  return {
    siteUrl,
    s3InternalEndpoint: required(
      env.SYNIE_S3_INTERNAL_ENDPOINT ?? 'http://minio:9000',
      'SYNIE_S3_INTERNAL_ENDPOINT',
    ).replace(/\/$/, ''),
    s3PublicEndpoint: required(
      env.SYNIE_S3_PUBLIC_ENDPOINT ??
        `http://127.0.0.1:${env.MINIO_API_PORT ?? '9000'}`,
      'SYNIE_S3_PUBLIC_ENDPOINT',
    ).replace(/\/$/, ''),
    s3Region: required(env.SYNIE_S3_REGION ?? 'us-east-1', 'SYNIE_S3_REGION'),
    s3AccessKeyId: envValue(minio, 'MINIO_ROOT_USER', 'minio'),
    s3SecretAccessKey: envValue(minio, 'MINIO_ROOT_PASSWORD', 'minio'),
    productFilesBucket: required(
      env.SYNIE_PRODUCT_FILES_BUCKET ?? 'synie-product-files',
      'SYNIE_PRODUCT_FILES_BUCKET',
    ),
    printWorkerUrl: envValue(backend, 'PRINT_WORKER_URL', 'convex-backend'),
    printWorkerHmacSecret: backendHmac,
  }
}

function assignmentName(line: string): string {
  const separator = line.indexOf('=')
  if (separator < 1) throw new Error('Convex deployment env 输出格式无效')
  const name = line.slice(0, separator)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error('Convex deployment env 含无效变量名')
  }
  return name
}

function decodedValue(line: string): string {
  const raw = line.slice(line.indexOf('=') + 1).trim()
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw) as string
    } catch {
      throw new Error('Convex deployment env 含无法解析的双引号值')
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1)
  return raw
}

function capturedAssignments(source: string): Map<string, string> {
  const assignments = new Map<string, string>()
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const name = assignmentName(line)
    if (assignments.has(name)) throw new Error(`Convex deployment env 重复变量：${name}`)
    assignments.set(name, line)
  }
  return assignments
}

function encodedAssignment(name: string, value: string): string {
  return `${name}=${JSON.stringify(value)}`
}

export function buildLocalDeploymentEnv(
  capturedSource: string,
  inputs: LocalDeploymentInputs,
  options: {
    rotateBetterAuthSecret?: boolean
    env?: NodeJS.ProcessEnv
  } = {},
): string {
  const captured = capturedAssignments(capturedSource)
  const existingBetterAuth = captured.get('BETTER_AUTH_SECRET')
  const betterAuthSecret =
    !options.rotateBetterAuthSecret && existingBetterAuth
      ? decodedValue(existingBetterAuth)
      : randomBytes(32).toString('hex')
  if (Buffer.byteLength(betterAuthSecret, 'utf8') < 32) {
    throw new Error('BETTER_AUTH_SECRET 必须至少 32 bytes')
  }

  const preserved = [...captured.entries()]
    .filter(([name]) => !MANAGED_NAMES.has(name))
    .map(([, line]) => line)
  const values: Record<string, string> = {
    SITE_URL: inputs.siteUrl,
    BETTER_AUTH_SECRET: betterAuthSecret,
    SYNIE_S3_INTERNAL_ENDPOINT: inputs.s3InternalEndpoint,
    SYNIE_S3_PUBLIC_ENDPOINT: inputs.s3PublicEndpoint,
    SYNIE_S3_REGION: inputs.s3Region,
    SYNIE_S3_ACCESS_KEY_ID: inputs.s3AccessKeyId,
    SYNIE_S3_SECRET_ACCESS_KEY: inputs.s3SecretAccessKey,
    SYNIE_PRODUCT_FILES_BUCKET: inputs.productFilesBucket,
    PRINT_WORKER_URL: inputs.printWorkerUrl,
    PRINT_WORKER_HMAC_SECRET: inputs.printWorkerHmacSecret,
  }

  const capturedOcrId = captured.get('SYNIE_OCR_ACCESS_KEY_ID')
  const capturedOcrSecret = captured.get('SYNIE_OCR_ACCESS_KEY_SECRET')
  const capturedOcrIdValue = capturedOcrId
    ? decodedValue(capturedOcrId).trim() || undefined
    : undefined
  const capturedOcrSecretValue = capturedOcrSecret
    ? decodedValue(capturedOcrSecret).trim() || undefined
    : undefined
  if (Boolean(capturedOcrIdValue) !== Boolean(capturedOcrSecretValue)) {
    throw new Error('捕获的 OCR AccessKey 必须成对配置')
  }
  const env = options.env ?? process.env
  const configuredOcrId = env.SYNIE_OCR_ACCESS_KEY_ID?.trim()
  const configuredOcrSecret = env.SYNIE_OCR_ACCESS_KEY_SECRET?.trim()
  if (Boolean(configuredOcrId) !== Boolean(configuredOcrSecret)) {
    throw new Error('SYNIE_OCR_ACCESS_KEY_ID 与 SYNIE_OCR_ACCESS_KEY_SECRET 必须成对配置')
  }
  const ocrId = capturedOcrIdValue ?? configuredOcrId
  const ocrSecret = capturedOcrSecretValue ?? configuredOcrSecret
  if (ocrId && ocrSecret) {
    values.SYNIE_OCR_ACCESS_KEY_ID = ocrId
    values.SYNIE_OCR_ACCESS_KEY_SECRET = ocrSecret
  }

  return `${[
    ...preserved,
    ...Object.entries(values).map(([name, value]) => encodedAssignment(name, value)),
  ].join('\n')}\n`
}

export async function captureDeploymentEnv(
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const cliEnv = selfHostedConvexCliEnv(env)
  const result = await run(['bunx', 'convex', 'env', 'list'], {
    cwd: root,
    env: cliEnv,
    capture: true,
    sensitiveOutput: true,
  })
  // 先解析一次；在接触 volume 前拒绝无法无损恢复的输出。
  capturedAssignments(result.stdout)
  return result.stdout
}

export async function applyDeploymentEnv(
  source: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  capturedAssignments(source)
  const cliEnv = selfHostedConvexCliEnv(env)
  const directory = mkdtempSync(join(tmpdir(), 'synie-convex-deployment-env-'))
  const path = join(directory, 'deployment.env')
  try {
    writeFileSync(path, source, { mode: 0o600 })
    chmodSync(path, 0o600)
    await run(
      ['bunx', 'convex', 'env', 'set', '--force', '--from-file', path],
      { cwd: root, env: cliEnv, sensitiveOutput: true },
    )
    const hmac = await run(
      ['bunx', 'convex', 'env', 'get', 'PRINT_WORKER_HMAC_SECRET'],
      { cwd: root, env: cliEnv, capture: true, sensitiveOutput: true },
    )
    const expected = decodedValue(
      capturedAssignments(source).get('PRINT_WORKER_HMAC_SECRET')!,
    )
    if (hmac.stdout.trim() !== expected) {
      throw new Error('Convex deployment 与 Compose 的 Print Worker HMAC 不同步')
    }
    log('deployment env 已写入并完成 secret 一致性校验（未输出值）')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
