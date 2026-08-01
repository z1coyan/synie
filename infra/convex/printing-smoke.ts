import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { bytesToText, textToBytes, unzipParts, zipParts } from '@synie/shared'
import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'
import { checkInfra } from './health.ts'
import { composeEnv, log, root, run, runCompose, waitForHttp } from './lib.ts'
import { verifyPrintWorkerContract } from './print-worker-contract-test.ts'
import { preparePrintBaseline } from './printing-smoke-fixtures.ts'

type GenericRow = Record<string, unknown> & { id: string }
type PrintJob = {
  id: string
  status: 'queued' | 'running' | 'succeeded' | 'retryable' | 'failed' | 'expired'
  attempts: number
  errorCode: string | null
  hasOutput: boolean
}
type Download = { url: string; filename: string; contentType: string }

const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const PRODUCT_BUCKET = 'synie-product-files'

const createFirstUserRef = makeFunctionReference<'mutation', {
  username: string
  password: string
  name?: string | null
}, { user: { id: string; username: string; name: string | null } }>(
  'setup/createFirstUser:createFirstUser',
)
const currencyCreateRef = makeFunctionReference<'mutation', {
  name: string
  isoCode: string
  symbol?: string | null
  active?: boolean
}, GenericRow>('resources/currencies:create')
const unitCreateRef = makeFunctionReference<'mutation', {
  unitType: 'QUANTITY'
  isBase?: boolean
  name: string
  symbol: string
  ratio: string
}, GenericRow>('resources/units:create')
const companyCreateRef = makeFunctionReference<'mutation', {
  code: string
  name: string
  shortName: string
  baseCurrencyId: string
}, GenericRow>('domains/base/companies:create')
const customerCreateRef = makeFunctionReference<'mutation', {
  code: string
  name: string
  shortName?: string | null
}, GenericRow>('domains/party/parties:createCustomer')
const categoryCreateRef = makeFunctionReference<'mutation', {
  code: string
  name: string
  isLeaf?: boolean
}, GenericRow>('domains/inventory/master:createCategory')
const materialCreateRef = makeFunctionReference<'mutation', {
  code: string
  name: string
  categoryId: string
  defaultUnitId: string
}, GenericRow>('domains/inventory/master:createMaterial')
const draftCreateRef = makeFunctionReference<'mutation', {
  resource: string
  input: unknown
}, GenericRow>('domains/trading/drafts:createDraft')
const roleCreateRef = makeFunctionReference<'mutation', {
  code: string
  name: string
}, { id: string }>('iam/roles:create')
const roleSyncRef = makeFunctionReference<'mutation', {
  id: string
  permissions: string[]
}, string[]>('iam/roles:syncPermissions')
const userCreateRef = makeFunctionReference<'mutation', {
  username: string
  name?: string | null
  roleIds?: string[]
  companyIds?: string[]
}, { user: { id: string; username: string }; password: string }>('iam/users:create')
const fileIntentRef = makeFunctionReference<'mutation', {
  filename: string
  contentType: string
  size: number
  sha256: string
}, { id: string }>('files/domain:createUploadIntent')
const fileSignRef = makeFunctionReference<'action', { intentId: string }, {
  finalized: boolean
  url?: string
  headers?: Record<string, string>
}>('files/actions:signUpload')
const fileFinalizeRef = makeFunctionReference<'action', { intentId: string }, {
  file: GenericRow
}>('files/actions:finalizeUpload')
const templateCreateRef = makeFunctionReference<'action', {
  name: string
  resource: 'sales.order'
  fileId: string
  remarks?: string | null
}, GenericRow>('platform/printing/actions:createTemplate')
const templateDefaultRef = makeFunctionReference<'mutation', {
  id: string
  value: boolean
}, GenericRow>('platform/printing/templates:setDefault')
const templateUsableRef = makeFunctionReference<'query', {
  resource: 'sales.order'
}, GenericRow[]>('platform/printing/templates:usable')
const exportRef = makeFunctionReference<'action', {
  resource: 'sales.order'
  templateId: string
  ids: string[]
  requestNonce: string
}, Download & { artifactId: string }>('platform/printing/actions:exportXlsx')
const startPrintRef = makeFunctionReference<'action', {
  resource: 'sales.order'
  templateId: string
  ids: string[]
  requestNonce: string
}, PrintJob>('platform/printing/actions:startPrint')
const getJobRef = makeFunctionReference<'query', { id: string }, PrintJob>(
  'platform/printing/jobs:getJob',
)
const printResultRef = makeFunctionReference<'action', { jobId: string }, Download>(
  'platform/printing/actions:printResultUrl',
)

