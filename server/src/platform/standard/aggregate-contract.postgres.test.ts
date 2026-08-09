/**
 * 聚合草稿合同测试：对每个聚合派生资源跑同一组断言。
 *
 * 合同（写一次，所有接入资源免费继承）：
 * - createDraft 整单落库；头与子行 create 审计
 * - replaceDraft 缺失即删除；显式空数组清空全部子行
 * - 缺集合键 fail-closed（不把缺字段当空删——后端对「暂态空不删」的对偶；
 *   编辑态闸门仍在前端 `assertAggregateDraftReady`）
 * - 逐行审计三型（create / update / destroy）
 * - 任一行失败整单回滚（原子性）
 * - 无差异不落库不审计
 * - 公司创建后不可改
 * - 授权决策 fail-closed
 *
 * 新聚合资源迁入后在 CASES 里加一行描述符即可（W2+ 业务资源）。
 * 合成 stdAc* 作合同种子，与 standard-v2 的 std_v2_* 表隔离，避免并行测互踩。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { createAuthzEnforcer } from '~/platform/authz/enforce.ts'
import { testActor } from '~/platform/authz/testing.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import { createRegistry, type Registry } from '~/platform/meta/registry.ts'
import type { FieldMeta, ResourceMeta } from '~/platform/meta/types.ts'
import { buildNumberingCatalog, createNumberingService } from '~/platform/numbering/index.ts'
import {
  createQuotationService,
  type QuotationService,
} from '~/modules/trading/quotation/service.ts'
import {
  createFulfillmentService,
  type FulfillmentService,
} from '~/modules/trading/fulfillment/service.ts'
import {
  createReturnsService,
  type ReturnsService,
} from '~/modules/trading/returns/service.ts'
import {
  createOrderService,
  type OrderService,
} from '~/modules/trading/order/service.ts'
import {
  createReconciliationService,
  type ReconciliationService,
} from '~/modules/trading/reconciliation/service.ts'
import {
  createOutsourcedService,
  type OutsourcedService,
} from '~/modules/trading/outsourced/service.ts'
import {
  createDemandService,
  type DemandService,
} from '~/modules/manufacturing/demand-service.ts'
import {
  createMasterService,
  type MasterService,
} from '~/modules/manufacturing/master-service.ts'
import { createGlEngine } from '~/engines/gl/index.ts'
import { createInventoryEngine } from '~/engines/inventory/index.ts'
import { createAggregateService, type AggregateService } from './aggregate.ts'
import { createStandardChildService } from './child.ts'
import { createStandardService } from './service.ts'

const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10)

function field(
  name: string,
  apiName: string,
  type: FieldMeta['type'],
  label: string,
  extra: Partial<FieldMeta> = {},
): FieldMeta {
  return { name, apiName, dbColumn: name, type, label, ...extra }
}

const crud = [
  { key: 'read', label: '查看', scope: 'row' as const },
  { key: 'create', label: '新建', scope: 'row' as const },
  { key: 'update', label: '编辑', scope: 'row' as const },
  { key: 'delete', label: '删除', scope: 'row' as const },
  { key: 'batch_update', label: '批量编辑', scope: 'bulk' as const },
  { key: 'batch_delete', label: '批量删除', scope: 'bulk' as const },
]

const statusOptions = [
  { value: 'DRAFT', label: '草稿' },
  { value: 'AUDITED', label: '已审核' },
]

// ── 合成资源 meta（合同种子；表名 std_ac_* 与 v2 隔离）──────────────────────

function acDocMeta(): ResourceMeta {
  return {
    name: 'stdAcDocs',
    classification: { presentation: 'none', interactive: false, note: '聚合合同种子·头' },
    permissionPrefix: 'stdac.doc',
    permissionLabel: '合同测试单',
    table: 'std_ac_doc',
    authz: { kind: 'company' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('name', 'name', 'string', '名称', { required: true, maxLength: 64, filterable: true }),
      field('status', 'status', 'enum', '状态', {
        readonly: true,
        enumOptions: statusOptions,
        filterable: true,
      }),
      field('company_id', 'companyId', 'uuid', '公司', { required: true, createOnly: true }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', { readonly: true }),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', { readonly: true }),
    ],
    actions: crud,
    audit: { enabled: true },
  }
}

function acItemMeta(): ResourceMeta {
  return {
    name: 'stdAcItems',
    classification: { presentation: 'none', interactive: false, note: '聚合合同种子·行' },
    permissionPrefix: 'stdac.item',
    permissionLabel: '合同测试行',
    table: 'std_ac_item',
    authz: { kind: 'via', parent: 'stdAcDocs', fk: 'doc_id' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('doc_id', 'docId', 'uuid', '母单', { required: true, createOnly: true, filterable: true }),
      field('idx', 'idx', 'integer', '行号', { required: true, sortable: true }),
      field('qty', 'qty', 'decimal', '数量', { required: true }),
      field('company_id', 'companyId', 'uuid', '公司', { readonly: true }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', { readonly: true }),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', { readonly: true }),
    ],
    actions: crud.slice(0, 4),
    audit: { enabled: true },
  }
}

function acTierMeta(): ResourceMeta {
  return {
    name: 'stdAcTiers',
    classification: { presentation: 'none', interactive: false, note: '聚合合同种子·孙级' },
    permissionPrefix: 'stdac.tier',
    permissionLabel: '合同测试档',
    table: 'std_ac_tier',
    authz: { kind: 'via', parent: 'stdAcItems', fk: 'item_id' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('item_id', 'itemId', 'uuid', '母行', { required: true, createOnly: true, filterable: true }),
      field('min_qty', 'minQty', 'decimal', '起订量', { required: true }),
      field('price', 'price', 'decimal', '档价', { required: true }),
      field('company_id', 'companyId', 'uuid', '公司', { readonly: true }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', { readonly: true }),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', { readonly: true }),
    ],
    actions: crud.slice(0, 4),
    audit: { enabled: true },
  }
}

// ── 描述符 ──────────────────────────────────────────────────────────────────

interface AggregateContractCase {
  title: string
  /** 头资源名（authz / permit） */
  headResource: string
  /** 决策层 fail-closed 覆盖的资源（头 + 子 + 孙） */
  authzResources: string[]
  headTable: string
  itemTable: string
  /** draft 上一级集合键（items / lines…） */
  itemsKey: string
  /** 可选孙级（价格档等）；无则跳过孙级审计断言 */
  nested?: { table: string; key: string }
  /**
   * 装配聚合服务 + 已 seal 的 registry。
   * 合成种子自建 registry；业务资源可用 sealed 全局 registry。
   */
  prepare: (db: ReturnType<typeof createDb>) => { service: AggregateService; registry: Registry }
  companyId: () => string
  otherCompanyId: () => string
  /** 至少两行一级子（便于缺失删 + 保留改）；有孙级时首行带 ≥1 档 */
  validDraft: () => Record<string, unknown>
  /**
   * 有差异替换：改头名、改保留行、删一行、加一行。
   * 返回 input 与断言用 id。
   */
  buildDiffReplace: (created: Record<string, unknown>) => {
    input: Record<string, unknown>
    keptItemId: string
    deletedItemId: string
  }
  /** 与现值完全一致的快照（含全部 id） */
  buildNoopReplace: (created: Record<string, unknown>) => Record<string, unknown>
  /** 含一行故意校验失败的替换（整单应回滚） */
  buildFailReplace: (created: Record<string, unknown>) => Record<string, unknown>
  /** 显式空集合 = 删全部子行 */
  buildEmptyReplace: (created: Record<string, unknown>) => Record<string, unknown>
  /**
   * 头无 company 列的 global 资源（BOM / 工艺模板）跳过「公司创建后不可改」断言。
   * 缺省 true（业务单据）。
   */
  companyScoped?: boolean
}

/** 合成夹具公司 id（无 FK；仅 wire 字段） */
const syntheticFixture = {
  companyId: crypto.randomUUID(),
  otherCompanyId: crypto.randomUUID(),
}

function asItems(draft: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const rows = draft[key]
  if (!Array.isArray(rows)) throw new Error(`合同夹具：draft.${key} 须为数组`)
  return rows as Array<Record<string, unknown>>
}

/**
 * 从 load/create 结果重建 noop 快照：保留 id + 可写字段。
 * 合成资源字段固定；业务 CASES 应自写 buildNoopReplace。
 */
function syntheticNoop(created: Record<string, unknown>): Record<string, unknown> {
  const items = asItems(created, 'items').map((item) => {
    const tiers = Array.isArray(item.tiers)
      ? (item.tiers as Array<Record<string, unknown>>).map((t) => ({
          id: t.id,
          minQty: t.minQty,
          price: t.price,
        }))
      : []
    return { id: item.id, idx: item.idx, qty: item.qty, tiers }
  })
  return {
    name: created.name,
    companyId: created.companyId,
    items,
  }
}

const CASES: AggregateContractCase[] = [
  {
    title: '合成聚合（stdAc）',
    headResource: 'stdAcDocs',
    authzResources: ['stdAcDocs', 'stdAcItems', 'stdAcTiers'],
    headTable: 'std_ac_doc',
    itemTable: 'std_ac_item',
    itemsKey: 'items',
    nested: { table: 'std_ac_tier', key: 'tiers' },
    prepare: (db) => {
      const registry = createRegistry()
      registry.register(acDocMeta())
      registry.register(acItemMeta())
      registry.register(acTierMeta())
      registry.seal()

      const head = createStandardService({
        db,
        registry,
        resource: 'stdAcDocs',
        hooks: {
          insertColumns: () => ({ status: 'draft' }),
        },
      })
      const items = createStandardChildService({
        db,
        registry,
        resource: 'stdAcItems',
        parent: {
          resource: 'stdAcDocs',
          fkField: 'docId',
          inheritFields: ['companyId'],
          gate: (parent) => {
            if (parent.status !== 'DRAFT') {
              throw new ApiError('conflict', '仅草稿合同测试单可编辑单据行')
            }
          },
        },
      })
      const tiers = createStandardChildService({
        db,
        registry,
        resource: 'stdAcTiers',
        parent: {
          resource: 'stdAcItems',
          fkField: 'itemId',
          inheritFields: ['companyId'],
          notFound: '合同测试行不存在',
        },
        notFound: '合同测试档不存在',
        defaultOrder: sql`"id" ASC`,
      })
      const service = createAggregateService({
        db,
        registry,
        head,
        children: [
          {
            key: 'items',
            service: items,
            children: [{ key: 'tiers', service: tiers }],
          },
        ],
      })
      return { service, registry }
    },
    companyId: () => syntheticFixture.companyId,
    otherCompanyId: () => syntheticFixture.otherCompanyId,
    validDraft: () => ({
      name: `合同聚-${crypto.randomUUID().slice(0, 8)}`,
      companyId: syntheticFixture.companyId,
      items: [
        {
          idx: 1,
          qty: '10',
          tiers: [
            { minQty: '1', price: '10.0000' },
            { minQty: '10', price: '9.0000' },
          ],
        },
        { idx: 2, qty: '20', tiers: [{ minQty: '1', price: '5.0000' }] },
      ],
    }),
    buildDiffReplace: (created) => {
      const items = asItems(created, 'items')
      const kept = items[0]!
      const deleted = items[1]!
      const keptTiers = (kept.tiers as Array<Record<string, unknown>>) ?? []
      const tier0 = keptTiers[0]!
      return {
        keptItemId: String(kept.id),
        deletedItemId: String(deleted.id),
        input: {
          name: `合同改-${crypto.randomUUID().slice(0, 8)}`,
          companyId: created.companyId,
          items: [
            {
              id: kept.id,
              idx: 1,
              qty: '11',
              tiers: [
                { id: tier0.id, minQty: '1', price: '11.0000' },
                // 第二档缺失 → 删
                { minQty: '100', price: '7.0000' },
              ],
            },
            // deleted 缺失 → 删整行（含其孙级）
            { idx: 3, qty: '3', tiers: [{ minQty: '1', price: '2.0000' }] },
          ],
        },
      }
    },
    buildNoopReplace: syntheticNoop,
    buildFailReplace: (created) => {
      const items = asItems(created, 'items')
      const kept = items[0]!
      const keptTiers = ((kept.tiers as Array<Record<string, unknown>>) ?? []).map((t) => ({
        id: t.id,
        minQty: t.minQty,
        price: t.price,
      }))
      return {
        name: '不应落库',
        companyId: created.companyId,
        items: [
          { id: kept.id, idx: kept.idx, qty: '99', tiers: keptTiers },
          // qty 必填缺失 → child 校验失败
          { idx: 9, tiers: [] },
        ],
      }
    },
    buildEmptyReplace: (created) => ({
      name: created.name,
      companyId: created.companyId,
      items: [],
    }),
  },
  // W2：报价两侧（孙级价格档首消费者）；夹具见 quotationFixture
  ...quotationContractCases(),
  // W2：采购入库（最简 2 层）；夹具见 purReceiptFixture
  purReceiptContractCase(),
  // W3：销售发货（条目 + 装箱平行子树；合同面测条目集合，装箱空数组）
  salDeliveryContractCase(),
  // 销售退货（源单行；无装箱子树；条目锚定已审核发货条目）
  salReturnContractCase(),
  // W3：销售/采购订单（SAMPLE/SPOT 免报价；委外子树不进合同）
  ...orderContractCases(),
  // W3：销售/采购对账（双状态机；条目聚合；invoice 接缝不进 CASES）
  ...reconciliationContractCases(),
  // W4：委外发料 / 委外入库（材料·副产物孙级；合同面测条目集合）
  ...outsourcedContractCases(),
  // W5：履约需求单（确认占量/作废下游进 effect；合同面测头+条目）
  mfgDemandContractCase(),
  mfgProcessTemplateContractCase(),
  mfgBomContractCase(),
]

/** 报价业务资源合同夹具（beforeAll 播种；prepare 只装配服务） */
const quotationFixture = {
  companyId: crypto.randomUUID(),
  otherCompanyId: crypto.randomUUID(),
  currencyId: crypto.randomUUID(),
  customerId: crypto.randomUUID(),
  supplierId: crypto.randomUUID(),
  unitId: crypto.randomUUID(),
  categoryId: crypto.randomUUID(),
  materialId: crypto.randomUUID(),
  material2Id: crypto.randomUUID(),
  ready: false,
  service: null as QuotationService | null,
  registry: null as Registry | null,
  ruleIds: [] as string[],
}

