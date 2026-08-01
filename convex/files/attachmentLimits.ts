import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'
import type { DataModel } from '../_generated/dataModel'
import { synieError } from '../lib/errors'

type ReadCtx = GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>

export const MAX_ATTACHMENTS_PER_OWNER = 200
export const MAX_DRAWING_ATTACHMENTS_PER_OWNER = 20
export const MAX_ATTACHMENT_CATEGORY_CODEPOINTS = 32

export function normalizeAttachmentCategory(value?: string): string {
  const normalized = value?.normalize('NFKC').trim() || 'default'
  if ([...normalized].length > MAX_ATTACHMENT_CATEGORY_CODEPOINTS) {
    throw synieError(
      'validation',
      `附件分类最多 ${MAX_ATTACHMENT_CATEGORY_CODEPOINTS} 个字符`,
    )
  }
  return normalized
}

function capacityError(): never {
  throw synieError(
    'conflict',
    `单个业务记录最多挂接 ${MAX_ATTACHMENTS_PER_OWNER} 个附件，请先清理后重试`,
  )
}

/**
 * Bound owner-scoped attachment work to a fixed Convex read/write budget.
 * One extra row turns legacy overflow into an explicit error instead of
 * silently truncating cleanup or snapshot replacement.
 */
export async function boundedOwnerAttachments(
  ctx: ReadCtx,
  ownerType: string,
  ownerId: string,
) {
  const rows = await ctx.db
    .query('attachments')
    .withIndex('by_owner', (query) =>
      query.eq('ownerType', ownerType).eq('ownerId', ownerId),
    )
    .take(MAX_ATTACHMENTS_PER_OWNER + 1)
  if (rows.length > MAX_ATTACHMENTS_PER_OWNER) capacityError()
  return rows
}

export function assertOwnerAttachmentCapacity(
  existingCount: number,
  additions = 1,
  removals = 0,
): void {
  if (
    !Number.isSafeInteger(existingCount) ||
    !Number.isSafeInteger(additions) ||
    !Number.isSafeInteger(removals) ||
    existingCount < 0 ||
    additions < 0 ||
    removals < 0 ||
    existingCount - removals + additions > MAX_ATTACHMENTS_PER_OWNER
  ) {
    capacityError()
  }
}

export function assertOwnerCategoryCapacity(
  attachments: readonly { category: string }[],
  category: string,
  additions = 1,
  removals = 0,
): void {
  if (category !== 'drawing') return
  const existingCount = attachments.filter((row) => row.category === category).length
  if (
    !Number.isSafeInteger(additions) ||
    !Number.isSafeInteger(removals) ||
    additions < 0 ||
    removals < 0 ||
    existingCount - removals + additions > MAX_DRAWING_ATTACHMENTS_PER_OWNER
  ) {
    throw synieError(
      'conflict',
      `单个业务记录的图纸槽位最多挂接 ${MAX_DRAWING_ATTACHMENTS_PER_OWNER} 个附件，请先清理后重试`,
    )
  }
}
