/**
 * 销售/采购对账单：对称服务。
 *
 * W3 聚合迁移：头 createStandardService + 条目 createStandardChildService +
 * createAggregateService；常规 confirm/unconfirm 与赠样 audit/void 双状态机迁 workflow（D7）。
 * 发票联动接缝仍收 Actor + 外层 trx，语义逐字冻结（invoice-seams.ts）。
 *
 * 路由手写（URL/DTO 冻结）；本文件只装配描述符、领域钩子与公开 API。
 */
import type { ListQuery } from '@synie/shared'
import { decimal } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import { utcToday } from '~/db/dates.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import type { GlEngine } from '~/engines/gl/index.ts'
import { createAggregateService, type AggregateService } from '~/platform/standard/aggregate.ts'
import {
  createStandardChildService,
  type StandardChildService,
} from '~/platform/standard/child.ts'
import { createStandardService, type StandardService } from '~/platform/standard/service.ts'
import { lowerParty, toDateOnly, type TradingSide, wireRequiredDecimal } from '../common.ts'
import {
  adjustProjection,
  assertGiftAction,
  assertRegularAction,
  closeTodos,
  fillDefaultAccounts,
  loadSource,
  openTodo,
  parseKind,
  postGiftGL,
  RECON_WRITE_ERRORS,
  requireItems,
  snapshotAmounts,
  validateHeadShape,
  validateItemShape,
  validateReferences,
  validateSource,
} from './domain.ts'
import type { TrxHandle } from '~/db/tx.ts'
import {
  closeFromInvoice as closeFromInvoiceSeam,
  existsForInvoice as existsForInvoiceSeam,
  loadForInvoiceAudit as loadForInvoiceAuditSeam,
  reopenFromInvoice as reopenFromInvoiceSeam,
} from './invoice-seams.ts'
import { reconciliationSpec, type ReconciliationSideSpec } from './spec.ts'
import type { ReconciliationDraft } from './types.ts'
import {
  HEAD_ALIAS,
  headExtras,
  headSelectExtra,
  headSource,
  ITEM_ALIAS,
  itemExtras,
  itemSelectExtra,
  itemSource,
  presentHead,
  presentItem,
} from './views.ts'

export type { InvoiceReconHead } from './invoice-seams.ts'

interface SideCtx {
  spec: ReconciliationSideSpec
  heads: StandardService
  items: StandardChildService
  aggregate: AggregateService
}

function headPayload(input: {
  companyId: string
  no?: string | null
  kind: string
  partyType: string
  partyId: string
  debitAccountId?: string | null
  creditAccountId?: string | null
  remarks?: string | null
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    companyId: input.companyId,
    reconciliationType: input.kind,
    partyType: input.partyType,
    partyId: input.partyId,
    remarks: input.remarks ?? null,
  }
  if (input.debitAccountId) payload.debitAccountId = input.debitAccountId
  if (input.creditAccountId) payload.creditAccountId = input.creditAccountId
  if (input.no != null && String(input.no).trim() !== '') payload.reconciliationNo = input.no
  return payload
}

function updateHeadPatch(input: {
  no?: string
  kind?: string
  partyType?: string
  partyId?: string
  debitAccountId?: string
  creditAccountId?: string
  remarks?: string | null
  remarksPresent?: boolean
}): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  if (input.no !== undefined) patch.reconciliationNo = input.no
  if (input.kind !== undefined) patch.reconciliationType = input.kind
  if (input.partyType !== undefined) patch.partyType = input.partyType
  if (input.partyId !== undefined) patch.partyId = input.partyId
  if (input.debitAccountId !== undefined) patch.debitAccountId = input.debitAccountId
  if (input.creditAccountId !== undefined) patch.creditAccountId = input.creditAccountId
  if (input.remarksPresent) patch.remarks = input.remarks ?? null
  return patch
}

function itemCreatePayload(
  side: TradingSide,
  input: {
    reconciliationId: string
    idx: number
    qty: string
    deliveryItemId?: string | null
    returnItemId?: string | null
    receiptItemId?: string | null
    outsourcedReceiptItemId?: string | null
    remarks?: string | null
  },
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    reconciliationId: input.reconciliationId,
    idx: input.idx,
    qty: input.qty,
    remarks: input.remarks ?? null,
  }
  if (side === 'sales') {
    payload.deliveryItemId = input.deliveryItemId ?? null
    payload.returnItemId = input.returnItemId ?? null
  } else {
    payload.receiptItemId = input.receiptItemId ?? null
    payload.outsourcedReceiptItemId = input.outsourcedReceiptItemId ?? null
  }
  return payload
}

