import { v } from 'convex/values'
import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'
import { internalMutation, internalQuery } from '../_generated/server'
import type { DataModel, Doc, Id } from '../_generated/dataModel'
import { actorForAppUser, type Actor } from '../lib/actor'
import { authedQuery } from '../lib/auth'
import { asDomainMutationCtx, type DomainMutationCtx } from '../lib/mutationContext'
import { synieError } from '../lib/errors'
import { writeAudit } from '../platform/audit/write'
import { normalizeWarehouse } from '../resources/model'
import { createCompanyAccountDefaultsInMutation } from '../domains/platform/companyAccountDefaults'
import { createInventoryDraftInMutation } from '../domains/inventory/drafts'
import { createTradingDraftInMutation } from '../domains/trading/drafts'
import { createReconciliationDraftInMutation } from '../domains/trading/reconciliationDrafts'
import { createOutsourcedDraftInMutation } from '../domains/trading/fulfillmentDrafts'
import { createManufacturingDraftInMutation } from '../domains/manufacturing/drafts'
import { createJournalDraftInMutation } from '../domains/accounting/drafts'
import { createExpenseDraftInMutation } from '../domains/finance/drafts'
import { createBankAccountRecord, createBankTransactionRecord } from '../domains/finance/banking'
import { createPaymentRecord, createPayrollRecord } from '../domains/hr/payroll'
import { createDomainRecord } from '../domains/shared/records'
import { executeCommandInMutation } from '../domains/commands'

type MutationCtx = GenericMutationCtx<DataModel>
type Wire = Record<string, unknown>

const STAGES = [
  'master',
  'inventory',
  'sales',
  'purchase',
  'manufacturing',
  'outsourced',
  'finance',
  'done',
] as const
type SampleStage = (typeof STAGES)[number]

type SampleData = {
  companyId: Id<'companies'>
  currencyId?: Id<'currencies'>
  unitId?: Id<'units'>
  customerId?: Id<'customers'>
  supplierId?: Id<'suppliers'>
  employeeId?: Id<'employees'>
  productId?: Id<'materials'>
  componentId?: Id<'materials'>
  defaultWarehouseId?: Id<'warehouses'>
  transitWarehouseId?: Id<'warehouses'>
  finishedWarehouseId?: Id<'warehouses'>
  outsourcedWarehouseId?: Id<'warehouses'>
  debitAccountId?: Id<'accounts'>
  creditAccountId?: Id<'accounts'>
  receivableAccountId?: Id<'accounts'>
  payableAccountId?: Id<'accounts'>
  expenseAccountId?: Id<'accounts'>
  salesOrderItemId?: string
  purchaseOrderItemId?: string
}

function sampleData(value: unknown): SampleData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw synieError('internal', '示例数据恢复记录损坏')
  }
  return value as SampleData
}

function stage(value: string | undefined): SampleStage {
  if (!value || !(STAGES as readonly string[]).includes(value)) {
    throw synieError('internal', '示例数据阶段记录损坏')
  }
  return value as SampleStage
}

async function ownedState(
  ctx: Pick<GenericMutationCtx<DataModel> | GenericQueryCtx<DataModel>, 'db'>,
  userId: Id<'appUsers'>,
) {
  const state = await ctx.db.query('setupState').withIndex('by_key', (query) =>
    query.eq('key', 'singleton'),
  ).unique()
  if (!state || state.firstAdminUserId !== userId) {
    throw synieError('forbidden', '只有首位超级管理员可生成示例数据')
  }
  if (!state.sampleRequested || !state.firstCompanyId) {
    throw synieError('conflict', '当前初始化没有待生成的示例数据')
  }
  return state
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined || value === null || value === '') {
    throw synieError('internal', `示例数据缺少 ${label}`)
  }
  return value
}

function wireId(value: Wire): string {
  return required(typeof value.id === 'string' ? value.id : undefined, '记录标识')
}

function items(value: Wire): Wire[] {
  if (!Array.isArray(value.items)) throw synieError('internal', '示例聚合缺少条目')
  return value.items as Wire[]
}

async function setNext(
  ctx: MutationCtx,
  state: Doc<'setupState'>,
  next: SampleStage,
  data: SampleData,
): Promise<void> {
  await ctx.db.patch(state._id, { sampleStage: next, sampleData: data })
}

async function sampleAudit(
  ctx: DomainMutationCtx,
  actor: Actor,
  resource: string,
  id: string,
  label: string,
  changes: Record<string, unknown>,
): Promise<void> {
  await writeAudit(ctx, actor, {
    resource,
    recordId: id,
    recordLabel: label,
    action: 'create',
    changes,
  })
}

