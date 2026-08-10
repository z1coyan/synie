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
import { insertDerivedDemand } from '~/modules/manufacturing/demand-domain.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import {
  headSnap,
  loadActionItems,
  loadHead,
  mapHead,
  validateHeadRefs,
  validateHeadShape,
} from './domain.ts'
import { returnSpec, type ReturnKind, type ReturnSideSpec } from './spec.ts'
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
  side: ReturnKind,
  id: string,
  deps: {
    inventory: Pick<InventoryEngine, 'post' | 'cancel'>
    gl: Pick<GlEngine, 'post' | 'cancel'>
    headTargets: Record<ReturnKind, AuthzTarget>
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
    // 委外复检：源入库条目已对账数量 > 0 禁止退货（保存期已拦，审核兜底复检）
    if (!spec.monetary) {
      const sourceIds = [
        ...new Set(
          items
            .map((i) => i.sourceItemId)
            .filter((v): v is string => v != null),
        ),
      ]
      for (const sourceItemId of sourceIds.sort()) {
        const r = await sql<{ reconciled_qty: string }>`
          SELECT reconciled_qty::text FROM ${ident(spec.sourceItemTable)}
          WHERE id=${sourceItemId}::uuid FOR UPDATE
        `.execute(trx)
        if (decimal(r.rows[0]?.reconciled_qty ?? 0).gt(0)) {
          throw new ApiError('conflict', '源入库条目已对账,须先撤回/作废相关采购对账单')
        }
      }
    }

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
    //       + Σ 手工行（手填原币含税单价 × 行单位数量 qty × 单头汇率——单价按行单位计，
    //         用 baseQty 会被单位换算系数放大）；委外纯数量单不算金额
    const exchangeRate = decimal(before.exchangeRate ?? '1')
    let amount = decimal(0)
    if (spec.monetary) {
      for (const item of items) {
        if (item.sourceItemId == null) {
          amount = amount.add(
            decimal(item.orderPrice ?? 0).mul(decimal(item.qty)).mul(exchangeRate),
          )
        } else if (item.orderBaseQty != null && !decimal(item.orderBaseQty).isZero()) {
          amount = amount.add(
            decimal(item.orderBaseAmount ?? 0)
              .mul(decimal(item.baseQty))
              .div(decimal(item.orderBaseQty)),
          )
        }
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
    if (spec.monetary && glAmount.gt(0)) {
      if (!postingDate) {
        throw ApiError.validation('审核参数不合法', { postingDate: ['有金额过账时必填'] })
      }
      const currencies = await accountCurrencies(trx, before.debitAccountId!, before.creditAccountId!)
      // 履约反转：销售退货 = 借选定科目（不带对手）/ 贷未开票应收（带对手）；
      //           采购退货 = 借未开票应付（带对手）/ 贷选定科目
      const debit: GlEntry = {
        accountId: before.debitAccountId!,
        currencyId: currencies.debit,
        debit: glAmount,
        credit: decimal(0),
      }
      const credit: GlEntry = {
        accountId: before.creditAccountId!,
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
      spec.projectionSide,
      {
        companyId: before.companyId,
        partyType: before.partyType,
        partyId: before.partyId,
        lines: sourceLines,
        requireOutsourced: spec.requireOutsourced,
      },
      PROJECTION_OPTS,
    )

    const auditedById = permit.actor.userId || null
    // 委外纯数量单头无 posting_date 列
    const postingSet = spec.monetary ? sql`posting_date=${postingDate}::date,` : sql``
    await sql`
      UPDATE ${ident(spec.headTable)} SET
        status='audited',
        ${postingSet}
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
  side: ReturnKind,
  id: string,
  deps: {
    inventory: Pick<InventoryEngine, 'post' | 'cancel'>
    gl: Pick<GlEngine, 'post' | 'cancel'>
    headTargets: Record<ReturnKind, AuthzTarget>
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
    // 加回不重验订单状态与超发/超收上限（verify:false）——订单可能已关闭、缺口可能已被重发填满
    await postFulfillment(
      trx,
      spec.projectionSide,
      {
        companyId: before.companyId,
        partyType: before.partyType,
        partyId: before.partyId,
        lines: sourceLines,
        requireOutsourced: spec.requireOutsourced,
      },
      { ...PROJECTION_OPTS, verify: false },
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

/**
 * 「生成补货需求单」（仅销售退货、已审核单）：全部退货行转成一张履约需求单草稿——
 * 行 = 退货行物料 + 数量（行单位/折默认单位），需求日默认 = 退货日期；
 * 源单行来源 = 对应销售订单条目，手工行 = 无来源手工行。
 * 可重复点击，每次生成一张新草稿；头留 source_return_id 链接供追溯。
 * 重复生成的超量由需求单确认时的销售占用校验兜底（占用上限 = 订购 + 已退）。
 */
export async function runGenerateReplenishment(
  db: Kysely<Database>,
  permit: Permit,
  id: string,
  deps: {
    headTargets: Record<ReturnKind, AuthzTarget>
    numberer: Pick<NumberingService, 'nextInTx'>
  },
) {
  const spec = returnSpec('sales')
  return withTx(db, async (trx) => {
    const before = mapHead(await lockHead(trx, permit, spec, id, deps.headTargets))
    if (before.status !== 'AUDITED') {
      throw new ApiError('conflict', `仅已审核${spec.label}可生成补货需求单`)
    }
    const rows = await sql<Record<string, unknown>>`
      SELECT idx, material_id, unit_id, qty::text, base_qty::text,
        material_code, material_name, material_spec, unit_name, order_item_id
      FROM ${ident(spec.itemTable)}
      WHERE return_id=${before.id}::uuid
      ORDER BY idx, id
    `.execute(trx)
    if (rows.rows.length === 0) {
      throw new ApiError('conflict', '没有退货条目可生成补货需求')
    }
    const demandNo = await deps.numberer.nextInTx(trx, {
      resource: 'mfg.demand',
      values: { company_id: before.companyId, demand_date: before.documentDate },
    })
    // 需求行口径 = 物料默认单位（销售退货.md：数量折默认单位）；退货行可能是转换单位
    const materialIds = [...new Set(rows.rows.map((r) => String(r.material_id)))]
    const defaults = await trx
      .selectFrom('inv_material as m')
      .innerJoin('bas_unit as u', 'u.id', 'm.default_unit_id')
      .select(['m.id as id', 'm.default_unit_id as unitId', 'u.name as unitName'])
      .where('m.id', 'in', materialIds)
      .execute()
    const defaultUnit = new Map(
      defaults.map((d) => [String(d.id), { unitId: String(d.unitId), unitName: String(d.unitName) }]),
    )
    // 指派类型默认 stock（现货补发是退货补货最常见形态；纯意图层路由声明，计划员可在草稿改派）
    const created = await insertDerivedDemand(trx, permit.actor, {
      companyId: before.companyId,
      demandNo,
      demandDate: before.documentDate,
      remarks: `退货补货:${before.no}`,
      assignType: 'stock',
      assignedDeptId: null,
      sourceReturnId: before.id,
      lines: rows.rows.map((r) => ({
        idx: Number(r.idx),
        materialId: String(r.material_id),
        unitId: defaultUnit.get(String(r.material_id))!.unitId,
        qty: String(r.base_qty),
        baseQty: String(r.base_qty),
        needDate: before.documentDate,
        sourceWorkOrderId: null,
        salesOrderItemId: r.order_item_id ? String(r.order_item_id) : null,
        materialCode: String(r.material_code),
        materialName: String(r.material_name),
        materialSpec: r.material_spec == null ? null : String(r.material_spec),
        unitName: defaultUnit.get(String(r.material_id))!.unitName,
        remarks: `退货补货:${before.no}`,
      })),
    })
    await writeAudit(trx, permit.actor, {
      resource: spec.headTable,
      recordId: before.id,
      recordLabel: before.no,
      companyId: before.companyId,
      actionType: 'update',
      actionName: 'generate_replenishment',
      changes: {},
    })
    return { demandId: created.id, demandNo: created.demandNo }
  })
}

async function lockHead(
  handle: DbHandle,
  permit: Permit,
  spec: ReturnSideSpec,
  id: string,
  headTargets: Record<ReturnKind, AuthzTarget>,
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
