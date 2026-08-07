/**
 * 委外发料 / 委外入库。
 *
 * W4 聚合迁移：头/子行/孙级与整单草稿由 platform/standard 派生——
 * createStandardService + createStandardChildService + createAggregateService；
 * audit/void → workflow（D7），effect 内联原 skeleton 库存/履约编排。
 * 三向收料与 carryReceiptChildren 留钩子；路由手写 URL/DTO 冻结。
 */
import type { ListQuery } from '@synie/shared'
import { decimal } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { DB as Database } from '~/db/types.ts'
import type { GlEngine } from '~/engines/gl/index.ts'
import type { InventoryEngine } from '~/engines/inventory/index.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import { createAggregateService, type AggregateService } from '~/platform/standard/aggregate.ts'
import {
  createStandardChildService,
  type StandardChildService,
} from '~/platform/standard/child.ts'
import {
  auditStamp,
  createStandardService,
  type StandardService,
} from '~/platform/standard/service.ts'
import { lowerParty, runeLen, toDateOnly, wireRequiredDecimal } from '../common.ts'
import { utcToday } from '~/db/dates.ts'
import {
  assertDraftReceipt,
  BYPRODUCT_ALIAS,
  BYPRODUCT_LABEL,
  BYPRODUCT_SOURCE,
  carryReceiptChildren,
  CHILD_LINE_DERIVED,
  CHILD_ORDER,
  deriveIssueItem,
  deriveReceiptByproduct,
  deriveReceiptItem,
  deriveReceiptMaterial,
  HEAD_ORDER,
  ISSUE_ITEM_ALIAS,
  ISSUE_ITEM_DERIVED,
  ISSUE_ITEM_LABEL,
  ISSUE_ITEM_SOURCE,
  ISSUE_LABEL,
  mapByproductExtras,
  mapIssueItemExtras,
  mapMaterialExtras,
  mapReceiptItemExtras,
  MATERIAL_ALIAS,
  MATERIAL_LABEL,
  MATERIAL_SOURCE,
  RECEIPT_ITEM_ALIAS,
  RECEIPT_ITEM_DERIVED,
  RECEIPT_ITEM_LABEL,
  RECEIPT_ITEM_SOURCE,
  RECEIPT_LABEL,
  resolveReceiptAccounts,
  type IssueHead,
  type IssueItem,
  type ReceiptByproduct,
  type ReceiptHead,
  type ReceiptItem,
  type ReceiptMaterial,
  validateHeadParty,
  validateIssueHead,
  validateReceiptHead,
  WRITE_ERRORS,
} from './domain.ts'
import {
  outsourcedIssueItemMeta,
  outsourcedIssueMeta,
  outsourcedReceiptItemByproductMeta,
  outsourcedReceiptItemMaterialMeta,
  outsourcedReceiptItemMeta,
  outsourcedReceiptMeta,
} from './meta.ts'
import {
  effectAuditIssue,
  effectAuditReceipt,
  effectVoidIssue,
  effectVoidReceipt,
} from './workflow.ts'

export {
  outsourcedIssueMeta,
  outsourcedIssueItemMeta,
  outsourcedReceiptMeta,
  outsourcedReceiptItemMeta,
  outsourcedReceiptItemMaterialMeta,
  outsourcedReceiptItemByproductMeta,
} from './meta.ts'

export const ISSUE_RESOURCE = 'purOutsourcedIssues'
export const ISSUE_ITEM_RESOURCE = 'purOutsourcedIssueItems'
export const RECEIPT_RESOURCE = 'purOutsourcedReceipts'
export const RECEIPT_ITEM_RESOURCE = 'purOutsourcedReceiptItems'
export const RECEIPT_MATERIAL_RESOURCE = 'purOutsourcedReceiptItemMaterials'
export const RECEIPT_BYPRODUCT_RESOURCE = 'purOutsourcedReceiptItemByproducts'

type Numberer = Pick<NumberingService, 'nextInTx'>

function draftGate(label: string) {
  return (parent: Record<string, unknown>) => {
    if (String(parent.status) !== 'DRAFT') {
      throw new ApiError('conflict', `仅草稿${label}可编辑`)
    }
  }
}

function applyDerived(draft: Record<string, unknown>, derived: Record<string, unknown>) {
  for (const [k, v] of Object.entries(derived)) {
    if (v === undefined) continue
    if (typeof v === 'object' && v !== null && 'toFixed' in v) {
      draft[k] = wireRequiredDecimal(v as never)
    } else {
      draft[k] = v
    }
  }
}

