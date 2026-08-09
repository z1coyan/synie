/**
 * 销售退货审核/作废：单事务编排（镜像 fulfillment/workflow 销售侧反转）。
 * 审核 = 库存回库（direction in）+ 金额>0 时 GL（借选定科目/贷未开票应收，带对手在贷方）
 *       + 发货条目 returned_qty 累加（守卫 ≤ base_qty）+ 订单条目 shipped_qty 回减；
 * 作废 = 全量回滚（已对账条目拦截）。
 * 聚合草稿不进本路径。
 */
import { decimal, roundAmount, toDecimalString, type Decimal } from '@synie/shared'
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
import {
  headSnap,
  loadActionItems,
  loadHead,
  mapHead,
  validateHeadRefs,
  validateHeadShape,
} from './domain.ts'
import {
  RETURN_HEAD_LABEL,
  RETURN_HEAD_TABLE,
  RETURN_VOUCHER_TYPE,
} from './spec.ts'
import { mapHeadDto } from './views.ts'

/**
 * 发货条目已退数量受控投影：退货审核 +Δ / 作废 −Δ。
 * 守卫：returned_qty+Δ ∈ [0, base_qty]，超出报「超出剩余可退数量」。
 */
async function adjustReturnedQty(
  trx: TrxHandle,
  lines: readonly { deliveryItemId: string; baseQty: string }[],
  direction: 1 | -1,
): Promise<void> {
  const grouped = new Map<string, Decimal>()
  for (const line of lines) {
    grouped.set(
      line.deliveryItemId,
      (grouped.get(line.deliveryItemId) ?? decimal(0)).add(decimal(line.baseQty)),
    )
  }
  for (const deliveryItemId of [...grouped.keys()].sort()) {
    const delta = grouped.get(deliveryItemId)!.mul(direction)
    const tag = await sql`
      UPDATE sal_delivery_item SET
        returned_qty=returned_qty+${toDecimalString(delta)}::numeric,
        updated_at=(now() AT TIME ZONE 'utc')
      WHERE id=${deliveryItemId}::uuid
        AND returned_qty+${toDecimalString(delta)}::numeric>=0
        AND returned_qty+${toDecimalString(delta)}::numeric<=base_qty
    `.execute(trx)
    if (Number(tag.numAffectedRows ?? 0) !== 1) {
      throw new ApiError('conflict', '超出剩余可退数量')
    }
  }
}

export async function runAuditHead(
  db: Kysely<Database>,
  permit: Permit,
  id: string,
  deps: {
    inventory: Pick<InventoryEngine, 'post' | 'cancel'>
    gl: Pick<GlEngine, 'post' | 'cancel'>
    headTarget: AuthzTarget
    auditFields: readonly string[]
  },
) {
  return withTx(db, async (trx) => {
    const before = mapHead(await lockHead(trx, permit, id, deps.headTarget))
    if (before.status !== 'DRAFT') throw new ApiError('conflict', `仅草稿${RETURN_HEAD_LABEL}可审核`)
    validateHeadShape(before)
    await validateHeadRefs(trx, before)

    const items = await loadActionItems(trx, id)
    if (items.length === 0) throw new ApiError('conflict', '审核前必须至少填写一条退货条目')

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
          direction: 'in' as const,
          remarks: before.remarks,
        }
      })
    // 源单行金额 = 发货条目快照口径：orderBaseAmount × baseQty / orderBaseQty
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

    if (stockLines.length > 0) {
      await deps.inventory.post(
        trx,
        {
          type: RETURN_VOUCHER_TYPE,
          id: before.id,
          no: before.no,
          companyId: before.companyId,
          postingDate: before.documentDate,
        },
        stockLines,
      )
    }

    const glAmount = decimal(roundAmount(amount))
    const postingDate = before.postingDate ?? before.documentDate
    if (glAmount.gt(0)) {
      if (!postingDate) {
        throw ApiError.validation('审核参数不合法', { postingDate: ['有金额过账时必填'] })
      }
      const currencies = await accountCurrencies(trx, before.debitAccountId, before.creditAccountId)
      // 销售发货的反转：借选定科目（不带对手）/ 贷未开票应收（带对手）
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
        partyType: lowerPartyType(before.partyType),
        partyId: before.partyId,
      }
      await deps.gl.post(
        trx,
        {
          type: RETURN_VOUCHER_TYPE,
          id: before.id,
          no: before.no,
          companyId: before.companyId,
          postingDate,
        },
        [debit, credit],
      )
    }

    // 投影：发货条目已退数量累加 + 订单条目已发数量回减
    await adjustReturnedQty(trx, items, 1)
    await reverseFulfillment(trx, 'sales', {
      companyId: before.companyId,
      partyType: before.partyType,
      partyId: before.partyId,
      lines: items.map((i) => ({ orderItemId: i.orderItemId, baseQty: i.baseQty })),
    })

    const auditedById = permit.actor.userId || null
    await sql`
      UPDATE ${ident(RETURN_HEAD_TABLE)} SET
        status='audited',
        posting_date=${postingDate}::date,
        audited_at=(now() AT TIME ZONE 'utc'),
        audited_by_id=${auditedById}::uuid,
        updated_at=(now() AT TIME ZONE 'utc')
      WHERE id=${before.id}::uuid
    `.execute(trx)

    const after = mapHead((await loadHead(trx, id))!)
    await writeAudit(trx, permit.actor, {
      resource: RETURN_HEAD_TABLE,
      recordId: before.id,
      recordLabel: after.no,
      companyId: after.companyId,
      actionType: 'update',
      actionName: 'audit',
      changes: auditDiff(headSnap(before), headSnap(after), deps.auditFields),
    })

    const row = await loadHead(trx, id)
    return mapHeadDto(row!)
  })
}

