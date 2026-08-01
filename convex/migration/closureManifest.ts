export const transactionClosures = [
  { id: 'application-kernel', wave: 'pre-005', dependsOn: [], status: 'convex-verified' },
  { id: 'resource-plane-pilots', wave: 'pre-005', dependsOn: ['application-kernel'], status: 'convex-verified' },
  { id: 'facts-engines', wave: 'pre-005', dependsOn: ['application-kernel'], status: 'convex-verified' },
  { id: 'platform-master', wave: 'A', dependsOn: ['application-kernel', 'resource-plane-pilots', 'facts-engines'], status: 'convex-verified' },
  { id: 'party-master', wave: 'A', dependsOn: ['platform-master'], status: 'convex-verified' },
  { id: 'inventory-master', wave: 'A', dependsOn: ['platform-master'], status: 'convex-verified' },
  { id: 'accounting-documents', wave: 'B', dependsOn: ['platform-master', 'facts-engines'], status: 'convex-verified' },
  { id: 'inventory-documents', wave: 'B', dependsOn: ['inventory-master', 'facts-engines'], status: 'convex-verified' },
  { id: 'trading-quotations', wave: 'C', dependsOn: ['party-master', 'inventory-master'], status: 'convex-verified' },
  { id: 'trading-orders', wave: 'C', dependsOn: ['trading-quotations'], status: 'convex-verified' },
  { id: 'trading-fulfillment', wave: 'C', dependsOn: ['trading-orders', 'inventory-documents', 'accounting-documents'], status: 'convex-verified' },
  { id: 'trading-reconciliation', wave: 'C', dependsOn: ['trading-fulfillment'], status: 'convex-verified' },
  { id: 'finance-documents', wave: 'D', dependsOn: ['trading-reconciliation', 'accounting-documents'], status: 'convex-verified' },
  { id: 'manufacturing', wave: 'E', dependsOn: ['trading-orders', 'trading-fulfillment', 'inventory-documents'], status: 'convex-verified' },
  { id: 'hr-payroll', wave: 'E', dependsOn: ['party-master', 'accounting-documents'], status: 'convex-verified' },
  { id: 'market-todo-setup', wave: 'E', dependsOn: ['platform-master', 'party-master'], status: 'convex-verified' },
  { id: 'files-port', wave: '006', dependsOn: ['application-kernel'], status: 'convex-verified' },
  { id: 'printing-port', wave: '007', dependsOn: ['files-port'], status: 'convex-verified' },
] as const

export type TransactionClosureId = (typeof transactionClosures)[number]['id']

const pilotResources = new Set(['basCurrencies', 'basUnits', 'invWarehouses'])

export function closureForResource(resource: string): TransactionClosureId {
  if (pilotResources.has(resource)) return 'resource-plane-pilots'
  if (resource === 'sysFiles' || resource === 'sysStorages') return 'files-port'
  if (resource === 'sysPrintTemplates') return 'printing-port'
  if (resource.startsWith('basMarket')) return 'market-todo-setup'
  if (resource.startsWith('hr')) return resource === 'hrEmployees' ? 'party-master' : 'hr-payroll'
  if (resource === 'purSuppliers' || resource === 'salCustomers') return 'party-master'
  if (resource.startsWith('sysTodo')) return 'market-todo-setup'
  if (resource.startsWith('sys') || resource.startsWith('bas') || resource.endsWith('Settings')) return 'platform-master'
  if (resource === 'salCompanyAccountDefaults') return 'platform-master'
  if (resource.startsWith('invMaterial')) return 'inventory-master'
  if (resource.startsWith('invStock')) return 'inventory-documents'
  if (resource.startsWith('accGl')) return 'accounting-documents'
  if (resource.startsWith('salQuotation') || resource.startsWith('purQuotation')) return 'trading-quotations'
  if (resource.startsWith('salOrder') || resource.startsWith('purOrder')) return 'trading-orders'
  if (
    resource.startsWith('salDeliver') || resource.startsWith('purReceipt') ||
    resource.startsWith('purOutsourced')
  ) return 'trading-fulfillment'
  if (resource.startsWith('salReconciliation') || resource.startsWith('purReconciliation') || resource.startsWith('scmOrderFlow')) {
    return 'trading-reconciliation'
  }
  if (resource.startsWith('mfg')) return 'manufacturing'
  if (resource.startsWith('acc')) return 'finance-documents'
  throw new Error(`资源未分配事务闭包: ${resource}`)
}

export function closureDependencies(id: TransactionClosureId): readonly TransactionClosureId[] {
  return transactionClosures.find((closure) => closure.id === id)!.dependsOn
}

export const transactionSourceRules = [
  ['server/src/modules/base/market/', 'market-todo-setup', 'convex/domains/market/domain.ts', 5],
  ['server/src/modules/base/', 'platform-master', 'convex/domains/base/companies.ts', 13],
  ['server/src/modules/iam/', 'platform-master', 'convex/iam/model.ts', 8],
  ['server/src/modules/party/', 'party-master', 'convex/domains/party/parties.ts', 6],
  ['server/src/modules/accounting/', 'accounting-documents', 'convex/domains/accounting/documents.ts', 8],
  ['server/src/modules/inventory/category-', 'inventory-master', 'convex/domains/inventory/master.ts', 3],
  ['server/src/modules/inventory/material-', 'inventory-master', 'convex/domains/inventory/master.ts', 6],
  ['server/src/modules/inventory/warehouse-', 'resource-plane-pilots', 'convex/resources/warehouses.ts', 4],
  ['server/src/modules/inventory/', 'inventory-documents', 'convex/domains/inventory/documents.ts', 25],
  ['server/src/modules/sales/company-account-default', 'platform-master', 'convex/domains/platform/companyAccountDefaults.ts', 2],
  ['server/src/modules/trading/quotation/', 'trading-quotations', 'convex/domains/trading/quotations.ts', 13],
  ['server/src/modules/trading/order/', 'trading-orders', 'convex/domains/trading/orders.ts', 15],
  ['server/src/modules/trading/fulfillment/', 'trading-fulfillment', 'convex/domains/trading/fulfillment.ts', 12],
  ['server/src/modules/trading/outsourced/', 'trading-fulfillment', 'convex/domains/trading/fulfillment.ts', 21],
  ['server/src/modules/trading/reconciliation/', 'trading-reconciliation', 'convex/domains/trading/reconciliation.ts', 8],
  ['server/src/modules/finance/', 'finance-documents', 'convex/domains/finance/documents.ts', 37],
  ['server/src/modules/manufacturing/', 'manufacturing', 'convex/domains/manufacturing/domain.ts', 49],
  ['server/src/modules/hr/', 'hr-payroll', 'convex/domains/hr/domain.ts', 18],
  ['server/src/platform/numbering/', 'facts-engines', 'convex/platform/numbering/model.ts', 5],
  ['server/src/platform/audit/', 'facts-engines', 'convex/platform/audit/model.ts', 0],
  ['server/src/platform/settings/', 'platform-master', 'convex/domains/platform/settings.ts', 2],
  ['server/src/platform/todo/', 'market-todo-setup', 'convex/domains/todo/domain.ts', 1],
  ['server/src/platform/setup/', 'market-todo-setup', 'convex/setup/model.ts', 5],
  ['server/src/platform/files/', 'files-port', 'convex/files/domain.ts', 8],
  ['server/src/platform/printing/', 'printing-port', 'convex/platform/printing/templates.ts', 5],
] as const satisfies readonly (readonly [string, TransactionClosureId, string, number])[]
