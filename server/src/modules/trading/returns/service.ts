/**
 * 退货（销售/采购）：标准服务装配。
 * 审核单事务：库存引擎（销售回库 in / 采购出仓 out）+ 来源条目已退/订单条目已发已收投影
 * + 金额>0 时 GL 引擎（零金额跳总账，科目草稿必填）。机制镜像 fulfillment（无装箱子树）。
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
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { AuthzTarget } from '~/platform/meta/resource-authz.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import {
  createAggregateService,
  withAggregateWireAdapter,
  type AggregateService,
} from '~/platform/standard/aggregate.ts'
import { createStandardChildService } from '~/platform/standard/child.ts'
import { auditStamp, createStandardService, type TransitionContext } from '~/platform/standard/service.ts'
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
  headFromWire,
  headLikeFromDraft,
  ITEM_ALIAS,
  ITEM_SOURCE,
  itemDerived,
  RETURN_WRITE_ERRORS,
  validateHeadRefs,
  validateHeadWire,
} from './domain.ts'
import { effectAuditHead, effectVoidHead, runGenerateReplenishment } from './workflow.ts'
import { returnSpec, type ReturnKind, type ReturnSideSpec } from './spec.ts'
import type { ReturnDraftDto, ReturnDraftInput } from './types.ts'
import {
  mapReturnItemExtras,
  presentReturnDraft,
  presentReturnHead,
  presentReturnItem,
  returnDraftPayload,
} from './views.ts'

export type {
  ReturnDraftDto,
  ReturnDraftInput,
  ReturnDraftItemInput,
  ReturnHead,
  ReturnItemDto,
} from './types.ts'

type Numberer = Pick<NumberingService, 'assignedInTx' | 'nextInTx'>

interface SideCtx {
  spec: ReturnSideSpec
  heads: ReturnType<typeof createStandardService>
  items: ReturnType<typeof createStandardChildService>
  aggregate: AggregateService
  /** 合同适配聚合（toPayload + present 包装由内核承担） */
  contractAggregate: AggregateService
}

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
  const headTargets: Record<ReturnKind, AuthzTarget> = {
    sales: registry.authzTarget(returnSpec('sales').headResource),
    purchase: registry.authzTarget(returnSpec('purchase').headResource),
    outsourced: registry.authzTarget(returnSpec('outsourced').headResource),
  }

  function buildSide(side: ReturnKind): SideCtx {
    const spec = returnSpec(side)
    const sourceKey = spec.sourceItemApi

    const heads = createStandardService({
      db,
      registry,
      resource: spec.headResource,
      notFound: `${spec.label}不存在`,
      defaultOrder: sql`"return_date" DESC, "id" ASC`,
      writeErrors: [{ code: '23505', message: `${spec.label}单号已存在` }],
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
          validateHeadWire(spec, draft, {
            requireReturnNo: action === 'update',
            requireDate: action === 'update' || draft.returnDate != null,
          })
          if (
            action === 'update' &&
            before &&
            draft.returnNo !== undefined &&
            String(draft.returnNo).trim() !== String(before.returnNo)
          ) {
            throw ApiError.validation(`${spec.label}参数不合法`, {
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
            // 原币/汇率缺省代入：公司本币 + 1（手工行全单换算口径；仅金额单）
            if (spec.monetary) {
              if (!draft.currencyId && draft.companyId) {
                const company = await trx
                  .selectFrom('bas_company')
                  .select('base_currency_id')
                  .where('id', '=', String(draft.companyId))
                  .executeTakeFirst()
                draft.currencyId = company?.base_currency_id ?? null
              }
              if (draft.exchangeRate == null || draft.exchangeRate === '') draft.exchangeRate = '1'
            }
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
          validateHeadWire(spec, draft, {
            requireReturnNo: action === 'update',
            requireDate: true,
          })
          await validateHeadRefs(trx, spec, headLikeFromDraft(draft, before))
          if (action === 'update' && before) {
            const partyTypeChanged =
              lowerParty(String(draft.partyType ?? before.partyType)) !==
              lowerParty(String(before.partyType))
            const partyIdChanged =
              String(draft.partyId ?? before.partyId) !== String(before.partyId)
            const currencyChanged =
              spec.monetary &&
              String(draft.currencyId ?? before.currencyId) !== String(before.currencyId)
            if (partyTypeChanged || partyIdChanged || currencyChanged) {
              const has = await sql<{ e: boolean }>`
                SELECT EXISTS(
                  SELECT 1 FROM ${sql.raw(spec.itemTable)}
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
            WHERE owner_type=${spec.itemTable}
              AND owner_id IN (
                SELECT id FROM ${sql.raw(spec.itemTable)}
                WHERE return_id=${String(item.id)}::uuid
              )
          `.execute(trx)
        },
      },
      // 审核/作废转移（D7 收尾）：外壳内核承担，领域效果进 effect
      workflow: {
        mutableMessage: `仅草稿${spec.label}可编辑`,
        transitions: [
          {
            key: 'audit',
            label: '审核',
            from: ['DRAFT'],
            to: 'AUDITED',
            guardMessage: `仅草稿${spec.label}可审核`,
            stamps: ({ permit }: { permit: Permit }) => auditStamp(permit),
            effect: async (trx: TrxHandle, { before }: TransitionContext) =>
              effectAuditHead(trx, engines, spec, headFromWire(before)),
          },
          {
            key: 'void',
            label: '作废',
            from: ['AUDITED'],
            to: 'VOIDED',
            guardMessage: `仅已审核${spec.label}可作废`,
            effect: async (trx: TrxHandle, { before }: TransitionContext) => {
              await effectVoidHead(trx, engines, spec, headFromWire(before))
            },
          },
        ],
      },
    })

    const items = createStandardChildService({
      db,
      registry,
      resource: spec.itemResource,
      notFound: `${spec.itemLabel}不存在`,
      defaultOrder: sql`"idx" ASC, "id" ASC`,
      writeErrors: RETURN_WRITE_ERRORS,
      recordLabel: (item) => String(item.idx),
      derivedFields: [...itemDerived(spec)],
      projection: {
        source: ITEM_SOURCE[side],
        alias: ITEM_ALIAS,
        selectExtra: spec.monetary
          ? sql`return_no, return_date, return_status, party_type, remaining_reconcilable_qty`
          : sql`return_no, return_date, return_status, party_type`,
        mapExtra: mapReturnItemExtras,
      },
      parent: {
        resource: spec.headResource,
        fkField: 'returnId',
        notFound: `${spec.label}不存在`,
        inheritFields: ['companyId'],
        gate: (parent: Record<string, unknown>) => {
          if (String(parent.status) !== 'DRAFT') {
            throw new ApiError('conflict', `仅草稿${spec.label}可编辑`)
          }
        },
      },
      hooks: {
        validate: ({ draft }: { draft: Record<string, unknown> }) => {
          const qty = draft.qty
          if (qty === undefined || qty === null || qty === '') {
            throw ApiError.validation(`${spec.itemLabel}参数不合法`, { qty: ['必填'] })
          }
          if (!decimal(String(qty)).gt(0)) {
            throw ApiError.validation(`${spec.itemLabel}参数不合法`, { qty: ['必须大于 0'] })
          }
          if (draft[sourceKey]) {
            // 源单行：锚点以外的物料/价税一律由来源快照覆盖，手填忽略
          } else {
            // 手工行：物料必填；价税仅金额单（单价可为 0——零金额跳过总账）
            if (!draft.materialId) {
              throw ApiError.validation(`${spec.itemLabel}参数不合法`, {
                materialId: ['必填'],
              })
            }
          }
          if (!draft[sourceKey] && spec.monetary) {
            if (draft.orderPrice == null || draft.orderPrice === '') {
              throw ApiError.validation(`${spec.itemLabel}参数不合法`, {
                orderPrice: ['必填'],
              })
            }
            if (decimal(String(draft.orderPrice)).lt(0)) {
              throw ApiError.validation(`${spec.itemLabel}参数不合法`, {
                orderPrice: ['不能小于 0'],
              })
            }
            if (draft.orderTaxRate == null || draft.orderTaxRate === '') {
              throw ApiError.validation(`${spec.itemLabel}参数不合法`, {
                orderTaxRate: ['必填'],
              })
            }
            if (decimal(String(draft.orderTaxRate)).lt(0)) {
              throw ApiError.validation(`${spec.itemLabel}参数不合法`, {
                orderTaxRate: ['不能小于 0'],
              })
            }
          }
          if (draft.remarks != null && runeLen(String(draft.remarks)) > 512) {
            throw ApiError.validation(`${spec.itemLabel}参数不合法`, {
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
            spec,
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
              sourceItemId:
                draft[sourceKey] == null || draft[sourceKey] === ''
                  ? null
                  : String(draft[sourceKey]),
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
          draft[sourceKey] = derived.sourceItemId
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
            spec.itemTable,
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
            WHERE owner_type=${spec.itemTable} AND owner_id=${String(item.id)}::uuid
          `.execute(trx)
        },
      },
    })

    const aggregate = createAggregateService({
      db,
      registry,
      head: heads,
      validationMessage: `${spec.draftLabel}草稿参数不合法`,
      children: [{ key: 'items', service: items }],
    })

    const contractAggregate = withAggregateWireAdapter(aggregate, {
      toPayload: (input) => returnDraftPayload(side, input as unknown as ReturnDraftInput),
      present: (draft) => presentReturnDraft(draft) as unknown as Record<string, unknown>,
    })

    return { spec, heads, items, aggregate, contractAggregate }
  }

  const sides: Record<ReturnKind, SideCtx> = {
    sales: buildSide('sales'),
    purchase: buildSide('purchase'),
    outsourced: buildSide('outsourced'),
  }

  const listMapped = <T,>(
    r: { count: number; results: readonly unknown[] },
    present: (row: Record<string, unknown>) => T,
  ) => ({ count: r.count, results: r.results.map((row) => present(row as Record<string, unknown>)) })

  return {
    getDraft: async (p: Permit, side: ReturnKind, id: string): Promise<ReturnDraftDto> =>
      presentReturnDraft(await sides[side].aggregate.loadDraft(p, id)),
    createDraft: async (p: Permit, side: ReturnKind, input: ReturnDraftInput): Promise<ReturnDraftDto> =>
      presentReturnDraft(await sides[side].aggregate.createDraft(p, returnDraftPayload(side, input))),
    replaceDraft: async (
      p: Permit,
      side: ReturnKind,
      id: string,
      input: ReturnDraftInput,
    ): Promise<ReturnDraftDto> =>
      presentReturnDraft(
        await sides[side].aggregate.replaceDraft(p, id, returnDraftPayload(side, input)),
      ),
    listHeads: async (p: Permit, side: ReturnKind, q: Partial<ListQuery>) =>
      listMapped(await sides[side].heads.list(p, q), presentReturnHead),
    getHead: async (p: Permit, side: ReturnKind, id: string) =>
      presentReturnHead((await sides[side].heads.get(p, id)) as Record<string, unknown>),
    deleteHead: (p: Permit, side: ReturnKind, id: string) => sides[side].heads.remove(p, id),
    auditHead: async (p: Permit, side: ReturnKind, id: string) =>
      presentReturnHead(
        (await sides[side].heads.transition(p, id, 'audit')) as Record<string, unknown>,
      ),
    voidHead: async (p: Permit, side: ReturnKind, id: string) =>
      presentReturnHead(
        (await sides[side].heads.transition(p, id, 'void')) as Record<string, unknown>,
      ),
    generateReplenishment: (p: Permit, id: string) =>
      runGenerateReplenishment(db, p, id, { headTargets, numberer }),
    listItems: async (p: Permit, side: ReturnKind, q: Partial<ListQuery>) =>
      listMapped(await sides[side].items.list(p, q), presentReturnItem),
    getItem: async (p: Permit, side: ReturnKind, id: string) =>
      presentReturnItem((await sides[side].items.get(p, id)) as Record<string, unknown>),
    _aggregateForContract: (side: ReturnKind): AggregateService => sides[side].contractAggregate,
  }
}

export type ReturnsService = ReturnType<typeof createReturnsService>
