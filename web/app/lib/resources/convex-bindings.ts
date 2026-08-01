import { decodeResourceDocument } from '@synie/shared'
import type { ConvexReactClient } from 'convex/react'
import type { Row } from '~/components/synie-data-grid/types'
import { api } from '~/lib/convex-api'
import { mapConvexError } from '~/lib/convex-errors'
import { getCachedDocument, setCachedDocument } from './catalog/cache'
import { createCommandAdapter, defineCommand } from './catalog/commands'
import { createResourceQueryCache } from './catalog/query-cache'
import type { ResourceBinding, ResourceReader, RecordWriter } from './catalog/types'
import type { ResourceQuery } from './types'
import type { HrSemanticOperations } from './hr-operations'
import type { FinanceBankingSemanticOperations } from './finance-operations'
import type { MarketSemanticOperations } from './market'
import type { TodoSemanticOperations } from './system-ops'
import type { ManufacturingSemanticOperations } from './manufacturing'
import type { FileSemanticOperations } from '~/lib/files'
import type { PrintingSemanticOperations } from '~/lib/print'
import type { AccountingSemanticOperations } from './accounting'
import type { InventorySemanticOperations } from './inventory'
import type { OrderSemanticOperations } from './orders'
import { CONVEX_DOMAIN_MANIFEST, type ConvexDomainResource } from './convex-domain-manifest'

const PILOTS = ['basCurrencies', 'basUnits', 'invWarehouses'] as const
type PilotResource = (typeof PILOTS)[number]
const WAVE_A = [
  'basCompanies', 'basAccounts', 'salCustomers', 'purSuppliers', 'hrEmployees',
  'invMaterialCategories', 'invMaterials', 'invMaterialUnits',
  'sysRoles', 'sysUsers', 'sysRolePermissions', 'sysAuditLogs',
  'sysNumberingRules', 'sysNumberingCounters',
  'salSettings', 'mfgSettings', 'accSettings', 'sysSettings',
  'salCompanyAccountDefaults',
] as const
const MIGRATED = [...PILOTS, ...WAVE_A, ...Object.keys(CONVEX_DOMAIN_MANIFEST), 'sysFiles', 'sysPrintTemplates'] as const

function isPilotResource(resource: string): resource is PilotResource {
  return (PILOTS as readonly string[]).includes(resource)
}

function failUnsupported(parts: string[]): never {
  throw new Error(`此筛选/排序组合暂不支持：${parts.join('、')}`)
}

function singleFixedId(input: ResourceQuery, field: string): string | undefined {
  const explicit = input.args?.[field]
  if (typeof explicit === 'string' && explicit) return explicit
  const raw = input.fixedFilter?.[field]
  if (typeof raw === 'string' && raw) return raw
  if (typeof raw === 'object' && raw !== null && 'values' in raw) {
    const values = (raw as { values?: unknown }).values
    if (Array.isArray(values) && values.length === 1 && typeof values[0] === 'string') return values[0]
  }
  return undefined
}

function booleanFilter(input: ResourceQuery, field: string): boolean | undefined {
  const explicit = input.args?.[field]
  if (typeof explicit === 'boolean') return explicit
  const raw = input.filter?.[field]
  return raw?.kind === 'bool' ? raw.eq : undefined
}

function enumFilter(input: ResourceQuery, field: string): string | undefined {
  const explicit = input.args?.[field]
  if (typeof explicit === 'string') return explicit
  const raw = input.filter?.[field]
  if (raw?.kind === 'enum' && raw.values.length === 1) return raw.values[0]
  const fixed = input.fixedFilter?.[field]
  return typeof fixed === 'object' && fixed !== null && 'kind' in fixed && fixed.kind === 'enum' &&
    'values' in fixed && Array.isArray(fixed.values) && fixed.values.length === 1 && typeof fixed.values[0] === 'string'
    ? fixed.values[0]
    : undefined
}

function textEquality(input: ResourceQuery, field: string): string | undefined {
  const explicit = input.args?.[field]
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim()
  const raw = input.filter?.[field]
  if (raw?.kind === 'text' && raw.op === 'eq' && raw.value.trim()) return raw.value.trim()
  const fixed = input.fixedFilter?.[field]
  if (typeof fixed === 'string' && fixed.trim()) return fixed.trim()
  if (typeof fixed === 'object' && fixed !== null && 'kind' in fixed && fixed.kind === 'text' &&
      'op' in fixed && fixed.op === 'eq' && 'value' in fixed && typeof fixed.value === 'string' && fixed.value.trim()) {
    return fixed.value.trim()
  }
  return undefined
}

function rejectCommonUnsupported(
  input: ResourceQuery,
  allowedFilters: string[],
  allowedSorts: readonly string[] = [],
  validateFixed = false,
): void {
  const sortUnsupported = input.sort && !allowedSorts.includes(String(input.sort.column))
  const unsupported = [
    ...(sortUnsupported ? [`排序 ${String(input.sort!.column)}`] : []),
    ...Object.keys(input.filter ?? {}).filter((field) => !allowedFilters.includes(field)),
    ...(validateFixed ? Object.keys(input.fixedFilter ?? {}).filter((field) => !allowedFilters.includes(field)) : []),
  ]
  if (unsupported.length > 0) failUnsupported(unsupported)
}

async function call<T>(invoke: () => Promise<T>): Promise<T> {
  try {
    return await invoke()
  } catch (error) {
    throw mapConvexError(error)
  }
}

function currencyReader(client: ConvexReactClient): ResourceReader {
  return {
    query: async (input) => {
      rejectCommonUnsupported(input, ['active'])
      const active = booleanFilter(input, 'active')
      if (input.search && active !== undefined) failUnsupported(['搜索 + 启用筛选'])
      const profile = input.search ? 'search' : active === undefined ? 'default' : 'lookup'
      return call(() => client.query(api.resources.currencies.list, {
        profile,
        numItems: input.numItems,
        cursor: input.cursor ?? null,
        ...(input.search ? { search: input.search } : {}),
        ...(active === undefined ? {} : { args: { active } }),
      })) as Promise<Awaited<ReturnType<ResourceReader['query']>>>
    },
    get: (id) => call(() => client.query(api.resources.currencies.get, { id: id as never })) as Promise<Row | null>,
  }
}

