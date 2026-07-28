/**
 * 过账编排骨架（B 收尾）。
 *
 * ## 履约三方（已迁）
 * `auditFulfillmentInTx` / `voidFulfillmentInTx`：
 * 销售发货 / 采购入库 / 委外入库
 * 「锁头 → collect → 订单投影 → 库存 →（金额>0）总账双分录 → 状态翻转 → 审计」。
 *
 * ## 库存单据（本工单）
 * `auditInventoryDocInTx` / `voidInventoryDocInTx`：
 * 手工出入库 / 盘点 / 生产入库 —— 无总账段；投影可选；空库存行跳过引擎。
 *
 * ## 总账单据（本工单）
 * `auditGlDocInTx` / `voidGlDocInTx`：
 * 报销单 / 承兑交易 / 增值税发票 —— 无库存段；多行 GL 由 collect 产出；
 * 领域副作用（对账结单、replayBill、红冲）走 after* 钩子。
 *
 * ## 形状不合、不硬套（记录原因）
 * - **手工凭证 journal**：已是 `createAndAuditJournal` / `auditJournalInTx` seam，
 *   生命周期（建头+行+审核）与单据审核不同，保持 seam 形态。
 * - **手工调拨 stock-transfer**：发货/收货两段状态机（draft→shipped→received），
 *   非「草稿→已审核→作废」；字段 shipped_at/received_at，收货还写行 received_qty；
 *   与单段 audit/void 骨架不合，保留手写。
 * - **委外发料 outsourced issue**：库存+发料投影、无总账、无 posting_date 列，
 *   形状接近库存骨架，但投影行键为 orderItemMaterialId（非履约 PostingProjectionLine），
 *   且本工单清单未列；可后续再迁 inventory 骨架。
 *
 * 领域差异以钩子注入；骨架不感知单据形状，只编排顺序、引擎调用与状态翻转。
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

// ---------------------------------------------------------------------------
// 履约过账（库存 + 条件总账双分录 + 订单投影）
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 库存单据（仅库存引擎；可选投影；无总账）
// ---------------------------------------------------------------------------

/** 库存单据头投影 */
export interface InvDocVoucher {
  id: string
  no: string
  companyId: string
}

export interface InvDocCollect {
  stockLines: StockLine[]
  /** 库存分录过账日 */
  postingDate: string
}

export interface InvDocAuditSpec<Head> {
  voucherType: string
  headTable: string
  /** 审计 actionName，默认 audit；盘点用 approve */
  actionName?: string
  /**
   * 审核时是否写 posting_date 列。
   * stock_count 有该列；stock_doc / mfg_output 无，须 false。
   */
  setPostingDate?: boolean
  lockDraft: (trx: TrxHandle) => Promise<Head>
  collect: (trx: TrxHandle, head: Head) => Promise<InvDocCollect>
  /** 库存过账后的投影（如工单完工回写）；默认无 */
  postProjection?: (trx: TrxHandle, head: Head) => Promise<void>
  voucherOf: (head: Head) => InvDocVoucher
  reload: (trx: TrxHandle, id: string) => Promise<Head>
  snapshot: (head: Head) => Record<string, unknown>
  auditFields: readonly string[]
}

export interface InvDocVoidSpec<Head> {
  voucherType: string
  headTable: string
  /** 作废目标状态，默认 voided；盘点用 cancelled */
  voidStatus?: string
  /** 审计 actionName，默认 void；盘点用 cancel */
  actionName?: string
  lockAudited: (trx: TrxHandle) => Promise<Head>
  /** 作废前投影回滚；默认无 */
  reverseProjection?: (trx: TrxHandle, head: Head) => Promise<void>
  voucherOf: (head: Head) => InvDocVoucher
  reload: (trx: TrxHandle, id: string) => Promise<Head>
  snapshot: (head: Head) => Record<string, unknown>
  auditFields: readonly string[]
}

/**
 * 库存单据审核：collect → inventory.post（空行跳过）→ 可选投影 → 状态翻转 → 审计。
 */
