import { SQL } from 'bun'

const baseURL = process.env.SYNIE_API_URL ?? process.env.GO_API_URL ?? 'http://127.0.0.1:8080/api/v1'
const username = process.env.E2E_ADMIN_USERNAME ?? 'admin'
const password = process.env.E2E_ADMIN_PASSWORD ?? 'synie-integration-admin-password'
const databaseURL =
  process.env.SYNIE_TEST_DATABASE_URL ??
  'postgres://synie:synie@127.0.0.1:5441/synie?sslmode=disable'

interface APIErrorEnvelope {
  error?: { code?: string; message?: string }
}

async function requestText(
  path: string,
  init: RequestInit = {},
  expectedStatus = 200,
): Promise<string> {
  const response = await fetch(baseURL + path, init)
  const text = await response.text()
  if (response.status !== expectedStatus) {
    let detail = text
    try {
      const envelope = JSON.parse(text) as APIErrorEnvelope
      detail = `${envelope.error?.code ?? 'unknown'}:${envelope.error?.message ?? text}`
    } catch {
      // 非 JSON 错误保留原始响应。
    }
    throw new Error(`${init.method ?? 'GET'} ${path}: ${response.status}, ${detail}`)
  }
  return text
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  expectedStatus = 200,
): Promise<T> {
  const text = await requestText(path, init, expectedStatus)
  return text === '' ? (undefined as T) : (JSON.parse(text) as T)
}

const login = await request<{ token: string }>('/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username, password }),
})
const headers = {
  Authorization: `Bearer ${login.token}`,
  'Content-Type': 'application/json',
}
const db = new SQL(databaseURL)
const startedAt = new Date()
const secret = `settings-rest-secret-${crypto.randomUUID()}`

type OriginalSettings = {
  sales: Record<string, unknown>
  manufacturing: Record<string, unknown>
  accounting: Record<string, unknown>
  system: Record<string, unknown>
}