function unitReader(client: ConvexReactClient): ResourceReader {
  return {
    query: async (input) => {
      rejectCommonUnsupported(input, ['unitType'])
      const unitType = enumFilter(input, 'unitType')
      if (input.search && unitType !== undefined) failUnsupported(['搜索 + 单位类型筛选'])
      const profile = input.search ? 'search' : unitType === undefined ? 'default' : 'lookup'
      return call(() => client.query(api.resources.units.list, {
        profile,
        numItems: input.numItems,
        cursor: input.cursor ?? null,
        ...(input.search ? { search: input.search } : {}),
        ...(unitType === undefined ? {} : { args: { unitType: unitType as never } }),
      })) as Promise<Awaited<ReturnType<ResourceReader['query']>>>
    },
    get: (id) => call(() => client.query(api.resources.units.get, { id: id as never })) as Promise<Row | null>,
  }
}

function warehouseReader(client: ConvexReactClient): ResourceReader {
  return {
    query: async (input) => {
      rejectCommonUnsupported(input, ['parentId'])
      const companyId = singleFixedId(input, 'companyId')
      if (!companyId) failUnsupported(['缺少公司范围'])
      let parentId: string | null | undefined = input.args?.parentId as string | null | undefined
      const parentFilter = input.filter?.parentId
      if (parentFilter?.kind === 'fk') {
        parentId = parentFilter.op === 'isNil' ? null : parentFilter.values.length === 1 ? parentFilter.values[0] : undefined
      }
      const profile = input.profile === 'treeChildren'
        ? 'treeChildren'
        : input.search
          ? 'search'
          : 'default'
      if (profile === 'treeChildren' && parentId === undefined) failUnsupported(['treeChildren 缺少 parentId'])
      if (profile !== 'treeChildren' && parentId !== undefined) failUnsupported(['parentId 仅支持树查询'])
      return call(() => client.query(api.resources.warehouses.list, {
        profile,
        numItems: input.numItems,
        cursor: input.cursor ?? null,
        ...(input.search ? { search: input.search } : {}),
        args: {
          companyId,
          ...(parentId === undefined ? {} : { parentId: parentId as never }),
        },
      })) as Promise<Awaited<ReturnType<ResourceReader['query']>>>
    },
    get: (id) => call(() => client.query(api.resources.warehouses.get, { id: id as never })) as Promise<Row | null>,
  }
}

function writer(client: ConvexReactClient, resource: PilotResource): RecordWriter {
  if (resource === 'basCurrencies') {
    return {
      create: (input) => call(() => client.mutation(api.resources.currencies.create, input as never)) as Promise<Row>,
      update: (id, input) => call(() => client.mutation(api.resources.currencies.update, { id, ...input } as never)) as Promise<Row>,
      delete: async (id) => { await call(() => client.mutation(api.resources.currencies.remove, { id: id as never })) },
    }
  }
  if (resource === 'basUnits') {
    return {
      create: (input) => call(() => client.mutation(api.resources.units.create, input as never)) as Promise<Row>,
      update: (id, input) => call(() => client.mutation(api.resources.units.update, { id, ...input } as never)) as Promise<Row>,
      delete: async (id) => { await call(() => client.mutation(api.resources.units.remove, { id: id as never })) },
    }
  }
  return {
    create: (input) => call(() => client.mutation(api.resources.warehouses.create, input as never)) as Promise<Row>,
    update: (id, input) => call(() => client.mutation(api.resources.warehouses.update, { id, ...input } as never)) as Promise<Row>,
    delete: async (id) => { await call(() => client.mutation(api.resources.warehouses.remove, { id: id as never })) },
  }
}

type FunctionRef = Parameters<ConvexReactClient['query']>[0]
type WaveResource = (typeof WAVE_A)[number]

