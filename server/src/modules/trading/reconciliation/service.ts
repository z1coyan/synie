/**
 * 销售/采购对账单：对称服务。
 * 常规：草稿→确认(占量+待办)→发票结单；赠送/样品：草稿→结单(占量+GL)→可作废。
 *
 * 授权全由平台承担：路由挂 `guard(资源, 动作)`，本服务只收 Permit——
 * 列表 `listAuthorized`、单条 `loadAuthorizedFrom`（与列表共用投影）、
 * 写前取行 `loadAuthorized(forUpdate)`、create 走 `assertCompanyWritable`。
 * `side` 只决定表/域差异，权限差异由路由选中的资源名（spec.headResource/itemResource）承载。
 * 状态前置条件（草稿才能改等）是领域不变量，留在本文件抛 conflict。
 * 发票联动接缝（closeFromInvoice/reopenFromInvoice/invoiceState）仍收 Actor：
 * 调用方是 finance 的内部事务，本就不做公司判定，只用 actor 写审计。
 */
import type { ListQuery } from '@synie/shared'
import { decimal, roundAmount, roundBaseQty } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { withTx, type DbHandle, type TrxHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import type { GlEngine } from '~/engines/gl/index.ts'
import {
  auditCreated,
  auditDestroyed,
  auditDiff,
  writeAudit,
} from '~/platform/audit/write.ts'
import { auditFieldsOf, mergeAuditFields } from '~/platform/audit/spec.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { AuthzTarget } from '~/platform/meta/resource-authz.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import { listAuthorized } from '~/db/list.ts'
import { assertCompanyWritable, loadAuthorized, loadAuthorizedFrom } from '~/db/load.ts'
import { mapWriteError } from '~/db/dberr.ts'
import {
  asDate,
  asDateTime,
  asOptionalString,
  ident,
  lowerParty,
  partyExists,
  runeLen,
  toDateOnly,
  type TradingSide,
  upperStatus,
  wireRequiredDecimal,
} from '../common.ts'
import { utcToday } from '~/db/dates.ts'
import {
  reconciliationHeadMeta,
  reconciliationItemMeta,
  reconciliationSpec,
  type ReconciliationKind,
  type ReconciliationSideSpec,
  type ReconciliationStatus,
} from './spec.ts'

// 双侧共用引擎：白名单取两侧 meta 派生并集（保留历史共享清单行为）
const HEAD_AUDIT = mergeAuditFields(
  auditFieldsOf(reconciliationHeadMeta('sales')),
  auditFieldsOf(reconciliationHeadMeta('purchase')),
)

const ITEM_AUDIT = mergeAuditFields(
  auditFieldsOf(reconciliationItemMeta('sales')),
  auditFieldsOf(reconciliationItemMeta('purchase')),
)

/**
 * 投影子查询的别名：listAuthorized / loadAuthorizedFrom 必须与 source 的 `) 别名` 逐字一致，
 * 否则 via 链的 EXISTS 会静默算成空集。故此处单点定义，source 用 sql.raw 回填。
 */
const HEAD_ALIAS = 'reconciliations'
const ITEM_ALIAS = 'reconciliation_items'

/** 列表与单条共用一份 select（别名只有一处可写错） */
const HEAD_SELECT = sql`SELECT id,reconciliation_no,reconciliation_type,party_type,party_id,
  posting_date,remarks,status,inserted_at,updated_at,company_id,
  debit_account_id,credit_account_id,created_by_id,gross_total,base_gross_total`

type Numberer = Pick<NumberingService, 'nextInTx'>

interface SourceItem {
  id: string
  companyId: string
  partyType: string
  partyId: string
  status: string
  no: string
  sourceDate: string
  materialName: string
  unitName: string
  currencyCode: string
  qty: ReturnType<typeof decimal>
  baseQty: ReturnType<typeof decimal>
  reconciledQty: ReturnType<typeof decimal>
  price: ReturnType<typeof decimal>
  exchangeRate: ReturnType<typeof decimal>
  orderType: string
  orderId: string
  outsourced: boolean
}

export function createReconciliationService(
  db: Kysely<Database>,
  numberer: Numberer,
  gl: Pick<GlEngine, 'post' | 'cancel'>,
  registry: Registry,
) {
  // 判定归宿按 side 解析：双边资源不同，权限差异全在资源名上
  const headTargets: Record<TradingSide, AuthzTarget> = {
    sales: registry.authzTarget(reconciliationSpec('sales').headResource),
    purchase: registry.authzTarget(reconciliationSpec('purchase').headResource),
  }
  const itemTargets: Record<TradingSide, AuthzTarget> = {
    sales: registry.authzTarget(reconciliationSpec('sales').itemResource),
    purchase: registry.authzTarget(reconciliationSpec('purchase').itemResource),
  }

  /** 锁单头：授权取行（FOR UPDATE，不命中一律 not_found）+ 取投影 */
  async function lockHead(
    handle: DbHandle,
    permit: Permit,
    spec: ReconciliationSideSpec,
    id: string,
  ): Promise<Record<string, unknown>> {
    await loadAuthorized({
      db: handle,
      permit,
      target: headTargets[spec.side],
      table: spec.table,
      id,
      forUpdate: true,
      notFoundMessage: `${spec.label}不存在`,
    })
    const row = await queryHead(handle, spec, id)
    if (!row) throw new ApiError('not_found', `${spec.label}不存在`)
    return row
  }

  /** 条目的可达性经 via 链递归到母单自身的行谓词；返回裸行（写路径用） */
  async function loadItemRow(handle: DbHandle, permit: Permit, side: TradingSide, id: string) {
    return loadAuthorized({
      db: handle,
      permit,
      target: itemTargets[side],
      table: reconciliationSpec(side).itemTable,
      id,
      notFoundMessage: '对账条目不存在',
    })
  }

  async function listHeads(permit: Permit, side: TradingSide, query: Partial<ListQuery>) {
    const spec = reconciliationSpec(side)
    return listAuthorized({
      db,
      permit,
      target: headTargets[side],
      alias: HEAD_ALIAS,
      resource: reconciliationHeadMeta(side),
      source: headListSource(spec),
      select: HEAD_SELECT,
      defaultOrder: sql`"inserted_at" DESC, "id" DESC`,
      query,
      mapRow: (r) => mapHeadDto(r),
    })
  }

  async function getHead(permit: Permit, side: TradingSide, id: string) {
    const spec = reconciliationSpec(side)
    return loadAuthorizedFrom({
      db,
      permit,
      target: headTargets[side],
      alias: HEAD_ALIAS,
      source: headListSource(spec),
      select: HEAD_SELECT,
      id,
      mapRow: (r) => mapHeadDto(r),
      notFoundMessage: `${spec.label}不存在`,
    })
  }

  async function createHead(
    permit: Permit,
    side: TradingSide,
    input: {
      companyId: string
      no?: string | null
      kind: string
      partyType: string
      partyId: string
      debitAccountId?: string | null
      creditAccountId?: string | null
      remarks?: string | null
    },
  ) {
    const spec = reconciliationSpec(side)
    if (!input.companyId) {
      throw ApiError.validation(`${spec.label}参数不合法`, { companyId: ['必填'] })
    }
    // 入参校验（400）先于公司边界（404）：错误语义唯一规则只管后者
    assertCompanyWritable(permit, input.companyId, '公司不存在')
    return withTx(db, async (trx) => {
      let debitAccountId = input.debitAccountId ?? ''
      let creditAccountId = input.creditAccountId ?? ''
      const filled = await fillDefaultAccounts(trx, spec, input.companyId, debitAccountId, creditAccountId)
      debitAccountId = filled.debitAccountId
      creditAccountId = filled.creditAccountId
      const kind = parseKind(input.kind)
      const partyType = lowerParty(input.partyType)
      validateHeadShape(spec, {
        companyId: input.companyId,
        no: input.no,
        kind,
        partyType,
        partyId: input.partyId,
        debitAccountId,
        creditAccountId,
        remarks: input.remarks,
      })
      await validateReferences(
        trx,
        spec,
        input.companyId,
        partyType,
        input.partyId,
        debitAccountId,
        creditAccountId,
      )
      let no = (input.no ?? '').trim()
      if (!no) {
        no = await numberer.nextInTx(trx, {
          resource: spec.prefix,
          values: { company_id: input.companyId, posting_date: utcToday() },
        })
      }
      try {
        const ins = await sql<{ id: string }>`
          INSERT INTO ${ident(spec.table)} (
            reconciliation_no, reconciliation_type, party_type, party_id, remarks,
            company_id, debit_account_id, credit_account_id, created_by_id
          ) VALUES (
            ${no}, ${kind}, ${partyType}, ${input.partyId}::uuid, ${input.remarks ?? null},
            ${input.companyId}::uuid, ${debitAccountId}::uuid, ${creditAccountId}::uuid,
            ${permit.actor.userId || null}::uuid
          ) RETURNING id
        `.execute(trx)
        const id = ins.rows[0]!.id
        const row = await queryHead(trx, spec, id)
        const dto = mapHeadDto(row!)
        await writeAudit(trx, permit.actor, {
          resource: spec.table,
          recordId: id,
          recordLabel: no,
          companyId: input.companyId,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(headSnap(row!), HEAD_AUDIT),
        })
        return dto
      } catch (err) {
        throw mapWriteError(err, `创建${spec.label}失败`, [
          { code: '23505', message: '对账单号已存在' },
        ])
      }
    })
  }

  async function updateHead(
    permit: Permit,
    side: TradingSide,
    id: string,
    input: {
      no?: string
      kind?: string
      partyType?: string
      partyId?: string
      debitAccountId?: string
      creditAccountId?: string
      remarks?: string | null
      remarksPresent?: boolean
    },
  ) {
    const spec = reconciliationSpec(side)
    return withTx(db, async (trx) => {
      const before = await lockHead(trx, permit, spec, id)
      if (String(before.status) !== 'draft') {
        throw new ApiError('conflict', `仅草稿${spec.label}可修改`)
      }
      if (input.kind !== undefined && parseKind(input.kind) !== String(before.reconciliation_type)) {
        throw new ApiError('conflict', '对账类型不可变更')
      }
      let partyType = String(before.party_type)
      let partyId = String(before.party_id)
      let partyChanged = false
      if (input.partyType !== undefined) {
        partyType = lowerParty(input.partyType)
        partyChanged = partyType !== String(before.party_type)
      }
      if (input.partyId !== undefined) {
        partyId = input.partyId
        partyChanged = partyChanged || partyId !== String(before.party_id)
      }
      if (partyChanged) {
        const has = await sql<{ e: boolean }>`
          SELECT EXISTS(SELECT 1 FROM ${ident(spec.itemTable)} WHERE reconciliation_id=${id}::uuid) AS e
        `.execute(trx)
        if (has.rows[0]?.e) {
          throw new ApiError('conflict', '请先删除对账条目')
        }
      }
      const no = input.no !== undefined ? input.no.trim() : String(before.reconciliation_no)
      const debitAccountId =
        input.debitAccountId !== undefined ? input.debitAccountId : String(before.debit_account_id)
      const creditAccountId =
        input.creditAccountId !== undefined
          ? input.creditAccountId
          : String(before.credit_account_id)
      const remarks = input.remarksPresent
        ? (input.remarks ?? null)
        : asOptionalString(before.remarks)
      validateHeadShape(spec, {
        companyId: String(before.company_id),
        no,
        kind: String(before.reconciliation_type) as ReconciliationKind,
        partyType,
        partyId,
        debitAccountId,
        creditAccountId,
        remarks,
      })
      await validateReferences(
        trx,
        spec,
        String(before.company_id),
        partyType,
        partyId,
        debitAccountId,
        creditAccountId,
      )
      const afterRow = {
        ...before,
        reconciliation_no: no,
        party_type: partyType,
        party_id: partyId,
        debit_account_id: debitAccountId,
        credit_account_id: creditAccountId,
        remarks,
      }
      const changes = auditDiff(headSnap(before), headSnap(afterRow), HEAD_AUDIT)
      if (Object.keys(changes).length === 0) return mapHeadDto(before)
      try {
        await sql`
          UPDATE ${ident(spec.table)} SET
            reconciliation_no=${no},
            party_type=${partyType},
            party_id=${partyId}::uuid,
            debit_account_id=${debitAccountId}::uuid,
            credit_account_id=${creditAccountId}::uuid,
            remarks=${remarks},
            updated_at=(now() AT TIME ZONE 'utc')
          WHERE id=${id}::uuid
        `.execute(trx)
        const row = await queryHead(trx, spec, id)
        await writeAudit(trx, permit.actor, {
          resource: spec.table,
          recordId: id,
          recordLabel: no,
          companyId: String(before.company_id),
          actionType: 'update',
          actionName: 'update',
          changes,
        })
        return mapHeadDto(row!)
      } catch (err) {
        throw mapWriteError(err, `更新${spec.label}失败`, [
          { code: '23505', message: '对账单号已存在' },
        ])
      }
    })
  }

  async function deleteHead(permit: Permit, side: TradingSide, id: string) {
    const spec = reconciliationSpec(side)
    await withTx(db, async (trx) => {
      const before = await lockHead(trx, permit, spec, id)
      if (String(before.status) !== 'draft') {
        throw new ApiError('conflict', `仅草稿${spec.label}可删除`)
      }
      await writeAudit(trx, permit.actor, {
        resource: spec.table,
        recordId: id,
        recordLabel: String(before.reconciliation_no),
        companyId: String(before.company_id),
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(headSnap(before), HEAD_AUDIT),
      })
      try {
        await sql`DELETE FROM ${ident(spec.table)} WHERE id=${id}::uuid`.execute(trx)
      } catch (err) {
        throw mapWriteError(err, `删除${spec.label}失败`, [
          { code: '23505', message: '对账单号已存在' },
        ])
      }
    })
  }

  async function confirm(permit: Permit, side: TradingSide, id: string) {
    const spec = reconciliationSpec(side)
    return changeState(permit, spec, id, 'draft', 'confirmed', 'regular', 'confirm', async (trx, before) => {
      await adjustProjection(trx, spec, id, 1)
      await openTodo(trx, spec, before, permit.actor.userId || null)
    })
  }

  async function unconfirm(permit: Permit, side: TradingSide, id: string) {
    const spec = reconciliationSpec(side)
    return changeState(permit, spec, id, 'confirmed', 'draft', 'regular', 'unconfirm', async (trx, before) => {
      const column = side === 'sales' ? 'sal_reconciliation_id' : 'pur_reconciliation_id'
      const linked = await sql<{ e: boolean }>`
        SELECT EXISTS(SELECT 1 FROM acc_vat_invoice WHERE ${sql.raw(column)}=${before.id}::uuid) AS e
      `.execute(trx)
      if (linked.rows[0]?.e) {
        throw new ApiError('conflict', '已关联发票，不可撤回确认')
      }
      await adjustProjection(trx, spec, id, -1)
      await closeTodos(trx, spec, id, 'unconfirm')
    })
  }

  async function audit(
    permit: Permit,
    side: TradingSide,
    id: string,
    input: { postingDate?: string | null },
  ) {
    const spec = reconciliationSpec(side)
    return withTx(db, async (trx) => {
      const before = await lockHead(trx, permit, spec, id)
      if (String(before.reconciliation_type) !== 'gift_sample' || String(before.status) !== 'draft') {
        throw new ApiError('conflict', '仅草稿赠送/样品对账单可结单审核')
      }
      await requireItems(trx, spec, id)
      await adjustProjection(trx, spec, id, 1)
      const posting = input.postingDate ? toDateOnly(input.postingDate) : utcToday()
      const baseGross = decimal(String(before.base_gross_total ?? 0))
      if (baseGross.gt(0)) {
        await postGiftGL(trx, gl, spec, before, posting)
      }
      await sql`
        UPDATE ${ident(spec.table)} SET status='closed', posting_date=${posting}::date,
          updated_at=(now() AT TIME ZONE 'utc') WHERE id=${id}::uuid
      `.execute(trx)
      const row = await queryHead(trx, spec, id)
      await writeAudit(trx, permit.actor, {
        resource: spec.table,
        recordId: id,
        recordLabel: String(before.reconciliation_no),
        companyId: String(before.company_id),
        actionType: 'update',
        actionName: 'audit',
        changes: auditDiff(headSnap(before), headSnap(row!), HEAD_AUDIT),
      })
      return mapHeadDto(row!)
    })
  }

  async function voidHead(permit: Permit, side: TradingSide, id: string) {
    const spec = reconciliationSpec(side)
    return changeState(permit, spec, id, 'closed', 'voided', 'gift_sample', 'void', async (trx, before) => {
      await gl.cancel(trx, { type: spec.voucher, id: String(before.id) })
      await adjustProjection(trx, spec, id, -1)
    })
  }

  /** 发票审核结单内部接缝（调用方持 trx） */
  async function closeFromInvoice(dbHandle: DbHandle, actor: Actor, side: TradingSide, id: string) {
    return invoiceState(dbHandle, actor, side, id, 'confirmed', 'closed', 'close_from_invoice', async (spec, head) => {
      await closeTodos(dbHandle, spec, id, 'invoice_audit')
      void head
    })
  }

  /** 发票作废/红冲重开内部接缝 */
  async function reopenFromInvoice(dbHandle: DbHandle, actor: Actor, side: TradingSide, id: string) {
    return invoiceState(dbHandle, actor, side, id, 'closed', 'confirmed', 'reopen_from_invoice', async (spec, head) => {
      await openTodo(dbHandle, spec, head, null)
    })
  }

  /** 发票引用校验：对账单是否存在（只读接缝） */
  async function existsForInvoice(
    dbHandle: DbHandle,
    side: TradingSide,
    id: string,
  ): Promise<boolean> {
    const spec = reconciliationSpec(side)
    const rows = await sql<{ e: boolean }>`
      SELECT EXISTS(SELECT 1 FROM ${ident(spec.table)} WHERE id=${id}::uuid) AS e
    `.execute(dbHandle)
    return Boolean(rows.rows[0]?.e)
  }

  /**
   * 发票审核取对账单头+行合计（FOR UPDATE，只读接缝）。
   * 供 finance 构建结转分录，读写同 seam。
   */
  async function loadForInvoiceAudit(
    dbHandle: DbHandle,
    side: TradingSide,
    id: string,
  ): Promise<InvoiceReconHead | null> {
    const spec = reconciliationSpec(side)
    const head = await sql<{
      reconciliation_type: string
      status: string
      company_id: string
      party_type: string
      party_id: string
      gross: string
      debit_account_id: string
      credit_account_id: string
    }>`
      SELECT h.reconciliation_type, h.status, h.company_id::text, h.party_type, h.party_id::text,
        (SELECT COALESCE(sum(i.base_amount),0)::text FROM ${ident(spec.itemTable)} i
          WHERE i.reconciliation_id=h.id) AS gross,
        h.debit_account_id::text, h.credit_account_id::text
      FROM ${ident(spec.table)} h WHERE h.id=${id}::uuid FOR UPDATE
    `.execute(dbHandle)
    if (head.rows.length === 0) return null
    const h = head.rows[0]!
    return {
      reconciliationType: h.reconciliation_type,
      status: h.status,
      companyId: h.company_id,
      partyType: h.party_type,
      partyId: h.party_id,
      gross: h.gross,
      debitAccountId: h.debit_account_id,
      creditAccountId: h.credit_account_id,
    }
  }

  async function listItems(permit: Permit, side: TradingSide, query: Partial<ListQuery>) {
    const spec = reconciliationSpec(side)
    return listAuthorized({
      db,
      permit,
      target: itemTargets[side],
      alias: ITEM_ALIAS,
      resource: reconciliationItemMeta(side),
      source: itemListSource(spec),
      select: itemSelect(spec),
      defaultOrder: sql`"idx" ASC, "id" ASC`,
      query,
      mapRow: (r) => mapItemDto(side, r),
    })
  }

  async function getItem(permit: Permit, side: TradingSide, id: string) {
    const spec = reconciliationSpec(side)
    return loadAuthorizedFrom({
      db,
      permit,
      target: itemTargets[side],
      alias: ITEM_ALIAS,
      source: itemListSource(spec),
      select: itemSelect(spec),
      id,
      mapRow: (r) => mapItemDto(side, r),
      notFoundMessage: '对账条目不存在',
    })
  }

  async function createItem(
    permit: Permit,
    side: TradingSide,
    input: {
      reconciliationId: string
      idx: number
      qty: string
      deliveryItemId?: string | null
      receiptItemId?: string | null
      outsourcedReceiptItemId?: string | null
      remarks?: string | null
    },
  ) {
    const spec = reconciliationSpec(side)
    validateItemShape(spec, input)
    return withTx(db, async (trx) => {
      // 母单先行：授权 + 行锁 + 草稿门，再写条目
      const head = await lockHead(trx, permit, spec, input.reconciliationId)
      if (String(head.status) !== 'draft') {
        throw new ApiError('conflict', '仅草稿对账单可编辑条目')
      }
      const qty = decimal(input.qty)
      const source = await loadSource(trx, side, input, true)
      await validateSource(trx, spec, head, source, null, qty)
      const { baseQty, amount, baseAmount } = snapshotAmounts(qty, source)
      try {
        let id: string
        if (side === 'sales') {
          const ins = await sql<{ id: string }>`
            INSERT INTO sal_reconciliation_item (
              idx, qty, base_qty, amount, base_amount, remarks,
              reconciliation_id, company_id, delivery_item_id
            ) VALUES (
              ${input.idx}, ${wireRequiredDecimal(qty)}, ${baseQty}, ${amount}, ${baseAmount},
              ${input.remarks ?? null}, ${head.id}::uuid, ${head.company_id}::uuid,
              ${source.id}::uuid
            ) RETURNING id
          `.execute(trx)
          id = ins.rows[0]!.id
        } else {
          const ins = await sql<{ id: string }>`
            INSERT INTO pur_reconciliation_item (
              idx, qty, base_qty, amount, base_amount, remarks,
              reconciliation_id, company_id, receipt_item_id, outsourced_receipt_item_id
            ) VALUES (
              ${input.idx}, ${wireRequiredDecimal(qty)}, ${baseQty}, ${amount}, ${baseAmount},
              ${input.remarks ?? null}, ${head.id}::uuid, ${head.company_id}::uuid,
              ${input.receiptItemId ?? null}::uuid, ${input.outsourcedReceiptItemId ?? null}::uuid
            ) RETURNING id
          `.execute(trx)
          id = ins.rows[0]!.id
        }
        const row = await queryItem(trx, spec, id)
        await writeAudit(trx, permit.actor, {
          resource: spec.itemTable,
          recordId: id,
          recordLabel: `${String(head.reconciliation_no)}-${Number(row!.idx)}`,
          companyId: String(head.company_id),
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(itemSnap(row!), ITEM_AUDIT),
        })
        return mapItemDto(side, row!)
      } catch (err) {
        throw mapWriteError(err, '创建对账条目失败', [])
      }
    })
  }

  async function updateItem(
    permit: Permit,
    side: TradingSide,
    id: string,
    input: {
      idx?: number
      qty?: string
      deliveryItemId?: string | null
      deliveryItemIdPresent?: boolean
      receiptItemId?: string | null
      receiptItemIdPresent?: boolean
      outsourcedReceiptItemId?: string | null
      outsourcedReceiptItemIdPresent?: boolean
      remarks?: string | null
      remarksPresent?: boolean
    },
  ) {
    const spec = reconciliationSpec(side)
    return withTx(db, async (trx) => {
      // 条目经 via 链取（不可达即 not_found），再母单先行加锁
      const before = await loadItemRow(trx, permit, side, id)
      const head = await lockHead(trx, permit, spec, String(before.reconciliation_id))
      if (String(head.status) !== 'draft') {
        throw new ApiError('conflict', '仅草稿对账单可编辑条目')
      }
      const create = {
        reconciliationId: String(head.id),
        idx: input.idx ?? Number(before.idx),
        qty: input.qty ?? String(before.qty),
        deliveryItemId: input.deliveryItemIdPresent
          ? (input.deliveryItemId ?? null)
          : asOptionalString(before.delivery_item_id),
        receiptItemId: input.receiptItemIdPresent
          ? (input.receiptItemId ?? null)
          : asOptionalString(before.receipt_item_id),
        outsourcedReceiptItemId: input.outsourcedReceiptItemIdPresent
          ? (input.outsourcedReceiptItemId ?? null)
          : asOptionalString(before.outsourced_receipt_item_id),
        remarks: input.remarksPresent ? (input.remarks ?? null) : asOptionalString(before.remarks),
      }
      validateItemShape(spec, create)
      const qty = decimal(create.qty)
      const source = await loadSource(trx, side, create, true)
      await validateSource(trx, spec, head, source, id, qty)
      const { baseQty, amount, baseAmount } = snapshotAmounts(qty, source)
      try {
        if (side === 'sales') {
          await sql`
            UPDATE sal_reconciliation_item SET
              idx=${create.idx}, qty=${wireRequiredDecimal(qty)}, base_qty=${baseQty},
              amount=${amount}, base_amount=${baseAmount}, remarks=${create.remarks},
              delivery_item_id=${source.id}::uuid,
              updated_at=(now() AT TIME ZONE 'utc')
            WHERE id=${id}::uuid
          `.execute(trx)
        } else {
          await sql`
            UPDATE pur_reconciliation_item SET
              idx=${create.idx}, qty=${wireRequiredDecimal(qty)}, base_qty=${baseQty},
              amount=${amount}, base_amount=${baseAmount}, remarks=${create.remarks},
              receipt_item_id=${create.receiptItemId}::uuid,
              outsourced_receipt_item_id=${create.outsourcedReceiptItemId}::uuid,
              updated_at=(now() AT TIME ZONE 'utc')
            WHERE id=${id}::uuid
          `.execute(trx)
        }
        const row = await queryItem(trx, spec, id)
        const changes = auditDiff(itemSnap(before), itemSnap(row!), ITEM_AUDIT)
        if (Object.keys(changes).length > 0) {
          await writeAudit(trx, permit.actor, {
            resource: spec.itemTable,
            recordId: id,
            recordLabel: `${String(head.reconciliation_no)}-${Number(row!.idx)}`,
            companyId: String(head.company_id),
            actionType: 'update',
            actionName: 'update',
            changes,
          })
        }
        return mapItemDto(side, row!)
      } catch (err) {
        throw mapWriteError(err, '更新对账条目失败', [])
      }
    })
  }

  async function deleteItem(permit: Permit, side: TradingSide, id: string) {
    const spec = reconciliationSpec(side)
    await withTx(db, async (trx) => {
      const before = await loadItemRow(trx, permit, side, id)
      const head = await lockHead(trx, permit, spec, String(before.reconciliation_id))
      if (String(head.status) !== 'draft') {
        throw new ApiError('conflict', '仅草稿对账单可编辑条目')
      }
      await writeAudit(trx, permit.actor, {
        resource: spec.itemTable,
        recordId: id,
        recordLabel: `${String(head.reconciliation_no)}-${Number(before.idx)}`,
        companyId: String(head.company_id),
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(itemSnap(before), ITEM_AUDIT),
      })
      await sql`DELETE FROM ${ident(spec.itemTable)} WHERE id=${id}::uuid`.execute(trx)
    })
  }

  async function changeState(
    permit: Permit,
    spec: ReconciliationSideSpec,
    id: string,
    from: ReconciliationStatus,
    to: ReconciliationStatus,
    kind: ReconciliationKind,
    action: string,
    effect: (trx: TrxHandle, before: Record<string, unknown>) => Promise<void>,
  ) {
    return withTx(db, async (trx) => {
      const before = await lockHead(trx, permit, spec, id)
      if (String(before.status) !== from || String(before.reconciliation_type) !== kind) {
        throw new ApiError('conflict', '对账单当前状态不允许执行该动作')
      }
      if (to === 'confirmed' || (to === 'closed' && kind === 'gift_sample')) {
        await requireItems(trx, spec, id)
      }
      await effect(trx, before)
      const tag = await sql`
        UPDATE ${ident(spec.table)} SET status=${to}, updated_at=(now() AT TIME ZONE 'utc')
        WHERE id=${id}::uuid AND status=${from}
      `.execute(trx)
      if (Number(tag.numAffectedRows ?? 0) !== 1) {
        throw new ApiError('conflict', '对账单已被并发处理')
      }
      const row = await queryHead(trx, spec, id)
      await writeAudit(trx, permit.actor, {
        resource: spec.table,
        recordId: id,
        recordLabel: String(before.reconciliation_no),
        companyId: String(before.company_id),
        actionType: 'update',
        actionName: action,
        changes: auditDiff(headSnap(before), headSnap(row!), HEAD_AUDIT),
      })
      return mapHeadDto(row!)
    })
  }

  async function invoiceState(
    dbHandle: DbHandle,
    actor: Actor,
    side: TradingSide,
    id: string,
    from: ReconciliationStatus,
    to: ReconciliationStatus,
    action: string,
    effect: (spec: ReconciliationSideSpec, head: Record<string, unknown>) => Promise<void>,
  ) {
    const spec = reconciliationSpec(side)
    const locked = await sql<{ status: string; reconciliation_type: string }>`
      SELECT status, reconciliation_type FROM ${ident(spec.table)} WHERE id=${id}::uuid FOR UPDATE
    `.execute(dbHandle)
    if (!locked.rows[0]) throw new ApiError('not_found', `${spec.label}不存在`)
    if (locked.rows[0].status !== from || locked.rows[0].reconciliation_type !== 'regular') {
      throw new ApiError('conflict', '常规对账单状态不允许发票联动')
    }
    const before = await queryHead(dbHandle, spec, id)
    if (!before) throw new ApiError('not_found', `${spec.label}不存在`)
    await effect(spec, before)
    await sql`
      UPDATE ${ident(spec.table)} SET status=${to}, updated_at=(now() AT TIME ZONE 'utc')
      WHERE id=${id}::uuid
    `.execute(dbHandle)
    const after = await queryHead(dbHandle, spec, id)
    await writeAudit(dbHandle, actor, {
      resource: spec.table,
      recordId: id,
      recordLabel: String(before.reconciliation_no),
      companyId: String(before.company_id),
      actionType: 'update',
      actionName: action,
      changes: auditDiff(headSnap(before), headSnap(after!), HEAD_AUDIT),
    })
    return mapHeadDto(after!)
  }

  return {
    listHeads,
    getHead,
    createHead,
    updateHead,
    deleteHead,
    confirm,
    unconfirm,
    audit,
    void: voidHead,
    closeFromInvoice,
    reopenFromInvoice,
    existsForInvoice,
    loadForInvoiceAudit,
    listItems,
    getItem,
    createItem,
    updateItem,
    deleteItem,
  }
}

/** 发票审核用对账单头（只读接缝出参） */
export interface InvoiceReconHead {
  reconciliationType: string
  status: string
  companyId: string
  partyType: string
  partyId: string
  gross: string
  debitAccountId: string
  creditAccountId: string
}

export type ReconciliationService = ReturnType<typeof createReconciliationService>

// ---- list sources ----

function headListSource(spec: ReconciliationSideSpec) {
  return sql` FROM (
    SELECT h.id,h.reconciliation_no,h.reconciliation_type,h.party_type,h.party_id,
      h.posting_date,h.remarks,h.status,h.inserted_at,h.updated_at,h.company_id,
      h.debit_account_id,h.credit_account_id,h.created_by_id,
      COALESCE(SUM(i.amount),0) AS gross_total,
      COALESCE(SUM(i.base_amount),0) AS base_gross_total
    FROM ${ident(spec.table)} h
    LEFT JOIN ${ident(spec.itemTable)} i ON i.reconciliation_id=h.id
    GROUP BY h.id
  ) ${sql.raw(HEAD_ALIAS)}`
}

function itemSelect(spec: ReconciliationSideSpec) {
  const sourceNo = spec.side === 'sales' ? 'delivery_no' : 'receipt_no'
  const sourceDate = spec.side === 'sales' ? 'delivery_date' : 'receipt_date'
  return sql`SELECT id,idx,qty,base_qty,amount,base_amount,remarks,inserted_at,
    updated_at,reconciliation_id,company_id,delivery_item_id,receipt_item_id,
    outsourced_receipt_item_id,reconciliation_no,reconciliation_status,
    ${sql.raw(sourceNo)},${sql.raw(sourceDate)},material_name,unit_name,order_currency_code`
}

function itemListSource(spec: ReconciliationSideSpec) {
  if (spec.side === 'sales') {
    return sql` FROM (
      SELECT ri.id,ri.idx,ri.qty,ri.base_qty,ri.amount,ri.base_amount,ri.remarks,
        ri.inserted_at,ri.updated_at,ri.reconciliation_id,ri.company_id,
        ri.delivery_item_id,NULL::uuid AS receipt_item_id,
        NULL::uuid AS outsourced_receipt_item_id,r.reconciliation_no,
        r.status AS reconciliation_status,h.delivery_no,h.delivery_date,
        i.material_name,i.unit_name,i.order_currency_code
      FROM sal_reconciliation_item ri
      JOIN sal_reconciliation r ON r.id=ri.reconciliation_id
      JOIN sal_delivery_item i ON i.id=ri.delivery_item_id
      JOIN sal_delivery h ON h.id=i.delivery_id
    ) ${sql.raw(ITEM_ALIAS)}`
  }
  return sql` FROM (
    SELECT ri.id,ri.idx,ri.qty,ri.base_qty,ri.amount,ri.base_amount,ri.remarks,
      ri.inserted_at,ri.updated_at,ri.reconciliation_id,ri.company_id,
      NULL::uuid AS delivery_item_id,ri.receipt_item_id,ri.outsourced_receipt_item_id,
      r.reconciliation_no,r.status AS reconciliation_status,
      COALESCE(sh.receipt_no,oh.receipt_no) AS receipt_no,
      COALESCE(sh.receipt_date,oh.receipt_date) AS receipt_date,
      COALESCE(si.material_name,oi.material_name) AS material_name,
      COALESCE(si.unit_name,oi.unit_name) AS unit_name,
      COALESCE(si.order_currency_code,oi.order_currency_code) AS order_currency_code
    FROM pur_reconciliation_item ri
    JOIN pur_reconciliation r ON r.id=ri.reconciliation_id
    LEFT JOIN pur_receipt_item si ON si.id=ri.receipt_item_id
    LEFT JOIN pur_receipt sh ON sh.id=si.receipt_id
    LEFT JOIN pur_outsourced_receipt_item oi ON oi.id=ri.outsourced_receipt_item_id
    LEFT JOIN pur_outsourced_receipt oh ON oh.id=oi.receipt_id
  ) ${sql.raw(ITEM_ALIAS)}`
}

// ---- query helpers ----

async function queryHead(db: DbHandle, spec: ReconciliationSideSpec, id: string) {
  const rows = await sql<Record<string, unknown>>`
    ${HEAD_SELECT}${headListSource(spec)} WHERE id=${id}::uuid
  `.execute(db)
  return rows.rows[0] ?? null
}

async function queryItem(db: DbHandle, spec: ReconciliationSideSpec, id: string) {
  const rows = await sql<Record<string, unknown>>`
    ${itemSelect(spec)}${itemListSource(spec)} WHERE id=${id}::uuid
  `.execute(db)
  return rows.rows[0] ?? null
}

async function requireItems(db: DbHandle, spec: ReconciliationSideSpec, id: string) {
  const r = await sql<{ e: boolean }>`
    SELECT EXISTS(SELECT 1 FROM ${ident(spec.itemTable)} WHERE reconciliation_id=${id}::uuid) AS e
  `.execute(db)
  if (!r.rows[0]?.e) {
    throw new ApiError('conflict', '生效前必须至少填写一行对账条目')
  }
}

// ---- projection ----

async function adjustProjection(
  db: DbHandle,
  spec: ReconciliationSideSpec,
  id: string,
  direction: number,
) {
  type Proj = { id: string; delta: string; outsourced: boolean; idx: string }
  let rows: Proj[]
  if (spec.side === 'sales') {
    const r = await sql<Proj>`
      SELECT delivery_item_id::text AS id, SUM(base_qty)::text AS delta,
        false AS outsourced, MIN(idx)::text AS idx
      FROM sal_reconciliation_item WHERE reconciliation_id=${id}::uuid
      GROUP BY delivery_item_id
    `.execute(db)
    rows = r.rows
  } else {
    const r = await sql<Proj>`
      SELECT COALESCE(receipt_item_id, outsourced_receipt_item_id)::text AS id,
        SUM(base_qty)::text AS delta,
        (outsourced_receipt_item_id IS NOT NULL) AS outsourced,
        MIN(idx)::text AS idx
      FROM pur_reconciliation_item WHERE reconciliation_id=${id}::uuid
      GROUP BY receipt_item_id, outsourced_receipt_item_id
    `.execute(db)
    rows = r.rows
  }
  rows.sort((a, b) => a.id.localeCompare(b.id))
  for (const value of rows) {
    const delta = decimal(value.delta).mul(direction)
    if (value.outsourced) {
      const parent = await sql<{ receipt_id: string }>`
        SELECT receipt_id FROM pur_outsourced_receipt_item WHERE id=${value.id}::uuid
      `.execute(db)
      if (!parent.rows[0]) throw new ApiError('conflict', '对账来源条目不存在')
      const status = await sql<{ status: string }>`
        SELECT status FROM pur_outsourced_receipt WHERE id=${parent.rows[0].receipt_id}::uuid FOR UPDATE
      `.execute(db)
      if (status.rows[0]?.status !== 'audited') {
        throw new ApiError('conflict', '仅已审核委外入库行可对账')
      }
      const item = await sql<{ base_qty: string; reconciled_qty: string }>`
        SELECT base_qty::text, reconciled_qty::text
        FROM pur_outsourced_receipt_item WHERE id=${value.id}::uuid FOR UPDATE
      `.execute(db)
      if (!item.rows[0]) throw new ApiError('conflict', '对账来源条目不存在')
      const next = decimal(item.rows[0].reconciled_qty).add(delta)
      if (next.isNegative() || next.gt(decimal(item.rows[0].base_qty))) {
        throw new ApiError('conflict', '超出剩余可对账量')
      }
      await sql`
        UPDATE pur_outsourced_receipt_item SET
          reconciled_qty=reconciled_qty+${wireRequiredDecimal(delta)},
          updated_at=(now() AT TIME ZONE 'utc')
        WHERE id=${value.id}::uuid
          AND reconciled_qty+${wireRequiredDecimal(delta)}>=0
          AND reconciled_qty+${wireRequiredDecimal(delta)}<=base_qty
      `.execute(db)
      continue
    }
    const table = spec.side === 'sales' ? 'sal_delivery_item' : 'pur_receipt_item'
    const parentTable = spec.side === 'sales' ? 'sal_delivery' : 'pur_receipt'
    const parentFK = spec.side === 'sales' ? 'delivery_id' : 'receipt_id'
    const parent = await sql<{ status: string }>`
      SELECT h.status FROM ${sql.raw(table)} i
      JOIN ${sql.raw(parentTable)} h ON h.id=i.${sql.raw(parentFK)}
      WHERE i.id=${value.id}::uuid FOR UPDATE OF h,i
    `.execute(db)
    if (!parent.rows[0]) throw new ApiError('conflict', '对账来源条目不存在')
    if (parent.rows[0].status !== 'audited') {
      throw new ApiError('conflict', '仅已审核且未作废来源条目可对账')
    }
    const tag = await sql`
      UPDATE ${sql.raw(table)} SET
        reconciled_qty=reconciled_qty+${wireRequiredDecimal(delta)},
        updated_at=(now() AT TIME ZONE 'utc')
      WHERE id=${value.id}::uuid
        AND reconciled_qty+${wireRequiredDecimal(delta)}>=0
        AND reconciled_qty+${wireRequiredDecimal(delta)}<=base_qty
    `.execute(db)
    if (Number(tag.numAffectedRows ?? 0) !== 1) {
      throw new ApiError('conflict', `第${value.idx}行超出剩余可对账量`)
    }
  }
}

async function postGiftGL(
  db: TrxHandle,
  gl: Pick<GlEngine, 'post'>,
  spec: ReconciliationSideSpec,
  head: Record<string, unknown>,
  posting: string,
) {
  const accounts = await sql<{ debit_currency: string | null; credit_currency: string | null }>`
    SELECT
      (SELECT currency_id::text FROM bas_account WHERE id=${String(head.debit_account_id)}::uuid) AS debit_currency,
      (SELECT currency_id::text FROM bas_account WHERE id=${String(head.credit_account_id)}::uuid) AS credit_currency
  `.execute(db)
  const debitCurrency = accounts.rows[0]?.debit_currency ?? null
  const creditCurrency = accounts.rows[0]?.credit_currency ?? null
  const baseGross = wireRequiredDecimal(String(head.base_gross_total ?? 0))
  const partyType = String(head.party_type)
  const partyId = String(head.party_id)
  const debitParty = spec.side === 'purchase' ? { partyType, partyId } : { partyType: null, partyId: null }
  const creditParty = spec.side === 'sales' ? { partyType, partyId } : { partyType: null, partyId: null }
  await gl.post(
    db,
    {
      type: spec.voucher,
      id: String(head.id),
      no: String(head.reconciliation_no),
      companyId: String(head.company_id),
      postingDate: posting,
    },
    [
      {
        accountId: String(head.debit_account_id),
        currencyId: debitCurrency,
        debit: baseGross,
        credit: '0',
        partyType: debitParty.partyType,
        partyId: debitParty.partyId,
      },
      {
        accountId: String(head.credit_account_id),
        currencyId: creditCurrency,
        debit: '0',
        credit: baseGross,
        partyType: creditParty.partyType,
        partyId: creditParty.partyId,
      },
    ],
  )
}

async function openTodo(
  db: DbHandle,
  spec: ReconciliationSideSpec,
  head: Record<string, unknown>,
  userId: string | null,
) {
  await sql`
    INSERT INTO sys_todo(
      type, source_type, source_id, source_no, party_type, party_id, amount,
      status, source_changed_at, company_id, created_by_id
    ) VALUES (
      ${spec.todoType}, ${spec.voucher}, ${String(head.id)}::uuid,
      ${String(head.reconciliation_no)}, ${String(head.party_type)},
      ${String(head.party_id)}::uuid, ${wireRequiredDecimal(String(head.base_gross_total ?? 0))},
      'active', (now() AT TIME ZONE 'utc'), ${String(head.company_id)}::uuid,
      ${userId}::uuid
    )
  `.execute(db)
}

async function closeTodos(
  db: DbHandle,
  spec: ReconciliationSideSpec,
  id: string,
  reason: string,
) {
  await sql`
    UPDATE sys_todo SET status='closed', closed_reason=${reason},
      closed_at=(now() AT TIME ZONE 'utc'), updated_at=(now() AT TIME ZONE 'utc')
    WHERE source_type=${spec.voucher} AND source_id=${id}::uuid AND status='active'
  `.execute(db)
}

// ---- validation ----

function parseKind(value: string): ReconciliationKind {
  const v = value.trim().toLowerCase()
  if (v === 'regular' || v === 'gift_sample') return v
  throw ApiError.validation('对账类型不合法', {
    reconciliationType: ['只允许 REGULAR 或 GIFT_SAMPLE'],
  })
}

function validateHeadShape(
  spec: ReconciliationSideSpec,
  input: {
    companyId: string
    no?: string | null
    kind: string
    partyType: string
    partyId: string
    debitAccountId: string
    creditAccountId: string
    remarks?: string | null
  },
) {
  const fields: Record<string, string[]> = {}
  if (!input.companyId) fields.companyId = ['必填']
  if (input.kind !== 'regular' && input.kind !== 'gift_sample') {
    fields.reconciliationType = ['只允许 REGULAR 或 GIFT_SAMPLE']
  }
  const partyType = lowerParty(input.partyType)
  if (partyType !== spec.party && partyType !== 'company') {
    fields.partyType = ['对手类型不合法']
  }
  if (!input.partyId) fields.partyId = ['必填']
  if (partyType === 'company' && input.partyId === input.companyId) {
    fields.partyId = ['对手不能是本公司']
  }
  if (!input.debitAccountId) fields.debitAccountId = ['必填']
  if (!input.creditAccountId) fields.creditAccountId = ['必填']
  if (input.no != null && runeLen(String(input.no).trim()) > 32) {
    fields.reconciliationNo = ['最多 32 个字符']
  }
  if (input.remarks != null && runeLen(input.remarks) > 512) {
    fields.remarks = ['最多 512 个字符']
  }
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation(`${spec.label}参数不合法`, fields)
  }
}