export async function auditInventoryDocInTx<Head>(
  trx: TrxHandle,
  actor: Actor,
  inventory: Pick<InventoryEngine, 'post' | 'cancel'>,
  spec: InvDocAuditSpec<Head>,
): Promise<Head> {
  const before = await spec.lockDraft(trx)
  const collected = await spec.collect(trx, before)
  const v = spec.voucherOf(before)

  if (collected.stockLines.length > 0) {
    await inventory.post(
      trx,
      {
        type: spec.voucherType,
        id: v.id,
        no: v.no,
        companyId: v.companyId,
        postingDate: collected.postingDate,
      },
      collected.stockLines,
    )
  }

  if (spec.postProjection) {
    await spec.postProjection(trx, before)
  }

  const auditedById = actor.userId || null
  if (spec.setPostingDate) {
    await sql`
      UPDATE ${ident(spec.headTable)} SET
        status='audited',
        posting_date=${collected.postingDate}::date,
        audited_at=(now() AT TIME ZONE 'utc'),
        audited_by_id=${auditedById}::uuid,
        updated_at=(now() AT TIME ZONE 'utc')
      WHERE id=${v.id}::uuid
    `.execute(trx)
  } else {
    await sql`
      UPDATE ${ident(spec.headTable)} SET
        status='audited',
        audited_at=(now() AT TIME ZONE 'utc'),
        audited_by_id=${auditedById}::uuid,
        updated_at=(now() AT TIME ZONE 'utc')
      WHERE id=${v.id}::uuid
    `.execute(trx)
  }

  const after = await spec.reload(trx, v.id)
  const label = spec.voucherOf(after)
  await writeAudit(trx, actor, {
    resource: spec.headTable,
    recordId: v.id,
    recordLabel: label.no,
    companyId: label.companyId,
    actionType: 'update',
    actionName: spec.actionName ?? 'audit',
    changes: auditDiff(spec.snapshot(before), spec.snapshot(after), spec.auditFields),
  })
  return after
}

/**
 * 库存单据作废：可选投影回滚 → inventory.cancel → 状态翻转 → 审计。
 */
export async function voidInventoryDocInTx<Head>(
  trx: TrxHandle,
  actor: Actor,
  inventory: Pick<InventoryEngine, 'post' | 'cancel'>,
  spec: InvDocVoidSpec<Head>,
): Promise<Head> {
  const before = await spec.lockAudited(trx)
  const v = spec.voucherOf(before)

  if (spec.reverseProjection) {
    await spec.reverseProjection(trx, before)
  }
  await inventory.cancel(trx, { type: spec.voucherType, id: v.id }, new Date())

  const nextStatus = spec.voidStatus ?? 'voided'
  await sql`
    UPDATE ${ident(spec.headTable)} SET
      status=${nextStatus},
      updated_at=(now() AT TIME ZONE 'utc')
    WHERE id=${v.id}::uuid
  `.execute(trx)

  const after = await spec.reload(trx, v.id)
  const label = spec.voucherOf(after)
  await writeAudit(trx, actor, {
    resource: spec.headTable,
    recordId: v.id,
    recordLabel: label.no,
    companyId: label.companyId,
    actionType: 'update',
    actionName: spec.actionName ?? 'void',
    changes: auditDiff(spec.snapshot(before), spec.snapshot(after), spec.auditFields),
  })
  return after
}

// ---------------------------------------------------------------------------
// 总账单据（仅 GL 引擎；无库存；副作用钩子）
// ---------------------------------------------------------------------------

export interface GlDocVoucher {
  id: string
  no: string
  companyId: string
}

export interface GlDocCollect {
  entries: GlEntry[]
  postingDate: string | null
  /** true 时跳过 gl.post（如承兑 REALLOCATE） */
  skipGl?: boolean
}

export interface GlDocAuditSpec<Head> {
  voucherType: string
  headTable: string
  actionName?: string
  /**
   * 状态翻转时用 WHERE status='draft' 防并发；默认 true。
   * 命中 0 行抛 conflictMessage。
   */
  concurrentDraftGuard?: boolean
  conflictMessage?: string
  lockDraft: (trx: TrxHandle) => Promise<Head>
  collect: (trx: TrxHandle, head: Head) => Promise<GlDocCollect>
  /**
   * 自定义状态翻转（发票/承兑等需额外列）。
   * 未提供时默认写 status/posting_date/audited_at/audited_by_id。
   */
  flipToAudited?: (
    trx: TrxHandle,
    head: Head,
    meta: { postingDate: string | null; auditedById: string | null },
  ) => Promise<void>
  /** 状态翻转并 reload 之后、写审计之前（对账结单、replayBill 等） */
  afterAudit?: (trx: TrxHandle, before: Head, after: Head) => Promise<void>
  voucherOf: (head: Head) => GlDocVoucher
  reload: (trx: TrxHandle, id: string) => Promise<Head>
  snapshot: (head: Head) => Record<string, unknown>
  auditFields: readonly string[]
}

export type GlEndMode = 'cancel' | 'reverse' | 'skip'

export interface GlDocVoidSpec<Head> {
  voucherType: string
  headTable: string
  actionName?: string
  /** 目标状态，默认 voided；红冲用 reversed */
  voidStatus?: string
  lockAudited: (trx: TrxHandle) => Promise<Head>
  /**
   * 决定 GL 收口方式；默认 cancel。
   * reverse 时须返回 reversePostingDate。
   */
  resolveGlEnd?: (
    trx: TrxHandle,
    head: Head,
  ) => Promise<{ mode: GlEndMode; reversePostingDate?: string }>
  /**
   * 自定义状态翻转（清对账 FK、写 red_invoice_no 等）。
   * 未提供时默认只改 status。
   */
  flipToEnded?: (trx: TrxHandle, head: Head, nextStatus: string) => Promise<void>
  afterVoid?: (trx: TrxHandle, before: Head, after: Head) => Promise<void>
  voucherOf: (head: Head) => GlDocVoucher
  reload: (trx: TrxHandle, id: string) => Promise<Head>
  snapshot: (head: Head) => Record<string, unknown>
  auditFields: readonly string[]
}

