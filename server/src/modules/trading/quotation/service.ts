/**
 * 销售/采购报价单：头/条目/价格档 + 订单套档解析。
 * 行为对齐 server-go/internal/domain/trading/quotation。
 *
 * 单头走标准动作内核（platform/standard）：get / list / remove + workflow 两转移
 * （audit/void）。转移取代 posting/skeleton 的 flipDocStatusInTx——effect 只做
 * 「条目非空 + 数量梯度条目必有价格档」的领域校验，状态翻转/盖章/审计交内核。
 *
 * 按动作弹射（原因见 docs/migration/standard-migration-decisions.md）：
 * - 头/条目/价格档的 create/update/delete：本资源的创建与更新 wire 是**整单聚合**
 *   （POST `/` 与 PUT `/:id` 一次提交头+条目+档位，测试钉死「任一子记录失败不残留」），
 *   内核动作各自 `withTx` 开事务且只收 Permit，无法在同一事务内组合；故保留在途手写
 *   实现（`*InTx`），单行端点是其 `withTx` 包装——一份实现两个入口，不引入第二套语义。
 * - 价格档是孙级资源（头 → 条目 → 价格档）：子行内核只有一层，且草稿门要读到祖父单头。
 *
 * 字段映射与审计快照一律由 meta 派生（platform/standard/fields 的 mapRow/snapshot），
 * 读投影的物理列亦按 meta 拼装——meta 是唯一事实源。
 *
 * 授权全由平台承担：路由挂 `guard(资源, 动作)`，本服务只收 Permit——
 * 列表 `listAuthorized`、单条 `loadAuthorizedFrom`（与列表共用投影）、
 * 写前取行/加锁 `loadAuthorized(forUpdate)`、create 走 `assertCompanyWritable`。
 * 模块内零鉴权代码；草稿门/有效期/对手一致等状态前置条件是领域不变量，留此处抛 conflict。
 */
