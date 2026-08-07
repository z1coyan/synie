/**
 * 履约审核/作废：原 posting skeleton 编排内联到本 module（W4 清零 skeleton 调用点）。
 * 聚合草稿不进本路径；装箱相等与金额分摊在 collect 内。
 */
import { decimal, roundAmount } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { toDateOnly } from '~/db/dates.ts'
import { ident } from '~/db/ident.ts'
import { withTx, type DbHandle, type TrxHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import type { GlEngine, GlEntry } from '~/engines/gl/index.ts'
import type { InventoryEngine, StockLine } from '~/engines/inventory/index.ts'
import { auditDiff, writeAudit } from '~/platform/audit/write.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { AuthzTarget } from '~/platform/meta/resource-authz.ts'
import { loadAuthorized } from '~/db/load.ts'
import { accountCurrencies } from '~/platform/posting/account-currency.ts'
import { lowerParty as lowerPartyType } from '~/platform/posting/text.ts'
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
    const before = mapHead(await lockHead(trx, permit, spec, id, deps.headTargets))
    if (before.status !== 'DRAFT') throw new ApiError('conflict', `仅草稿${spec.label}可审核`)
    validateHeadShape(spec, before)
    await validateHeadRefs(trx, spec, before)

    const items = await loadActionItems(trx, spec, id)
    if (items.length === 0) throw new ApiError('conflict', '审核前必须至少填写一条履约条目')
    if (side === 'sales') await validatePackEquality(trx, id, items)

    const projectionLines = items.map((i) => ({
      orderItemId: i.orderItemId,
      baseQty: i.baseQty,
    }))
    const stockLines: StockLine[] = items
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

    await postFulfillment(trx, side, {
      companyId: before.companyId,
      partyType: before.partyType,
      partyId: before.partyId,
      lines: projectionLines,
    })

    if (stockLines.length > 0) {
      await deps.inventory.post(
        trx,
        {
          type: spec.voucherType,
          id: before.id,
          no: before.no,
          companyId: before.companyId,
          postingDate: before.documentDate,
        },
        stockLines,
      )
    }

    const glAmount = decimal(roundAmount(amount))
    let postingDate = before.postingDate ?? before.documentDate
    if (deps.postingDateOverride) postingDate = toDateOnly(deps.postingDateOverride)
    if (glAmount.gt(0)) {
      if (!postingDate) {
        throw ApiError.validation('审核参数不合法', { postingDate: ['有金额过账时必填'] })
      }
      const currencies = await accountCurrencies(trx, before.debitAccountId, before.creditAccountId)
      const debit: GlEntry = {
        accountId: before.debitAccountId,
        currencyId: currencies.debit,
        debit: glAmount,
        credit: decimal(0),
      }
      const credit: GlEntry = {
        accountId: before.creditAccountId,
        currencyId: currencies.credit,
        debit: decimal(0),
        credit: glAmount,
      }
      if (side === 'sales') {
        debit.partyType = lowerPartyType(before.partyType)
        debit.partyId = before.partyId
      } else {
        credit.partyType = lowerPartyType(before.partyType)
        credit.partyId = before.partyId
      }
      await deps.gl.post(
        trx,
        {
          type: spec.voucherType,
          id: before.id,
          no: before.no,
          companyId: before.companyId,
          postingDate,
        },
        [debit, credit],
      )
    }

    const auditedById = permit.actor.userId || null
    await sql`
      UPDATE ${ident(spec.headTable)} SET
        status='audited',
        posting_date=${postingDate}::date,
        audited_at=(now() AT TIME ZONE 'utc'),
        audited_by_id=${auditedById}::uuid,
        updated_at=(now() AT TIME ZONE 'utc')
      WHERE id=${before.id}::uuid
    `.execute(trx)

    const after = mapHead((await loadHead(trx, spec, id))!)
    await writeAudit(trx, permit.actor, {
      resource: spec.headTable,
      recordId: before.id,
      recordLabel: after.no,
      companyId: after.companyId,
      actionType: 'update',
      actionName: 'audit',
      changes: auditDiff(headSnap(before), headSnap(after), deps.auditFields),
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
    const before = mapHead(await lockHead(trx, permit, spec, id, deps.headTargets))
    if (before.status !== 'AUDITED') {
      throw new ApiError('conflict', `仅已审核${spec.label}可作废`)
    }

    const items = await loadActionItems(trx, spec, id)
    for (const item of items) {
      if (decimal(item.reconciledQty).gt(0)) {
        throw new ApiError('conflict', '存在已对账履约条目,不可作废')
      }
    }
    const lines = items.map((i) => ({ orderItemId: i.orderItemId, baseQty: i.baseQty }))

    await reverseFulfillment(trx, side, {
      companyId: before.companyId,
      partyType: before.partyType,
      partyId: before.partyId,
      lines,
    })
    await deps.inventory.cancel(trx, { type: spec.voucherType, id: before.id })
    await deps.gl.cancel(trx, { type: spec.voucherType, id: before.id })
    await sql`
      UPDATE ${ident(spec.headTable)} SET status='voided', updated_at=(now() AT TIME ZONE 'utc')
      WHERE id=${before.id}::uuid
    `.execute(trx)

    const after = mapHead((await loadHead(trx, spec, id))!)
    await writeAudit(trx, permit.actor, {
      resource: spec.headTable,
      recordId: before.id,
      recordLabel: after.no,
      companyId: after.companyId,
      actionType: 'update',
      actionName: 'void',
      changes: auditDiff(headSnap(before), headSnap(after), deps.auditFields),
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