const PRINT_PERMISSIONS = [
  'sales.order:read',
  'sales.order:print',
  'sales.order:export',
  'sales.order:batch_print',
] as const

function safePort(name: string, fallback: number): string {
  const value = process.env[name] ?? String(fallback)
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error(`${name} 必须是 1024..65535 的端口`)
  }
  return String(port)
}

function invariant(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

function client(url: string): ConvexHttpClient {
  return new ConvexHttpClient(url, {
    skipConvexDeploymentUrlCheck: true,
    logger: false,
  })
}

function endpoint(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`
}

function cookieHeader(headers: Headers): string {
  const extended = headers as Headers & { getSetCookie?: () => string[] }
  const values = extended.getSetCookie?.() ??
    (headers.get('set-cookie') ? [headers.get('set-cookie')!] : [])
  return values
    .map((value) => value.split(';', 1)[0])
    .filter(Boolean)
    .join('; ')
}

function authHeaders(authBaseUrl: string, siteOrigin: string): Record<string, string> {
  if (new URL(authBaseUrl).origin === siteOrigin) return { origin: siteOrigin }
  const publicUrl = new URL(siteOrigin)
  return {
    origin: siteOrigin,
    'x-better-auth-forwarded-host': publicUrl.host,
    'x-better-auth-forwarded-proto': publicUrl.protocol.replace(':', ''),
  }
}

async function signIn(input: {
  authBaseUrl: string
  siteOrigin: string
  convexUrl: string
  username: string
  password: string
}): Promise<ConvexHttpClient> {
  const headers = authHeaders(input.authBaseUrl, input.siteOrigin)
  const response = await fetch(endpoint(input.authBaseUrl, 'sign-in/username'), {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      username: input.username,
      password: input.password,
      rememberMe: false,
    }),
    redirect: 'manual',
  })
  invariant(response.ok, `打印烟测登录失败：HTTP ${response.status}`)
  const cookie = cookieHeader(response.headers)
  invariant(cookie, '打印烟测登录未返回 session cookie')
  const tokenResponse = await fetch(endpoint(input.authBaseUrl, 'convex/token'), {
    headers: { ...headers, cookie },
    redirect: 'manual',
  })
  invariant(tokenResponse.ok, `打印烟测 JWT 获取失败：HTTP ${tokenResponse.status}`)
  const body = await tokenResponse.json() as { token?: unknown }
  invariant(typeof body.token === 'string' && body.token.length > 0, '打印烟测 JWT 缺失')
  const result = client(input.convexUrl)
  result.setAuth(body.token)
  return result
}

async function expectRejected(runRejected: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await runRejected()
  } catch {
    return
  }
  throw new Error(`${label} 未被服务端拒绝`)
}

function templateWorkbook(): Uint8Array {
  const fixture = new Uint8Array(
    readFileSync(join(root, 'web/e2e/fixtures/matrix_template.xlsx')),
  )
  const parts = unzipParts(fixture)
  parts.set(
    'xl/worksheets/sheet1.xml',
    textToBytes(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
      `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<dimension ref="A1:B3"/><sheetData>` +
      `<row r="1"><c r="A1" t="inlineStr"><is><t>订单 \${order_no}</t></is></c>` +
      `<c r="B1" t="inlineStr"><is><t>公司 \${company.name}</t></is></c></row>` +
      `<row r="2"><c r="A2" t="inlineStr"><is><t>\${items._seq}</t></is></c>` +
      `<c r="B2" t="inlineStr"><is><t>\${items.material_name}</t></is></c></row>` +
      `<row r="3"><c r="A3" t="inlineStr"><is><t>合计 \${gross_total}</t></is></c></row>` +
      `</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" ` +
      `header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="portrait"/>` +
      `</worksheet>`,
    ),
  )
  return zipParts(parts)
}

