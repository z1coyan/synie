/**
 * 销售退货（源单行）：标准服务装配。
 * 审核单事务：库存引擎（回库）+ 发货条目已退/订单条目已发投影 + 金额>0 时 GL 引擎
 * （零金额跳总账，科目草稿必填）。机制镜像 fulfillment 销售侧（无装箱子树）。
 *
 * 头/条目 + 整单草稿由 platform/standard 派生
 * （createStandardService + createStandardChildService + createAggregateService）。
 * 授权全由平台承担：路由挂 `guard(资源, 动作)`，本服务只收 Permit。
 */
import { decimal, type ListQuery } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { TrxHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import type { GlEngine } from '~/engines/gl/index.ts'
import type { InventoryEngine } from '~/engines/inventory/index.ts'
import { auditFieldsOf } from '~/platform/audit/spec.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import {
  createAggregateService,
  type AggregateService,
} from '~/platform/standard/aggregate.ts'
import { createStandardChildService } from '~/platform/standard/child.ts'
import { createStandardService } from '~/platform/standard/service.ts'
import {
  lowerParty,
  runeLen,
  syncDrawingAttachments,
  toDateOnly,
  wireRequiredDecimal,
} from '../common.ts'
import { utcToday } from '~/db/dates.ts'
import {
  deriveItem,
  headLikeFromDraft,
  ITEM_ALIAS,
  ITEM_DERIVED,
  ITEM_SOURCE,
  RETURN_WRITE_ERRORS,
  validateHeadRefs,
  validateHeadWire,
} from './domain.ts'
import { runAuditHead, runVoidHead } from './workflow.ts'
import {
  RETURN_HEAD_LABEL,
  RETURN_HEAD_RESOURCE,
  RETURN_ITEM_LABEL,
  RETURN_ITEM_RESOURCE,
  RETURN_ITEM_TABLE,
} from './spec.ts'
import type { ReturnDraftDto, ReturnDraftInput } from './types.ts'
import {
  mapReturnItemExtras,
  presentReturnDraft,
  presentReturnHead,
  presentReturnItem,
  returnDraftPayload,
} from './views.ts'
import { returnHeadMeta } from './spec.ts'

export type { ReturnDraftDto, ReturnDraftInput, ReturnDraftItemInput, ReturnHead, ReturnItemDto } from './types.ts'

// 审核/作废审计：头字段白名单；单号/日期列经 rename 为通用键
const HEAD_AUDIT = auditFieldsOf(returnHeadMeta(), {
  rename: { return_no: 'number', return_date: 'document_date' },
})

type Numberer = Pick<NumberingService, 'assignedInTx' | 'nextInTx'>