function waveBinding(client: ConvexReactClient, resource: WaveResource): ResourceBinding {
  const queryRef = (ref: unknown, args: Record<string, unknown>) =>
    client.query(ref as FunctionRef, args as never) as Promise<any>
  const mutateRef = (ref: unknown, args: Record<string, unknown>) =>
    client.mutation(ref as Parameters<ConvexReactClient['mutation']>[0], args as never) as Promise<any>
  const refs: Record<WaveResource, { list: unknown; get?: unknown; create?: unknown; update?: unknown; remove?: unknown }> = {
    basCompanies: { list: api.domains.base.companies.list, get: api.domains.base.companies.get, create: api.domains.base.companies.create, update: api.domains.base.companies.update, remove: api.domains.base.companies.remove },
    basAccounts: { list: api.domains.base.accounts.list, get: api.domains.base.accounts.get, create: api.domains.base.accounts.create, update: api.domains.base.accounts.update, remove: api.domains.base.accounts.remove },
    salCustomers: { list: api.domains.party.parties.listCustomers, get: api.domains.party.parties.getCustomer, create: api.domains.party.parties.createCustomer, update: api.domains.party.parties.updateCustomer, remove: api.domains.party.parties.removeCustomer },
    purSuppliers: { list: api.domains.party.parties.listSuppliers, get: api.domains.party.parties.getSupplier, create: api.domains.party.parties.createSupplier, update: api.domains.party.parties.updateSupplier, remove: api.domains.party.parties.removeSupplier },
    hrEmployees: { list: api.domains.party.parties.listEmployees, get: api.domains.party.parties.getEmployee, create: api.domains.party.parties.createEmployee, update: api.domains.party.parties.updateEmployee, remove: api.domains.party.parties.removeEmployee },
    invMaterialCategories: { list: api.domains.inventory.master.listCategories, get: api.domains.inventory.master.getCategory, create: api.domains.inventory.master.createCategory, update: api.domains.inventory.master.updateCategory, remove: api.domains.inventory.master.removeCategory },
    invMaterials: { list: api.domains.inventory.master.listMaterials, get: api.domains.inventory.master.getMaterial, create: api.domains.inventory.master.createMaterial, update: api.domains.inventory.master.updateMaterial, remove: api.domains.inventory.master.removeMaterial },
    invMaterialUnits: { list: api.domains.inventory.master.listMaterialUnits, get: api.domains.inventory.master.getMaterialUnit, create: api.domains.inventory.master.createMaterialUnit, update: api.domains.inventory.master.updateMaterialUnit, remove: api.domains.inventory.master.removeMaterialUnit },
    sysRoles: { list: api.domains.platform.resources.listRoles, get: api.domains.platform.resources.getRole, create: api.iam.roles.create, update: api.iam.roles.update, remove: api.iam.roles.remove },
    sysUsers: { list: api.domains.platform.resources.listUsers, get: api.domains.platform.resources.getUser, create: api.iam.users.create, update: api.iam.users.update, remove: api.iam.users.remove },
    sysRolePermissions: { list: api.domains.platform.resources.listRolePermissions },
    sysAuditLogs: { list: api.domains.platform.resources.listAudit, get: api.domains.platform.resources.getAudit },
    sysNumberingRules: { list: api.domains.platform.numbering.listRules, get: api.domains.platform.numbering.getRule, create: api.domains.platform.numbering.createRule, update: api.domains.platform.numbering.updateRule, remove: api.domains.platform.numbering.removeRule },
    sysNumberingCounters: { list: api.domains.platform.numbering.listCounters, get: api.domains.platform.numbering.getCounter, update: api.domains.platform.numbering.updateCounter },
    salSettings: { list: api.domains.platform.settings.listSales, get: api.domains.platform.settings.getSales, update: api.domains.platform.settings.updateSales },
    mfgSettings: { list: api.domains.platform.settings.listManufacturing, get: api.domains.platform.settings.getManufacturing, update: api.domains.platform.settings.updateManufacturing },
    accSettings: { list: api.domains.platform.settings.listAccounting, get: api.domains.platform.settings.getAccounting, update: api.domains.platform.settings.updateAccounting },
    sysSettings: { list: api.domains.platform.settings.listSystem, get: api.domains.platform.settings.getSystem, update: api.domains.platform.settings.updateSystem },
    salCompanyAccountDefaults: { list: api.domains.platform.companyAccountDefaults.list, get: api.domains.platform.companyAccountDefaults.get, create: api.domains.platform.companyAccountDefaults.create, update: api.domains.platform.companyAccountDefaults.update },
  }
  const entry = refs[resource]
  const reader: ResourceReader = {
    query: async (input) => {
      rejectCommonUnsupported(input, [])
      const common: Record<string, unknown> = { numItems: input.numItems, cursor: input.cursor ?? null }
      if (resource === 'basAccounts') {
        const companyId = singleFixedId(input, 'companyId')
        if (!companyId) failUnsupported(['缺少公司范围'])
        const parentId = input.args?.parentId as string | null | undefined
        Object.assign(common, {
          profile: input.profile === 'treeChildren' ? 'treeChildren' : input.search ? 'search' : 'default',
          companyId,
          ...(parentId === undefined ? {} : { parentId }),
          ...(input.search ? { search: input.search } : {}),
        })
      } else if (resource === 'invMaterialCategories') {
        Object.assign(common, {
          profile: input.profile === 'treeChildren' ? 'treeChildren' : input.search ? 'search' : 'default',
          ...(input.args?.parentId === undefined ? {} : { parentId: input.args.parentId }),
          ...(input.search ? { search: input.search } : {}),
        })
      } else if (resource === 'invMaterialUnits') {
        const materialId = singleFixedId(input, 'materialId')
        if (!materialId) failUnsupported(['缺少物料范围'])
        Object.assign(common, { materialId })
      } else if (resource === 'sysRolePermissions') {
        const roleId = singleFixedId(input, 'roleId')
        if (!roleId) failUnsupported(['缺少角色范围'])
        Object.assign(common, { roleId })
      } else if (resource === 'sysAuditLogs') {
        const companyId = singleFixedId(input, 'companyId')
        if (companyId) Object.assign(common, { companyId })
      } else if (resource === 'sysNumberingCounters') {
        const ruleId = singleFixedId(input, 'ruleId')
        if (ruleId) Object.assign(common, { ruleId })
      } else if (resource === 'salCompanyAccountDefaults') {
        const companyId = singleFixedId(input, 'companyId')
        if (companyId) Object.assign(common, { companyId })
      } else if (['basCompanies', 'salCustomers', 'purSuppliers', 'hrEmployees', 'invMaterials'].includes(resource)) {
        Object.assign(common, { profile: input.search ? 'search' : 'default', ...(input.search ? { search: input.search } : {}) })
      }
      return call(() => queryRef(entry.list, common))
    },
    get: entry.get
      ? (id) => call(() => queryRef(entry.get, { id })) as Promise<Row | null>
      : async () => null,
  }
  const recordWriter: RecordWriter | undefined = entry.create || entry.update || entry.remove
    ? ({
        ...(entry.create ? { create: (input: Record<string, unknown>) => call(() => mutateRef(entry.create, input)) as Promise<Row> } : {}),
        ...(entry.update ? { update: (id: string, input: Record<string, unknown>) => call(() => mutateRef(entry.update, { id, ...input })) as Promise<Row> } : {}),
        ...(entry.remove ? { delete: async (id: string) => { await call(() => mutateRef(entry.remove, { id })) } } : {}),
      } as RecordWriter)
    : undefined
  const commands = resource === 'basAccounts'
    ? createCommandAdapter({
        initializeTemplate: defineCommand(
          'collection',
          (input: { companyId: string; template: string }) =>
            call(() => client.mutation(api.domains.base.accounts.initializeTemplate, input as never)),
        ),
      })
    : resource === 'sysRoles'
      ? createCommandAdapter({
          loadPermissions: defineCommand('row', (input: { id: string }) =>
            call(async () => {
              const [catalog, page] = await Promise.all([
                client.query(api.catalog.permissions.get, {}),
                client.query(api.domains.platform.resources.listRolePermissions, { roleId: input.id as never, numItems: 500, cursor: null }),
              ])
              return { catalog, rows: page.results }
            })),
          syncPermissions: defineCommand('row', (input: { id: string; permissions: string[] }) =>
            call(() => client.mutation(api.iam.roles.syncPermissions, { id: input.id as never, permissions: input.permissions }))),
        })
      : resource === 'sysUsers'
        ? createCommandAdapter({
            getAccess: defineCommand('row', (input: { id: string }) =>
              call(() => client.query(api.domains.platform.resources.getUserAccess, { id: input.id as never }))),
            createManaged: defineCommand('collection', (input: Record<string, unknown>) =>
              call(() => client.mutation(api.iam.users.create, input as never))),
            resetPassword: defineCommand('row', (input: { id: string }) =>
              call(() => client.mutation(api.iam.users.resetPassword, { id: input.id as never }))),
          })
        : resource === 'sysNumberingRules'
          ? createCommandAdapter({
              listNumberables: defineCommand('collection', () =>
                call(() => client.query(api.domains.platform.numbering.listNumberableResources, {}))),
            })
          : undefined
  return {
    resource,
    reader,
    ...(recordWriter ? { writer: recordWriter } : {}),
    ...(commands ? { commands } : {}),
    cache: createResourceQueryCache(resource, `convex:${resource}`),
    loadDocument: async () => {
      const cached = getCachedDocument(resource)
      if (cached) return cached
      const raw = await call(() => client.query(api.catalog.get.get, { resource }))
      const document = decodeResourceDocument(raw)
      setCachedDocument(resource, document)
      return document
    },
  }
}

