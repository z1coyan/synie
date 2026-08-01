import { expect, test } from '@playwright/test'
import { waitForHydration } from './helpers/hydration'

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`缺少环境变量 ${name}`)
  return value
}

test('production Web 通过 Convex 完成模板导出和 PDF 预览', async ({ context, page }) => {
  const retiredBusinessApiPrefix = '/api/' + 'v1'
  const username = requiredEnv('E2E_CONVEX_USERNAME')
  const password = requiredEnv('E2E_CONVEX_PASSWORD')
  const orderNo = requiredEnv('E2E_PRINT_ORDER_NO')
  const templateName = requiredEnv('E2E_PRINT_TEMPLATE_NAME')
  const forbiddenRequests: string[] = []
  context.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path.startsWith(retiredBusinessApiPrefix) || path.startsWith('/api/internal/print-worker')) {
      forbiddenRequests.push(`${request.method()} ${path}`)
    }
  })

  await page.goto('/login')
  await waitForHydration(page)
  await page.getByLabel('用户名').fill(username)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登 录' }).click()
  await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible()

  await page.goto('/scm/sales-orders/orders')
  await waitForHydration(page)
  await expect(page.getByRole('heading', { name: '销售订单', exact: true })).toBeVisible()
  const row = page.getByRole('row').filter({ hasText: orderNo })
  await expect(row).toHaveCount(1)

  await row.getByRole('button', { name: '行操作' }).click()
  await page.getByRole('menuitem', { name: '导出 Excel' }).click()
  await expect(page.getByRole('heading', { name: '导出 Excel' })).toBeVisible()
  await expect(page.getByText(`${templateName}（默认）`)).toBeVisible()
  const download = page.waitForEvent('download')
  await page.getByLabel('导出 Excel').getByRole('button', { name: '导出', exact: true }).click()
  const downloaded = await download
  expect(downloaded.suggestedFilename()).toMatch(/\.xlsx$/)
  await expect(page.getByText('已开始下载 Excel')).toBeVisible()

  await row.getByRole('button', { name: '行操作' }).click()
  await page.getByRole('menuitem', { name: '打印', exact: true }).click()
  await expect(page.getByRole('heading', { name: '模板打印' })).toBeVisible()
  const popupPromise = context.waitForEvent('page')
  const pdfResponsePromise = context.waitForEvent('response', {
    predicate: (response) => {
      const path = new URL(response.url()).pathname
      return path.startsWith('/synie-product-files/print-tmp/') && path.endsWith('.pdf')
    },
  })
  await page.getByLabel('模板打印').getByRole('button', { name: '打印', exact: true }).click()
  const preview = await popupPromise
  await expect(page.getByText('已打开打印预览')).toBeVisible({ timeout: 120_000 })
  const pdfResponse = await pdfResponsePromise
  expect(pdfResponse.status()).toBe(200)
  expect(pdfResponse.headers()['content-type']).toContain('application/pdf')
  expect(pdfResponse.headers()['content-disposition']).toMatch(/^inline;/)

  // Headless Chromium downloads top-level PDFs even with an inline disposition,
  // so its popup can remain about:blank. Verify the signed response bytes instead
  // of depending on the installed browser PDF viewer.
  const pdf = await context.request.get(pdfResponse.url())
  expect(pdf.ok()).toBe(true)
  expect(Buffer.from(await pdf.body()).subarray(0, 5).toString('ascii')).toBe('%PDF-')
  await preview.close()

  expect(forbiddenRequests).toEqual([])
})