export function createOutsourcedService(
  db: Kysely<Database>,
  numberer: Numberer,
  engines: {
    inventory: Pick<InventoryEngine, 'post' | 'cancel'>
    gl: Pick<GlEngine, 'post' | 'cancel'>
  },
  registry: Registry,
) {
  const { inventory, gl } = engines

  // ---------- 发料头 ----------
  const issueHeads = createStandardService<IssueHead>({
    db,
    registry,
    resource: ISSUE_RESOURCE,
    notFound: `${ISSUE_LABEL}不存在`,
    defaultOrder: HEAD_ORDER,
    writeErrors: [...WRITE_ERRORS],
    numbering: { service: numberer, field: 'issueNo' },
    hooks: {
      insertColumns: ({ permit }) => ({
        status: 'draft',
        created_by_id: permit.actor.userId || null,
      }),
      validate: ({ action, draft, before }) => {
        if (action === 'create') {
          validateHeadParty(
            String(draft.companyId ?? ''),
            String(draft.partyType ?? ''),
            String(draft.partyId ?? ''),
            draft.remarks == null ? null : String(draft.remarks),
          )
        }
        if (
          action === 'update' &&
          before &&
          draft.issueNo !== undefined &&
          String(draft.issueNo).trim() !== String(before.issueNo)
        ) {
          throw ApiError.validation(`${ISSUE_LABEL}参数不合法`, {
            issueNo: ['编号创建后不可修改'],
          })
        }
      },
      beforeWrite: async (trx, { action, draft, before }) => {
        if (action === 'create') {
          if (!draft.issueDate) draft.issueDate = utcToday()
          else draft.issueDate = toDateOnly(String(draft.issueDate))
        } else if (draft.issueDate != null) {
          draft.issueDate = toDateOnly(String(draft.issueDate))
        }
        if (draft.partyType != null) draft.partyType = lowerParty(String(draft.partyType))
        const companyId = String(draft.companyId ?? before?.companyId ?? '')
        // create 时编号在 beforeWrite 之后由内核 nextInTx 写入，校验用占位通过形态检查
        const issueNo =
          action === 'create'
            ? String(draft.issueNo ?? 'AUTO')
            : String(draft.issueNo ?? before?.issueNo ?? '')
        const issueDate = String(draft.issueDate ?? before?.issueDate ?? '')
        await validateIssueHead(trx, {
          issueNo,
          issueDate,
          partyType: String(draft.partyType ?? before?.partyType ?? ''),
          partyId: String(draft.partyId ?? before?.partyId ?? ''),
          remarks: draft.remarks === undefined ? (before?.remarks as string | null) ?? null : (draft.remarks as string | null),
          companyId,
          fromWarehouseId:
            draft.fromWarehouseId === undefined
              ? ((before?.fromWarehouseId as string | null) ?? null)
              : draft.fromWarehouseId
                ? String(draft.fromWarehouseId)
                : null,
          outsourcedWarehouseId:
            draft.outsourcedWarehouseId === undefined
              ? ((before?.outsourcedWarehouseId as string | null) ?? null)
              : draft.outsourcedWarehouseId
                ? String(draft.outsourcedWarehouseId)
                : null,
        })
      },
    },
    workflow: {
      mutableMessage: `仅草稿${ISSUE_LABEL}可编辑`,
      transitions: [
        {
          key: 'audit',
          label: '审核',
          from: ['DRAFT'],
          to: 'AUDITED',
          guardMessage: `仅草稿${ISSUE_LABEL}可编辑`,
          stamps: ({ permit }) => auditStamp(permit),
          effect: async (trx, { before }) => {
            await effectAuditIssue(trx, inventory, before as IssueHead)
          },
        },
        {
          key: 'void',
          label: '作废',
          from: ['AUDITED'],
          to: 'VOIDED',
          guardMessage: `仅已审核${ISSUE_LABEL}可作废`,
          effect: async (trx, { before }) => {
            await effectVoidIssue(trx, inventory, before as IssueHead)
          },
        },
      ],
    },
  })

  const issueItems = createStandardChildService<IssueItem>({
    db,
    registry,
    resource: ISSUE_ITEM_RESOURCE,
    notFound: `${ISSUE_ITEM_LABEL}不存在`,
    defaultOrder: CHILD_ORDER,
    writeErrors: [...WRITE_ERRORS],
    recordLabel: (item) => String(item.idx),
    derivedFields: [...ISSUE_ITEM_DERIVED],
    projection: {
      source: ISSUE_ITEM_SOURCE,
      alias: ISSUE_ITEM_ALIAS,
      selectExtra: sql`issue_no, issue_date, issue_status, party_type, party_id`,
      mapExtra: mapIssueItemExtras,
    },
    parent: {
      resource: ISSUE_RESOURCE,
      fkField: 'issueId',
      notFound: `${ISSUE_LABEL}不存在`,
      inheritFields: ['companyId'],
      gate: draftGate(ISSUE_LABEL),
    },
    hooks: {
      validate: ({ draft }) => {
        if (draft.qty === undefined || draft.qty === null || draft.qty === '') {
          throw ApiError.validation(`${ISSUE_ITEM_LABEL}参数不合法`, { qty: ['必填'] })
        }
        if (!decimal(String(draft.qty)).gt(0)) {
          throw ApiError.validation(`${ISSUE_ITEM_LABEL}参数不合法`, { qty: ['必须大于 0'] })
        }
        if (!draft.orderItemMaterialId) {
          throw ApiError.validation(`${ISSUE_ITEM_LABEL}参数不合法`, {
            orderItemMaterialId: ['必填'],
          })
        }
        if (draft.remarks != null && runeLen(String(draft.remarks)) > 512) {
          throw ApiError.validation(`${ISSUE_ITEM_LABEL}参数不合法`, {
            remarks: ['最多 512 个字符'],
          })
        }
      },
      beforeWrite: async (trx, { draft, parent }) => {
        const fromWarehouseId =
          draft.fromWarehouseId == null || draft.fromWarehouseId === ''
            ? (parent.fromWarehouseId as string | null)
            : String(draft.fromWarehouseId)
        const outsourcedWarehouseId =
          draft.outsourcedWarehouseId == null || draft.outsourcedWarehouseId === ''
            ? (parent.outsourcedWarehouseId as string | null)
            : String(draft.outsourcedWarehouseId)
        const derived = await deriveIssueItem(
          trx,
          {
            companyId: String(parent.companyId),
            partyType: String(parent.partyType),
            partyId: String(parent.partyId),
          },
          {
            orderItemMaterialId: String(draft.orderItemMaterialId),
            qty: decimal(String(draft.qty)),
            fromWarehouseId,
            outsourcedWarehouseId,
            remarks: draft.remarks == null ? null : String(draft.remarks),
          },
        )
        draft.fromWarehouseId = derived.fromWarehouseId
        draft.outsourcedWarehouseId = derived.outsourcedWarehouseId
        draft.remarks = derived.remarks
        draft.qty = wireRequiredDecimal(derived.qty)
        applyDerived(draft, {
          baseQty: derived.baseQty,
          materialId: derived.materialId,
          unitId: derived.unitId,
          materialCode: derived.materialCode,
          materialName: derived.materialName,
          materialSpec: derived.materialSpec,
          unitName: derived.unitName,
          orderNo: derived.orderNo,
        })
      },
    },
  })

  // ---------- 入库头 ----------
  const receiptHeads = createStandardService<ReceiptHead>({
    db,
    registry,
    resource: RECEIPT_RESOURCE,
    notFound: `${RECEIPT_LABEL}不存在`,
    defaultOrder: HEAD_ORDER,
    writeErrors: [...WRITE_ERRORS],
    numbering: { service: numberer, field: 'receiptNo' },
    hooks: {
      insertColumns: ({ permit }) => ({
        status: 'draft',
        created_by_id: permit.actor.userId || null,
      }),
      validate: ({ action, draft, before }) => {
        if (action === 'create') {
          validateHeadParty(
            String(draft.companyId ?? ''),
            String(draft.partyType ?? ''),
            String(draft.partyId ?? ''),
            draft.remarks == null ? null : String(draft.remarks),
          )
        }
        if (
          action === 'update' &&
          before &&
          draft.receiptNo !== undefined &&
          String(draft.receiptNo).trim() !== String(before.receiptNo)
        ) {
          throw ApiError.validation(`${RECEIPT_LABEL}参数不合法`, {
            receiptNo: ['编号创建后不可修改'],
          })
        }
      },
      beforeWrite: async (trx, { action, draft, before }) => {
        if (action === 'create') {
          if (!draft.receiptDate) draft.receiptDate = utcToday()
          else draft.receiptDate = toDateOnly(String(draft.receiptDate))
        } else if (draft.receiptDate != null) {
          draft.receiptDate = toDateOnly(String(draft.receiptDate))
        }
        if (draft.postingDate != null && draft.postingDate !== '') {
          draft.postingDate = toDateOnly(String(draft.postingDate))
        } else if (draft.postingDate === '') {
          draft.postingDate = null
        }
        if (draft.partyType != null) draft.partyType = lowerParty(String(draft.partyType))
        const companyId = String(draft.companyId ?? before?.companyId ?? '')
        if (action === 'create') {
          const { debit, credit } = await resolveReceiptAccounts(
            trx,
            companyId,
            draft.debitAccountId ? String(draft.debitAccountId) : null,
            draft.creditAccountId ? String(draft.creditAccountId) : null,
          )
          draft.debitAccountId = debit
          draft.creditAccountId = credit
        }
        await validateReceiptHead(trx, {
          receiptNo:
            action === 'create'
              ? String(draft.receiptNo ?? 'AUTO')
              : String(draft.receiptNo ?? before?.receiptNo ?? ''),
          receiptDate: String(draft.receiptDate ?? before?.receiptDate ?? ''),
          partyType: String(draft.partyType ?? before?.partyType ?? ''),
          partyId: String(draft.partyId ?? before?.partyId ?? ''),
          remarks:
            draft.remarks === undefined
              ? ((before?.remarks as string | null) ?? null)
              : (draft.remarks as string | null),
          companyId,
          warehouseId:
            draft.warehouseId === undefined
              ? ((before?.warehouseId as string | null) ?? null)
              : draft.warehouseId
                ? String(draft.warehouseId)
                : null,
          outsourcedWarehouseId:
            draft.outsourcedWarehouseId === undefined
              ? ((before?.outsourcedWarehouseId as string | null) ?? null)
              : draft.outsourcedWarehouseId
                ? String(draft.outsourcedWarehouseId)
                : null,
          debitAccountId: String(draft.debitAccountId ?? before?.debitAccountId ?? ''),
          creditAccountId: String(draft.creditAccountId ?? before?.creditAccountId ?? ''),
        })
      },
    },
    workflow: {
      mutableMessage: `仅草稿${RECEIPT_LABEL}可编辑`,
      transitions: [
        {
          key: 'audit',
          label: '审核',
          from: ['DRAFT'],
          to: 'AUDITED',
          guardMessage: `仅草稿${RECEIPT_LABEL}可编辑`,
          stamps: ({ permit }) => auditStamp(permit),
          effect: async (trx, { before, input }) => {
            const override =
              input.postingDate === undefined
                ? undefined
                : input.postingDate === null
                  ? null
                  : String(input.postingDate)
            return effectAuditReceipt(
              trx,
              { inventory, gl },
              before as ReceiptHead,
              override,
            )
          },
        },
        {
          key: 'void',
          label: '作废',
          from: ['AUDITED'],
          to: 'VOIDED',
          guardMessage: `仅已审核${RECEIPT_LABEL}可作废`,
          effect: async (trx, { before }) => {
            await effectVoidReceipt(trx, { inventory, gl }, before as ReceiptHead)
          },
        },
      ],
    },
  })

  // materials / byproducts 先于 items 声明，供 carry afterWrite 闭包引用
  let receiptMaterials: StandardChildService<ReceiptMaterial>
  let receiptByproducts: StandardChildService<ReceiptByproduct>

  const receiptItems = createStandardChildService<ReceiptItem>({
    db,
    registry,
    resource: RECEIPT_ITEM_RESOURCE,
    notFound: `${RECEIPT_ITEM_LABEL}不存在`,
    defaultOrder: CHILD_ORDER,
    writeErrors: [...WRITE_ERRORS],
    recordLabel: (item) => String(item.idx),
    derivedFields: [...RECEIPT_ITEM_DERIVED],
    projection: {
      source: RECEIPT_ITEM_SOURCE,
      alias: RECEIPT_ITEM_ALIAS,
      selectExtra: sql`receipt_no, receipt_date, receipt_status, party_type, party_id, remaining_reconcilable_qty`,
      mapExtra: mapReceiptItemExtras,
    },
    parent: {
      resource: RECEIPT_RESOURCE,
      fkField: 'receiptId',
      notFound: `${RECEIPT_LABEL}不存在`,
      inheritFields: ['companyId'],
      gate: draftGate(RECEIPT_LABEL),
    },
    hooks: {
      validate: ({ draft }) => {
        if (draft.qty === undefined || draft.qty === null || draft.qty === '') {
          throw ApiError.validation(`${RECEIPT_ITEM_LABEL}参数不合法`, { qty: ['必填'] })
        }
        if (!decimal(String(draft.qty)).gt(0)) {
          throw ApiError.validation(`${RECEIPT_ITEM_LABEL}参数不合法`, { qty: ['必须大于 0'] })
        }
        if (!draft.orderItemId) {
          throw ApiError.validation(`${RECEIPT_ITEM_LABEL}参数不合法`, {
            orderItemId: ['必填'],
          })
        }
        if (draft.remarks != null && runeLen(String(draft.remarks)) > 512) {
          throw ApiError.validation(`${RECEIPT_ITEM_LABEL}参数不合法`, {
            remarks: ['最多 512 个字符'],
          })
        }
      },
      beforeWrite: async (trx, { action, draft, parent, before }) => {
        const warehouseId =
          draft.warehouseId == null || draft.warehouseId === ''
            ? (parent.warehouseId as string | null)
            : String(draft.warehouseId)
        const derived = await deriveReceiptItem(
          trx,
          {
            id: String(parent.id),
            companyId: String(parent.companyId),
            partyType: String(parent.partyType),
            partyId: String(parent.partyId),
          },
          {
            qty: decimal(String(draft.qty)),
            orderItemId: String(draft.orderItemId),
            unitId:
              draft.unitId == null || draft.unitId === '' ? null : String(draft.unitId),
            warehouseId,
            remarks: draft.remarks == null ? null : String(draft.remarks),
          },
          action === 'update' && before ? String(before.id) : null,
        )
        draft.warehouseId = derived.warehouseId
        draft.remarks = derived.remarks
        draft.qty = wireRequiredDecimal(derived.qty)
        if (action === 'create' && draft.reconciledQty === undefined) {
          draft.reconciledQty = '0'
        }
        applyDerived(draft, {
          baseQty: derived.baseQty,
          materialId: derived.materialId,
          unitId: derived.unitId,
          unitName: derived.unitName,
          materialCode: derived.materialCode,
          materialName: derived.materialName,
          materialSpec: derived.materialSpec,
          customerPartNo: derived.customerPartNo,
          orderNo: derived.orderNo,
          orderQty: derived.orderQty,
          orderBaseQty: derived.orderBaseQty,
          orderUnitName: derived.orderUnitName,
          orderPrice: derived.orderPrice,
          orderAmount: derived.orderAmount,
          orderBasePrice: derived.orderBasePrice,
          orderBaseAmount: derived.orderBaseAmount,
          orderTaxRate: derived.orderTaxRate,
          orderCurrencyCode: derived.orderCurrencyCode,
        })
      },
      afterWrite: async (trx, { action, permit, item, parent }) => {
        if (action !== 'create') return
        if (!decimal(String(item.orderBaseQty)).gt(0)) return
        // 已有子行则跳过（聚合草稿若显式提交 materials 时由调用方维护）
        const existing = await sql<{ c: string }>`
          SELECT count(*)::text AS c FROM pur_outsourced_receipt_item_material
          WHERE receipt_item_id=${String(item.id)}::uuid
        `.execute(trx)
        if (Number(existing.rows[0]?.c ?? 0) > 0) return
        const receipt = parent as ReceiptHead
        await carryReceiptChildren(
          trx,
          receipt,
          {
            id: String(item.id),
            orderItemId: String(item.orderItemId),
            baseQty: String(item.baseQty),
            orderBaseQty: String(item.orderBaseQty),
          },
          async (input) => {
            await receiptMaterials.createInTx(trx, permit, input)
          },
          async (input) => {
            await receiptByproducts.createInTx(trx, permit, input)
          },
        )
      },
    },
  })

  receiptMaterials = createStandardChildService<ReceiptMaterial>({
    db,
    registry,
    resource: RECEIPT_MATERIAL_RESOURCE,
    notFound: `${MATERIAL_LABEL}不存在`,
    defaultOrder: CHILD_ORDER,
    writeErrors: [...WRITE_ERRORS],
    recordLabel: (item) => String(item.idx),
    derivedFields: [...CHILD_LINE_DERIVED],
    projection: {
      source: MATERIAL_SOURCE,
      alias: MATERIAL_ALIAS,
      selectExtra: sql`receipt_no`,
      mapExtra: mapMaterialExtras,
    },
    parent: {
      resource: RECEIPT_ITEM_RESOURCE,
      fkField: 'receiptItemId',
      notFound: `${RECEIPT_ITEM_LABEL}不存在`,
      inheritFields: ['companyId'],
    },
    hooks: {
      validate: ({ draft }) => {
        if (draft.qty === undefined || draft.qty === null || draft.qty === '') {
          throw ApiError.validation('委外入库子行参数不合法', { qty: ['必须大于 0'] })
        }
        if (!decimal(String(draft.qty)).gt(0)) {
          throw ApiError.validation('委外入库子行参数不合法', { qty: ['必须大于 0'] })
        }
        if (!draft.orderItemMaterialId) {
          throw ApiError.validation('委外入库子行参数不合法', { sourceId: ['来源清单行必填'] })
        }
      },
      beforeWrite: async (trx, { draft, parent }) => {
        const receipt = await assertDraftReceipt(trx, String(parent.receiptId))
        const outsourcedWarehouseId =
          draft.outsourcedWarehouseId === undefined || draft.outsourcedWarehouseId === ''
            ? receipt.outsourcedWarehouseId
            : draft.outsourcedWarehouseId == null
              ? null
              : String(draft.outsourcedWarehouseId)
        const derived = await deriveReceiptMaterial(
          trx,
          receipt,
          { orderItemId: String(parent.orderItemId) },
          {
            qty: decimal(String(draft.qty)),
            orderItemMaterialId: String(draft.orderItemMaterialId),
            outsourcedWarehouseId,
            remarks: draft.remarks == null ? null : String(draft.remarks),
          },
        )
        draft.outsourcedWarehouseId = derived.outsourcedWarehouseId
        draft.remarks = derived.remarks
        draft.qty = wireRequiredDecimal(derived.qty)
        applyDerived(draft, {
          baseQty: derived.baseQty,
          materialId: derived.materialId,
          unitId: derived.unitId,
          materialCode: derived.materialCode,
          materialName: derived.materialName,
          materialSpec: derived.materialSpec,
          unitName: derived.unitName,
          orderNo: derived.orderNo,
        })
      },
      beforeDelete: async (trx, { parent }) => {
        await assertDraftReceipt(trx, String(parent.receiptId))
      },
    },
  })

  receiptByproducts = createStandardChildService<ReceiptByproduct>({
    db,
    registry,
    resource: RECEIPT_BYPRODUCT_RESOURCE,
    notFound: `${BYPRODUCT_LABEL}不存在`,
    defaultOrder: CHILD_ORDER,
    writeErrors: [...WRITE_ERRORS],
    recordLabel: (item) => String(item.idx),
    derivedFields: [...CHILD_LINE_DERIVED],
    projection: {
      source: BYPRODUCT_SOURCE,
      alias: BYPRODUCT_ALIAS,
      selectExtra: sql`receipt_no`,
      mapExtra: mapByproductExtras,
    },
    parent: {
      resource: RECEIPT_ITEM_RESOURCE,
      fkField: 'receiptItemId',
      notFound: `${RECEIPT_ITEM_LABEL}不存在`,
      inheritFields: ['companyId'],
    },
    hooks: {
      validate: ({ draft }) => {
        if (draft.qty === undefined || draft.qty === null || draft.qty === '') {
          throw ApiError.validation('委外入库子行参数不合法', { qty: ['必须大于 0'] })
        }
        if (!decimal(String(draft.qty)).gt(0)) {
          throw ApiError.validation('委外入库子行参数不合法', { qty: ['必须大于 0'] })
        }
        if (!draft.orderItemByproductId) {
          throw ApiError.validation('委外入库子行参数不合法', { sourceId: ['来源清单行必填'] })
        }
      },
      beforeWrite: async (trx, { draft, parent }) => {
        const receipt = await assertDraftReceipt(trx, String(parent.receiptId))
        const warehouseId =
          draft.warehouseId === undefined || draft.warehouseId === ''
            ? receipt.warehouseId
            : draft.warehouseId == null
              ? null
              : String(draft.warehouseId)
        const derived = await deriveReceiptByproduct(
          trx,
          receipt,
          { orderItemId: String(parent.orderItemId) },
          {
            qty: decimal(String(draft.qty)),
            orderItemByproductId: String(draft.orderItemByproductId),
            warehouseId,
            remarks: draft.remarks == null ? null : String(draft.remarks),
          },
        )
        draft.warehouseId = derived.warehouseId
        draft.remarks = derived.remarks
        draft.qty = wireRequiredDecimal(derived.qty)
        applyDerived(draft, {
          baseQty: derived.baseQty,
          materialId: derived.materialId,
          unitId: derived.unitId,
          materialCode: derived.materialCode,
          materialName: derived.materialName,
          materialSpec: derived.materialSpec,
          unitName: derived.unitName,
          orderNo: derived.orderNo,
        })
      },
      beforeDelete: async (trx, { parent }) => {
        await assertDraftReceipt(trx, String(parent.receiptId))
      },
    },
  })

  const issueAggregate = createAggregateService({
    db,
    registry,
    head: issueHeads,
    validationMessage: '委外发料草稿参数不合法',
    children: [{ key: 'items', service: issueItems }],
  })

  // 聚合树只挂成品行：材料/副产物由 create 钩子 carry 比例带出，独立 child CRUD 维护；
  // 不进草稿嵌套，避免空数组快照抹掉 carry 结果。
  const receiptAggregate = createAggregateService({
    db,
    registry,
    head: receiptHeads,
    validationMessage: '委外入库草稿参数不合法',
    children: [{ key: 'items', service: receiptItems }],
  })

  // ---------- 公开 API（wire 冻结；薄包装） ----------
  return {
    listIssues: (p: Permit, q: Partial<ListQuery>) => issueHeads.list(p, q),
    getIssue: (p: Permit, id: string) => issueHeads.get(p, id),
    createIssue: async (
      p: Permit,
      input: {
        companyId: string
        issueNo?: string | null
        issueDate?: string | null
        partyType: string
        partyId: string
        remarks?: string | null
        fromWarehouseId?: string | null
        outsourcedWarehouseId?: string | null
      },
    ) => {
      const payload: Record<string, unknown> = {
        companyId: input.companyId,
        partyType: input.partyType,
        partyId: input.partyId,
        remarks: input.remarks ?? null,
        fromWarehouseId: input.fromWarehouseId ?? null,
        outsourcedWarehouseId: input.outsourcedWarehouseId ?? null,
      }
      if (input.issueDate != null) payload.issueDate = input.issueDate
      // 编号系统生成：非空拒收
      if (input.issueNo != null && String(input.issueNo).trim() !== '') {
        payload.issueNo = input.issueNo
      }
      return issueHeads.create(p, payload)
    },
    updateIssue: async (
      p: Permit,
      id: string,
      input: {
        issueNo?: string
        issueDate?: string
        partyType?: string
        partyId?: string
        remarks?: string | null
        remarksPresent?: boolean
        fromWarehouseId?: string | null
        fromWarehouseIdPresent?: boolean
        outsourcedWarehouseId?: string | null
        outsourcedWarehouseIdPresent?: boolean
      },
    ) => {
      const patch: Record<string, unknown> = {}
      if (input.issueNo !== undefined) patch.issueNo = input.issueNo
      if (input.issueDate !== undefined) patch.issueDate = input.issueDate
      if (input.partyType !== undefined) patch.partyType = input.partyType
      if (input.partyId !== undefined) patch.partyId = input.partyId
      if (input.remarksPresent) patch.remarks = input.remarks ?? null
      if (input.fromWarehouseIdPresent) patch.fromWarehouseId = input.fromWarehouseId ?? null
      if (input.outsourcedWarehouseIdPresent) {
        patch.outsourcedWarehouseId = input.outsourcedWarehouseId ?? null
      }
      return issueHeads.update(p, id, patch)
    },
    deleteIssue: (p: Permit, id: string) => issueHeads.remove(p, id),
    auditIssue: (p: Permit, id: string) => issueHeads.transition(p, id, 'audit'),
    voidIssue: (p: Permit, id: string) => issueHeads.transition(p, id, 'void'),

    listIssueItems: (p: Permit, q: Partial<ListQuery>) => issueItems.list(p, q),
    getIssueItem: (p: Permit, id: string) => issueItems.get(p, id),
    createIssueItem: (
      p: Permit,
      input: {
        issueId: string
        idx: number
        qty: string
        orderItemMaterialId: string
        fromWarehouseId?: string | null
        outsourcedWarehouseId?: string | null
        remarks?: string | null
      },
    ) =>
      issueItems.create(p, {
        issueId: input.issueId,
        idx: input.idx,
        qty: input.qty,
        orderItemMaterialId: input.orderItemMaterialId,
        fromWarehouseId: input.fromWarehouseId ?? null,
        outsourcedWarehouseId: input.outsourcedWarehouseId ?? null,
        remarks: input.remarks ?? null,
      }),
    updateIssueItem: (
      p: Permit,
      id: string,
      input: {
        idx?: number
        qty?: string
        orderItemMaterialId?: string
        fromWarehouseId?: string
        outsourcedWarehouseId?: string
        remarks?: string | null
        remarksPresent?: boolean
      },
    ) => {
      const patch: Record<string, unknown> = {}
      if (input.idx !== undefined) patch.idx = input.idx
      if (input.qty !== undefined) patch.qty = input.qty
      if (input.orderItemMaterialId !== undefined) {
        patch.orderItemMaterialId = input.orderItemMaterialId
      }
      if (input.fromWarehouseId !== undefined) patch.fromWarehouseId = input.fromWarehouseId
      if (input.outsourcedWarehouseId !== undefined) {
        patch.outsourcedWarehouseId = input.outsourcedWarehouseId
      }
      if (input.remarksPresent) patch.remarks = input.remarks ?? null
      return issueItems.update(p, id, patch)
    },
    deleteIssueItem: (p: Permit, id: string) => issueItems.remove(p, id),

    listReceipts: (p: Permit, q: Partial<ListQuery>) => receiptHeads.list(p, q),
    getReceipt: (p: Permit, id: string) => receiptHeads.get(p, id),
    createReceipt: async (
      p: Permit,
      input: {
        companyId: string
        receiptNo?: string | null
        receiptDate?: string | null
        postingDate?: string | null
        partyType: string
        partyId: string
        remarks?: string | null
        warehouseId?: string | null
        outsourcedWarehouseId?: string | null
        debitAccountId?: string | null
        creditAccountId?: string | null
      },
    ) => {
      const payload: Record<string, unknown> = {
        companyId: input.companyId,
        partyType: input.partyType,
        partyId: input.partyId,
        remarks: input.remarks ?? null,
        warehouseId: input.warehouseId ?? null,
        outsourcedWarehouseId: input.outsourcedWarehouseId ?? null,
        postingDate: input.postingDate ?? null,
      }
      if (input.receiptDate != null) payload.receiptDate = input.receiptDate
      if (input.debitAccountId != null) payload.debitAccountId = input.debitAccountId
      if (input.creditAccountId != null) payload.creditAccountId = input.creditAccountId
      if (input.receiptNo != null && String(input.receiptNo).trim() !== '') {
        payload.receiptNo = input.receiptNo
      }
      return receiptHeads.create(p, payload)
    },
    updateReceipt: (
      p: Permit,
      id: string,
      input: {
        receiptNo?: string
        receiptDate?: string
        postingDate?: string | null
        postingDatePresent?: boolean
        partyType?: string
        partyId?: string
        remarks?: string | null
        remarksPresent?: boolean
        warehouseId?: string | null
        warehouseIdPresent?: boolean
        outsourcedWarehouseId?: string | null
        outsourcedWarehouseIdPresent?: boolean
        debitAccountId?: string
        creditAccountId?: string
      },
    ) => {
      const patch: Record<string, unknown> = {}
      if (input.receiptNo !== undefined) patch.receiptNo = input.receiptNo
      if (input.receiptDate !== undefined) patch.receiptDate = input.receiptDate
      if (input.postingDatePresent) patch.postingDate = input.postingDate ?? null
      if (input.partyType !== undefined) patch.partyType = input.partyType
      if (input.partyId !== undefined) patch.partyId = input.partyId
      if (input.remarksPresent) patch.remarks = input.remarks ?? null
      if (input.warehouseIdPresent) patch.warehouseId = input.warehouseId ?? null
      if (input.outsourcedWarehouseIdPresent) {
        patch.outsourcedWarehouseId = input.outsourcedWarehouseId ?? null
      }
      if (input.debitAccountId !== undefined) patch.debitAccountId = input.debitAccountId
      if (input.creditAccountId !== undefined) patch.creditAccountId = input.creditAccountId
      return receiptHeads.update(p, id, patch)
    },
    deleteReceipt: (p: Permit, id: string) => receiptHeads.remove(p, id),
    auditReceipt: (
      p: Permit,
      id: string,
      input: { postingDate?: string | null } = {},
    ) =>
      receiptHeads.transition(p, id, 'audit', {
        postingDate: input.postingDate,
      }),
    voidReceipt: (p: Permit, id: string) => receiptHeads.transition(p, id, 'void'),

    listReceiptItems: (p: Permit, q: Partial<ListQuery>) => receiptItems.list(p, q),
    getReceiptItem: (p: Permit, id: string) => receiptItems.get(p, id),
    createReceiptItem: (
      p: Permit,
      input: {
        receiptId: string
        idx: number
        qty: string
        orderItemId: string
        unitId?: string | null
        warehouseId?: string | null
        remarks?: string | null
      },
    ) =>
      receiptItems.create(p, {
        receiptId: input.receiptId,
        idx: input.idx,
        qty: input.qty,
        orderItemId: input.orderItemId,
        unitId: input.unitId ?? null,
        warehouseId: input.warehouseId ?? null,
        remarks: input.remarks ?? null,
      }),
    updateReceiptItem: (
      p: Permit,
      id: string,
      input: {
        idx?: number
        qty?: string
        orderItemId?: string
        unitId?: string | null
        unitIdPresent?: boolean
        warehouseId?: string | null
        warehouseIdPresent?: boolean
        remarks?: string | null
        remarksPresent?: boolean
      },
    ) => {
      const patch: Record<string, unknown> = {}
      if (input.idx !== undefined) patch.idx = input.idx
      if (input.qty !== undefined) patch.qty = input.qty
      if (input.orderItemId !== undefined) patch.orderItemId = input.orderItemId
      if (input.unitIdPresent) patch.unitId = input.unitId ?? null
      if (input.warehouseIdPresent) patch.warehouseId = input.warehouseId ?? null
      if (input.remarksPresent) patch.remarks = input.remarks ?? null
      return receiptItems.update(p, id, patch)
    },
    deleteReceiptItem: (p: Permit, id: string) => receiptItems.remove(p, id),

    listReceiptMaterials: (p: Permit, q: Partial<ListQuery>) => receiptMaterials.list(p, q),
    getReceiptMaterial: (p: Permit, id: string) => receiptMaterials.get(p, id),
    createReceiptMaterial: (
      p: Permit,
      input: {
        receiptItemId: string
        idx: number
        qty: string
        orderItemMaterialId: string
        outsourcedWarehouseId?: string | null
        remarks?: string | null
      },
    ) =>
      receiptMaterials.create(p, {
        receiptItemId: input.receiptItemId,
        idx: input.idx,
        qty: input.qty,
        orderItemMaterialId: input.orderItemMaterialId,
        outsourcedWarehouseId: input.outsourcedWarehouseId ?? null,
        remarks: input.remarks ?? null,
      }),
    updateReceiptMaterial: (
      p: Permit,
      id: string,
      input: {
        idx?: number
        qty?: string
        orderItemMaterialId?: string
        outsourcedWarehouseId?: string | null
        outsourcedWarehouseIdPresent?: boolean
        remarks?: string | null
        remarksPresent?: boolean
      },
    ) => {
      const patch: Record<string, unknown> = {}
      if (input.idx !== undefined) patch.idx = input.idx
      if (input.qty !== undefined) patch.qty = input.qty
      if (input.orderItemMaterialId !== undefined) {
        patch.orderItemMaterialId = input.orderItemMaterialId
      }
      if (input.outsourcedWarehouseIdPresent) {
        patch.outsourcedWarehouseId = input.outsourcedWarehouseId ?? null
      }
      if (input.remarksPresent) patch.remarks = input.remarks ?? null
      return receiptMaterials.update(p, id, patch)
    },
    deleteReceiptMaterial: (p: Permit, id: string) => receiptMaterials.remove(p, id),

    listReceiptByproducts: (p: Permit, q: Partial<ListQuery>) => receiptByproducts.list(p, q),
    getReceiptByproduct: (p: Permit, id: string) => receiptByproducts.get(p, id),
    createReceiptByproduct: (
      p: Permit,
      input: {
        receiptItemId: string
        idx: number
        qty: string
        orderItemByproductId: string
        warehouseId?: string | null
        remarks?: string | null
      },
    ) =>
      receiptByproducts.create(p, {
        receiptItemId: input.receiptItemId,
        idx: input.idx,
        qty: input.qty,
        orderItemByproductId: input.orderItemByproductId,
        warehouseId: input.warehouseId ?? null,
        remarks: input.remarks ?? null,
      }),
    updateReceiptByproduct: (
      p: Permit,
      id: string,
      input: {
        idx?: number
        qty?: string
        orderItemByproductId?: string
        warehouseId?: string | null
        warehouseIdPresent?: boolean
        remarks?: string | null
        remarksPresent?: boolean
      },
    ) => {
      const patch: Record<string, unknown> = {}
      if (input.idx !== undefined) patch.idx = input.idx
      if (input.qty !== undefined) patch.qty = input.qty
      if (input.orderItemByproductId !== undefined) {
        patch.orderItemByproductId = input.orderItemByproductId
      }
      if (input.warehouseIdPresent) patch.warehouseId = input.warehouseId ?? null
      if (input.remarksPresent) patch.remarks = input.remarks ?? null
      return receiptByproducts.update(p, id, patch)
    },
    deleteReceiptByproduct: (p: Permit, id: string) => receiptByproducts.remove(p, id),

    /** 合同套件 / 判官 */
    _aggregateForContract: (kind: 'issue' | 'receipt'): AggregateService =>
      kind === 'issue' ? issueAggregate : receiptAggregate,
  }
}

export type OutsourcedService = ReturnType<typeof createOutsourcedService>