export function createReturnsService(
  db: Kysely<Database>,
  numberer: Numberer,
  engines: {
    inventory: Pick<InventoryEngine, 'post' | 'cancel'>
    gl: Pick<GlEngine, 'post' | 'cancel'>
  },
  registry: Registry,
) {
  const { inventory, gl } = engines
  const headTarget = registry.authzTarget(RETURN_HEAD_RESOURCE)

  const heads = createStandardService({
    db,
    registry,
    resource: RETURN_HEAD_RESOURCE,
    notFound: `${RETURN_HEAD_LABEL}不存在`,
    defaultOrder: sql`"return_date" DESC, "id" ASC`,
    writeErrors: [{ code: '23505', message: `${RETURN_HEAD_LABEL}单号已存在` }],
    numbering: { service: numberer, field: 'returnNo' },
    hooks: {
      insertColumns: ({ permit }: { permit: Permit }) => ({
        status: 'draft',
        created_by_id: permit.actor.userId || null,
      }),
      validate: ({
        action,
        draft,
        before,
      }: {
        action: 'create' | 'update'
        draft: Record<string, unknown>
        before?: Record<string, unknown>
      }) => {
        validateHeadWire(draft, {
          requireReturnNo: action === 'update',
          requireDate: action === 'update' || draft.returnDate != null,
        })
        if (
          action === 'update' &&
          before &&
          draft.returnNo !== undefined &&
          String(draft.returnNo).trim() !== String(before.returnNo)
        ) {
          throw ApiError.validation(`${RETURN_HEAD_LABEL}参数不合法`, {
            returnNo: ['编号创建后不可修改'],
          })
        }
      },
      beforeWrite: async (
        trx: TrxHandle,
        {
          action,
          draft,
          before,
        }: {
          action: 'create' | 'update'
          draft: Record<string, unknown>
          before?: Record<string, unknown>
        },
      ) => {
        if (action === 'create') {
          if (!draft.returnDate) draft.returnDate = utcToday()
          else draft.returnDate = toDateOnly(String(draft.returnDate))
          // 原币/汇率缺省代入：公司本币 + 1（手工行全单换算口径）
          if (!draft.currencyId && draft.companyId) {
            const company = await trx
              .selectFrom('bas_company')
              .select('base_currency_id')
              .where('id', '=', String(draft.companyId))
              .executeTakeFirst()
            draft.currencyId = company?.base_currency_id ?? null
          }
          if (draft.exchangeRate == null || draft.exchangeRate === '') draft.exchangeRate = '1'
        } else if (draft.returnDate != null) {
          draft.returnDate = toDateOnly(String(draft.returnDate))
        }
        if (draft.postingDate != null && draft.postingDate !== '') {
          draft.postingDate = toDateOnly(String(draft.postingDate))
        } else if (draft.postingDate === '') {
          draft.postingDate = null
        }
        if (draft.partyType != null) draft.partyType = lowerParty(String(draft.partyType))
        if (draft.exchangeRate === '') draft.exchangeRate = null
        validateHeadWire(draft, { requireReturnNo: action === 'update', requireDate: true })
        await validateHeadRefs(trx, headLikeFromDraft(draft, before))
        if (action === 'update' && before) {
          const partyTypeChanged =
            lowerParty(String(draft.partyType ?? before.partyType)) !==
            lowerParty(String(before.partyType))
          const partyIdChanged =
            String(draft.partyId ?? before.partyId) !== String(before.partyId)
          const currencyChanged =
            String(draft.currencyId ?? before.currencyId) !== String(before.currencyId)
          if (partyTypeChanged || partyIdChanged || currencyChanged) {
            const has = await sql<{ e: boolean }>`
              SELECT EXISTS(
                SELECT 1 FROM ${sql.raw(RETURN_ITEM_TABLE)}
                WHERE return_id=${String(before.id)}::uuid
              ) AS e
            `.execute(trx)
            if (has.rows[0]?.e) {
              const fields: Record<string, string[]> = {}
              if (partyTypeChanged) fields.partyType = ['已有条目时不可修改']
              if (partyIdChanged) fields.partyId = ['已有条目时不可修改']
              if (currencyChanged) fields.currencyId = ['已有条目时不可修改']
              throw ApiError.validation('已有条目时不可修改退货对手或原币', fields)
            }
          }
        }
      },
      beforeDelete: async (trx: TrxHandle, { item }: { item: Record<string, unknown> }) => {
        await sql`
          DELETE FROM sys_attachment
          WHERE owner_type=${RETURN_ITEM_TABLE}
            AND owner_id IN (
              SELECT id FROM ${sql.raw(RETURN_ITEM_TABLE)}
              WHERE return_id=${String(item.id)}::uuid
            )
        `.execute(trx)
      },
    },
    workflow: {
      mutableMessage: `仅草稿${RETURN_HEAD_LABEL}可编辑`,
      transitions: [],
    },
  })

  const items = createStandardChildService({
    db,
    registry,
    resource: RETURN_ITEM_RESOURCE,
    notFound: `${RETURN_ITEM_LABEL}不存在`,
    defaultOrder: sql`"idx" ASC, "id" ASC`,
    writeErrors: RETURN_WRITE_ERRORS,
    recordLabel: (item) => String(item.idx),
    derivedFields: [...ITEM_DERIVED],
    projection: {
      source: ITEM_SOURCE,
      alias: ITEM_ALIAS,
      selectExtra: sql`return_no, return_date, return_status, party_type, remaining_reconcilable_qty`,
      mapExtra: mapReturnItemExtras,
    },
    parent: {
      resource: RETURN_HEAD_RESOURCE,
      fkField: 'returnId',
      notFound: `${RETURN_HEAD_LABEL}不存在`,
      inheritFields: ['companyId'],
      gate: (parent: Record<string, unknown>) => {
        if (String(parent.status) !== 'DRAFT') {
          throw new ApiError('conflict', `仅草稿${RETURN_HEAD_LABEL}可编辑`)
        }
      },
    },
    hooks: {
      validate: ({ draft }: { draft: Record<string, unknown> }) => {
        const qty = draft.qty
        if (qty === undefined || qty === null || qty === '') {
          throw ApiError.validation(`${RETURN_ITEM_LABEL}参数不合法`, { qty: ['必填'] })
        }
        if (!decimal(String(qty)).gt(0)) {
          throw ApiError.validation(`${RETURN_ITEM_LABEL}参数不合法`, { qty: ['必须大于 0'] })
        }
        if (draft.deliveryItemId) {
          // 源单行：锚点以外的物料/价税一律由发货快照覆盖，手填忽略
        } else {
          // 手工行：物料/含税单价/税率手填必填（单价可为 0——零金额跳过总账）
          if (!draft.materialId) {
            throw ApiError.validation(`${RETURN_ITEM_LABEL}参数不合法`, {
              materialId: ['必填'],
            })
          }
          if (draft.orderPrice == null || draft.orderPrice === '') {
            throw ApiError.validation(`${RETURN_ITEM_LABEL}参数不合法`, {
              orderPrice: ['必填'],
            })
          }
          if (decimal(String(draft.orderPrice)).lt(0)) {
            throw ApiError.validation(`${RETURN_ITEM_LABEL}参数不合法`, {
              orderPrice: ['不能小于 0'],
            })
          }
          if (draft.orderTaxRate == null || draft.orderTaxRate === '') {
            throw ApiError.validation(`${RETURN_ITEM_LABEL}参数不合法`, {
              orderTaxRate: ['必填'],
            })
          }
          if (decimal(String(draft.orderTaxRate)).lt(0)) {
            throw ApiError.validation(`${RETURN_ITEM_LABEL}参数不合法`, {
              orderTaxRate: ['不能小于 0'],
            })
          }
        }
        if (draft.remarks != null && runeLen(String(draft.remarks)) > 512) {
          throw ApiError.validation(`${RETURN_ITEM_LABEL}参数不合法`, {
            remarks: ['最多 512 个字符'],
          })
        }
      },
      beforeWrite: async (
        trx: TrxHandle,
        {
          draft,
          parent,
        }: { draft: Record<string, unknown>; parent: Record<string, unknown> },
      ) => {
        const derived = await deriveItem(
          trx,
          {
            companyId: String(parent.companyId),
            partyType: String(parent.partyType),
            partyId: String(parent.partyId),
            currencyId: parent.currencyId ? String(parent.currencyId) : null,
            exchangeRate: parent.exchangeRate != null ? String(parent.exchangeRate) : null,
          },
          {
            idx: Number(draft.idx),
            qty: decimal(String(draft.qty)),
            deliveryItemId:
              draft.deliveryItemId == null || draft.deliveryItemId === ''
                ? null
                : String(draft.deliveryItemId),
            materialId:
              draft.materialId == null || draft.materialId === ''
                ? null
                : String(draft.materialId),
            unitId: draft.unitId == null || draft.unitId === '' ? null : String(draft.unitId),
            warehouseId:
              draft.warehouseId === undefined ||
              draft.warehouseId === null ||
              draft.warehouseId === ''
                ? null
                : String(draft.warehouseId),
            price:
              draft.orderPrice == null || draft.orderPrice === ''
                ? null
                : decimal(String(draft.orderPrice)),
            taxRate:
              draft.orderTaxRate == null || draft.orderTaxRate === ''
                ? null
                : decimal(String(draft.orderTaxRate)),
            remarks: draft.remarks == null ? null : String(draft.remarks),
          },
        )
        draft.idx = derived.idx
        draft.qty = wireRequiredDecimal(derived.qty)
        draft.baseQty = wireRequiredDecimal(derived.baseQty)
        draft.deliveryItemId = derived.deliveryItemId
        draft.orderItemId = derived.orderItemId
        draft.materialId = derived.materialId
        draft.unitId = derived.unitId
        draft.warehouseId = derived.warehouseId
        draft.materialCode = derived.materialCode
        draft.materialName = derived.materialName
        draft.materialSpec = derived.materialSpec
        draft.customerPartNo = derived.customerPartNo
        draft.unitName = derived.unitName
        draft.orderNo = derived.orderNo
        draft.orderQty = wireRequiredDecimal(derived.orderQty)
        draft.orderBaseQty = wireRequiredDecimal(derived.orderBaseQty)
        draft.orderUnitName = derived.orderUnitName
        draft.orderPrice = wireRequiredDecimal(derived.orderPrice)
        draft.orderAmount = wireRequiredDecimal(derived.orderAmount)
        draft.orderBasePrice = wireRequiredDecimal(derived.orderBasePrice)
        draft.orderBaseAmount = wireRequiredDecimal(derived.orderBaseAmount)
        draft.orderTaxRate = wireRequiredDecimal(derived.orderTaxRate)
        draft.orderCurrencyCode = derived.orderCurrencyCode
        draft.remarks = derived.remarks
      },
      afterWrite: async (
        trx: TrxHandle,
        {
          item,
          parent,
        }: { item: Record<string, unknown>; parent: Record<string, unknown> },
      ) => {
        await syncDrawingAttachments(
          trx,
          RETURN_ITEM_TABLE,
          String(item.id),
          String(item.materialId),
          String(parent.companyId),
        )
      },
      beforeDelete: async (
        trx: TrxHandle,
        { item }: { item: Record<string, unknown> },
      ) => {
        await sql`
          DELETE FROM sys_attachment
          WHERE owner_type=${RETURN_ITEM_TABLE} AND owner_id=${String(item.id)}::uuid
        `.execute(trx)
      },
    },
  })

  const aggregate = createAggregateService({
    db,
    registry,
    head: heads,
    validationMessage: '销售退货草稿参数不合法',
    children: [{ key: 'items', service: items }],
  })

  const engineDeps = { inventory, gl, headTarget, auditFields: HEAD_AUDIT }
  const asRec = (v: unknown) => v as Record<string, unknown>
  const listMapped = <T,>(
    r: { count: number; results: readonly unknown[] },
    present: (row: Record<string, unknown>) => T,
  ) => ({ count: r.count, results: r.results.map((row) => present(row as Record<string, unknown>)) })

  return {
    getDraft: async (p: Permit, id: string): Promise<ReturnDraftDto> =>
      presentReturnDraft(await aggregate.loadDraft(p, id)),
    createDraft: async (p: Permit, input: ReturnDraftInput): Promise<ReturnDraftDto> =>
      presentReturnDraft(await aggregate.createDraft(p, returnDraftPayload(input))),
    replaceDraft: async (
      p: Permit,
      id: string,
      input: ReturnDraftInput,
    ): Promise<ReturnDraftDto> =>
      presentReturnDraft(await aggregate.replaceDraft(p, id, returnDraftPayload(input))),
    listHeads: async (p: Permit, q: Partial<ListQuery>) =>
      listMapped(await heads.list(p, q), presentReturnHead),
    getHead: async (p: Permit, id: string) =>
      presentReturnHead((await heads.get(p, id)) as Record<string, unknown>),
    deleteHead: (p: Permit, id: string) => heads.remove(p, id),
    auditHead: (p: Permit, id: string) => runAuditHead(db, p, id, engineDeps),
    voidHead: (p: Permit, id: string) => runVoidHead(db, p, id, engineDeps),
    listItems: async (p: Permit, q: Partial<ListQuery>) =>
      listMapped(await items.list(p, q), presentReturnItem),
    getItem: async (p: Permit, id: string) =>
      presentReturnItem((await items.get(p, id)) as Record<string, unknown>),
    _aggregateForContract: (): AggregateService => ({
      loadDraft: async (p, id) => asRec(presentReturnDraft(await aggregate.loadDraft(p, id))),
      createDraft: async (p, input) =>
        asRec(
          presentReturnDraft(
            await aggregate.createDraft(p, returnDraftPayload(input as unknown as ReturnDraftInput)),
          ),
        ),
      replaceDraft: async (p, id, input) =>
        asRec(
          presentReturnDraft(
            await aggregate.replaceDraft(
              p,
              id,
              returnDraftPayload(input as unknown as ReturnDraftInput),
            ),
          ),
        ),
      head: heads,
      children: aggregate.children,
    }),
  }
}

export type ReturnsService = ReturnType<typeof createReturnsService>