/**
 * 总账单据审核：collect →（可选）gl.post → 状态翻转 → afterAudit → 审计。
 */
export async function auditGlDocInTx<Head>(
  trx: TrxHandle,
  actor: Actor,
  gl: Pick<GlEngine, 'post' | 'cancel' | 'reverse'>,
  spec: GlDocAuditSpec<Head>,
): Promise<Head> {
  const before = await spec.lockDraft(trx)
  const collected = await spec.collect(trx, before)
  const v = spec.voucherOf(before)
  const auditedById = actor.userId || null

  if (spec.flipToAudited) {
    await spec.flipToAudited(trx, before, {
      postingDate: collected.postingDate,
      auditedById,
    })
  } else {
    const useGuard = spec.concurrentDraftGuard !== false
    if (useGuard) {
      const tag = await sql`
        UPDATE ${ident(spec.headTable)} SET
          status='audited',
          posting_date=${collected.postingDate}::date,
          audited_at=(now() AT TIME ZONE 'utc'),
          audited_by_id=${auditedById}::uuid,
          updated_at=(now() AT TIME ZONE 'utc')
        WHERE id=${v.id}::uuid AND status='draft'
      `.execute(trx)
      if (Number(tag.numAffectedRows ?? 0) !== 1) {
        throw new ApiError('conflict', spec.conflictMessage ?? '单据已被并发处理')
      }
    } else {
      await sql`
        UPDATE ${ident(spec.headTable)} SET
          status='audited',
          posting_date=${collected.postingDate}::date,
          audited_at=(now() AT TIME ZONE 'utc'),
          audited_by_id=${auditedById}::uuid,
          updated_at=(now() AT TIME ZONE 'utc')
        WHERE id=${v.id}::uuid
      `.execute(trx)
    }
  }

  if (!collected.skipGl) {
    if (!collected.postingDate) {
      throw ApiError.validation('审核参数不合法', { postingDate: ['过账时必填'] })
    }
    if (collected.entries.length === 0) {
      throw new ApiError('conflict', '过账分录不能为空')
    }
    await gl.post(
      trx,
      {
        type: spec.voucherType,
        id: v.id,
        no: v.no,
        companyId: v.companyId,
        postingDate: collected.postingDate,
      },
      collected.entries,
    )
  }

  let after = await spec.reload(trx, v.id)
  if (spec.afterAudit) {
    await spec.afterAudit(trx, before, after)
    after = await spec.reload(trx, v.id)
  }

  const label = spec.voucherOf(after)
  await writeAudit(trx, actor, {
    resource: spec.headTable,
    recordId: v.id,
    recordLabel: label.no,
    companyId: label.companyId,
    actionType: 'update',
    actionName: spec.actionName ?? 'audit',
    changes: auditDiff(spec.snapshot(before), spec.snapshot(after), spec.auditFields),
  })
  return after
}

/**
 * 总账单据作废/红冲：resolveGlEnd → gl.cancel|reverse|skip → 状态翻转 → afterVoid → 审计。
 */
export async function voidGlDocInTx<Head>(
  trx: TrxHandle,
  actor: Actor,
  gl: Pick<GlEngine, 'post' | 'cancel' | 'reverse'>,
  spec: GlDocVoidSpec<Head>,
): Promise<Head> {
  const before = await spec.lockAudited(trx)
  const v = spec.voucherOf(before)
  const end = spec.resolveGlEnd
    ? await spec.resolveGlEnd(trx, before)
    : { mode: 'cancel' as const }

  if (end.mode === 'reverse') {
    if (!end.reversePostingDate) {
      throw ApiError.validation('红冲参数不合法', { postingDate: ['必填'] })
    }
    await gl.reverse(trx, { type: spec.voucherType, id: v.id }, end.reversePostingDate)
  } else if (end.mode === 'cancel') {
    await gl.cancel(trx, { type: spec.voucherType, id: v.id })
  }

  const nextStatus = spec.voidStatus ?? 'voided'
  if (spec.flipToEnded) {
    await spec.flipToEnded(trx, before, nextStatus)
  } else {
    await sql`
      UPDATE ${ident(spec.headTable)} SET
        status=${nextStatus},
        updated_at=(now() AT TIME ZONE 'utc')
      WHERE id=${v.id}::uuid
    `.execute(trx)
  }

  let after = await spec.reload(trx, v.id)
  if (spec.afterVoid) {
    await spec.afterVoid(trx, before, after)
    after = await spec.reload(trx, v.id)
  }

  const label = spec.voucherOf(after)
  await writeAudit(trx, actor, {
    resource: spec.headTable,
    recordId: v.id,
    recordLabel: label.no,
    companyId: label.companyId,
    actionType: 'update',
    actionName: spec.actionName ?? 'void',
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