type DomainGateway = (typeof CONVEX_DOMAIN_MANIFEST)[ConvexDomainResource]['gateway']

function gatewayRefs(gateway: DomainGateway) {
  const refs = {
    accounting: api.domains.accounting.documents,
    inventory: api.domains.inventory.documents,
    quotations: api.domains.trading.quotations,
    orders: api.domains.trading.orders,
    fulfillment: api.domains.trading.fulfillment,
    reconciliation: api.domains.trading.reconciliation,
    finance: api.domains.finance.documents,
    manufacturing: api.domains.manufacturing.domain,
    hr: api.domains.hr.domain,
    market: api.domains.market.domain,
  }
  return refs[gateway]
}

type DraftGateway = NonNullable<(typeof CONVEX_DOMAIN_MANIFEST)[ConvexDomainResource]['draftGateway']>

function draftGatewayRefs(gateway: DraftGateway) {
  const refs = {
    accounting: api.domains.accounting.drafts,
    inventory: api.domains.inventory.drafts,
    trading: api.domains.trading.drafts,
    fulfillment: api.domains.trading.fulfillmentDrafts,
    reconciliation: api.domains.trading.reconciliationDrafts,
    finance: api.domains.finance.drafts,
    manufacturing: api.domains.manufacturing.drafts,
  }
  return refs[gateway]
}

const COMMAND_EFFECTS: Readonly<Record<string, readonly string[]>> = {
  'invStockDocs.audit': ['invStockEntries'],
  'invStockDocs.void': ['invStockEntries'],
  'invStockTransfers.ship': ['invStockTransferItems', 'invStockEntries'],
  'invStockTransfers.receive': ['invStockTransferItems', 'invStockEntries'],
  'invStockCounts.approve': ['invStockEntries'],
  'invStockCounts.cancel': ['invStockEntries'],
  'accGlJournals.audit': ['accGlEntries'],
  'accGlJournals.cancel': ['accGlEntries'],
  'salQuotations.audit': ['salQuotationItems'],
  'salQuotations.void': ['salQuotationItems'],
  'purQuotations.audit': ['purQuotationItems'],
  'purQuotations.void': ['purQuotationItems'],
  'salOrders.audit': ['salOrderItems'],
  'salOrders.close': ['salOrderItems'],
  'salOrders.void': ['salOrderItems'],
  'purOrders.audit': ['purOrderItems', 'purOrderItemMaterials', 'mfgDemandItems'],
  'purOrders.close': ['purOrderItems', 'purOrderItemMaterials'],
  'purOrders.void': ['purOrderItems', 'purOrderItemMaterials', 'mfgDemandItems'],
  'salDeliveries.audit': ['salDeliveryItems', 'salOrderItems', 'invStockEntries', 'accGlEntries', 'scmOrderFlowItems'],
  'salDeliveries.void': ['salDeliveryItems', 'salOrderItems', 'invStockEntries', 'accGlEntries', 'scmOrderFlowItems'],
  'purReceipts.audit': ['purReceiptItems', 'purOrderItems', 'mfgDemandItems', 'invStockEntries', 'accGlEntries', 'scmOrderFlowItems'],
  'purReceipts.void': ['purReceiptItems', 'purOrderItems', 'mfgDemandItems', 'invStockEntries', 'accGlEntries', 'scmOrderFlowItems'],
  'purOutsourcedIssues.audit': ['purOutsourcedIssueItems', 'purOrderItemMaterials', 'invStockEntries', 'scmOrderFlowItems'],
  'purOutsourcedIssues.void': ['purOutsourcedIssueItems', 'purOrderItemMaterials', 'invStockEntries', 'scmOrderFlowItems'],
  'purOutsourcedReceipts.audit': ['purOutsourcedReceiptItems', 'purOrderItems', 'mfgDemandItems', 'invStockEntries', 'accGlEntries', 'scmOrderFlowItems'],
  'purOutsourcedReceipts.void': ['purOutsourcedReceiptItems', 'purOrderItems', 'mfgDemandItems', 'invStockEntries', 'accGlEntries', 'scmOrderFlowItems'],
  'salReconciliations.confirm': ['salReconciliationItems', 'salDeliveryItems'],
  'salReconciliations.unconfirm': ['salReconciliationItems', 'salDeliveryItems'],
  'salReconciliations.audit': ['salReconciliationItems', 'salDeliveryItems', 'accGlEntries'],
  'salReconciliations.void': ['salReconciliationItems', 'salDeliveryItems', 'accGlEntries'],
  'purReconciliations.confirm': ['purReconciliationItems', 'purReceiptItems', 'purOutsourcedReceiptItems'],
  'purReconciliations.unconfirm': ['purReconciliationItems', 'purReceiptItems', 'purOutsourcedReceiptItems'],
  'purReconciliations.audit': ['purReconciliationItems', 'purReceiptItems', 'purOutsourcedReceiptItems', 'accGlEntries'],
  'purReconciliations.void': ['purReconciliationItems', 'purReceiptItems', 'purOutsourcedReceiptItems', 'accGlEntries'],
  'accVatInvoices.audit': ['accGlEntries'],
  'accVatInvoices.void': ['accGlEntries'],
  'accVatInvoices.reverse': ['accGlEntries'],
  'accBankTransactions.reconcile': ['accBankReconciliations'],
  'accExpenseReports.audit': ['accExpenseReportItems', 'accGlEntries'],
  'accExpenseReports.void': ['accExpenseReportItems', 'accGlEntries'],
  'accBillTransactions.audit': ['accBills', 'accBillHoldings', 'accGlEntries'],
  'accBillTransactions.void': ['accBills', 'accBillHoldings', 'accGlEntries'],
  'mfgWorkOrders.void': ['mfgDemandItems', 'mfgDemands'],
  'mfgOutputs.audit': ['mfgOutputItems', 'mfgWorkOrders', 'mfgDemandItems', 'mfgDemands', 'invStockEntries'],
  'mfgOutputs.void': ['mfgOutputItems', 'mfgWorkOrders', 'mfgDemandItems', 'mfgDemands', 'invStockEntries'],
}

