import { execFileSync } from 'node:child_process'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { loginViaUI, sessionCookieHeader } from './fixtures/session'

const goAPIURL = process.env.SYNIE_API_URL ?? process.env.GO_API_URL ?? 'http://127.0.0.1:8080/api/v1'

type SalesSetting = {
  id: string
  sampleItemMaxQty: number
  deliveryOvershipRatio: string
  spotItemMaxQty: number
  receiptOverreceiveRatio: string
  demandOverorderRatio: string
}

type ManufacturingSetting = {
  id: string
  outputOverreceiveRatio: string
}

type AccountingSetting = {
  id: string
  ocrAccessKeyId?: string | null
}

type SystemSetting = {
  id: string
  marketFetchScheduleEnabled: boolean
  marketFetchLastIntervalMinutes: number
  marketFetchSettlementEnabled: boolean
}

async function api<T>(request: APIRequestContext, path: string): Promise<T> {
  // page.request 与浏览器同 context,自动携带会话 cookie
  const response = await request.get(`/api/v1${path}`)
  const text = await response.text()
  expect(response.ok(), `${path}: ${response.status()} ${text}`).toBeTruthy()
  return JSON.parse(text) as T
}

async function restorePatch(
  cookie: { Cookie: string },
  path: string,
  data: unknown,
): Promise<void> {
  // 直连 API origin,cookie 域是前端 origin,需显式带 Cookie 头
  const response = await fetch(`${goAPIURL}${path}`, {
    method: 'PATCH',
    headers: {
      ...cookie,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`restore PATCH ${path}: ${response.status} ${text}`)
  }
}

const pgDb = process.env.SYNIE_PG_DB ?? 'synie'

function postgres(sql: string): void {
  execFileSync(
    'docker',
    [
      'exec',
      'synie-postgres-1',
      'psql',
      '-U',
      'synie',
      '-d',
      pgDb,
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    { stdio: 'ignore' },
  )
}

function graphqlDocument(body: string | null): string {
  if (!body) return ''
  try {
    const payload = JSON.parse(body) as { query?: unknown }
    return typeof payload.query === 'string' ? payload.query : ''
  } catch {
    return body
  }
}

test.setTimeout(180_000)

test('四类设置通过 Go REST 保存，Settings GraphQL=0', async ({ page }) => {
  const startedAt = new Date()
  await loginViaUI(page)
  const cookie = await sessionCookieHeader(page.context())
  const [sales, manufacturing, accounting, system] = await Promise.all([
    api<SalesSetting>(page.request, '/settings/supply-chain'),
    api<ManufacturingSetting>(page.request, '/settings/production'),
    api<AccountingSetting>(page.request, '/settings/finance'),
    api<SystemSetting>(page.request, '/settings/system'),
  ])

  const settingsGraphQL: string[] = []
  const restRequests: string[] = []
  page.on('request', (outgoing) => {
    const pathname = new URL(outgoing.url()).pathname
    const document = graphqlDocument(outgoing.postData())
    if (
      pathname === '/graphql' &&
      /\b(?:salSetting|mfgSetting|accSetting|sysSetting|update(?:Sal|Mfg|Acc|Sys)Setting)\b/.test(
        document,
      )
    ) {
      settingsGraphQL.push(document)
    }
    if (
      pathname.startsWith('/api/v1/settings/') ||
      (pathname.includes('/api/v1/meta/resources/') &&
        /(?:sal|mfg|acc|sys)Settings$/.test(pathname))
    ) {
      restRequests.push(`${outgoing.method()} ${pathname}`)
    }
  })

  try {
    await page.goto('/base/market')
    await expect(
      page.getByRole('heading', { name: /^(行情|无行情权限)$/ }),
    ).toBeVisible()
    // 行情状态 REST 受 canPriceRead（旧 myPermissions GraphQL）门控；Go-only 环境只断言页面可达，
    // System Setting 的 GET/PATCH 由后续行情拉取设置页覆盖。

    await page.goto('/scm/purchase/orders')
    await expect(page.getByRole('heading', { name: '采购订单', exact: true })).toBeVisible()
    // purOrders DataGrid Meta 仍走旧 GraphQL 授权，Go JWT 环境不保证渲染新增入口；
    // 抽屉 Settings 迁移由静态扫描与类型/构建门禁覆盖。

    await page.goto('/scm/settings/sales')
    const sampleMax = page.getByLabel('样品条目数量上限')
    await expect(sampleMax).toBeVisible()
    await sampleMax.fill(String(sales.sampleItemMaxQty === 91 ? 92 : 91))
    await page.getByLabel('发货超发比例(%)').fill('7')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.getByText('销售设置已保存')).toBeVisible()

    await page.goto('/scm/settings/purchase')
    const spotMax = page.getByLabel('零星条目数量上限')
    await expect(spotMax).toBeVisible()
    await spotMax.fill(String(sales.spotItemMaxQty === 93 ? 94 : 93))
    await page.getByLabel('入库超收比例(%)').fill('6')
    await page.getByLabel('需求超安排比例(%)').fill('5')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.getByText('采购设置已保存')).toBeVisible()

    await page.goto('/scm/settings/production')
    const outputRatio = page.getByLabel('生产入库超入比例 (%)')
    await expect(outputRatio).toBeVisible()
    await outputRatio.fill('4')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.getByText('生产设置已保存')).toBeVisible()

    await page.goto('/finance/settings')
    const keyID = page.getByLabel('AccessKey ID')
    await expect(keyID).toBeVisible()
    await keyID.fill(`settings-e2e-${Date.now().toString(36)}`)
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.getByText('财务设置已保存')).toBeVisible()
    await expect(page.getByLabel('AccessKey Secret')).toHaveValue('')

    await page.goto('/base/settings/market-fetch')
    const schedule = page.getByRole('checkbox', { name: '启用定时拉取' })
    await expect(schedule).toBeVisible()
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.getByText('行情拉取设置已保存')).toBeVisible()


    expect(restRequests).toContain('PATCH /api/v1/settings/supply-chain')
    expect(restRequests).toContain('PATCH /api/v1/settings/production')
    expect(restRequests).toContain('PATCH /api/v1/settings/finance')
    expect(restRequests).toContain('PATCH /api/v1/settings/system')
    expect(settingsGraphQL).toEqual([])
  } finally {
    try {
      const restored = await Promise.allSettled([
        restorePatch(cookie, '/settings/supply-chain', {
          sampleItemMaxQty: sales.sampleItemMaxQty,
          deliveryOvershipRatio: sales.deliveryOvershipRatio,
          spotItemMaxQty: sales.spotItemMaxQty,
          receiptOverreceiveRatio: sales.receiptOverreceiveRatio,
          demandOverorderRatio: sales.demandOverorderRatio,
        }),
        restorePatch(cookie, '/settings/production', {
          outputOverreceiveRatio: manufacturing.outputOverreceiveRatio,
        }),
        restorePatch(cookie, '/settings/finance', {
          ocrAccessKeyId: accounting.ocrAccessKeyId ?? null,
        }),
        restorePatch(cookie, '/settings/system', {
          marketFetchScheduleEnabled: system.marketFetchScheduleEnabled,
          marketFetchLastIntervalMinutes: system.marketFetchLastIntervalMinutes,
          marketFetchSettlementEnabled: system.marketFetchSettlementEnabled,
        }),
      ])
      const failures = restored.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      )
      if (failures.length > 0) {
        throw new AggregateError(
          failures.map((result) => result.reason),
          'Settings E2E 恢复失败',
        )
      }
    } finally {
      const recordIDs = [sales.id, manufacturing.id, accounting.id, system.id]
        .map((id) => `'${id}'::uuid`)
        .join(',')
      postgres(`
        DELETE FROM sys_audit_log
        WHERE record_id IN (${recordIDs})
          AND resource IN ('sal_setting', 'mfg_setting', 'acc_setting', 'sys_setting')
          AND inserted_at >= ('${startedAt.toISOString()}'::timestamptz AT TIME ZONE 'utc');
      `)
    }
  }
})
