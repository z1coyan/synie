import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import type { Actor } from '../lib/actor'
import { asDomainMutationCtx } from '../lib/mutationContext'
import { synieError } from '../lib/errors'
import { writeAudit } from '../platform/audit/write'
import { normalizeWarehouse } from './model'

export type WarehouseSeedFault = 'after_root' | 'after_first_leaf'

export async function seedDefaultWarehouses(
  ctx: MutationCtx,
  actor: Actor,
  company: { _id: string; code: string },
  fault?: WarehouseSeedFault,
): Promise<number> {
  const existing = await ctx.db
    .query('warehouses')
    .withIndex('by_company_name_key', (query) => query.eq('companyId', company._id))
    .first()
  if (existing) return 0

  const now = Date.now()
  const make = (name: string, isLeaf: boolean, parentId: Doc<'warehouses'>['_id'] | null) => ({
    ...normalizeWarehouse({ name, companyId: company._id, isLeaf, parentId }),
    parentId,
    insertedAt: now,
    updatedAt: now,
  })
  const rootId = await ctx.db.insert(
    'warehouses',
    make(`${company.code} - 所有仓库`, false, null),
  )
  if (fault === 'after_root') throw synieError('internal', '默认仓库 fault probe')

  const firstLeafId = await ctx.db.insert(
    'warehouses',
    make(`${company.code} - 默认仓库`, true, rootId),
  )
  if (fault === 'after_first_leaf') throw synieError('internal', '默认仓库 fault probe')
  const transitId = await ctx.db.insert(
    'warehouses',
    make(`${company.code} - 在途`, true, rootId),
  )

  for (const id of [rootId, firstLeafId, transitId]) {
    const row = (await ctx.db.get(id))!
    await writeAudit(asDomainMutationCtx(ctx), actor, {
      resource: 'invWarehouses',
      recordId: id,
      recordLabel: row.name,
      companyId: row.companyId,
      action: 'create',
      changes: {
        name: row.name,
        isLeaf: row.isLeaf,
        active: row.active,
        isOutsourced: row.isOutsourced,
        partyType: row.partyType,
        partyId: row.partyId,
        allowNegative: row.allowNegative,
        companyId: row.companyId,
        parentId: row.parentId,
        accountId: row.accountId,
      },
    })
  }
  return 3
}