function domainBinding(client: ConvexReactClient, resource: ConvexDomainResource): ResourceBinding {
  const manifest = CONVEX_DOMAIN_MANIFEST[resource]
  const refs = gatewayRefs(manifest.gateway)
  const draftRefs = manifest.draftGateway ? draftGatewayRefs(manifest.draftGateway) : null
  const queryRef = (ref: unknown, args: Record<string, unknown>) =>
    client.query(ref as FunctionRef, args as never) as Promise<any>
  const mutateRef = (ref: unknown, args: Record<string, unknown>) =>
    client.mutation(ref as Parameters<ConvexReactClient['mutation']>[0], args as never) as Promise<any>
  const reader: ResourceReader = {
    query: async (input) => {
      const allowedFilters = [
        'companyId', 'status',
        ...(manifest.parentField ? [manifest.parentField] : []),
        ...manifest.equalityFields,
      ]
      rejectCommonUnsupported(input, allowedFilters, manifest.sortFields, true)
      const queryArgs: Record<string, unknown> = {}
      const companyId = singleFixedId(input, 'companyId')
      if (companyId) queryArgs.companyId = companyId
      if (manifest.parentField) {
        const parentId = singleFixedId(input, manifest.parentField)
        if (parentId) queryArgs.parentId = parentId
      }
      const status = enumFilter(input, 'status')
      if (status) queryArgs.status = status
      if (input.sort) {
        queryArgs.sortField = String(input.sort.column)
        queryArgs.sortDirection = input.sort.direction
      }
      for (const field of manifest.equalityFields) {
        const value = textEquality(input, field)
        if (value) queryArgs[field] = value
      }
      return call(() => queryRef(refs.list, {
        resource,
        numItems: input.numItems,
        cursor: input.cursor ?? null,
        ...(input.search ? { search: input.search } : {}),
        ...(Object.keys(queryArgs).length ? { queryArgs } : {}),
      }))
    },
    get: (id) => call(() => queryRef(refs.get, { resource, id })) as Promise<Row | null>,
  }

  const capabilities = manifest.capabilities as readonly string[]
  const semanticDelete = resource === 'accBankReconciliations'
  const recordWriter: RecordWriter | undefined = semanticDelete || capabilities.some((capability) =>
    capability === 'create' || capability === 'update' || capability === 'delete')
    ? ({
        ...(!manifest.aggregate && capabilities.includes('create')
          ? { create: (input: Record<string, unknown>) => call(() => mutateRef(refs.create, { resource, input })) as Promise<Row> }
          : {}),
        ...(!manifest.aggregate && capabilities.includes('update')
          ? { update: (id: string, input: Record<string, unknown>) => call(() => mutateRef(refs.update, { resource, id, input })) as Promise<Row> }
          : {}),
        ...(capabilities.includes('delete') || semanticDelete
          ? { delete: async (id: string) => {
              if (manifest.aggregate && draftRefs) await call(() => mutateRef(draftRefs.removeDraft, { resource, id }))
              else await call(() => mutateRef(refs.remove, { resource, id }))
            } }
          : {}),
      } as RecordWriter)
    : undefined

  const commandMap: Record<string, ReturnType<typeof defineCommand<any, any>>> = {}
  for (const key of manifest.commands) {
    const target = manifest.commandTargets[key as keyof typeof manifest.commandTargets]
    commandMap[key] = resource === 'hrAttendanceDays' && key === 'recalc'
      ? defineCommand('collection', (input: { dateFrom: string; dateTo: string }) =>
          call(() => client.action(api.domains.hr.attendance.recalcRange, input)),
        { affectedResources: ['hrAttendanceDays'] })
      : defineCommand(
          target,
          async (input: Record<string, unknown>) => {
            if (target !== 'row') throw new Error(`${resource}.${key} 缺少显式 collection command adapter`)
            if (!input || typeof input.id !== 'string' || !input.id.trim()) throw new Error(`${key} 命令缺少记录 id`)
            const { id, ...payload } = input
            return call(() => client.mutation(api.domains.commands.execute, {
              resource,
              id,
              key,
              ...(Object.keys(payload).length ? { input: payload } : {}),
            }))
          },
          { affectedResources: COMMAND_EFFECTS[`${resource}.${key}`] },
        )
  }
  const commands = Object.keys(commandMap).length ? createCommandAdapter(commandMap) : undefined
  const draft = manifest.aggregate && draftRefs
    ? {
        loadDraft: (id: string) => call(() => queryRef(draftRefs.loadDraft, { resource, id })),
        createDraft: (input: unknown) => call(() => mutateRef(draftRefs.createDraft, { resource, input })),
        replaceDraft: (id: string, input: unknown) => call(() => mutateRef(draftRefs.replaceDraft, { resource, id, input })),
      }
    : undefined
  return {
    resource,
    reader,
    ...(recordWriter ? { writer: recordWriter } : {}),
    ...(commands ? { commands } : {}),
    ...(draft ? { draft } : {}),
    cache: createResourceQueryCache(resource, `convex:${resource}`),
    loadDocument: async () => {
      const cached = getCachedDocument(resource)
      if (cached) return cached
      const raw = await call(() => client.query(api.catalog.get.get, { resource }))
      const document = decodeResourceDocument(raw)
      setCachedDocument(resource, document)
      return document
    },
  }
}

function fileBinding(client: ConvexReactClient): ResourceBinding {
  return {
    resource: 'sysFiles',
    reader: {
      query: (input) => call(() => client.query(api.files.domain.listFiles, {
        numItems: input.numItems,
        cursor: input.cursor ?? null,
      })) as Promise<Awaited<ReturnType<ResourceReader['query']>>>,
      get: (id) => call(() => client.query(api.files.domain.getFile, { id: id as never })) as Promise<Row | null>,
    },
    writer: {
      delete: async (id: string) => { await call(() => client.action(api.files.actions.removeFile, { fileId: id as never })) },
    } as unknown as RecordWriter,
    cache: createResourceQueryCache('sysFiles', 'convex:sysFiles'),
    loadDocument: async () => {
      const cached = getCachedDocument('sysFiles')
      if (cached) return cached
      const raw = await call(() => client.query(api.catalog.get.get, { resource: 'sysFiles' }))
      const document = decodeResourceDocument(raw)
      setCachedDocument('sysFiles', document)
      return document
    },
  }
}