async function uploadTemplate(admin: ConvexHttpClient, bytes: Uint8Array): Promise<GenericRow> {
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const intent = await admin.mutation(fileIntentRef, {
    filename: '销售订单闭环模板.xlsx',
    contentType: XLSX_CONTENT_TYPE,
    size: bytes.byteLength,
    sha256,
  })
  const signed = await admin.action(fileSignRef, { intentId: intent.id })
  invariant(!signed.finalized && signed.url, '模板上传未返回签名 URL')
  const response = await fetch(signed.url, {
    method: 'PUT',
    headers: signed.headers,
    body: bytes,
  })
  invariant(response.ok, `模板直传 MinIO 失败：HTTP ${response.status}`)
  return (await admin.action(fileFinalizeRef, { intentId: intent.id })).file
}

function verifyXlsx(bytes: Uint8Array, values: readonly string[], label: string): void {
  invariant(bytes[0] === 0x50 && bytes[1] === 0x4b, `${label} 不是 xlsx ZIP`)
  const text = [...unzipParts(bytes).values()].map(bytesToText).join('\n')
  for (const value of values) invariant(text.includes(value), `${label} 缺少渲染值 ${value}`)
  invariant(!text.includes('${'), `${label} 仍含未填充占位符`)
}

async function download(url: string, label: string): Promise<Uint8Array> {
  const response = await fetch(url)
  invariant(response.ok, `${label} 下载失败：HTTP ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

async function waitForJob(user: ConvexHttpClient, id: string): Promise<PrintJob> {
  const deadline = Date.now() + 180_000
  let latest: PrintJob | null = null
  while (Date.now() < deadline) {
    latest = await user.query(getJobRef, { id })
    if (latest.status === 'succeeded') return latest
    if (latest.status === 'failed' || latest.status === 'expired') {
      throw new Error(`打印任务终止：${latest.status}/${latest.errorCode ?? 'unknown'}`)
    }
    await Bun.sleep(500)
  }
  throw new Error(
    `打印任务超时：${latest?.status ?? 'unknown'}/${latest?.errorCode ?? 'unknown'}`,
  )
}

function s3Client(endpointUrl: string, accessKeyId: string, secretAccessKey: string): S3Client {
  return new S3Client({
    endpoint: endpointUrl,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  })
}

async function printObjectCount(s3: S3Client): Promise<number> {
  const response = await s3.send(new ListObjectsV2Command({
    Bucket: PRODUCT_BUCKET,
    Prefix: 'print-tmp/',
  }))
  return response.Contents?.length ?? 0
}

function redactDiagnostic(value: string): string {
  return value
    .replaceAll(/https?:\/\/\S+/gi, '<url>')
    .replaceAll(/(authorization|token|secret|password|admin[_-]?key)\s*[:=]\s*\S+/gi, '$1=<redacted>')
    .replaceAll(/\b[a-z0-9]{28,64}\b/gi, '<id>')
    .slice(0, 4_000)
}

function printFailureLogs(output: string): void {
  const diagnostics: string[] = []
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue
    try {
      const event = JSON.parse(line) as {
        identifier?: unknown
        udfType?: unknown
        error?: unknown
        logLines?: unknown
      }
      const identifier = typeof event.identifier === 'string' ? event.identifier : 'unknown'
      const isPrinting = identifier.startsWith('platform/printing/')
      if (typeof event.error === 'string') {
        diagnostics.push(
          `${String(event.udfType ?? 'Function')} ${identifier}: ${redactDiagnostic(event.error)}`,
        )
      }
      if (isPrinting && Array.isArray(event.logLines)) {
        for (const rawLog of event.logLines) {
          if (!rawLog || typeof rawLog !== 'object') continue
          const messages = (rawLog as { messages?: unknown }).messages
          if (!Array.isArray(messages)) continue
          diagnostics.push(
            `${String(event.udfType ?? 'Function')} ${identifier}: ${redactDiagnostic(messages.map(String).join(' '))}`,
          )
        }
      }
    } catch {
      // Ignore non-JSON CLI notices. Never print an unparsed line because it may contain credentials.
    }
  }
  if (diagnostics.length === 0) {
    log('失败前的 Convex 历史中没有可公开的 printing/error 诊断')
    return
  }
  console.error('[synie:convex] Convex 安全诊断:\n' + diagnostics.slice(-30).join('\n'))
}

async function main() {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10)
  const project = process.env.SYNIE_PRINTING_SMOKE_PROJECT?.trim() ||
    `synie-plan007-printing-${suffix}`
  if (!/^[a-z0-9][a-z0-9_-]{5,80}$/.test(project)) {
    throw new Error('SYNIE_PRINTING_SMOKE_PROJECT 不是安全的 Compose project name')
  }
  if (process.env.SYNIE_PRINTING_SMOKE_SKIP_BUILD !== '1' &&
      !process.env.HEROUI_AUTH_TOKEN?.trim()) {
    throw new Error(
      '构建 production Web 镜像需要 HEROUI_AUTH_TOKEN；或仅在已提供 SYNIE_WEB_IMAGE 时设置 SYNIE_PRINTING_SMOKE_SKIP_BUILD=1',
    )
  }

  const convexPort = safePort('SYNIE_PRINTING_SMOKE_CONVEX_PORT', 38_210)
  const sitePort = safePort('SYNIE_PRINTING_SMOKE_SITE_PORT', 38_211)
  const webPort = safePort('SYNIE_PRINTING_SMOKE_WEB_PORT', 38_300)
  const minioPort = safePort('SYNIE_PRINTING_SMOKE_MINIO_PORT', 38_200)
  const webOrigin = `http://127.0.0.1:${webPort}`
  const convexUrl = `http://127.0.0.1:${convexPort}`
  const convexSiteUrl = `http://127.0.0.1:${sitePort}`
  const minioUrl = `http://127.0.0.1:${minioPort}`
  const workerSecret = `${crypto.randomUUID()}${crypto.randomUUID()}`
  const accessKeyId = 'synie-local'
  const secretAccessKey = 'synie-local-development-only'
  const image = process.env.SYNIE_WEB_IMAGE?.trim() || `synie-web-print:${suffix}`
  const env = composeEnv({
    COMPOSE_PROJECT_NAME: project,
    SYNIE_POSTGRES_PORT: safePort('SYNIE_PRINTING_SMOKE_LEGACY_POSTGRES_PORT', 38_441),
    CONVEX_POSTGRES_PORT: safePort('SYNIE_PRINTING_SMOKE_CONVEX_POSTGRES_PORT', 38_442),
    MINIO_API_PORT: minioPort,
    MINIO_CONSOLE_PORT: safePort('SYNIE_PRINTING_SMOKE_MINIO_CONSOLE_PORT', 38_201),
    CONVEX_PORT: convexPort,
    CONVEX_SITE_PORT: sitePort,
    CONVEX_DASHBOARD_PORT: safePort('SYNIE_PRINTING_SMOKE_DASHBOARD_PORT', 38_791),
    WEB_PORT: webPort,
    VITE_CONVEX_URL: convexUrl,
    VITE_CONVEX_SITE_URL: convexSiteUrl,
    VITE_SITE_URL: webOrigin,
    CONVEX_CLOUD_ORIGIN: convexUrl,
    CONVEX_SITE_ORIGIN: 'http://convex-backend:3211',
    SYNIE_CONVEX_PUBLIC_SITE_URL: convexSiteUrl,
    SYNIE_PRODUCT_FILES_CORS_ORIGIN: webOrigin,
    CONVEX_REDACT_LOGS_TO_CLIENT: 'false',
    PRINT_WORKER_URL: 'http://web:3000',
    PRINT_WORKER_HMAC_SECRET: workerSecret,
    PRINT_WORKER_ALLOWED_HOSTS: 'minio',
    SYNIE_WEB_IMAGE: image,
  })
  let started = false
  let tempDirectory: string | undefined
  let deploymentEnv: NodeJS.ProcessEnv | undefined
  let verificationStage = 'bootstrap'
  let s3: S3Client | undefined
  let contractReport: Awaited<ReturnType<typeof verifyPrintWorkerContract>> | undefined

  try {
    if (process.env.SYNIE_PRINTING_SMOKE_SKIP_BUILD !== '1') {
      log(`构建 production Web/LibreOffice 镜像 ${image}`)
      await runCompose(['build', 'web'], { env })
    }
    log(`启动隔离打印烟测栈 ${project}（先不启动 Web Worker）`)
    await runCompose([
      'up', '-d', 'convex-postgres', 'minio', 'minio-public', 'minio-init',
      'convex-backend', 'convex-dashboard',
    ], { env })
    started = true
    await checkInfra({ includeLegacyPostgres: false, env })

    const keyResult = await runCompose(
      ['exec', '-T', 'convex-backend', './generate_admin_key.sh'],
      { env, capture: true, sensitiveOutput: true },
    )
    const adminKey = keyResult.stdout.trim().split(/\r?\n/).at(-1)?.trim()
    invariant(adminKey && adminKey.length >= 32 && !/\s/.test(adminKey), '无法解析 deployment admin key')

    tempDirectory = mkdtempSync(join(tmpdir(), 'synie-convex-printing-'))
    const envFile = join(tempDirectory, 'deployment.env')
    const betterAuthSecret = `${crypto.randomUUID()}${crypto.randomUUID()}`
    writeFileSync(envFile, [
      `SITE_URL=${webOrigin}`,
      `BETTER_AUTH_SECRET=${betterAuthSecret}`,
      'SYNIE_S3_INTERNAL_ENDPOINT=http://minio:9000',
      `SYNIE_S3_PUBLIC_ENDPOINT=${minioUrl}`,
      'SYNIE_S3_REGION=us-east-1',
      `SYNIE_S3_ACCESS_KEY_ID=${accessKeyId}`,
      `SYNIE_S3_SECRET_ACCESS_KEY=${secretAccessKey}`,
      `SYNIE_PRODUCT_FILES_BUCKET=${PRODUCT_BUCKET}`,
      'PRINT_WORKER_URL=http://web:3000',
      `PRINT_WORKER_HMAC_SECRET=${workerSecret}`,
      '',
    ].join('\n'), { mode: 0o600 })
    chmodSync(envFile, 0o600)

    deploymentEnv = {
      ...env,
      CONVEX_SELF_HOSTED_PROJECT: project,
      CONVEX_SELF_HOSTED_URL: convexUrl,
      CONVEX_SELF_HOSTED_SITE_URL: convexSiteUrl,
      CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey,
    }
    await run(['bunx', 'convex', 'env', 'set', '--force', '--from-file', envFile], {
      cwd: root,
      env: deploymentEnv,
      sensitiveOutput: true,
    })
    await run(['bunx', 'convex', 'dev', '--once', '--typecheck-components'], {
      cwd: root,
      env: deploymentEnv,
    })

    const username = '打印闭环管理员'
    const password = 'Convex-printing-E2E-only-password'
    const unauthenticated = client(convexUrl)
    await unauthenticated.mutation(createFirstUserRef, {
      username,
      password,
      name: '打印闭环管理员',
    })
    const authBaseUrl = endpoint(convexSiteUrl, 'api/auth')
    const admin = await signIn({ authBaseUrl, siteOrigin: webOrigin, convexUrl, username, password })

    const currency = await admin.mutation(currencyCreateRef, {
      name: '打印闭环人民币', isoCode: 'PRT', symbol: '¥', active: true,
    })
    const unit = await admin.mutation(unitCreateRef, {
      unitType: 'QUANTITY', isBase: true, name: '打印闭环件', symbol: '件', ratio: '1',
    })
    const company = await admin.mutation(companyCreateRef, {
      code: 'PT', name: '打印闭环公司', shortName: '打印公司', baseCurrencyId: currency.id,
    })
    const customer = await admin.mutation(customerCreateRef, {
      code: 'PRT-CUSTOMER', name: '打印闭环客户', shortName: '打印客户',
    })
    const category = await admin.mutation(categoryCreateRef, {
      code: 'PRT-CATEGORY', name: '打印闭环分类', isLeaf: true,
    })
    const material = await admin.mutation(materialCreateRef, {
      code: 'PRT-MATERIAL', name: '打印闭环物料', categoryId: category.id,
      defaultUnitId: unit.id,
    })
    const today = new Date().toISOString().slice(0, 10)
    const createOrder = () => admin.mutation(draftCreateRef, {
      resource: 'salOrders',
      input: {
        companyId: company.id, orderDate: today, orderType: 'REGULAR',
        partyType: 'CUSTOMER', partyId: customer.id, currencyId: currency.id,
        exchangeRate: '1', terms: 'self-hosted printing', remarks: null,
        items: [{
          idx: 1, qty: '2', materialId: material.id, unitId: unit.id,
          price: '12.50', taxRate: '0.13', remarks: null, quotationItemId: null,
          issueLines: [], byproductLines: [],
        }],
      },
    })
    const firstOrder = await createOrder()
    const secondOrder = await createOrder()
    const orderNumbers = [String(firstOrder.orderNo), String(secondOrder.orderNo)]
    invariant(orderNumbers.every(Boolean) && orderNumbers[0] !== orderNumbers[1], '销售订单 fixture 编号异常')

    const file = await uploadTemplate(admin, templateWorkbook())
    const template = await admin.action(templateCreateRef, {
      name: '销售订单闭环模板', resource: 'sales.order', fileId: file.id,
      remarks: 'Plan 007 isolated smoke',
    })
    await admin.mutation(templateDefaultRef, { id: template.id, value: true })

    const role = await admin.mutation(roleCreateRef, {
      code: 'PRINTING_SMOKE', name: '打印闭环角色',
    })
    await admin.mutation(roleSyncRef, { id: role.id, permissions: [...PRINT_PERMISSIONS] })
    const limited = await admin.mutation(userCreateRef, {
      username: '打印闭环操作员', name: '打印闭环操作员', roleIds: [role.id],
      companyIds: [company.id],
    })
    const observer = await admin.mutation(userCreateRef, {
      username: '打印闭环旁观者', name: '打印闭环旁观者', roleIds: [role.id],
      companyIds: [company.id],
    })
    const operator = await signIn({
      authBaseUrl, siteOrigin: webOrigin, convexUrl,
      username: limited.user.username, password: limited.password,
    })
    const otherUser = await signIn({
      authBaseUrl, siteOrigin: webOrigin, convexUrl,
      username: observer.user.username, password: observer.password,
    })
    const usable = await operator.query(templateUsableRef, { resource: 'sales.order' })
    invariant(usable.length === 1 && usable[0]?.isDefault === true, '业务用户未读取到默认打印模板')

    // Web/LibreOffice has not started: export must remain fully operational.
    s3 = s3Client(minioUrl, accessKeyId, secretAccessKey)
    const exportStarted = performance.now()
    verificationStage = 'worker-down-single-export'
    const singleExport = await operator.action(exportRef, {
      resource: 'sales.order', templateId: template.id, ids: [firstOrder.id],
      requestNonce: 'worker-down-single-export',
    })
    verifyXlsx(
      await download(singleExport.url, 'Worker 停机单条导出'),
      [orderNumbers[0]!, '打印闭环物料', '打印闭环公司'],
      'Worker 停机单条导出',
    )
    verificationStage = 'worker-down-batch-export'
    const batchExport = await operator.action(exportRef, {
      resource: 'sales.order', templateId: template.id,
      ids: [firstOrder.id, secondOrder.id], requestNonce: 'worker-down-batch-export',
    })
    verifyXlsx(
      await download(batchExport.url, 'Worker 停机批量导出'),
      [...orderNumbers, '打印闭环物料'],
      'Worker 停机批量导出',
    )
    const beforeExportReplay = await printObjectCount(s3)
    const replayedExport = await operator.action(exportRef, {
      resource: 'sales.order', templateId: template.id,
      ids: [firstOrder.id, secondOrder.id], requestNonce: 'worker-down-batch-export',
    })
    invariant(replayedExport.artifactId === batchExport.artifactId, '导出 requestNonce 未复用 artifact')
    invariant(await printObjectCount(s3) === beforeExportReplay, '导出重放产生额外临时对象')
    await expectRejected(() => operator.action(exportRef, {
      resource: 'sales.order', templateId: template.id,
      ids: Array.from({ length: 101 }, (_, index) => `too-many-${index}`),
      requestNonce: '101-rejected-before-template-download',
    }), '101 条导出')
    await expectRejected(() => operator.action(startPrintRef, {
      resource: 'sales.order', templateId: template.id,
      ids: Array.from({ length: 101 }, (_, index) => `too-many-${index}`),
      requestNonce: '101-print-rejected-before-template-download',
    }), '101 条打印')
    const exportDurationMs = performance.now() - exportStarted
    log('Worker 完全不可用时，单条/批量 xlsx 导出与幂等重放通过')

    verificationStage = 'production-worker-startup'
    await runCompose(['up', '-d', '--no-build', 'web'], { env })
    await waitForHttp(
      'production Web Worker readiness',
      `${webOrigin}/api/internal/print-worker/v1/health`,
      150,
    )
    verificationStage = 'implementation-neutral-worker-contract'
    contractReport = await verifyPrintWorkerContract({
      workerBaseUrl: webOrigin,
      workerSecret,
      s3IoEndpoint: minioUrl,
      s3SignedEndpoint: 'http://minio:9000',
      region: 'us-east-1',
      accessKeyId,
      secretAccessKey,
      bucket: PRODUCT_BUCKET,
      fixturePath: join(root, 'web/e2e/fixtures/matrix_template.xlsx'),
    })
    const ssr = await fetch(`${webOrigin}/scm/sales-orders/orders`, { redirect: 'manual' })
    invariant(ssr.status >= 200 && ssr.status < 400, `production SSR 失败：HTTP ${ssr.status}`)
    const loginHtml = await (await fetch(`${webOrigin}/login`)).text()
    const assetPath = loginHtml.match(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/)?.[1]
    invariant(assetPath, 'production SSR 未引用浏览器静态资源')
    const asset = await fetch(`${webOrigin}${assetPath}`, { redirect: 'manual' })
    invariant(asset.status === 200, `production 静态资源失败：HTTP ${asset.status}`)
    invariant(
      (asset.headers.get('content-type') ?? '').match(/javascript|text\/css/),
      'production 静态资源 Content-Type 异常',
    )

    const singleStarted = performance.now()
    verificationStage = 'single-print'
    const singleJob = await operator.action(startPrintRef, {
      resource: 'sales.order', templateId: template.id, ids: [firstOrder.id],
      requestNonce: 'single-print',
    })
    const completedSingle = await waitForJob(operator, singleJob.id)
    invariant(completedSingle.hasOutput && completedSingle.attempts >= 1, '单条打印未生成输出')
    const singlePdf = await download(
      (await operator.action(printResultRef, { jobId: singleJob.id })).url,
      '单条 PDF',
    )
    invariant(bytesToText(singlePdf.slice(0, 5)) === '%PDF-', '单条打印结果不是 PDF')
    const singleDurationMs = performance.now() - singleStarted

    const batchStarted = performance.now()
    verificationStage = 'batch-print'
    const batchJob = await operator.action(startPrintRef, {
      resource: 'sales.order', templateId: template.id,
      ids: [firstOrder.id, secondOrder.id], requestNonce: 'batch-print',
    })
    const completedBatch = await waitForJob(operator, batchJob.id)
    invariant(completedBatch.hasOutput && completedBatch.attempts >= 1, '批量打印未生成输出')
    const batchPdf = await download(
      (await operator.action(printResultRef, { jobId: batchJob.id })).url,
      '批量 PDF',
    )
    invariant(bytesToText(batchPdf.slice(0, 5)) === '%PDF-', '批量打印结果不是 PDF')
    const batchDurationMs = performance.now() - batchStarted
    verificationStage = 'hundred-record-fixtures'
    const hundredOrderIds = await preparePrintBaseline([firstOrder, secondOrder], createOrder)
    const hundredStarted = performance.now()
    verificationStage = 'hundred-record-print'
    const hundredJob = await operator.action(startPrintRef, {
      resource: 'sales.order', templateId: template.id,
      ids: hundredOrderIds,
      requestNonce: 'hundred-record-print-baseline',
    })
    const completedHundred = await waitForJob(operator, hundredJob.id)
    invariant(completedHundred.hasOutput && completedHundred.attempts >= 1, '100 条打印未生成输出')
    const hundredPdf = await download(
      (await operator.action(printResultRef, { jobId: hundredJob.id })).url,
      '100 条 PDF',
    )
    invariant(bytesToText(hundredPdf.slice(0, 5)) === '%PDF-', '100 条打印结果不是 PDF')
    const hundredDurationMs = performance.now() - hundredStarted
    const beforePrintReplay = await printObjectCount(s3)
    const replayedJob = await operator.action(startPrintRef, {
      resource: 'sales.order', templateId: template.id,
      ids: [firstOrder.id, secondOrder.id], requestNonce: 'batch-print',
    })
    invariant(replayedJob.id === batchJob.id, '打印 requestNonce 未复用 job')
    invariant(await printObjectCount(s3) === beforePrintReplay, '打印重放产生额外临时对象')
    await expectRejected(() => otherUser.query(getJobRef, { id: batchJob.id }), '跨用户查询打印任务')
    await expectRejected(
      () => otherUser.action(printResultRef, { jobId: batchJob.id }),
      '跨用户获取 PDF URL',
    )

    const playwrightEnv: NodeJS.ProcessEnv = {
      ...deploymentEnv,
      E2E_BASE_URL: webOrigin,
      E2E_CONVEX_USERNAME: limited.user.username,
      E2E_CONVEX_PASSWORD: limited.password,
      E2E_PRINT_ORDER_NO: orderNumbers[0],
      E2E_PRINT_TEMPLATE_NAME: String(template.name),
    }
    verificationStage = 'production-browser'
    await run([
      'bunx', 'playwright', 'test', '--config=convex-printing.playwright.config.ts',
    ], { cwd: join(root, 'web'), env: playwrightEnv })

    await admin.mutation(roleSyncRef, { id: role.id, permissions: [] })
    await expectRejected(
      () => operator.action(printResultRef, { jobId: batchJob.id }),
      '权限撤销后获取 PDF URL',
    )
    await expectRejected(
      () => operator.query(getJobRef, { id: batchJob.id }),
      '权限撤销后查询打印任务',
    )
    const report = {
      project,
      image,
      checks: [
        'worker-down-single-batch-export',
        'single-batch-real-libreoffice-pdf',
        'hundred-record-real-libreoffice-baseline',
        'artifact-job-idempotency',
        'cross-user-and-revoked-permission-denial',
        'production-ssr-and-browser-no-rest-no-internal-worker',
        'implementation-neutral-worker-contract',
      ],
      durationsMs: {
        workerDownExports: Math.round(exportDurationMs),
        singlePrint: Math.round(singleDurationMs),
        batchPrint: Math.round(batchDurationMs),
        hundredRecordPrint: Math.round(hundredDurationMs),
      },
      bytes: {
        singlePdf: singlePdf.byteLength,
        batchPdf: batchPdf.byteLength,
        hundredRecordPdf: hundredPdf.byteLength,
      },
      workerContract: contractReport,
    }
    console.log(JSON.stringify(report, null, 2))
    log('Plan 007 self-hosted printing smoke 通过')
  } catch (error) {
    log(`打印烟测失败阶段：${verificationStage}`)
    if (deploymentEnv) {
      const result = await run([
        'timeout', '6s', 'bunx', 'convex', 'logs', '--history', '500', '--jsonl',
      ], {
        cwd: root,
        env: deploymentEnv,
        capture: true,
        allowFailure: true,
        sensitiveOutput: true,
      })
      printFailureLogs(result.stdout)
    }
    throw error
  } finally {
    s3?.destroy()
    if (tempDirectory) rmSync(tempDirectory, { recursive: true, force: true })
    if (started) {
      await runCompose(['stop'], { env, allowFailure: true })
      log(`已停止 ${project}；卷保留，未执行 down -v`)
    }
  }
}

main().catch((error) => {
  console.error('[synie:convex] 打印烟测失败:', error instanceof Error ? error.message : error)
  process.exit(1)
})