let original: OriginalSettings | null = null
try {
  const rows = await db`
    SELECT
      (SELECT row_to_json(s) FROM sal_setting s LIMIT 1) AS sales,
      (SELECT row_to_json(m) FROM mfg_setting m LIMIT 1) AS manufacturing,
      (SELECT row_to_json(a) FROM acc_setting a LIMIT 1) AS accounting,
      (SELECT row_to_json(s) FROM sys_setting s LIMIT 1) AS system
  `
  const snapshot = rows[0] as OriginalSettings | undefined
  if (
    !snapshot?.sales ||
    !snapshot.manufacturing ||
    !snapshot.accounting ||
    !snapshot.system
  ) {
    throw new Error('Settings 单例种子缺失: sal/mfg/acc/sys 四表必须各有一行')
  }
  original = snapshot
  const resources = ['salSettings', 'mfgSettings', 'accSettings', 'sysSettings']
  const metas = await Promise.all(
    resources.map((resource) =>
      request<{ grid: { capabilities: string[] }; form?: unknown }>(
        `/meta/resources/${resource}`,
        { headers },
      ),
    ),
  )
  for (const [index, meta] of metas.entries()) {
    if ([...meta.grid.capabilities].sort().join(',') !== 'update') {
      throw new Error(
        `${resources[index]} capabilities=${meta.grid.capabilities.join(',')}`,
      )
    }
  }
  const accountingMeta = JSON.stringify(metas[2])
  if (
    accountingMeta.includes('ocrAccessKeySecret') ||
    accountingMeta.includes('ocr_access_key_secret')
  ) {
    throw new Error('财务设置 Meta 泄漏了 OCR Secret')
  }

  const [sales, manufacturing, accounting, system] = await Promise.all([
    request<{ sampleItemMaxQty: number }>('/settings/supply-chain', { headers }),
    request<{ outputOverreceiveRatio: string }>('/settings/production', { headers }),
    request<{ ocrAccessKeyId?: string | null }>('/settings/finance', { headers }),
    request<{ marketFetchLastIntervalMinutes: number }>('/settings/system', { headers }),
  ])

  const salesUpdated = await request<{ sampleItemMaxQty: number; demandOverorderRatio: string }>(
    '/settings/supply-chain',
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        sampleItemMaxQty: sales.sampleItemMaxQty === 97 ? 98 : 97,
        deliveryOvershipRatio: '0.07',
        spotItemMaxQty: 96,
        receiptOverreceiveRatio: '0.06',
        demandOverorderRatio: '0.05',
      }),
    },
  )
  if (salesUpdated.demandOverorderRatio !== '0.05') {
    throw new Error(`供应链设置更新结果=${JSON.stringify(salesUpdated)}`)
  }

  const manufacturingUpdated = await request<{ outputOverreceiveRatio: string }>(
    '/settings/production',
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        outputOverreceiveRatio:
          manufacturing.outputOverreceiveRatio === '0.04' ? '0.03' : '0.04',
      }),
    },
  )
  if (!['0.03', '0.04'].includes(manufacturingUpdated.outputOverreceiveRatio)) {
    throw new Error(`生产设置更新结果=${JSON.stringify(manufacturingUpdated)}`)
  }

  const accountingText = await requestText('/settings/finance', {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      ocrAccessKeyId: `settings-rest-${crypto.randomUUID().slice(0, 8)}`,
      ocrAccessKeySecret: secret,
    }),
  })
  if (
    accountingText.includes(secret) ||
    accountingText.includes('ocrAccessKeySecret') ||
    accountingText.includes('ocr_access_key_secret')
  ) {
    throw new Error('财务设置 API 响应泄漏了 OCR Secret')
  }
  const accountingUpdated = JSON.parse(accountingText) as { ocrAccessKeyId?: string | null }
  if (!accountingUpdated.ocrAccessKeyId?.startsWith('settings-rest-')) {
    throw new Error(`财务设置更新结果=${accountingText}`)
  }
  const configured = await request<{ configured: boolean }>(
    '/settings/finance/ocr-configured',
    { headers },
  )
  if (!configured.configured) throw new Error('OCR 凭证写入后 configured=false')

  const nextInterval = system.marketFetchLastIntervalMinutes === 30 ? 60 : 30
  const systemUpdated = await request<{ marketFetchLastIntervalMinutes: number }>(
    '/settings/system',
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        marketFetchScheduleEnabled: true,
        marketFetchLastIntervalMinutes: nextInterval,
        marketFetchSettlementEnabled: false,
      }),
    },
  )
  if (systemUpdated.marketFetchLastIntervalMinutes !== nextInterval) {
    throw new Error(`系统设置更新结果=${JSON.stringify(systemUpdated)}`)
  }

  await request<unknown>(
    '/settings/system',
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ marketFetchLastIntervalMinutes: 15 }),
    },
    400,
  )

  const auditRows = (await db`
    SELECT resource, changes::text AS changes
    FROM sys_audit_log
    WHERE (
        (resource = 'sal_setting' AND record_id = ${original.sales.id}::uuid)
        OR (resource = 'mfg_setting' AND record_id = ${original.manufacturing.id}::uuid)
        OR (resource = 'acc_setting' AND record_id = ${original.accounting.id}::uuid)
        OR (resource = 'sys_setting' AND record_id = ${original.system.id}::uuid)
      )
      AND inserted_at >= ${startedAt}
    ORDER BY inserted_at
  `) as Array<{ resource: string; changes: string }>
  const auditedResources = new Set(auditRows.map((row) => String(row.resource)))
  for (const resource of ['sal_setting', 'mfg_setting', 'acc_setting', 'sys_setting']) {
    if (!auditedResources.has(resource)) throw new Error(`缺少 ${resource} 更新审计`)
  }
  const auditJSON = JSON.stringify(auditRows)
  if (auditJSON.includes(secret)) throw new Error('审计日志泄漏了 OCR Secret')
  const accountingAudit = auditRows.find((row) => row.resource === 'acc_setting')
  if (
    !accountingAudit ||
    !String(accountingAudit.changes).includes('"[FILTERED]"')
  ) {
    throw new Error(`OCR Secret 审计未脱敏: ${JSON.stringify(accountingAudit)}`)
  }

  console.log(
    `settings REST acceptance ok: meta=${resources.length} API=4 audit=${auditRows.length} secret=[FILTERED]`,
  )
} finally {
  try {
    if (original) {
      const restored = await Promise.allSettled([
        db`
          UPDATE sal_setting SET
            sample_item_max_qty = ${original.sales.sample_item_max_qty},
            delivery_overship_ratio = ${original.sales.delivery_overship_ratio},
            spot_item_max_qty = ${original.sales.spot_item_max_qty},
            receipt_overreceive_ratio = ${original.sales.receipt_overreceive_ratio},
            demand_overorder_ratio = ${original.sales.demand_overorder_ratio},
            updated_at = ${original.sales.updated_at}
          WHERE id = ${original.sales.id}::uuid
        `,
        db`
          UPDATE mfg_setting SET
            output_overreceive_ratio = ${original.manufacturing.output_overreceive_ratio},
            updated_at = ${original.manufacturing.updated_at}
          WHERE id = ${original.manufacturing.id}::uuid
        `,
        db`
          UPDATE acc_setting SET
            ocr_access_key_id = ${original.accounting.ocr_access_key_id},
            ocr_access_key_secret = ${original.accounting.ocr_access_key_secret},
            updated_at = ${original.accounting.updated_at}
          WHERE id = ${original.accounting.id}::uuid
        `,
        db`
          UPDATE sys_setting SET
            market_fetch_schedule_enabled = ${original.system.market_fetch_schedule_enabled},
            market_fetch_last_interval_minutes = ${original.system.market_fetch_last_interval_minutes},
            market_fetch_settlement_enabled = ${original.system.market_fetch_settlement_enabled},
            market_fetch_last_run_at = ${original.system.market_fetch_last_run_at},
            market_fetch_last_summary = ${original.system.market_fetch_last_summary},
            updated_at = ${original.system.updated_at}
          WHERE id = ${original.system.id}::uuid
        `,
      ])
      await db`
        DELETE FROM sys_audit_log
        WHERE (
            (resource = 'sal_setting' AND record_id = ${original.sales.id}::uuid)
            OR (resource = 'mfg_setting' AND record_id = ${original.manufacturing.id}::uuid)
            OR (resource = 'acc_setting' AND record_id = ${original.accounting.id}::uuid)
            OR (resource = 'sys_setting' AND record_id = ${original.system.id}::uuid)
          )
          AND inserted_at >= ${startedAt}
      `
      const failures = restored.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      )
      if (failures.length > 0) {
        throw new AggregateError(
          failures.map((result) => result.reason),
          'Settings REST 验收恢复失败',
        )
      }
    }
  } finally {
    await db.close()
  }
}