import type { ListQuery } from '@synie/shared'
import { decimal, type Decimal } from '@synie/shared'
import { sql, type RawBuilder } from 'kysely'
import type { Kysely } from 'kysely'
import { withReadSnapshot, withTx, type DbHandle, type TrxHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import { auditCreated, auditDestroyed, auditDiff, writeAudit } from '~/platform/audit/write.ts'
import { auditFieldsOf } from '~/platform/audit/spec.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { AuthzTarget } from '~/platform/meta/resource-authz.ts'
import type { ResourceMeta } from '~/platform/meta/types.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import { mapRow, physicalFields, snapshot } from '~/platform/standard/fields.ts'
import {
  auditStamp,
  createStandardService,
  type StandardService,
} from '~/platform/standard/service.ts'
import { listAuthorized } from '~/db/list.ts'
import { assertCompanyWritable, loadAuthorized, loadAuthorizedFrom } from '~/db/load.ts'
import { mapWriteError, type PgWriteMapping } from '~/db/dberr.ts'
import {
  asDate,
  codeNamedRef,
  guardCustomerMaterial,
  guardMaterialType,
  ident,
  loadMaterialSnap,
  lowerParty,
  namedRef,
  partyExists,
  runeLen,
  toDateOnly,
  type TradingSide,
  upperStatus,
  wireRequiredDecimal,
} from '../common.ts'
import { utcToday } from '~/db/dates.ts'
import { quotationSpec, type QuotationSideSpec } from './spec.ts'

/**
 * 三条读路径的投影常量：列表、单条 get、写后 reload 共用同一份 source/select，
 * 别名只有一处可写错。**别名必须与 source 子查询的 `) x` 逐字一致**——
 * 写错不报错也不 typecheck，via 链会静默把行集算成空。
 */
const HEAD_ALIAS = 'quotation_heads'
const ITEM_ALIAS = 'quotation_items'
const TIER_ALIAS = 'quotation_tiers'

/** 投影附加列（物理列由 meta 派生，此处只列 join/聚合出来的） */
const HEAD_EXTRA = sql`company_name,currency_code,currency_name,created_by_name,audited_by_name`
const ITEM_EXTRA = sql`tier_count,quotation_date,valid_until,quotation_status,party_type,
  currency_code,currency_id,quotation_no,company_name,material_live_name,unit_live_name`
const TIER_EXTRA = sql`company_name`

function headSource(spec: QuotationSideSpec) {
  return sql` FROM (
    SELECT q.id,q.quotation_no,q.quotation_date,q.valid_until,q.party_type,q.party_id,
      q.terms,q.remarks,q.status,q.audited_at,q.inserted_at,q.updated_at,q.company_id,
      q.currency_id,q.created_by_id,q.audited_by_id,c.name AS company_name,
      cur.iso_code AS currency_code,cur.name AS currency_name,
      creator.name AS created_by_name,auditor.name AS audited_by_name
    FROM ${ident(spec.headTable)} q
    JOIN bas_company c ON c.id=q.company_id
    JOIN bas_currency cur ON cur.id=q.currency_id
    LEFT JOIN sys_user creator ON creator.id=q.created_by_id
    LEFT JOIN sys_user auditor ON auditor.id=q.audited_by_id
  ) quotation_heads`
}

function itemSource(spec: QuotationSideSpec) {
  return sql` FROM (
    SELECT i.id,i.idx,i.pricing_mode,i.price,i.tax_rate,i.material_code,i.material_name,
      i.material_spec,i.customer_part_no,i.unit_name,i.remarks,i.inserted_at,i.updated_at,
      i.quotation_id,i.company_id,i.material_id,i.unit_id,
      (SELECT count(*) FROM ${ident(spec.tierTable)} t WHERE t.item_id=i.id)::bigint AS tier_count,
      q.quotation_date,q.valid_until,q.status AS quotation_status,q.party_type,q.party_id,
      cur.iso_code AS currency_code,q.currency_id,q.quotation_no,c.name AS company_name,
      m.name AS material_live_name,u.name AS unit_live_name
    FROM ${ident(spec.itemTable)} i
    JOIN ${ident(spec.headTable)} q ON q.id=i.quotation_id
    JOIN bas_company c ON c.id=i.company_id
    JOIN bas_currency cur ON cur.id=q.currency_id
    JOIN inv_material m ON m.id=i.material_id
    JOIN bas_unit u ON u.id=i.unit_id
  ) quotation_items`
}

function tierSource(spec: QuotationSideSpec) {
  return sql` FROM (
    SELECT t.id,t.min_qty,t.price,t.inserted_at,t.updated_at,t.item_id,t.company_id,
      c.name AS company_name
    FROM ${ident(spec.tierTable)} t
    JOIN bas_company c ON c.id=t.company_id
  ) quotation_tiers`
}

/** 物理列自 meta 派生（与内核 SELECT 拼装同口径），附加列跟在其后 */
function selectOf(meta: ResourceMeta, extra: RawBuilder<unknown>): RawBuilder<unknown> {
  const cols = sql.join(physicalFields(meta).map((f) => sql.id(f.dbColumn)))
  return sql`SELECT ${cols}, ${extra}`
}

const QUOTATION_WRITE_ERRORS: readonly PgWriteMapping[] = [
  { code: '23505', constraint: 'quotation_unique_quotation_no', message: '报价单号已存在' },
  {
    code: '23505',
    constraint: 'quotation_item_unique_material_unit',
    message: '同一物料与单位在本报价单已有报价行',
  },
  {
    code: '23505',
    constraint: 'quotation_tier_unique_item_min_qty',
    message: '同一起订量档已存在',
  },
  { code: '23505', message: '报价数据已存在' },
  { code: '23503', message: '报价数据已被业务引用,不可删除' },
]

export interface Quotation {
  id: string
  quotationNo: string
  quotationDate: string
  validUntil: string
  partyType: string
  partyId: string
  terms: string | null
  remarks: string | null
  status: string
  auditedAt: Date | null
  insertedAt: Date
  updatedAt: Date
  companyId: string
  currencyId: string
  createdById: string | null
  auditedById: string | null
  company: { id: string; name: string }
  currency: { id: string; code: string; name: string }
  createdBy: { id: string; name: string } | null
  auditedBy: { id: string; name: string } | null
  [key: string]: unknown
}

export interface QuotationItem {
  id: string
  idx: number
  pricingMode: string
  price: string | null
  taxRate: string
  materialCode: string
  materialName: string
  materialSpec: string | null
  customerPartNo: string | null
  unitName: string
  remarks: string | null
  insertedAt: Date
  updatedAt: Date
  quotationId: string
  companyId: string
  materialId: string
  unitId: string
  tierCount: number
  quotationDate: string
  validUntil: string
  quotationStatus: string
  partyType: string
  partyId: string
  currencyCode: string
  quotation: { id: string; quotationNo: string }
  company: { id: string; name: string }
  material: { id: string; code: string; name: string }
  unit: { id: string; name: string }
  [key: string]: unknown
}

export interface QuotationTier {
  id: string
  minQty: string
  price: string
  insertedAt: Date
  updatedAt: Date
  itemId: string
  companyId: string
  company: { id: string; name: string }
  [key: string]: unknown
}

export interface QuotationHeadCreateInput {
  companyId: string
  quotationNo?: string | null
  quotationDate?: string | null
  validUntil: string
  partyType: string
  partyId: string
  currencyId?: string | null
  terms?: string | null
  remarks?: string | null
}

export interface QuotationHeadUpdateInput {
  quotationNo?: string
  quotationDate?: string
  validUntil?: string
  partyType?: string
  partyId?: string
  currencyId?: string
  terms?: string | null
  termsPresent?: boolean
  remarks?: string | null
  remarksPresent?: boolean
}

export interface QuotationItemCreateInput {
  quotationId: string
  idx: number
  materialId: string
  unitId: string
  pricingMode?: string
  price?: string | null
  taxRate?: string | null
  remarks?: string | null
}

export interface QuotationItemUpdateInput {
  idx?: number
  materialId?: string
  unitId?: string
  pricingMode?: string
  price?: string | null
  pricePresent?: boolean
  taxRate?: string
  remarks?: string | null
  remarksPresent?: boolean
}

export interface QuotationDraftTierInput {
  id?: string
  minQty: string
  price: string
}

export interface QuotationDraftItemInput
  extends Omit<QuotationItemCreateInput, 'quotationId'> {
  id?: string
  tiers: QuotationDraftTierInput[]
}

export interface QuotationDraftInput extends QuotationHeadCreateInput {
  items: QuotationDraftItemInput[]
}

export type QuotationSavedDraft = Quotation & {
  items: Array<QuotationItem & { tiers: QuotationTier[] }>
}

export interface ResolveOrderInput {
  quotationItemId: string
  orderDate: string
  companyId: string
  partyType: string
  partyId: string
  currencyId: string
  qty: Decimal | string
}

export interface ResolveOrderResult {
  materialId: string
  unitId: string
  price: Decimal
  taxRate: Decimal
}

type Numberer = Pick<NumberingService, 'nextInTx'>

/** 单侧装配：meta / 审计白名单 / 投影 / 判定归宿 / 内核单头服务 */
interface SideCtx {
  spec: QuotationSideSpec
  headMeta: ResourceMeta
  itemMeta: ResourceMeta
  tierMeta: ResourceMeta
  headAudit: readonly string[]
  itemAudit: readonly string[]
  tierAudit: readonly string[]
  headSelect: RawBuilder<unknown>
  itemSelect: RawBuilder<unknown>
  tierSelect: RawBuilder<unknown>
  headFrom: RawBuilder<unknown>
  itemFrom: RawBuilder<unknown>
  tierFrom: RawBuilder<unknown>
  headTarget: AuthzTarget
  itemTarget: AuthzTarget
  tierTarget: AuthzTarget
  heads: StandardService<Quotation>
}

export function createQuotationService(
  db: Kysely<Database>,
  numberer: Numberer,
  registry: Registry,
) {
  /** 判定归宿/meta 按 side 预解析（Registry 内已记忆化）；资源名唯一事实源是 spec */
  const sides: Record<TradingSide, SideCtx> = {
    sales: buildSide('sales'),
    purchase: buildSide('purchase'),
  }

  function metaOf(name: string): ResourceMeta {
    const meta = registry.get(name)
    if (!meta) throw new Error(`报价服务：未知 Meta 资源 ${name}`)
    return meta
  }

  function buildSide(side: TradingSide): SideCtx {
    const spec = quotationSpec(side)
    const headMeta = metaOf(spec.headResource)
    const itemMeta = metaOf(spec.itemResource)
    const tierMeta = metaOf(spec.tierResource)
    const headFrom = headSource(spec)
    /**
     * 单头内核：get/list/remove + audit/void 两转移。
     * 「仅草稿可修改或删除」由 workflow.mutableStatuses 缺省（DRAFT）承担，
     * 文案逐字冻结；create/update 弹射（见文件头）故不声明写钩子。
     */
    const heads = createStandardService<Quotation>({
      db,
      registry,
      resource: spec.headResource,
      notFound: `${spec.label}不存在`,
      defaultOrder: sql`"quotation_date" DESC, "id" ASC`,
      writeErrors: QUOTATION_WRITE_ERRORS,
      projection: {
        source: headFrom,
        alias: HEAD_ALIAS,
        selectExtra: HEAD_EXTRA,
        mapExtra: headExtras,
      },
      workflow: {
        mutableMessage: '仅草稿报价单可修改或删除',
        transitions: [
          {
            key: 'audit',
            label: '审核',
            from: ['DRAFT'],
            to: 'AUDITED',
            guardMessage: '仅草稿报价单可审核',
            stamps: ({ permit }) => auditStamp(permit),
            effect: async (trx, { before }) => {
              await assertAuditable(trx, spec, String(before.id))
            },
          },
          {
            key: 'void',
            label: '作废',
            from: ['AUDITED'],
            to: 'VOIDED',
            guardMessage: '仅已审核报价单可作废',
          },
        ],
      },
    })
    return {
      spec,
      headMeta,
      itemMeta,
      tierMeta,
      headAudit: auditFieldsOf(headMeta),
      itemAudit: auditFieldsOf(itemMeta),
      tierAudit: auditFieldsOf(tierMeta),
      headSelect: selectOf(headMeta, HEAD_EXTRA),
      itemSelect: selectOf(itemMeta, ITEM_EXTRA),
      tierSelect: selectOf(tierMeta, TIER_EXTRA),
      headFrom,
      itemFrom: itemSource(spec),
      tierFrom: tierSource(spec),
      headTarget: registry.authzTarget(spec.headResource),
      itemTarget: registry.authzTarget(spec.itemResource),
      tierTarget: registry.authzTarget(spec.tierResource),
      heads,
    }
  }

  /** 审核前置：条目非空 + 数量梯度条目必须有价格档（内核转移 effect） */
  async function assertAuditable(
    trx: TrxHandle,
    spec: QuotationSideSpec,
    id: string,
  ): Promise<void> {
    const count = await sql<{ c: string }>`
      SELECT count(*)::text AS c FROM ${ident(spec.itemTable)} WHERE quotation_id=${id}::uuid
    `.execute(trx)
    if (Number(count.rows[0]?.c ?? 0) === 0) {
      throw new ApiError('conflict', '审核前必须至少填写一行条目')
    }
    const missing = await sql<{ e: boolean }>`
      SELECT EXISTS(
        SELECT 1 FROM ${ident(spec.itemTable)} i
        WHERE i.quotation_id=${id}::uuid AND i.pricing_mode='qty_tiered'
          AND NOT EXISTS(SELECT 1 FROM ${ident(spec.tierTable)} t WHERE t.item_id=i.id)
      ) AS e
    `.execute(trx)
    if (missing.rows[0]?.e) {
      throw new ApiError('conflict', '数量梯度条目必须至少填写一个价格档')
    }
  }

  // ─── 投影读取（写后 reload 与聚合草稿共用；授权已在上游完成） ─────────

  async function loadHeadRow(
    handle: DbHandle,
    ctx: SideCtx,
    id: string,
  ): Promise<Record<string, unknown> | undefined> {
    const rows = await sql<Record<string, unknown>>`
      ${ctx.headSelect}${ctx.headFrom} WHERE quotation_heads.id=${id}::uuid
    `.execute(handle)
    return rows.rows[0]
  }

  async function loadItemRow(
    handle: DbHandle,
    ctx: SideCtx,
    id: string,
  ): Promise<Record<string, unknown> | undefined> {
    const rows = await sql<Record<string, unknown>>`
      ${ctx.itemSelect}${ctx.itemFrom} WHERE quotation_items.id=${id}::uuid
    `.execute(handle)
    return rows.rows[0]
  }

  async function loadTierRow(
    handle: DbHandle,
    ctx: SideCtx,
    id: string,
  ): Promise<Record<string, unknown> | undefined> {
    const rows = await sql<Record<string, unknown>>`
      ${ctx.tierSelect}${ctx.tierFrom} WHERE quotation_tiers.id=${id}::uuid
    `.execute(handle)
    return rows.rows[0]
  }

  async function loadItemRowsForQuotation(
    handle: DbHandle,
    ctx: SideCtx,
    quotationId: string,
  ): Promise<Record<string, unknown>[]> {
    const rows = await sql<Record<string, unknown>>`
      ${ctx.itemSelect}${ctx.itemFrom}
      WHERE quotation_items.quotation_id=${quotationId}::uuid
      ORDER BY quotation_items.idx,quotation_items.id
    `.execute(handle)
    return rows.rows
  }

  async function loadTierRowsForQuotation(
    handle: DbHandle,
    ctx: SideCtx,
    quotationId: string,
  ): Promise<Record<string, unknown>[]> {
    const rows = await sql<Record<string, unknown>>`
      SELECT t.id,t.min_qty,t.price,t.inserted_at,t.updated_at,t.item_id,t.company_id,
        c.name AS company_name
      FROM ${ident(ctx.spec.tierTable)} t
      JOIN ${ident(ctx.spec.itemTable)} i ON i.id=t.item_id
      JOIN bas_company c ON c.id=t.company_id
      WHERE i.quotation_id=${quotationId}::uuid
      ORDER BY i.idx,t.min_qty,t.id
    `.execute(handle)
    return rows.rows
  }

  function mapHead(ctx: SideCtx, row: Record<string, unknown>): Quotation {
    return { ...mapRow(ctx.headMeta, row), ...headExtras(row) } as Quotation
  }

  function mapItem(ctx: SideCtx, row: Record<string, unknown>): QuotationItem {
    return { ...mapRow(ctx.itemMeta, row), ...itemExtras(row) } as unknown as QuotationItem
  }

  function mapTier(ctx: SideCtx, row: Record<string, unknown>): QuotationTier {
    return { ...mapRow(ctx.tierMeta, row), ...tierExtras(row) } as unknown as QuotationTier
  }

  // ─── 单头写路径（弹射：整单聚合要求单事务，见文件头） ────────────────

  /** 按 Permit 锁裸表头行（授权 + FOR UPDATE），再取 join 投影（子查询不能 FOR UPDATE） */
  async function lockHead(
    handle: DbHandle,
    permit: Permit,
    side: TradingSide,
    id: string,
  ): Promise<Record<string, unknown>> {
    const ctx = sides[side]
    await loadAuthorized({
      db: handle,
      permit,
      target: ctx.headTarget,
      table: ctx.spec.headTable,
      id,
      forUpdate: true,
      notFoundMessage: `${ctx.spec.label}不存在`,
    })
    return (await loadHeadRow(handle, ctx, id))!
  }

  /** 锁草稿单头：条目/价格档编辑与整单替换的公共前置（授权 → 状态守卫） */
  async function lockDraftHead(
    handle: DbHandle,
    permit: Permit,
    side: TradingSide,
    id: string,
    child: '' | 'item' | 'tier',
  ): Promise<Record<string, unknown>> {
    const row = await lockHead(handle, permit, side, id)
    if (String(row.status).toLowerCase() !== 'draft') {
      let message = '仅草稿报价单可修改或删除'
      if (child === 'item') message = '仅草稿报价单可编辑条目'
      if (child === 'tier') message = '仅草稿报价单可编辑价格档'
      throw new ApiError('conflict', message)
    }
    return row
  }

  /** 条目的母单：条目不存在与母单不可达同为 not_found；加锁顺序母单先行 */
  async function itemParent(
    trx: TrxHandle,
    permit: Permit,
    side: TradingSide,
    itemId: string,
  ): Promise<Record<string, unknown>> {
    const ctx = sides[side]
    const existing = await sql<{ quotation_id: string }>`
      SELECT quotation_id FROM ${ident(ctx.spec.itemTable)} WHERE id=${itemId}::uuid
    `.execute(trx)
    if (!existing.rows[0]) throw new ApiError('not_found', '报价条目不存在')
    return lockDraftHead(trx, permit, side, existing.rows[0].quotation_id, 'item')
  }

  /** 母单锁定后再锁子行（顺序固定：母单 → 子行） */
  async function lockChildRow(
    trx: TrxHandle,
    table: string,
    id: string,
    notFound: string,
  ): Promise<void> {
    const rows = await sql<{ id: string }>`
      SELECT id FROM ${ident(table)} WHERE id=${id}::uuid FOR UPDATE
    `.execute(trx)
    if (!rows.rows[0]) throw new ApiError('not_found', notFound)
  }

  // ─── 单头：读/删/审核/作废走内核 ──────────────────────────────────

  async function listHeads(permit: Permit, side: TradingSide, query: Partial<ListQuery>) {
    return sides[side].heads.list(permit, query)
  }

  async function getHead(permit: Permit, side: TradingSide, id: string): Promise<Quotation> {
    return sides[side].heads.get(permit, id)
  }

  async function deleteHead(permit: Permit, side: TradingSide, id: string): Promise<void> {
    await sides[side].heads.remove(permit, id)
  }

  async function auditHead(permit: Permit, side: TradingSide, id: string): Promise<Quotation> {
    return sides[side].heads.transition(permit, id, 'audit')
  }

  async function voidHead(permit: Permit, side: TradingSide, id: string): Promise<Quotation> {
    return sides[side].heads.transition(permit, id, 'void')
  }

  async function createHead(
    permit: Permit,
    side: TradingSide,
    input: QuotationHeadCreateInput,
  ): Promise<Quotation> {
    const ctx = sides[side]
    // 入参校验（400）先于公司边界（404）：错误语义唯一规则只管后者
    if (!input.companyId) {
      throw ApiError.validation(`${ctx.spec.label}参数不合法`, { companyId: ['必填'] })
    }
    assertCompanyWritable(permit, input.companyId, '公司不存在')
    return withTx(db, (trx) => createHeadInTx(trx, permit, side, input))
  }

  async function createHeadInTx(
    trx: TrxHandle,
    permit: Permit,
    side: TradingSide,
    input: QuotationHeadCreateInput,
  ): Promise<Quotation> {
    const ctx = sides[side]
    const spec = ctx.spec
    const company = await trx
      .selectFrom('bas_company')
      .select(['id', 'base_currency_id'])
      .where('id', '=', input.companyId)
      .executeTakeFirst()
    if (!company) {
      throw ApiError.validation('报价参数不合法', { companyId: ['公司不存在'] })
    }
    const currencyId = input.currencyId ?? company.base_currency_id
    const quotationDate = input.quotationDate ? toDateOnly(input.quotationDate) : utcToday()
    let quotationNo = (input.quotationNo ?? '').trim()
    if (!quotationNo) {
      quotationNo = await numberer.nextInTx(trx, {
        resource: spec.prefix,
        values: {
          company_id: input.companyId,
          quotation_date: quotationDate,
          valid_until: toDateOnly(input.validUntil),
          party_type: lowerParty(input.partyType),
          party_id: input.partyId,
          currency_id: currencyId,
        },
      })
    }
    const partyType = lowerParty(input.partyType)
    validateHeadShape(spec, {
      quotationNo,
      quotationDate,
      validUntil: toDateOnly(input.validUntil),
      partyType,
      partyId: input.partyId,
      companyId: input.companyId,
      currencyId,
      remarks: input.remarks ?? null,
    })
    if (!(await partyExists(trx, partyType, input.partyId))) {
      throw ApiError.validation('报价参数不合法', { partyId: ['对手不存在'] })
    }
    const createdById = permit.actor.userId || null
    try {
      const inserted = await sql<{ id: string }>`
        INSERT INTO ${ident(spec.headTable)} (
          quotation_no,quotation_date,valid_until,party_type,party_id,terms,remarks,
          company_id,currency_id,created_by_id
        ) VALUES (
          ${quotationNo},${quotationDate}::date,${toDateOnly(input.validUntil)}::date,
          ${partyType},${input.partyId}::uuid,${input.terms ?? null},${input.remarks ?? null},
          ${input.companyId}::uuid,${currencyId}::uuid,${createdById}::uuid
        ) RETURNING id
      `.execute(trx)
      const id = inserted.rows[0]!.id
      const item = mapHead(ctx, (await loadHeadRow(trx, ctx, id))!)
      await writeAudit(trx, permit.actor, {
        resource: ctx.headMeta.table,
        recordId: id,
        recordLabel: item.quotationNo,
        companyId: item.companyId,
        actionType: 'create',
        actionName: 'create',
        changes: auditCreated(snapshot(ctx.headMeta, item, ctx.headAudit), ctx.headAudit),
      })
      return item
    } catch (err) {
      throw mapQuotationWrite('创建报价单失败', err)
    }
  }

  async function updateHead(
    permit: Permit,
    side: TradingSide,
    id: string,
    input: QuotationHeadUpdateInput,
  ): Promise<Quotation> {
    return withTx(db, (trx) => updateHeadInTx(trx, permit, side, id, input))
  }

  async function updateHeadInTx(
    trx: TrxHandle,
    permit: Permit,
    side: TradingSide,
    id: string,
    input: QuotationHeadUpdateInput,
  ): Promise<Quotation> {
    const ctx = sides[side]
    const spec = ctx.spec
    const locked = await lockDraftHead(trx, permit, side, id, '')
    const before = mapHead(ctx, locked)
    const after: Quotation = {
      ...before,
      quotationNo: input.quotationNo !== undefined ? input.quotationNo.trim() : before.quotationNo,
      quotationDate: input.quotationDate
        ? toDateOnly(input.quotationDate)
        : before.quotationDate,
      validUntil: input.validUntil ? toDateOnly(input.validUntil) : before.validUntil,
      partyType: input.partyType
        ? input.partyType.trim().toUpperCase()
        : before.partyType,
      partyId: input.partyId ?? before.partyId,
      currencyId: input.currencyId ?? before.currencyId,
      terms: input.termsPresent ? (input.terms ?? null) : before.terms,
      remarks: input.remarksPresent ? (input.remarks ?? null) : before.remarks,
    }
    const headChanged =
      lowerParty(after.partyType) !== lowerParty(before.partyType) ||
      after.partyId !== before.partyId ||
      after.currencyId !== before.currencyId
    if (headChanged) {
      const has = await sql<{ e: boolean }>`
        SELECT EXISTS(SELECT 1 FROM ${ident(spec.itemTable)} WHERE quotation_id=${id}::uuid) AS e
      `.execute(trx)
      if (has.rows[0]?.e) {
        throw new ApiError('conflict', '请先删除报价条目')
      }
    }
    validateHeadShape(spec, {
      quotationNo: after.quotationNo,
      quotationDate: after.quotationDate,
      validUntil: after.validUntil,
      partyType: lowerParty(after.partyType),
      partyId: after.partyId,
      companyId: after.companyId,
      currencyId: after.currencyId,
      remarks: after.remarks,
    })
    if (!(await partyExists(trx, after.partyType, after.partyId))) {
      throw ApiError.validation('报价参数不合法', { partyId: ['对手不存在'] })
    }
    const changes = auditDiff(
      snapshot(ctx.headMeta, before, ctx.headAudit),
      snapshot(ctx.headMeta, after, ctx.headAudit),
      ctx.headAudit,
    )
    if (Object.keys(changes).length === 0) return before
    try {
      await sql`
        UPDATE ${ident(spec.headTable)} SET
          quotation_no=${after.quotationNo},
          quotation_date=${after.quotationDate}::date,
          valid_until=${after.validUntil}::date,
          party_type=${lowerParty(after.partyType)},
          party_id=${after.partyId}::uuid,
          currency_id=${after.currencyId}::uuid,
          terms=${after.terms},
          remarks=${after.remarks},
          updated_at=(now() AT TIME ZONE 'utc')
        WHERE id=${id}::uuid
      `.execute(trx)
      const item = mapHead(ctx, (await loadHeadRow(trx, ctx, id))!)
      await writeAudit(trx, permit.actor, {
        resource: ctx.headMeta.table,
        recordId: id,
        recordLabel: item.quotationNo,
        companyId: item.companyId,
        actionType: 'update',
        actionName: 'update',
        changes,
      })
      return item
    } catch (err) {
      throw mapQuotationWrite('更新报价单失败', err)
    }
  }

  // ─── 条目 ────────────────────────────────────────────────────────

  async function listItems(permit: Permit, side: TradingSide, query: Partial<ListQuery>) {
    const ctx = sides[side]
    return listAuthorized({
      db,
      permit,
      target: ctx.itemTarget,
      alias: ITEM_ALIAS,
      resource: ctx.itemMeta,
      source: ctx.itemFrom,
      select: ctx.itemSelect,
      defaultOrder: sql`"quotation_date" DESC, "idx" ASC, "id" ASC`,
      query,
      mapRow: (r) => mapItem(ctx, r),
    })
  }

  async function getItem(permit: Permit, side: TradingSide, id: string): Promise<QuotationItem> {
    const ctx = sides[side]
    return loadAuthorizedFrom({
      db,
      permit,
      target: ctx.itemTarget,
      alias: ITEM_ALIAS,
      source: ctx.itemFrom,
      select: ctx.itemSelect,
      id,
      mapRow: (r) => mapItem(ctx, r),
      notFoundMessage: '报价条目不存在',
    })
  }

  async function createItem(
    permit: Permit,
    side: TradingSide,
    input: QuotationItemCreateInput,
  ): Promise<QuotationItem> {
    return withTx(db, (trx) => createItemInTx(trx, permit, side, input))
  }

  async function createItemInTx(
    trx: TrxHandle,
    permit: Permit,
    side: TradingSide,
    input: QuotationItemCreateInput,
  ): Promise<QuotationItem> {
    const ctx = sides[side]
    const spec = ctx.spec
    const parent = await lockDraftHead(trx, permit, side, input.quotationId, 'item')
    const { mode, price, taxRate } = normalizeItemShape(
      input.pricingMode,
      input.price,
      input.taxRate,
      input.materialId,
      input.unitId,
      input.remarks,
    )
    const snap = await loadMaterialSnap(trx, input.materialId, input.unitId)
    if (spec.customerMaterialGuard) {
      guardCustomerMaterial(side, String(parent.party_type), String(parent.party_id), snap)
      guardMaterialType(snap, ['STOCK', 'VIRTUAL'], '报价条目')
    }
    try {
      const inserted = await sql<{ id: string }>`
        INSERT INTO ${ident(spec.itemTable)} (
          idx,pricing_mode,price,tax_rate,material_code,material_name,material_spec,
          customer_part_no,unit_name,remarks,quotation_id,company_id,material_id,unit_id
        ) VALUES (
          ${input.idx},${mode.toLowerCase()},${price !== null ? wireRequiredDecimal(price) : null},
          ${wireRequiredDecimal(taxRate)},${snap.code},${snap.name},${snap.spec},
          ${snap.customerPartNo},${snap.unitName},${input.remarks ?? null},
          ${input.quotationId}::uuid,${String(parent.company_id)}::uuid,
          ${input.materialId}::uuid,${input.unitId}::uuid
        ) RETURNING id
      `.execute(trx)
      const id = inserted.rows[0]!.id
      const item = mapItem(ctx, (await loadItemRow(trx, ctx, id))!)
      await writeAudit(trx, permit.actor, {
        resource: ctx.itemMeta.table,
        recordId: id,
        recordLabel: String(item.idx),
        companyId: item.companyId,
        actionType: 'create',
        actionName: 'create',
        changes: auditCreated(snapshot(ctx.itemMeta, item, ctx.itemAudit), ctx.itemAudit),
      })
      return item
    } catch (err) {
      throw mapQuotationWrite('创建报价条目失败', err)
    }
  }

  async function updateItem(
    permit: Permit,
    side: TradingSide,
    id: string,
    input: QuotationItemUpdateInput,
  ): Promise<QuotationItem> {
    return withTx(db, (trx) => updateItemInTx(trx, permit, side, id, input))
  }

  async function updateItemInTx(
    trx: TrxHandle,
    permit: Permit,
    side: TradingSide,
    id: string,
    input: QuotationItemUpdateInput,
  ): Promise<QuotationItem> {
    const ctx = sides[side]
    const spec = ctx.spec
    // 母单先行加锁（授权 + 草稿门），再锁子行
    const parent = await itemParent(trx, permit, side, id)
    await lockChildRow(trx, spec.itemTable, id, '报价条目不存在')
    const beforeRow = await loadItemRow(trx, ctx, id)
    if (!beforeRow) throw new ApiError('not_found', '报价条目不存在')
    const before = mapItem(ctx, beforeRow)
    const afterMode = input.pricingMode ?? before.pricingMode
    const afterPrice = input.pricePresent ? input.price : before.price
    const { mode, price, taxRate } = normalizeItemShape(
      afterMode,
      afterPrice,
      input.taxRate ?? before.taxRate,
      input.materialId ?? before.materialId,
      input.unitId ?? before.unitId,
      input.remarksPresent ? input.remarks : before.remarks,
    )
    const materialId = input.materialId ?? before.materialId
    const unitId = input.unitId ?? before.unitId
    const snap = await loadMaterialSnap(trx, materialId, unitId)
    if (spec.customerMaterialGuard) {
      guardCustomerMaterial(side, String(parent.party_type), String(parent.party_id), snap)
      guardMaterialType(snap, ['STOCK', 'VIRTUAL'], '报价条目')
    }
    const after: QuotationItem = {
      ...before,
      idx: input.idx ?? before.idx,
      pricingMode: mode,
      price: price !== null ? wireRequiredDecimal(price) : null,
      taxRate: wireRequiredDecimal(taxRate),
      materialId,
      unitId,
      materialCode: snap.code,
      materialName: snap.name,
      materialSpec: snap.spec,
      customerPartNo: snap.customerPartNo,
      unitName: snap.unitName,
      remarks: input.remarksPresent ? (input.remarks ?? null) : before.remarks,
    }
    const changes = auditDiff(
      snapshot(ctx.itemMeta, before, ctx.itemAudit),
      snapshot(ctx.itemMeta, after, ctx.itemAudit),
      ctx.itemAudit,
    )
    if (Object.keys(changes).length === 0) return before
    try {
      await sql`
        UPDATE ${ident(spec.itemTable)} SET
          idx=${after.idx}, pricing_mode=${mode.toLowerCase()},
          price=${after.price}, tax_rate=${after.taxRate},
          material_code=${after.materialCode}, material_name=${after.materialName},
          material_spec=${after.materialSpec}, customer_part_no=${after.customerPartNo},
          unit_name=${after.unitName}, remarks=${after.remarks},
          material_id=${after.materialId}::uuid, unit_id=${after.unitId}::uuid,
          updated_at=(now() AT TIME ZONE 'utc')
        WHERE id=${id}::uuid
      `.execute(trx)
      if (before.pricingMode === 'QTY_TIERED' && mode === 'FIXED') {
        await purgeTiers(trx, permit, ctx, id)
      }
      const item = mapItem(ctx, (await loadItemRow(trx, ctx, id))!)
      await writeAudit(trx, permit.actor, {
        resource: ctx.itemMeta.table,
        recordId: id,
        recordLabel: String(item.idx),
        companyId: item.companyId,
        actionType: 'update',
        actionName: 'update',
        changes,
      })
      return item
    } catch (err) {
      throw mapQuotationWrite('更新报价条目失败', err)
    }
  }

  async function deleteItem(permit: Permit, side: TradingSide, id: string): Promise<void> {
    await withTx(db, (trx) => deleteItemInTx(trx, permit, side, id))
  }

  async function deleteItemInTx(
    trx: TrxHandle,
    permit: Permit,
    side: TradingSide,
    id: string,
  ): Promise<void> {
    const ctx = sides[side]
    const spec = ctx.spec
    // 母单先行加锁（授权 + 草稿门），再锁子行
    await itemParent(trx, permit, side, id)
    await lockChildRow(trx, spec.itemTable, id, '报价条目不存在')
    const row = await loadItemRow(trx, ctx, id)
    if (!row) throw new ApiError('not_found', '报价条目不存在')
    const item = mapItem(ctx, row)
    await writeAudit(trx, permit.actor, {
      resource: ctx.itemMeta.table,
      recordId: id,
      recordLabel: String(item.idx),
      companyId: item.companyId,
      actionType: 'destroy',
      actionName: 'destroy',
      changes: auditDestroyed(snapshot(ctx.itemMeta, item, ctx.itemAudit), ctx.itemAudit),
    })
    try {
      await sql`DELETE FROM ${ident(spec.itemTable)} WHERE id=${id}::uuid`.execute(trx)
    } catch (err) {
      throw mapQuotationWrite('删除报价条目失败', err)
    }
  }

  // ─── 价格档（孙级资源：整体弹射保留手写） ─────────────────────────

  async function listTiers(permit: Permit, side: TradingSide, query: Partial<ListQuery>) {
    const ctx = sides[side]
    return listAuthorized({
      db,
      permit,
      target: ctx.tierTarget,
      alias: TIER_ALIAS,
      resource: ctx.tierMeta,
      source: ctx.tierFrom,
      select: ctx.tierSelect,
      defaultOrder: sql`"min_qty" ASC, "id" ASC`,
      query,
      mapRow: (r) => mapTier(ctx, r),
    })
  }

  async function getTier(permit: Permit, side: TradingSide, id: string): Promise<QuotationTier> {
    const ctx = sides[side]
    return loadAuthorizedFrom({
      db,
      permit,
      target: ctx.tierTarget,
      alias: TIER_ALIAS,
      source: ctx.tierFrom,
      select: ctx.tierSelect,
      id,
      mapRow: (r) => mapTier(ctx, r),
      notFoundMessage: '报价价格档不存在',
    })
  }

  async function createTier(
    permit: Permit,
    side: TradingSide,
    input: { itemId: string; minQty: string; price: string },
  ): Promise<QuotationTier> {
    return withTx(db, (trx) => createTierInTx(trx, permit, side, input))
  }

  async function createTierInTx(
    trx: TrxHandle,
    permit: Permit,
    side: TradingSide,
    input: { itemId: string; minQty: string; price: string },
  ): Promise<QuotationTier> {
    const ctx = sides[side]
    const spec = ctx.spec
    const minQty = decimal(input.minQty)
    const price = decimal(input.price)
    validateTierShape(minQty, price)
    const parent = await tierParent(trx, spec, input.itemId)
    await lockDraftHead(trx, permit, side, parent.quotationId, 'tier')
    if (parent.mode !== 'qty_tiered') {
      throw ApiError.validation('报价价格档参数不合法', {
        itemId: ['仅数量梯度条目可维护价格档'],
      })
    }
    try {
      const inserted = await sql<{ id: string }>`
        INSERT INTO ${ident(spec.tierTable)} (min_qty,price,item_id,company_id)
        VALUES (${wireRequiredDecimal(minQty)},${wireRequiredDecimal(price)},
          ${input.itemId}::uuid,${parent.companyId}::uuid)
        RETURNING id
      `.execute(trx)
      const id = inserted.rows[0]!.id
      const item = mapTier(ctx, (await loadTierRow(trx, ctx, id))!)
      await writeAudit(trx, permit.actor, {
        resource: ctx.tierMeta.table,
        recordId: id,
        recordLabel: item.minQty,
        companyId: item.companyId,
        actionType: 'create',
        actionName: 'create',
        changes: auditCreated(snapshot(ctx.tierMeta, item, ctx.tierAudit), ctx.tierAudit),
      })
      return item
    } catch (err) {
      throw mapQuotationWrite('创建报价价格档失败', err)
    }
  }

  async function updateTier(
    permit: Permit,
    side: TradingSide,
    id: string,
    input: { minQty?: string; price?: string },
  ): Promise<QuotationTier> {
    return withTx(db, (trx) => updateTierInTx(trx, permit, side, id, input))
  }

  async function updateTierInTx(
    trx: TrxHandle,
    permit: Permit,
    side: TradingSide,
    id: string,
    input: { minQty?: string; price?: string },
  ): Promise<QuotationTier> {
    const ctx = sides[side]
    const spec = ctx.spec
    const owner = await tierOwnerItem(trx, spec, id)
    const parent = await tierParent(trx, spec, owner)
    // 母单先行加锁（授权 + 草稿门），再锁子行
    await lockDraftHead(trx, permit, side, parent.quotationId, 'tier')
    await lockChildRow(trx, spec.tierTable, id, '报价价格档不存在')
    if (parent.mode !== 'qty_tiered') {
      throw ApiError.validation('报价价格档参数不合法', {
        itemId: ['仅数量梯度条目可维护价格档'],
      })
    }
    const beforeRow = await loadTierRow(trx, ctx, id)
    if (!beforeRow) throw new ApiError('not_found', '报价价格档不存在')
    const before = mapTier(ctx, beforeRow)
    const after: QuotationTier = {
      ...before,
      minQty: input.minQty !== undefined ? wireRequiredDecimal(input.minQty) : before.minQty,
      price: input.price !== undefined ? wireRequiredDecimal(input.price) : before.price,
    }
    validateTierShape(decimal(after.minQty), decimal(after.price))
    const changes = auditDiff(
      snapshot(ctx.tierMeta, before, ctx.tierAudit),
      snapshot(ctx.tierMeta, after, ctx.tierAudit),
      ctx.tierAudit,
    )
    if (Object.keys(changes).length === 0) return before
    try {
      await sql`
        UPDATE ${ident(spec.tierTable)} SET
          min_qty=${after.minQty}, price=${after.price},
          updated_at=(now() AT TIME ZONE 'utc')
        WHERE id=${id}::uuid
      `.execute(trx)
      const item = mapTier(ctx, (await loadTierRow(trx, ctx, id))!)
      await writeAudit(trx, permit.actor, {
        resource: ctx.tierMeta.table,
        recordId: id,
        recordLabel: item.minQty,
        companyId: item.companyId,
        actionType: 'update',
        actionName: 'update',
        changes,
      })
      return item
    } catch (err) {
      throw mapQuotationWrite('更新报价价格档失败', err)
    }
  }

  async function deleteTier(permit: Permit, side: TradingSide, id: string): Promise<void> {
    await withTx(db, (trx) => deleteTierInTx(trx, permit, side, id))
  }

  async function deleteTierInTx(
    trx: TrxHandle,
    permit: Permit,
    side: TradingSide,
    id: string,
  ): Promise<void> {
    const ctx = sides[side]
    const spec = ctx.spec
    const owner = await tierOwnerItem(trx, spec, id)
    const parent = await tierParent(trx, spec, owner)
    // 母单先行加锁（授权 + 草稿门），再锁子行
    await lockDraftHead(trx, permit, side, parent.quotationId, 'tier')
    await lockChildRow(trx, spec.tierTable, id, '报价价格档不存在')
    if (parent.mode !== 'qty_tiered') {
      throw ApiError.validation('报价价格档参数不合法', {
        itemId: ['仅数量梯度条目可维护价格档'],
      })
    }
    const row = await loadTierRow(trx, ctx, id)
    if (!row) throw new ApiError('not_found', '报价价格档不存在')
    const item = mapTier(ctx, row)
    await writeAudit(trx, permit.actor, {
      resource: ctx.tierMeta.table,
      recordId: id,
      recordLabel: item.minQty,
      companyId: item.companyId,
      actionType: 'destroy',
      actionName: 'destroy',
      changes: auditDestroyed(snapshot(ctx.tierMeta, item, ctx.tierAudit), ctx.tierAudit),
    })
    try {
      await sql`DELETE FROM ${ident(spec.tierTable)} WHERE id=${id}::uuid`.execute(trx)
    } catch (err) {
      throw mapQuotationWrite('删除报价价格档失败', err)
    }
  }

  /** 定价模式由数量梯度改回固定价：清档并逐行留审计（actionName=purge） */
  async function purgeTiers(
    handle: DbHandle,
    permit: Permit,
    ctx: SideCtx,
    itemId: string,
  ): Promise<void> {
    const rows = await sql<Record<string, unknown>>`
      ${ctx.tierSelect}${ctx.tierFrom}
      WHERE quotation_tiers.item_id=${itemId}::uuid
      ORDER BY quotation_tiers.min_qty, quotation_tiers.id
    `.execute(handle)
    await sql`DELETE FROM ${ident(ctx.spec.tierTable)} WHERE item_id=${itemId}::uuid`.execute(
      handle,
    )
    for (const row of rows.rows) {
      const item = mapTier(ctx, row)
      await writeAudit(handle, permit.actor, {
        resource: ctx.tierMeta.table,
        recordId: item.id,
        recordLabel: item.minQty,
        companyId: item.companyId,
        actionType: 'destroy',
        actionName: 'purge',
        changes: auditDestroyed(snapshot(ctx.tierMeta, item, ctx.tierAudit), ctx.tierAudit),
      })
    }
  }

  // ─── 整单聚合（本资源的 create/update wire：单事务全成全败） ──────────

  async function loadDraft(
    handle: DbHandle,
    permit: Permit,
    side: TradingSide,
    id: string,
  ): Promise<QuotationSavedDraft> {
    const ctx = sides[side]
    const head = await loadAuthorizedFrom({
      db: handle,
      permit,
      target: ctx.headTarget,
      alias: HEAD_ALIAS,
      source: ctx.headFrom,
      select: ctx.headSelect,
      id,
      mapRow: (r) => mapHead(ctx, r),
      notFoundMessage: `${ctx.spec.label}不存在`,
    })
    const itemRows = await loadItemRowsForQuotation(handle, ctx, id)
    const tierRows = await loadTierRowsForQuotation(handle, ctx, id)
    const tiersByItem = new Map<string, QuotationTier[]>()
    for (const row of tierRows) {
      const tier = mapTier(ctx, row)
      const tiers = tiersByItem.get(tier.itemId) ?? []
      tiers.push(tier)
      tiersByItem.set(tier.itemId, tiers)
    }
    return {
      ...head,
      items: itemRows.map((row) => {
        const item = mapItem(ctx, row)
        return { ...item, tiers: tiersByItem.get(item.id) ?? [] }
      }),
    }
  }

  /** 领域专用完整报价草稿读取：表头 + 全部条目 + 全部价格档。 */
  async function getDraft(
    permit: Permit,
    side: TradingSide,
    id: string,
  ): Promise<QuotationSavedDraft> {
    return withReadSnapshot(db, (snap) => loadDraft(snap, permit, side, id))
  }

  async function createDraft(
    permit: Permit,
    side: TradingSide,
    input: QuotationDraftInput,
  ): Promise<QuotationSavedDraft> {
    // 入参校验（400）先于公司边界（404）
    validateNewQuotationDraftIdentities(input)
    if (!input.companyId) {
      throw ApiError.validation('报价草稿参数不合法', { 'header.companyId': ['必填'] })
    }
    assertCompanyWritable(permit, input.companyId, '公司不存在')
    return withTx(db, async (trx) => {
      const head = await withIndexedFields('header', () =>
        createHeadInTx(trx, permit, side, input),
      )
      for (let itemIndex = 0; itemIndex < input.items.length; itemIndex++) {
        const inputItem = input.items[itemIndex]!
        const item = await withIndexedFields(`items[${itemIndex}]`, () =>
          createItemInTx(trx, permit, side, {
            ...inputItem,
            quotationId: head.id,
          }),
        )
        for (let tierIndex = 0; tierIndex < inputItem.tiers.length; tierIndex++) {
          const tier = inputItem.tiers[tierIndex]!
          await withIndexedFields(
            `items[${itemIndex}].tiers[${tierIndex}]`,
            () => createTierInTx(trx, permit, side, { ...tier, itemId: item.id }),
          )
        }
      }
      return loadDraft(trx, permit, side, head.id)
    })
  }

  /**
   * 整单替换：子树差异（新增/删除条目与档位）的码级门控由路由声明——
   * PUT 挂 `guard(head, 'update', { allOf: [prefix:create, prefix:delete] })`，
   * 服务层不再按差异动态追加判定（403 只由 guard 产生）。
   */
  async function replaceDraft(
    permit: Permit,
    side: TradingSide,
    id: string,
    input: QuotationDraftInput,
  ): Promise<QuotationSavedDraft> {
    const ctx = sides[side]
    const spec = ctx.spec
    return withTx(db, async (trx) => {
      const before = mapHead(ctx, await lockDraftHead(trx, permit, side, id, ''))
      if (input.companyId !== before.companyId) {
        throw ApiError.validation('报价草稿参数不合法', {
          'header.companyId': ['创建后不可修改公司'],
        })
      }

      const existingItems = await sql<{ id: string }>`
        SELECT id FROM ${ident(spec.itemTable)}
        WHERE quotation_id=${id}::uuid
      `.execute(trx)
      const existingTiers = await sql<{ id: string; item_id: string }>`
        SELECT t.id,t.item_id
        FROM ${ident(spec.tierTable)} t
        JOIN ${ident(spec.itemTable)} i ON i.id=t.item_id
        WHERE i.quotation_id=${id}::uuid
      `.execute(trx)
      const existingItemIds = new Set(existingItems.rows.map((item) => item.id))
      const tierOwner = new Map(
        existingTiers.rows.map((tier) => [tier.id, tier.item_id]),
      )
      validateQuotationDraftIdentities(input, existingItemIds, tierOwner)

      const requestedItems = requestedItemIds(input)

      // 全量替换先移除 omitted 旧行，使“清空条目 + 修改对手/币种”能在
      // 同一事务内完成；后续任一校验失败会连同删除一起回滚。
      for (const oldId of existingItemIds) {
        if (!requestedItems.has(oldId)) {
          await deleteItemInTx(trx, permit, side, oldId)
        }
      }

      await withIndexedFields('header', () =>
        updateHeadInTx(trx, permit, side, id, {
          quotationNo: input.quotationNo ?? before.quotationNo,
          quotationDate: input.quotationDate ?? before.quotationDate,
          validUntil: input.validUntil,
          partyType: input.partyType,
          partyId: input.partyId,
          currencyId: input.currencyId ?? before.currencyId,
          terms: input.terms ?? null,
          termsPresent: true,
          remarks: input.remarks ?? null,
          remarksPresent: true,
        }),
      )

      for (let itemIndex = 0; itemIndex < input.items.length; itemIndex++) {
        const inputItem = input.items[itemIndex]!
        let savedItem: QuotationItem
        if (inputItem.id === undefined) {
          savedItem = await withIndexedFields(`items[${itemIndex}]`, () =>
            createItemInTx(trx, permit, side, {
              ...inputItem,
              quotationId: id,
            }),
          )
        } else {
          const requestedTierIds = new Set(
            inputItem.tiers.flatMap((tier) =>
              tier.id === undefined ? [] : [tier.id],
            ),
          )
          for (const [tierId, ownerId] of tierOwner) {
            if (ownerId === inputItem.id && !requestedTierIds.has(tierId)) {
              await deleteTierInTx(trx, permit, side, tierId)
            }
          }
          savedItem = await withIndexedFields(`items[${itemIndex}]`, () =>
            updateItemInTx(trx, permit, side, inputItem.id!, {
              idx: inputItem.idx,
              materialId: inputItem.materialId,
              unitId: inputItem.unitId,
              pricingMode: inputItem.pricingMode,
              price: inputItem.price ?? null,
              pricePresent: true,
              taxRate: inputItem.taxRate ?? undefined,
              remarks: inputItem.remarks ?? null,
              remarksPresent: true,
            }),
          )
        }

        for (let tierIndex = 0; tierIndex < inputItem.tiers.length; tierIndex++) {
          const inputTier = inputItem.tiers[tierIndex]!
          const prefix = `items[${itemIndex}].tiers[${tierIndex}]`
          if (inputTier.id === undefined) {
            await withIndexedFields(prefix, () =>
              createTierInTx(trx, permit, side, {
                itemId: savedItem.id,
                minQty: inputTier.minQty,
                price: inputTier.price,
              }),
            )
          } else {
            await withIndexedFields(prefix, () =>
              updateTierInTx(trx, permit, side, inputTier.id!, {
                minQty: inputTier.minQty,
                price: inputTier.price,
              }),
            )
          }
        }
      }
      return loadDraft(trx, permit, side, id)
    })
  }

  /**
   * 订单行套档：调用方已持订单头锁；本函数锁定报价头并校验有效期/公司/对手/币种。
   */
  async function resolveForOrder(
    trx: DbHandle,
    side: TradingSide,
    input: ResolveOrderInput,
  ): Promise<ResolveOrderResult> {
    const spec = quotationSpec(side)
    const rows = await sql<{
      material_id: string
      unit_id: string
      pricing_mode: string
      price: string | null
      tax_rate: string
      quotation_date: string
      valid_until: string
      status: string
      company_id: string
      party_type: string
      party_id: string
      currency_id: string
    }>`
      SELECT i.material_id,i.unit_id,i.pricing_mode,i.price::text AS price,i.tax_rate::text AS tax_rate,
        q.quotation_date::text AS quotation_date,q.valid_until::text AS valid_until,q.status,
        q.company_id,q.party_type,q.party_id,q.currency_id
      FROM ${ident(spec.itemTable)} i
      JOIN ${ident(spec.headTable)} q ON q.id=i.quotation_id
      WHERE i.id=${input.quotationItemId}::uuid
      FOR UPDATE OF q
    `.execute(trx)
    const row = rows.rows[0]
    if (!row) {
      throw ApiError.validation('订单条目参数不合法', {
        quotationItemId: ['报价条目不存在'],
      })
    }
    const orderDate = toDateOnly(input.orderDate)
    if (row.status.toLowerCase() !== 'audited') {
      throw new ApiError('conflict', '报价单须为已审核状态')
    }
    const qDate = asDate(row.quotation_date)
    const vUntil = asDate(row.valid_until)
    if (orderDate < qDate || orderDate > vUntil) {
      throw new ApiError('conflict', '订单日期不在报价有效期内')
    }
    if (row.company_id !== input.companyId) {
      throw new ApiError('conflict', '报价公司与订单不一致')
    }
    if (
      row.party_type !== lowerParty(input.partyType) ||
      row.party_id !== input.partyId
    ) {
      throw new ApiError('conflict', '报价对手与订单不一致')
    }
    if (row.currency_id !== input.currencyId) {
      throw new ApiError('conflict', '报价币种与订单不一致')
    }
    const taxRate = decimal(row.tax_rate)
    const mode = row.pricing_mode.toLowerCase()
    if (mode === 'fixed') {
      if (row.price === null) throw new ApiError('conflict', '固定价报价缺少单价')
      return {
        materialId: row.material_id,
        unitId: row.unit_id,
        price: decimal(row.price),
        taxRate,
      }
    }
    if (mode === 'qty_tiered') {
      const tier = await sql<{ price: string }>`
        SELECT price::text AS price FROM ${ident(spec.tierTable)}
        WHERE item_id=${input.quotationItemId}::uuid AND min_qty <= ${wireRequiredDecimal(input.qty)}
        ORDER BY min_qty DESC LIMIT 1
      `.execute(trx)
      if (!tier.rows[0]) {
        throw new ApiError('conflict', '数量低于首档起订量,无可用报价')
      }
      return {
        materialId: row.material_id,
        unitId: row.unit_id,
        price: decimal(tier.rows[0].price),
        taxRate,
      }
    }
    throw new ApiError('conflict', '报价定价模式不合法')
  }

  return {
    listHeads,
    getHead,
    createHead,
    updateHead,
    deleteHead,
    auditHead,
    voidHead,
    listItems,
    getItem,
    createItem,
    updateItem,
    deleteItem,
    listTiers,
    getTier,
    createTier,
    updateTier,
    deleteTier,
    getDraft,
    createDraft,
    replaceDraft,
    resolveForOrder,
  }
}

export type QuotationService = ReturnType<typeof createQuotationService>

// ─── 投影附加键（join 出来的引用与计算列；物理列由 meta 派生） ──────────

function headExtras(row: Record<string, unknown>): Record<string, unknown> {
  const companyId = String(row.company_id)
  const currencyId = String(row.currency_id)
  const createdById = row.created_by_id ? String(row.created_by_id) : null
  const auditedById = row.audited_by_id ? String(row.audited_by_id) : null
  return {
    company: namedRef(companyId, String(row.company_name)),
    currency: codeNamedRef(
      currencyId,
      String(row.currency_code),
      String(row.currency_name),
    ),
    createdBy: createdById
      ? namedRef(createdById, String(row.created_by_name ?? ''))
      : null,
    auditedBy: auditedById
      ? namedRef(auditedById, String(row.audited_by_name ?? ''))
      : null,
  }
}

function itemExtras(row: Record<string, unknown>): Record<string, unknown> {
  const quotationId = String(row.quotation_id)
  const companyId = String(row.company_id)
  const materialId = String(row.material_id)
  const unitId = String(row.unit_id)
  return {
    tierCount: Number(row.tier_count ?? 0),
    quotationDate: asDate(row.quotation_date),
    validUntil: asDate(row.valid_until),
    quotationStatus: upperStatus(String(row.quotation_status)),
    partyType: upperStatus(String(row.party_type)),
    currencyCode: String(row.currency_code),
    quotation: { id: quotationId, quotationNo: String(row.quotation_no) },
    company: namedRef(companyId, String(row.company_name)),
    material: codeNamedRef(
      materialId,
      String(row.material_code),
      String(row.material_live_name ?? row.material_name),
    ),
    unit: namedRef(unitId, String(row.unit_live_name ?? row.unit_name)),
  }
}

function tierExtras(row: Record<string, unknown>): Record<string, unknown> {
  return {
    company: namedRef(String(row.company_id), String(row.company_name ?? '')),
  }
}

// ─── 领域校验（头/条目/价格档形状 + 聚合子记录身份） ─────────────────

async function withIndexedFields<T>(
  prefix: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'validation' || !error.fields) throw error
    const fields = Object.fromEntries(
      Object.entries(error.fields).map(([field, messages]) => [
        `${prefix}.${field}`,
        messages,
      ]),
    )
    throw ApiError.validation(error.message, fields)
  }
}