function itemUpdatePatch(
  side: TradingSide,
  input: {
    idx?: number
    qty?: string
    deliveryItemId?: string | null
    deliveryItemIdPresent?: boolean
    returnItemId?: string | null
    returnItemIdPresent?: boolean
    receiptItemId?: string | null
    receiptItemIdPresent?: boolean
    outsourcedReceiptItemId?: string | null
    outsourcedReceiptItemIdPresent?: boolean
    remarks?: string | null
    remarksPresent?: boolean
  },
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  if (input.idx !== undefined) patch.idx = input.idx
  if (input.qty !== undefined) patch.qty = input.qty
  if (side === 'sales') {
    if (input.deliveryItemIdPresent) patch.deliveryItemId = input.deliveryItemId ?? null
    if (input.returnItemIdPresent) patch.returnItemId = input.returnItemId ?? null
  }
  if (side === 'purchase') {
    if (input.receiptItemIdPresent) patch.receiptItemId = input.receiptItemId ?? null
    if (input.outsourcedReceiptItemIdPresent) {
      patch.outsourcedReceiptItemId = input.outsourcedReceiptItemId ?? null
    }
  }
  if (input.remarksPresent) patch.remarks = input.remarks ?? null
  return patch
}

function draftItemPayload(side: TradingSide, item: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    idx: item.idx,
    qty: item.qty,
    remarks: item.remarks ?? null,
  }
  if (item.id !== undefined) payload.id = item.id
  if (side === 'sales') {
    payload.deliveryItemId = item.deliveryItemId ?? null
    payload.returnItemId = item.returnItemId ?? null
  } else {
    payload.receiptItemId = item.receiptItemId ?? null
    payload.outsourcedReceiptItemId = item.outsourcedReceiptItemId ?? null
  }
  return payload
}

function draftHeadPayload(input: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    companyId: input.companyId,
    reconciliationType: input.reconciliationType ?? input.kind,
    partyType: input.partyType,
    partyId: input.partyId,
    remarks: input.remarks ?? null,
  }
  if (input.debitAccountId) payload.debitAccountId = input.debitAccountId
  if (input.creditAccountId) payload.creditAccountId = input.creditAccountId
  const no = input.reconciliationNo ?? input.no
  if (no != null && String(no).trim() !== '') payload.reconciliationNo = no
  return payload
}

function presentDraft(side: TradingSide, draft: Record<string, unknown>): ReconciliationDraft {
  const items = Array.isArray(draft.items)
    ? (draft.items as Array<Record<string, unknown>>).map((row) => presentItem(side, row))
    : []
  return { ...presentHead(draft), items }
}

async function sumBaseGross(trx: TrxHandle, itemTable: string, id: string): Promise<string> {
  const sum = await sql<{ g: string }>`
    SELECT COALESCE(SUM(base_amount),0)::text AS g
    FROM ${sql.raw(itemTable)} WHERE reconciliation_id=${id}::uuid
  `.execute(trx)
  return wireRequiredDecimal(decimal(sum.rows[0]?.g ?? '0'))
}

