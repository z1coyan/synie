/**
 * 履约过账编排骨架：销售发货 / 采购入库 / 委外入库共用的
 * 「锁头 → 校验收集 → 订单投影 → 库存引擎 →（金额>0）总账引擎 → 状态翻转 → 审计」流水线。
 *
 * 领域差异（行收集、仓/外协校验、快照与审计字段、DTO 形状）以钩子注入；
 * 骨架不感知单据形状，只编排顺序、引擎调用与状态翻转——
 * 过账规则（零金额跳总账、过账日期解析、往来对手挂借/贷、舍入）只此一份。
 */
import { decimal, roundAmount, type Decimal } from '@synie/shared'
import { sql } from 'kysely'
import type { GlEngine, GlEntry } from '~/engines/gl/index.ts'
import type { InventoryEngine, StockLine } from '~/engines/inventory/index.ts'
import type { TrxHandle } from '~/db/tx.ts'
import { auditDiff, writeAudit } from '~/platform/audit/write.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { ident, lowerParty, toDateOnly } from './common.ts'

/** 骨架视角的单据头投影（各领域头经 voucherOf 映射而来） */
export interface PostingVoucher {
  id: string
  no: string
  companyId: string
  /** 业务日（发货/入库日期），库存分录的过账日 */
  documentDate: string
  /** 头上显式过账日期（可空，空回退业务日） */
  postingDate: string | null
  partyType: string
  partyId: string
  debitAccountId: string
  creditAccountId: string
}

export interface PostingProjectionLine {
  orderItemId: string
  baseQty: string
}

/** collect 钩子的产物：投影行 + 库存行 + 过账金额（未舍入） */
export interface PostingCollect {
  projectionLines: PostingProjectionLine[]
  stockLines: StockLine[]
  amount: Decimal
}

export interface FulfillAuditSpec<Head> {
  voucherType: string
  /** 状态翻转 UPDATE 目标表（经 ident 白名单） */
  headTable: string
  /** 往来对手挂借方（销售发货）或贷方（采购/委外入库） */
  partySide: 'debit' | 'credit'
  /** 过账日期覆盖（入参优先于头上 postingDate） */
  postingDateOverride?: string | null
  /** 锁头 + 草稿门 + 头形状/引用校验 */
  lockDraft: (trx: TrxHandle) => Promise<Head>
  /** 收集并校验过账素材（行容差、仓/外协仓、装箱等值、金额分摊） */
  collect: (trx: TrxHandle, head: Head) => Promise<PostingCollect>
  /** 订单投影累加（已发/已收数量） */
  postProjection: (trx: TrxHandle, head: Head, lines: PostingProjectionLine[]) => Promise<void>
  /** 骨架视角投影 */
  voucherOf: (head: Head) => PostingVoucher
  /** 状态翻转后重载头 */
  reload: (trx: TrxHandle, id: string) => Promise<Head>
  snapshot: (head: Head) => Record<string, unknown>
  auditFields: readonly string[]
}

export interface FulfillVoidSpec<Head> {
  voucherType: string
  headTable: string
  /** 锁头 + 已审核门 */
  lockAudited: (trx: TrxHandle) => Promise<Head>
  /** 作废涉及的投影行（内含已对账行拦截），供投影回滚 */
  voidableLines: (trx: TrxHandle, head: Head) => Promise<PostingProjectionLine[]>
  /** 订单投影回滚 */
  reverseProjection: (trx: TrxHandle, head: Head, lines: PostingProjectionLine[]) => Promise<void>
  voucherOf: (head: Head) => PostingVoucher
  reload: (trx: TrxHandle, id: string) => Promise<Head>
  snapshot: (head: Head) => Record<string, unknown>
  auditFields: readonly string[]
}

export interface PostingEngines {
  inventory: Pick<InventoryEngine, 'post' | 'cancel'>
  gl: Pick<GlEngine, 'post' | 'cancel'>
}

/**
 * 审核过账：投影 → 库存 →（金额>0）总账 → 状态翻转 → 审计。
 * 调用方持有 trx（withTx 包裹），骨架不自起事务。
 */