function validateNewQuotationDraftIdentities(input: QuotationDraftInput): void {
  const fields: Record<string, string[]> = {}
  input.items.forEach((item, itemIndex) => {
    if (item.id !== undefined) {
      fields[`items[${itemIndex}].id`] = ['新记录不能包含 id']
    }
    item.tiers.forEach((tier, tierIndex) => {
      if (tier.id !== undefined) {
        fields[`items[${itemIndex}].tiers[${tierIndex}].id`] = ['新记录不能包含 id']
      }
    })
  })
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('报价草稿参数不合法', fields)
  }
}

function validateQuotationDraftIdentities(
  input: QuotationDraftInput,
  existingItems: ReadonlySet<string>,
  tierOwner: ReadonlyMap<string, string>,
): void {
  const fields: Record<string, string[]> = {}
  const seenItems = new Set<string>()
  const seenTiers = new Set<string>()
  input.items.forEach((item, itemIndex) => {
    if (item.id !== undefined) {
      const field = `items[${itemIndex}].id`
      if (seenItems.has(item.id)) fields[field] = ['同一草稿中不能重复']
      else if (!existingItems.has(item.id)) fields[field] = ['不属于该报价单']
      seenItems.add(item.id)
    }
    item.tiers.forEach((tier, tierIndex) => {
      if (tier.id === undefined) return
      const field = `items[${itemIndex}].tiers[${tierIndex}].id`
      if (seenTiers.has(tier.id)) fields[field] = ['同一草稿中不能重复']
      else if (item.id === undefined || tierOwner.get(tier.id) !== item.id) {
        fields[field] = ['不属于该报价条目']
      }
      seenTiers.add(tier.id)
    })
  })
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('报价草稿子记录身份不合法', fields)
  }
}