function quotationContractCases(): AggregateContractCase[] {
  function wrap(side: 'sales' | 'purchase', headResource: string, headTable: string, itemTable: string, tierTable: string): AggregateContractCase {
    const partyType = side === 'sales' ? 'CUSTOMER' : 'SUPPLIER'
    const partyId = () =>
      side === 'sales' ? quotationFixture.customerId : quotationFixture.supplierId
    const asAgg = (): AggregateService => {
      const q = quotationFixture.service!
      return {
        loadDraft: (p, id) => q.getDraft(p, side, id),
        createDraft: (p, input) => q.createDraft(p, side, input as never),
        replaceDraft: (p, id, input) => q.replaceDraft(p, side, id, input as never),
        head: null as never,
        children: [],
      }
    }
    const validDraft = () => ({
      companyId: quotationFixture.companyId,
      quotationDate: '2026-07-31',
      validUntil: '2026-08-31',
      partyType,
      partyId: partyId(),
      currencyId: quotationFixture.currencyId,
      terms: `合同-${side}`,
      remarks: null,
      items: [
        {
          idx: 1,
          materialId: quotationFixture.materialId,
          unitId: quotationFixture.unitId,
          pricingMode: 'FIXED',
          price: '10',
          taxRate: '0.13',
          remarks: null,
          tiers: [],
        },
        {
          idx: 2,
          materialId: quotationFixture.material2Id,
          unitId: quotationFixture.unitId,
          pricingMode: 'QTY_TIERED',
          price: null,
          taxRate: '0.13',
          remarks: null,
          tiers: [
            { minQty: '10', price: '8' },
            { minQty: '100', price: '7' },
          ],
        },
      ],
    })
    const noopFrom = (created: Record<string, unknown>) => {
      const items = asItems(created, 'items').map((item) => ({
        id: item.id,
        idx: item.idx,
        materialId: item.materialId,
        unitId: item.unitId,
        pricingMode: item.pricingMode,
        price: item.price,
        taxRate: item.taxRate,
        remarks: item.remarks,
        tiers: (Array.isArray(item.tiers) ? item.tiers : []).map((t: Record<string, unknown>) => ({
          id: t.id,
          minQty: t.minQty,
          price: t.price,
        })),
      }))
      return {
        companyId: created.companyId,
        quotationDate: created.quotationDate,
        validUntil: created.validUntil,
        partyType: created.partyType,
        partyId: created.partyId,
        currencyId: created.currencyId,
        terms: created.terms,
        remarks: created.remarks,
        items,
      }
    }
    return {
      title: side === 'sales' ? '销售报价单（salQuotations）' : '采购报价单（purQuotations）',
      headResource,
      authzResources: [
        headResource,
        side === 'sales' ? 'salQuotationItems' : 'purQuotationItems',
        side === 'sales' ? 'salQuotationTiers' : 'purQuotationTiers',
      ],
      headTable,
      itemTable,
      itemsKey: 'items',
      nested: { table: tierTable, key: 'tiers' },
      prepare: () => ({
        service: asAgg(),
        registry: quotationFixture.registry!,
      }),
      companyId: () => quotationFixture.companyId,
      otherCompanyId: () => quotationFixture.otherCompanyId,
      validDraft,
      buildDiffReplace: (created) => {
        const items = asItems(created, 'items')
        const kept = items[1]! // 梯度行
        const deleted = items[0]!
        const keptTiers = (kept.tiers as Array<Record<string, unknown>>) ?? []
        const tier0 = keptTiers[0]!
        return {
          keptItemId: String(kept.id),
          deletedItemId: String(deleted.id),
          input: {
            ...noopFrom(created),
            terms: `合同改-${side}`,
            items: [
              {
                id: kept.id,
                idx: 1,
                materialId: kept.materialId,
                unitId: kept.unitId,
                pricingMode: 'QTY_TIERED',
                price: null,
                taxRate: kept.taxRate,
                remarks: '保留',
                tiers: [
                  { id: tier0.id, minQty: tier0.minQty, price: '7.5' },
                  { minQty: '200', price: '5' },
                ],
              },
              {
                idx: 2,
                materialId: quotationFixture.materialId,
                unitId: quotationFixture.unitId,
                pricingMode: 'FIXED',
                price: '9',
                taxRate: '0.13',
                remarks: null,
                tiers: [],
              },
            ],
          },
        }
      },
      buildNoopReplace: noopFrom,
      buildFailReplace: (created) => {
        const base = noopFrom(created)
        const items = asItems(created, 'items')
        const tiered = items.find((i) => String(i.pricingMode).toUpperCase() === 'QTY_TIERED')!
        const tiers = ((tiered.tiers as Array<Record<string, unknown>>) ?? []).map((t) => ({
          id: t.id,
          minQty: t.minQty,
          price: t.price,
        }))
        return {
          ...base,
          terms: '不应落库',
          items: [
            ...asItems(base, 'items').filter((i) => String(i.id) !== String(tiered.id)),
            {
              id: tiered.id,
              idx: tiered.idx,
              materialId: tiered.materialId,
              unitId: tiered.unitId,
              pricingMode: 'QTY_TIERED',
              price: null,
              taxRate: tiered.taxRate,
              remarks: tiered.remarks,
              tiers: [...tiers, { minQty: '0', price: '1' }],
            },
          ],
        }
      },
      buildEmptyReplace: (created) => ({
        ...noopFrom(created),
        items: [],
      }),
    }
  }
  return [
    wrap('sales', 'salQuotations', 'sal_quotation', 'sal_quotation_item', 'sal_quotation_tier'),
    wrap('purchase', 'purQuotations', 'pur_quotation', 'pur_quotation_item', 'pur_quotation_tier'),
  ]
}

/** 采购入库业务资源合同夹具 */
const purReceiptFixture = {
  companyId: crypto.randomUUID(),
  otherCompanyId: crypto.randomUUID(),
  currencyId: crypto.randomUUID(),
  supplierId: crypto.randomUUID(),
  unitId: crypto.randomUUID(),
  categoryId: crypto.randomUUID(),
  materialId: crypto.randomUUID(),
  material2Id: crypto.randomUUID(),
  warehouseId: crypto.randomUUID(),
  debitAccountId: crypto.randomUUID(),
  creditAccountId: crypto.randomUUID(),
  orderId: crypto.randomUUID(),
  orderItemId: crypto.randomUUID(),
  orderItem2Id: crypto.randomUUID(),
  ready: false,
  service: null as FulfillmentService | null,
  registry: null as Registry | null,
  ruleIds: [] as string[],
}

function purReceiptContractCase(): AggregateContractCase {
  const asAgg = (): AggregateService => {
    const f = purReceiptFixture.service!
    const asRec = (p: Promise<unknown>) => p as Promise<Record<string, unknown>>
    return {
      loadDraft: (p, id) => asRec(f.getPurchaseReceiptDraft(p, id)),
      createDraft: (p, input) => asRec(f.createPurchaseReceiptDraft(p, input as never)),
      replaceDraft: (p, id, input) =>
        asRec(f.replacePurchaseReceiptDraft(p, id, input as never)),
      head: null as never,
      children: [],
    }
  }
  const validDraft = () => ({
    companyId: purReceiptFixture.companyId,
    documentDate: '2026-07-25',
    postingDate: '2026-07-25',
    partyType: 'supplier',
    partyId: purReceiptFixture.supplierId,
    remarks: '合同-purReceipt',
    warehouseId: purReceiptFixture.warehouseId,
    debitAccountId: purReceiptFixture.debitAccountId,
    creditAccountId: purReceiptFixture.creditAccountId,
    items: [
      {
        idx: 1,
        qty: '10',
        orderItemId: purReceiptFixture.orderItemId,
        warehouseId: purReceiptFixture.warehouseId,
      },
      {
        idx: 2,
        qty: '20',
        orderItemId: purReceiptFixture.orderItem2Id,
        warehouseId: purReceiptFixture.warehouseId,
      },
    ],
  })
  const noopFrom = (created: Record<string, unknown>) => {
    const items = asItems(created, 'items').map((item) => ({
      id: item.id,
      idx: item.idx,
      qty: item.qty,
      orderItemId: item.orderItemId,
      unitId: item.unitId,
      warehouseId: item.warehouseId,
      remarks: item.remarks,
    }))
    return {
      companyId: created.companyId,
      no: created.receiptNo,
      documentDate: created.receiptDate,
      postingDate: created.postingDate,
      partyType: created.partyType,
      partyId: created.partyId,
      remarks: created.remarks,
      warehouseId: created.warehouseId,
      debitAccountId: created.debitAccountId,
      creditAccountId: created.creditAccountId,
      items,
    }
  }
  return {
    title: '采购入库单（purReceipts）',
    headResource: 'purReceipts',
    authzResources: ['purReceipts', 'purReceiptItems'],
    headTable: 'pur_receipt',
    itemTable: 'pur_receipt_item',
    itemsKey: 'items',
    prepare: () => ({
      service: asAgg(),
      registry: purReceiptFixture.registry!,
    }),
    companyId: () => purReceiptFixture.companyId,
    otherCompanyId: () => purReceiptFixture.otherCompanyId,
    validDraft,
    buildDiffReplace: (created) => {
      const items = asItems(created, 'items')
      const kept = items[0]!
      const deleted = items[1]!
      return {
        keptItemId: String(kept.id),
        deletedItemId: String(deleted.id),
        input: {
          ...noopFrom(created),
          remarks: '合同改-purReceipt',
          items: [
            {
              id: kept.id,
              idx: 1,
              qty: '11',
              orderItemId: kept.orderItemId,
              unitId: kept.unitId,
              warehouseId: kept.warehouseId,
              remarks: '保留',
            },
            {
              idx: 3,
              qty: '3',
              orderItemId: purReceiptFixture.orderItem2Id,
              warehouseId: purReceiptFixture.warehouseId,
            },
          ],
        },
      }
    },
    buildNoopReplace: noopFrom,
    buildFailReplace: (created) => {
      const base = noopFrom(created)
      const items = asItems(created, 'items')
      const kept = items[0]!
      return {
        ...base,
        remarks: '不应落库',
        items: [
          {
            id: kept.id,
            idx: kept.idx,
            qty: '99',
            orderItemId: kept.orderItemId,
            unitId: kept.unitId,
            warehouseId: kept.warehouseId,
            remarks: kept.remarks,
          },
          // qty 必须 >0 → 校验失败
          {
            idx: 9,
            qty: '0',
            orderItemId: purReceiptFixture.orderItemId,
            warehouseId: purReceiptFixture.warehouseId,
          },
        ],
      }
    },
    buildEmptyReplace: (created) => ({
      ...noopFrom(created),
      items: [],
    }),
  }
}

/** 销售发货业务资源合同夹具 */
const salDeliveryFixture = {
  companyId: crypto.randomUUID(),
  otherCompanyId: crypto.randomUUID(),
  currencyId: crypto.randomUUID(),
  customerId: crypto.randomUUID(),
  unitId: crypto.randomUUID(),
  categoryId: crypto.randomUUID(),
  materialId: crypto.randomUUID(),
  material2Id: crypto.randomUUID(),
  warehouseId: crypto.randomUUID(),
  debitAccountId: crypto.randomUUID(),
  creditAccountId: crypto.randomUUID(),
  orderId: crypto.randomUUID(),
  orderItemId: crypto.randomUUID(),
  orderItem2Id: crypto.randomUUID(),
  ready: false,
  service: null as FulfillmentService | null,
  registry: null as Registry | null,
  ruleIds: [] as string[],
}

function salDeliveryContractCase(): AggregateContractCase {
  const asAgg = (): AggregateService => salDeliveryFixture.service!._aggregateForContract('sales')
  const validDraft = () => ({
    companyId: salDeliveryFixture.companyId,
    documentDate: '2026-07-25',
    postingDate: '2026-07-25',
    partyType: 'customer',
    partyId: salDeliveryFixture.customerId,
    remarks: '合同-salDelivery',
    warehouseId: salDeliveryFixture.warehouseId,
    debitAccountId: salDeliveryFixture.debitAccountId,
    creditAccountId: salDeliveryFixture.creditAccountId,
    items: [
      {
        idx: 1,
        qty: '10',
        orderItemId: salDeliveryFixture.orderItemId,
        warehouseId: salDeliveryFixture.warehouseId,
      },
      {
        idx: 2,
        qty: '20',
        orderItemId: salDeliveryFixture.orderItem2Id,
        warehouseId: salDeliveryFixture.warehouseId,
      },
    ],
    packBoxes: [],
  })
  const noopFrom = (created: Record<string, unknown>) => {
    const items = asItems(created, 'items').map((item) => ({
      id: item.id,
      idx: item.idx,
      qty: item.qty,
      orderItemId: item.orderItemId,
      unitId: item.unitId,
      warehouseId: item.warehouseId,
      remarks: item.remarks,
    }))
    const packBoxes = Array.isArray(created.packBoxes)
      ? (created.packBoxes as Array<Record<string, unknown>>).map((box) => ({
          id: box.id,
          lines: Array.isArray(box.lines)
            ? (box.lines as Array<Record<string, unknown>>).map((line) => ({
                id: line.id,
                idx: line.idx,
                qty: line.qty,
                materialId: line.materialId,
                unitId: line.unitId,
                remarks: line.remarks,
              }))
            : [],
        }))
      : []
    return {
      companyId: created.companyId,
      no: created.deliveryNo,
      documentDate: created.deliveryDate,
      postingDate: created.postingDate,
      partyType: created.partyType,
      partyId: created.partyId,
      remarks: created.remarks,
      warehouseId: created.warehouseId,
      debitAccountId: created.debitAccountId,
      creditAccountId: created.creditAccountId,
      items,
      packBoxes,
    }
  }
  return {
    title: '销售发货单（salDeliveries）',
    headResource: 'salDeliveries',
    authzResources: [
      'salDeliveries',
      'salDeliveryItems',
      'salDeliveryPackBoxes',
      'salDeliveryPackLines',
    ],
    headTable: 'sal_delivery',
    itemTable: 'sal_delivery_item',
    itemsKey: 'items',
    prepare: () => ({
      service: asAgg(),
      registry: salDeliveryFixture.registry!,
    }),
    companyId: () => salDeliveryFixture.companyId,
    otherCompanyId: () => salDeliveryFixture.otherCompanyId,
    validDraft,
    buildDiffReplace: (created) => {
      const items = asItems(created, 'items')
      const kept = items[0]!
      const deleted = items[1]!
      return {
        keptItemId: String(kept.id),
        deletedItemId: String(deleted.id),
        input: {
          ...noopFrom(created),
          remarks: '合同改-salDelivery',
          items: [
            {
              id: kept.id,
              idx: 1,
              qty: '11',
              orderItemId: kept.orderItemId,
              unitId: kept.unitId,
              warehouseId: kept.warehouseId,
              remarks: '保留',
            },
            {
              idx: 3,
              qty: '3',
              orderItemId: salDeliveryFixture.orderItem2Id,
              warehouseId: salDeliveryFixture.warehouseId,
            },
          ],
          packBoxes: [],
        },
      }
    },
    buildNoopReplace: noopFrom,
    buildFailReplace: (created) => {
      const base = noopFrom(created)
      const items = asItems(created, 'items')
      const kept = items[0]!
      return {
        ...base,
        remarks: '不应落库',
        items: [
          {
            id: kept.id,
            idx: kept.idx,
            qty: '99',
            orderItemId: kept.orderItemId,
            unitId: kept.unitId,
            warehouseId: kept.warehouseId,
            remarks: kept.remarks,
          },
          {
            idx: 9,
            qty: '0',
            orderItemId: salDeliveryFixture.orderItemId,
            warehouseId: salDeliveryFixture.warehouseId,
          },
        ],
        packBoxes: [],
      }
    },
    buildEmptyReplace: (created) => ({
      ...noopFrom(created),
      items: [],
      packBoxes: [],
    }),
  }
}

/** 销售退货业务资源合同夹具（独立公司 + 已审核发货单两行作源单锚点） */
const salReturnFixture = {
  companyId: crypto.randomUUID(),
  otherCompanyId: crypto.randomUUID(),
  currencyId: crypto.randomUUID(),
  customerId: crypto.randomUUID(),
  unitId: crypto.randomUUID(),
  categoryId: crypto.randomUUID(),
  materialId: crypto.randomUUID(),
  material2Id: crypto.randomUUID(),
  warehouseId: crypto.randomUUID(),
  debitAccountId: crypto.randomUUID(),
  creditAccountId: crypto.randomUUID(),
  orderId: crypto.randomUUID(),
  orderItemId: crypto.randomUUID(),
  orderItem2Id: crypto.randomUUID(),
  deliveryId: crypto.randomUUID(),
  deliveryItemId: crypto.randomUUID(),
  deliveryItem2Id: crypto.randomUUID(),
  ready: false,
  service: null as ReturnsService | null,
  registry: null as Registry | null,
  ruleIds: [] as string[],
}