function printTemplateBinding(client: ConvexReactClient): ResourceBinding {
  return {
    resource: 'sysPrintTemplates',
    reader: {
      query: (input) => call(() => client.query(api.platform.printing.templates.list, {
        numItems: input.numItems,
        cursor: input.cursor ?? null,
        ...(input.search ? { search: input.search } : {}),
      })) as Promise<Awaited<ReturnType<ResourceReader['query']>>>,
      get: (id) => call(() => client.query(api.platform.printing.templates.get, { id: id as never })) as Promise<Row | null>,
    },
    writer: {
      create: (input: Record<string, unknown>) => call(() => client.action(
        api.platform.printing.actions.createTemplate,
        {
          name: String(input.name ?? ''),
          resource: input.resource as 'sales.order' | 'mfg.work_order',
          fileId: input.fileId as never,
          ...(input.remarks === undefined ? {} : { remarks: input.remarks == null ? null : String(input.remarks) }),
        },
      )) as Promise<Row>,
      update: (id: string, input: Record<string, unknown>) => call(() => client.action(
        api.platform.printing.actions.updateTemplate,
        {
          id: id as never,
          ...(input.name === undefined ? {} : { name: String(input.name) }),
          ...(input.fileId === undefined ? {} : { fileId: input.fileId as never }),
          ...(Object.prototype.hasOwnProperty.call(input, 'remarks')
            ? { remarksPresent: true, remarks: input.remarks == null ? null : String(input.remarks) }
            : { remarksPresent: false }),
        },
      )) as Promise<Row>,
      delete: async (id: string) => { await call(() => client.mutation(api.platform.printing.templates.remove, { id: id as never })) },
    } as RecordWriter,
    commands: createCommandAdapter({
      setDefault: defineCommand('row', ({ id }: { id: string }) => call(() => client.mutation(
        api.platform.printing.templates.setDefault, { id: id as never, value: true },
      ))),
      unsetDefault: defineCommand('row', ({ id }: { id: string }) => call(() => client.mutation(
        api.platform.printing.templates.setDefault, { id: id as never, value: false },
      ))),
    }),
    cache: createResourceQueryCache('sysPrintTemplates', 'convex:sysPrintTemplates'),
    loadDocument: async () => {
      const cached = getCachedDocument('sysPrintTemplates')
      if (cached) return cached
      const raw = await call(() => client.query(api.catalog.get.get, { resource: 'sysPrintTemplates' }))
      const document = decodeResourceDocument(raw)
      setCachedDocument('sysPrintTemplates', document)
      return document
    },
  }
}

function bankImportItemsBinding(client: ConvexReactClient): ResourceBinding {
  return {
    resource: 'accBankImportItems',
    reader: {
      query: (input) => {
        const importId = singleFixedId(input, 'importId')
        if (!importId) throw new Error('银行流水导入行查询必须限定 importId')
        return call(() => client.query(api.domains.finance.bankImport.listItems, {
          importId, numItems: input.numItems, cursor: input.cursor ?? null,
        })) as Promise<Awaited<ReturnType<ResourceReader['query']>>>
      },
      get: (id) => call(() => client.query(api.domains.finance.bankImport.getItem, { id: id as never })) as Promise<Row | null>,
    },
    writer: {
      update: (id: string, input: Record<string, unknown>) =>
        call(() => client.mutation(api.domains.finance.bankImport.updateItem, { id: id as never, input })) as Promise<Row>,
      delete: async (id: string) => { await call(() => client.mutation(api.domains.finance.bankImport.removeItem, { id: id as never })) },
    } as RecordWriter,
    cache: createResourceQueryCache('accBankImportItems', 'convex:accBankImportItems'),
    loadDocument: async () => {
      const cached = getCachedDocument('accBankImportItems')
      if (cached) return cached
      const raw = await call(() => client.query(api.catalog.get.get, { resource: 'accBankImportItems' }))
      const document = decodeResourceDocument(raw)
      setCachedDocument('accBankImportItems', document)
      return document
    },
  }
}

function attendancePunchesBinding(client: ConvexReactClient): ResourceBinding {
  return {
    resource: 'hrAttendancePunches',
    reader: {
      query: (input) => {
        if (input.search) throw new Error('考勤打卡事实不支持全文搜索')
        if (input.sort && (input.sort.column !== 'punchedAt' || input.sort.direction !== 'descending')) {
          throw new Error('考勤打卡事实仅支持按时间倒序')
        }
        const importId = singleFixedId(input, 'importId')
        return call(() => client.query(api.domains.hr.attendanceImport.listPunches, {
          numItems: input.numItems, cursor: input.cursor ?? null,
          ...(importId ? { importId } : {}),
        })) as Promise<Awaited<ReturnType<ResourceReader['query']>>>
      },
      get: (id) => call(() => client.query(api.domains.hr.attendanceImport.getPunch, { id: id as never })) as Promise<Row | null>,
    },
    cache: createResourceQueryCache('hrAttendancePunches', 'convex:hrAttendancePunches'),
    loadDocument: async () => {
      const cached = getCachedDocument('hrAttendancePunches')
      if (cached) return cached
      const raw = await call(() => client.query(api.catalog.get.get, { resource: 'hrAttendancePunches' }))
      const document = decodeResourceDocument(raw)
      setCachedDocument('hrAttendancePunches', document)
      return document
    },
  }
}

export function createConvexBindingResolver(client: ConvexReactClient) {
  const bindings = new Map<string, ResourceBinding>()
  for (const resource of PILOTS) {
    const reader = resource === 'basCurrencies'
      ? currencyReader(client)
      : resource === 'basUnits'
        ? unitReader(client)
        : warehouseReader(client)
    bindings.set(resource, {
      resource,
      reader,
      writer: writer(client, resource),
      ...(resource === 'invWarehouses'
        ? {
            commands: createCommandAdapter({
              seedDefaults: defineCommand(
                'collection',
                (input: { companyId: string }) =>
                  call(() => client.mutation(api.resources.warehouses.seedDefaults, input)),
              ),
            }),
          }
        : {}),
      cache: createResourceQueryCache(resource, `convex:${resource}`),
      loadDocument: async () => {
        const cached = getCachedDocument(resource)
        if (cached) return cached
        const raw = await call(() => client.query(api.catalog.get.get, { resource }))
        const document = decodeResourceDocument(raw)
        setCachedDocument(resource, document)
        return document
      },
    })
  }
  for (const resource of WAVE_A) bindings.set(resource, waveBinding(client, resource))
  for (const resource of Object.keys(CONVEX_DOMAIN_MANIFEST) as ConvexDomainResource[]) {
    bindings.set(resource, domainBinding(client, resource))
  }
  bindings.set('sysFiles', fileBinding(client))
  bindings.set('sysPrintTemplates', printTemplateBinding(client))
  bindings.set('accBankImportItems', bankImportItemsBinding(client))
  bindings.set('hrAttendancePunches', attendancePunchesBinding(client))
  return (resource: string): ResourceBinding => {
    if (!(MIGRATED as readonly string[]).includes(resource)) throw new Error(`资源「${resource}」尚未迁移到 Convex`)
    return bindings.get(resource)!
  }
}