export async function auditFulfillmentInTx<Head>(
  trx: TrxHandle,
  actor: Actor,
  engines: PostingEngines,
  spec: FulfillAuditSpec<Head>,
): Promise<Head> {
  const before = await spec.lockDraft(trx)
  const collected = await spec.collect(trx, before)
  const v = spec.voucherOf(before)

  await spec.postProjection(trx, before, collected.projectionLines)
  await engines.inventory.post(
    trx,
    { type: spec.voucherType, id: v.id, no: v.no, companyId: v.companyId, postingDate: v.documentDate },
    collected.stockLines,
  )

  const amount = decimal(roundAmount(collected.amount))
  let postingDate = v.postingDate ?? v.documentDate
  if (spec.postingDateOverride) postingDate = toDateOnly(spec.postingDateOverride)
  if (amount.gt(0)) {
    if (!postingDate) {
      throw ApiError.validation('审核参数不合法', { postingDate: ['有金额过账时必填'] })
    }
    const currencies = await accountCurrencies(trx, v.debitAccountId, v.creditAccountId)
    const debit: GlEntry = {
      accountId: v.debitAccountId,
      currencyId: currencies.debit,
      debit: amount,
      credit: decimal(0),
    }
    const credit: GlEntry = {
      accountId: v.creditAccountId,
      currencyId: currencies.credit,
      debit: decimal(0),
      credit: amount,
    }
    if (spec.partySide === 'debit') {
      debit.partyType = lowerParty(v.partyType)
      debit.partyId = v.partyId
    } else {
      credit.partyType = lowerParty(v.partyType)
      credit.partyId = v.partyId
    }
    await engines.gl.post(
      trx,
      { type: spec.voucherType, id: v.id, no: v.no, companyId: v.companyId, postingDate },
      [debit, credit],
    )
  }

  const auditedById = actor.userId || null
  await sql`
    UPDATE ${ident(spec.headTable)} SET
      status='audited',
      posting_date=${postingDate}::date,
      audited_at=(now() AT TIME ZONE 'utc'),
      audited_by_id=${auditedById}::uuid,
      updated_at=(now() AT TIME ZONE 'utc')
    WHERE id=${v.id}::uuid
  `.execute(trx)

  const after = await spec.reload(trx, v.id)
  await writeAudit(trx, actor, {
    resource: spec.headTable,
    recordId: v.id,
    recordLabel: spec.voucherOf(after).no,
    companyId: spec.voucherOf(after).companyId,
    actionType: 'update',
    actionName: 'audit',
    changes: auditDiff(spec.snapshot(before), spec.snapshot(after), spec.auditFields),
  })
  return after
}

/**
 * 作废：投影回滚 → 库存分录作废 → 总账分录作废 → 状态翻转 → 审计。
 * 调用方持有 trx，骨架不自起事务。
 */
export async function voidFulfillmentInTx<Head>(
  trx: TrxHandle,
  actor: Actor,
  engines: PostingEngines,
  spec: FulfillVoidSpec<Head>,
): Promise<Head> {
  const before = await spec.lockAudited(trx)
  const lines = await spec.voidableLines(trx, before)
  const v = spec.voucherOf(before)

  await spec.reverseProjection(trx, before, lines)
  await engines.inventory.cancel(trx, { type: spec.voucherType, id: v.id })
  await engines.gl.cancel(trx, { type: spec.voucherType, id: v.id })
  await sql`
    UPDATE ${ident(spec.headTable)} SET status='voided', updated_at=(now() AT TIME ZONE 'utc')
    WHERE id=${v.id}::uuid
  `.execute(trx)

  const after = await spec.reload(trx, v.id)
  await writeAudit(trx, actor, {
    resource: spec.headTable,
    recordId: v.id,
    recordLabel: spec.voucherOf(after).no,
    companyId: spec.voucherOf(after).companyId,
    actionType: 'update',
    actionName: 'void',
    changes: auditDiff(spec.snapshot(before), spec.snapshot(after), spec.auditFields),
  })
  return after
}

/** 借贷科目币种（曾逐字重复于 fulfillment/outsourced 两处） */
async function accountCurrencies(db: TrxHandle, debitId: string, creditId: string) {
  const rows = await sql<{ id: string; currency_id: string | null }>`
    SELECT id, currency_id FROM bas_account WHERE id = ANY(${[debitId, creditId]}::uuid[])
  `.execute(db)
  const map = new Map(rows.rows.map((r) => [r.id, r.currency_id]))
  return { debit: map.get(debitId) ?? null, credit: map.get(creditId) ?? null }
}