function salReturnContractCase(): AggregateContractCase {
  const asAgg = (): AggregateService => salReturnFixture.service!._aggregateForContract()
  const validDraft = () => ({
    companyId: salReturnFixture.companyId,
    documentDate: '2026-08-09',
    postingDate: '2026-08-09',
    partyType: 'customer',
    partyId: salReturnFixture.customerId,
    currencyId: salReturnFixture.currencyId,
    remarks: '合同-salReturn',
    warehouseId: salReturnFixture.warehouseId,
    debitAccountId: salReturnFixture.debitAccountId,
    creditAccountId: salReturnFixture.creditAccountId,
    items: [
      {
        idx: 1,
        qty: '2',
        deliveryItemId: salReturnFixture.deliveryItemId,
        warehouseId: salReturnFixture.warehouseId,
      },
      {
        idx: 2,
        qty: '3',
        deliveryItemId: salReturnFixture.deliveryItem2Id,
        warehouseId: salReturnFixture.warehouseId,
      },
    ],
  })
  const noopFrom = (created: Record<string, unknown>) => {
    const items = asItems(created, 'items').map((item) => ({
      id: item.id,
      idx: item.idx,
      qty: item.qty,
      deliveryItemId: item.deliveryItemId,
      unitId: item.unitId,
      warehouseId: item.warehouseId,
      remarks: item.remarks,
    }))
    return {
      companyId: created.companyId,
      no: created.returnNo,
      documentDate: created.returnDate,
      postingDate: created.postingDate,
      partyType: created.partyType,
      partyId: created.partyId,
      currencyId: created.currencyId,
      exchangeRate: created.exchangeRate,
      remarks: created.remarks,
      warehouseId: created.warehouseId,
      debitAccountId: created.debitAccountId,
      creditAccountId: created.creditAccountId,
      items,
    }
  }
  return {
    title: '销售退货单（salReturns）',
    headResource: 'salReturns',
    authzResources: ['salReturns', 'salReturnItems'],
    headTable: 'sal_return',
    itemTable: 'sal_return_item',
    itemsKey: 'items',
    prepare: () => ({
      service: asAgg(),
      registry: salReturnFixture.registry!,
    }),
    companyId: () => salReturnFixture.companyId,
    otherCompanyId: () => salReturnFixture.otherCompanyId,
    validDraft,
    buildDiffReplace: (created) => {
      const items = asItems(created, 'items')
      const kept = items[0]!
      const deleted = items[1]!
      return {
        keptItemId: String(kept.id),
        deletedItemId: String(deleted.id),
        input: {
          ...noopFrom(created),
          remarks: '合同改-salReturn',
          items: [
            {
              id: kept.id,
              idx: 1,
              qty: '4',
              deliveryItemId: kept.deliveryItemId,
              unitId: kept.unitId,
              warehouseId: kept.warehouseId,
              remarks: '保留',
            },
            {
              idx: 3,
              qty: '1',
              deliveryItemId: salReturnFixture.deliveryItem2Id,
              warehouseId: salReturnFixture.warehouseId,
            },
          ],
        },
      }
    },
    buildNoopReplace: noopFrom,
    buildFailReplace: (created) => {
      const base = noopFrom(created)
      const items = asItems(created, 'items')
      const kept = items[0]!
      return {
        ...base,
        remarks: '不应落库',
        items: [
          {
            id: kept.id,
            idx: kept.idx,
            qty: '5',
            deliveryItemId: kept.deliveryItemId,
            unitId: kept.unitId,
            warehouseId: kept.warehouseId,
            remarks: kept.remarks,
          },
          // qty 必须 >0 → 校验失败
          {
            idx: 9,
            qty: '0',
            deliveryItemId: salReturnFixture.deliveryItemId,
            warehouseId: salReturnFixture.warehouseId,
          },
        ],
      }
    },
    buildEmptyReplace: (created) => ({
      ...noopFrom(created),
      items: [],
    }),
  }
}

/** 订单业务资源合同夹具（复用 quotation 主数据；SAMPLE/SPOT 免报价套档） */
const orderFixture = {
  service: null as OrderService | null,
  registry: null as Registry | null,
  ruleIds: [] as string[],
  ready: false,
}

function orderContractCases(): AggregateContractCase[] {
  function wrap(
    side: 'sales' | 'purchase',
    headResource: string,
    headTable: string,
    itemTable: string,
  ): AggregateContractCase {
    const partyType = side === 'sales' ? 'CUSTOMER' : 'SUPPLIER'
    const partyId = () =>
      side === 'sales' ? quotationFixture.customerId : quotationFixture.supplierId
    const orderType = side === 'sales' ? 'SAMPLE' : 'SPOT'
    const asAgg = (): AggregateService => orderFixture.service!._aggregateForContract(side)
    const validDraft = () => ({
      companyId: quotationFixture.companyId,
      orderDate: '2026-07-31',
      orderType,
      partyType,
      partyId: partyId(),
      currencyId: quotationFixture.currencyId,
      exchangeRate: '1',
      terms: `合同-ord-${side}`,
      remarks: null,
      items: [
        {
          idx: 1,
          qty: '5',
          materialId: quotationFixture.materialId,
          unitId: quotationFixture.unitId,
          price: '10',
          taxRate: '0.13',
          remarks: null,
          issueLines: [],
          byproductLines: [],
        },
        {
          idx: 2,
          qty: '3',
          materialId: quotationFixture.material2Id,
          unitId: quotationFixture.unitId,
          price: '8',
          taxRate: '0.13',
          remarks: null,
          issueLines: [],
          byproductLines: [],
        },
      ],
    })
    const noopFrom = (created: Record<string, unknown>) => {
      const items = asItems(created, 'items').map((item) => ({
        id: item.id,
        idx: item.idx,
        qty: item.qty,
        materialId: item.materialId,
        unitId: item.unitId,
        price: item.price,
        taxRate: item.taxRate,
        remarks: item.remarks,
        quotationItemId: item.quotationItemId ?? null,
        bomId: item.bomId ?? null,
        demandLineId: item.demandLineId ?? null,
        demandDate: item.demandDate ?? null,
        issueLines: [],
        byproductLines: [],
      }))
      return {
        companyId: created.companyId,
        orderDate: created.orderDate,
        orderType: created.orderType,
        partyType: created.partyType,
        partyId: created.partyId,
        currencyId: created.currencyId,
        exchangeRate: created.exchangeRate,
        terms: created.terms,
        remarks: created.remarks,
        isOutsourced: created.isOutsourced,
        items,
      }
    }
    return {
      title: side === 'sales' ? '销售订单（salOrders）' : '采购订单（purOrders）',
      headResource,
      authzResources: [
        headResource,
        side === 'sales' ? 'salOrderItems' : 'purOrderItems',
      ],
      headTable,
      itemTable,
      itemsKey: 'items',
      prepare: () => ({
        service: asAgg(),
        registry: orderFixture.registry!,
      }),
      companyId: () => quotationFixture.companyId,
      otherCompanyId: () => quotationFixture.otherCompanyId,
      validDraft,
      buildDiffReplace: (created) => {
        const items = asItems(created, 'items')
        const kept = items[0]!
        const deleted = items[1]!
        return {
          keptItemId: String(kept.id),
          deletedItemId: String(deleted.id),
          input: {
            ...noopFrom(created),
            terms: `合同改-ord-${side}`,
            items: [
              {
                id: kept.id,
                idx: 1,
                qty: '6',
                materialId: kept.materialId,
                unitId: kept.unitId,
                price: kept.price,
                taxRate: kept.taxRate,
                remarks: '保留',
                issueLines: [],
                byproductLines: [],
              },
              {
                idx: 2,
                qty: '2',
                materialId: quotationFixture.material2Id,
                unitId: quotationFixture.unitId,
                price: '9',
                taxRate: '0.13',
                remarks: null,
                issueLines: [],
                byproductLines: [],
              },
            ],
          },
        }
      },
      buildNoopReplace: noopFrom,
      buildFailReplace: (created) => ({
        ...noopFrom(created),
        terms: '不应落库',
        items: [
          ...asItems(noopFrom(created), 'items'),
          {
            idx: 9,
            qty: '0',
            materialId: quotationFixture.materialId,
            unitId: quotationFixture.unitId,
            price: '1',
            taxRate: '0.13',
            issueLines: [],
            byproductLines: [],
          },
        ],
      }),
      buildEmptyReplace: (created) => ({
        ...noopFrom(created),
        items: [],
      }),
    }
  }
  return [
    wrap('sales', 'salOrders', 'sal_order', 'sal_order_item'),
    wrap('purchase', 'purOrders', 'pur_order', 'pur_order_item'),
  ]
}


/** 对账业务资源合同夹具 */
const reconFixture = {
  companyId: crypto.randomUUID(),
  otherCompanyId: crypto.randomUUID(),
  currencyId: crypto.randomUUID(),
  customerId: crypto.randomUUID(),
  supplierId: crypto.randomUUID(),
  unitId: crypto.randomUUID(),
  categoryId: crypto.randomUUID(),
  materialId: crypto.randomUUID(),
  material2Id: crypto.randomUUID(),
  warehouseId: crypto.randomUUID(),
  salesDebitId: crypto.randomUUID(),
  salesCreditId: crypto.randomUUID(),
  purchaseDebitId: crypto.randomUUID(),
  purchaseCreditId: crypto.randomUUID(),
  salesDeliveryItemId: crypto.randomUUID(),
  salesDeliveryItem2Id: crypto.randomUUID(),
  purchaseReceiptItemId: crypto.randomUUID(),
  purchaseReceiptItem2Id: crypto.randomUUID(),
  ready: false,
  service: null as ReconciliationService | null,
  registry: null as Registry | null,
  ruleIds: [] as string[],
}

function reconciliationContractCases(): AggregateContractCase[] {
  function wrap(
    side: 'sales' | 'purchase',
    headResource: string,
    headTable: string,
    itemTable: string,
  ): AggregateContractCase {
    const asAgg = (): AggregateService => reconFixture.service!._aggregateForContract(side)
    const isSales = side === 'sales'
    const sourceKey = isSales ? 'deliveryItemId' : 'receiptItemId'
    const src1 = () =>
      isSales ? reconFixture.salesDeliveryItemId : reconFixture.purchaseReceiptItemId
    const src2 = () =>
      isSales ? reconFixture.salesDeliveryItem2Id : reconFixture.purchaseReceiptItem2Id
    const validDraft = () => ({
      companyId: reconFixture.companyId,
      reconciliationType: 'REGULAR',
      partyType: isSales ? 'CUSTOMER' : 'SUPPLIER',
      partyId: isSales ? reconFixture.customerId : reconFixture.supplierId,
      debitAccountId: isSales ? reconFixture.salesDebitId : reconFixture.purchaseDebitId,
      creditAccountId: isSales ? reconFixture.salesCreditId : reconFixture.purchaseCreditId,
      remarks: `合同-recon-${side}`,
      items: [
        { idx: 1, qty: '2', [sourceKey]: src1() },
        { idx: 2, qty: '3', [sourceKey]: src2() },
      ],
    })
    const noopFrom = (created: Record<string, unknown>) => {
      const items = asItems(created, 'items').map((item) => ({
        id: item.id,
        idx: item.idx,
        qty: item.qty,
        [sourceKey]: item[sourceKey],
        remarks: item.remarks,
      }))
      return {
        companyId: created.companyId,
        reconciliationType: created.reconciliationType,
        partyType: created.partyType,
        partyId: created.partyId,
        debitAccountId: created.debitAccountId,
        creditAccountId: created.creditAccountId,
        remarks: created.remarks,
        items,
      }
    }
    return {
      title: isSales ? '销售对账单（salReconciliations）' : '采购对账单（purReconciliations）',
      headResource,
      authzResources: [
        headResource,
        isSales ? 'salReconciliationItems' : 'purReconciliationItems',
      ],
      headTable,
      itemTable,
      itemsKey: 'items',
      prepare: () => ({
        service: asAgg(),
        registry: reconFixture.registry!,
      }),
      companyId: () => reconFixture.companyId,
      otherCompanyId: () => reconFixture.otherCompanyId,
      validDraft,
      buildDiffReplace: (created) => {
        const items = asItems(created, 'items')
        const kept = items[0]!
        const deleted = items[1]!
        return {
          keptItemId: String(kept.id),
          deletedItemId: String(deleted.id),
          input: {
            ...noopFrom(created),
            remarks: `合同改-recon-${side}`,
            items: [
              {
                id: kept.id,
                idx: 1,
                qty: '4',
                [sourceKey]: kept[sourceKey],
                remarks: '保留',
              },
              {
                idx: 3,
                qty: '1',
                [sourceKey]: src2(),
                remarks: null,
              },
            ],
          },
        }
      },
      buildNoopReplace: noopFrom,
      buildFailReplace: (created) => ({
        ...noopFrom(created),
        remarks: '不应落库',
        items: [
          ...asItems(noopFrom(created), 'items'),
          { idx: 9, qty: '0', [sourceKey]: src1() },
        ],
      }),
      buildEmptyReplace: (created) => ({
        ...noopFrom(created),
        items: [],
      }),
    }
  }
  return [
    wrap('sales', 'salReconciliations', 'sal_reconciliation', 'sal_reconciliation_item'),
    wrap('purchase', 'purReconciliations', 'pur_reconciliation', 'pur_reconciliation_item'),
  ]
}

/** W4 委外发料/入库合同夹具 */
const outsourcedFixture = {
  companyId: crypto.randomUUID(),
  otherCompanyId: crypto.randomUUID(),
  currencyId: crypto.randomUUID(),
  supplierId: crypto.randomUUID(),
  unitId: crypto.randomUUID(),
  categoryId: crypto.randomUUID(),
  materialId: crypto.randomUUID(),
  material2Id: crypto.randomUUID(),
  finishedId: crypto.randomUUID(),
  finished2Id: crypto.randomUUID(),
  mainWhId: crypto.randomUUID(),
  outWhId: crypto.randomUUID(),
  debitId: crypto.randomUUID(),
  creditId: crypto.randomUUID(),
  orderId: crypto.randomUUID(),
  orderItemId: crypto.randomUUID(),
  orderItem2Id: crypto.randomUUID(),
  orderMaterialId: crypto.randomUUID(),
  orderMaterial2Id: crypto.randomUUID(),
  ready: false,
  service: null as OutsourcedService | null,
  registry: null as Registry | null,
  ruleIds: [] as string[],
}

