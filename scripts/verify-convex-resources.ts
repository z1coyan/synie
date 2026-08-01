import { chmodSync, writeFileSync } from 'node:fs'
import { textToBytes, zipParts } from '@synie/shared'
import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'

type ResourcePage<T> = {
  results: T[]
  pageInfo: { continueCursor: string | null; isDone: boolean }
}
type Currency = { id: string; name: string; isoCode: string; symbol: string | null; active: boolean }
type Unit = { id: string; unitType: string; isBase: boolean; name: string; symbol: string; ratio: string }
type Warehouse = { id: string; name: string; companyId: string; parentId: string | null; isLeaf: boolean }
type WarehouseSupportOption = { id: string; name: string; code?: string }
type Fixture = { companyId: string; accountId: string; supplierId: string }
type GenericRow = Record<string, unknown> & { id: string }
let verificationStage = 'bootstrap'

const prepareRef = makeFunctionReference<'mutation', {
  spikeSecret: string; adminUsername: string; companyCode: string
}, Fixture>('resources/probe:prepare')
const seedFaultRef = makeFunctionReference<'mutation', {
  spikeSecret: string; adminUsername: string; companyId: string; fault: 'after_root' | 'after_first_leaf'
}, null>('resources/probe:seedWithFault')
const inspectCompanyRef = makeFunctionReference<'query', {
  spikeSecret: string; companyId: string
}, { warehouseCount: number; auditCount: number }>('resources/probe:inspectCompany')
const addReferenceRef = makeFunctionReference<'mutation', {
  spikeSecret: string
  targetResource: 'basCurrencies' | 'basUnits' | 'invWarehouses'
  targetId: string
  sourceLabel: string
}, string>('resources/probe:addReference')
const runFileMaintenanceRef = makeFunctionReference<'action', { spikeSecret: string }, {
  cleanup: Record<string, unknown> | null
  reconciliation: {
    missingObjectKeys?: string[]
    orphanObjectKeys?: string[]
    checksumMismatchFileIds?: string[]
  } | null
}>('resources/ioProbe:runFileMaintenance')

const currencyListRef = makeFunctionReference<'query', {
  profile: 'default' | 'lookup' | 'search'; numItems: number; cursor?: string | null
  search?: string; args?: { active?: boolean }
}, ResourcePage<Currency>>('resources/currencies:list')
const currencyGetRef = makeFunctionReference<'query', { id: string }, Currency | null>('resources/currencies:get')
const currencyCreateRef = makeFunctionReference<'mutation', {
  name: string; isoCode: string; symbol?: string | null; active?: boolean
}, Currency>('resources/currencies:create')
const currencyUpdateRef = makeFunctionReference<'mutation', {
  id: string; name?: string; symbol?: string | null; active?: boolean
}, Currency>('resources/currencies:update')
const currencyRemoveRef = makeFunctionReference<'mutation', { id: string }, null>('resources/currencies:remove')

const unitListRef = makeFunctionReference<'query', {
  profile: 'default' | 'lookup' | 'search'; numItems: number; cursor?: string | null
  search?: string; args?: { unitType?: 'LENGTH' | 'AREA' | 'WEIGHT' | 'QUANTITY' }
}, ResourcePage<Unit>>('resources/units:list')
const unitGetRef = makeFunctionReference<'query', { id: string }, Unit | null>('resources/units:get')
const unitCreateRef = makeFunctionReference<'mutation', {
  unitType: 'LENGTH' | 'AREA' | 'WEIGHT' | 'QUANTITY'; isBase?: boolean
  name: string; symbol: string; ratio: string
}, Unit>('resources/units:create')
const unitUpdateRef = makeFunctionReference<'mutation', {
  id: string; name?: string; symbol?: string; ratio?: string
}, Unit>('resources/units:update')
const unitRemoveRef = makeFunctionReference<'mutation', { id: string }, null>('resources/units:remove')

const warehouseListRef = makeFunctionReference<'query', {
  profile: 'default' | 'lookup' | 'treeChildren' | 'search'; numItems: number
  cursor?: string | null; search?: string
  args: { companyId: string; parentId?: string | null }
}, ResourcePage<Warehouse>>('resources/warehouses:list')
const warehouseCreateRef = makeFunctionReference<'mutation', {
  name: string; companyId: string; parentId?: string | null; accountId?: string | null
  isLeaf?: boolean; active?: boolean; isOutsourced?: boolean
  partyType?: 'SUPPLIER' | 'COMPANY'; partyId?: string | null; allowNegative?: boolean
}, Warehouse>('resources/warehouses:create')
const warehouseRemoveRef = makeFunctionReference<'mutation', { id: string }, null>('resources/warehouses:remove')
const warehouseSeedRef = makeFunctionReference<'mutation', { companyId: string }, number>('resources/warehouses:seedDefaults')
const warehouseSupportOptionsRef = makeFunctionReference<'query', {
  kind: 'companies' | 'accounts' | 'suppliers' | 'parents'
  numItems: number
  cursor?: string | null
  companyId?: string
}, ResourcePage<WarehouseSupportOption>>('resources/warehouses:supportOptions')

const catalogRef = makeFunctionReference<'query', { resource: 'basCurrencies' | 'basUnits' | 'invWarehouses' }, {
  capabilities: string[]; commands: Array<{ key: string }>
}>('catalog/get:get')
const createRoleRef = makeFunctionReference<'mutation', { code: string; name: string }, { id: string }>('iam/roles:create')
const syncPermissionsRef = makeFunctionReference<'mutation', { id: string; permissions: string[] }, string[]>('iam/roles:syncPermissions')
const createUserRef = makeFunctionReference<'mutation', {
  username: string; name?: string | null; roleIds?: string[]; companyIds?: string[]
}, { user: { id: string; username: string }; password: string }>('iam/users:create')

const companyCreateRef = makeFunctionReference<'mutation', { code: string; name: string; shortName: string; baseCurrencyId: string }, GenericRow>('domains/base/companies:create')
const companyListRef = makeFunctionReference<'query', { profile: 'default' | 'search'; numItems: number; cursor?: string | null; search?: string }, ResourcePage<GenericRow>>('domains/base/companies:list')
const companyGetRef = makeFunctionReference<'query', { id: string }, GenericRow | null>('domains/base/companies:get')
const accountInitRef = makeFunctionReference<'mutation', { companyId: string; template: string }, { createdCount: number }>('domains/base/accounts:initializeTemplate')
const accountListRef = makeFunctionReference<'query', { profile: 'default' | 'treeChildren' | 'search'; numItems: number; cursor?: string | null; companyId: string; parentId?: string | null; search?: string }, ResourcePage<GenericRow>>('domains/base/accounts:list')
const customerCreateRef = makeFunctionReference<'mutation', { code: string; name: string; shortName?: string | null }, GenericRow>('domains/party/parties:createCustomer')
const supplierCreateRef = makeFunctionReference<'mutation', { code: string; name: string; shortName?: string | null }, GenericRow>('domains/party/parties:createSupplier')
const employeeCreateRef = makeFunctionReference<'mutation', { code: string; name: string; attendanceNo?: string | null; dailyWage?: string | null; monthlyAllowance?: string | null; insuranceTypes?: string[] }, GenericRow>('domains/party/parties:createEmployee')
const categoryCreateRef = makeFunctionReference<'mutation', { code: string; name: string; isLeaf?: boolean }, GenericRow>('domains/inventory/master:createCategory')
const materialCreateRef = makeFunctionReference<'mutation', { code: string; name: string; categoryId: string; defaultUnitId: string; customerId?: string | null; isCustomerMaterial?: boolean }, GenericRow>('domains/inventory/master:createMaterial')
const materialRemoveRef = makeFunctionReference<'mutation', { id: string }, null>('domains/inventory/master:removeMaterial')
const materialUnitCreateRef = makeFunctionReference<'mutation', { materialId: string; unitId: string; factor: string }, GenericRow>('domains/inventory/master:createMaterialUnit')
const fileCreateIntentRef = makeFunctionReference<'mutation', {
  filename: string; contentType: string; size: number; sha256: string
  ownerType?: string; ownerId?: string; category?: string
}, { id: string; expiresAt: number }>('files/domain:createUploadIntent')
const fileSignUploadRef = makeFunctionReference<'action', { intentId: string }, {
  finalized: boolean; url?: string; headers?: Record<string, string>
}>('files/actions:signUpload')
const fileFinalizeRef = makeFunctionReference<'action', { intentId: string }, {
  file: GenericRow; attachment: GenericRow | null
}>('files/actions:finalizeUpload')
const fileAttachRef = makeFunctionReference<'mutation', {
  fileId: string; ownerType: string; ownerId: string; category?: string
}, GenericRow>('files/domain:attach')
const fileDownloadRef = makeFunctionReference<'action', { fileId: string }, { url: string }>('files/actions:downloadUrl')
const fileRemoveRef = makeFunctionReference<'action', { fileId: string }, null>('files/actions:removeFile')
const fileListAttachmentsRef = makeFunctionReference<'query', {
  ownerType: string; ownerId: string; category?: string
}, { count: number; results: GenericRow[] }>('files/domain:listAttachments')
const fileListByFileRef = makeFunctionReference<'query', { fileId: string }, { count: number; results: GenericRow[] }>('files/domain:listFileAttachments')
const fileRemoveAttachmentRef = makeFunctionReference<'mutation', { id: string }, null>('files/domain:removeAttachment')
const fileGetRef = makeFunctionReference<'query', { id: string }, GenericRow | null>('files/domain:getFile')
const salesSettingsListRef = makeFunctionReference<'query', { numItems: number; cursor?: string | null }, ResourcePage<GenericRow>>('domains/platform/settings:listSales')
const salesSettingsUpdateRef = makeFunctionReference<'mutation', { id: string; sampleItemMaxQty?: number; deliveryOvershipRatio?: string }, GenericRow>('domains/platform/settings:updateSales')
const numberingRuleListRef = makeFunctionReference<'query', { numItems: number; cursor?: string | null }, ResourcePage<GenericRow>>('domains/platform/numbering:listRules')
const auditListRef = makeFunctionReference<'query', {
  numItems: number
  cursor?: string | null
  companyId?: string | null
  resource?: string
  recordId?: string
}, ResourcePage<GenericRow>>('domains/platform/resources:listAudit')
const draftCreateRef = makeFunctionReference<'mutation', { resource: string; input: unknown }, GenericRow>('domains/trading/drafts:createDraft')
const draftReplaceRef = makeFunctionReference<'mutation', { resource: string; id: string; input: unknown }, GenericRow>('domains/trading/drafts:replaceDraft')
const draftLoadRef = makeFunctionReference<'query', { resource: string; id: string }, GenericRow>('domains/trading/drafts:loadDraft')
const domainCommandRef = makeFunctionReference<'mutation', { resource: string; id: string; key: string; input?: unknown }, GenericRow>('domains/commands:execute')
const inventoryDocumentListRef = makeFunctionReference<'query', { resource: string; numItems: number; cursor?: string | null; queryArgs?: Record<string, unknown> }, ResourcePage<GenericRow>>('domains/inventory/documents:list')
const accountingDocumentListRef = makeFunctionReference<'query', { resource: string; numItems: number; cursor?: string | null; queryArgs?: Record<string, unknown> }, ResourcePage<GenericRow>>('domains/accounting/documents:list')
const orderDocumentListRef = makeFunctionReference<'query', { resource: string; numItems: number; cursor?: string | null; queryArgs?: Record<string, unknown> }, ResourcePage<GenericRow>>('domains/trading/orders:list')
const financeDocumentGetRef = makeFunctionReference<'query', { resource: string; id: string }, GenericRow | null>('domains/finance/documents:get')
const financeDocumentListRef = makeFunctionReference<'query', {
  resource: string; numItems: number; cursor?: string | null; search?: string
  queryArgs?: Record<string, unknown>
}, ResourcePage<GenericRow>>('domains/finance/documents:list')
const financeDocumentCreateRef = makeFunctionReference<'mutation', { resource: string; input: unknown }, GenericRow>('domains/finance/documents:create')
const financeDocumentUpdateRef = makeFunctionReference<'mutation', { resource: string; id: string; input: unknown }, GenericRow>('domains/finance/documents:update')
const financeDocumentRemoveRef = makeFunctionReference<'mutation', { resource: string; id: string }, null>('domains/finance/documents:remove')
const bankRemainingRef = makeFunctionReference<'query', { bankTransactionId: string; journalId: string }, { amount: string }>('domains/finance/banking:remaining')
const bankQuickCreateRef = makeFunctionReference<'mutation', {
  bankTransactionId: string; counterAccountId: string; amount: string; summary?: string | null; postingDate: string
}, GenericRow>('domains/finance/banking:quickCreate')
const bankImportCreateRef = makeFunctionReference<'action', {
  companyId: string; bankAccountId: string; templateId: string; fileId: string
}, GenericRow>('domains/finance/bankImportActions:create')
const bankImportCommitRef = makeFunctionReference<'action', { importId: string }, GenericRow>('domains/finance/bankImportActions:commit')
const bankImportRemoveRef = makeFunctionReference<'action', { importId: string }, null>('domains/finance/bankImportActions:remove')
const ocrConfiguredRef = makeFunctionReference<'action', {}, { configured: boolean }>('domains/finance/ocrActions:configured')
const hrDomainCreateRef = makeFunctionReference<'mutation', { resource: string; input: unknown }, GenericRow>('domains/hr/domain:create')
const hrDomainGetRef = makeFunctionReference<'query', { resource: string; id: string }, GenericRow | null>('domains/hr/domain:get')
const hrDomainListRef = makeFunctionReference<'query', {
  resource: string; numItems: number; cursor?: string | null; search?: string; queryArgs?: Record<string, unknown>
}, ResourcePage<GenericRow>>('domains/hr/domain:list')
const hrDomainRemoveRef = makeFunctionReference<'mutation', { resource: string; id: string }, null>('domains/hr/domain:remove')
const attendanceImportCreateRef = makeFunctionReference<'action', { fileId: string }, GenericRow>('domains/hr/attendanceImportActions:create')
const attendanceImportCommitRef = makeFunctionReference<'action', {
  importId: string; autoCreateEmployees: boolean
}, GenericRow>('domains/hr/attendanceImportActions:commit')
const attendanceImportRemoveRef = makeFunctionReference<'action', { importId: string }, null>('domains/hr/attendanceImportActions:remove')
const attendancePunchListRef = makeFunctionReference<'query', {
  numItems: number; cursor?: string | null; importId?: string
}, ResourcePage<GenericRow>>('domains/hr/attendanceImport:listPunches')
const payrollPayRemainingRef = makeFunctionReference<'mutation', {
  payrollId: string; paidOn: string; remarks?: string
}, GenericRow>('domains/hr/payroll:payRemaining')
const payrollLoanBalancesRef = makeFunctionReference<'query', {}, Array<{
  employeeId: string; borrowed: string; repaid: string; balance: string
}>>('domains/hr/payroll:loanBalances')
const payrollMonthStatsRef = makeFunctionReference<'query', { month: string }, {
  count: number; pendingCount: number; payableTotal: string; paidTotal: string
}>('domains/hr/payroll:monthStats')
const manufacturingDraftCreateRef = makeFunctionReference<'mutation', {
  resource: string; input: unknown
}, GenericRow>('domains/manufacturing/drafts:createDraft')
const manufacturingDraftLoadRef = makeFunctionReference<'query', {
  resource: string; id: string
}, GenericRow>('domains/manufacturing/drafts:loadDraft')
const manufacturingDraftRemoveRef = makeFunctionReference<'mutation', {
  resource: string; id: string
}, null>('domains/manufacturing/drafts:removeDraft')
const manufacturingDomainGetRef = makeFunctionReference<'query', {
  resource: string; id: string
}, GenericRow | null>('domains/manufacturing/domain:get')
const manufacturingArrangeManualRef = makeFunctionReference<'mutation', {
  demandItemId: string; arrangementType: 'STOCK' | 'CLOSE'; qty: string; remarks?: string | null
}, { id: string; baseQty: string }>('domains/manufacturing/drafts:arrangeManual')
const manufacturingRemoveArrangementRef = makeFunctionReference<'mutation', { id: string }, null>('domains/manufacturing/drafts:removeArrangement')
const manufacturingArrangementsRef = makeFunctionReference<'query', { demandItemId: string }, GenericRow[]>('domains/manufacturing/drafts:arrangements')
const manufacturingApplyBomRef = makeFunctionReference<'mutation', { id: string; bomId: string | null }, GenericRow>('domains/manufacturing/drafts:applyBom')
const manufacturingCreateInlineBomRef = makeFunctionReference<'mutation', { id: string; input: unknown }, {
  workOrder: GenericRow; bom: GenericRow
}>('domains/manufacturing/drafts:createInlineBom')
const manufacturingSalesCandidatesRef = makeFunctionReference<'query', { companyId: string }, GenericRow[]>('domains/manufacturing/drafts:salesItemCandidates')
const reconciliationDraftCreateRef = makeFunctionReference<'mutation', {
  resource: string; input: unknown
}, GenericRow>('domains/trading/reconciliationDrafts:createDraft')
const marketCreateRef = makeFunctionReference<'mutation', {
  resource: string; input: unknown
}, GenericRow>('domains/market/domain:create')
const marketChartRef = makeFunctionReference<'query', {}, GenericRow[]>('domains/market/domain:chartInstruments')
const marketSeriesRef = makeFunctionReference<'query', {
  instrumentIds: string[]; priceKind: string; from: string; to: string
}, { priceKind: string; series: Array<GenericRow & { points: Array<{ observedAt: string; price: string }> }> }>('domains/market/domain:priceSeries')
const marketRefreshRef = makeFunctionReference<'action', {
  instrumentId?: string | null
}, { items?: unknown[]; summary?: string }>('domains/market/actions:refresh')
const retiredStorageCatalogRef = makeFunctionReference<'query', { resource: string }, unknown>('catalog/get:get')
const todoListRef = makeFunctionReference<'query', {
  tab: 'active' | 'history' | 'recent'; includeDismissed?: boolean
  numItems: number; cursor?: string | null
}, { count: number; results: GenericRow[]; pageInfo: { continueCursor: string | null; isDone: boolean } }>('domains/todo/domain:list')
const todoUnreadRef = makeFunctionReference<'query', {}, { count: number }>('domains/todo/domain:unreadCount')
const todoDismissRef = makeFunctionReference<'mutation', { id: string }, GenericRow>('domains/todo/domain:dismiss')

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`缺少环境变量 ${name}`)
  return value
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function client(url: string): ConvexHttpClient {
  return new ConvexHttpClient(url, { skipConvexDeploymentUrlCheck: true, logger: false })
}

