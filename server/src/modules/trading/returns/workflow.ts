/**
 * 退货审核/作废：单事务编排（销售退货/采购退货对称；镜像 fulfillment 反转）。
 * 审核 = 库存分录（销售回库 in / 采购出仓 out）+ 金额>0 时 GL
 *       （销售：借选定科目/贷未开票应收带对手；采购：借未开票应付带对手/贷选定科目）
 *       + 源行累加来源条目 returned_qty（守卫 ≤ base_qty）+ 订单条目已发/已收回减
 *       （采购侧 skipDemandChain：需求行已完成/已收不随退货反转，ADR 2026-08-09）；
 * 作废 = 全量回滚（已对账条目拦截）。
 * 聚合草稿不进本路径。
 */
import { decimal, roundAmount, toDecimalString, type Decimal } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
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
} from './domain.ts'
import { returnSpec, type ReturnSideSpec } from './spec.ts'
import { mapHeadDto } from './views.ts'

/**
 * 来源条目已退数量受控投影：退货审核 +Δ / 作废 −Δ。
 * 守卫：returned_qty+Δ ∈ [0, base_qty]，超出报「超出剩余可退数量」。
 */
async function adjustReturnedQty(
  trx: TrxHandle,
  spec: ReturnSideSpec,
  lines: readonly { sourceItemId: string; baseQty: string }[],
  direction: 1 | -1,
): Promise<void> {
  const grouped = new Map<string, Decimal>()
  for (const line of lines) {
    grouped.set(
      line.sourceItemId,
      (grouped.get(line.sourceItemId) ?? decimal(0)).add(decimal(line.baseQty)),
    )
  }
  for (const sourceItemId of [...grouped.keys()].sort()) {
    const delta = grouped.get(sourceItemId)!.mul(direction)
    const tag = await sql`
      UPDATE ${ident(spec.sourceItemTable)} SET
        returned_qty=returned_qty+${toDecimalString(delta)}::numeric,
        updated_at=(now() AT TIME ZONE 'utc')
      WHERE id=${sourceItemId}::uuid
        AND returned_qty+${toDecimalString(delta)}::numeric>=0
        AND returned_qty+${toDecimalString(delta)}::numeric<=base_qty
    `.execute(trx)
    if (Number(tag.numAffectedRows ?? 0) !== 1) {
      throw new ApiError('conflict', '超出剩余可退数量')
    }
  }
}

/** 订单投影：采购退货不回写需求行（需求行已完成/已收不反转） */
const PROJECTION_OPTS = { skipDemandChain: true }

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
  },
) {
  const spec = returnSpec(side)
  return withTx(db, async (trx) => {
    const before = mapHead(await lockHead(trx, permit, spec, id, deps.headTargets))
    if (before.status !== 'DRAFT') throw new ApiError('conflict', `仅草稿${spec.label}可审核`)
    validateHeadShape(spec, before)
    await validateHeadRefs(trx, spec, before)

    const items = await loadActionItems(trx, spec, id)
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
          direction: spec.stockDirection,
          remarks: before.remarks,
        }
      })
    // 金额 = Σ 源行（履约快照比例口径 orderBaseAmount × baseQty / orderBaseQty）
    //       + Σ 手工行（手填原币含税单价 × baseQty × 单头汇率）
    const exchangeRate = decimal(before.exchangeRate ?? '1')
    let amount = decimal(0)
    for (const item of items) {
      if (item.sourceItemId == null) {
        amount = amount.add(
          decimal(item.orderPrice ?? 0).mul(decimal(item.baseQty)).mul(exchangeRate),
        )
      } else if (item.orderBaseQty != null && !decimal(item.orderBaseQty).isZero()) {
        amount = amount.add(
          decimal(item.orderBaseAmount ?? 0)
            .mul(decimal(item.baseQty))
            .div(decimal(item.orderBaseQty)),
        )
      }
    }

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
    const postingDate = before.postingDate ?? before.documentDate
    if (glAmount.gt(0)) {
      if (!postingDate) {
        throw ApiError.validation('审核参数不合法', { postingDate: ['有金额过账时必填'] })
      }
      const currencies = await accountCurrencies(trx, before.debitAccountId, before.creditAccountId)
      // 履约反转：销售退货 = 借选定科目（不带对手）/ 贷未开票应收（带对手）；
      //           采购退货 = 借未开票应付（带对手）/ 贷选定科目
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
        credit.partyType = lowerPartyType(before.partyType)
        credit.partyId = before.partyId
      } else {
        debit.partyType = lowerPartyType(before.partyType)
        debit.partyId = before.partyId
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

    // 投影：来源条目已退数量累加 + 订单条目已发/已收数量回减（仅源单行；手工行无锚点不动投影）
    await adjustReturnedQty(
      trx,
      spec,
      items.filter((i): i is typeof i & { sourceItemId: string } => i.sourceItemId != null),
      1,
    )
    const sourceLines = items
      .filter((i) => i.orderItemId != null)
      .map((i) => ({ orderItemId: i.orderItemId!, baseQty: i.baseQty }))
    await reverseFulfillment(
      trx,
      side,
      {
        companyId: before.companyId,
        partyType: before.partyType,
        partyId: before.partyId,
        lines: sourceLines,
      },
      PROJECTION_OPTS,
    )

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
    return mapHeadDto(row!)
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
  const spec = returnSpec(side)
  return withTx(db, async (trx) => {
    const before = mapHead(await lockHead(trx, permit, spec, id, deps.headTargets))
    if (before.status !== 'AUDITED') {
      throw new ApiError('conflict', `仅已审核${spec.label}可作废`)
    }

    const items = await loadActionItems(trx, spec, id)
    for (const item of items) {
      if (decimal(item.reconciledQty).gt(0)) {
        throw new ApiError('conflict', '存在已对账退货条目,不可作废')
      }
    }

    // 回滚：已退数量（守卫 ≥0）→ 已发/已收数量加回 → 库存/总账分录作废（仅源单行）
    await adjustReturnedQty(
      trx,
      spec,
      items.filter((i): i is typeof i & { sourceItemId: string } => i.sourceItemId != null),
      -1,
    )
    const sourceLines = items
      .filter((i) => i.orderItemId != null)
      .map((i) => ({ orderItemId: i.orderItemId!, baseQty: i.baseQty }))
    await postFulfillment(
      trx,
      side,
      {
        companyId: before.companyId,
        partyType: before.partyType,
        partyId: before.partyId,
        lines: sourceLines,
      },
      PROJECTION_OPTS,
    )
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
    return mapHeadDto(row!)
  })
}

async function lockHead(
  handle: DbHandle,
  permit: Permit,
  spec: ReturnSideSpec,
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
