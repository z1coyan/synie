/**
 * 履约审核/作废：仍走 posting skeleton（库存 + 投影 + 可选 GL）。
 * 聚合草稿不进本路径；装箱相等与金额分摊在 collect 钩子内。
 */
import { decimal } from '@synie/shared'
import type { Kysely } from 'kysely'
import { withTx, type DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import type { GlEngine } from '~/engines/gl/index.ts'
import type { InventoryEngine } from '~/engines/inventory/index.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { AuthzTarget } from '~/platform/meta/resource-authz.ts'
import { loadAuthorized } from '~/db/load.ts'
import { auditFulfillmentInTx, voidFulfillmentInTx } from '~/platform/posting/skeleton.ts'
import { postFulfillment, reverseFulfillment } from '../order/projection.ts'
import type { TradingSide } from '../common.ts'
import {
  headSnap,
  loadActionItems,
  loadHead,
  mapHead,
  validateHeadRefs,
  validateHeadShape,
  validatePackEquality,
} from './domain.ts'
import { fulfillmentSpec, type FulfillmentSideSpec } from './spec.ts'
import { mapHeadDto } from './views.ts'

export async function runAuditHead(
  db: Kysely<Database>,
  permit: Permit,
  side: TradingSide,
  id: string,
  deps: {
    inventory: Pick<InventoryEngine, 'post' | 'cancel'>
    gl: Pick<GlEngine, 'post' | 'cancel'>
    headTargets: Record<TradingSide, AuthzTarget>
    auditFields: readonly string[]
    postingDateOverride?: string | null
  },
) {
  const spec = fulfillmentSpec(side)
  return withTx(db, async (trx) => {
    await auditFulfillmentInTx(trx, permit.actor, { inventory: deps.inventory, gl: deps.gl }, {
      voucherType: spec.voucherType,
      headTable: spec.headTable,
      partySide: side === 'sales' ? 'debit' : 'credit',
      postingDateOverride: deps.postingDateOverride,
      lockDraft: async (t) => {
        const before = mapHead(await lockHead(t, permit, spec, id, deps.headTargets))
        if (before.status !== 'DRAFT') throw new ApiError('conflict', `仅草稿${spec.label}可审核`)
        validateHeadShape(spec, before)
        await validateHeadRefs(t, spec, before)
        return before
      },
      collect: async (t, before) => {
        const items = await loadActionItems(t, spec, id)
        if (items.length === 0) throw new ApiError('conflict', '审核前必须至少填写一条履约条目')
        if (side === 'sales') await validatePackEquality(t, id, items)
        const projectionLines = items.map((i) => ({
          orderItemId: i.orderItemId,
          baseQty: i.baseQty,
        }))
        const stockLines = items
          .filter((i) => i.materialType === 'STOCK')
          .map((i) => {
            if (!i.warehouseId) {
              throw new ApiError(
                'conflict',
                `物料 ${i.materialCode} ${i.materialName} 已转为库存类,行仓必填后才可审核`,
              )
            }
            return {
              warehouseId: i.warehouseId,
              materialId: i.materialId,
              quantity: decimal(i.baseQty),
              direction: (spec.stockDirection < 0 ? 'out' : 'in') as 'in' | 'out',
              remarks: before.remarks,
            }
          })
        let amount = decimal(0)
        for (const item of items) {
          if (!decimal(item.orderBaseQty).isZero()) {
            amount = amount.add(
              decimal(item.orderBaseAmount)
                .mul(decimal(item.baseQty))
                .div(decimal(item.orderBaseQty)),
            )
          }
        }
        return { projectionLines, stockLines, amount }
      },
      postProjection: (t, before, lines) =>
        postFulfillment(t, side, {
          companyId: before.companyId,
          partyType: before.partyType,
          partyId: before.partyId,
          lines,
        }),
      voucherOf: (h) => h,
      reload: async (t, headId) => mapHead((await loadHead(t, spec, headId))!),
      snapshot: headSnap,
      auditFields: deps.auditFields,
    })
    const row = await loadHead(trx, spec, id)
    return mapHeadDto(side, row!)
  })
}

export async function runVoidHead(
  db: Kysely<Database>,
  permit: Permit,
  side: TradingSide,
  id: string,
  deps: {
    inventory: Pick<InventoryEngine, 'post' | 'cancel'>
    gl: Pick<GlEngine, 'post' | 'cancel'>
    headTargets: Record<TradingSide, AuthzTarget>
    auditFields: readonly string[]
  },
) {
  const spec = fulfillmentSpec(side)
  return withTx(db, async (trx) => {
    await voidFulfillmentInTx(trx, permit.actor, { inventory: deps.inventory, gl: deps.gl }, {
      voucherType: spec.voucherType,
      headTable: spec.headTable,
      lockAudited: async (t) => {
        const before = mapHead(await lockHead(t, permit, spec, id, deps.headTargets))
        if (before.status !== 'AUDITED') {
          throw new ApiError('conflict', `仅已审核${spec.label}可作废`)
        }
        return before
      },
      voidableLines: async (t) => {
        const items = await loadActionItems(t, spec, id)
        for (const item of items) {
          if (decimal(item.reconciledQty).gt(0)) {
            throw new ApiError('conflict', '存在已对账履约条目,不可作废')
          }
        }
        return items.map((i) => ({ orderItemId: i.orderItemId, baseQty: i.baseQty }))
      },
      reverseProjection: (t, before, lines) =>
        reverseFulfillment(t, side, {
          companyId: before.companyId,
          partyType: before.partyType,
          partyId: before.partyId,
          lines,
        }),
      voucherOf: (h) => h,
      reload: async (t, headId) => mapHead((await loadHead(t, spec, headId))!),
      snapshot: headSnap,
      auditFields: deps.auditFields,
    })
    const row = await loadHead(trx, spec, id)
    return mapHeadDto(side, row!)
  })
}

async function lockHead(
  handle: DbHandle,
  permit: Permit,
  spec: FulfillmentSideSpec,
  id: string,
  headTargets: Record<TradingSide, AuthzTarget>,
) {
  return loadAuthorized({
    db: handle,
    permit,
    target: headTargets[spec.side],
    table: spec.headTable,
    id,
    forUpdate: true,
    notFoundMessage: `${spec.label}不存在`,
  })
}