async function fillDefaultAccounts(
  db: DbHandle,
  spec: ReconciliationSideSpec,
  companyId: string,
  debitAccountId: string,
  creditAccountId: string,
): Promise<{ debitAccountId: string; creditAccountId: string }> {
  if (debitAccountId && creditAccountId) {
    return { debitAccountId, creditAccountId }
  }
  const debitCol =
    spec.side === 'sales' ? 'delivery_credit_account_id' : 'receipt_credit_account_id'
  const creditCol =
    spec.side === 'sales' ? 'delivery_debit_account_id' : 'receipt_debit_account_id'
  const rows = await sql<Record<string, string | null>>`
    SELECT ${sql.raw(debitCol)}::text AS debit, ${sql.raw(creditCol)}::text AS credit
    FROM sal_company_account_default WHERE company_id=${companyId}::uuid
  `.execute(db)
  const row = rows.rows[0]
  return {
    debitAccountId: debitAccountId || row?.debit || '',
    creditAccountId: creditAccountId || row?.credit || '',
  }
}

async function validateReferences(
  db: DbHandle,
  spec: ReconciliationSideSpec,
  companyId: string,
  partyType: string,
  partyId: string,
  debitId: string,
  creditId: string,
) {
  if (!(await partyExists(db, partyType, partyId))) {
    throw ApiError.validation(`${spec.label}参数不合法`, { partyId: ['对手不存在'] })
  }
  const rows = await sql<{
    id: string
    company_id: string
    is_group: boolean
    active: boolean
    role: string | null
  }>`
    SELECT id::text, company_id::text, is_group, active, role
    FROM bas_account WHERE id = ANY(${[debitId, creditId]}::uuid[])
  `.execute(db)
  const found = new Map(rows.rows.map((r) => [r.id, r]))
  for (const [field, accountId] of [
    ['debitAccountId', debitId],
    ['creditAccountId', creditId],
  ] as const) {
    const value = found.get(accountId)
    if (!value || value.company_id !== companyId || value.is_group || !value.active) {
      throw ApiError.validation(`${spec.label}参数不合法`, {
        [field]: ['科目须属于本公司、启用且非汇总'],
      })
    }
    const requiredRole =
      (field === 'creditAccountId' && spec.side === 'sales') ||
      (field === 'debitAccountId' && spec.side === 'purchase')
    const wantRole = spec.side === 'sales' ? 'unbilled_receivable' : 'unbilled_payable'
    if (
      requiredRole &&
      (!value.role || value.role.toLowerCase() !== wantRole)
    ) {
      throw ApiError.validation(`${spec.label}参数不合法`, {
        [field]: ['科目角色不符合对账要求'],
      })
    }
  }
}