function endpoint(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`
}

function utcToday(): string {
  return new Date().toISOString().slice(0, 10)
}

function cookieHeader(headers: Headers): string {
  const extended = headers as Headers & { getSetCookie?: () => string[] }
  const values = extended.getSetCookie?.() ?? (headers.get('set-cookie') ? [headers.get('set-cookie')!] : [])
  return values.map((value) => value.split(';', 1)[0]).filter(Boolean).join('; ')
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
  authBaseUrl: string; siteOrigin: string; convexUrl: string; username: string; password: string
}): Promise<ConvexHttpClient> {
  const headers = authHeaders(input.authBaseUrl, input.siteOrigin)
  const response = await fetch(endpoint(input.authBaseUrl, 'sign-in/username'), {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ username: input.username, password: input.password, rememberMe: false }),
    redirect: 'manual',
  })
  invariant(response.ok, `资源烟测登录失败：HTTP ${response.status}`)
  const cookie = cookieHeader(response.headers)
  invariant(cookie, '资源烟测登录未返回 session cookie')
  const tokenResponse = await fetch(endpoint(input.authBaseUrl, 'convex/token'), {
    headers: { ...headers, cookie }, redirect: 'manual',
  })
  invariant(tokenResponse.ok, `资源烟测 JWT 获取失败：HTTP ${tokenResponse.status}`)
  const body = await tokenResponse.json() as { token?: unknown }
  invariant(typeof body.token === 'string' && body.token.length > 0, '资源烟测 JWT 缺失')
  const result = client(input.convexUrl)
  result.setAuth(body.token)
  return result
}

async function expectRejected(run: () => Promise<unknown>, label: string): Promise<void> {
  let rejected = false
  try {
    await run()
  } catch {
    rejected = true
  }
  invariant(rejected, `${label} 未被服务端拒绝`)
}

async function collectAll<T>(load: (cursor: string | null) => Promise<ResourcePage<T>>): Promise<T[]> {
  const rows: T[] = []
  const seen = new Set<string>()
  let cursor: string | null = null
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const page = await load(cursor)
    rows.push(...page.results)
    if (page.pageInfo.isDone) {
      invariant(page.pageInfo.continueCursor === null, '完成页仍返回 continueCursor')
      return rows
    }
    const next = page.pageInfo.continueCursor
    invariant(next && !seen.has(next), 'cursor 缺失或重复')
    seen.add(next)
    cursor = next
  }
  throw new Error('cursor 分页超过安全页数')
}

async function uploadProductFile(
  admin: ConvexHttpClient,
  bytes: Uint8Array,
  filename: string,
  contentType: string,
  attachment?: { ownerType: string; ownerId: string; category: string },
): Promise<GenericRow> {
  const sha256 = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex')
  const intent = await admin.mutation(fileCreateIntentRef, {
    filename, contentType, size: bytes.byteLength, sha256,
    ...attachment,
  })
  const signed = await admin.action(fileSignUploadRef, { intentId: intent.id })
  invariant(!signed.finalized && signed.url, `${filename} 未返回签名上传 URL`)
  const response = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body: bytes })
  invariant(response.ok, `${filename} 直传 S3 失败：HTTP ${response.status}`)
  return (await admin.action(fileFinalizeRef, { intentId: intent.id })).file
}

function inlineCell(reference: string, value: string): string {
  const escaped = value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
  return `<c r="${reference}" t="inlineStr"><is><t>${escaped}</t></is></c>`
}

function bankWorkbook(rows: Array<[date: string, amount: string, summary: string]>): Uint8Array {
  const header = `<row r="1">${inlineCell('A1', '日期')}${inlineCell('B1', '金额')}${inlineCell('C1', '摘要')}</row>`
  const body = rows.map(([date, amount, summary], index) => {
    const row = index + 2
    return `<row r="${row}">${inlineCell(`A${row}`, date)}${inlineCell(`B${row}`, amount)}${inlineCell(`C${row}`, summary)}</row>`
  }).join('')
  return zipParts(new Map([
    ['[Content_Types].xml', textToBytes('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')],
    ['xl/workbook.xml', textToBytes('<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="流水" sheetId="1" r:id="rId1"/></sheets></workbook>')],
    ['xl/_rels/workbook.xml.rels', textToBytes('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')],
    ['xl/worksheets/sheet1.xml', textToBytes(`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${header}${body}</sheetData></worksheet>`)],
  ]))
}

async function main() {
  const convexUrl = requiredEnv('CONVEX_SELF_HOSTED_URL')
  const convexSiteUrl = requiredEnv('CONVEX_SELF_HOSTED_SITE_URL')
  const spikeSecret = requiredEnv('SYNIE_RESOURCE_SPIKE_SECRET')
  const username = requiredEnv('E2E_CONVEX_USERNAME')
  const password = requiredEnv('E2E_CONVEX_PASSWORD')
  const resultFile = requiredEnv('SYNIE_RESOURCE_RESULT_FILE')
  const siteOrigin = requiredEnv('E2E_BASE_URL').replace(/\/$/, '')
  const authBaseUrl = endpoint(convexSiteUrl, 'api/auth')
  const marker = crypto.randomUUID().replaceAll('-', '').slice(0, 12)
  const probe = client(convexUrl)
  const admin = await signIn({ authBaseUrl, siteOrigin, convexUrl, username, password })

  const first = await probe.mutation(prepareRef, {
    spikeSecret, adminUsername: username, companyCode: `A${marker.slice(0, 7)}`.toUpperCase(),
  })
  const second = await probe.mutation(prepareRef, {
    spikeSecret, adminUsername: username, companyCode: `B${marker.slice(0, 7)}`.toUpperCase(),
  })

  for (const fault of ['after_root', 'after_first_leaf'] as const) {
    await expectRejected(
      () => probe.mutation(seedFaultRef, {
        spikeSecret, adminUsername: username, companyId: first.companyId, fault,
      }),
      `三仓 seed ${fault} 故障注入`,
    )
    const afterFault = await probe.query(inspectCompanyRef, { spikeSecret, companyId: first.companyId })
    invariant(afterFault.warehouseCount === 0 && afterFault.auditCount === 0, `${fault} 留下半状态`)
  }
  invariant(await admin.mutation(warehouseSeedRef, { companyId: first.companyId }) === 3, '首次三仓 seed 数量不正确')
  invariant(await admin.mutation(warehouseSeedRef, { companyId: first.companyId }) === 0, '三仓 seed 不幂等')
  const seeded = await probe.query(inspectCompanyRef, { spikeSecret, companyId: first.companyId })
  invariant(seeded.warehouseCount === 3 && seeded.auditCount === 3, '三仓 seed/audit 闭包不完整')

  const raceCode = 'RAC'
  const raced = await Promise.allSettled(Array.from({ length: 20 }, () =>
    admin.mutation(currencyCreateRef, { name: `并发币种-${marker}`, isoCode: raceCode }),
  ))
  invariant(raced.filter((item) => item.status === 'fulfilled').length === 1, '20 并发 ISO create 未保持唯一性')

  const paginationCodes = ['CAA', 'CAB', 'CAC', 'CAX', 'CAE']
  for (const code of paginationCodes) {
    await admin.mutation(currencyCreateRef, { name: `游标币种-${marker}-${code}`, isoCode: code })
  }
  const currencies = await collectAll((cursor) => admin.query(currencyListRef, {
    profile: 'default', numItems: 2, cursor,
  }))
  invariant(new Set(currencies.map((row) => row.id)).size === currencies.length, '币种 cursor 分页重复记录')
  invariant(paginationCodes.every((code) => currencies.some((row) => row.isoCode === code)), '币种 cursor 分页漏记录')
  const currencySearch = await admin.query(currencyListRef, {
    profile: 'search', numItems: 20, search: 'CAA',
  })
  invariant(currencySearch.results.length === 1 && currencySearch.results[0].isoCode === 'CAA', '币种 search profile 结果不正确')
  await expectRejected(() => admin.query(currencyListRef, {
    profile: 'default', numItems: 20, search: '非法组合',
  }), '币种非法 query profile')

  const editableCurrency = await admin.mutation(currencyCreateRef, {
    name: `可编辑币种-${marker}`, isoCode: 'EDT', symbol: 'e',
  })
  const updatedCurrency = await admin.mutation(currencyUpdateRef, {
    id: editableCurrency.id, name: `已编辑币种-${marker}`, symbol: null,
  })
  invariant((await admin.query(currencyGetRef, { id: editableCurrency.id }))?.name === updatedCurrency.name, '币种 get/update 不一致')
  await admin.mutation(currencyRemoveRef, { id: editableCurrency.id })
  invariant(await admin.query(currencyGetRef, { id: editableCurrency.id }) === null, '币种 delete 后仍可读取')
  const referencedCurrency = await admin.mutation(currencyCreateRef, { name: `被引用币种-${marker}`, isoCode: 'REF' })
  await probe.mutation(addReferenceRef, { spikeSecret, targetResource: 'basCurrencies', targetId: referencedCurrency.id, sourceLabel: 'resource-smoke' })
  await expectRejected(() => admin.mutation(currencyRemoveRef, { id: referencedCurrency.id }), '被引用币种删除')

  const baseUnit = await admin.mutation(unitCreateRef, {
    unitType: 'WEIGHT', isBase: true, name: `千克-${marker}`, symbol: `kg-${marker}`, ratio: '1.000000',
  })
  await expectRejected(() => admin.mutation(unitCreateRef, {
    unitType: 'WEIGHT', isBase: true, name: `另一基准-${marker}`, symbol: `base-${marker}`, ratio: '1',
  }), '同类型重复基准单位')
  const childUnit = await admin.mutation(unitCreateRef, {
    unitType: 'WEIGHT', name: `克-${marker}`, symbol: `g-${marker}`, ratio: '0.0010004',
  })
  invariant(childUnit.ratio === '0.001', '单位定标 int64/half-up wire 不一致')
  await admin.mutation(unitUpdateRef, { id: childUnit.id, name: `公克-${marker}`, ratio: '0.001' })
  invariant((await admin.query(unitGetRef, { id: childUnit.id }))?.ratio === '0.001', '单位 get/update decimal 不一致')
  const unitLookup = await admin.query(unitListRef, {
    profile: 'lookup', numItems: 20, args: { unitType: 'WEIGHT' },
  })
  invariant(unitLookup.results.some((row) => row.id === baseUnit.id) && unitLookup.results.some((row) => row.id === childUnit.id), '单位 lookup profile 漏记录')
  await probe.mutation(addReferenceRef, { spikeSecret, targetResource: 'basUnits', targetId: childUnit.id, sourceLabel: 'resource-smoke' })
  await expectRejected(() => admin.mutation(unitRemoveRef, { id: childUnit.id }), '被引用单位删除')

  const roots = await admin.query(warehouseListRef, {
    profile: 'treeChildren', numItems: 10, args: { companyId: first.companyId, parentId: null },
  })
  invariant(roots.results.length === 1 && !roots.results[0].isLeaf, '三仓根节点不正确')
  const leaves = await admin.query(warehouseListRef, {
    profile: 'treeChildren', numItems: 10, args: { companyId: first.companyId, parentId: roots.results[0].id },
  })
  invariant(leaves.results.length === 2 && leaves.results.every((row) => row.isLeaf), '三仓叶子节点不正确')
  await expectRejected(() => admin.mutation(warehouseCreateRef, {
    name: `跨公司父节点-${marker}`, companyId: second.companyId, parentId: roots.results[0].id,
  }), '仓库跨公司父节点')
  await expectRejected(() => admin.mutation(warehouseCreateRef, {
    name: `跨公司科目-${marker}`, companyId: second.companyId, accountId: first.accountId,
  }), '仓库跨公司科目')
  const protectedWarehouse = await admin.mutation(warehouseCreateRef, {
    name: `受保护仓库-${marker}`, companyId: first.companyId,
  })
  await probe.mutation(addReferenceRef, { spikeSecret, targetResource: 'invWarehouses', targetId: protectedWarehouse.id, sourceLabel: 'stock-entry' })
  await expectRejected(() => admin.mutation(warehouseRemoveRef, { id: protectedWarehouse.id }), '有库存引用仓库删除')

  // Wave A: formal master/IAM/settings records, no Plan 003 isolation fixtures.
  const formalCurrency = await admin.mutation(currencyCreateRef, { name: `正式本位币-${marker}`, isoCode: 'FML', active: true })
  const formalCompany = await admin.mutation(companyCreateRef, {
    code: 'WA', name: `Wave A 公司-${marker}`, shortName: 'WaveA', baseCurrencyId: formalCurrency.id,
  })
  const formalCompany2 = await admin.mutation(companyCreateRef, {
    code: 'WB', name: `Wave B 范围对照公司-${marker}`, shortName: 'WaveB', baseCurrencyId: formalCurrency.id,
  })
  const formalWarehouses = await admin.query(warehouseListRef, {
    profile: 'default', numItems: 10, args: { companyId: formalCompany.id },
  })
  invariant(formalWarehouses.results.length === 3, '正式公司创建未原子 seed 三仓')
  const initialized = await admin.mutation(accountInitRef, { companyId: formalCompany.id, template: 'SMALL' })
  invariant(initialized.createdCount > 20, '正式科目模板创建数量异常')
  await expectRejected(() => admin.mutation(accountInitRef, { companyId: formalCompany.id, template: 'SMALL' }), '科目模板重复初始化')
  const accounts = await admin.query(accountListRef, { profile: 'default', numItems: 100, companyId: formalCompany.id })
  invariant(accounts.results.length > 20, '正式科目列表缺失')

  const customerRace = await Promise.allSettled(Array.from({ length: 20 }, () => admin.mutation(customerCreateRef, {
    code: `C-${marker}`, name: `并发客户-${marker}`,
  })))
  invariant(customerRace.filter(item => item.status === 'fulfilled').length === 1, 'Wave A 客户 20 并发唯一创建未收敛为一个')
  const customer = (customerRace.find(item => item.status === 'fulfilled') as PromiseFulfilledResult<GenericRow>).value
  const supplier = await admin.mutation(supplierCreateRef, { code: `S-${marker}`, name: `正式供应商-${marker}` })
  const employee = await admin.mutation(employeeCreateRef, { code: `E-${marker}`, name: `正式员工-${marker}`, attendanceNo: `ATT-${marker}`, dailyWage: '123.456', monthlyAllowance: '88.8', insuranceTypes: ['pension', 'pension'] })
  invariant(employee.dailyWage === '123.46' && Array.isArray(employee.insuranceTypes) && employee.insuranceTypes.length === 1, '员工 decimal/集合规范化不正确')
  const category = await admin.mutation(categoryCreateRef, { code: `CAT-${marker}`, name: `正式分类-${marker}`, isLeaf: true })
  const material = await admin.mutation(materialCreateRef, { code: `M-${marker}`, name: `正式物料-${marker}`, categoryId: category.id, defaultUnitId: baseUnit.id, customerId: customer.id, isCustomerMaterial: true })
  const conversion = await admin.mutation(materialUnitCreateRef, { materialId: material.id, unitId: childUnit.id, factor: '1000.0000004' })
  invariant(conversion.factor === '1000', '物料单位转换未使用 scale-6 int64')

  // Plan 006 product file: browser bytes go directly to the public S3 endpoint.
  verificationStage = 'product-file-s3-roundtrip'
  const fileBytes = new TextEncoder().encode(`Synie Convex product file ${marker}`)
  const fileDigest = Buffer.from(await crypto.subtle.digest('SHA-256', fileBytes)).toString('hex')
  await expectRejected(() => admin.mutation(fileCreateIntentRef, {
    filename: 'too-large.bin', contentType: 'application/octet-stream',
    size: 50 * 1024 * 1024 + 1, sha256: fileDigest,
  }), '50MB+1 文件')
  await expectRejected(() => admin.mutation(fileCreateIntentRef, {
    filename: 'unknown-owner.txt', contentType: 'text/plain', size: fileBytes.byteLength,
    sha256: fileDigest, ownerType: 'unknown_owner', ownerId: material.id,
  }), '未知附件宿主')
  const fileIntent = await admin.mutation(fileCreateIntentRef, {
    filename: `验收-${marker}.txt`, contentType: 'text/plain', size: fileBytes.byteLength,
    sha256: fileDigest, ownerType: 'inv_material', ownerId: material.id, category: 'smoke',
  })
  const signedUpload = await admin.action(fileSignUploadRef, { intentId: fileIntent.id })
  invariant(!signedUpload.finalized && signedUpload.url, '文件上传未返回短时签名 URL')
  const uploadResponse = await fetch(signedUpload.url, {
    method: 'PUT', headers: signedUpload.headers, body: fileBytes,
  })
  invariant(uploadResponse.ok, `浏览器直传 S3 失败：HTTP ${uploadResponse.status}`)
  const finalizedFile = await admin.action(fileFinalizeRef, { intentId: fileIntent.id })
  invariant(finalizedFile.file.sha256 === fileDigest && finalizedFile.attachment?.category === 'smoke', '文件 finalize 元数据/附件不完整')
  const repeatedFinalize = await admin.action(fileFinalizeRef, { intentId: fileIntent.id })
  invariant(repeatedFinalize.file.id === finalizedFile.file.id, '文件重复 finalize 未保持幂等')
  const ownerAttachments = await admin.query(fileListAttachmentsRef, {
    ownerType: 'inv_material', ownerId: material.id, category: 'smoke',
  })
  const fileAttachments = await admin.query(fileListByFileRef, { fileId: finalizedFile.file.id })
  invariant(ownerAttachments.count === 1 && fileAttachments.count === 1, '附件正查/反查不一致')
  const signedDownload = await admin.action(fileDownloadRef, { fileId: finalizedFile.file.id })
  const downloaded = new Uint8Array(await (await fetch(signedDownload.url)).arrayBuffer())
  invariant(Buffer.from(downloaded).equals(Buffer.from(fileBytes)), '短时下载 URL 返回 bytes 不一致')
  await expectRejected(() => admin.action(fileRemoveRef, { fileId: finalizedFile.file.id }), '删除仍被附件引用的文件')
  await admin.mutation(fileRemoveAttachmentRef, { id: finalizedFile.attachment!.id })
  await admin.action(fileRemoveRef, { fileId: finalizedFile.file.id })
  invariant(await admin.query(fileGetRef, { id: finalizedFile.file.id }) === null, '删除对象后文件元数据仍存在')
  const finalizedFileAudits = await admin.query(auditListRef, {
    numItems: 20, cursor: null, resource: 'sys_file', recordId: finalizedFile.file.id,
  })
  const finalizedAttachmentAudits = await admin.query(auditListRef, {
    numItems: 20, cursor: null, resource: 'sys_attachment', recordId: finalizedFile.attachment!.id,
  })
  invariant(
    ['create', 'destroy'].every((action) =>
      finalizedFileAudits.results.some((row) => row.actionType === action)),
    '文件 finalize/删除缺少 formal audit',
  )
  invariant(
    ['create', 'destroy'].every((action) =>
      finalizedAttachmentAudits.results.some((row) => row.actionType === action)),
    '附件 finalize/移除缺少 formal audit',
  )

  // A deleted owner must not strand its attachment and permanently lock the
  // underlying file. This also exercises the direct attach audit path.
  verificationStage = 'stale-owner-attachment-cleanup-audit'
  const disposableMaterial = await admin.mutation(materialCreateRef, {
    code: `MD-${marker}`, name: `待删宿主物料-${marker}`,
    categoryId: category.id, defaultUnitId: baseUnit.id,
  })
  const staleFile = await uploadProductFile(
    admin, fileBytes, `失效宿主-${marker}.txt`, 'text/plain',
  )
  const staleAttachment = await admin.mutation(fileAttachRef, {
    fileId: staleFile.id, ownerType: 'inv_material',
    ownerId: disposableMaterial.id, category: 'stale-owner',
  })
  await admin.mutation(materialRemoveRef, { id: disposableMaterial.id })
  const staleWitnesses = await admin.query(fileListByFileRef, { fileId: staleFile.id })
  invariant(
    staleWitnesses.results.some((row) => row.id === staleAttachment.id),
    '宿主删除后文件管理员无法枚举失效挂接',
  )
  await admin.mutation(fileRemoveAttachmentRef, { id: staleAttachment.id })
  await admin.action(fileRemoveRef, { fileId: staleFile.id })
  invariant(await admin.query(fileGetRef, { id: staleFile.id }) === null, '失效挂接清理后文件仍无法删除')
  const directAttachmentAudits = await admin.query(auditListRef, {
    numItems: 20, cursor: null, resource: 'sys_attachment', recordId: staleAttachment.id,
  })
  invariant(
    ['create', 'destroy'].every((action) =>
      directAttachmentAudits.results.some((row) => row.actionType === action)),
    '直接挂接/失效宿主清理缺少 formal audit',
  )

  // Keep one material drawing through the standard trading/manufacturing waves
  // so every document-line snapshot seam is verified against real S3 metadata.
  const drawingBytes = Uint8Array.from(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ))
  const drawingDigest = Buffer.from(await crypto.subtle.digest('SHA-256', drawingBytes)).toString('hex')
  const drawingIntent = await admin.mutation(fileCreateIntentRef, {
    filename: `图纸-${marker}.png`, contentType: 'image/png', size: drawingBytes.byteLength,
    sha256: drawingDigest, ownerType: 'inv_material', ownerId: material.id, category: 'drawing',
  })
  const signedDrawingUpload = await admin.action(fileSignUploadRef, { intentId: drawingIntent.id })
  invariant(!signedDrawingUpload.finalized && signedDrawingUpload.url, '物料图纸未返回短时签名上传 URL')
  const drawingUploadResponse = await fetch(signedDrawingUpload.url, {
    method: 'PUT', headers: signedDrawingUpload.headers, body: drawingBytes,
  })
  invariant(drawingUploadResponse.ok, `物料图纸直传 S3 失败：HTTP ${drawingUploadResponse.status}`)
  const drawingFile = await admin.action(fileFinalizeRef, { intentId: drawingIntent.id })
  invariant(drawingFile.attachment?.category === 'drawing', '物料图纸挂接未落到 drawing 槽位')

  // Waves B/C: all six AggregateDraft seams and posting effects share one mutation.
  verificationStage = 'wave-bc-fixtures'
  const leafAccounts = accounts.results.filter(row => row.isGroup === false && row.active !== false)
  invariant(leafAccounts.length >= 2, '会计/履约测试缺少两个可过账叶子科目')
  const postingWarehouse = await admin.mutation(warehouseCreateRef, {
    name: `允许负库存验收仓-${marker}`, companyId: formalCompany.id, allowNegative: true,
  })
  const today = utcToday()
  verificationStage = 'sales-quotation-create'
  const salesQuotation = await admin.mutation(draftCreateRef, {
    resource: 'salQuotations',
    input: {
      companyId: formalCompany.id, quotationDate: today, validUntil: today,
      partyType: 'CUSTOMER', partyId: customer.id, currencyId: formalCurrency.id,
      terms: 'self-host', remarks: null,
      items: [{ idx: 1, materialId: material.id, unitId: baseUnit.id, pricingMode: 'FIXED', price: '12.3456', taxRate: '0.13', remarks: null, tiers: [] }],
    },
  })
  invariant(salesQuotation.status === 'DRAFT' && String(salesQuotation.quotationNo).length > 0, '销售报价草稿未自动编号/初始化状态')
  const salesQuotationItems = salesQuotation.items as GenericRow[]
  invariant(salesQuotationItems.length === 1 && (salesQuotationItems[0].tiers as unknown[]).length === 0, '销售报价完整草稿读取不正确')
  verificationStage = 'sales-quotation-replace'
  const replacedQuotation = await admin.mutation(draftReplaceRef, {
    resource: 'salQuotations', id: salesQuotation.id,
    input: {
      companyId: formalCompany.id, quotationNo: salesQuotation.quotationNo, quotationDate: today, validUntil: today,
      partyType: 'CUSTOMER', partyId: customer.id, currencyId: formalCurrency.id,
      terms: 'replaced', remarks: null,
      items: [{ id: salesQuotationItems[0].id, idx: 1, materialId: material.id, unitId: baseUnit.id, pricingMode: 'QTY_TIERED', price: null, taxRate: '0.13', remarks: null, tiers: [{ minQty: '1', price: '11.5' }] }],
    },
  })
  invariant(((replacedQuotation.items as GenericRow[])[0].tiers as unknown[]).length === 1, '报价完整替换没有原子保存价格档')
  await expectRejected(() => admin.mutation(draftReplaceRef, {
    resource: 'salQuotations', id: salesQuotation.id,
    input: { companyId: formalCompany.id },
  }), 'Aggregate Draft 缺 items fail-closed')
  verificationStage = 'sales-quotation-audit'
  await admin.mutation(domainCommandRef, { resource: 'salQuotations', id: salesQuotation.id, key: 'audit' })

  verificationStage = 'sales-order-create'
  const salesOrderInput = (itemId?: string) => ({
      companyId: formalCompany.id, orderDate: today, orderType: 'REGULAR',
      partyType: 'CUSTOMER', partyId: customer.id, currencyId: formalCurrency.id, exchangeRate: '1',
      terms: null, remarks: null,
      items: [{ ...(itemId ? { id: itemId } : {}), idx: 1, qty: '5', materialId: material.id, unitId: baseUnit.id, price: '12.3456', taxRate: '0.13', remarks: null, quotationItemId: salesQuotationItems[0].id, issueLines: [], byproductLines: [] }],
  })
  const salesOrder = await admin.mutation(draftCreateRef, {
    resource: 'salOrders', input: salesOrderInput(),
  })
  const createdSalesOrderItem = (salesOrder.items as GenericRow[])[0]!
  const refreshedDrawingFile = await uploadProductFile(
    admin,
    drawingBytes,
    `图纸更新-${marker}.png`,
    'image/png',
    { ownerType: 'inv_material', ownerId: material.id, category: 'drawing' },
  )
  const replacedSalesOrder = await admin.mutation(draftReplaceRef, {
    resource: 'salOrders', id: salesOrder.id, input: {
      ...salesOrderInput(createdSalesOrderItem.id),
      orderNo: salesOrder.orderNo,
    },
  })
  const salesOrderItem = (replacedSalesOrder.items as GenericRow[])[0]!
  const refreshedOrderDrawing = await admin.query(fileListByFileRef, { fileId: refreshedDrawingFile.id })
  invariant(
    refreshedOrderDrawing.results.some((row) => row.ownerType === 'sal_order_item' && row.ownerId === salesOrderItem.id),
    '销售订单条目 replace 未重拍物料 drawing 挂接',
  )
  verificationStage = 'sales-order-audit'
  await admin.mutation(domainCommandRef, { resource: 'salOrders', id: salesOrder.id, key: 'audit' })
  const indexedOrderItems = await admin.query(orderDocumentListRef, {
    resource: 'salOrderItems', numItems: 20,
    queryArgs: { parentId: salesOrder.id, sortField: 'idx', sortDirection: 'ascending' },
  })
  invariant(indexedOrderItems.results.length === 1 && indexedOrderItems.results[0].id === salesOrderItem.id, '订单行父范围/序号 query profile 漏记录')
  verificationStage = 'sales-delivery-create'
  const delivery = await admin.mutation(draftCreateRef, {
    resource: 'salDeliveries',
    input: {
      companyId: formalCompany.id, deliveryDate: today, postingDate: today,
      partyType: 'CUSTOMER', partyId: customer.id, warehouseId: postingWarehouse.id,
      debitAccountId: leafAccounts[0].id, creditAccountId: leafAccounts[1].id, remarks: null,
      items: [{ idx: 1, qty: '2', orderItemId: salesOrderItem.id, unitId: baseUnit.id, warehouseId: postingWarehouse.id, remarks: null }],
      packBoxes: [{ lines: [{ idx: 1, qty: '2', materialId: material.id, unitId: baseUnit.id, remarks: null }] }],
    },
  })
  invariant((delivery.packBoxes as Array<{ lines: unknown[] }>)[0].lines.length === 1, '销售发货装箱子树不完整')
  verificationStage = 'sales-delivery-audit'
  await admin.mutation(domainCommandRef, { resource: 'salDeliveries', id: delivery.id, key: 'audit' })
  const stockAfterDelivery = await admin.query(inventoryDocumentListRef, { resource: 'invStockEntries', numItems: 100, queryArgs: { companyId: formalCompany.id } })
  const sortedStockAfterDelivery = await admin.query(inventoryDocumentListRef, {
    resource: 'invStockEntries', numItems: 100,
    queryArgs: { companyId: formalCompany.id, sortField: 'postingDate', sortDirection: 'descending' },
  })
  const glAfterDelivery = await admin.query(accountingDocumentListRef, { resource: 'accGlEntries', numItems: 100, queryArgs: { companyId: formalCompany.id } })
  invariant(stockAfterDelivery.results.some(row => row.voucherId === delivery.id && row.quantity === '-2'), '销售发货未同 mutation 写库存事实投影')
  invariant(sortedStockAfterDelivery.results.some(row => row.voucherId === delivery.id && row.quantity === '-2'), '库存事实日期 query profile 漏记录')
  invariant(glAfterDelivery.results.filter(row => row.voucherId === delivery.id).length === 2, '销售发货未同 mutation 写平衡总账事实投影')
  verificationStage = 'sales-delivery-void'
  await admin.mutation(domainCommandRef, { resource: 'salDeliveries', id: delivery.id, key: 'void' })
  const voidedStock = await admin.query(inventoryDocumentListRef, { resource: 'invStockEntries', numItems: 100, queryArgs: { companyId: formalCompany.id } })
  invariant(voidedStock.results.some(row => row.voucherId === delivery.id && row.isCancelled === true), '发货作废未取消库存事实')

  verificationStage = 'purchase-quotation-create'
  const purchaseQuotation = await admin.mutation(draftCreateRef, {
    resource: 'purQuotations', input: {
      companyId: formalCompany.id, quotationDate: today, validUntil: today,
      partyType: 'SUPPLIER', partyId: supplier.id, currencyId: formalCurrency.id,
      items: [{ idx: 1, materialId: material.id, unitId: baseUnit.id, pricingMode: 'FIXED', price: '8.5', taxRate: '0.13', remarks: null, tiers: [] }],
    },
  })
  await admin.mutation(domainCommandRef, { resource: 'purQuotations', id: purchaseQuotation.id, key: 'audit' })
  verificationStage = 'purchase-order-create'
  const purchaseOrder = await admin.mutation(draftCreateRef, {
    resource: 'purOrders', input: {
      companyId: formalCompany.id, orderDate: today, orderType: 'REGULAR', isOutsourced: false,
      partyType: 'SUPPLIER', partyId: supplier.id, currencyId: formalCurrency.id, exchangeRate: '1',
      items: [{ idx: 1, qty: '3', materialId: material.id, unitId: baseUnit.id, price: '8.5', taxRate: '0.13', remarks: null, quotationItemId: (purchaseQuotation.items as GenericRow[])[0].id, bomId: null, demandLineId: null, demandDate: null, issueLines: [], byproductLines: [] }],
    },
  })
  await admin.mutation(domainCommandRef, { resource: 'purOrders', id: purchaseOrder.id, key: 'audit' })
  verificationStage = 'purchase-receipt-create'
  const receipt = await admin.mutation(draftCreateRef, {
    resource: 'purReceipts', input: {
      companyId: formalCompany.id, receiptDate: today, postingDate: today,
      partyType: 'SUPPLIER', partyId: supplier.id, warehouseId: postingWarehouse.id,
      debitAccountId: leafAccounts[0].id, creditAccountId: leafAccounts[1].id,
      items: [{ idx: 1, qty: '3', orderItemId: (purchaseOrder.items as GenericRow[])[0].id, unitId: baseUnit.id, warehouseId: postingWarehouse.id, remarks: null }],
    },
  })
  invariant((await admin.query(draftLoadRef, { resource: 'purReceipts', id: receipt.id })).items instanceof Array, '采购入库聚合 loadDraft 失败')
  verificationStage = 'purchase-receipt-audit'
  await admin.mutation(domainCommandRef, { resource: 'purReceipts', id: receipt.id, key: 'audit' })

  // Wave D banking: quick reconciliation owns journal audit, GL and both capacities in one mutation.
  verificationStage = 'banking-quick-reconciliation'
  const partyRoles = new Set(['unbilled_receivable', 'receivable', 'advance_received', 'unbilled_payable', 'payable', 'advance_paid', 'other_payable'])
  const bankingAccounts = leafAccounts.filter((row) => !partyRoles.has(String(row.role ?? '')))
  invariant(bankingAccounts.length >= 2, '银行快速对账缺少两个非往来叶子科目')
  const bankAccount = await admin.mutation(financeDocumentCreateRef, {
    resource: 'accBankAccounts',
    input: {
      alias: `验收银行-${marker}`, bankName: '验收银行', holderName: 'Synie', accountNo: `BA-${marker}`,
      active: true, companyId: formalCompany.id, currencyId: formalCurrency.id,
      accountId: bankingAccounts[0].id,
    },
  })
  const bankTransaction = await admin.mutation(financeDocumentCreateRef, {
    resource: 'accBankTransactions',
    input: {
      occurredAt: new Date().toISOString(), income: '100', expense: null, balance: '100',
      summary: '银行快速对账验收', companyId: formalCompany.id, bankAccountId: bankAccount.id,
    },
  })
  invariant(bankTransaction.reconciledAmount === '0' && bankTransaction.unreconciledAmount === '100', '银行流水初始对账投影不正确')
  const quickRecon = await admin.mutation(bankQuickCreateRef, {
    bankTransactionId: bankTransaction.id,
    counterAccountId: bankingAccounts[1].id,
    amount: '40',
    summary: '自动生成凭证',
    postingDate: today,
  })
  const reconciledTransaction = await admin.query(financeDocumentGetRef, { resource: 'accBankTransactions', id: bankTransaction.id })
  invariant(reconciledTransaction?.reconciledAmount === '40' && reconciledTransaction.unreconciledAmount === '60' && reconciledTransaction.reconcileStatus === 'PARTIAL', '快速对账未刷新银行流水容量')
  const quickJournal = await admin.query(accountingDocumentListRef, { resource: 'accGlJournals', numItems: 100, queryArgs: { companyId: formalCompany.id, status: 'AUDITED' } })
  invariant(quickJournal.results.some(row => row.id === quickRecon.journalId), '快速对账没有原子创建并审核会计凭证')
  invariant(Number((await admin.query(bankRemainingRef, { bankTransactionId: bankTransaction.id, journalId: String(quickRecon.journalId) })).amount) === 0, '已用尽快速凭证仍暴露可对账余额')
  await expectRejected(() => admin.mutation(financeDocumentUpdateRef, {
    resource: 'accBankTransactions', id: bankTransaction.id,
    input: { income: '39' },
  }), '银行流水金额低于已对账金额')
  await expectRejected(() => admin.mutation(domainCommandRef, {
    resource: 'accGlJournals', id: String(quickRecon.journalId), key: 'cancel',
  }), '已被银行对账引用的凭证取消')
  await admin.mutation(financeDocumentRemoveRef, { resource: 'accBankReconciliations', id: quickRecon.id })
  const releasedTransaction = await admin.query(financeDocumentGetRef, { resource: 'accBankTransactions', id: bankTransaction.id })
  invariant(releasedTransaction?.reconciledAmount === '0' && releasedTransaction.unreconciledAmount === '100' && releasedTransaction.reconcileStatus === 'UNRECONCILED', '解除对账未释放银行流水容量')

  // Plan 006 I/O: real S3-backed bank/attendance imports, generation visibility and env-only integrations.
  verificationStage = 'bank-import-s3-parse-commit'
  const bankTemplate = await admin.mutation(financeDocumentCreateRef, {
    resource: 'accBankImportTemplates',
    input: {
      name: `验收流水模板-${marker}`, startRow: 2,
      dateCol: 'A', dateFormat: 'YMD_DASH', amountCol: 'B', summaryCol: 'C',
      companyId: formalCompany.id, bankAccountId: bankAccount.id,
    },
  })
  const bankSummary = `S3流水-${marker}`
  const bankFile = await uploadProductFile(
    admin,
    bankWorkbook([[today, '25.67', bankSummary]]),
    `银行流水-${marker}.xlsx`,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  const bankImport = await admin.action(bankImportCreateRef, {
    companyId: formalCompany.id, bankAccountId: bankAccount.id,
    templateId: bankTemplate.id, fileId: bankFile.id,
  })
  invariant(bankImport.status === 'PARSED' && bankImport.itemCount === 1 && bankImport.errorCount === 0, '银行流水 action 未完成 S3 解析/staging')
  const bankTransactionsBeforeCommit = await admin.query(financeDocumentListRef, {
    resource: 'accBankTransactions', numItems: 100, queryArgs: { companyId: formalCompany.id },
  })
  invariant(!bankTransactionsBeforeCommit.results.some((row) => row.summary === bankSummary), '银行流水在 parent commit 前已对业务查询可见')
  const committedBankImport = await admin.action(bankImportCommitRef, { importId: bankImport.id })
  invariant(committedBankImport.status === 'IMPORTED', '银行流水提交未切换 parent 状态')
  const bankTransactionsAfterCommit = await admin.query(financeDocumentListRef, {
    resource: 'accBankTransactions', numItems: 100, queryArgs: { companyId: formalCompany.id },
  })
  invariant(bankTransactionsAfterCommit.results.some((row) => row.summary === bankSummary && row.income === '25.67'), '银行流水提交后未一次进入业务查询')

  const removableBankFile = await uploadProductFile(
    admin,
    bankWorkbook([[today, '1.01', `待删除流水-${marker}`]]),
    `待删除流水-${marker}.xlsx`,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  const removableBankImport = await admin.action(bankImportCreateRef, {
    companyId: formalCompany.id, bankAccountId: bankAccount.id,
    templateId: bankTemplate.id, fileId: removableBankFile.id,
  })
  await admin.action(bankImportRemoveRef, { importId: removableBankImport.id })
  invariant(await admin.query(financeDocumentGetRef, { resource: 'accBankImports', id: removableBankImport.id }) === null, '银行流水分块删除未清理 parent')

  verificationStage = 'attendance-import-generation-flip'
  const attendanceDate = today
  const attendanceBytes = new TextEncoder().encode(
    `${employee.attendanceNo} ${attendanceDate} 08:00:00\n${employee.attendanceNo} ${attendanceDate} 17:30:00\n`,
  )
  const attendanceFile = await uploadProductFile(
    admin, attendanceBytes, `考勤-${marker}.dat`, 'text/plain',
  )
  const attendanceImport = await admin.action(attendanceImportCreateRef, { fileId: attendanceFile.id })
  invariant(
    attendanceImport.status === 'PARSED' && attendanceImport.totalRows === 2 &&
      attendanceImport.matchedRows === 2 && attendanceImport.unmatchedRows === 0,
    '考勤 action 未完成 S3 解析/staging',
  )
  const punchesBeforeCommit = await admin.query(attendancePunchListRef, {
    importId: attendanceImport.id, numItems: 20, cursor: null,
  })
  invariant(punchesBeforeCommit.results.length === 0, '考勤 raw facts 在 parent/generation commit 前已可见')
  const committedAttendance = await admin.action(attendanceImportCommitRef, {
    importId: attendanceImport.id, autoCreateEmployees: false,
  })
  invariant(committedAttendance.status === 'IMPORTED' && committedAttendance.importedCount === 2, '考勤提交未完成 generation 对拍与切换')
  const punchesAfterCommit = await admin.query(attendancePunchListRef, {
    importId: attendanceImport.id, numItems: 20, cursor: null,
  })
  invariant(punchesAfterCommit.results.length === 2, '考勤 generation flip 后未一次看到完整打卡事实')
  const attendanceDaysAfterCommit = await admin.query(hrDomainListRef, {
    resource: 'hrAttendanceDays', numItems: 100, queryArgs: { sortField: 'date', sortDirection: 'ascending' },
  })
  invariant(attendanceDaysAfterCommit.results.some((row) => row.employeeId === employee.id && row.date === attendanceDate), '考勤 generation 未生成员工日投影')
  await admin.action(attendanceImportRemoveRef, { importId: attendanceImport.id })
  invariant((await admin.query(attendancePunchListRef, { importId: attendanceImport.id, numItems: 20, cursor: null })).results.length === 0, '删除考勤批次后仍可见打卡事实')
  const attendanceDaysAfterRemoval = await admin.query(hrDomainListRef, {
    resource: 'hrAttendanceDays', numItems: 100, queryArgs: { sortField: 'date', sortDirection: 'ascending' },
  })
  invariant(!attendanceDaysAfterRemoval.results.some((row) => row.employeeId === employee.id && row.date === attendanceDate), '删除考勤批次后日投影未回滚')

  // Finalize must re-authorize after direct S3 upload. A permission change in
  // this window rejects the metadata mutation and removes both staged/final
  // objects, which the reconciliation assertion below proves end to end.
  verificationStage = 'file-finalize-live-authorization-cleanup'
  const finalizeRole = await admin.mutation(createRoleRef, {
    code: `file-finalize-${marker}`,
    name: '文件确认时授权验收角色',
  })
  await admin.mutation(syncPermissionsRef, {
    id: finalizeRole.id,
    permissions: ['sys.file:create', 'inv.material:read'],
  })
  const finalizeUsername = `file-${marker}`
  const finalizeUser = await admin.mutation(createUserRef, {
    username: finalizeUsername,
    roleIds: [finalizeRole.id],
    companyIds: [formalCompany.id],
  })
  const finalizeClient = await signIn({
    authBaseUrl,
    siteOrigin,
    convexUrl,
    username: finalizeUsername,
    password: finalizeUser.password,
  })
  const rejectedIntent = await finalizeClient.mutation(fileCreateIntentRef, {
    filename: `授权变化-${marker}.txt`,
    contentType: 'text/plain',
    size: fileBytes.byteLength,
    sha256: fileDigest,
    ownerType: 'inv_material',
    ownerId: material.id,
    category: 'revoked-finalize',
  })
  const rejectedSignedUpload = await finalizeClient.action(fileSignUploadRef, {
    intentId: rejectedIntent.id,
  })
  invariant(!rejectedSignedUpload.finalized && rejectedSignedUpload.url, '授权变化验收未返回签名上传 URL')
  const rejectedUploadResponse = await fetch(rejectedSignedUpload.url, {
    method: 'PUT',
    headers: rejectedSignedUpload.headers,
    body: fileBytes,
  })
  invariant(rejectedUploadResponse.ok, `授权变化验收直传 S3 失败：HTTP ${rejectedUploadResponse.status}`)
  await admin.mutation(syncPermissionsRef, {
    id: finalizeRole.id,
    permissions: ['inv.material:read'],
  })
  await expectRejected(
    () => finalizeClient.action(fileFinalizeRef, { intentId: rejectedIntent.id }),
    '上传后撤销 sys.file:create 的 finalize',
  )
  await expectRejected(
    () => finalizeClient.action(fileFinalizeRef, { intentId: rejectedIntent.id }),
    '已业务拒绝的上传意图再次 finalize',
  )
  const rejectedAttachments = await admin.query(fileListAttachmentsRef, {
    ownerType: 'inv_material',
    ownerId: material.id,
    category: 'revoked-finalize',
  })
  invariant(rejectedAttachments.count === 0, '权限撤销后 finalize 仍创建了附件元数据')

  verificationStage = 'file-download-live-owner-authorization'
  await admin.mutation(syncPermissionsRef, {
    id: finalizeRole.id,
    permissions: ['sys.file:create', 'sys.file:read', 'inv.material:read'],
  })
  const uploaderAttachedFile = await uploadProductFile(
    finalizeClient,
    fileBytes,
    `上传者挂接-${marker}.txt`,
    'text/plain',
    { ownerType: 'inv_material', ownerId: material.id, category: 'uploader-scope' },
  )
  await admin.mutation(syncPermissionsRef, {
    id: finalizeRole.id,
    permissions: ['sys.file:read'],
  })
  await expectRejected(
    () => finalizeClient.action(fileDownloadRef, { fileId: uploaderAttachedFile.id }),
    '已挂接文件的上传者丢失宿主权限后下载',
  )
  const uploaderAttachmentRows = await admin.query(fileListByFileRef, {
    fileId: uploaderAttachedFile.id,
  })
  invariant(uploaderAttachmentRows.count === 1, '上传者授权验收文件缺少挂接')
  await admin.mutation(fileRemoveAttachmentRef, { id: uploaderAttachmentRows.results[0].id })
  await admin.action(fileRemoveRef, { fileId: uploaderAttachedFile.id })

  await admin.mutation(syncPermissionsRef, {
    id: finalizeRole.id,
    permissions: ['sys.file:create', 'sys.file:read'],
  })
  const otherUsersBareFile = await uploadProductFile(
    finalizeClient, fileBytes, `裸文件-${marker}.txt`, 'text/plain',
  )
  await admin.mutation(syncPermissionsRef, {
    id: finalizeRole.id,
    permissions: ['sys.file:read'],
  })
  const superAdminDownload = await admin.action(fileDownloadRef, {
    fileId: otherUsersBareFile.id,
  })
  const superAdminBytes = new Uint8Array(
    await (await fetch(superAdminDownload.url)).arrayBuffer(),
  )
  invariant(
    Buffer.from(superAdminBytes).equals(Buffer.from(fileBytes)),
    '超级管理员无法下载其他用户上传的无挂接文件',
  )
  await admin.action(fileRemoveRef, { fileId: otherUsersBareFile.id })

  verificationStage = 'io-env-cron-storage-maintenance'
  invariant((await admin.action(ocrConfiguredRef, {})).configured === false, '未配置 OCR deployment secret 时不应报告可用')
  const emptyMarketRefresh = await admin.action(marketRefreshRef, { instrumentId: null })
  invariant(Array.isArray(emptyMarketRefresh.items) && emptyMarketRefresh.items.length === 0, '禁用行情品种时手动刷新不应外呼')
  await expectRejected(() => admin.query(retiredStorageCatalogRef, { resource: 'sysStorages' }), 'Convex 模式已退役 sysStorages Catalog')
  const maintenance = await probe.action(runFileMaintenanceRef, { spikeSecret })
  invariant(
    maintenance.reconciliation?.missingObjectKeys?.length === 0 &&
      maintenance.reconciliation?.orphanObjectKeys?.length === 0 &&
      maintenance.reconciliation?.checksumMismatchFileIds?.length === 0,
    '产品 S3 inventory 与 Convex 文件元数据不一致',
  )

  // Wave E HR: payroll/payment/loan state and query projections move atomically.
  verificationStage = 'hr-payroll-payment-loan'
  await admin.mutation(hrDomainCreateRef, {
    resource: 'hrEmployeeLoans',
    input: {
      kind: 'BORROW', employeeId: employee.id, occurredOn: today,
      amount: '50', remarks: '工资抵扣验收借款',
    },
  })
  const payrollMonth = today.slice(0, 7)
  const payroll = await admin.mutation(hrDomainCreateRef, {
    resource: 'hrPayrolls',
    input: {
      employeeId: employee.id, month: payrollMonth,
      workdays: '2', attendanceDays: 2, missingDays: 0, overtimeHours: '0',
      dailyWage: '100', allowance: '0', bonus: '0', fine: '0',
      loanDeduction: '10', remarks: '工资发放闭环验收',
    },
  })
  invariant(payroll.status === 'PENDING' && Number(payroll.payable) === 190 && payroll.paidTotal === null, '工资单金额或初始状态不正确')
  await expectRejected(() => admin.mutation(hrDomainCreateRef, {
    resource: 'hrPayrolls',
    input: {
      employeeId: employee.id, month: payrollMonth,
      workdays: '1', attendanceDays: 1, missingDays: 0, overtimeHours: '0',
      dailyWage: '100', allowance: '0', bonus: '0', fine: '0', loanDeduction: '0',
    },
  }), '员工同月重复工资单')
  const payrollsForMonth = await admin.query(hrDomainListRef, {
    resource: 'hrPayrolls', numItems: 20, queryArgs: { month: payrollMonth },
  })
  invariant(payrollsForMonth.results.length === 1 && payrollsForMonth.results[0].id === payroll.id, '工资月份 equality query profile 漏记录')
  const payment = await admin.mutation(payrollPayRemainingRef, {
    payrollId: payroll.id, paidOn: today, remarks: '全额发放验收',
  })
  invariant(payment.kind === 'NORMAL' && Number(payment.amount) === 190, '工资全额发放记录不正确')
  const paidPayroll = await admin.query(hrDomainGetRef, { resource: 'hrPayrolls', id: payroll.id })
  invariant(paidPayroll?.status === 'PAID' && Number(paidPayroll.paidTotal) === 190, '工资发放没有原子更新工资单投影')
  const paidStats = await admin.query(payrollMonthStatsRef, { month: payrollMonth })
  invariant(paidStats.count === 1 && paidStats.pendingCount === 0 && Number(paidStats.payableTotal) === 190 && Number(paidStats.paidTotal) === 190, '工资月份统计未反映发放状态')
  const balancesAfterPayment = await admin.query(payrollLoanBalancesRef, {})
  const employeeBalanceAfterPayment = balancesAfterPayment.find((row) => row.employeeId === employee.id)
  invariant(employeeBalanceAfterPayment && Number(employeeBalanceAfterPayment.borrowed) === 50 && Number(employeeBalanceAfterPayment.repaid) === 10 && Number(employeeBalanceAfterPayment.balance) === 40, '工资借款抵扣没有创建联动归还记录')
  await admin.mutation(hrDomainRemoveRef, { resource: 'hrPayrollPayments', id: payment.id })
  const revertedPayroll = await admin.query(hrDomainGetRef, { resource: 'hrPayrolls', id: payroll.id })
  invariant(revertedPayroll?.status === 'PENDING' && revertedPayroll.paidTotal === null, '删除正常发放没有恢复工资单待发状态')
  const balancesAfterRemoval = await admin.query(payrollLoanBalancesRef, {})
  const employeeBalanceAfterRemoval = balancesAfterRemoval.find((row) => row.employeeId === employee.id)
  invariant(employeeBalanceAfterRemoval && Number(employeeBalanceAfterRemoval.borrowed) === 50 && Number(employeeBalanceAfterRemoval.repaid) === 0 && Number(employeeBalanceAfterRemoval.balance) === 50, '删除正常发放没有原子移除联动归还记录')

  // Wave E market: active-only uniqueness, void/re-record and indexed chart/series decisions.
  verificationStage = 'market-decision-indexes'
  const instrument = await admin.mutation(marketCreateRef, {
    resource: 'basMarketInstruments',
    input: {
      code: `MK-${marker}`, name: `行情品种-${marker}`, sourceType: 'EXCHANGE',
      defaultPriceKind: 'SETTLEMENT', currencyId: formalCurrency.id, unitId: baseUnit.id,
    },
  })
  invariant(instrument.active === true && instrument.fetchEnabled === false, '行情品种默认状态不正确')
  const observedAt = '2026-07-31T04:05:06.000Z'
  const marketPoint = await admin.mutation(marketCreateRef, {
    resource: 'basMarketPricePoints',
    input: { instrumentId: instrument.id, observedAt, price: '101.25' },
  })
  invariant(marketPoint.priceKind === 'SETTLEMENT' && marketPoint.source === 'MANUAL' && marketPoint.currencyId === formalCurrency.id, '行情价点未继承品种口径')
  await expectRejected(() => admin.mutation(marketCreateRef, {
    resource: 'basMarketPricePoints',
    input: { instrumentId: instrument.id, observedAt, price: '199', priceKind: 'SETTLEMENT' },
  }), '未作废行情价点唯一性')
  const voidedMarketPoint = await admin.mutation(domainCommandRef, {
    resource: 'basMarketPricePoints', id: marketPoint.id, key: 'void',
  })
  invariant(voidedMarketPoint.isVoided === true && voidedMarketPoint.status === 'VOIDED', '行情价点作废状态不一致')
  const rerecordedPoint = await admin.mutation(marketCreateRef, {
    resource: 'basMarketPricePoints',
    input: { instrumentId: instrument.id, observedAt, price: '102.5' },
  })
  await admin.mutation(marketCreateRef, {
    resource: 'basMarketPricePoints',
    input: { instrumentId: instrument.id, observedAt: '2026-08-01T04:05:06.000Z', price: '103' },
  })
  const chartInstruments = await admin.query(marketChartRef, {})
  invariant(chartInstruments.some((row) => row.id === instrument.id && row.currencyCode === 'FML'), '行情图区品种索引漏记录')
  const priceSeries = await admin.query(marketSeriesRef, {
    instrumentIds: [instrument.id], priceKind: 'SETTLEMENT',
    from: observedAt, to: '2026-08-01T04:05:06.000Z',
  })
  invariant(priceSeries.priceKind === 'settlement' && priceSeries.series[0]?.points.map((point) => point.price).join(',') === '102.5,103', '行情序列没有排除作废价点或保持时间顺序')
  invariant(rerecordedPoint.id !== marketPoint.id, '行情价点作废后未生成独立重录事实')

  // Wave E todo: reconciliation producer, permission/company audience and invoice close/reopen.
  verificationStage = 'todo-reconciliation-invoice'
  const receiptItem = (receipt.items as GenericRow[])[0]!
  const purchaseReconciliation = await admin.mutation(reconciliationDraftCreateRef, {
    resource: 'purReconciliations',
    input: {
      companyId: formalCompany.id, reconciliationType: 'REGULAR',
      partyType: 'SUPPLIER', partyId: supplier.id,
      debitAccountId: leafAccounts[0].id, creditAccountId: leafAccounts[1].id,
      remarks: '待办闭环验收',
      items: [{ idx: 1, qty: '3', receiptItemId: receiptItem.id, outsourcedReceiptItemId: null, remarks: null }],
    },
  })
  await admin.mutation(domainCommandRef, { resource: 'purReconciliations', id: purchaseReconciliation.id, key: 'confirm' })
  const activeTodos = await admin.query(todoListRef, { tab: 'active', numItems: 20, cursor: null })
  const activeTodo = activeTodos.results.find((row) => row.sourceId === purchaseReconciliation.id)
  invariant(activeTodo?.type === 'RECEIVE_INVOICE' && activeTodo.partyName === supplier.name, '对账确认未产生可消费待办')
  invariant((await admin.query(todoUnreadRef, {})).count >= 1, '新待办未进入未读计数')
  const dismissedTodo = await admin.mutation(todoDismissRef, { id: activeTodo.id })
  invariant(dismissedTodo.dismissed === true && dismissedTodo.myReadAt, '个人忽略没有同时标记已读')
  const hiddenTodos = await admin.query(todoListRef, { tab: 'active', numItems: 20, cursor: null })
  invariant(!hiddenTodos.results.some((row) => row.id === activeTodo.id), '个人忽略后待办仍出现在活跃列表')
  await admin.mutation(domainCommandRef, { resource: 'purReconciliations', id: purchaseReconciliation.id, key: 'unconfirm' })
  const historyTodos = await admin.query(todoListRef, { tab: 'history', numItems: 20, cursor: null })
  invariant(historyTodos.results.some((row) => row.id === activeTodo.id && row.closedReason === 'UNCONFIRM'), '撤回确认没有关闭待办历史')
  await admin.mutation(domainCommandRef, { resource: 'purReconciliations', id: purchaseReconciliation.id, key: 'confirm' })
  const reopenedTodos = await admin.query(todoListRef, { tab: 'active', numItems: 20, cursor: null })
  const reopenedTodo = reopenedTodos.results.find((row) => row.sourceId === purchaseReconciliation.id)
  invariant(reopenedTodo && reopenedTodo.id !== activeTodo.id && reopenedTodo.dismissed === false, '再次确认没有以新待办复位个人忽略')
  const invoice = await admin.mutation(financeDocumentCreateRef, {
    resource: 'accVatInvoices',
    input: {
      companyId: formalCompany.id, direction: 'INBOUND', invoiceDate: today,
      partyType: 'SUPPLIER', partyId: supplier.id, invoiceKind: 'NORMAL',
      invoiceNo: `INV-${marker}`, netTotal: String(purchaseReconciliation.baseGrossTotal),
      taxTotal: '0', grossTotal: String(purchaseReconciliation.baseGrossTotal),
      partyAccountId: leafAccounts[0].id, amountAccountId: leafAccounts[1].id,
      purReconciliationId: purchaseReconciliation.id,
    },
  })
  const linkedTodos = await admin.query(todoListRef, { tab: 'active', numItems: 20, cursor: null })
  invariant(linkedTodos.results.some((row) => row.id === reopenedTodo.id && row.draftInvoiceLinked === true), '待办未投影草稿发票关联')
  await admin.mutation(domainCommandRef, { resource: 'accVatInvoices', id: invoice.id, key: 'audit' })
  const invoiceClosedTodos = await admin.query(todoListRef, { tab: 'history', numItems: 20, cursor: null })
  invariant(invoiceClosedTodos.results.some((row) => row.id === reopenedTodo.id && row.closedReason === 'INVOICE_AUDIT'), '发票审核没有关闭待办')
  await admin.mutation(domainCommandRef, { resource: 'accVatInvoices', id: invoice.id, key: 'void' })
  const invoiceReopenedTodos = await admin.query(todoListRef, { tab: 'active', numItems: 20, cursor: null })
  invariant(invoiceReopenedTodos.results.some((row) => row.sourceId === purchaseReconciliation.id && row.id !== reopenedTodo.id), '发票作废没有复活待办')

  // Wave E manufacturing: BOM snapshot, split work orders, output facts and demand projections.
  verificationStage = 'manufacturing-demand-work-order-output'
  const salesCandidates = await admin.query(manufacturingSalesCandidatesRef, { companyId: formalCompany.id })
  invariant(salesCandidates.some((row) => row.id === salesOrderItem.id), '制造需求销售条目候选池漏掉已审核订单行')
  const componentMaterial = await admin.mutation(materialCreateRef, {
    code: `MC-${marker}`, name: `制造配料-${marker}`, categoryId: category.id, defaultUnitId: baseUnit.id,
  })
  const bom = await admin.mutation(manufacturingDraftCreateRef, {
    resource: 'mfgBoms',
    input: {
      code: `B-${marker}`, planName: '自托管验收 BOM', note: null, materialId: material.id,
      components: [{ materialId: componentMaterial.id, unitId: baseUnit.id, quantity: '2', lossRate: '0.1', note: '快照配料' }],
      routes: [], byproducts: [],
    },
  })
  await admin.mutation(domainCommandRef, { resource: 'mfgBoms', id: bom.id, key: 'activate' })
  const demandDateBefore = utcToday()
  const demand = await admin.mutation(manufacturingDraftCreateRef, {
    resource: 'mfgDemands',
    input: {
      companyId: formalCompany.id, remarks: '制造闭环验收',
      items: [
        { idx: 1, materialId: material.id, unitId: baseUnit.id, qty: '100', needDate: today, salesOrderItemId: null, remarks: null },
        { idx: 2, materialId: componentMaterial.id, unitId: baseUnit.id, qty: '10', needDate: today, salesOrderItemId: null, remarks: '手工关闭安排验收' },
      ],
    },
  })
  const demandDateAfter = utcToday()
  invariant(
    [demandDateBefore, demandDateAfter].includes(String(demand.demandDate)) &&
      String(demand.demandNo).length > 0,
    '履约需求缺省日期/编号未按 mutation 时点 UTC 当天派生',
  )
  await admin.mutation(domainCommandRef, { resource: 'mfgDemands', id: demand.id, key: 'audit' })
  const demandItems = demand.items as GenericRow[]
  const productionDemandItem = demandItems.find((row) => Number(row.idx) === 1)!
  const manualDemandItem = demandItems.find((row) => Number(row.idx) === 2)!
  invariant(productionDemandItem && manualDemandItem, '制造需求聚合缺少两条需求行')
  const manualArrangement = await admin.mutation(manufacturingArrangeManualRef, {
    demandItemId: manualDemandItem.id, arrangementType: 'CLOSE', qty: '10', remarks: '关闭剩余需求',
  })
  const manuallyCompleted = await admin.query(manufacturingDomainGetRef, { resource: 'mfgDemandItems', id: manualDemandItem.id })
  invariant(manuallyCompleted?.status === 'COMPLETED' && Number(manuallyCompleted.arrangedQty) === 10 && Number(manuallyCompleted.completedQty) === 10, '关闭安排没有完成需求行双投影')
  await admin.mutation(manufacturingRemoveArrangementRef, { id: manualArrangement.id })
  const manualReopened = await admin.query(manufacturingDomainGetRef, { resource: 'mfgDemandItems', id: manualDemandItem.id })
  invariant(manualReopened?.status === 'PENDING' && Number(manualReopened.arrangedQty) === 0, '删除关闭安排没有恢复需求行投影')

  const workOrderRole = await admin.mutation(createRoleRef, {
    code: `work-order-${marker}`, name: '无文件写权限工单验收角色',
  })
  await admin.mutation(syncPermissionsRef, {
    id: workOrderRole.id,
    permissions: ['mfg.work_order:read', 'mfg.work_order:create', 'mfg.work_order:delete'],
  })
  const workOrderUser = await admin.mutation(createUserRef, {
    username: `工单验收-${marker}`,
    name: '无文件写权限工单验收用户',
    roleIds: [workOrderRole.id],
    companyIds: [formalCompany.id],
  })
  const workOrderOperator = await signIn({
    authBaseUrl,
    siteOrigin,
    convexUrl,
    username: `工单验收-${marker}`,
    password: workOrderUser.password,
  })
  await expectRejected(() => workOrderOperator.mutation(manufacturingDraftCreateRef, {
    resource: 'mfgWorkOrders',
    input: { demandItemId: productionDemandItem.id, qty: '1', bomId: bom.id },
  }), '无 BOM 查看权限的工单创建')
  const disposableWorkOrder = await workOrderOperator.mutation(manufacturingDraftCreateRef, {
    resource: 'mfgWorkOrders', input: { demandItemId: productionDemandItem.id, qty: '1' },
  })
  invariant(
    (await admin.query(fileListByFileRef, { fileId: drawingFile.file.id })).results.some(
      (row) => row.ownerType === 'mfg_work_order' && row.ownerId === disposableWorkOrder.id,
    ),
    '无 sys.file:create 权限的业务用户未能触发服务端图纸快照',
  )
  const disposableAttachmentFile = await uploadProductFile(
    admin,
    new TextEncoder().encode(`disposable work-order attachment ${marker}`),
    `待清理工单附件-${marker}.txt`,
    'text/plain',
    { ownerType: 'mfg_work_order', ownerId: disposableWorkOrder.id, category: 'default' },
  )
  await workOrderOperator.mutation(manufacturingDraftRemoveRef, {
    resource: 'mfgWorkOrders', id: disposableWorkOrder.id,
  })
  invariant(
    (await admin.query(fileListByFileRef, { fileId: disposableAttachmentFile.id })).count === 0,
    '删除工单未清理非 drawing 附件挂接',
  )
  await admin.action(fileRemoveRef, { fileId: disposableAttachmentFile.id })
  const demandAfterDisposableWorkOrder = await admin.query(manufacturingDomainGetRef, {
    resource: 'mfgDemandItems', id: productionDemandItem.id,
  })
  invariant(Number(demandAfterDisposableWorkOrder?.arrangedQty) === 0, '删除工单未释放生产安排')

  const workOrder1 = await admin.mutation(manufacturingDraftCreateRef, {
    resource: 'mfgWorkOrders', input: { demandItemId: productionDemandItem.id, qty: '40', bomId: bom.id },
  })
  invariant(workOrder1.status === 'IN_PROGRESS' && Number(workOrder1.baseQty) === 40 && (workOrder1.components as unknown[]).length === 1, '工单创建没有复制 BOM 快照')
  const workOrderEditorRole = await admin.mutation(createRoleRef, {
    code: `work-order-editor-${marker}`, name: '仅工单编辑权限验收角色',
  })
  await admin.mutation(syncPermissionsRef, {
    id: workOrderEditorRole.id,
    permissions: ['mfg.work_order:read', 'mfg.work_order:update'],
  })
  const workOrderEditorUser = await admin.mutation(createUserRef, {
    username: `工单编辑-${marker}`,
    name: '仅工单编辑权限验收用户',
    roleIds: [workOrderEditorRole.id],
    companyIds: [formalCompany.id],
  })
  const workOrderEditor = await signIn({
    authBaseUrl,
    siteOrigin,
    convexUrl,
    username: `工单编辑-${marker}`,
    password: workOrderEditorUser.password,
  })
  await expectRejected(() => workOrderEditor.mutation(manufacturingApplyBomRef, {
    id: workOrder1.id,
    bomId: bom.id,
  }), '无 BOM 查看权限的工单快照替换')
  await admin.mutation(syncPermissionsRef, {
    id: workOrderEditorRole.id,
    permissions: ['mfg.work_order:read', 'mfg.work_order:update', 'mfg.bom:read'],
  })
  const updateOnlyWorkOrder = await workOrderEditor.mutation(manufacturingApplyBomRef, {
    id: workOrder1.id,
    bomId: bom.id,
  })
  invariant(
    (updateOnlyWorkOrder.components as unknown[]).length === 1,
    '仅 update 权限用户无法替换工单 BOM 子行快照',
  )
  const drawingSnapshots = await admin.query(fileListByFileRef, { fileId: drawingFile.file.id })
  const drawingOwners = new Set(drawingSnapshots.results.map((row) => `${row.ownerType}:${row.ownerId}`))
  for (const [ownerType, ownerId] of [
    ['inv_material', material.id],
    ['sal_order_item', salesOrderItem.id],
    ['sal_delivery_item', (delivery.items as GenericRow[])[0]!.id],
    ['pur_order_item', (purchaseOrder.items as GenericRow[])[0]!.id],
    ['pur_receipt_item', (receipt.items as GenericRow[])[0]!.id],
    ['mfg_work_order', workOrder1.id],
  ]) {
    invariant(drawingOwners.has(`${ownerType}:${ownerId}`), `${ownerType} 未复制物料 drawing 挂接快照`)
  }
  const refreshedDrawingSnapshots = await admin.query(fileListByFileRef, { fileId: refreshedDrawingFile.id })
  invariant(
    refreshedDrawingSnapshots.results.some((row) => row.ownerType === 'mfg_work_order' && row.ownerId === workOrder1.id),
    '工单创建未复制物料新增 drawing 挂接',
  )
  const lateDrawingFile = await uploadProductFile(
    admin,
    drawingBytes,
    `图纸冻结-${marker}.png`,
    'image/png',
    { ownerType: 'inv_material', ownerId: material.id, category: 'drawing' },
  )
  await admin.mutation(manufacturingApplyBomRef, { id: workOrder1.id, bomId: bom.id })
  const lateDrawingSnapshots = await admin.query(fileListByFileRef, { fileId: lateDrawingFile.id })
  invariant(
    !lateDrawingSnapshots.results.some((row) => row.ownerType === 'mfg_work_order' && row.ownerId === workOrder1.id),
    '工单修改错误地重拍了创建时冻结的 drawing 挂接',
  )
  await expectRejected(() => admin.mutation(manufacturingDraftCreateRef, {
    resource: 'mfgWorkOrders', input: { demandItemId: productionDemandItem.id, qty: '61' },
  }), '需求超安排')
  const workOrder2 = await admin.mutation(manufacturingDraftCreateRef, {
    resource: 'mfgWorkOrders', input: { demandItemId: productionDemandItem.id, qty: '60' },
  })
  const inlineBom = await admin.mutation(manufacturingCreateInlineBomRef, {
    id: workOrder2.id,
    input: {
      code: `BI-${marker}`, planName: '工单内嵌 BOM', note: null,
      components: [{ materialId: componentMaterial.id, unitId: baseUnit.id, quantity: '3', lossRate: null, note: null }],
      routes: [], byproducts: [],
    },
  })
  invariant(
    inlineBom.bom.status === 'ACTIVE' && inlineBom.workOrder.bomId === inlineBom.bom.id &&
      (inlineBom.workOrder.components as unknown[]).length === 1,
    '工单内嵌 BOM 未在同 mutation 创建、启用并选入快照',
  )
  const arrangements = await admin.query(manufacturingArrangementsRef, { demandItemId: productionDemandItem.id })
  invariant(arrangements.length === 2 && arrangements.every((row) => row.arrangementType === 'MAKE'), '分批工单没有维护两条生产安排')

  const createOutput = (workOrderId: string, qty: string) => admin.mutation(manufacturingDraftCreateRef, {
    resource: 'mfgOutputs',
    input: {
      companyId: formalCompany.id, warehouseId: postingWarehouse.id, remarks: '制造入库验收',
      items: [{ idx: 1, workOrderId, unitId: baseUnit.id, qty, warehouseId: postingWarehouse.id, remarks: null }],
    },
  })
  const outputDateBefore = utcToday()
  const output1 = await createOutput(workOrder1.id, '30')
  const outputDateAfter = utcToday()
  invariant(
    [outputDateBefore, outputDateAfter].includes(String(output1.outputDate)) &&
      String(output1.outputNo).length > 0,
    '生产入库缺省日期/编号未按 mutation 时点 UTC 当天派生',
  )
  await admin.mutation(domainCommandRef, { resource: 'mfgOutputs', id: output1.id, key: 'audit' })
  const workOrderAfterFirstBatch = await admin.query(manufacturingDomainGetRef, { resource: 'mfgWorkOrders', id: workOrder1.id })
  invariant(workOrderAfterFirstBatch?.status === 'IN_PROGRESS' && Number(workOrderAfterFirstBatch.receivedBaseQty) === 30 && Number(workOrderAfterFirstBatch.remainingBaseQty) === 10, '工单第一批入库投影不正确')
  await expectRejected(() => admin.mutation(domainCommandRef, { resource: 'mfgWorkOrders', id: workOrder1.id, key: 'void' }), '存在已审核入库的工单作废')
  await expectRejected(() => admin.mutation(manufacturingApplyBomRef, { id: workOrder1.id, bomId: null }), '存在已审核入库的工单修改 BOM 快照')
  const output2 = await createOutput(workOrder1.id, '10')
  await admin.mutation(domainCommandRef, { resource: 'mfgOutputs', id: output2.id, key: 'audit' })
  const output3 = await createOutput(workOrder2.id, '60')
  await admin.mutation(domainCommandRef, { resource: 'mfgOutputs', id: output3.id, key: 'audit' })
  const completedDemandItem = await admin.query(manufacturingDomainGetRef, { resource: 'mfgDemandItems', id: productionDemandItem.id })
  invariant(completedDemandItem?.status === 'COMPLETED' && Number(completedDemandItem.arrangedQty) === 100 && Number(completedDemandItem.completedQty) === 100, '多批生产入库没有完成需求行双投影')
  const manufacturingStock = await admin.query(inventoryDocumentListRef, { resource: 'invStockEntries', numItems: 100, queryArgs: { companyId: formalCompany.id } })
  invariant([output1.id, output2.id, output3.id].every((id) => manufacturingStock.results.some((row) => row.voucherId === id && Number(row.quantity) > 0)), '生产入库没有同 mutation 写库存事实')
  await admin.mutation(domainCommandRef, { resource: 'mfgOutputs', id: output3.id, key: 'void' })
  const reopenedWorkOrder = await admin.query(manufacturingDomainGetRef, { resource: 'mfgWorkOrders', id: workOrder2.id })
  const reopenedDemandItem = await admin.query(manufacturingDomainGetRef, { resource: 'mfgDemandItems', id: productionDemandItem.id })
  invariant(reopenedWorkOrder?.status === 'IN_PROGRESS' && Number(reopenedWorkOrder.receivedBaseQty) === 0 && reopenedDemandItem?.status === 'SCHEDULED' && Number(reopenedDemandItem.completedQty) === 40, '作废生产入库没有原子回滚工单与需求投影')
  invariant((await admin.query(manufacturingDraftLoadRef, { resource: 'mfgWorkOrders', id: workOrder1.id })).components instanceof Array, '工单 BOM 快照聚合读取失败')

  const salesSettingsPage = await admin.query(salesSettingsListRef, { numItems: 1, cursor: null })
  invariant(salesSettingsPage.results.length === 1, 'setup 未创建供应链 singleton setting')
  const salesSetting = await admin.mutation(salesSettingsUpdateRef, { id: salesSettingsPage.results[0].id, sampleItemMaxQty: 9, deliveryOvershipRatio: '0.0555555' })
  invariant(salesSetting.deliveryOvershipRatio === '0.055556', '设置比例定标/half-up 不正确')
  const numberingRules = await admin.query(numberingRuleListRef, { numItems: 100, cursor: null })
  invariant(numberingRules.results.some((row) => row.resource === 'hr.employee' && row.enabled === true), 'setup 未创建员工编号规则')
  const waveAudit = await admin.query(auditListRef, {
    numItems: 10,
    cursor: null,
    resource: 'basCompanies',
    recordId: formalCompany.id,
  })
  invariant(waveAudit.results.some(row => row.resource === 'basCompanies' && row.recordId === formalCompany.id), '正式 Wave A 写入缺少审计')

  verificationStage = 'limited-actor-permission-company-scope'
  const role = await admin.mutation(createRoleRef, { code: `resource-${marker}`, name: '资源只读验收角色' })
  await admin.mutation(syncPermissionsRef, {
    id: role.id,
    permissions: ['base.currency:read', 'base.unit:read', 'inv.warehouse:read'],
  })
  const limitedUsername = `资源只读-${marker}`
  const limitedUser = await admin.mutation(createUserRef, {
    username: limitedUsername,
    name: '资源只读验收用户',
    roleIds: [role.id],
    companyIds: [first.companyId],
  })
  const limited = await signIn({
    authBaseUrl, siteOrigin, convexUrl, username: limitedUsername, password: limitedUser.password,
  })
  const limitedCurrencyCatalog = await limited.query(catalogRef, { resource: 'basCurrencies' })
  const limitedWarehouseCatalog = await limited.query(catalogRef, { resource: 'invWarehouses' })
  invariant(limitedCurrencyCatalog.capabilities.length === 0, '只读 Actor Catalog 暴露写能力')
  invariant(limitedWarehouseCatalog.commands.length === 0, '只读 Actor Catalog 暴露 seed command')
  invariant((await limited.query(currencyListRef, { profile: 'default', numItems: 2 })).results.length > 0, '只读 Actor 无法查询币种')
  await expectRejected(() => limited.mutation(currencyCreateRef, {
    name: '越权币种', isoCode: 'BAD',
  }), '只读 Actor 币种 create')
  const limitedWarehouses = await limited.query(warehouseListRef, {
    profile: 'default', numItems: 100, cursor: null, args: { companyId: first.companyId },
  })
  invariant(
    limitedWarehouses.results.length > 0 && limitedWarehouses.results.every((row) => row.companyId === first.companyId),
    '只读 Actor 无法读取授权公司的仓库或发生公司范围泄漏',
  )
  const limitedCompanies = await collectAll((cursor) => limited.query(warehouseSupportOptionsRef, {
    kind: 'companies', numItems: 100, cursor,
  }))
  invariant(
    limitedCompanies.length === 1 && limitedCompanies[0].id === first.companyId,
    '仓库专用公司候选泄漏未授权公司',
  )
  const limitedAccounts = await collectAll((cursor) => limited.query(warehouseSupportOptionsRef, {
    kind: 'accounts', companyId: first.companyId, numItems: 100, cursor,
  }))
  invariant(
    limitedAccounts.some((row) => row.id === first.accountId),
    '只有仓库读取权限时无法加载 pilot 科目候选',
  )
  const limitedSuppliers = await collectAll((cursor) => limited.query(warehouseSupportOptionsRef, {
    kind: 'suppliers', numItems: 100, cursor,
  }))
  invariant(
    limitedSuppliers.some((row) => row.id === first.supplierId),
    '只有仓库读取权限时无法加载 pilot 供应商候选',
  )
  const limitedParents = await collectAll((cursor) => limited.query(warehouseSupportOptionsRef, {
    kind: 'parents', companyId: first.companyId, numItems: 100, cursor,
  }))
  invariant(limitedParents.length === 1, '仓库父级候选没有只返回授权公司的非叶仓')
  await expectRejected(() => limited.query(companyListRef, {
    profile: 'default', numItems: 10, cursor: null,
  }), '仓库只读 Actor 通用公司 list')
  await expectRejected(() => limited.query(warehouseSupportOptionsRef, {
    kind: 'companies', numItems: 101, cursor: null,
  }), '仓库辅助选项超大分页')
  await expectRejected(() => limited.query(warehouseSupportOptionsRef, {
    kind: 'companies', numItems: 1.5, cursor: null,
  }), '仓库辅助选项小数分页')
  await expectRejected(() => limited.query(warehouseListRef, {
    profile: 'default', numItems: 10, args: { companyId: second.companyId },
  }), '只读 Actor 越权公司查询')
  await expectRejected(() => limited.query(warehouseSupportOptionsRef, {
    kind: 'accounts', companyId: second.companyId, numItems: 10, cursor: null,
  }), '只读 Actor 越权公司科目候选')

  const firstParentPage = await admin.query(warehouseSupportOptionsRef, {
    kind: 'parents', companyId: first.companyId, numItems: 1, cursor: null,
  })
  invariant(firstParentPage.pageInfo.continueCursor, '仓库父级候选没有产生可验证的 opaque cursor')
  await expectRejected(() => admin.query(warehouseSupportOptionsRef, {
    kind: 'parents', companyId: second.companyId, numItems: 1,
    cursor: firstParentPage.pageInfo.continueCursor,
  }), '仓库辅助 cursor 跨公司重放')
  await expectRejected(() => admin.query(warehouseSupportOptionsRef, {
    kind: 'suppliers', numItems: 1, cursor: firstParentPage.pageInfo.continueCursor,
  }), '仓库辅助 cursor 跨 kind 重放')

  const formalRole = await admin.mutation(createRoleRef, { code: `wave-a-${marker}`, name: 'Wave A 公司范围验收角色' })
  await admin.mutation(syncPermissionsRef, {
    id: formalRole.id,
    permissions: ['base.company:read', 'base.account:read', 'inv.warehouse:read'],
  })
  const formalUsername = `WaveA只读-${marker}`
  const formalLimitedUser = await admin.mutation(createUserRef, { username: formalUsername, roleIds: [formalRole.id], companyIds: [formalCompany.id] })
  const formalLimited = await signIn({ authBaseUrl, siteOrigin, convexUrl, username: formalUsername, password: formalLimitedUser.password })
  const visibleCompanies = await formalLimited.query(companyListRef, { profile: 'default', numItems: 20, cursor: null })
  invariant(visibleCompanies.results.length === 1 && visibleCompanies.results[0].id === formalCompany.id, '正式公司列表泄漏未授权公司')
  invariant((await formalLimited.query(companyGetRef, { id: formalCompany.id }))?.id === formalCompany.id, '受限用户无法读取授权公司')
  await expectRejected(() => formalLimited.query(companyGetRef, { id: formalCompany2.id }), '受限用户 company get 穿透')
  await expectRejected(() => formalLimited.query(accountListRef, { profile: 'default', numItems: 20, companyId: formalCompany2.id }), '受限用户 account list 穿透')

  const result = {
    marker,
    limitedUsername,
    limitedPassword: limitedUser.password,
    companyCode: `A${marker.slice(0, 7)}`.toUpperCase(),
    formalCompanyName: String(formalCompany.name),
    formalMaterialName: String(material.name),
  }
  writeFileSync(resultFile, `${JSON.stringify(result)}\n`, { mode: 0o600 })
  chmodSync(resultFile, 0o600)
  console.log('Convex resource smoke 通过：pilots=3 waveA=formal-master/IAM/settings concurrency=20 scope/permission=ok')
}

try {
  await main()
} catch (error) {
  const detail = error && typeof error === 'object' && 'data' in error
    ? JSON.stringify((error as { data: unknown }).data)
    : String(error)
  console.error(`Convex resource verifier stage=${verificationStage}: ${detail}`)
  throw error
}
