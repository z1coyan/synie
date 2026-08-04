import { expect, test } from '@playwright/test'
import { loginViaUI } from './fixtures/session'

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const sequence = Date.now() % (alphabet.length * alphabet.length)
const isoCode = `R${alphabet[Math.floor(sequence / alphabet.length)]}${alphabet[sequence % alphabet.length]}`
const currencyName = `公司选择器测试币-${isoCode}`

test.setTimeout(60_000)

async function waitInViewport(page: import('@playwright/test').Page, locator: import('@playwright/test').Locator) {
  await expect(locator).toBeVisible()
  await expect.poll(async () => {
    const box = await locator.boundingBox()
    const viewport = page.viewportSize()
    return Boolean(box && viewport && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height)
  }).toBe(true)
}

test('公司页及用户公司授权选择器只使用 Go REST', async ({ page }) => {
  await loginViaUI(page)

  // page.request 与浏览器同 context,自动携带会话 cookie
  const created = await page.request.post('/api/v1/base/currencies', {
    data: { name: currencyName, isoCode, symbol: 'R', active: true },
  })
  const createdText = await created.text()
  expect(created.ok(), `${created.status()} ${createdText}`).toBeTruthy()
  const currency = JSON.parse(createdText) as { id: string }
  try {

  const graphqlRequests: Array<{ url: string; body: string | null }> = []
  page.on('request', (req) => {
    if (new URL(req.url()).pathname === '/graphql') {
      graphqlRequests.push({ url: req.url(), body: req.postData() })
    }
  })

  await page.goto('/system/companies')
  await expect(page.getByRole('grid', { name: 'basCompanies 数据表格' })).toBeVisible()
  await page.getByRole('button', { name: '新增', exact: true }).click()
  const companyDrawer = page.getByRole('dialog', { name: '新增公司' })
  await expect(companyDrawer).toBeVisible()
  const baseCurrencyTrigger = companyDrawer.getByRole('group').nth(1)
  await waitInViewport(page, baseCurrencyTrigger)
  await baseCurrencyTrigger.click()
  const currencyOption = page.getByRole('option', { name: currencyName })
  await expect(currencyOption).toBeVisible()
  await currencyOption.click()
  await expect(page.getByRole('listbox')).toBeHidden()
  const parentTrigger = companyDrawer.getByRole('group').nth(0)
  await waitInViewport(page, parentTrigger)
  await parentTrigger.click()
  await expect(page.getByRole('listbox')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')

  await page.goto('/system/users')
  await expect(page.getByRole('grid', { name: 'sysUsers 数据表格' })).toBeVisible()
  await page.getByRole('button', { name: '新增', exact: true }).click()
  const userDrawer = page.getByRole('dialog', { name: '新增用户' })
  await expect(userDrawer).toBeVisible()
  const companyTrigger = userDrawer.getByRole('group').last()
  await waitInViewport(page, companyTrigger)
  await companyTrigger.click()
  await expect(page.getByRole('listbox')).toBeVisible()
  expect(graphqlRequests).toEqual([])

  expect(graphqlRequests).toEqual([])
  } finally {
    const deleted = await page.request.delete(`/api/v1/base/currencies/${currency.id}`)
    expect(deleted.ok()).toBeTruthy()
  }
})
