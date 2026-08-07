import { expect, test, type Page, type Route } from '@playwright/test'
import { loginViaUI } from './fixtures/session'

const materialId = '00000000-0000-4000-8000-000000000099'

interface PreviewCase {
  id: string
  entryId: string
  voucherType: string
  voucherNo: string
  label: string
  docNoField: string
  parentPath: string
  linePaths: string[]
  sectionTitles: string[]
  status: string
  statusLabel: string
}

const PREVIEWS: PreviewCase[] = [
  previewCase(
    1,
    'inv.stock_doc',
    'E2E-STOCK-DOC',
    '手工出入库单',
    'docNo',
    '/api/v1/inventory/stock-docs',
    ['/api/v1/inventory/stock-doc-items'],
    ['出入库行'],
  ),
  previewCase(
    2,
    'inv.stock_transfer',
    'E2E-TRANSFER',
    '手工调拨单',
    'docNo',
    '/api/v1/inventory/stock-transfers',
    ['/api/v1/inventory/stock-transfer-items'],
    ['调拨行'],
  ),
  previewCase(
    3,
    'inv.stock_count',
    'E2E-COUNT',
    '库存盘点单',
    'docNo',
    '/api/v1/inventory/stock-counts',
    ['/api/v1/inventory/stock-count-items'],
    ['盘点行'],
  ),
  previewCase(
    4,
    'sales.delivery',
    'E2E-DELIVERY',
    '销售发货单',
    'deliveryNo',
    '/api/v1/sales/deliveries',
    ['/api/v1/sales/delivery-items'],
    ['发货条目'],
  ),
  previewCase(
    5,
    'purchase.receipt',
    'E2E-RECEIPT',
    '采购入库单',
    'receiptNo',
    '/api/v1/purchase/receipts',
    ['/api/v1/purchase/receipt-items'],
    ['入库条目'],
  ),
  previewCase(
    6,
    'mfg.output',
    'E2E-OUTPUT',
    '生产入库单',
    'outputNo',
    '/api/v1/manufacturing/outputs',
    ['/api/v1/manufacturing/output-items'],
    ['入库条目'],
  ),
  previewCase(
    7,
    'purchase.outsourced_issue',
    'E2E-OUT-ISSUE',
    '委外发料单',
    'issueNo',
    '/api/v1/purchase/outsourced-issues',
    ['/api/v1/purchase/outsourced-issue-items'],
    ['发料条目'],
  ),
  previewCase(
    8,
    'purchase.outsourced_receipt',
    'E2E-OUT-RECEIPT',
    '委外入库单',
    'receiptNo',
    '/api/v1/purchase/outsourced-receipts',
    [
      '/api/v1/purchase/outsourced-receipt-items',
      '/api/v1/purchase/outsourced-receipt-item-materials',
      '/api/v1/purchase/outsourced-receipt-item-byproducts',
    ],
    ['成品入库行', '材料扣减行', '副产物行'],
  ),
]

function previewCase(
  n: number,
  voucherType: string,
  voucherNo: string,
  label: string,
  docNoField: string,
  parentPath: string,
  linePaths: string[],
  sectionTitles: string[],
): PreviewCase {
  const suffix = String(n).padStart(12, '0')
  return {
    id: `00000000-0000-4000-8000-${suffix}`,
    entryId: `10000000-0000-4000-8000-${suffix}`,
    voucherType,
    voucherNo,
    label,
    docNoField,
    parentPath,
    linePaths,
    sectionTitles,
    status: voucherType === 'inv.stock_transfer' ? 'RECEIVED' : 'AUDITED',
    statusLabel: voucherType === 'inv.stock_transfer' ? '已收货' : '已审核',
  }
}