function validateItemShape(
  spec: ReconciliationSideSpec,
  input: {
    reconciliationId: string
    qty: string
    deliveryItemId?: string | null
    receiptItemId?: string | null
    outsourcedReceiptItemId?: string | null
    remarks?: string | null
  },
) {
  const fields: Record<string, string[]> = {}
  if (!input.reconciliationId) fields.reconciliationId = ['必填']
  const qty = decimal(input.qty || '0')
  if (!qty.gt(0)) fields.qty = ['必须大于 0']
  if (input.remarks != null && runeLen(input.remarks) > 512) {
    fields.remarks = ['最多 512 个字符']
  }
  if (spec.side === 'sales') {
    if (!input.deliveryItemId) fields.deliveryItemId = ['必填']
    if (input.receiptItemId || input.outsourcedReceiptItemId) {
      fields.source = ['销售对账只允许发货条目来源']
    }
  } else {
    let count = 0
    if (input.receiptItemId) count++
    if (input.outsourcedReceiptItemId) count++
    if (count !== 1) {
      fields.source = ['标准入库条目与委外入库条目必须恰选一个']
    }
    if (input.deliveryItemId) {
      fields.deliveryItemId = ['采购对账不允许发货条目来源']
    }
  }
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('对账条目参数不合法', fields)
  }
}

