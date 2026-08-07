import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import { loginViaUI } from './fixtures/session'

const suffix = Date.now().toString(36)
const ruleName = `浏览器编号规则-${suffix}`
const scopeKey = `E2E|${suffix}`

const candidates = [
  { prefix: 'inv.stock_count', label: '库存盘点单' },
  { prefix: 'mfg.operation', label: '工序' },
  { prefix: 'acc.gl_journal', label: '会计凭证' },
]

const pgContainer = process.env.SYNIE_PG_CONTAINER ?? 'synie-postgres-1'
const pgDb = process.env.SYNIE_PG_DB ?? 'synie'

function postgres(sql: string): string {
  return execFileSync(
    'docker',
    ['exec', pgContainer, 'psql', '-U', 'synie', '-d', pgDb, '-Atc', sql],
    { encoding: 'utf8' },
  )
}

test.setTimeout(90_000)

test('编号规则与计数器通过 Grid/Drawer REST 完成且 GraphQL=0', async ({ page }) => {
  await loginViaUI(page)

  // page.request 与浏览器同 context,自动携带会话 cookie
  const existingResponse = await page.request.post('/api/v1/system/numbering/rules/query', {
    data: { limit: 200, offset: 0 },
  })
  expect(existingResponse.ok()).toBeTruthy()
  const existing = (await existingResponse.json()) as {
    results: Array<{ resource: string; enabled: boolean }>
  }
  const occupied = new Set(
    existing.results.filter((rule) => rule.enabled).map((rule) => rule.resource),
  )
  const candidate = candidates.find((item) => !occupied.has(item.prefix))
  expect(candidate, '三个浏览器测试候选资源都已有启用规则').toBeTruthy()

  const graphqlRequests: string[] = []
  const numberingRequests: string[] = []
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname
    if (pathname === '/graphql') graphqlRequests.push(request.postData() ?? '')
    if (
      pathname.startsWith('/api/v1/system/numbering') ||
      pathname.includes('/meta/resources/sysNumbering')
    ) {
      numberingRequests.push(`${request.method()} ${pathname}`)
    }
  })

  let ruleID: string | undefined
  let counterID: string | undefined
  try {
    await page.goto('/system/numbering')
    await expect(page.getByRole('heading', { name: '编号规则' })).toBeVisible()
    await expect(
      page.getByRole('grid', { name: 'sysNumberingRules 数据表格' }),
    ).toBeVisible()
    await page.getByRole('button', { name: '新增', exact: true }).click()

    const createDrawer = page.getByRole('dialog', { name: '新增编号规则' })
    await expect(createDrawer).toBeVisible()
    await createDrawer.getByLabel('绑定单据').click()
    await page.getByRole('option', { name: candidate!.label, exact: true }).click()
    await createDrawer.getByLabel('规则名称').fill(ruleName)
    await createDrawer.getByLabel('固定文本').fill('E2E-')
    await createDrawer.getByRole('button', { name: '加文本', exact: true }).click()
    await createDrawer.getByLabel('序号位数').fill('3')
    await createDrawer.getByRole('button', { name: '加序号', exact: true }).click()
    await createDrawer.getByRole('button', { name: '保存', exact: true }).click()
    await expect(createDrawer).toBeHidden()

    const ruleQuery = await page.request.post('/api/v1/system/numbering/rules/query', {
      data: { limit: 20, offset: 0, search: ruleName },
    })
    expect(ruleQuery.ok()).toBeTruthy()
    const rules = (await ruleQuery.json()) as {
      results: Array<{ id: string; enabled: boolean }>
    }
    expect(rules.results).toHaveLength(1)
    ruleID = rules.results[0].id

    const insertOutput = postgres(`
      INSERT INTO sys_numbering_counter (rule_id, scope_key, value)
      VALUES ('${ruleID}'::uuid, '${scopeKey}', 7)
      RETURNING id;
    `)
    counterID = insertOutput.match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    )?.[0]
    expect(counterID).toBeTruthy()

    const search = page.getByRole('searchbox', { name: '搜索' })
    await search.fill(ruleName)
    const row = page.getByRole('row').filter({ hasText: ruleName })
    await expect(row).toBeVisible()
    await row.getByRole('button', { name: '行操作' }).click()
    await page.getByRole('menuitem', { name: '编辑', exact: true }).click()

    const editDrawer = page.getByRole('dialog', { name: '编辑编号规则' })
    await expect(editDrawer).toBeVisible()
    const counterGrid = editDrawer.getByRole('grid', { name: '计数器(当前序号)' })
    await expect(counterGrid.getByRole('row').filter({ hasText: scopeKey })).toBeVisible()
    await counterGrid.getByRole('button', { name: '编辑', exact: true }).click()

    const counterDrawer = page.getByRole('dialog', { name: '编辑计数器' })
    await counterDrawer.getByLabel('当前序号').fill('41')
    await counterDrawer.getByRole('button', { name: '保存', exact: true }).click()
    await expect(counterDrawer).toBeHidden()
    await editDrawer.getByRole('button', { name: '保存', exact: true }).click()
    await expect(editDrawer).toBeHidden()

    const counterResponse = await page.request.get(
      `/api/v1/system/numbering/counters/${counterID}`,
    )
    expect(counterResponse.ok()).toBeTruthy()
    const counter = (await counterResponse.json()) as { value: number }
    expect(counter.value).toBe(41)

    await expect(row).toBeVisible()
    await row.getByRole('button', { name: '行操作' }).click()
    await page.getByRole('menuitem', { name: '停用', exact: true }).click()
    await expect(page.getByText(`已停用「${ruleName}」`)).toBeVisible()

    expect(numberingRequests).toContain('GET /api/v1/system/numbering/resources')
    expect(numberingRequests).toContain('POST /api/v1/system/numbering/rules')
    expect(numberingRequests).toContain(
      'POST /api/v1/system/numbering/counters/query',
    )
    expect(
      numberingRequests.some(
        (entry) =>
          entry === `PATCH /api/v1/system/numbering/counters/${counterID}`,
      ),
    ).toBe(true)
    expect(graphqlRequests).toEqual([])
  } finally {
    if (ruleID) {
      await page.request.delete(`/api/v1/system/numbering/rules/${ruleID}`)
      postgres(`
        DELETE FROM sys_audit_log
        WHERE record_id = '${ruleID}'::uuid
        ${counterID ? `OR record_id = '${counterID}'::uuid` : ''};
      `)
    }
  }
})