function outsourcedContractCases(): AggregateContractCase[] {
  function issueCase(): AggregateContractCase {
    const asAgg = (): AggregateService =>
      outsourcedFixture.service!._aggregateForContract('issue')
    const validDraft = () => ({
      companyId: outsourcedFixture.companyId,
      partyType: 'SUPPLIER',
      partyId: outsourcedFixture.supplierId,
      fromWarehouseId: outsourcedFixture.mainWhId,
      outsourcedWarehouseId: outsourcedFixture.outWhId,
      remarks: '合同-issue',
      items: [
        {
          idx: 1,
          qty: '2',
          orderItemMaterialId: outsourcedFixture.orderMaterialId,
          fromWarehouseId: outsourcedFixture.mainWhId,
          outsourcedWarehouseId: outsourcedFixture.outWhId,
        },
        {
          idx: 2,
          qty: '3',
          orderItemMaterialId: outsourcedFixture.orderMaterial2Id,
          fromWarehouseId: outsourcedFixture.mainWhId,
          outsourcedWarehouseId: outsourcedFixture.outWhId,
        },
      ],
    })
    const noopFrom = (created: Record<string, unknown>) => {
      const items = asItems(created, 'items').map((item) => ({
        id: item.id,
        idx: item.idx,
        qty: item.qty,
        orderItemMaterialId: item.orderItemMaterialId,
        fromWarehouseId: item.fromWarehouseId,
        outsourcedWarehouseId: item.outsourcedWarehouseId,
        remarks: item.remarks,
      }))
      return {
        companyId: created.companyId,
        partyType: created.partyType,
        partyId: created.partyId,
        fromWarehouseId: created.fromWarehouseId,
        outsourcedWarehouseId: created.outsourcedWarehouseId,
        remarks: created.remarks,
        items,
      }
    }
    return {
      title: '委外发料单（purOutsourcedIssues）',
      headResource: 'purOutsourcedIssues',
      authzResources: ['purOutsourcedIssues', 'purOutsourcedIssueItems'],
      headTable: 'pur_outsourced_issue',
      itemTable: 'pur_outsourced_issue_item',
      itemsKey: 'items',
      prepare: () => ({
        service: asAgg(),
        registry: outsourcedFixture.registry!,
      }),
      companyId: () => outsourcedFixture.companyId,
      otherCompanyId: () => outsourcedFixture.otherCompanyId,
      validDraft,
      buildDiffReplace: (created) => {
        const items = asItems(created, 'items')
        const kept = items[0]!
        const deleted = items[1]!
        return {
          keptItemId: String(kept.id),
          deletedItemId: String(deleted.id),
          input: {
            ...noopFrom(created),
            remarks: '合同改-issue',
            items: [
              {
                id: kept.id,
                idx: 1,
                qty: '4',
                orderItemMaterialId: kept.orderItemMaterialId,
                fromWarehouseId: kept.fromWarehouseId,
                outsourcedWarehouseId: kept.outsourcedWarehouseId,
                remarks: '保留',
              },
              {
                idx: 3,
                qty: '1',
                orderItemMaterialId: outsourcedFixture.orderMaterial2Id,
                fromWarehouseId: outsourcedFixture.mainWhId,
                outsourcedWarehouseId: outsourcedFixture.outWhId,
              },
            ],
          },
        }
      },
      buildNoopReplace: noopFrom,
      buildFailReplace: (created) => ({
        ...noopFrom(created),
        remarks: '不应落库',
        items: [
          ...asItems(noopFrom(created), 'items'),
          {
            idx: 9,
            qty: '0',
            orderItemMaterialId: outsourcedFixture.orderMaterialId,
            fromWarehouseId: outsourcedFixture.mainWhId,
            outsourcedWarehouseId: outsourcedFixture.outWhId,
          },
        ],
      }),
      buildEmptyReplace: (created) => ({
        ...noopFrom(created),
        items: [],
      }),
    }
  }

  function receiptCase(): AggregateContractCase {
    const asAgg = (): AggregateService =>
      outsourcedFixture.service!._aggregateForContract('receipt')
    const validDraft = () => ({
      companyId: outsourcedFixture.companyId,
      partyType: 'SUPPLIER',
      partyId: outsourcedFixture.supplierId,
      warehouseId: outsourcedFixture.mainWhId,
      outsourcedWarehouseId: outsourcedFixture.outWhId,
      debitAccountId: outsourcedFixture.debitId,
      creditAccountId: outsourcedFixture.creditId,
      remarks: '合同-receipt',
      items: [
        {
          idx: 1,
          qty: '2',
          orderItemId: outsourcedFixture.orderItemId,
          warehouseId: outsourcedFixture.mainWhId,
        },
        {
          idx: 2,
          qty: '3',
          orderItemId: outsourcedFixture.orderItem2Id,
          warehouseId: outsourcedFixture.mainWhId,
        },
      ],
    })
    const noopFrom = (created: Record<string, unknown>) => {
      const items = asItems(created, 'items').map((item) => ({
        id: item.id,
        idx: item.idx,
        qty: item.qty,
        orderItemId: item.orderItemId,
        unitId: item.unitId,
        warehouseId: item.warehouseId,
        remarks: item.remarks,
      }))
      return {
        companyId: created.companyId,
        partyType: created.partyType,
        partyId: created.partyId,
        warehouseId: created.warehouseId,
        outsourcedWarehouseId: created.outsourcedWarehouseId,
        debitAccountId: created.debitAccountId,
        creditAccountId: created.creditAccountId,
        remarks: created.remarks,
        items,
      }
    }
    return {
      title: '委外入库单（purOutsourcedReceipts）',
      headResource: 'purOutsourcedReceipts',
      authzResources: ['purOutsourcedReceipts', 'purOutsourcedReceiptItems'],
      headTable: 'pur_outsourced_receipt',
      itemTable: 'pur_outsourced_receipt_item',
      itemsKey: 'items',
      prepare: () => ({
        service: asAgg(),
        registry: outsourcedFixture.registry!,
      }),
      companyId: () => outsourcedFixture.companyId,
      otherCompanyId: () => outsourcedFixture.otherCompanyId,
      validDraft,
      buildDiffReplace: (created) => {
        const items = asItems(created, 'items')
        const kept = items[0]!
        const deleted = items[1]!
        return {
          keptItemId: String(kept.id),
          deletedItemId: String(deleted.id),
          input: {
            ...noopFrom(created),
            remarks: '合同改-receipt',
            items: [
              {
                id: kept.id,
                idx: 1,
                qty: '4',
                orderItemId: kept.orderItemId,
                unitId: kept.unitId,
                warehouseId: kept.warehouseId,
                remarks: '保留',
              },
              {
                idx: 3,
                qty: '1',
                orderItemId: outsourcedFixture.orderItem2Id,
                warehouseId: outsourcedFixture.mainWhId,
              },
            ],
          },
        }
      },
      buildNoopReplace: noopFrom,
      buildFailReplace: (created) => ({
        ...noopFrom(created),
        remarks: '不应落库',
        items: [
          ...asItems(noopFrom(created), 'items'),
          {
            idx: 9,
            qty: '0',
            orderItemId: outsourcedFixture.orderItemId,
            warehouseId: outsourcedFixture.mainWhId,
          },
        ],
      }),
      buildEmptyReplace: (created) => ({
        ...noopFrom(created),
        items: [],
      }),
    }
  }

  return [issueCase(), receiptCase()]
}

/** 履约需求单合同夹具（beforeAll 播种） */
const demandFixture = {
  companyId: crypto.randomUUID(),
  otherCompanyId: crypto.randomUUID(),
  currencyId: crypto.randomUUID(),
  unitId: crypto.randomUUID(),
  categoryId: crypto.randomUUID(),
  materialId: crypto.randomUUID(),
  material2Id: crypto.randomUUID(),
  ready: false,
  service: null as DemandService | null,
  registry: null as Registry | null,
  ruleIds: [] as string[],
}

/** 工艺模板 / BOM 主数据合同夹具（global；beforeAll 播种） */
const masterFixture = {
  unitId: crypto.randomUUID(),
  categoryId: crypto.randomUUID(),
  materialId: crypto.randomUUID(),
  material2Id: crypto.randomUUID(),
  material3Id: crypto.randomUUID(),
  operationId: crypto.randomUUID(),
  operation2Id: crypto.randomUUID(),
  ready: false,
  service: null as MasterService | null,
  registry: null as Registry | null,
  ruleIds: [] as string[],
}

function mfgDemandContractCase(): AggregateContractCase {
  const asAgg = (): AggregateService => demandFixture.service!._aggregateForContract()
  const validDraft = () => ({
    companyId: demandFixture.companyId,
    assignType: 'PURCHASE',
    demandDate: '2026-07-31',
    needDate: '2026-08-15',
    remarks: '合同-demand',
    assignedDeptId: null,
    items: [
      {
        idx: 1,
        materialId: demandFixture.materialId,
        unitId: demandFixture.unitId,
        qty: '10',
        needDate: '2026-08-15',
        remarks: null,
      },
      {
        idx: 2,
        materialId: demandFixture.material2Id,
        unitId: demandFixture.unitId,
        qty: '20',
        needDate: '2026-08-20',
        remarks: null,
      },
    ],
  })
  const noopFrom = (created: Record<string, unknown>) => {
    const items = asItems(created, 'items').map((item) => ({
      id: item.id,
      idx: item.idx,
      materialId: item.materialId,
      unitId: item.unitId,
      qty: item.qty,
      needDate: item.needDate,
      remarks: item.remarks,
    }))
    return {
      companyId: created.companyId,
      assignType: created.assignType,
      demandDate: created.demandDate,
      needDate: created.needDate,
      remarks: created.remarks,
      assignedDeptId: created.assignedDeptId ?? null,
      items,
    }
  }
  return {
    title: '履约需求单（mfgDemands）',
    headResource: 'mfgDemands',
    authzResources: ['mfgDemands', 'mfgDemandItems'],
    headTable: 'mfg_demand',
    itemTable: 'mfg_demand_item',
    itemsKey: 'items',
    prepare: () => ({
      service: asAgg(),
      registry: demandFixture.registry!,
    }),
    companyId: () => demandFixture.companyId,
    otherCompanyId: () => demandFixture.otherCompanyId,
    validDraft,
    buildDiffReplace: (created) => {
      const items = asItems(created, 'items')
      const kept = items[0]!
      const deleted = items[1]!
      return {
        keptItemId: String(kept.id),
        deletedItemId: String(deleted.id),
        input: {
          ...noopFrom(created),
          remarks: '合同改-demand',
          items: [
            {
              id: kept.id,
              idx: 1,
              materialId: kept.materialId,
              unitId: kept.unitId,
              qty: '11',
              needDate: kept.needDate,
              remarks: '保留',
            },
            {
              idx: 3,
              materialId: demandFixture.material2Id,
              unitId: demandFixture.unitId,
              qty: '3',
              needDate: '2026-08-25',
              remarks: null,
            },
          ],
        },
      }
    },
    buildNoopReplace: noopFrom,
    buildFailReplace: (created) => ({
      ...noopFrom(created),
      remarks: '不应落库',
      items: [
        ...asItems(noopFrom(created), 'items'),
        {
          idx: 9,
          materialId: demandFixture.materialId,
          unitId: demandFixture.unitId,
          // needDate 缺 → 校验失败
          qty: '1',
        },
      ],
    }),
    buildEmptyReplace: (created) => ({
      ...noopFrom(created),
      items: [],
    }),
  }
}

function mfgProcessTemplateContractCase(): AggregateContractCase {
  const asAgg = (): AggregateService => masterFixture.service!._templateAggregateForContract()
  const validDraft = () => ({
    name: `合同模板-${suffix}`,
    note: '合同-template',
    items: [
      {
        operationId: masterFixture.operationId,
        seq: 10,
        requirement: '要求A',
        isOutsourced: false,
      },
      {
        operationId: masterFixture.operation2Id,
        seq: 20,
        requirement: null,
        isOutsourced: true,
      },
    ],
  })
  const noopFrom = (created: Record<string, unknown>) => {
    const items = asItems(created, 'items').map((item) => ({
      id: item.id,
      operationId: item.operationId,
      seq: item.seq,
      requirement: item.requirement,
      isOutsourced: item.isOutsourced,
    }))
    return {
      name: created.name,
      note: created.note,
      items,
    }
  }
  return {
    title: '工艺模板（mfgProcessTemplates）',
    headResource: 'mfgProcessTemplates',
    authzResources: ['mfgProcessTemplates', 'mfgProcessTemplateItems'],
    headTable: 'mfg_process_template',
    itemTable: 'mfg_process_template_item',
    itemsKey: 'items',
    companyScoped: false,
    prepare: () => ({
      service: asAgg(),
      registry: masterFixture.registry!,
    }),
    companyId: () => '',
    otherCompanyId: () => '',
    validDraft,
    buildDiffReplace: (created) => {
      const items = asItems(created, 'items')
      const kept = items[0]!
      const deleted = items[1]!
      return {
        keptItemId: String(kept.id),
        deletedItemId: String(deleted.id),
        input: {
          ...noopFrom(created),
          note: '合同改-template',
          items: [
            {
              id: kept.id,
              operationId: kept.operationId,
              seq: 11,
              requirement: '保留',
              isOutsourced: false,
            },
            {
              operationId: masterFixture.operation2Id,
              seq: 30,
              requirement: '新增',
              isOutsourced: false,
            },
          ],
        },
      }
    },
    buildNoopReplace: noopFrom,
    buildFailReplace: (created) => ({
      ...noopFrom(created),
      note: '不应落库',
      items: [
        ...asItems(noopFrom(created), 'items'),
        {
          // operationId 缺 → 校验失败
          seq: 99,
          isOutsourced: false,
        },
      ],
    }),
    buildEmptyReplace: (created) => ({
      ...noopFrom(created),
      items: [],
    }),
  }
}

function mfgBomContractCase(): AggregateContractCase {
  const asAgg = (): AggregateService => masterFixture.service!._bomAggregateForContract()
  const validDraft = () => ({
    materialId: masterFixture.materialId,
    planName: '合同方案',
    note: '合同-bom',
    components: [
      {
        materialId: masterFixture.material2Id,
        unitId: masterFixture.unitId,
        quantity: '2',
        lossRate: '0.01',
        note: null,
      },
      {
        materialId: masterFixture.material3Id,
        unitId: masterFixture.unitId,
        quantity: '3',
        lossRate: null,
        note: '行2',
      },
    ],
    routes: [],
    byproducts: [],
  })
  const noopFrom = (created: Record<string, unknown>) => {
    const components = asItems(created, 'components').map((item) => ({
      id: item.id,
      materialId: item.materialId,
      unitId: item.unitId,
      quantity: item.quantity,
      lossRate: item.lossRate,
      note: item.note,
    }))
    const routes = Array.isArray(created.routes)
      ? (created.routes as Array<Record<string, unknown>>).map((item) => ({
          id: item.id,
          operationId: item.operationId,
          seq: item.seq,
          requirement: item.requirement,
          isOutsourced: item.isOutsourced,
        }))
      : []
    const byproducts = Array.isArray(created.byproducts)
      ? (created.byproducts as Array<Record<string, unknown>>).map((item) => ({
          id: item.id,
          materialId: item.materialId,
          unitId: item.unitId,
          quantity: item.quantity,
          note: item.note,
        }))
      : []
    return {
      planName: created.planName,
      note: created.note,
      components,
      routes,
      byproducts,
    }
  }
  return {
    title: 'BOM（mfgBoms）',
    headResource: 'mfgBoms',
    authzResources: [
      'mfgBoms',
      'mfgBomComponents',
      'mfgBomRoutes',
      'mfgBomByproducts',
    ],
    headTable: 'mfg_bom',
    itemTable: 'mfg_bom_component',
    itemsKey: 'components',
    companyScoped: false,
    prepare: () => ({
      service: asAgg(),
      registry: masterFixture.registry!,
    }),
    companyId: () => '',
    otherCompanyId: () => '',
    validDraft,
    buildDiffReplace: (created) => {
      const items = asItems(created, 'components')
      const kept = items[0]!
      const deleted = items[1]!
      return {
        keptItemId: String(kept.id),
        deletedItemId: String(deleted.id),
        input: {
          ...noopFrom(created),
          note: '合同改-bom',
          components: [
            {
              id: kept.id,
              materialId: kept.materialId,
              unitId: kept.unitId,
              quantity: '2.5',
              lossRate: kept.lossRate,
              note: '保留',
            },
            {
              materialId: masterFixture.material3Id,
              unitId: masterFixture.unitId,
              quantity: '1',
              lossRate: null,
              note: null,
            },
          ],
          routes: [],
          byproducts: [],
        },
      }
    },
    buildNoopReplace: noopFrom,
    buildFailReplace: (created) => ({
      ...noopFrom(created),
      note: '不应落库',
      components: [
        ...asItems(noopFrom(created), 'components'),
        {
          materialId: masterFixture.material2Id,
          unitId: masterFixture.unitId,
          quantity: '0',
        },
      ],
      routes: [],
      byproducts: [],
    }),
    buildEmptyReplace: (created) => ({
      ...noopFrom(created),
      components: [],
      routes: [],
      byproducts: [],
    }),
  }
}

// ── 套件 ────────────────────────────────────────────────────────────────────