async function loadSource(
  db: DbHandle,
  side: TradingSide,
  input: {
    deliveryItemId?: string | null
    receiptItemId?: string | null
    outsourcedReceiptItemId?: string | null
  },
  lock: boolean,
): Promise<SourceItem> {
  const lockSql = lock ? sql` FOR UPDATE OF i` : sql``
  let rows: { rows: Record<string, unknown>[] }
  if (side === 'sales') {
    rows = await sql<Record<string, unknown>>`
      SELECT i.id::text, h.company_id::text, h.party_type, h.party_id::text, h.status,
        h.delivery_no AS no, h.delivery_date AS source_date, i.material_name, i.unit_name,
        i.order_currency_code AS currency_code, i.qty::text, i.base_qty::text,
        i.reconciled_qty::text, i.order_price::text, o.exchange_rate::text,
        o.order_type, o.id::text AS order_id
      FROM sal_delivery_item i
      JOIN sal_delivery h ON h.id=i.delivery_id
      JOIN sal_order_item oi ON oi.id=i.order_item_id
      JOIN sal_order o ON o.id=oi.order_id
      WHERE i.id=${input.deliveryItemId!}::uuid${lockSql}
    `.execute(db)
  } else if (input.receiptItemId) {
    rows = await sql<Record<string, unknown>>`
      SELECT i.id::text, h.company_id::text, h.party_type, h.party_id::text, h.status,
        h.receipt_no AS no, h.receipt_date AS source_date, i.material_name, i.unit_name,
        i.order_currency_code AS currency_code, i.qty::text, i.base_qty::text,
        i.reconciled_qty::text, i.order_price::text, o.exchange_rate::text,
        o.order_type, o.id::text AS order_id
      FROM pur_receipt_item i
      JOIN pur_receipt h ON h.id=i.receipt_id
      JOIN pur_order_item oi ON oi.id=i.order_item_id
      JOIN pur_order o ON o.id=oi.order_id
      WHERE i.id=${input.receiptItemId}::uuid${lockSql}
    `.execute(db)
  } else {
    rows = await sql<Record<string, unknown>>`
      SELECT i.id::text, h.company_id::text, h.party_type, h.party_id::text, h.status,
        h.receipt_no AS no, h.receipt_date AS source_date, i.material_name, i.unit_name,
        i.order_currency_code AS currency_code, i.qty::text, i.base_qty::text,
        i.reconciled_qty::text, i.order_price::text, o.exchange_rate::text,
        o.order_type, o.id::text AS order_id
      FROM pur_outsourced_receipt_item i
      JOIN pur_outsourced_receipt h ON h.id=i.receipt_id
      JOIN pur_order_item oi ON oi.id=i.order_item_id
      JOIN pur_order o ON o.id=oi.order_id
      WHERE i.id=${input.outsourcedReceiptItemId!}::uuid${lockSql}
    `.execute(db)
  }
  const row = rows.rows[0]
  if (!row) {
    throw ApiError.validation('对账条目参数不合法', { source: ['来源条目不存在'] })
  }
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    partyType: String(row.party_type),
    partyId: String(row.party_id),
    status: String(row.status),
    no: String(row.no),
    sourceDate: asDate(row.source_date),
    materialName: String(row.material_name),
    unitName: String(row.unit_name),
    currencyCode: String(row.currency_code),
    qty: decimal(String(row.qty)),
    baseQty: decimal(String(row.base_qty)),
    reconciledQty: decimal(String(row.reconciled_qty)),
    price: decimal(String(row.order_price)),
    exchangeRate: decimal(String(row.exchange_rate)),
    orderType: String(row.order_type),
    orderId: String(row.order_id),
    outsourced: side === 'purchase' && Boolean(input.outsourcedReceiptItemId),
  }
}