async function seedMaster(
  rawCtx: MutationCtx,
  ctx: DomainMutationCtx,
  actor: Actor,
  state: Doc<'setupState'>,
  data: SampleData,
): Promise<void> {
  if (await rawCtx.db.query('customers').withIndex('by_code_key', (q) => q.eq('codeKey', 'c01')).unique()) {
    throw synieError('conflict', '客户 C01 已存在，无法安全生成示例数据')
  }
  const company = await rawCtx.db.get(data.companyId)
  if (!company) throw synieError('internal', '示例公司不存在')
  const [unit, productCategory, componentCategory] = await Promise.all([
    rawCtx.db.query('units').withIndex('by_symbol_key', (q) => q.eq('symbolKey', 'pcs')).unique(),
    rawCtx.db.query('materialCategories').withIndex('by_code_key', (q) => q.eq('codeKey', 'f(p)')).unique(),
    rawCtx.db.query('materialCategories').withIndex('by_code_key', (q) => q.eq('codeKey', 'm(c)')).unique(),
  ])
  if (!unit || !productCategory || !componentCategory) {
    throw synieError('internal', '示例数据缺少单位或物料分类种子')
  }
  const now = Date.now()
  const customerId = await rawCtx.db.insert('customers', {
    code: 'C01', codeKey: 'c01', name: '江南精密制造', shortName: '江南精密',
    searchText: 'c01 江南精密制造 江南精密', insertedAt: now, updatedAt: now,
  })
  const supplierId = await rawCtx.db.insert('suppliers', {
    code: 'S01', codeKey: 's01', name: '华东材料供应', shortName: '华东材料',
    searchText: 's01 华东材料供应 华东材料', insertedAt: now, updatedAt: now,
  })
  const employeeId = await rawCtx.db.insert('employees', {
    code: 'H(E)-0001', codeKey: 'h(e)-0001', name: '演示员工', attendanceNo: 'DEMO-001',
    idNumber: null, householdRegistration: null, phone: null, currentAddress: null,
    dailyWage: 30_000n, monthlyAllowance: 50_000n, insuranceTypes: [],
    searchText: 'h(e)-0001 演示员工 demo-001', insertedAt: now, updatedAt: now,
  })
  const productId = await rawCtx.db.insert('materials', {
    code: 'F(P)C01-1', codeKey: 'f(p)c01-1', name: '演示精密零件', spec: 'DEMO-100',
    customerPartNo: 'C01-PN-001', isCustomerMaterial: true, active: true,
    categoryId: productCategory._id, defaultUnitId: unit._id, customerId,
    searchText: 'f(p)c01-1 演示精密零件 demo-100', insertedAt: now, updatedAt: now,
  })
  const componentId = await rawCtx.db.insert('materials', {
    code: 'M(C)-1', codeKey: 'm(c)-1', name: '演示通用配料', spec: 'RAW-100',
    customerPartNo: null, isCustomerMaterial: false, active: true,
    categoryId: componentCategory._id, defaultUnitId: unit._id, customerId: null,
    searchText: 'm(c)-1 演示通用配料 raw-100', insertedAt: now, updatedAt: now,
  })

  const accounts = await rawCtx.db.query('accounts').withIndex('by_company_code_key', (q) =>
    q.eq('companyId', company._id),
  ).collect()
  const leaves = accounts.filter((row) => !row.isGroup && row.active)
  const debit = leaves.find((row) => row.direction === 'DEBIT')
  const credit = leaves.find((row) => row.direction === 'CREDIT')
  const receivable = leaves.find((row) => row.role === 'receivable') ?? debit
  const payable = leaves.find((row) => row.role === 'payable') ?? credit
  const expense = leaves.find((row) => row.role === 'other_expense') ?? debit
  if (!debit || !credit || !receivable || !payable || !expense) {
    throw synieError('internal', '科目模板缺少示例业务所需明细科目')
  }
  await createCompanyAccountDefaultsInMutation(ctx, actor, {
    companyId: company._id,
    deliveryDebitAccountId: receivable._id,
    deliveryCreditAccountId: credit._id,
    receiptDebitAccountId: debit._id,
    receiptCreditAccountId: payable._id,
  })

  const warehouses = await rawCtx.db.query('warehouses').withIndex('by_company_name_key', (q) =>
    q.eq('companyId', company._id),
  ).collect()
  const root = warehouses.find((row) => row.name.endsWith('所有仓库') && !row.isLeaf)
  const defaultWarehouse = warehouses.find((row) => row.name.endsWith('默认仓库'))
  const transitWarehouse = warehouses.find((row) => row.name.endsWith('在途'))
  if (!root || !defaultWarehouse || !transitWarehouse) throw synieError('internal', '示例公司三仓种子不完整')
  const finishedNormalized = normalizeWarehouse({
    name: `${company.code} - 成品仓`, companyId: company._id, parentId: root._id,
  })
  const finishedWarehouseId = await rawCtx.db.insert('warehouses', {
    ...finishedNormalized, parentId: root._id, insertedAt: now, updatedAt: now,
  })
  const outsourcedNormalized = normalizeWarehouse({
    name: `${company.code} - 外协仓`, companyId: company._id, parentId: root._id,
    isOutsourced: true, partyType: 'SUPPLIER', partyId: supplierId,
  })
  const outsourcedWarehouseId = await rawCtx.db.insert('warehouses', {
    ...outsourcedNormalized, parentId: root._id, insertedAt: now, updatedAt: now,
  })

  await sampleAudit(ctx, actor, 'salCustomers', customerId, '江南精密制造', { code: 'C01', name: '江南精密制造' })
  await sampleAudit(ctx, actor, 'purSuppliers', supplierId, '华东材料供应', { code: 'S01', name: '华东材料供应' })
  await sampleAudit(ctx, actor, 'hrEmployees', employeeId, '演示员工', { code: 'H(E)-0001', name: '演示员工' })
  await sampleAudit(ctx, actor, 'invMaterials', productId, '演示精密零件', { code: 'F(P)C01-1', name: '演示精密零件' })
  await sampleAudit(ctx, actor, 'invMaterials', componentId, '演示通用配料', { code: 'M(C)-1', name: '演示通用配料' })
  for (const warehouseId of [finishedWarehouseId, outsourcedWarehouseId]) {
    const warehouse = (await rawCtx.db.get(warehouseId))!
    await sampleAudit(ctx, actor, 'invWarehouses', warehouseId, warehouse.name, {
      name: warehouse.name, companyId: warehouse.companyId, parentId: warehouse.parentId,
      isLeaf: warehouse.isLeaf, isOutsourced: warehouse.isOutsourced,
    })
  }
  await setNext(rawCtx, state, 'inventory', {
    ...data,
    currencyId: company.baseCurrencyId,
    unitId: unit._id,
    customerId,
    supplierId,
    employeeId,
    productId,
    componentId,
    defaultWarehouseId: defaultWarehouse._id,
    transitWarehouseId: transitWarehouse._id,
    finishedWarehouseId,
    outsourcedWarehouseId,
    debitAccountId: debit._id,
    creditAccountId: credit._id,
    receivableAccountId: receivable._id,
    payableAccountId: payable._id,
    expenseAccountId: expense._id,
  })
}

