import type { Doc } from '../../_generated/dataModel'
import { assertMutationBudget } from '../../lib/budget'
import type { DomainMutationCtx } from '../../lib/mutationContext'
import { synieError } from '../../lib/errors'
import { activeGenerationInMutation } from '../generation'
import { checkedAdd } from '../shared'
import { groupDeltas, normalizeLines, validateVoucher, type StockLine, type StockVoucher } from './model'
import { applyInventoryDelta, readCurrent } from './projections'
import { bumpWarehouseRevision } from '../../domains/inventory/revisions'
import { replaceDomainQueryRows } from '../../domains/shared/queryProfiles'

function inventoryBudget(lines: number, keys: number, label: string) {
  return {
    label,
    reads: 2 * lines + 4 * keys + 4,
    writes: lines + 3 * keys + 1,
    estimatedReadBytes: (2 * lines + 4 * keys + 4) * 1_024,
    estimatedWriteBytes: (lines + 3 * keys + 1) * 1_024,
  }
}

async function validateReferences(
  ctx: DomainMutationCtx,
  voucher: StockVoucher,
  deltas: ReturnType<typeof groupDeltas>,
): Promise<Map<string, Doc<'warehouses'>>> {
  const warehouses = new Map<string, Doc<'warehouses'>>()
  for (const delta of deltas) {
    const [warehouse, material] = await Promise.all([
      ctx.db.get(delta.warehouseId),
      ctx.db.get(delta.materialId),
    ])
    if (!warehouse || !warehouse.isLeaf || warehouse.companyId !== voucher.companyId) {
      throw synieError('validation', '仓库不存在、不是叶子仓或不属于凭证公司')
    }
    if (!material || !material.active) {
      throw synieError('validation', '物料不存在或已停用')
    }
    warehouses.set(delta.warehouseId, warehouse)
  }
  return warehouses
}

export async function postInventoryInMutation(
  ctx: DomainMutationCtx,
  voucher: StockVoucher,
  lines: readonly StockLine[],
): Promise<number> {
  validateVoucher(voucher)
  const normalized = normalizeLines(lines)
  const deltas = groupDeltas(normalized)
  assertMutationBudget(inventoryBudget(lines.length, deltas.length, '库存过账'))
  const warehouses = await validateReferences(ctx, voucher, deltas)
  const generation = await activeGenerationInMutation(ctx, 'inventory')

  for (const delta of deltas) {
    const key = { companyId: voucher.companyId, warehouseId: delta.warehouseId, materialId: delta.materialId }
    const current = await readCurrent(ctx, generation, key)
    const next = checkedAdd(current?.baseQty ?? 0n, delta.delta)
    if (!warehouses.get(delta.warehouseId)!.allowNegative && next < 0n) {
      throw synieError('conflict', '库存不足')
    }
  }
  const now = Date.now()
  for (const [sequence, line] of normalized.entries()) {
    const factId = await ctx.db.insert('stockEntries', {
      voucherType: voucher.type,
      voucherId: voucher.id,
      voucherNo: voucher.no,
      companyId: voucher.companyId,
      warehouseId: line.warehouseId,
      materialId: line.materialId,
      postingDate: voucher.postingDate,
      signedBaseQty: line.signedBaseQty,
      sequence,
      cancelled: false,
      cancelledAt: null,
      createdAt: now,
    })
    const material = await ctx.db.get(line.materialId)
    const projectionId = await ctx.db.insert('inventoryDocuments', {
      resource: 'invStockEntries',
      companyId: voucher.companyId,
      parentId: null,
      status: null,
      sortKey: `${voucher.postingDate}:${voucher.no}:${String(sequence).padStart(6, '0')}`,
      searchText: `${voucher.no} ${voucher.type} ${material?.code ?? ''} ${material?.name ?? ''}`.toLocaleLowerCase(),
      decimalValues: { quantity: line.signedBaseQty },
      data: {
        seq: sequence,
        postingDate: voucher.postingDate,
        voucherType: voucher.type,
        voucherId: voucher.id,
        voucherNo: voucher.no,
        isCancelled: false,
        cancelledAt: null,
        remarks: null,
        companyId: voucher.companyId,
        warehouseId: line.warehouseId,
        materialId: line.materialId,
        materialCode: material?.code ?? '',
        materialName: material?.name ?? '',
        materialSpec: material?.spec ?? null,
        customerPartNo: material?.customerPartNo ?? null,
        factId,
      },
      insertedAt: now,
      updatedAt: now,
    })
    await replaceDomainQueryRows(ctx, 'invStockEntries', String(projectionId), {
      postingDate: voucher.postingDate,
      companyId: voucher.companyId,
    }, { companyId: voucher.companyId, parentId: null, status: null })
    await ctx.db.patch(factId, { factProjectionId: projectionId })
  }
  for (const delta of deltas) {
    await applyInventoryDelta(ctx, generation, {
      companyId: voucher.companyId,
      warehouseId: delta.warehouseId,
      materialId: delta.materialId,
    }, voucher.postingDate, delta.delta)
    await bumpWarehouseRevision(ctx, delta.warehouseId)
  }
  return normalized.length
}

export async function cancelInventoryInMutation(
  ctx: DomainMutationCtx,
  voucherType: string,
  voucherId: string,
): Promise<number> {
  const facts = await ctx.db
    .query('stockEntries')
    .withIndex('by_voucher', (query) => query.eq('voucherType', voucherType).eq('voucherId', voucherId))
    .take(5_000)
  const live = facts.filter((fact) => !fact.cancelled)
  if (live.length === 0) return 0
  const lines = live.map((fact) => ({
    warehouseId: fact.warehouseId,
    materialId: fact.materialId,
    quantity: '1',
    direction: 'in' as const,
    signedBaseQty: -fact.signedBaseQty,
  }))
  const deltas = groupDeltas(lines)
  assertMutationBudget(inventoryBudget(live.length, deltas.length, '库存作废'))
  const generation = await activeGenerationInMutation(ctx, 'inventory')
  for (const delta of deltas) {
    const warehouse = await ctx.db.get(delta.warehouseId)
    const current = await readCurrent(ctx, generation, {
      companyId: live[0]!.companyId,
      warehouseId: delta.warehouseId,
      materialId: delta.materialId,
    })
    if (!warehouse?.allowNegative && checkedAdd(current?.baseQty ?? 0n, delta.delta) < 0n) {
      throw synieError('conflict', '作废后库存不足')
    }
  }
  const now = Date.now()
  for (const fact of live) {
    await ctx.db.patch(fact._id, { cancelled: true, cancelledAt: now })
    if (fact.factProjectionId) {
      const projection = await ctx.db.get(fact.factProjectionId)
      if (projection) {
        await ctx.db.patch(projection._id, {
          data: { ...projection.data, isCancelled: true, cancelledAt: now },
          updatedAt: now,
        })
      }
    }
  }
  for (const delta of deltas) {
    await applyInventoryDelta(
      ctx,
      generation,
      {
        companyId: live[0]!.companyId,
        warehouseId: delta.warehouseId,
        materialId: delta.materialId,
      },
      live[0]!.postingDate,
      delta.delta,
    )
    await bumpWarehouseRevision(ctx, delta.warehouseId)
  }
  return live.length
}