async function validateSource(
  db: DbHandle,
  spec: ReconciliationSideSpec,
  head: Record<string, unknown>,
  source: SourceItem,
  selfId: string | null,
  qty: ReturnType<typeof decimal>,
) {
  if (source.status !== 'audited') {
    throw new ApiError('conflict', '仅已审核且未作废的来源条目可对账')
  }
  if (source.companyId !== String(head.company_id)) {
    throw ApiError.validation('对账条目参数不合法', {
      source: ['来源公司与对账单不一致'],
    })
  }
  if (
    source.partyType !== String(head.party_type) ||
    source.partyId !== String(head.party_id)
  ) {
    throw ApiError.validation('对账条目参数不合法', {
      source: ['来源对手与对账单不一致'],
    })
  }
  const sibling = await sql<{ currency: string | null }>`
    SELECT CASE ${spec.side}::text
      WHEN 'sales' THEN (
        SELECT di.order_currency_code FROM sal_reconciliation_item ri
        JOIN sal_delivery_item di ON di.id=ri.delivery_item_id
        WHERE ri.reconciliation_id=${String(head.id)}::uuid
          AND (${selfId}::uuid IS NULL OR ri.id<>${selfId}::uuid)
        LIMIT 1
      )
      ELSE (
        SELECT COALESCE(si.order_currency_code, oi.order_currency_code)
        FROM pur_reconciliation_item ri
        LEFT JOIN pur_receipt_item si ON si.id=ri.receipt_item_id
        LEFT JOIN pur_outsourced_receipt_item oi ON oi.id=ri.outsourced_receipt_item_id
        WHERE ri.reconciliation_id=${String(head.id)}::uuid
          AND (${selfId}::uuid IS NULL OR ri.id<>${selfId}::uuid)
        LIMIT 1
      )
    END AS currency
  `.execute(db)
  const siblingCurrency = sibling.rows[0]?.currency
  if (siblingCurrency != null && siblingCurrency !== source.currencyCode) {
    throw ApiError.validation('对账条目参数不合法', {
      source: ['同一对账单内订单原币必须一致'],
    })
  }
  if (String(head.reconciliation_type) === 'regular') {
    if (!source.price.gt(0)) {
      throw ApiError.validation('对账条目参数不合法', {
        source: ['常规对账单不可勾选零金额条目'],
      })
    }
    if (spec.side === 'sales' && source.orderType === 'sample') {
      throw ApiError.validation('对账条目参数不合法', {
        source: ['常规销售对账单不可勾选样品订单来源'],
      })
    }
  }
  const snapped = snapshotAmounts(qty, source)
  const remaining = source.baseQty.sub(source.reconciledQty)
  if (decimal(snapped.baseQty).gt(remaining)) {
    throw new ApiError('conflict', `超出剩余可对账量(剩余 ${remaining.toFixed()})`)
  }
}