async function seedInventory(
  rawCtx: MutationCtx,
  ctx: DomainMutationCtx,
  actor: Actor,
  state: Doc<'setupState'>,
  data: SampleData,
): Promise<void> {
  const companyId = data.companyId
  const unitId = required(data.unitId, '单位')
  const productId = required(data.productId, '成品')
  const componentId = required(data.componentId, '配料')
  const defaultWarehouseId = required(data.defaultWarehouseId, '默认仓')
  const finishedWarehouseId = required(data.finishedWarehouseId, '成品仓')
  const transitWarehouseId = required(data.transitWarehouseId, '在途仓')
  const today = new Date().toISOString().slice(0, 10)
  const opening = await createInventoryDraftInMutation(rawCtx, actor, 'invStockDocs', {
    companyId, direction: 'IN', docDate: today, warehouseId: defaultWarehouseId,
    summary: '示例期初入库', remarks: '初始化示例数据',
    items: [
      { idx: 1, qty: '1000', materialId: productId, unitId, remark: null },
      { idx: 2, qty: '1000', materialId: componentId, unitId, remark: null },
    ],
  })
  await executeCommandInMutation(ctx, actor, { resource: 'invStockDocs', id: wireId(opening), key: 'audit' })
  const stockOut = await createInventoryDraftInMutation(rawCtx, actor, 'invStockDocs', {
    companyId, direction: 'OUT', docDate: today, warehouseId: defaultWarehouseId,
    summary: '示例领料出库', remarks: '初始化示例数据',
    items: [{ idx: 1, qty: '5', materialId: componentId, unitId, remark: null }],
  })
  await executeCommandInMutation(ctx, actor, { resource: 'invStockDocs', id: wireId(stockOut), key: 'audit' })
  const transfer = await createInventoryDraftInMutation(rawCtx, actor, 'invStockTransfers', {
    companyId, docDate: today, fromWarehouseId: defaultWarehouseId,
    toWarehouseId: finishedWarehouseId, transitWarehouseId,
    summary: '示例成品调拨', remarks: '初始化示例数据',
    items: [{ idx: 1, qty: '10', materialId: productId, unitId, remark: null }],
  })
  await executeCommandInMutation(ctx, actor, { resource: 'invStockTransfers', id: wireId(transfer), key: 'ship' })
  await executeCommandInMutation(ctx, actor, { resource: 'invStockTransfers', id: wireId(transfer), key: 'receive' })
  const count = await createInventoryDraftInMutation(rawCtx, actor, 'invStockCounts', {
    companyId, postingDate: today, warehouseId: defaultWarehouseId,
    summary: '示例库存盘点', remarks: '初始化示例数据',
    items: [{ countedQuantity: '989', materialId: productId, unitId, remark: '盘亏 1 件' }],
  })
  await executeCommandInMutation(ctx, actor, { resource: 'invStockCounts', id: wireId(count), key: 'approve' })
  await setNext(rawCtx, state, 'sales', data)
}