export function createConvexFileSemanticOperations(client: ConvexReactClient): FileSemanticOperations {
  return {
    createUploadIntent: (input) => call(() => client.mutation(api.files.domain.createUploadIntent, input as never)) as ReturnType<FileSemanticOperations['createUploadIntent']>,
    signUpload: (intentId) => call(() => client.action(api.files.actions.signUpload, { intentId: intentId as never })) as ReturnType<FileSemanticOperations['signUpload']>,
    finalizeUpload: (intentId) => call(() => client.action(api.files.actions.finalizeUpload, { intentId: intentId as never })) as ReturnType<FileSemanticOperations['finalizeUpload']>,
    downloadUrl: (fileId) => call(() => client.action(api.files.actions.downloadUrl, { fileId: fileId as never })) as ReturnType<FileSemanticOperations['downloadUrl']>,
    attach: (fileId, input) => call(() => client.mutation(api.files.domain.attach, { fileId: fileId as never, ...input })) as ReturnType<FileSemanticOperations['attach']>,
    listAttachments: (input) => call(() => client.query(api.files.domain.listAttachments, input)) as ReturnType<FileSemanticOperations['listAttachments']>,
    listFileAttachments: (fileId) => call(() => client.query(api.files.domain.listFileAttachments, { fileId: fileId as never })) as ReturnType<FileSemanticOperations['listFileAttachments']>,
    removeAttachment: async (id) => { await call(() => client.mutation(api.files.domain.removeAttachment, { id: id as never })) },
    removeFile: async (id) => { await call(() => client.action(api.files.actions.removeFile, { fileId: id as never })) },
    listFiles: (input) => call(() => client.query(api.files.domain.listFiles, input)) as ReturnType<FileSemanticOperations['listFiles']>,
    getFile: (id) => call(() => client.query(api.files.domain.getFile, { id: id as never })) as ReturnType<FileSemanticOperations['getFile']>,
  }
}

export function createConvexPrintingSemanticOperations(client: ConvexReactClient): PrintingSemanticOperations {
  const resource = (value: string) => value as 'sales.order' | 'mfg.work_order'
  return {
    listResources: () => call(() => client.query(api.platform.printing.templates.resources, {})),
    listTemplates: (value) => call(() => client.query(
      api.platform.printing.templates.usable, { resource: resource(value) },
    )),
    fieldCatalog: (value) => call(() => client.query(
      api.platform.printing.templates.catalog, { resource: value },
    )),
    exportXlsx: (input) => call(() => client.action(
      api.platform.printing.actions.exportXlsx,
      { ...input, resource: resource(input.resource), templateId: input.templateId as never },
    )),
    startPrint: (input) => call(() => client.action(
      api.platform.printing.actions.startPrint,
      { ...input, resource: resource(input.resource), templateId: input.templateId as never },
    )) as unknown as ReturnType<PrintingSemanticOperations['startPrint']>,
    resultUrl: (jobId) => call(() => client.action(
      api.platform.printing.actions.printResultUrl, { jobId: jobId as never },
    )),
  }
}

export function createConvexHrSemanticOperations(
  client: ConvexReactClient,
): HrSemanticOperations {
  return {
    createAttendanceImport: (fileId) => call(() => client.action(api.domains.hr.attendanceImportActions.create, { fileId: fileId as never })) as ReturnType<HrSemanticOperations['createAttendanceImport']>,
    commitAttendanceImport: (id, autoCreateEmployees) => call(() => client.action(api.domains.hr.attendanceImportActions.commit, { importId: id, autoCreateEmployees })) as ReturnType<HrSemanticOperations['commitAttendanceImport']>,
    removeAttendanceImport: async (id) => { await call(() => client.action(api.domains.hr.attendanceImportActions.remove, { importId: id })) },
    recalcAttendanceDays: (dateFrom, dateTo) =>
      call(() => client.action(api.domains.hr.attendance.recalcRange, { dateFrom, dateTo })),
    fetchAttendanceMonthSummary: (month) =>
      call(() => client.query(api.domains.hr.attendance.monthSummary, { month })) as ReturnType<HrSemanticOperations['fetchAttendanceMonthSummary']>,
    refreshPayroll: (id) =>
      call(() => client.mutation(api.domains.hr.payroll.refresh, { id })) as ReturnType<HrSemanticOperations['refreshPayroll']>,
    generatePayrolls: (month) =>
      call(() => client.action(api.domains.hr.payroll.generate, { month })),
    fetchPayrollMonthStats: (month) =>
      call(() => client.query(api.domains.hr.payroll.monthStats, { month })),
    payRemainingPayroll: (payrollId, paidOn, remarks) =>
      call(() => client.mutation(api.domains.hr.payroll.payRemaining, {
        payrollId,
        paidOn,
        ...(remarks === undefined ? {} : { remarks }),
      })) as ReturnType<HrSemanticOperations['payRemainingPayroll']>,
    fetchEmployeeLoanBalances: () =>
      call(() => client.query(api.domains.hr.payroll.loanBalances, {})),
  }
}