function snapshotAmounts(qty: ReturnType<typeof decimal>, source: SourceItem) {
  let baseQty = qty
  if (!source.qty.isZero()) {
    baseQty = qty.mul(source.baseQty).div(source.qty)
  }
  const amount = qty.mul(source.price)
  const baseAmount = decimal(roundAmount(amount)).mul(source.exchangeRate)
  return {
    baseQty: roundBaseQty(baseQty),
    amount: roundAmount(amount),
    baseAmount: roundAmount(baseAmount),
  }
}

// ---- DTO ----

function mapHeadDto(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    reconciliationNo: String(row.reconciliation_no),
    reconciliationType: upperStatus(String(row.reconciliation_type)),
    partyType: upperStatus(String(row.party_type)),
    partyId: String(row.party_id),
    postingDate: row.posting_date != null ? asDate(row.posting_date) : null,
    remarks: asOptionalString(row.remarks),
    status: upperStatus(String(row.status)),
    insertedAt: asDateTime(row.inserted_at),
    updatedAt: asDateTime(row.updated_at),
    companyId: String(row.company_id),
    debitAccountId: String(row.debit_account_id),
    creditAccountId: String(row.credit_account_id),
    createdById: row.created_by_id != null ? String(row.created_by_id) : null,
    grossTotal: wireRequiredDecimal(String(row.gross_total ?? 0)),
    baseGrossTotal: wireRequiredDecimal(String(row.base_gross_total ?? 0)),
  }
}

