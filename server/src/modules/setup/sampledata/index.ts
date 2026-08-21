/**
 * 全业务链示例数据编排（对齐 server-go sampledata.Seed）。
 * 整组成功标记：银行账号 377601886688901；中途失败留下半成品时整组 wipe 后重跑。
 */
import type { Actor } from '~/platform/authz/core/index.ts'
import {
  alreadySeeded,
  loadCompany,
  partialSampleStarted,
  wipePartialSample,
} from './helpers.ts'
import { seedFinance } from './finance.ts'
import { seedInventoryDocuments, seedOpeningStock } from './inventory.ts'
import { seedMaster, seedPrerequisites } from './master.ts'
import { seedMfg } from './mfg.ts'
import { seedOutsourced } from './outsourced.ts'
import { seedPurchase } from './purchase.ts'
import { seedSales } from './sales.ts'
import type { SampleDataDeps, SampleSummary } from './types.ts'

export type { SampleDataDeps, SampleSummary } from './types.ts'

export async function seedSampleData(
  deps: SampleDataDeps,
  actor: Actor,
  companyId: string,
): Promise<SampleSummary> {
  if (await alreadySeeded(deps.db)) {
    return emptySummary()
  }
  if (await partialSampleStarted(deps.db)) {
    await wipePartialSample(deps.db)
  }
  if (!companyId) {
    return emptySummary()
  }

  const company = await loadCompany(deps.db, companyId)
  const seedContext = await seedPrerequisites(deps, actor, company)
  const md = await seedMaster(deps, actor, company)
  const openingDocs = await seedOpeningStock(deps, actor, seedContext, md)
  const purchase = await seedPurchase(deps, actor, seedContext, md)
  const sales = await seedSales(deps, actor, seedContext, md)
  const invDocs = await seedInventoryDocuments(deps, actor, seedContext, md)
  const mfg = await seedMfg(deps, actor, md)
  const out = await seedOutsourced(deps, actor, seedContext, md)
  const finance = await seedFinance(deps, actor, seedContext, md, sales, purchase)

  return {
    customers: Object.keys(md.customers).length,
    suppliers: Object.keys(md.suppliers).length,
    materials: Object.keys(md.materials).length,
    employees: Object.keys(md.employees).length,
    salesQuotations: sales.quotations.length,
    purchaseQuotations: purchase.quotations.length,
    salesOrders: sales.orders.length,
    purchaseOrders: purchase.orders.length,
    salesDeliveries: sales.deliveries.length,
    purchaseReceipts: purchase.receipts.length,
    salesReconciliations: sales.reconciliations.length,
    purchaseReconciliations: purchase.reconciliations.length + out.reconciliations.length,
    stockDocs: openingDocs + invDocs.stockDocs,
    stockTransfers: 1,
    stockCounts: 1,
    operations: mfg.operations.length,
    processTemplates: mfg.processTemplates.length,
    boms: mfg.boms.length + out.boms.length,
    bankAccounts: 1,
    bankTransactions: finance.bankTransactions,
    glJournals: finance.glJournals,
    expenseReports: 1,
    payrolls: finance.payrolls,
    vatInvoices: finance.vatInvoices,
    outsourcedOrders: out.orders.length,
    outsourcedIssues: out.issues.length,
    outsourcedReceipts: out.receipts.length,
  }
}

function emptySummary(): SampleSummary {
  return {
    customers: 0,
    suppliers: 0,
    materials: 0,
    employees: 0,
    salesQuotations: 0,
    purchaseQuotations: 0,
    salesOrders: 0,
    purchaseOrders: 0,
    salesDeliveries: 0,
    purchaseReceipts: 0,
    salesReconciliations: 0,
    purchaseReconciliations: 0,
    stockDocs: 0,
    stockTransfers: 0,
    stockCounts: 0,
    operations: 0,
    processTemplates: 0,
    boms: 0,
    bankAccounts: 0,
    bankTransactions: 0,
    glJournals: 0,
    expenseReports: 0,
    payrolls: 0,
    vatInvoices: 0,
    outsourcedOrders: 0,
    outsourcedIssues: 0,
    outsourcedReceipts: 0,
  }
}