async function fulfillJSON(route: Route, body: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

function entryRow(item: PreviewCase) {
  return {
    id: item.entryId,
    postingDate: '2026-07-31',
    quantity: '1',
    voucherType: item.voucherType,
    voucherId: item.id,
    voucherNo: item.voucherNo,
    isCancelled: false,
    materialId: null,
    materialCode: '',
    materialName: '',
  }
}

function lineRow(path: string) {
  return {
    id: path.includes('outsourced-receipt-items')
      ? '20000000-0000-4000-8000-000000000001'
      : `20000000-0000-4000-8000-${String(path.length).padStart(12, '0')}`,
    idx: 1,
    materialId,
    materialCode: 'E2E-MAT',
    materialName: '速览验收物料',
    materialSpec: 'SPEC',
    customerPartNo: 'CPN',
    unitName: '个',
    qty: '1',
    baseQty: '1',
    countedQuantity: '1',
    convertedCounted: '1',
    bookQuantity: '0',
  }
}

async function installPreviewFixtures(page: Page, previews: PreviewCase[]): Promise<void> {
  await page.route('**/api/v1/inventory/stock-entries/query', (route) =>
    fulfillJSON(route, {
      count: previews.length,
      results: previews.map(entryRow),
    }),
  )

  for (const item of previews) {
    await page.route(`**${item.parentPath}/${item.id}`, (route) =>
      fulfillJSON(route, {
        id: item.id,
        [item.docNoField]: item.voucherNo,
        status: item.status,
        remarks: '浏览器隔离验收',
      }),
    )
    for (const path of item.linePaths) {
      await page.route(`**${path}/query`, (route) =>
        fulfillJSON(route, { count: 1, results: [lineRow(path)] }),
      )
    }
  }

  await page.route(`**/api/v1/base/materials/${materialId}`, (route) =>
    fulfillJSON(route, {
      id: materialId,
      code: 'E2E-MAT',
      name: '速览验收物料',
      spec: 'SPEC',
    }),
  )
}

test.setTimeout(180_000)

test('库存分录八类来源的单号与单据链接打开同一只读头+行速览', async ({ page }) => {
  await loginViaUI(page)
  await installPreviewFixtures(page, PREVIEWS)
  await page.goto('/inventory/stock-entries')
  const grid = page.getByRole('grid', { name: 'invStockEntries 数据表格' })
  await expect(grid).toBeVisible()

  for (const item of PREVIEWS) {
    const row = grid.getByRole('row').filter({ hasText: item.voucherNo })
    await expect(row).toBeVisible()
    // 来源单号与来源单据已归并为单列多态 fk 链接(链接文本即单号,见 stock-entries 页注释)
    const sourceLinks = row.getByRole('link', { name: item.voucherNo, exact: true })
    await expect(sourceLinks).toHaveCount(1)

    // 同一链接开合两次:速览可重复进入且互不影响
    for (const linkIndex of [0, 0]) {
      await sourceLinks.nth(linkIndex).click()
      const drawer = page.getByRole('dialog', { name: `${item.label}详情` })
      await expect(drawer).toBeVisible()
      await expect(drawer.getByText(item.voucherNo, { exact: true }).first()).toBeVisible()
      await expect(drawer.getByText(item.statusLabel, { exact: true })).toBeVisible()
      for (const title of item.sectionTitles) {
        await expect(drawer.getByText(title, { exact: true })).toBeVisible()
      }
      await expect(drawer.getByRole('button', { name: /编辑|审核|作废/ })).toHaveCount(0)
      if (item.voucherType === 'sales.delivery') {
        await expect(drawer.getByText(/装箱/)).toHaveCount(0)
      }
      await drawer.getByRole('button', { name: '关闭', exact: true }).click()
      await expect(drawer).toBeHidden()
    }
  }

  const firstDrawerLink = grid
    .getByRole('row')
    .filter({ hasText: PREVIEWS[0]!.voucherNo })
    .getByRole('link', { name: PREVIEWS[0]!.voucherNo, exact: true })
    .nth(0)
  await firstDrawerLink.click()
  const documentDrawer = page.getByRole('dialog', { name: '手工出入库单详情' })
  await documentDrawer.getByRole('link', { name: 'E2E-MAT', exact: true }).click()
  const materialDrawer = page.getByRole('dialog', { name: '物料详情' })
  await expect(materialDrawer).toBeVisible()
  await expect(materialDrawer.getByText('E2E-MAT', { exact: true }).first()).toBeVisible()
  await expect(materialDrawer.getByText('出入库行', { exact: true })).toHaveCount(0)
})

test('来源资源变体被权限裁剪时来源单号与来源单据均退为纯文本', async ({ page }) => {
  await loginViaUI(page)
  const purchase = PREVIEWS.find((item) => item.voucherType === 'purchase.receipt')!
  await installPreviewFixtures(page, [purchase])
  await page.route('**/api/v1/meta/resources/invStockEntries', async (route) => {
    const response = await route.fetch()
    const document = (await response.json()) as {
      fields?: Array<{ name?: string; variants?: Array<{ value?: string }> }>
    }
    const voucher = document.fields?.find((field) => field.name === 'voucherId')
    if (voucher?.variants) {
      voucher.variants = voucher.variants.filter((variant) => variant.value !== purchase.voucherType)
    }
    await fulfillJSON(route, document)
  })

  await page.goto('/inventory/stock-entries')
  // 变体被裁剪后目标资源解析失败:单元格退为纯文本(当前实现渲染截断 id 而非来源单号),
  // 且全行不再渲染任何链接——本条只锁定「无链接可点」这一安全语义
  const row = page.getByRole('row').filter({ hasText: purchase.id.slice(0, 8) })
  await expect(row).toBeVisible()
  await expect(row.getByRole('link')).toHaveCount(0)
})