function mapItemDto(side: TradingSide, row: Record<string, unknown>) {
  const numberKey = side === 'sales' ? 'deliveryNo' : 'receiptNo'
  const dateKey = side === 'sales' ? 'deliveryDate' : 'receiptDate'
  const sourceDate = side === 'sales' ? row.delivery_date : row.receipt_date
  const sourceNo =
    side === 'sales' ? String(row.delivery_no ?? '') : String(row.receipt_no ?? '')
  return {
    id: String(row.id),
    idx: Number(row.idx),
    qty: wireRequiredDecimal(String(row.qty)),
    baseQty: wireRequiredDecimal(String(row.base_qty)),
    amount: wireRequiredDecimal(String(row.amount)),
    baseAmount: wireRequiredDecimal(String(row.base_amount)),
    remarks: asOptionalString(row.remarks),
    insertedAt: asDateTime(row.inserted_at),
    updatedAt: asDateTime(row.updated_at),
    reconciliationId: String(row.reconciliation_id),
    companyId: String(row.company_id),
    deliveryItemId: row.delivery_item_id != null ? String(row.delivery_item_id) : null,
    receiptItemId: row.receipt_item_id != null ? String(row.receipt_item_id) : null,
    outsourcedReceiptItemId:
      row.outsourced_receipt_item_id != null ? String(row.outsourced_receipt_item_id) : null,
    reconciliationNo: String(row.reconciliation_no),
    reconciliationStatus: upperStatus(String(row.reconciliation_status)),
    [numberKey]: sourceNo,
    [dateKey]: asDate(sourceDate),
    materialName: String(row.material_name),
    unitName: String(row.unit_name),
    orderCurrencyCode: String(row.order_currency_code),
  }
}