async function seedSales(
  rawCtx: MutationCtx,
  ctx: DomainMutationCtx,
  actor: Actor,
  state: Doc<'setupState'>,
  data: SampleData,
): Promise<void> {
  const companyId = data.companyId
  const currencyId = required(data.currencyId, '币种')
  const customerId = required(data.customerId, '客户')
  const productId = required(data.productId, '成品')
  const unitId = required(data.unitId, '单位')
  const warehouseId = required(data.defaultWarehouseId, '默认仓')
  const debitAccountId = required(data.receivableAccountId, '应收科目')
  const creditAccountId = required(data.creditAccountId, '收入科目')
  const today = new Date().toISOString().slice(0, 10)
  const quotation = await createTradingDraftInMutation(rawCtx, actor, 'salQuotations', {
    companyId, quotationDate: today, validUntil: today, partyType: 'CUSTOMER', partyId: customerId,
    currencyId, terms: '示例报价', remarks: null,
    items: [{ idx: 1, materialId: productId, unitId, pricingMode: 'FIXED', price: '100', taxRate: '0', remarks: null, tiers: [] }],
  })
  await executeCommandInMutation(ctx, actor, { resource: 'salQuotations', id: wireId(quotation), key: 'audit' })
  const quotationItemId = wireId(items(quotation)[0]!)
  const order = await createTradingDraftInMutation(rawCtx, actor, 'salOrders', {
    companyId, orderDate: today, orderType: 'REGULAR', partyType: 'CUSTOMER', partyId: customerId,
    currencyId, exchangeRate: '1', terms: null, remarks: '示例销售订单',
    items: [{ idx: 1, qty: '20', materialId: productId, unitId, price: '100', taxRate: '0', remarks: null, quotationItemId, issueLines: [], byproductLines: [] }],
  })
  await executeCommandInMutation(ctx, actor, { resource: 'salOrders', id: wireId(order), key: 'audit' })
  const orderItemId = wireId(items(order)[0]!)
  const delivery = await createTradingDraftInMutation(rawCtx, actor, 'salDeliveries', {
    companyId, deliveryDate: today, postingDate: today, partyType: 'CUSTOMER', partyId: customerId,
    warehouseId, debitAccountId, creditAccountId, remarks: '示例销售发货',
    items: [{ idx: 1, qty: '5', orderItemId, unitId, warehouseId, remarks: null }],
    packBoxes: [],
  })
  await executeCommandInMutation(ctx, actor, { resource: 'salDeliveries', id: wireId(delivery), key: 'audit' })
  const deliveryItemId = wireId(items(delivery)[0]!)
  const reconciliation = await createReconciliationDraftInMutation(rawCtx, actor, 'salReconciliations', {
    companyId, reconciliationType: 'REGULAR', partyType: 'CUSTOMER', partyId: customerId,
    debitAccountId, creditAccountId, remarks: '示例销售对账',
    items: [{ idx: 1, qty: '5', deliveryItemId, remarks: null }],
  })
  await executeCommandInMutation(ctx, actor, { resource: 'salReconciliations', id: wireId(reconciliation), key: 'confirm' })
  const invoice = await createDomainRecord(rawCtx, actor, 'accVatInvoices', {
    companyId, direction: 'OUTBOUND', invoiceDate: today, partyType: 'CUSTOMER', partyId: customerId,
    invoiceKind: 'NORMAL', invoiceNo: 'DEMO-SALES-001', netTotal: '500', taxTotal: '0', grossTotal: '500',
    partyAccountId: debitAccountId, amountAccountId: creditAccountId,
    salReconciliationId: wireId(reconciliation), remarks: '示例销项发票',
  })
  await executeCommandInMutation(ctx, actor, { resource: 'accVatInvoices', id: wireId(invoice), key: 'audit' })
  await setNext(rawCtx, state, 'purchase', { ...data, salesOrderItemId: orderItemId })
}