export function createReconciliationService(
  db: Kysely<Database>,
  numberer: NumberingService,
  gl: Pick<GlEngine, 'post' | 'cancel'>,
  registry: Registry,
) {
  const sides: Record<TradingSide, SideCtx> = {
    sales: buildSide('sales'),
    purchase: buildSide('purchase'),
  }

  function buildSide(side: TradingSide): SideCtx {
    const spec = reconciliationSpec(side)

    const heads = createStandardService({
      db,
      registry,
      resource: spec.headResource,
      notFound: `${spec.label}不存在`,
      defaultOrder: sql`"inserted_at" DESC, "id" DESC`,
      writeErrors: RECON_WRITE_ERRORS,
      numbering: { service: numberer, field: 'reconciliationNo' },
      projection: {
        source: headSource(spec),
        alias: HEAD_ALIAS,
        selectExtra: headSelectExtra(),
        mapExtra: headExtras,
      },
      hooks: {
        insertColumns: ({ permit }) => ({
          status: 'draft',
          created_by_id: permit.actor.userId || null,
        }),
        validate: ({ action, draft, before }) => {
          if (action === 'create') {
            const fields: Record<string, string[]> = {}
            if (!draft.companyId) fields.companyId = ['必填']
            try {
              parseKind(String(draft.reconciliationType ?? ''))
            } catch {
              fields.reconciliationType = ['只允许 REGULAR 或 GIFT_SAMPLE']
            }
            const partyType = lowerParty(String(draft.partyType ?? ''))
            if (partyType !== spec.party && partyType !== 'company') {
              fields.partyType = ['对手类型不合法']
            }
            if (!draft.partyId) fields.partyId = ['必填']
            if (partyType === 'company' && String(draft.partyId) === String(draft.companyId)) {
              fields.partyId = ['对手不能是本公司']
            }
            if (Object.keys(fields).length > 0) {
              throw ApiError.validation(`${spec.label}参数不合法`, fields)
            }
            return
          }
          if (
            before &&
            draft.reconciliationNo !== undefined &&
            String(draft.reconciliationNo).trim() !== String(before.reconciliationNo)
          ) {
            throw ApiError.validation(`${spec.label}参数不合法`, {
              reconciliationNo: ['编号创建后不可修改'],
            })
          }
          if (
            before &&
            draft.reconciliationType !== undefined &&
            parseKind(String(draft.reconciliationType)) !==
              String(before.reconciliationType).toLowerCase()
          ) {
            throw new ApiError('conflict', '对账类型不可变更')
          }
          validateHeadShape(spec, {
            companyId: String(draft.companyId ?? before?.companyId ?? ''),
            no: String(draft.reconciliationNo ?? before?.reconciliationNo ?? ''),
            kind: String(draft.reconciliationType ?? before?.reconciliationType ?? '').toLowerCase(),
            partyType: lowerParty(String(draft.partyType ?? before?.partyType ?? '')),
            partyId: String(draft.partyId ?? before?.partyId ?? ''),
            debitAccountId: String(draft.debitAccountId ?? before?.debitAccountId ?? ''),
            creditAccountId: String(draft.creditAccountId ?? before?.creditAccountId ?? ''),
            remarks: draft.remarks == null ? null : String(draft.remarks),
          })
        },
        beforeWrite: async (trx, { action, draft, before }) => {
          if (action === 'create') {
            draft.reconciliationType = parseKind(String(draft.reconciliationType ?? ''))
            draft.partyType = lowerParty(String(draft.partyType ?? ''))
            const filled = await fillDefaultAccounts(
              trx,
              spec,
              String(draft.companyId),
              String(draft.debitAccountId ?? ''),
              String(draft.creditAccountId ?? ''),
            )
            draft.debitAccountId = filled.debitAccountId
            draft.creditAccountId = filled.creditAccountId
            validateHeadShape(spec, {
              companyId: String(draft.companyId ?? ''),
              no: null,
              kind: String(draft.reconciliationType),
              partyType: String(draft.partyType),
              partyId: String(draft.partyId ?? ''),
              debitAccountId: String(draft.debitAccountId),
              creditAccountId: String(draft.creditAccountId),
              remarks: draft.remarks == null ? null : String(draft.remarks),
            })
            await validateReferences(
              trx,
              spec,
              String(draft.companyId),
              String(draft.partyType),
              String(draft.partyId),
              String(draft.debitAccountId),
              String(draft.creditAccountId),
            )
            return
          }
          if (draft.partyType != null) draft.partyType = lowerParty(String(draft.partyType))
          if (draft.reconciliationType != null) {
            draft.reconciliationType = parseKind(String(draft.reconciliationType))
          }
          await validateReferences(
            trx,
            spec,
            String(draft.companyId ?? before?.companyId),
            lowerParty(String(draft.partyType ?? before?.partyType)),
            String(draft.partyId ?? before?.partyId),
            String(draft.debitAccountId ?? before?.debitAccountId),
            String(draft.creditAccountId ?? before?.creditAccountId),
          )
          if (before) {
            const partyChanged =
              lowerParty(String(draft.partyType ?? before.partyType)) !==
                lowerParty(String(before.partyType)) ||
              String(draft.partyId ?? before.partyId) !== String(before.partyId)
            if (partyChanged) {
              const has = await sql<{ e: boolean }>`
                SELECT EXISTS(
                  SELECT 1 FROM ${sql.raw(spec.itemTable)}
                  WHERE reconciliation_id=${String(before.id)}::uuid
                ) AS e
              `.execute(trx)
              if (has.rows[0]?.e) throw new ApiError('conflict', '请先删除对账条目')
            }
          }
        },
      },
      workflow: {
        mutableMessage: `仅草稿${spec.label}可修改或删除`,
        transitions: [
          {
            key: 'confirm',
            label: '确认',
            from: ['DRAFT'],
            to: 'CONFIRMED',
            guardMessage: '对账单当前状态不允许执行该动作',
            effect: async (trx, { before, permit }) => {
              assertRegularAction(before)
              await requireItems(trx, spec, String(before.id))
              await adjustProjection(trx, spec, String(before.id), 1)
              const g = await sumBaseGross(trx, spec.itemTable, String(before.id))
              await openTodo(trx, spec, { ...before, baseGrossTotal: g }, permit.actor.userId || null)
            },
          },
          {
            key: 'unconfirm',
            label: '撤回确认',
            from: ['CONFIRMED'],
            to: 'DRAFT',
            guardMessage: '对账单当前状态不允许执行该动作',
            effect: async (trx, { before }) => {
              assertRegularAction(before)
              const column = side === 'sales' ? 'sal_reconciliation_id' : 'pur_reconciliation_id'
              const linked = await sql<{ e: boolean }>`
                SELECT EXISTS(
                  SELECT 1 FROM acc_vat_invoice
                  WHERE ${sql.raw(column)}=${String(before.id)}::uuid
                ) AS e
              `.execute(trx)
              if (linked.rows[0]?.e) {
                throw new ApiError('conflict', '已关联发票，不可撤回确认')
              }
              await adjustProjection(trx, spec, String(before.id), -1)
              await closeTodos(trx, spec, String(before.id), 'unconfirm')
            },
          },
          {
            key: 'audit',
            label: '结单',
            from: ['DRAFT'],
            to: 'CLOSED',
            guardMessage: '仅草稿赠送/样品对账单可结单审核',
            effect: async (trx, { before, input }) => {
              assertGiftAction(before, '仅草稿赠送/样品对账单可结单审核')
              await requireItems(trx, spec, String(before.id))
              await adjustProjection(trx, spec, String(before.id), 1)
              const posting =
                input.postingDate != null && input.postingDate !== ''
                  ? toDateOnly(String(input.postingDate))
                  : utcToday()
              const g = await sumBaseGross(trx, spec.itemTable, String(before.id))
              if (decimal(g).gt(0)) {
                await postGiftGL(trx, gl, spec, { ...before, baseGrossTotal: g }, posting)
              }
              return { posting_date: posting }
            },
          },
          {
            key: 'void',
            label: '作废',
            from: ['CLOSED'],
            to: 'VOIDED',
            guardMessage: '对账单当前状态不允许执行该动作',
            effect: async (trx, { before }) => {
              assertGiftAction(before, '对账单当前状态不允许执行该动作')
              await gl.cancel(trx, { type: spec.voucher, id: String(before.id) })
              await adjustProjection(trx, spec, String(before.id), -1)
            },
          },
        ],
      },
    })

    const items = createStandardChildService({
      db,
      registry,
      resource: spec.itemResource,
      notFound: '对账条目不存在',
      defaultOrder: sql`"idx" ASC, "id" ASC`,
      writeErrors: RECON_WRITE_ERRORS,
      recordLabel: (item) =>
        item.reconciliationNo != null
          ? `${String(item.reconciliationNo)}-${Number(item.idx)}`
          : String(item.idx),
      derivedFields: ['baseQty', 'amount', 'baseAmount'],
      projection: {
        source: itemSource(spec),
        alias: ITEM_ALIAS,
        selectExtra: itemSelectExtra(side),
        mapExtra: (row) => itemExtras(side, row),
      },
      parent: {
        resource: spec.headResource,
        fkField: 'reconciliationId',
        notFound: `${spec.label}不存在`,
        inheritFields: ['companyId'],
        gate: (parent) => {
          if (String(parent.status) !== 'DRAFT') {
            throw new ApiError('conflict', '仅草稿对账单可编辑条目')
          }
        },
      },
      hooks: {
        validate: ({ draft }) => {
          const qty = draft.qty
          if (qty === undefined || qty === null || qty === '') {
            throw ApiError.validation('对账条目参数不合法', { qty: ['必填'] })
          }
          validateItemShape(side, {
            reconciliationId:
              draft.reconciliationId == null ? undefined : String(draft.reconciliationId),
            qty: String(qty),
            deliveryItemId:
              draft.deliveryItemId === undefined
                ? undefined
                : draft.deliveryItemId == null
                  ? null
                  : String(draft.deliveryItemId),
            returnItemId:
              draft.returnItemId === undefined
                ? undefined
                : draft.returnItemId == null
                  ? null
                  : String(draft.returnItemId),
            receiptItemId:
              draft.receiptItemId === undefined
                ? undefined
                : draft.receiptItemId == null
                  ? null
                  : String(draft.receiptItemId),
            outsourcedReceiptItemId:
              draft.outsourcedReceiptItemId === undefined
                ? undefined
                : draft.outsourcedReceiptItemId == null
                  ? null
                  : String(draft.outsourcedReceiptItemId),
            remarks: draft.remarks == null ? null : String(draft.remarks),
          })
        },
        beforeWrite: async (trx, { action, draft, parent, before }) => {
          const sourceInput = {
            deliveryItemId:
              side === 'sales'
                ? draft.deliveryItemId == null || draft.deliveryItemId === ''
                  ? null
                  : String(draft.deliveryItemId)
                : null,
            returnItemId:
              side === 'sales'
                ? draft.returnItemId == null || draft.returnItemId === ''
                  ? null
                  : String(draft.returnItemId)
                : null,
            receiptItemId:
              side === 'purchase'
                ? draft.receiptItemId == null || draft.receiptItemId === ''
                  ? null
                  : String(draft.receiptItemId)
                : null,
            outsourcedReceiptItemId:
              side === 'purchase'
                ? draft.outsourcedReceiptItemId == null || draft.outsourcedReceiptItemId === ''
                  ? null
                  : String(draft.outsourcedReceiptItemId)
                : null,
          }
          const qty = decimal(String(draft.qty))
          const source = await loadSource(trx, side, sourceInput, true)
          await validateSource(
            trx,
            spec,
            parent,
            source,
            action === 'update' && before ? String(before.id) : null,
            qty,
          )
          const amounts = snapshotAmounts(qty, source)
          draft.qty = wireRequiredDecimal(qty)
          draft.baseQty = amounts.baseQty
          draft.amount = amounts.amount
          draft.baseAmount = amounts.baseAmount
          draft.remarks = draft.remarks == null ? null : String(draft.remarks)
          // 双来源恰一：按来源落对应外键并清空另一臂
          if (side === 'sales') {
            if (source.isReturn) {
              draft.returnItemId = source.id
              draft.deliveryItemId = null
            } else {
              draft.deliveryItemId = source.id
              draft.returnItemId = null
            }
          }
        },
      },
    })

    return {
      spec,
      heads,
      items,
      aggregate: createAggregateService({
        db,
        registry,
        head: heads,
        validationMessage: '对账草稿参数不合法',
        children: [{ key: 'items', service: items }],
      }),
    }
  }

  return {
    listHeads: async (p: Permit, side: TradingSide, q: Partial<ListQuery>) => {
      const r = await sides[side].heads.list(p, q)
      return { count: r.count, results: r.results.map((row) => presentHead(row)) }
    },
    getHead: async (p: Permit, side: TradingSide, id: string) =>
      presentHead(await sides[side].heads.get(p, id)),
    createHead: async (
      p: Permit,
      side: TradingSide,
      input: Parameters<typeof headPayload>[0],
    ) => presentHead(await sides[side].heads.create(p, headPayload(input))),
    updateHead: async (
      p: Permit,
      side: TradingSide,
      id: string,
      input: Parameters<typeof updateHeadPatch>[0],
    ) => presentHead(await sides[side].heads.update(p, id, updateHeadPatch(input))),
    deleteHead: (p: Permit, side: TradingSide, id: string) => sides[side].heads.remove(p, id),
    confirm: async (p: Permit, side: TradingSide, id: string) =>
      presentHead(await sides[side].heads.transition(p, id, 'confirm')),
    unconfirm: async (p: Permit, side: TradingSide, id: string) =>
      presentHead(await sides[side].heads.transition(p, id, 'unconfirm')),
    audit: async (
      p: Permit,
      side: TradingSide,
      id: string,
      input: { postingDate?: string | null },
    ) =>
      presentHead(
        await sides[side].heads.transition(p, id, 'audit', {
          postingDate: input.postingDate ?? null,
        }),
      ),
    void: async (p: Permit, side: TradingSide, id: string) =>
      presentHead(await sides[side].heads.transition(p, id, 'void')),
    closeFromInvoice: (h: DbHandle, actor: Actor, side: TradingSide, id: string) =>
      closeFromInvoiceSeam(h, actor, registry, side, id),
    reopenFromInvoice: (h: DbHandle, actor: Actor, side: TradingSide, id: string) =>
      reopenFromInvoiceSeam(h, actor, registry, side, id),
    existsForInvoice: existsForInvoiceSeam,
    loadForInvoiceAudit: loadForInvoiceAuditSeam,
    listItems: async (p: Permit, side: TradingSide, q: Partial<ListQuery>) => {
      const r = await sides[side].items.list(p, q)
      return { count: r.count, results: r.results.map((row) => presentItem(side, row)) }
    },
    getItem: async (p: Permit, side: TradingSide, id: string) =>
      presentItem(side, await sides[side].items.get(p, id)),
    createItem: async (
      p: Permit,
      side: TradingSide,
      input: Parameters<typeof itemCreatePayload>[1],
    ) => presentItem(side, await sides[side].items.create(p, itemCreatePayload(side, input))),
    updateItem: async (
      p: Permit,
      side: TradingSide,
      id: string,
      input: Parameters<typeof itemUpdatePatch>[1],
    ) => presentItem(side, await sides[side].items.update(p, id, itemUpdatePatch(side, input))),
    deleteItem: (p: Permit, side: TradingSide, id: string) => sides[side].items.remove(p, id),
    getDraft: async (p: Permit, side: TradingSide, id: string) =>
      presentDraft(side, await sides[side].aggregate.loadDraft(p, id)),
    createDraft: async (p: Permit, side: TradingSide, input: Record<string, unknown>) => {
      const items = Array.isArray(input.items)
        ? (input.items as Array<Record<string, unknown>>).map((item) =>
            draftItemPayload(side, item),
          )
        : input.items
      return presentDraft(
        side,
        await sides[side].aggregate.createDraft(p, { ...draftHeadPayload(input), items }),
      )
    },
    replaceDraft: async (
      p: Permit,
      side: TradingSide,
      id: string,
      input: Record<string, unknown>,
    ) => {
      const items = Array.isArray(input.items)
        ? (input.items as Array<Record<string, unknown>>).map((item) =>
            draftItemPayload(side, item),
          )
        : input.items
      return presentDraft(
        side,
        await sides[side].aggregate.replaceDraft(p, id, {
          ...draftHeadPayload(input),
          items,
        }),
      )
    },
    _aggregateForContract: (side: TradingSide): AggregateService => {
      const asRec = (d: ReconciliationDraft) => d as unknown as Record<string, unknown>
      return {
        loadDraft: async (p, id) =>
          asRec(presentDraft(side, await sides[side].aggregate.loadDraft(p, id))),
        createDraft: async (p, input) => {
          const items = Array.isArray(input.items)
            ? (input.items as Array<Record<string, unknown>>).map((item) =>
                draftItemPayload(side, item),
              )
            : input.items
          return asRec(
            presentDraft(
              side,
              await sides[side].aggregate.createDraft(p, {
                ...draftHeadPayload(input),
                items,
              }),
            ),
          )
        },
        replaceDraft: async (p, id, input) => {
          const items = Array.isArray(input.items)
            ? (input.items as Array<Record<string, unknown>>).map((item) =>
                draftItemPayload(side, item),
              )
            : input.items
          return asRec(
            presentDraft(
              side,
              await sides[side].aggregate.replaceDraft(p, id, {
                ...draftHeadPayload(input),
                items,
              }),
            ),
          )
        },
        head: sides[side].heads,
        children: sides[side].aggregate.children,
      }
    },
  }
}

export type ReconciliationService = ReturnType<typeof createReconciliationService>