export function createConvexFinanceBankingSemanticOperations(
  client: ConvexReactClient,
): FinanceBankingSemanticOperations {
  return {
    createBankImport: (input) => call(() => client.action(api.domains.finance.bankImportActions.create, {
      companyId: String(input.companyId), bankAccountId: String(input.bankAccountId),
      templateId: String(input.templateId), fileId: input.fileId as never,
    })) as ReturnType<FinanceBankingSemanticOperations['createBankImport']>,
    commitBankImport: (id) => call(() => client.action(api.domains.finance.bankImportActions.commit, { importId: id })) as ReturnType<FinanceBankingSemanticOperations['commitBankImport']>,
    removeBankImport: async (id) => { await call(() => client.action(api.domains.finance.bankImportActions.remove, { importId: id })) },
    updateBankImportItem: (id, input) => call(() => client.mutation(api.domains.finance.bankImport.updateItem, { id: id as never, input })) as ReturnType<FinanceBankingSemanticOperations['updateBankImportItem']>,
    removeBankImportItem: async (id) => { await call(() => client.mutation(api.domains.finance.bankImport.removeItem, { id: id as never })) },
    ocrConfigured: () => call(() => client.action(api.domains.finance.ocrActions.configured, {})),
    ocrVatInvoice: (fileId) => call(() => client.action(
      api.domains.finance.ocrActions.recognizeVatInvoice,
      { fileId: fileId as never },
    )) as ReturnType<FinanceBankingSemanticOperations['ocrVatInvoice']>,
    ocrBillTransaction: (fileId) => call(() => client.action(
      api.domains.finance.ocrActions.recognizeBankAcceptance,
      { fileId: fileId as never },
    )) as ReturnType<FinanceBankingSemanticOperations['ocrBillTransaction']>,
    fetchBankReconciliationRemaining: async (bankTransactionId, journalId) => {
      const result = await call(() => client.query(api.domains.finance.banking.remaining, {
        bankTransactionId,
        journalId,
      }))
      return result.amount
    },
    quickCreateBankReconciliation: (input) => call(() => client.mutation(
      api.domains.finance.banking.quickCreate,
      {
        bankTransactionId: String(input.bankTransactionId),
        counterAccountId: String(input.counterAccountId),
        amount: String(input.amount),
        postingDate: String(input.postingDate),
        ...(input.summary === undefined ? {} : { summary: input.summary == null ? null : String(input.summary) }),
      },
    )) as ReturnType<FinanceBankingSemanticOperations['quickCreateBankReconciliation']>,
  }
}

export function createConvexAccountingSemanticOperations(
  client: ConvexReactClient,
): AccountingSemanticOperations {
  return {
    arAp: (companyId, asOf) => call(() => client.query(
      api.domains.accounting.reports.arAp,
      { companyId: companyId as never, asOf },
    )) as ReturnType<AccountingSemanticOperations['arAp']>,
  }
}

export function createConvexInventorySemanticOperations(
  client: ConvexReactClient,
): InventorySemanticOperations {
  return {
    stockBalance: (input) => call(() => client.query(
      api.domains.inventory.operations.stockBalance,
      input as never,
    )) as ReturnType<InventorySemanticOperations['stockBalance']>,
    refreshStockCount: (id) => call(() => client.mutation(
      api.domains.inventory.operations.refreshStockCount,
      { id },
    )) as ReturnType<InventorySemanticOperations['refreshStockCount']>,
    outsourcedWarehouses: (partyType, partyId) => call(() => client.query(
      api.domains.inventory.operations.outsourcedWarehouses,
      { partyType, partyId },
    )) as ReturnType<InventorySemanticOperations['outsourcedWarehouses']>,
  }
}

export function createConvexOrderSemanticOperations(
  client: ConvexReactClient,
): OrderSemanticOperations {
  return {
    demandLines: (input) => call(() => client.query(
      api.domains.trading.operations.purchaseDemandLines,
      input,
    )),
    expandBom: (bomId, quantity) => call(() => client.query(
      api.domains.trading.operations.expandPurchaseBom,
      { bomId, quantity },
    )),
    salesHistory: (orderId) => call(() => client.query(
      api.domains.trading.operations.salesOrderHistory,
      { orderId },
    )),
    purchaseHistory: (orderId) => call(() => client.query(
      api.domains.trading.operations.purchaseOrderHistory,
      { orderId },
    )),
  }
}

export function createConvexMarketSemanticOperations(
  client: ConvexReactClient,
): MarketSemanticOperations {
  return {
    chartInstruments: () => call(() => client.query(
      api.domains.market.domain.chartInstruments, {},
    )) as ReturnType<MarketSemanticOperations['chartInstruments']>,
    priceSeries: (input) => call(() => client.query(
      api.domains.market.domain.priceSeries, input,
    )) as unknown as ReturnType<MarketSemanticOperations['priceSeries']>,
    refresh: (input) => call(() => client.action(
      api.domains.market.actions.refresh,
      {
        instrumentId: typeof input.instrumentId === 'string' && input.instrumentId
          ? input.instrumentId
          : null,
      },
    )) as ReturnType<MarketSemanticOperations['refresh']>,
  }
}

export function createConvexTodoSemanticOperations(
  client: ConvexReactClient,
): TodoSemanticOperations {
  return {
    list: async (tab, options) => {
      if ((options?.offset ?? 0) !== 0) throw new Error('Convex 待办仅支持游标分页')
      const result = await call(() => client.query(api.domains.todo.domain.list, {
        tab,
        includeDismissed: false,
        numItems: options?.limit ?? 20,
        cursor: null,
      }))
      return { count: result.count, results: result.results } as Awaited<ReturnType<TodoSemanticOperations['list']>>
    },
    unreadCount: async () => {
      const result = await call(() => client.query(api.domains.todo.domain.unreadCount, {}))
      return result.count
    },
    markRead: async (id) => {
      await call(() => client.mutation(api.domains.todo.domain.markRead, { id }))
    },
    dismiss: async (id) => {
      await call(() => client.mutation(api.domains.todo.domain.dismiss, { id }))
    },
  }
}

export function createConvexManufacturingSemanticOperations(
  client: ConvexReactClient,
): ManufacturingSemanticOperations {
  return {
    applyRouteTemplate: (id, templateId) => call(() => client.mutation(
      api.domains.manufacturing.drafts.applyRouteTemplate,
      { bomId: id, templateId },
    )),
    applyWorkOrderBom: (id, bomId) => call(() => client.mutation(
      api.domains.manufacturing.drafts.applyBom,
      { id, bomId },
    )),
    getWorkOrderBomSnapshot: (id) => call(() => client.query(
      api.domains.manufacturing.drafts.bomSnapshot,
      { id },
    )),
    createWorkOrderInlineBom: (id, input) => call(() => client.mutation(
      api.domains.manufacturing.drafts.createInlineBom,
      { id, input },
    )),
    salesItemCandidates: (companyId) => call(() => client.query(
      api.domains.manufacturing.drafts.salesItemCandidates,
      { companyId },
    )),
    salesItemOccupancies: (salesOrderItemIds) => call(() => client.query(
      api.domains.manufacturing.drafts.salesItemOccupancies,
      { salesOrderItemIds },
    )),
  }
}

/** @deprecated Plan 003 name retained for tests during the rolling migration. */
export const createConvexPilotBindingResolver = createConvexBindingResolver