async function seedPurchase(
  rawCtx: MutationCtx,
  ctx: DomainMutationCtx,
  actor: Actor,
  state: Doc<'setupState'>,
  data: SampleData,
): Promise<void> {
  const companyId = data.companyId
  const currencyId = required(data.currencyId, '币种')
  const supplierId = required(data.supplierId, '供应商')
  const componentId = required(data.componentId, '配料')
  const unitId = required(data.unitId, '单位')
  const warehouseId = required(data.defaultWarehouseId, '默认仓')
  const debitAccountId = required(data.debitAccountId, '存货科目')
  const creditAccountId = required(data.payableAccountId, '应付科目')
  const today = new Date().toISOString().slice(0, 10)
  const quotation = await createTradingDraftInMutation(rawCtx, actor, 'purQuotations', {
    companyId, quotationDate: today, validUntil: today, partyType: 'SUPPLIER', partyId: supplierId,
    currencyId, terms: '示例采购报价', remarks: null,
    items: [{ idx: 1, materialId: componentId, unitId, pricingMode: 'FIXED', price: '20', taxRate: '0', remarks: null, tiers: [] }],
  })
  await executeCommandInMutation(ctx, actor, { resource: 'purQuotations', id: wireId(quotation), key: 'audit' })
  const order = await createTradingDraftInMutation(rawCtx, actor, 'purOrders', {
    companyId, orderDate: today, orderType: 'REGULAR', isOutsourced: false,
    partyType: 'SUPPLIER', partyId: supplierId, currencyId, exchangeRate: '1', remarks: '示例采购订单',
    items: [{ idx: 1, qty: '20', materialId: componentId, unitId, price: '20', taxRate: '0', remarks: null, quotationItemId: wireId(items(quotation)[0]!), bomId: null, demandLineId: null, demandDate: null, issueLines: [], byproductLines: [] }],
  })
  await executeCommandInMutation(ctx, actor, { resource: 'purOrders', id: wireId(order), key: 'audit' })
  const orderItemId = wireId(items(order)[0]!)
  const receipt = await createTradingDraftInMutation(rawCtx, actor, 'purReceipts', {
    companyId, receiptDate: today, postingDate: today, partyType: 'SUPPLIER', partyId: supplierId,
    warehouseId, debitAccountId, creditAccountId, remarks: '示例采购入库',
    items: [{ idx: 1, qty: '5', orderItemId, unitId, warehouseId, remarks: null }],
  })
  await executeCommandInMutation(ctx, actor, { resource: 'purReceipts', id: wireId(receipt), key: 'audit' })
  const reconciliation = await createReconciliationDraftInMutation(rawCtx, actor, 'purReconciliations', {
    companyId, reconciliationType: 'REGULAR', partyType: 'SUPPLIER', partyId: supplierId,
    debitAccountId, creditAccountId, remarks: '示例采购对账',
    items: [{ idx: 1, qty: '5', receiptItemId: wireId(items(receipt)[0]!), outsourcedReceiptItemId: null, remarks: null }],
  })
  await executeCommandInMutation(ctx, actor, { resource: 'purReconciliations', id: wireId(reconciliation), key: 'confirm' })
  const invoice = await createDomainRecord(rawCtx, actor, 'accVatInvoices', {
    companyId, direction: 'INBOUND', invoiceDate: today, partyType: 'SUPPLIER', partyId: supplierId,
    invoiceKind: 'NORMAL', invoiceNo: 'DEMO-PURCHASE-001', netTotal: '100', taxTotal: '0', grossTotal: '100',
    partyAccountId: creditAccountId, amountAccountId: debitAccountId,
    purReconciliationId: wireId(reconciliation), remarks: '示例进项发票',
  })
  await executeCommandInMutation(ctx, actor, { resource: 'accVatInvoices', id: wireId(invoice), key: 'audit' })
  await setNext(rawCtx, state, 'manufacturing', { ...data, purchaseOrderItemId: orderItemId })
}

async function seedManufacturing(
  rawCtx: MutationCtx,
  ctx: DomainMutationCtx,
  actor: Actor,
  state: Doc<'setupState'>,
  data: SampleData,
): Promise<void> {
  const companyId = data.companyId
  const productId = required(data.productId, '成品')
  const componentId = required(data.componentId, '配料')
  const unitId = required(data.unitId, '单位')
  const finishedWarehouseId = required(data.finishedWarehouseId, '成品仓')
  const today = new Date().toISOString().slice(0, 10)
  const operation = await createDomainRecord(rawCtx, actor, 'mfgOperations', { name: '示例装配' })
  await createManufacturingDraftInMutation(rawCtx, actor, 'mfgProcessTemplates', {
    name: '示例装配工艺', note: '初始化示例数据',
    items: [{ seq: 10, operationId: wireId(operation), requirement: '按图装配并检验', isOutsourced: false }],
  })
  const bom = await createManufacturingDraftInMutation(rawCtx, actor, 'mfgBoms', {
    planName: '示例精密零件 BOM', note: '初始化示例数据', materialId: productId,
    components: [{ materialId: componentId, unitId, quantity: '2', lossRate: '0', note: null }],
    routes: [{ seq: 10, operationId: wireId(operation), requirement: '按图装配并检验', isOutsourced: false }],
    byproducts: [],
  })
  await executeCommandInMutation(ctx, actor, { resource: 'mfgBoms', id: wireId(bom), key: 'activate' })
  const demand = await createManufacturingDraftInMutation(rawCtx, actor, 'mfgDemands', {
    companyId, demandDate: today, remarks: '示例销售履约需求',
    items: [{ idx: 1, materialId: productId, unitId, qty: '15', needDate: today, salesOrderItemId: required(data.salesOrderItemId, '销售订单行'), remarks: null }],
  })
  await executeCommandInMutation(ctx, actor, { resource: 'mfgDemands', id: wireId(demand), key: 'audit' })
  const workOrder = await createManufacturingDraftInMutation(rawCtx, actor, 'mfgWorkOrders', {
    demandItemId: wireId(items(demand)[0]!), qty: '15', bomId: wireId(bom),
  })
  const output = await createManufacturingDraftInMutation(rawCtx, actor, 'mfgOutputs', {
    companyId, outputDate: today, warehouseId: finishedWarehouseId, remarks: '示例生产入库',
    items: [{ idx: 1, workOrderId: wireId(workOrder), unitId, qty: '15', warehouseId: finishedWarehouseId, remarks: null }],
  })
  await executeCommandInMutation(ctx, actor, { resource: 'mfgOutputs', id: wireId(output), key: 'audit' })
  await setNext(rawCtx, state, 'outsourced', data)
}