export async function runVoidHead(
  db: Kysely<Database>,
  permit: Permit,
  id: string,
  deps: {
    inventory: Pick<InventoryEngine, 'post' | 'cancel'>
    gl: Pick<GlEngine, 'post' | 'cancel'>
    headTarget: AuthzTarget
    auditFields: readonly string[]
  },
) {
  return withTx(db, async (trx) => {
    const before = mapHead(await lockHead(trx, permit, id, deps.headTarget))
    if (before.status !== 'AUDITED') {
      throw new ApiError('conflict', `仅已审核${RETURN_HEAD_LABEL}可作废`)
    }

    const items = await loadActionItems(trx, id)
    for (const item of items) {
      if (decimal(item.reconciledQty).gt(0)) {
        throw new ApiError('conflict', '存在已对账退货条目,不可作废')
      }
    }

    // 回滚：已退数量（守卫 ≥0）→ 已发数量加回 → 库存/总账分录作废
    await adjustReturnedQty(trx, items, -1)
    await postFulfillment(trx, 'sales', {
      companyId: before.companyId,
      partyType: before.partyType,
      partyId: before.partyId,
      lines: items.map((i) => ({ orderItemId: i.orderItemId, baseQty: i.baseQty })),
    })
    await deps.inventory.cancel(trx, { type: RETURN_VOUCHER_TYPE, id: before.id })
    await deps.gl.cancel(trx, { type: RETURN_VOUCHER_TYPE, id: before.id })
    await sql`
      UPDATE ${ident(RETURN_HEAD_TABLE)} SET status='voided', updated_at=(now() AT TIME ZONE 'utc')
      WHERE id=${before.id}::uuid
    `.execute(trx)

    const after = mapHead((await loadHead(trx, id))!)
    await writeAudit(trx, permit.actor, {
      resource: RETURN_HEAD_TABLE,
      recordId: before.id,
      recordLabel: after.no,
      companyId: after.companyId,
      actionType: 'update',
      actionName: 'void',
      changes: auditDiff(headSnap(before), headSnap(after), deps.auditFields),
    })

    const row = await loadHead(trx, id)
    return mapHeadDto(row!)
  })
}

async function lockHead(
  handle: DbHandle,
  permit: Permit,
  id: string,
  headTarget: AuthzTarget,
) {
  return loadAuthorized({
    db: handle,
    permit,
    target: headTarget,
    table: RETURN_HEAD_TABLE,
    id,
    forUpdate: true,
    notFoundMessage: `${RETURN_HEAD_LABEL}不存在`,
  })
}
