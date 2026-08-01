import type { GenericQueryCtx } from 'convex/server'
import type { DataModel } from '../_generated/dataModel'
import type { Actor } from '../lib/actor'
import { canAccessCompany } from '../lib/companyScope'
import { synieError } from '../lib/errors'
import { requirePermission } from '../lib/permissions'
import { getDomainRecord } from '../domains/shared/records'
import { catalogDocument } from '../domains/shared/policies'

type QueryCtx = GenericQueryCtx<DataModel>

const OWNER_RESOURCES = Object.freeze({
  acc_bank_account: 'accBankAccounts',
  acc_bank_transaction: 'accBankTransactions',
  acc_bill: 'accBills',
  acc_bill_transaction: 'accBillTransactions',
  acc_vat_invoice: 'accVatInvoices',
  hr_employee: 'hrEmployees',
  inv_material: 'invMaterials',
  mfg_work_order: 'mfgWorkOrders',
  pur_order_item: 'purOrderItems',
  pur_receipt_item: 'purReceiptItems',
  sal_customer: 'salCustomers',
  sal_delivery_item: 'salDeliveryItems',
  sal_order_item: 'salOrderItems',
  sys_print_template: 'sysPrintTemplates',
} as const)

export type AttachmentOwnerType = keyof typeof OWNER_RESOURCES

export const ATTACHMENT_OWNER_TYPES = Object.freeze(
  Object.keys(OWNER_RESOURCES) as AttachmentOwnerType[],
)

const GLOBAL_OWNER_RESOURCES = new Set([
  'invMaterials',
  'hrEmployees',
  'salCustomers',
  'sysPrintTemplates',
])

export function ownerReadPermission(ownerType: string): string {
  return `${catalogDocument(ownerResource(ownerType)).permissionPrefix}:read`
}

export function ownerUsesCompanyScope(ownerType: string): boolean {
  return !GLOBAL_OWNER_RESOURCES.has(ownerResource(ownerType))
}

export function validatedOwnerCompanyId(
  ownerType: string,
  value: unknown,
): string | null {
  if (ownerUsesCompanyScope(ownerType)) {
    if (typeof value !== 'string' || !value) {
      throw synieError('forbidden', '宿主公司归属缺失')
    }
    return value
  }
  return null
}

async function dedicatedOwner(
  ctx: QueryCtx,
  actor: Actor,
  resource: string,
  ownerId: string,
): Promise<Record<string, unknown> | null> {
  if (resource === 'invMaterials') {
    requirePermission(actor, 'inv.material:read')
    const id = ctx.db.normalizeId('materials', ownerId)
    return id ? await ctx.db.get(id) : null
  }
  if (resource === 'hrEmployees') {
    requirePermission(actor, 'hr.employee:read')
    const id = ctx.db.normalizeId('employees', ownerId)
    return id ? await ctx.db.get(id) : null
  }
  if (resource === 'salCustomers') {
    requirePermission(actor, 'sales.customer:read')
    const id = ctx.db.normalizeId('customers', ownerId)
    return id ? await ctx.db.get(id) : null
  }
  if (resource === 'sysPrintTemplates') {
    requirePermission(actor, 'sys.print_template:read')
    const id = ctx.db.normalizeId('printTemplates', ownerId)
    return id ? await ctx.db.get(id) : null
  }
  return null
}

/** Fail-closed attachment owner resolver; returns the frozen company scope. */
export async function resolveOwner(
  ctx: QueryCtx,
  actor: Actor,
  ownerType: string,
  ownerId: string,
): Promise<string | null> {
  const resource = OWNER_RESOURCES[ownerType as keyof typeof OWNER_RESOURCES]
  if (!resource) throw synieError('validation', '未知的宿主类型')
  let row: Record<string, unknown> | null
  if (resource === 'invMaterials' || resource === 'hrEmployees' || resource === 'salCustomers' || resource === 'sysPrintTemplates') {
    row = await dedicatedOwner(ctx, actor, resource, ownerId)
  } else {
    // getDomainRecord enforces the Catalog read permission and company scope.
    row = await getDomainRecord(ctx, actor, resource, ownerId)
  }
  if (!row) throw synieError('forbidden', '无权访问该宿主记录')
  const companyId = validatedOwnerCompanyId(ownerType, row.companyId)
  if (companyId && !canAccessCompany(actor, companyId)) {
    throw synieError('forbidden', '无权访问该宿主记录')
  }
  return companyId
}

export function ownerResource(ownerType: string): string {
  const resource = OWNER_RESOURCES[ownerType as keyof typeof OWNER_RESOURCES]
  if (!resource) throw synieError('validation', '未知的宿主类型')
  return resource
}