/** 整单替换保留的既有条目 id；未列出的旧行按全量替换语义删除 */
function requestedItemIds(input: QuotationDraftInput): ReadonlySet<string> {
  const requested = new Set<string>()
  for (const item of input.items) {
    if (item.id !== undefined) requested.add(item.id)
  }
  return requested
}

function validateHeadShape(
  spec: QuotationSideSpec,
  v: {
    quotationNo: string
    quotationDate: string
    validUntil: string
    partyType: string
    partyId: string
    companyId: string
    currencyId: string
    remarks: string | null
  },
) {
  const fields: Record<string, string[]> = {}
  if (!v.quotationNo || runeLen(v.quotationNo) > 32) {
    fields.quotationNo = ['不能为空且最多 32 个字符']
  }
  if (!v.quotationDate) fields.quotationDate = ['必填']
  if (!v.validUntil) fields.validUntil = ['必填']
  else if (v.quotationDate && v.validUntil < v.quotationDate) {
    fields.validUntil = ['报价截止不得早于报价日期']
  }
  if (!spec.allowedParty.has(lowerParty(v.partyType))) {
    fields.partyType =
      spec.side === 'sales'
        ? ['对手类型只能为客户或内部公司']
        : ['对手类型只能为供应商或内部公司']
  }
  if (!v.partyId) fields.partyId = ['必填']
  if (!v.companyId) fields.companyId = ['必填']
  if (!v.currencyId) fields.currencyId = ['必填']
  if (lowerParty(v.partyType) === 'company' && v.partyId === v.companyId) {
    fields.partyId = ['对手不能是本公司']
  }
  if (v.remarks && runeLen(v.remarks) > 512) fields.remarks = ['最多 512 个字符']
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation(`${spec.label}参数不合法`, fields)
  }
}