async function seedOutsourced(
  rawCtx: MutationCtx,
  ctx: DomainMutationCtx,
  actor: Actor,
  state: Doc<'setupState'>,
  data: SampleData,
): Promise<void> {
  const companyId = data.companyId
  const supplierId = required(data.supplierId, '供应商')
  const productId = required(data.productId, '成品')
  const componentId = required(data.componentId, '配料')
  const unitId = required(data.unitId, '单位')
  const currencyId = required(data.currencyId, '币种')
  const defaultWarehouseId = required(data.defaultWarehouseId, '默认仓')
  const finishedWarehouseId = required(data.finishedWarehouseId, '成品仓')
  const outsourcedWarehouseId = required(data.outsourcedWarehouseId, '外协仓')
  const debitAccountId = required(data.debitAccountId, '存货科目')
  const creditAccountId = required(data.payableAccountId, '应付科目')
  const today = new Date().toISOString().slice(0, 10)
  const order = await createTradingDraftInMutation(rawCtx, actor, 'purOrders', {
    companyId, orderDate: today, orderType: 'REGULAR', isOutsourced: true,
    partyType: 'SUPPLIER', partyId: supplierId, currencyId, exchangeRate: '1', remarks: '示例委外订单',
    items: [{
      idx: 1, qty: '5', materialId: productId, unitId, price: '30', taxRate: '0', remarks: null,
      quotationItemId: null, bomId: null, demandLineId: null, demandDate: null,
      issueLines: [{ materialId: componentId, unitId, quantity: '10', remarks: null }], byproductLines: [],
    }],
  })
  await executeCommandInMutation(ctx, actor, { resource: 'purOrders', id: wireId(order), key: 'audit' })
  const orderItem = items(order)[0]!
  const issueLine = required(Array.isArray(orderItem.issueLines) ? (orderItem.issueLines as Wire[])[0] : undefined, '委外发料配置')
  const issue = await createOutsourcedDraftInMutation(rawCtx, actor, 'purOutsourcedIssues', {
    companyId, issueDate: today, partyType: 'SUPPLIER', partyId: supplierId,
    fromWarehouseId: defaultWarehouseId, outsourcedWarehouseId, remarks: '示例委外发料',
    items: [{ idx: 1, qty: '10', orderItemMaterialId: wireId(issueLine), fromWarehouseId: defaultWarehouseId, outsourcedWarehouseId, remarks: null }],
  })
  await executeCommandInMutation(ctx, actor, { resource: 'purOutsourcedIssues', id: wireId(issue), key: 'audit' })
  const receipt = await createOutsourcedDraftInMutation(rawCtx, actor, 'purOutsourcedReceipts', {
    companyId, receiptDate: today, postingDate: today, partyType: 'SUPPLIER', partyId: supplierId,
    warehouseId: finishedWarehouseId, outsourcedWarehouseId, debitAccountId, creditAccountId,
    remarks: '示例委外入库',
    items: [{
      idx: 1, qty: '5', orderItemId: wireId(orderItem), unitId, warehouseId: finishedWarehouseId,
      remarks: null, materialLines: [{ idx: 1, qty: '10', orderItemMaterialId: wireId(issueLine), outsourcedWarehouseId, remarks: null }], byproductLines: [],
    }],
  })
  await executeCommandInMutation(ctx, actor, { resource: 'purOutsourcedReceipts', id: wireId(receipt), key: 'audit' })
  const reconciliation = await createReconciliationDraftInMutation(rawCtx, actor, 'purReconciliations', {
    companyId, reconciliationType: 'REGULAR', partyType: 'SUPPLIER', partyId: supplierId,
    debitAccountId, creditAccountId, remarks: '示例委外加工费对账',
    items: [{ idx: 1, qty: '5', receiptItemId: null, outsourcedReceiptItemId: wireId(items(receipt)[0]!), remarks: null }],
  })
  await executeCommandInMutation(ctx, actor, { resource: 'purReconciliations', id: wireId(reconciliation), key: 'confirm' })
  const invoice = await createDomainRecord(rawCtx, actor, 'accVatInvoices', {
    companyId, direction: 'INBOUND', invoiceDate: today, partyType: 'SUPPLIER', partyId: supplierId,
    invoiceKind: 'NORMAL', invoiceNo: 'DEMO-OUTSOURCE-001', netTotal: '150', taxTotal: '0', grossTotal: '150',
    partyAccountId: creditAccountId, amountAccountId: debitAccountId,
    purReconciliationId: wireId(reconciliation), remarks: '示例委外加工费发票',
  })
  await executeCommandInMutation(ctx, actor, { resource: 'accVatInvoices', id: wireId(invoice), key: 'audit' })
  await setNext(rawCtx, state, 'finance', data)
}

