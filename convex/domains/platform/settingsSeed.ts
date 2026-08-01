import type { MutationCtx } from '../../_generated/server'

/**
 * Settings are true singleton aggregates.  They are created as part of the
 * setup transaction so every read remains a pure indexed query and a partial
 * setup can never expose a mixture of defaults and persisted values.
 */
export async function seedSettings(ctx: Pick<MutationCtx, 'db'>): Promise<void> {
  const now = Date.now()
  if (!(await ctx.db.query('salesSettings').withIndex('by_key', (q) => q.eq('key', 'singleton')).unique())) {
    await ctx.db.insert('salesSettings', {
      key: 'singleton',
      sampleItemMaxQty: 5,
      deliveryOvershipRatioScaled: 0n,
      spotItemMaxQty: 5,
      receiptOverreceiveRatioScaled: 0n,
      demandOverorderRatioScaled: 0n,
      insertedAt: now,
      updatedAt: now,
    })
  }
  if (!(await ctx.db.query('manufacturingSettings').withIndex('by_key', (q) => q.eq('key', 'singleton')).unique())) {
    await ctx.db.insert('manufacturingSettings', {
      key: 'singleton',
      outputOverreceiveRatioScaled: 0n,
      insertedAt: now,
      updatedAt: now,
    })
  }
  if (!(await ctx.db.query('accountingSettings').withIndex('by_key', (q) => q.eq('key', 'singleton')).unique())) {
    await ctx.db.insert('accountingSettings', {
      key: 'singleton',
      insertedAt: now,
      updatedAt: now,
    })
  }
  if (!(await ctx.db.query('systemSettings').withIndex('by_key', (q) => q.eq('key', 'singleton')).unique())) {
    await ctx.db.insert('systemSettings', {
      key: 'singleton',
      marketFetchScheduleEnabled: false,
      marketFetchLastIntervalMinutes: 60,
      marketFetchSettlementEnabled: false,
      marketFetchLastRunAt: null,
      marketFetchLastSummary: null,
      insertedAt: now,
      updatedAt: now,
    })
  }
}