function normalizeItemShape(
  modeRaw: string | undefined,
  priceRaw: string | null | undefined,
  taxRateRaw: string | null | undefined,
  materialId: string,
  unitId: string,
  remarks: string | null | undefined,
): { mode: string; price: Decimal | null; taxRate: Decimal } {
  let mode = (modeRaw ?? 'FIXED').trim().toUpperCase()
  if (!mode) mode = 'FIXED'
  let taxRate = decimal('0.13')
  if (taxRateRaw !== null && taxRateRaw !== undefined && taxRateRaw !== '') {
    taxRate = decimal(taxRateRaw)
  }
  const fields: Record<string, string[]> = {}
  let price: Decimal | null = null
  if (mode === 'FIXED') {
    if (priceRaw === null || priceRaw === undefined || priceRaw === '') {
      fields.price = ['固定价条目必须填写含税单价']
    } else {
      price = decimal(priceRaw)
      if (price.isNegative()) fields.price = ['含税单价不能为负']
    }
  } else if (mode === 'QTY_TIERED') {
    price = null
  } else {
    fields.pricingMode = ['只能为 FIXED 或 QTY_TIERED']
  }
  if (taxRate.isNegative() || taxRate.gte(1)) {
    fields.taxRate = ['税率必须在 0(含)与 1 之间']
  }
  if (!materialId) fields.materialId = ['必填']
  if (!unitId) fields.unitId = ['必填']
  if (remarks && runeLen(remarks) > 512) fields.remarks = ['最多 512 个字符']
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('报价条目参数不合法', fields)
  }
  return { mode, price, taxRate }
}