async function seedFinance(
  rawCtx: MutationCtx,
  ctx: DomainMutationCtx,
  actor: Actor,
  state: Doc<'setupState'>,
  data: SampleData,
): Promise<void> {
  const companyId = data.companyId
  const currencyId = required(data.currencyId, '币种')
  const employeeId = required(data.employeeId, '员工')
  const debitAccountId = required(data.debitAccountId, '借方科目')
  const creditAccountId = required(data.creditAccountId, '贷方科目')
  const expenseAccountId = required(data.expenseAccountId, '费用科目')
  const today = new Date().toISOString().slice(0, 10)
  const bank = await createBankAccountRecord(rawCtx, actor, {
    alias: '示例基本户', bankName: '示例银行', branchName: '营业部', holderName: '示例公司',
    accountNo: '377601886688901', active: true, companyId, currencyId, accountId: debitAccountId,
  })
  await createBankTransactionRecord(rawCtx, actor, {
    occurredAt: new Date().toISOString(), income: '200000', expense: null, balance: '200000',
    counterpartyName: '股东', summary: '示例股东注资', companyId, bankAccountId: wireId(bank),
  })
  const journal = await createJournalDraftInMutation(rawCtx, actor, {
    companyId, date: today, postingDate: today, remarks: '示例期初实收资本入账',
    lines: [
      { idx: 1, accountId: debitAccountId, debit: '200000', credit: '0', remarks: '银行存款' },
      { idx: 2, accountId: creditAccountId, debit: '0', credit: '200000', remarks: '实收资本' },
    ],
  })
  await executeCommandInMutation(ctx, actor, { resource: 'accGlJournals', id: wireId(journal), key: 'audit' })
  const expense = await createExpenseDraftInMutation(rawCtx, actor, {
    companyId, expenseDate: today, postingDate: today, employeeId,
    paymentAccountId: debitAccountId, remarks: '示例费用报销',
    items: [{ idx: 1, kind: 'MANUAL', summary: '客户拜访差旅费', amount: '100', expenseAccountId, remarks: null }],
  })
  await executeCommandInMutation(ctx, actor, { resource: 'accExpenseReports', id: wireId(expense), key: 'audit' })
  const payroll = await createPayrollRecord(rawCtx, actor, {
    employeeId, month: today.slice(0, 7), workdays: '22', attendanceDays: 22, missingDays: 0,
    overtimeHours: '0', dailyWage: '300', allowance: '500', bonus: '0', fine: '0',
    loanDeduction: '0', remarks: '示例工资单',
  })
  await createPaymentRecord(rawCtx, actor, {
    payrollId: wireId(payroll), paidOn: today, amount: String(payroll.payable), remarks: '示例工资发放',
  })
  await setNext(rawCtx, state, 'done', data)
}

async function finish(rawCtx: MutationCtx, state: Doc<'setupState'>): Promise<void> {
  const now = Date.now()
  await rawCtx.db.patch(state._id, {
    sampleStage: 'done',
    sampleSeededAt: now,
    completedAt: now,
  })
}

export const planForAction = internalQuery({
  args: { userId: v.id('appUsers') },
  returns: v.object({ stage: v.string(), completed: v.boolean() }),
  handler: async (ctx, args) => {
    const state = await ownedState(ctx, args.userId)
    return {
      stage: state.completedAt !== undefined ? 'done' : stage(state.sampleStage),
      completed: state.completedAt !== undefined,
    }
  },
})