run('聚合草稿合同（postgres）', () => {
  const db = createDb(url!)
  // 业务 CASES 在 describe 体里就要 prepare——先装服务，数据在 beforeAll 播种
  const sealed = createSealedResourceRegistry()
  const numbering = createNumberingService(db, buildNumberingCatalog(sealed), sealed)
  quotationFixture.registry = sealed
  quotationFixture.service = createQuotationService(db, numbering, sealed)
  purReceiptFixture.registry = sealed
  const fulfillment = createFulfillmentService(
    db,
    numbering,
    { inventory: createInventoryEngine(), gl: createGlEngine() },
    sealed,
  )
  purReceiptFixture.service = fulfillment
  salDeliveryFixture.registry = sealed
  salDeliveryFixture.service = fulfillment
  salReturnFixture.registry = sealed
  salReturnFixture.service = createReturnsService(
    db,
    numbering,
    { inventory: createInventoryEngine(), gl: createGlEngine() },
    sealed,
  )
  orderFixture.registry = sealed
  orderFixture.service = createOrderService(
    db,
    numbering,
    quotationFixture.service,
    sealed,
  )
  reconFixture.registry = sealed
  reconFixture.service = createReconciliationService(
    db,
    numbering,
    createGlEngine(),
    sealed,
  )
  outsourcedFixture.registry = sealed
  outsourcedFixture.service = createOutsourcedService(
    db,
    numbering,
    { inventory: createInventoryEngine(), gl: createGlEngine() },
    sealed,
  )
  demandFixture.registry = sealed
  demandFixture.service = createDemandService(db, numbering, sealed)
  masterFixture.registry = sealed
  masterFixture.service = createMasterService(db, numbering, sealed)

  beforeAll(async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS std_ac_doc (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name varchar(64) NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'draft',
        company_id uuid NOT NULL,
        inserted_at timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
        updated_at timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
      )
    `.execute(db)
    await sql`
      CREATE TABLE IF NOT EXISTS std_ac_item (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        doc_id uuid NOT NULL REFERENCES std_ac_doc(id) ON DELETE CASCADE,
        idx integer NOT NULL,
        qty numeric(18,6) NOT NULL,
        company_id uuid NOT NULL,
        inserted_at timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
        updated_at timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
      )
    `.execute(db)
    await sql`
      CREATE TABLE IF NOT EXISTS std_ac_tier (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        item_id uuid NOT NULL REFERENCES std_ac_item(id) ON DELETE CASCADE,
        min_qty numeric(18,6) NOT NULL,
        price numeric(18,6) NOT NULL,
        company_id uuid NOT NULL,
        inserted_at timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
        updated_at timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
      )
    `.execute(db)

    // 报价业务夹具（sal/pur CASES）
    const f = quotationFixture
    const tag = `AC${suffix}`
    await sql`
      INSERT INTO bas_currency(id,name,iso_code,symbol,active)
      VALUES (${f.currencyId}::uuid, ${tag + '币'}, ${'A' + suffix.slice(0, 2)}, '¤', true)
    `.execute(db)
    await sql`
      INSERT INTO bas_company(id,code,name,short_name,base_currency_id) VALUES
        (${f.companyId}::uuid, ${'A' + suffix}, ${tag + '公司'}, 'AC', ${f.currencyId}::uuid),
        (${f.otherCompanyId}::uuid, ${'B' + suffix}, ${tag + '他司'}, 'AD', ${f.currencyId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO sal_customers(id,code,name,short_name)
      VALUES (${f.customerId}::uuid, ${'CU' + suffix}, ${tag + '客户'}, 'CU')
    `.execute(db)
    await sql`
      INSERT INTO pur_supplier(id,code,name,short_name)
      VALUES (${f.supplierId}::uuid, ${'SU' + suffix}, ${tag + '供应商'}, 'SU')
    `.execute(db)
    await sql`
      INSERT INTO bas_unit(id,unit_type,is_base,name,symbol,ratio)
      VALUES (${f.unitId}::uuid, ${'ac-' + suffix}, true, ${tag + '件'}, ${'ua' + suffix}, 1)
    `.execute(db)
    await sql`
      INSERT INTO inv_material_category(id,code,name,is_leaf,active)
      VALUES (${f.categoryId}::uuid, ${'MC' + suffix}, ${tag + '分类'}, true, true)
    `.execute(db)
    await sql`
      INSERT INTO inv_material(id,code,name,category_id,default_unit_id,active) VALUES
        (${f.materialId}::uuid, ${'M' + suffix}, ${tag + '物料'}, ${f.categoryId}::uuid, ${f.unitId}::uuid, true),
        (${f.material2Id}::uuid, ${'N' + suffix}, ${tag + '物料二'}, ${f.categoryId}::uuid, ${f.unitId}::uuid, true)
    `.execute(db)

    const admin = testActor({
      username: `agg-q-seed-${suffix}`,
      superAdmin: true,
      allCompanies: true,
    })
    const authz = createAuthzEnforcer(sealed)
    const permit = (resource: string, action: string): Permit => {
      const d = authz.decideFor(admin, resource, action)
      if (d.outcome !== 'permit') throw new Error(`seed permit ${resource}:${action}`)
      return d.permit
    }
    for (const [resource, mark] of [
      ['sales.quotation', 'SQ'],
      ['purchase.quotation', 'PQ'],
    ] as const) {
      const existing = await db
        .selectFrom('sys_numbering_rule')
        .select('id')
        .where('resource', '=', resource)
        .where('enabled', '=', true)
        .executeTakeFirst()
      if (!existing) {
        const rule = await numbering.create(permit('sysNumberingRules', 'create'), {
          resource,
          name: `${tag}${mark}规则`,
          segments: [
            { type: 'text', value: `A${suffix}${mark}-` },
            { type: 'seq', padding: 4 },
          ],
          perCompany: false,
          enabled: true,
        })
        f.ruleIds.push(rule.id)
      }
    }
    f.ready = true

    // 采购入库夹具
    const pr = purReceiptFixture
    const prTag = `PR${suffix}`
    await sql`
      INSERT INTO bas_currency(id,name,iso_code,symbol,active)
      VALUES (${pr.currencyId}::uuid, ${prTag + '币'}, ${'R' + suffix.slice(0, 2)}, '¤', true)
    `.execute(db)
    await sql`
      INSERT INTO bas_company(id,code,name,short_name,base_currency_id) VALUES
        (${pr.companyId}::uuid, ${'R' + suffix}, ${prTag + '公司'}, 'PR', ${pr.currencyId}::uuid),
        (${pr.otherCompanyId}::uuid, ${'S' + suffix}, ${prTag + '他司'}, 'PS', ${pr.currencyId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO pur_supplier(id,code,name,short_name)
      VALUES (${pr.supplierId}::uuid, ${'PS' + suffix}, ${prTag + '供应商'}, 'PS')
    `.execute(db)
    await sql`
      INSERT INTO bas_unit(id,unit_type,is_base,name,symbol,ratio)
      VALUES (${pr.unitId}::uuid, ${'pr-' + suffix}, true, ${prTag + '件'}, ${'up' + suffix}, 1)
    `.execute(db)
    await sql`
      INSERT INTO inv_material_category(id,code,name,is_leaf,active)
      VALUES (${pr.categoryId}::uuid, ${'PC' + suffix}, ${prTag + '分类'}, true, true)
    `.execute(db)
    await sql`
      INSERT INTO inv_material(id,code,name,category_id,default_unit_id,active,material_type) VALUES
        (${pr.materialId}::uuid, ${'PM' + suffix}, ${prTag + '物料'}, ${pr.categoryId}::uuid, ${pr.unitId}::uuid, true, 'STOCK'),
        (${pr.material2Id}::uuid, ${'PN' + suffix}, ${prTag + '物料二'}, ${pr.categoryId}::uuid, ${pr.unitId}::uuid, true, 'STOCK')
    `.execute(db)
    await sql`
      INSERT INTO inv_warehouse(id,name,code,company_id,active,is_leaf)
      VALUES (
        ${pr.warehouseId}::uuid, ${prTag + '仓'}, ${'PW' + suffix.slice(0, 8)},
        ${pr.companyId}::uuid, true, true
      )
    `.execute(db)
    await sql`
      INSERT INTO bas_account(id,code,name,direction,is_group,active,company_id,currency_id,role) VALUES
        (${pr.debitAccountId}::uuid, ${'PD' + suffix}, ${prTag + '借'}, 'debit', false, true,
          ${pr.companyId}::uuid, ${pr.currencyId}::uuid, NULL),
        (${pr.creditAccountId}::uuid, ${'PC' + suffix}, ${prTag + '未开应付'}, 'credit', false, true,
          ${pr.companyId}::uuid, ${pr.currencyId}::uuid, 'unbilled_payable')
    `.execute(db)
    await sql`
      INSERT INTO pur_order(id,order_no,order_date,party_type,party_id,status,company_id,
        exchange_rate,currency_id,is_outsourced)
      VALUES (${pr.orderId}::uuid, ${prTag + '-PO'}, '2026-07-20', 'supplier',
        ${pr.supplierId}::uuid, 'audited', ${pr.companyId}::uuid, 1, ${pr.currencyId}::uuid, false)
    `.execute(db)
    await sql`
      INSERT INTO pur_order_item(
        id,idx,qty,base_qty,price,amount,base_price,base_amount,tax_rate,
        order_id,company_id,material_id,unit_id,material_code,material_name,unit_name
      ) VALUES
        (${pr.orderItemId}::uuid,1,1000,1000,8,8000,8,8000,0,${pr.orderId}::uuid,
          ${pr.companyId}::uuid,${pr.materialId}::uuid,${pr.unitId}::uuid,
          ${'PM' + suffix},${prTag + '物料'},${prTag + '件'}),
        (${pr.orderItem2Id}::uuid,2,500,500,8,4000,8,4000,0,${pr.orderId}::uuid,
          ${pr.companyId}::uuid,${pr.material2Id}::uuid,${pr.unitId}::uuid,
          ${'PN' + suffix},${prTag + '物料二'},${prTag + '件'})
    `.execute(db)
    {
      const existing = await db
        .selectFrom('sys_numbering_rule')
        .select('id')
        .where('resource', '=', 'purchase.receipt')
        .where('enabled', '=', true)
        .executeTakeFirst()
      if (!existing) {
        const rule = await numbering.create(permit('sysNumberingRules', 'create'), {
          resource: 'purchase.receipt',
          name: `${prTag}入库规则`,
          segments: [
            { type: 'text', value: `R${suffix}-` },
            { type: 'seq', padding: 4 },
          ],
          perCompany: false,
          enabled: true,
        })
        pr.ruleIds.push(rule.id)
      }
    }
    pr.ready = true

    // 销售发货夹具
    const sd = salDeliveryFixture
    const sdTag = `SD${suffix}`
    await sql`
      INSERT INTO bas_currency(id,name,iso_code,symbol,active)
      VALUES (${sd.currencyId}::uuid, ${sdTag + '币'}, ${'D' + suffix.slice(0, 2)}, '¤', true)
    `.execute(db)
    await sql`
      INSERT INTO bas_company(id,code,name,short_name,base_currency_id) VALUES
        (${sd.companyId}::uuid, ${'D' + suffix}, ${sdTag + '公司'}, 'SD', ${sd.currencyId}::uuid),
        (${sd.otherCompanyId}::uuid, ${'E' + suffix}, ${sdTag + '他司'}, 'SE', ${sd.currencyId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO sal_customers(id,code,name,short_name)
      VALUES (${sd.customerId}::uuid, ${'DC' + suffix}, ${sdTag + '客户'}, 'DC')
    `.execute(db)
    await sql`
      INSERT INTO bas_unit(id,unit_type,is_base,name,symbol,ratio)
      VALUES (${sd.unitId}::uuid, ${'sd-' + suffix}, true, ${sdTag + '件'}, ${'ud' + suffix}, 1)
    `.execute(db)
    await sql`
      INSERT INTO inv_material_category(id,code,name,is_leaf,active)
      VALUES (${sd.categoryId}::uuid, ${'DC' + suffix}, ${sdTag + '分类'}, true, true)
    `.execute(db)
    await sql`
      INSERT INTO inv_material(id,code,name,category_id,default_unit_id,active,material_type) VALUES
        (${sd.materialId}::uuid, ${'DM' + suffix}, ${sdTag + '物料'}, ${sd.categoryId}::uuid, ${sd.unitId}::uuid, true, 'STOCK'),
        (${sd.material2Id}::uuid, ${'DN' + suffix}, ${sdTag + '物料二'}, ${sd.categoryId}::uuid, ${sd.unitId}::uuid, true, 'STOCK')
    `.execute(db)
    await sql`
      INSERT INTO inv_warehouse(id,name,code,company_id,active,is_leaf)
      VALUES (
        ${sd.warehouseId}::uuid, ${sdTag + '仓'}, ${'DW' + suffix.slice(0, 8)},
        ${sd.companyId}::uuid, true, true
      )
    `.execute(db)
    await sql`
      INSERT INTO bas_account(id,code,name,direction,is_group,active,company_id,currency_id,role) VALUES
        (${sd.debitAccountId}::uuid, ${'DD' + suffix}, ${sdTag + '未开应收'}, 'debit', false, true,
          ${sd.companyId}::uuid, ${sd.currencyId}::uuid, 'unbilled_receivable'),
        (${sd.creditAccountId}::uuid, ${'DC' + suffix}, ${sdTag + '贷'}, 'credit', false, true,
          ${sd.companyId}::uuid, ${sd.currencyId}::uuid, NULL)
    `.execute(db)
    await sql`
      INSERT INTO sal_order(id,order_no,order_date,party_type,party_id,status,company_id,
        exchange_rate,currency_id,order_type)
      VALUES (${sd.orderId}::uuid, ${sdTag + '-SO'}, '2026-07-20', 'customer',
        ${sd.customerId}::uuid, 'audited', ${sd.companyId}::uuid, 1, ${sd.currencyId}::uuid, 'sample')
    `.execute(db)
    await sql`
      INSERT INTO sal_order_item(
        id,idx,qty,base_qty,price,amount,base_price,base_amount,tax_rate,
        order_id,company_id,material_id,unit_id,material_code,material_name,unit_name
      ) VALUES
        (${sd.orderItemId}::uuid,1,1000,1000,8,8000,8,8000,0,${sd.orderId}::uuid,
          ${sd.companyId}::uuid,${sd.materialId}::uuid,${sd.unitId}::uuid,
          ${'DM' + suffix},${sdTag + '物料'},${sdTag + '件'}),
        (${sd.orderItem2Id}::uuid,2,500,500,8,4000,8,4000,0,${sd.orderId}::uuid,
          ${sd.companyId}::uuid,${sd.material2Id}::uuid,${sd.unitId}::uuid,
          ${'DN' + suffix},${sdTag + '物料二'},${sdTag + '件'})
    `.execute(db)
    {
      const existing = await db
        .selectFrom('sys_numbering_rule')
        .select('id')
        .where('resource', '=', 'sales.delivery')
        .where('enabled', '=', true)
        .executeTakeFirst()
      if (!existing) {
        const rule = await numbering.create(permit('sysNumberingRules', 'create'), {
          resource: 'sales.delivery',
          name: `${sdTag}发货规则`,
          segments: [
            { type: 'text', value: `D${suffix}-` },
            { type: 'seq', padding: 4 },
          ],
          perCompany: false,
          enabled: true,
        })
        sd.ruleIds.push(rule.id)
      }
    }
    sd.ready = true

    // 销售退货夹具：独立公司 + 已审核销售订单/发货单（两行）作源单锚点
    const rt = salReturnFixture
    const rtTag = `RT${suffix}`
    await sql`
      INSERT INTO bas_currency(id,name,iso_code,symbol,active)
      VALUES (${rt.currencyId}::uuid, ${rtTag + '币'}, ${'T' + suffix.slice(0, 2)}, '¤', true)
    `.execute(db)
    await sql`
      INSERT INTO bas_company(id,code,name,short_name,base_currency_id) VALUES
        (${rt.companyId}::uuid, ${'T' + suffix}, ${rtTag + '公司'}, 'RT', ${rt.currencyId}::uuid),
        (${rt.otherCompanyId}::uuid, ${'U' + suffix}, ${rtTag + '他司'}, 'RU', ${rt.currencyId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO sal_customers(id,code,name,short_name)
      VALUES (${rt.customerId}::uuid, ${'TC' + suffix}, ${rtTag + '客户'}, 'TC')
    `.execute(db)
    await sql`
      INSERT INTO bas_unit(id,unit_type,is_base,name,symbol,ratio)
      VALUES (${rt.unitId}::uuid, ${'rt-' + suffix}, true, ${rtTag + '件'}, ${'ut' + suffix}, 1)
    `.execute(db)
    await sql`
      INSERT INTO inv_material_category(id,code,name,is_leaf,active)
      VALUES (${rt.categoryId}::uuid, ${'TC' + suffix}, ${rtTag + '分类'}, true, true)
    `.execute(db)
    await sql`
      INSERT INTO inv_material(id,code,name,category_id,default_unit_id,active,material_type) VALUES
        (${rt.materialId}::uuid, ${'TM' + suffix}, ${rtTag + '物料'}, ${rt.categoryId}::uuid, ${rt.unitId}::uuid, true, 'STOCK'),
        (${rt.material2Id}::uuid, ${'TN' + suffix}, ${rtTag + '物料二'}, ${rt.categoryId}::uuid, ${rt.unitId}::uuid, true, 'STOCK')
    `.execute(db)
    await sql`
      INSERT INTO inv_warehouse(id,name,code,company_id,active,is_leaf)
      VALUES (
        ${rt.warehouseId}::uuid, ${rtTag + '仓'}, ${'TW' + suffix.slice(0, 8)},
        ${rt.companyId}::uuid, true, true
      )
    `.execute(db)
    await sql`
      INSERT INTO bas_account(id,code,name,direction,is_group,active,company_id,currency_id,role) VALUES
        (${rt.debitAccountId}::uuid, ${'TD' + suffix}, ${rtTag + '借'}, 'debit', false, true,
          ${rt.companyId}::uuid, ${rt.currencyId}::uuid, NULL),
        (${rt.creditAccountId}::uuid, ${'TT' + suffix}, ${rtTag + '未开应收'}, 'credit', false, true,
          ${rt.companyId}::uuid, ${rt.currencyId}::uuid, 'unbilled_receivable')
    `.execute(db)
    await sql`
      INSERT INTO sal_order(id,order_no,order_date,party_type,party_id,status,company_id,
        exchange_rate,currency_id,order_type)
      VALUES (${rt.orderId}::uuid, ${rtTag + '-SO'}, '2026-07-20', 'customer',
        ${rt.customerId}::uuid, 'audited', ${rt.companyId}::uuid, 1, ${rt.currencyId}::uuid, 'regular')
    `.execute(db)
    await sql`
      INSERT INTO sal_order_item(
        id,idx,qty,base_qty,price,amount,base_price,base_amount,tax_rate,
        order_id,company_id,material_id,unit_id,material_code,material_name,unit_name
      ) VALUES
        (${rt.orderItemId}::uuid,1,100,100,10,1000,10,1000,0,${rt.orderId}::uuid,
          ${rt.companyId}::uuid,${rt.materialId}::uuid,${rt.unitId}::uuid,
          ${'TM' + suffix},${rtTag + '物料'},${rtTag + '件'}),
        (${rt.orderItem2Id}::uuid,2,50,50,10,500,10,500,0,${rt.orderId}::uuid,
          ${rt.companyId}::uuid,${rt.material2Id}::uuid,${rt.unitId}::uuid,
          ${'TN' + suffix},${rtTag + '物料二'},${rtTag + '件'})
    `.execute(db)
    await sql`
      INSERT INTO sal_delivery(id,delivery_no,delivery_date,party_type,party_id,status,company_id,
        warehouse_id,debit_account_id,credit_account_id)
      VALUES (${rt.deliveryId}::uuid,${rtTag + '-SD'},'2026-07-25','customer',${rt.customerId}::uuid,
        'audited',${rt.companyId}::uuid,${rt.warehouseId}::uuid,${rt.creditAccountId}::uuid,${rt.debitAccountId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO sal_delivery_item(
        id,idx,qty,base_qty,material_code,material_name,unit_name,order_no,
        order_qty,order_base_qty,order_unit_name,order_price,order_amount,
        order_base_price,order_base_amount,order_tax_rate,order_currency_code,
        delivery_id,company_id,order_item_id,material_id,unit_id,warehouse_id,reconciled_qty
      ) VALUES
        (${rt.deliveryItemId}::uuid,1,100,100,${'TM' + suffix},${rtTag + '物料'},${rtTag + '件'},${rtTag + '-SO'},
          100,100,${rtTag + '件'},10,1000,10,1000,0,${'T' + suffix.slice(0, 2)},
          ${rt.deliveryId}::uuid,${rt.companyId}::uuid,${rt.orderItemId}::uuid,${rt.materialId}::uuid,${rt.unitId}::uuid,${rt.warehouseId}::uuid,0),
        (${rt.deliveryItem2Id}::uuid,2,50,50,${'TN' + suffix},${rtTag + '物料二'},${rtTag + '件'},${rtTag + '-SO'},
          50,50,${rtTag + '件'},10,500,10,500,0,${'T' + suffix.slice(0, 2)},
          ${rt.deliveryId}::uuid,${rt.companyId}::uuid,${rt.orderItem2Id}::uuid,${rt.material2Id}::uuid,${rt.unitId}::uuid,${rt.warehouseId}::uuid,0)
    `.execute(db)
    {
      const existing = await db
        .selectFrom('sys_numbering_rule')
        .select('id')
        .where('resource', '=', 'sales.return')
        .where('enabled', '=', true)
        .executeTakeFirst()
      if (!existing) {
        const rule = await numbering.create(permit('sysNumberingRules', 'create'), {
          resource: 'sales.return',
          name: `${rtTag}退货规则`,
          segments: [
            { type: 'text', value: `T${suffix}-` },
            { type: 'seq', padding: 4 },
          ],
          perCompany: false,
          enabled: true,
        })
        rt.ruleIds.push(rule.id)
      }
    }
    rt.ready = true

    // 订单编号规则（复用 quotation 公司/物料/对手）
    for (const [resource, mark] of [
      ['sales.order', 'SO'],
      ['purchase.order', 'PO'],
    ] as const) {
      const existing = await db
        .selectFrom('sys_numbering_rule')
        .select('id')
        .where('resource', '=', resource)
        .where('enabled', '=', true)
        .executeTakeFirst()
      if (!existing) {
        const rule = await numbering.create(permit('sysNumberingRules', 'create'), {
          resource,
          name: `ORD${suffix}${mark}规则`,
          segments: [
            { type: 'text', value: `O${suffix}${mark}-` },
            { type: 'seq', padding: 4 },
          ],
          perCompany: false,
          enabled: true,
        })
        orderFixture.ruleIds.push(rule.id)
      }
    }
    orderFixture.ready = true

    // 对账夹具：独立公司 + 已审核发货/入库各两行（可对账量充足）
    {
      const rf = reconFixture
      const tag = `RC${suffix}`
      await sql`
        INSERT INTO bas_currency(id,name,iso_code,symbol,active)
        VALUES (${rf.currencyId}::uuid, ${tag + '币'}, ${'Q' + suffix.slice(0, 2)}, '¤', true)
      `.execute(db)
      await sql`
        INSERT INTO bas_company(id,code,name,short_name,base_currency_id) VALUES
          (${rf.companyId}::uuid, ${'RC' + suffix}, ${tag + '公司'}, 'RC', ${rf.currencyId}::uuid),
          (${rf.otherCompanyId}::uuid, ${'RD' + suffix}, ${tag + '他司'}, 'RD', ${rf.currencyId}::uuid)
      `.execute(db)
      await sql`
        INSERT INTO sal_customers(id,code,name,short_name)
        VALUES (${rf.customerId}::uuid, ${'RC' + suffix}, ${tag + '客户'}, 'RC')
      `.execute(db)
      await sql`
        INSERT INTO pur_supplier(id,code,name,short_name)
        VALUES (${rf.supplierId}::uuid, ${'RS' + suffix}, ${tag + '供应商'}, 'RS')
      `.execute(db)
      await sql`
        INSERT INTO bas_unit(id,unit_type,is_base,name,symbol,ratio)
        VALUES (${rf.unitId}::uuid, ${'rc-' + suffix}, true, ${tag + '件'}, ${'ur' + suffix.slice(0, 4)}, 1)
      `.execute(db)
      await sql`
        INSERT INTO inv_material_category(id,code,name,is_leaf,active)
        VALUES (${rf.categoryId}::uuid, ${'RM' + suffix}, ${tag + '分类'}, true, true)
      `.execute(db)
      await sql`
        INSERT INTO inv_material(id,code,name,category_id,default_unit_id,active) VALUES
          (${rf.materialId}::uuid, ${'RM' + suffix}, ${tag + '物料'}, ${rf.categoryId}::uuid, ${rf.unitId}::uuid, true),
          (${rf.material2Id}::uuid, ${'RN' + suffix}, ${tag + '物料二'}, ${rf.categoryId}::uuid, ${rf.unitId}::uuid, true)
      `.execute(db)
      await sql`
        INSERT INTO inv_warehouse(id,name,code,company_id)
        VALUES (${rf.warehouseId}::uuid, ${tag + '仓'}, ${'RW' + suffix}, ${rf.companyId}::uuid)
      `.execute(db)
      await sql`
        INSERT INTO bas_account(id,code,name,direction,is_group,active,company_id,currency_id,role) VALUES
          (${rf.salesDebitId}::uuid, ${'RSD' + suffix}, ${tag + '销借'}, 'debit', false, true, ${rf.companyId}::uuid, ${rf.currencyId}::uuid, NULL),
          (${rf.salesCreditId}::uuid, ${'RSC' + suffix}, ${tag + '未开应收'}, 'credit', false, true, ${rf.companyId}::uuid, ${rf.currencyId}::uuid, 'unbilled_receivable'),
          (${rf.purchaseDebitId}::uuid, ${'RPD' + suffix}, ${tag + '未开应付'}, 'debit', false, true, ${rf.companyId}::uuid, ${rf.currencyId}::uuid, 'unbilled_payable'),
          (${rf.purchaseCreditId}::uuid, ${'RPC' + suffix}, ${tag + '采贷'}, 'credit', false, true, ${rf.companyId}::uuid, ${rf.currencyId}::uuid, NULL)
      `.execute(db)
      const soId = crypto.randomUUID()
      const soi1 = crypto.randomUUID()
      const soi2 = crypto.randomUUID()
      const sdId = crypto.randomUUID()
      await sql`
        INSERT INTO sal_order(id,order_no,order_date,party_type,party_id,status,company_id,exchange_rate,currency_id,order_type)
        VALUES (${soId}::uuid, ${'RSO' + suffix}, '2026-07-20', 'customer', ${rf.customerId}::uuid,
          'audited', ${rf.companyId}::uuid, 1, ${rf.currencyId}::uuid, 'regular')
      `.execute(db)
      await sql`
        INSERT INTO sal_order_item(id,idx,qty,price,amount,order_id,company_id,material_id,unit_id,
          material_code,material_name,unit_name,base_qty) VALUES
          (${soi1}::uuid,1,100,10,1000,${soId}::uuid,${rf.companyId}::uuid,${rf.materialId}::uuid,${rf.unitId}::uuid,
            ${'RM' + suffix},${tag + '物料'},${tag + '件'},100),
          (${soi2}::uuid,2,100,10,1000,${soId}::uuid,${rf.companyId}::uuid,${rf.material2Id}::uuid,${rf.unitId}::uuid,
            ${'RN' + suffix},${tag + '物料二'},${tag + '件'},100)
      `.execute(db)
      await sql`
        INSERT INTO sal_delivery(id,delivery_no,delivery_date,party_type,party_id,status,company_id,
          warehouse_id,debit_account_id,credit_account_id)
        VALUES (${sdId}::uuid,${'RSD' + suffix},'2026-07-25','customer',${rf.customerId}::uuid,
          'audited',${rf.companyId}::uuid,${rf.warehouseId}::uuid,${rf.salesCreditId}::uuid,${rf.salesDebitId}::uuid)
      `.execute(db)
      await sql`
        INSERT INTO sal_delivery_item(
          id,idx,qty,base_qty,material_code,material_name,unit_name,order_no,
          order_qty,order_base_qty,order_unit_name,order_price,order_amount,
          order_base_price,order_base_amount,order_tax_rate,order_currency_code,
          delivery_id,company_id,order_item_id,material_id,unit_id,warehouse_id,reconciled_qty
        ) VALUES
          (${rf.salesDeliveryItemId}::uuid,1,100,100,${'RM' + suffix},${tag + '物料'},${tag + '件'},${'RSO' + suffix},
            100,100,${tag + '件'},10,1000,10,1000,0.13,${'Q' + suffix.slice(0, 2)},
            ${sdId}::uuid,${rf.companyId}::uuid,${soi1}::uuid,${rf.materialId}::uuid,${rf.unitId}::uuid,${rf.warehouseId}::uuid,0),
          (${rf.salesDeliveryItem2Id}::uuid,2,100,100,${'RN' + suffix},${tag + '物料二'},${tag + '件'},${'RSO' + suffix},
            100,100,${tag + '件'},10,1000,10,1000,0.13,${'Q' + suffix.slice(0, 2)},
            ${sdId}::uuid,${rf.companyId}::uuid,${soi2}::uuid,${rf.material2Id}::uuid,${rf.unitId}::uuid,${rf.warehouseId}::uuid,0)
      `.execute(db)
      const poId = crypto.randomUUID()
      const poi1 = crypto.randomUUID()
      const poi2 = crypto.randomUUID()
      const prId = crypto.randomUUID()
      await sql`
        INSERT INTO pur_order(id,order_no,order_date,party_type,party_id,status,company_id,exchange_rate,currency_id,is_outsourced)
        VALUES (${poId}::uuid,${'RPO' + suffix},'2026-07-20','supplier',${rf.supplierId}::uuid,
          'audited',${rf.companyId}::uuid,1,${rf.currencyId}::uuid,false)
      `.execute(db)
      await sql`
        INSERT INTO pur_order_item(id,idx,qty,base_qty,price,amount,order_id,company_id,material_id,unit_id,
          material_code,material_name,unit_name) VALUES
          (${poi1}::uuid,1,100,100,8,800,${poId}::uuid,${rf.companyId}::uuid,${rf.materialId}::uuid,${rf.unitId}::uuid,
            ${'RM' + suffix},${tag + '物料'},${tag + '件'}),
          (${poi2}::uuid,2,100,100,8,800,${poId}::uuid,${rf.companyId}::uuid,${rf.material2Id}::uuid,${rf.unitId}::uuid,
            ${'RN' + suffix},${tag + '物料二'},${tag + '件'})
      `.execute(db)
      await sql`
        INSERT INTO pur_receipt(id,receipt_no,receipt_date,party_type,party_id,status,company_id,
          warehouse_id,debit_account_id,credit_account_id)
        VALUES (${prId}::uuid,${'RPR' + suffix},'2026-07-25','supplier',${rf.supplierId}::uuid,
          'audited',${rf.companyId}::uuid,${rf.warehouseId}::uuid,${rf.purchaseCreditId}::uuid,${rf.purchaseDebitId}::uuid)
      `.execute(db)
      await sql`
        INSERT INTO pur_receipt_item(
          id,idx,qty,base_qty,material_code,material_name,unit_name,order_no,
          order_qty,order_base_qty,order_unit_name,order_price,order_amount,
          order_base_price,order_base_amount,order_tax_rate,order_currency_code,
          receipt_id,company_id,order_item_id,material_id,unit_id,warehouse_id,reconciled_qty
        ) VALUES
          (${rf.purchaseReceiptItemId}::uuid,1,100,100,${'RM' + suffix},${tag + '物料'},${tag + '件'},${'RPO' + suffix},
            100,100,${tag + '件'},8,800,8,800,0.13,${'Q' + suffix.slice(0, 2)},
            ${prId}::uuid,${rf.companyId}::uuid,${poi1}::uuid,${rf.materialId}::uuid,${rf.unitId}::uuid,${rf.warehouseId}::uuid,0),
          (${rf.purchaseReceiptItem2Id}::uuid,2,100,100,${'RN' + suffix},${tag + '物料二'},${tag + '件'},${'RPO' + suffix},
            100,100,${tag + '件'},8,800,8,800,0.13,${'Q' + suffix.slice(0, 2)},
            ${prId}::uuid,${rf.companyId}::uuid,${poi2}::uuid,${rf.material2Id}::uuid,${rf.unitId}::uuid,${rf.warehouseId}::uuid,0)
      `.execute(db)
      for (const [resource, mark] of [
        ['sales.reconciliation', 'SR'],
        ['purchase.reconciliation', 'PR'],
      ] as const) {
        const existing = await db
          .selectFrom('sys_numbering_rule')
          .select('id')
          .where('resource', '=', resource)
          .where('enabled', '=', true)
          .executeTakeFirst()
        if (!existing) {
          const rule = await numbering.create(permit('sysNumberingRules', 'create'), {
            resource,
            name: `RC${suffix}${mark}规则`,
            segments: [
              { type: 'text', value: `R${suffix}${mark}-` },
              { type: 'seq', padding: 4 },
            ],
            perCompany: false,
            enabled: true,
          })
          rf.ruleIds.push(rule.id)
        }
      }
      rf.ready = true
    }

    // 委外发料/入库夹具
    {
      const ox = outsourcedFixture
      const tag = `OX${suffix}`
      await sql`
        INSERT INTO bas_currency(id,name,iso_code,symbol,active)
        VALUES (${ox.currencyId}::uuid, ${tag + '币'}, ${'X' + suffix.slice(0, 2)}, '¤', true)
      `.execute(db)
      await sql`
        INSERT INTO bas_company(id,code,name,short_name,base_currency_id) VALUES
          (${ox.companyId}::uuid, ${'X' + suffix}, ${tag + '公司'}, 'OX', ${ox.currencyId}::uuid),
          (${ox.otherCompanyId}::uuid, ${'Y' + suffix}, ${tag + '他司'}, 'OY', ${ox.currencyId}::uuid)
      `.execute(db)
      await sql`
        INSERT INTO pur_supplier(id,code,name,short_name)
        VALUES (${ox.supplierId}::uuid, ${'XS' + suffix}, ${tag + '供应商'}, 'XS')
      `.execute(db)
      await sql`
        INSERT INTO bas_unit(id,unit_type,is_base,name,symbol,ratio)
        VALUES (${ox.unitId}::uuid, ${'ox-' + suffix}, true, ${tag + '件'}, ${'ux' + suffix}, 1)
      `.execute(db)
      await sql`
        INSERT INTO inv_material_category(id,code,name,is_leaf,active)
        VALUES (${ox.categoryId}::uuid, ${'XC' + suffix}, ${tag + '分类'}, true, true)
      `.execute(db)
      await sql`
        INSERT INTO inv_material(id,code,name,category_id,default_unit_id,active,material_type) VALUES
          (${ox.materialId}::uuid, ${'XM' + suffix}, ${tag + '材料'}, ${ox.categoryId}::uuid, ${ox.unitId}::uuid, true, 'STOCK'),
          (${ox.material2Id}::uuid, ${'XN' + suffix}, ${tag + '材料二'}, ${ox.categoryId}::uuid, ${ox.unitId}::uuid, true, 'STOCK'),
          (${ox.finishedId}::uuid, ${'XF' + suffix}, ${tag + '成品'}, ${ox.categoryId}::uuid, ${ox.unitId}::uuid, true, 'STOCK'),
          (${ox.finished2Id}::uuid, ${'XG' + suffix}, ${tag + '成品二'}, ${ox.categoryId}::uuid, ${ox.unitId}::uuid, true, 'STOCK')
      `.execute(db)
      await sql`
        INSERT INTO inv_warehouse(id,name,code,is_leaf,active,is_outsourced,company_id)
        VALUES (${ox.mainWhId}::uuid, ${tag + '主仓'}, ${'XW' + suffix.slice(0, 8)}, true, true, false, ${ox.companyId}::uuid)
      `.execute(db)
      await sql`
        INSERT INTO inv_warehouse(id,name,code,is_leaf,active,is_outsourced,party_type,party_id,company_id)
        VALUES (${ox.outWhId}::uuid, ${tag + '外协仓'}, ${'XO' + suffix.slice(0, 8)}, true, true, true,
          'supplier', ${ox.supplierId}::uuid, ${ox.companyId}::uuid)
      `.execute(db)
      await sql`
        INSERT INTO bas_account(id,code,name,direction,is_group,active,company_id,currency_id,role) VALUES
          (${ox.debitId}::uuid, ${'XD' + suffix}, ${tag + '借'}, 'debit', false, true,
            ${ox.companyId}::uuid, ${ox.currencyId}::uuid, NULL),
          (${ox.creditId}::uuid, ${'XC' + suffix}, ${tag + '未开应付'}, 'credit', false, true,
            ${ox.companyId}::uuid, ${ox.currencyId}::uuid, 'unbilled_payable')
      `.execute(db)
      await sql`
        INSERT INTO pur_order(id,order_no,order_date,party_type,party_id,status,company_id,
          exchange_rate,currency_id,is_outsourced)
        VALUES (${ox.orderId}::uuid, ${tag + '-PO'}, '2026-07-20', 'supplier',
          ${ox.supplierId}::uuid, 'audited', ${ox.companyId}::uuid, 1, ${ox.currencyId}::uuid, true)
      `.execute(db)
      await sql`
        INSERT INTO pur_order_item(
          id,idx,qty,base_qty,price,amount,base_price,base_amount,tax_rate,
          order_id,company_id,material_id,unit_id,material_code,material_name,unit_name,received_qty
        ) VALUES
          (${ox.orderItemId}::uuid,1,10,10,20,200,20,200,0,${ox.orderId}::uuid,
            ${ox.companyId}::uuid,${ox.finishedId}::uuid,${ox.unitId}::uuid,
            ${'XF' + suffix},${tag + '成品'},${tag + '件'},0),
          (${ox.orderItem2Id}::uuid,2,10,10,20,200,20,200,0,${ox.orderId}::uuid,
            ${ox.companyId}::uuid,${ox.finished2Id}::uuid,${ox.unitId}::uuid,
            ${'XG' + suffix},${tag + '成品二'},${tag + '件'},0)
      `.execute(db)
      await sql`
        INSERT INTO pur_order_item_material(
          id, quantity, issued_qty, order_item_id, company_id, material_id, unit_id
        ) VALUES
          (${ox.orderMaterialId}::uuid, 8, 0, ${ox.orderItemId}::uuid, ${ox.companyId}::uuid, ${ox.materialId}::uuid, ${ox.unitId}::uuid),
          (${ox.orderMaterial2Id}::uuid, 6, 0, ${ox.orderItem2Id}::uuid, ${ox.companyId}::uuid, ${ox.material2Id}::uuid, ${ox.unitId}::uuid)
      `.execute(db)
      for (const resource of ['purchase.outsourced_issue', 'purchase.outsourced_receipt'] as const) {
        const existing = await db
          .selectFrom('sys_numbering_rule')
          .select('id')
          .where('resource', '=', resource)
          .where('enabled', '=', true)
          .executeTakeFirst()
        if (!existing) {
          const rule = await numbering.create(permit('sysNumberingRules', 'create'), {
            resource,
            name: `${tag}${resource}规则`,
            segments: [
              { type: 'text', value: `O${suffix}-` },
              { type: 'seq', padding: 4 },
            ],
            perCompany: false,
            enabled: true,
          })
          ox.ruleIds.push(rule.id)
        }
      }
      ox.ready = true
    }

    // 履约需求单夹具（W5）
    {
      const df = demandFixture
      const tag = `MD${suffix}`
      await sql`
        INSERT INTO bas_currency(id,name,iso_code,symbol,active)
        VALUES (${df.currencyId}::uuid, ${tag + '币'}, ${'M' + suffix.slice(0, 2)}, '¤', true)
      `.execute(db)
      await sql`
        INSERT INTO bas_company(id,code,name,short_name,base_currency_id) VALUES
          (${df.companyId}::uuid, ${'M' + suffix}, ${tag + '公司'}, 'MD', ${df.currencyId}::uuid),
          (${df.otherCompanyId}::uuid, ${'N' + suffix}, ${tag + '他司'}, 'ME', ${df.currencyId}::uuid)
      `.execute(db)
      await sql`
        INSERT INTO bas_unit(id,unit_type,is_base,name,symbol,ratio)
        VALUES (${df.unitId}::uuid, ${'md-' + suffix}, true, ${tag + '件'}, ${'um' + suffix}, 1)
      `.execute(db)
      await sql`
        INSERT INTO inv_material_category(id,code,name,is_leaf,active)
        VALUES (${df.categoryId}::uuid, ${'MD' + suffix}, ${tag + '分类'}, true, true)
      `.execute(db)
      await sql`
        INSERT INTO inv_material(id,code,name,category_id,default_unit_id,active,material_type) VALUES
          (${df.materialId}::uuid, ${'MM' + suffix}, ${tag + '物料'}, ${df.categoryId}::uuid, ${df.unitId}::uuid, true, 'STOCK'),
          (${df.material2Id}::uuid, ${'MN' + suffix}, ${tag + '物料二'}, ${df.categoryId}::uuid, ${df.unitId}::uuid, true, 'STOCK')
      `.execute(db)
      {
        const existing = await db
          .selectFrom('sys_numbering_rule')
          .select('id')
          .where('resource', '=', 'mfg.demand')
          .where('enabled', '=', true)
          .executeTakeFirst()
        if (!existing) {
          const rule = await numbering.create(permit('sysNumberingRules', 'create'), {
            resource: 'mfg.demand',
            name: `${tag}需求规则`,
            segments: [
              { type: 'text', value: `MD${suffix}-` },
              { type: 'seq', padding: 4 },
            ],
            perCompany: false,
            enabled: true,
          })
          df.ruleIds.push(rule.id)
        }
      }
      df.ready = true
    }

    // 工艺模板 / BOM 主数据夹具（W5）
    {
      const mf = masterFixture
      const tag = `MB${suffix}`
      await sql`
        INSERT INTO bas_unit(id,unit_type,is_base,name,symbol,ratio)
        VALUES (${mf.unitId}::uuid, ${'mb-' + suffix}, true, ${tag + '件'}, ${'ub' + suffix}, 1)
      `.execute(db)
      await sql`
        INSERT INTO inv_material_category(id,code,name,is_leaf,active)
        VALUES (${mf.categoryId}::uuid, ${'MB' + suffix}, ${tag + '分类'}, true, true)
      `.execute(db)
      await sql`
        INSERT INTO inv_material(id,code,name,category_id,default_unit_id,active,material_type) VALUES
          (${mf.materialId}::uuid, ${'BA' + suffix}, ${tag + '母料'}, ${mf.categoryId}::uuid, ${mf.unitId}::uuid, true, 'STOCK'),
          (${mf.material2Id}::uuid, ${'BB' + suffix}, ${tag + '子料'}, ${mf.categoryId}::uuid, ${mf.unitId}::uuid, true, 'STOCK'),
          (${mf.material3Id}::uuid, ${'BC' + suffix}, ${tag + '子料二'}, ${mf.categoryId}::uuid, ${mf.unitId}::uuid, true, 'STOCK')
      `.execute(db)
      await sql`
        INSERT INTO mfg_operation(id,code,name,note) VALUES
          (${mf.operationId}::uuid, ${'OA' + suffix}, ${tag + '工序'}, null),
          (${mf.operation2Id}::uuid, ${'OB' + suffix}, ${tag + '工序二'}, null)
      `.execute(db)
      for (const resource of ['mfg.route_template', 'mfg.bom'] as const) {
        const existing = await db
          .selectFrom('sys_numbering_rule')
          .select('id')
          .where('resource', '=', resource)
          .where('enabled', '=', true)
          .executeTakeFirst()
        if (!existing) {
          const rule = await numbering.create(permit('sysNumberingRules', 'create'), {
            resource,
            name: `${tag}${resource}规则`,
            segments: [
              { type: 'text', value: `M${suffix.slice(0, 4)}-` },
              { type: 'seq', padding: 4 },
            ],
            perCompany: false,
            enabled: true,
          })
          mf.ruleIds.push(rule.id)
        }
      }
      mf.ready = true
    }
  })

  afterAll(async () => {
    const f = quotationFixture
    for (const id of [...f.ruleIds, ...orderFixture.ruleIds]) {
      await db.deleteFrom('sys_numbering_rule').where('id', '=', id).execute()
    }
    await sql`DELETE FROM sys_audit_log WHERE company_id=${f.companyId}::uuid`.execute(db)
    await sql`DELETE FROM sal_order WHERE company_id=${f.companyId}::uuid`.execute(db)
    await sql`DELETE FROM pur_order WHERE company_id=${f.companyId}::uuid`.execute(db)
    await sql`DELETE FROM sal_quotation WHERE company_id=${f.companyId}::uuid`.execute(db)
    await sql`DELETE FROM pur_quotation WHERE company_id=${f.companyId}::uuid`.execute(db)
    await sql`
      DELETE FROM inv_material WHERE id IN (${f.materialId}::uuid, ${f.material2Id}::uuid)
    `.execute(db)
    await sql`DELETE FROM inv_material_category WHERE id=${f.categoryId}::uuid`.execute(db)
    await sql`DELETE FROM bas_unit WHERE id=${f.unitId}::uuid`.execute(db)
    await sql`DELETE FROM sal_customers WHERE id=${f.customerId}::uuid`.execute(db)
    await sql`DELETE FROM pur_supplier WHERE id=${f.supplierId}::uuid`.execute(db)
    await sql`
      DELETE FROM bas_company WHERE id IN (${f.companyId}::uuid, ${f.otherCompanyId}::uuid)
    `.execute(db)
    await sql`DELETE FROM bas_currency WHERE id=${f.currencyId}::uuid`.execute(db)

    const pr = purReceiptFixture
    for (const id of pr.ruleIds) {
      await db.deleteFrom('sys_numbering_rule').where('id', '=', id).execute()
    }
    await sql`DELETE FROM sys_audit_log WHERE company_id=${pr.companyId}::uuid`.execute(db)
    await sql`DELETE FROM pur_receipt WHERE company_id=${pr.companyId}::uuid`.execute(db)
    await sql`DELETE FROM pur_order_item WHERE order_id=${pr.orderId}::uuid`.execute(db)
    await sql`DELETE FROM pur_order WHERE id=${pr.orderId}::uuid`.execute(db)
    await sql`DELETE FROM bas_account WHERE company_id=${pr.companyId}::uuid`.execute(db)
    await sql`DELETE FROM inv_warehouse WHERE id=${pr.warehouseId}::uuid`.execute(db)
    await sql`
      DELETE FROM inv_material WHERE id IN (${pr.materialId}::uuid, ${pr.material2Id}::uuid)
    `.execute(db)
    await sql`DELETE FROM inv_material_category WHERE id=${pr.categoryId}::uuid`.execute(db)
    await sql`DELETE FROM bas_unit WHERE id=${pr.unitId}::uuid`.execute(db)
    await sql`DELETE FROM pur_supplier WHERE id=${pr.supplierId}::uuid`.execute(db)
    await sql`
      DELETE FROM bas_company WHERE id IN (${pr.companyId}::uuid, ${pr.otherCompanyId}::uuid)
    `.execute(db)
    await sql`DELETE FROM bas_currency WHERE id=${pr.currencyId}::uuid`.execute(db)

    const sd = salDeliveryFixture
    for (const id of sd.ruleIds) {
      await db.deleteFrom('sys_numbering_rule').where('id', '=', id).execute()
    }
    await sql`DELETE FROM sys_audit_log WHERE company_id=${sd.companyId}::uuid`.execute(db)
    await sql`DELETE FROM sal_delivery WHERE company_id=${sd.companyId}::uuid`.execute(db)
    await sql`DELETE FROM sal_order_item WHERE order_id=${sd.orderId}::uuid`.execute(db)
    await sql`DELETE FROM sal_order WHERE id=${sd.orderId}::uuid`.execute(db)
    await sql`DELETE FROM bas_account WHERE company_id=${sd.companyId}::uuid`.execute(db)
    await sql`DELETE FROM inv_warehouse WHERE id=${sd.warehouseId}::uuid`.execute(db)
    await sql`
      DELETE FROM inv_material WHERE id IN (${sd.materialId}::uuid, ${sd.material2Id}::uuid)
    `.execute(db)
    await sql`DELETE FROM inv_material_category WHERE id=${sd.categoryId}::uuid`.execute(db)
    await sql`DELETE FROM bas_unit WHERE id=${sd.unitId}::uuid`.execute(db)
    await sql`DELETE FROM sal_customers WHERE id=${sd.customerId}::uuid`.execute(db)
    await sql`
      DELETE FROM bas_company WHERE id IN (${sd.companyId}::uuid, ${sd.otherCompanyId}::uuid)
    `.execute(db)
    await sql`DELETE FROM bas_currency WHERE id=${sd.currencyId}::uuid`.execute(db)

    await sql`DELETE FROM sys_audit_log WHERE resource IN ('std_ac_doc', 'std_ac_item', 'std_ac_tier')`.execute(
      db,
    )
    // 委外夹具清理
    {
      const ox = outsourcedFixture
      for (const id of ox.ruleIds) {
        await db.deleteFrom('sys_numbering_rule').where('id', '=', id).execute()
      }
      await sql`DELETE FROM sys_audit_log WHERE company_id=${ox.companyId}::uuid`.execute(db)
      await sql`DELETE FROM pur_outsourced_receipt WHERE company_id=${ox.companyId}::uuid`.execute(db)
      await sql`DELETE FROM pur_outsourced_issue WHERE company_id=${ox.companyId}::uuid`.execute(db)
      await sql`DELETE FROM pur_order_item_material WHERE company_id=${ox.companyId}::uuid`.execute(db)
      await sql`DELETE FROM pur_order_item WHERE order_id=${ox.orderId}::uuid`.execute(db)
      await sql`DELETE FROM pur_order WHERE id=${ox.orderId}::uuid`.execute(db)
      await sql`DELETE FROM bas_account WHERE company_id=${ox.companyId}::uuid`.execute(db)
      await sql`DELETE FROM inv_warehouse WHERE company_id=${ox.companyId}::uuid`.execute(db)
      await sql`
        DELETE FROM inv_material WHERE id IN (
          ${ox.materialId}::uuid, ${ox.material2Id}::uuid, ${ox.finishedId}::uuid, ${ox.finished2Id}::uuid
        )
      `.execute(db)
      await sql`DELETE FROM inv_material_category WHERE id=${ox.categoryId}::uuid`.execute(db)
      await sql`DELETE FROM bas_unit WHERE id=${ox.unitId}::uuid`.execute(db)
      await sql`DELETE FROM pur_supplier WHERE id=${ox.supplierId}::uuid`.execute(db)
      await sql`
        DELETE FROM bas_company WHERE id IN (${ox.companyId}::uuid, ${ox.otherCompanyId}::uuid)
      `.execute(db)
      await sql`DELETE FROM bas_currency WHERE id=${ox.currencyId}::uuid`.execute(db)
    }
    // 对账夹具清理
    {
      const rf = reconFixture
      for (const id of rf.ruleIds) {
        await db.deleteFrom('sys_numbering_rule').where('id', '=', id).execute()
      }
      await sql`DELETE FROM sys_todo WHERE company_id=${rf.companyId}::uuid`.execute(db)
      await sql`DELETE FROM sys_audit_log WHERE company_id=${rf.companyId}::uuid`.execute(db)
      await sql`DELETE FROM sal_reconciliation WHERE company_id=${rf.companyId}::uuid`.execute(db)
      await sql`DELETE FROM pur_reconciliation WHERE company_id=${rf.companyId}::uuid`.execute(db)
      await sql`DELETE FROM sal_delivery WHERE company_id=${rf.companyId}::uuid`.execute(db)
      await sql`DELETE FROM pur_receipt WHERE company_id=${rf.companyId}::uuid`.execute(db)
      await sql`DELETE FROM sal_order WHERE company_id=${rf.companyId}::uuid`.execute(db)
      await sql`DELETE FROM pur_order WHERE company_id=${rf.companyId}::uuid`.execute(db)
      await sql`DELETE FROM bas_account WHERE company_id=${rf.companyId}::uuid`.execute(db)
      await sql`DELETE FROM inv_warehouse WHERE id=${rf.warehouseId}::uuid`.execute(db)
      await sql`DELETE FROM inv_material WHERE id IN (${rf.materialId}::uuid, ${rf.material2Id}::uuid)`.execute(db)
      await sql`DELETE FROM inv_material_category WHERE id=${rf.categoryId}::uuid`.execute(db)
      await sql`DELETE FROM bas_unit WHERE id=${rf.unitId}::uuid`.execute(db)
      await sql`DELETE FROM sal_customers WHERE id=${rf.customerId}::uuid`.execute(db)
      await sql`DELETE FROM pur_supplier WHERE id=${rf.supplierId}::uuid`.execute(db)
      await sql`DELETE FROM bas_company WHERE id IN (${rf.companyId}::uuid, ${rf.otherCompanyId}::uuid)`.execute(db)
      await sql`DELETE FROM bas_currency WHERE id=${rf.currencyId}::uuid`.execute(db)
    }

    // 履约需求单夹具清理
    {
      const df = demandFixture
      for (const id of df.ruleIds) {
        await db.deleteFrom('sys_numbering_rule').where('id', '=', id).execute()
      }
      await sql`DELETE FROM sys_audit_log WHERE company_id=${df.companyId}::uuid`.execute(db)
      await sql`DELETE FROM mfg_demand WHERE company_id=${df.companyId}::uuid`.execute(db)
      await sql`
        DELETE FROM inv_material WHERE id IN (${df.materialId}::uuid, ${df.material2Id}::uuid)
      `.execute(db)
      await sql`DELETE FROM inv_material_category WHERE id=${df.categoryId}::uuid`.execute(db)
      await sql`DELETE FROM bas_unit WHERE id=${df.unitId}::uuid`.execute(db)
      await sql`
        DELETE FROM bas_company WHERE id IN (${df.companyId}::uuid, ${df.otherCompanyId}::uuid)
      `.execute(db)
      await sql`DELETE FROM bas_currency WHERE id=${df.currencyId}::uuid`.execute(db)
    }

    // 工艺模板 / BOM 主数据夹具清理（按本夹具主键/命名前缀收口，勿全表扫）
    {
      const mf = masterFixture
      for (const id of mf.ruleIds) {
        await db.deleteFrom('sys_numbering_rule').where('id', '=', id).execute()
      }
      // 子表 ON DELETE CASCADE
      await sql`
        DELETE FROM mfg_bom WHERE material_id IN (
          ${mf.materialId}::uuid, ${mf.material2Id}::uuid, ${mf.material3Id}::uuid
        )
      `.execute(db)
      await sql`
        DELETE FROM mfg_process_template WHERE name LIKE ${'%' + suffix + '%'}
      `.execute(db)
      await sql`
        DELETE FROM mfg_operation WHERE id IN (${mf.operationId}::uuid, ${mf.operation2Id}::uuid)
      `.execute(db)
      await sql`
        DELETE FROM inv_material WHERE id IN (
          ${mf.materialId}::uuid, ${mf.material2Id}::uuid, ${mf.material3Id}::uuid
        )
      `.execute(db)
      await sql`DELETE FROM inv_material_category WHERE id=${mf.categoryId}::uuid`.execute(db)
      await sql`DELETE FROM bas_unit WHERE id=${mf.unitId}::uuid`.execute(db)
    }

    await sql`DROP TABLE IF EXISTS std_ac_tier`.execute(db)
    await sql`DROP TABLE IF EXISTS std_ac_item`.execute(db)
    await sql`DROP TABLE IF EXISTS std_ac_doc`.execute(db)
    await db.destroy()
  })

  async function auditCount(table: string, recordId: string, actionType: string): Promise<number> {
    const rows = await db
      .selectFrom('sys_audit_log')
      .select('id')
      .where('resource', '=', table)
      .where('record_id', '=', recordId)
      .where('action_type', '=', actionType)
      .execute()
    return rows.length
  }

  for (const c of CASES) {
    describe(c.title, () => {
      const { service, registry } = c.prepare(db)
      const authz = createAuthzEnforcer(registry)
      const admin = testActor({
        // 空 userId → created_by_id 落 null，避免业务表 FK 指向不存在的 sys_user
        userId: '',
        username: `agg-contract-${suffix}`,
        superAdmin: true,
        allCompanies: true,
      })

      function permitOf(actor: Actor, resource: string, action: string): Permit {
        const decision = authz.decideFor(actor, resource, action)
        if (decision.outcome !== 'permit') {
          throw new Error(`夹具应当 permit：${resource}:${action}`)
        }
        return decision.permit
      }

      const p = (action: string) => permitOf(admin, c.headResource, action)

      test('无授权 actor 决策层即 deny（fail-closed）', () => {
        const nobody = testActor({ username: `agg-nobody-${suffix}` })
        for (const resource of c.authzResources) {
          for (const action of ['read', 'create', 'update', 'delete']) {
            expect(authz.decideFor(nobody, resource, action).outcome).not.toBe('permit')
          }
        }
      })

      test('createDraft：整单落库；头与子行 create 审计', async () => {
        const created = await service.createDraft(p('create'), c.validDraft())
        expect(created.id).toBeTruthy()
        expect(await auditCount(c.headTable, String(created.id), 'create')).toBe(1)

        const items = asItems(created, c.itemsKey)
        expect(items.length).toBeGreaterThanOrEqual(2)
        for (const item of items) {
          expect(await auditCount(c.itemTable, String(item.id), 'create')).toBe(1)
        }
        if (c.nested) {
          const nestedRows = items.flatMap((item) => {
            const nested = item[c.nested!.key]
            return Array.isArray(nested) ? (nested as Array<Record<string, unknown>>) : []
          })
          expect(nestedRows.length).toBeGreaterThanOrEqual(1)
          for (const row of nestedRows) {
            expect(await auditCount(c.nested.table, String(row.id), 'create')).toBe(1)
          }
        }

        const loaded = await service.loadDraft(p('read'), String(created.id))
        expect(loaded.id).toBe(created.id)
        expect(asItems(loaded, c.itemsKey).length).toBe(items.length)
      })

      test('replaceDraft：缺失即删 + 逐行审计三型（改/删/增）', async () => {
        const created = await service.createDraft(p('create'), c.validDraft())
        const { input, keptItemId, deletedItemId } = c.buildDiffReplace(created)

        const replaced = await service.replaceDraft(p('update'), String(created.id), input)
        expect(await auditCount(c.headTable, String(created.id), 'update')).toBe(1)
        expect(await auditCount(c.itemTable, keptItemId, 'update')).toBe(1)
        expect(await auditCount(c.itemTable, deletedItemId, 'destroy')).toBe(1)

        const items = asItems(replaced, c.itemsKey)
        expect(items.some((i) => String(i.id) === keptItemId)).toBe(true)
        expect(items.some((i) => String(i.id) === deletedItemId)).toBe(false)
        const added = items.find((i) => String(i.id) !== keptItemId)
        expect(added).toBeTruthy()
        expect(await auditCount(c.itemTable, String(added!.id), 'create')).toBe(1)
      })

      test('replaceDraft：显式空集合 = 删全部子行（权威快照）', async () => {
        const created = await service.createDraft(p('create'), c.validDraft())
        const itemIds = asItems(created, c.itemsKey).map((i) => String(i.id))
        expect(itemIds.length).toBeGreaterThanOrEqual(1)

        const emptied = await service.replaceDraft(
          p('update'),
          String(created.id),
          c.buildEmptyReplace(created),
        )
        expect(asItems(emptied, c.itemsKey)).toEqual([])
        for (const id of itemIds) {
          expect(await auditCount(c.itemTable, id, 'destroy')).toBe(1)
        }
      })

      test('缺集合键 fail-closed（不把缺字段当空删 · 暂态空对偶）', async () => {
        const created = await service.createDraft(p('create'), c.validDraft())
        const itemCountBefore = asItems(created, c.itemsKey).length
        const omit: Record<string, unknown> = {
          name: created.name,
          companyId: created.companyId,
        }
        // 故意不带 c.itemsKey

        await expect(
          service.replaceDraft(p('update'), String(created.id), omit),
        ).rejects.toMatchObject({
          code: 'validation',
          fields: { [c.itemsKey]: ['必须显式提交数组'] },
        })

        const reloaded = await service.loadDraft(p('read'), String(created.id))
        expect(asItems(reloaded, c.itemsKey).length).toBe(itemCountBefore)
        expect(await auditCount(c.headTable, String(created.id), 'update')).toBe(0)
      })

      test('replaceDraft：任一行失败整单回滚（原子性）', async () => {
        const created = await service.createDraft(p('create'), c.validDraft())
        const nameBefore = created.name
        const itemsBefore = asItems(created, c.itemsKey)
        const qtyBefore = itemsBefore[0]!.qty

        await expect(
          service.replaceDraft(p('update'), String(created.id), c.buildFailReplace(created)),
        ).rejects.toThrow()

        const reloaded = await service.loadDraft(p('read'), String(created.id))
        expect(reloaded.name).toBe(nameBefore)
        const items = asItems(reloaded, c.itemsKey)
        expect(items.length).toBe(itemsBefore.length)
        expect(items[0]!.qty).toBe(qtyBefore)
        expect(await auditCount(c.headTable, String(created.id), 'update')).toBe(0)
      })

      test('replaceDraft：无差异不落库不审计', async () => {
        const created = await service.createDraft(p('create'), c.validDraft())
        const item0 = asItems(created, c.itemsKey)[0]!
        await service.replaceDraft(p('update'), String(created.id), c.buildNoopReplace(created))
        expect(await auditCount(c.headTable, String(created.id), 'update')).toBe(0)
        expect(await auditCount(c.itemTable, String(item0.id), 'update')).toBe(0)
      })

      test('公司创建后不可改', async () => {
        if (c.companyScoped === false) return
        const created = await service.createDraft(p('create'), c.validDraft())
        const noop = c.buildNoopReplace(created)
        await expect(
          service.replaceDraft(p('update'), String(created.id), {
            ...noop,
            companyId: c.otherCompanyId(),
          }),
        ).rejects.toMatchObject({
          code: 'validation',
          fields: { companyId: ['创建后不可修改公司'] },
        })
        const reloaded = await service.loadDraft(p('read'), String(created.id))
        expect(reloaded.companyId).toBe(c.companyId())
      })
    })
  }
})