function validateTierShape(minQty: Decimal, price: Decimal) {
  const fields: Record<string, string[]> = {}
  if (!minQty.gt(0)) fields.minQty = ['起订量必须大于零']
  if (price.isNegative()) fields.price = ['含税档价不能为负']
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('报价价格档参数不合法', fields)
  }
}

/** 价格档所属条目 id（母单先行加锁前的定位读，不加锁） */
async function tierOwnerItem(
  db: DbHandle,
  spec: QuotationSideSpec,
  tierId: string,
): Promise<string> {
  const rows = await sql<{ item_id: string }>`
    SELECT item_id FROM ${ident(spec.tierTable)} WHERE id=${tierId}::uuid
  `.execute(db)
  const row = rows.rows[0]
  if (!row) throw new ApiError('not_found', '报价价格档不存在')
  return row.item_id
}

async function tierParent(
  db: DbHandle,
  spec: QuotationSideSpec,
  itemId: string,
): Promise<{ quotationId: string; companyId: string; mode: string }> {
  const rows = await sql<{
    quotation_id: string
    company_id: string
    pricing_mode: string
  }>`
    SELECT quotation_id, company_id, pricing_mode FROM ${ident(spec.itemTable)}
    WHERE id=${itemId}::uuid
  `.execute(db)
  const row = rows.rows[0]
  if (!row) throw new ApiError('not_found', '报价条目不存在')
  return {
    quotationId: row.quotation_id,
    companyId: row.company_id,
    mode: row.pricing_mode.toLowerCase(),
  }
}

function mapQuotationWrite(message: string, err: unknown): ApiError {
  return mapWriteError(err, message, QUOTATION_WRITE_ERRORS)
}