export const summary = authedQuery({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const state = await ownedState(ctx, ctx.actor.userId)
    const companyId = state.firstCompanyId!
    const countResource = async (
      table: 'accountingDocuments' | 'inventoryDocuments' | 'tradingDocuments' |
        'financeDocuments' | 'manufacturingDocuments' | 'hrDocuments',
      resource: string,
    ) => (await ctx.db.query(table).withIndex('by_resource_sort', (query) =>
      query.eq('resource', resource),
    ).collect()).length
    const [currencies, units, categories, roles, numbering, warehouses, accounts, activeCurrencies] = await Promise.all([
      ctx.db.query('currencies').collect(),
      ctx.db.query('units').collect(),
      ctx.db.query('materialCategories').collect(),
      ctx.db.query('iamRoles').collect(),
      ctx.db.query('numberingRules').collect(),
      ctx.db.query('warehouses').withIndex('by_company_name_key', (query) => query.eq('companyId', companyId)).collect(),
      ctx.db.query('accounts').withIndex('by_company_code_key', (query) => query.eq('companyId', companyId)).collect(),
      ctx.db.query('currencies').withIndex('by_active_iso_code_key', (query) => query.eq('active', true)).collect(),
    ])
    const resources = Object.fromEntries(await Promise.all([
      ['invStockDocs', 'inventoryDocuments'], ['invStockTransfers', 'inventoryDocuments'],
      ['invStockCounts', 'inventoryDocuments'], ['salQuotations', 'tradingDocuments'],
      ['salOrders', 'tradingDocuments'], ['salDeliveries', 'tradingDocuments'],
      ['salReconciliations', 'tradingDocuments'], ['purQuotations', 'tradingDocuments'],
      ['purOrders', 'tradingDocuments'], ['purReceipts', 'tradingDocuments'],
      ['purReconciliations', 'tradingDocuments'], ['purOutsourcedIssues', 'tradingDocuments'],
      ['purOutsourcedReceipts', 'tradingDocuments'], ['mfgProcessTemplates', 'manufacturingDocuments'],
      ['mfgBoms', 'manufacturingDocuments'], ['mfgDemands', 'manufacturingDocuments'],
      ['mfgWorkOrders', 'manufacturingDocuments'], ['mfgOutputs', 'manufacturingDocuments'],
      ['accGlJournals', 'accountingDocuments'], ['accVatInvoices', 'financeDocuments'],
      ['accBankAccounts', 'financeDocuments'], ['accBankTransactions', 'financeDocuments'],
      ['accExpenseReports', 'financeDocuments'], ['hrPayrolls', 'hrDocuments'],
      ['hrPayrollPayments', 'hrDocuments'],
    ].map(async ([resource, table]) => [
      resource,
      await countResource(table as Parameters<typeof countResource>[0], resource),
    ])))
    return {
      completed: state.completedAt !== undefined,
      sampleSeeded: state.sampleSeededAt !== undefined,
      stage: state.sampleStage ?? null,
      currencies: currencies.length,
      activeCurrencies: activeCurrencies.length,
      units: units.length,
      categories: categories.length,
      roles: roles.length,
      numberingRules: numbering.length,
      warehouses: warehouses.length,
      accounts: accounts.length,
      customers: await ctx.db.query('customers').collect().then((rows) => rows.length),
      suppliers: await ctx.db.query('suppliers').collect().then((rows) => rows.length),
      employees: await ctx.db.query('employees').collect().then((rows) => rows.length),
      materials: await ctx.db.query('materials').collect().then((rows) => rows.length),
      stockFacts: await ctx.db.query('stockEntries').collect().then((rows) => rows.filter((row) => row.companyId === String(companyId)).length),
      glFacts: await ctx.db.query('glEntries').collect().then((rows) => rows.filter((row) => row.companyId === String(companyId)).length),
      resources,
    }
  },
})

export const runStage = internalMutation({
  args: { userId: v.id('appUsers'), expectedStage: v.string() },
  returns: v.object({ stage: v.string(), completed: v.boolean() }),
  handler: async (rawCtx, args) => {
    const state = await ownedState(rawCtx, args.userId)
    if (state.completedAt !== undefined) return { stage: 'done', completed: true }
    const current = stage(state.sampleStage)
    if (current !== args.expectedStage) {
      return { stage: current, completed: false }
    }
    const actor = await actorForAppUser(rawCtx, args.userId)
    if (!actor.superAdmin) throw synieError('forbidden', '只有超级管理员可生成示例数据')
    const ctx = asDomainMutationCtx(rawCtx)
    const data = sampleData(state.sampleData)
    if (current === 'master') await seedMaster(rawCtx, ctx, actor, state, data)
    else if (current === 'inventory') await seedInventory(rawCtx, ctx, actor, state, data)
    else if (current === 'sales') await seedSales(rawCtx, ctx, actor, state, data)
    else if (current === 'purchase') await seedPurchase(rawCtx, ctx, actor, state, data)
    else if (current === 'manufacturing') await seedManufacturing(rawCtx, ctx, actor, state, data)
    else if (current === 'outsourced') await seedOutsourced(rawCtx, ctx, actor, state, data)
    else if (current === 'finance') await seedFinance(rawCtx, ctx, actor, state, data)
    else await finish(rawCtx, state)
    const nextState = await rawCtx.db.get(state._id)
    const next = nextState?.completedAt !== undefined ? 'done' : stage(nextState?.sampleStage)
    return { stage: next, completed: nextState?.completedAt !== undefined }
  },
})