function headSnap(row: Record<string, unknown>) {
  return {
    reconciliation_no: String(row.reconciliation_no),
    reconciliation_type: String(row.reconciliation_type),
    party_type: String(row.party_type),
    party_id: String(row.party_id),
    posting_date: row.posting_date != null ? asDate(row.posting_date) : null,
    remarks: asOptionalString(row.remarks),
    status: String(row.status),
    company_id: String(row.company_id),
    debit_account_id: String(row.debit_account_id),
    credit_account_id: String(row.credit_account_id),
    created_by_id: row.created_by_id != null ? String(row.created_by_id) : null,
  }
}

function itemSnap(row: Record<string, unknown>) {
  return {
    idx: Number(row.idx),
    qty: String(row.qty),
    base_qty: String(row.base_qty),
    amount: String(row.amount),
    base_amount: String(row.base_amount),
    remarks: asOptionalString(row.remarks),
    reconciliation_id: String(row.reconciliation_id),
    company_id: String(row.company_id),
    delivery_item_id: row.delivery_item_id != null ? String(row.delivery_item_id) : null,
    receipt_item_id: row.receipt_item_id != null ? String(row.receipt_item_id) : null,
    outsourced_receipt_item_id:
      row.outsourced_receipt_item_id != null ? String(row.outsourced_receipt_item_id) : null,
  }
}
