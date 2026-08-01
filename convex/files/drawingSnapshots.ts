import type { GenericMutationCtx } from 'convex/server'
import type { DataModel } from '../_generated/dataModel'
import { synieError } from '../lib/errors'
import {
  assertOwnerAttachmentCapacity,
  assertOwnerCategoryCapacity,
  boundedOwnerAttachments,
} from './attachmentLimits'

type MutationCtx = GenericMutationCtx<DataModel>

export const DRAWING_SNAPSHOT_OWNER_TYPES = [
  'mfg_work_order',
  'pur_order_item',
  'pur_receipt_item',
  'sal_delivery_item',
  'sal_order_item',
] as const

export type DrawingSnapshotOwnerType = (typeof DRAWING_SNAPSHOT_OWNER_TYPES)[number]

const DRAWING_CATEGORY = 'drawing'

/**
 * Replace a document line's drawing references with the material's current
 * drawing set. The file bytes stay immutable and shared; only attachment rows
 * are snapshotted. Call this from the same mutation that saves the owner row.
 */
export async function replaceMaterialDrawingSnapshot(
  ctx: MutationCtx,
  input: {
    materialId: string
    ownerType: DrawingSnapshotOwnerType
    ownerId: string
    companyId: string | null
  },
): Promise<void> {
  const materialId = ctx.db.normalizeId('materials', input.materialId)
  if (!materialId || !await ctx.db.get(materialId)) {
    throw synieError('validation', '图纸快照物料不存在')
  }

  const [targetAttachments, sourceAttachments] = await Promise.all([
    boundedOwnerAttachments(ctx, input.ownerType, input.ownerId),
    boundedOwnerAttachments(ctx, 'inv_material', input.materialId),
  ])
  const existing = targetAttachments.filter((row) => row.category === DRAWING_CATEGORY)
  const source = sourceAttachments.filter((row) => row.category === DRAWING_CATEGORY)
  assertOwnerCategoryCapacity(sourceAttachments, DRAWING_CATEGORY, 0, 0)
  assertOwnerCategoryCapacity(targetAttachments, DRAWING_CATEGORY, source.length, existing.length)
  assertOwnerAttachmentCapacity(targetAttachments.length, source.length, existing.length)
  for (const attachment of existing) await ctx.db.delete(attachment._id)

  const insertedAt = Date.now()
  for (const attachment of source) {
    await ctx.db.insert('attachments', {
      fileId: attachment.fileId,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      category: DRAWING_CATEGORY,
      companyId: input.companyId,
      insertedAt,
    })
  }
}

/** Remove every attachment before deleting an owner row. */
export async function removeOwnerAttachments(
  ctx: MutationCtx,
  ownerType: DrawingSnapshotOwnerType,
  ownerId: string,
): Promise<void> {
  const attachments = await boundedOwnerAttachments(ctx, ownerType, ownerId)
  for (const attachment of attachments) {
    await ctx.db.delete(attachment._id)
  }
}
