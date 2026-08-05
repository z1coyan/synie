/**
 * 采购委外配置：发料清单 / 副产物 / 需求池 / BOM 展开。
 * 从 order/service 拆出，与订单主聚合弱关联、与 outsourced 天然同组。
 *
 * 授权全由平台承担（工单 10）：路由挂 `guard(资源, 动作)`，本服务只收 Permit——
 * 列表 `listAuthorized`、单条 `loadAuthorizedFrom`（与列表共用投影）、
 * 母单锁 `loadAuthorized(forUpdate)`。两类清单是 `via(purOrderItems → purOrders)` 子资源，
 * 判定递归到采购订单头自身的行谓词。状态守卫（仅草稿可编辑）留在本文件抛 conflict。
 */
import type { ListQuery } from '@synie/shared'
import { decimal } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { withTx, type DbHandle, type TrxHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import {
  auditCreated,
  auditDestroyed,
  auditDiff,
  writeAudit,
} from '~/platform/audit/write.ts'
import { auditFieldsOf } from '~/platform/audit/spec.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import { listAuthorized } from '~/db/list.ts'
import { companyInPermitScope, loadAuthorized, loadAuthorizedFrom } from '~/db/load.ts'
import {
  asDate,
  asDateTime,
  asOptionalString,
  guardMaterialType,
  loadMaterialSnap,
  upperStatus,
  wireRequiredDecimal,
} from '../common.ts'
import { orderByproductMeta, orderMaterialMeta, orderSpec } from './spec.ts'

const MATERIAL_AUDIT = auditFieldsOf(orderMaterialMeta())

const BYPRODUCT_AUDIT = auditFieldsOf(orderByproductMeta())

/** 判定归宿资源名（路由 import 常量，不写裸字面量） */
export const ORDER_MATERIAL_RESOURCE = 'purOrderItemMaterials'
export const ORDER_BYPRODUCT_RESOURCE = 'purOrderItemByproducts'

/** 列表与单条共用同一份投影；alias 必须与子查询别名逐字一致 */
const MATERIAL_SOURCE = sql` FROM (
      SELECT m.id,m.quantity,m.issued_qty,m.remarks,m.inserted_at,m.updated_at,m.order_item_id,
        m.company_id,m.material_id,mat.code AS material_code,mat.name AS material_name,mat.spec AS material_spec,
        m.unit_id,u.name AS unit_name,
        o.order_no,o.status AS order_status,o.is_outsourced AS order_is_outsourced,o.party_type,o.party_id,
        (m.quantity - m.issued_qty) AS remaining_issue_qty
      FROM pur_order_item_material m
      JOIN pur_order_item oi ON oi.id=m.order_item_id
      JOIN pur_order o ON o.id=oi.order_id
      JOIN inv_material mat ON mat.id=m.material_id
      JOIN bas_unit u ON u.id=m.unit_id
    ) order_item_materials`
const MATERIAL_ALIAS = 'order_item_materials'
const BYPRODUCT_SOURCE = sql` FROM (
      SELECT b.id,b.quantity,b.remarks,b.inserted_at,b.updated_at,b.order_item_id,b.company_id,
        b.material_id,mat.code AS material_code,mat.name AS material_name,mat.spec AS material_spec,
        b.unit_id,u.name AS unit_name
      FROM pur_order_item_byproduct b
      JOIN inv_material mat ON mat.id=b.material_id
      JOIN bas_unit u ON u.id=b.unit_id
    ) order_item_byproducts`
const BYPRODUCT_ALIAS = 'order_item_byproducts'
const LINE_SELECT = sql`SELECT *`

export interface OutsourcedDraftLineInput {
  id?: string
  materialId: string
  unitId: string
  quantity: string
  remarks?: string | null
}

export interface OutsourcedDraftItemInput {
  issueLines: OutsourcedDraftLineInput[]
  byproductLines: OutsourcedDraftLineInput[]
}

export interface OutsourcedSavedLine {
  id: string
  quantity: string
  remarks: string | null
  insertedAt: string
  updatedAt: string
  orderItemId: string
  companyId: string
  materialId: string
  materialCode: string
  materialName: string
  materialSpec: string | null
  unitId: string
  unitName: string
}

export interface OutsourcedSavedIssueLine extends OutsourcedSavedLine {
  issuedQty: string
  orderNo: string
  orderStatus: string
  orderIsOutsourced: boolean
  partyType: string
  partyId: string
  remainingIssueQty: string
}

export interface OutsourcedDraftLines {
  issueLines: OutsourcedSavedIssueLine[]
  byproductLines: OutsourcedSavedLine[]
}

export function createOutsourcedConfigService(db: Kysely<Database>, registry: Registry) {
  const spec = orderSpec('purchase')
  const materialTarget = registry.authzTarget(ORDER_MATERIAL_RESOURCE)
  const byproductTarget = registry.authzTarget(ORDER_BYPRODUCT_RESOURCE)
  const orderTarget = registry.authzTarget(spec.headResource)

  /**
   * 清单行的母单：先取订单头并加锁（授权递归归宿资源），再做草稿门。
   * 加锁顺序母单先行，与并发路径一致。
   */
  async function lockOrderOfItem(
    trx: DbHandle,
    permit: Permit,
    orderItemId: string,
  ): Promise<{ companyId: string; isOutsourced: boolean; status: string }> {
    const owner = await sql<{ order_id: string }>`
      SELECT order_id FROM pur_order_item WHERE id=${orderItemId}::uuid
    `.execute(trx)
    if (!owner.rows[0]) throw new ApiError('not_found', '订单条目不存在')
    const head = await loadAuthorized({
      db: trx,
      permit,
      target: orderTarget,
      table: spec.headTable,
      id: owner.rows[0].order_id,
      forUpdate: true,
      notFoundMessage: '订单条目不存在',
    })
    if (String(head.status).toLowerCase() !== 'draft') {
      throw new ApiError('conflict', '仅草稿订单可编辑条目')
    }
    return {
      companyId: String(head.company_id),
      isOutsourced: Boolean(head.is_outsourced),
      status: String(head.status),
    }
  }

  /** 单条读：与列表共用同一份投影，判定经 via 链递归到订单头 */
  function loadLine<T>(
    handle: DbHandle,
    permit: Permit,
    kind: DraftLineKind,
    id: string,
  ): Promise<T> {
    const issue = kind === 'issue'
    return loadAuthorizedFrom({
      db: handle,
      permit,
      target: issue ? materialTarget : byproductTarget,
      alias: issue ? MATERIAL_ALIAS : BYPRODUCT_ALIAS,
      source: issue ? MATERIAL_SOURCE : BYPRODUCT_SOURCE,
      select: LINE_SELECT,
      id,
      mapRow: (r) => (issue ? mapMaterial(r) : mapByproduct(r)) as unknown as T,
      notFoundMessage: issue ? '发料清单行不存在' : '副产物清单行不存在',
    })
  }

  async function listMaterials(permit: Permit, query: Partial<ListQuery>) {
    return listAuthorized({
    db,
    permit,
    target: materialTarget,
    alias: MATERIAL_ALIAS,
    resource: orderMaterialMeta(),
    source: MATERIAL_SOURCE,
    select: LINE_SELECT,
    defaultOrder: sql`"id" ASC`,
    query,
    mapRow: (r) => mapMaterial(r),
  })
}

  async function getMaterial(permit: Permit, id: string): Promise<OutsourcedSavedIssueLine> {
    return loadLine<OutsourcedSavedIssueLine>(db, permit, 'issue', id)
}

  async function createMaterial(
    permit: Permit,
    input: {
    orderItemId: string
    materialId: string
    unitId: string
    quantity: string
    remarks?: string | null
  },
  ) {
    return withTx(db, async (trx) => {
    const parent = await lockOrderOfItem(trx, permit, input.orderItemId)
    if (!parent.isOutsourced) {
      throw ApiError.validation('发料清单参数不合法', { orderItemId: ['仅委外订单可维护发料清单'] })
    }
    const snap = await loadMaterialSnap(trx, input.materialId, input.unitId)
    guardMaterialType(snap, ['STOCK'], '发料清单行')
    const qty = decimal(input.quantity)
    if (!qty.isPositive()) {
      throw ApiError.validation('发料清单参数不合法', { quantity: ['必须大于 0'] })
    }
    const ins = await sql<{ id: string }>`
      INSERT INTO pur_order_item_material (
        quantity,remarks,order_item_id,company_id,material_id,unit_id
      ) VALUES (
        ${wireRequiredDecimal(qty)},${input.remarks ?? null},${input.orderItemId}::uuid,
        ${parent.companyId}::uuid,${input.materialId}::uuid,${input.unitId}::uuid
      ) RETURNING id
    `.execute(trx)
    const id = ins.rows[0]!.id
    // 事务内权威重读（已授权）：新建行的投影快照
    const dto = (await loadIssueLines(trx, 'id', id))[0]!
    await writeAudit(trx, permit.actor, {
      resource: 'pur_order_item_material',
      recordId: dto.id,
      recordLabel: dto.materialCode,
      companyId: dto.companyId,
      actionType: 'create',
      actionName: 'create',
      changes: auditCreated(materialSnap(dto), MATERIAL_AUDIT),
    })
    return dto
  })
}

  async function updateMaterial(
    permit: Permit,
    id: string,
    input: {
    materialId?: string
    unitId?: string
    quantity?: string
    remarks?: string | null
    remarksPresent?: boolean
  },
  ) {
    return withTx(db, async (trx) => {
    const cur = await sql<{ order_item_id: string }>`
      SELECT order_item_id FROM pur_order_item_material WHERE id=${id}::uuid
    `.execute(trx)
    if (!cur.rows[0]) throw new ApiError('not_found', '发料清单行不存在')
    await lockOrderOfItem(trx, permit, cur.rows[0].order_item_id)
    const before = await loadLine<OutsourcedSavedIssueLine>(trx, permit, 'issue', id)
    const materialId = input.materialId ?? before.materialId
    const unitId = input.unitId ?? before.unitId
    const snap = await loadMaterialSnap(trx, materialId, unitId)
    guardMaterialType(snap, ['STOCK'], '发料清单行')
    const quantity = input.quantity ?? before.quantity
    if (!decimal(quantity).isPositive()) {
      throw ApiError.validation('发料清单参数不合法', { quantity: ['必须大于 0'] })
    }
    await sql`
      UPDATE pur_order_item_material SET
        quantity=${quantity}, material_id=${materialId}::uuid, unit_id=${unitId}::uuid,
        remarks=${input.remarksPresent ? (input.remarks ?? null) : before.remarks},
        updated_at=(now() AT TIME ZONE 'utc')
      WHERE id=${id}::uuid
    `.execute(trx)
    // 事务内权威重读（已授权）：审计 diff 与返回值都取更新后状态
    const dto = (await loadIssueLines(trx, 'id', id))[0]!
    const changes = auditDiff(materialSnap(before), materialSnap(dto), MATERIAL_AUDIT)
    if (Object.keys(changes).length > 0) {
      await writeAudit(trx, permit.actor, {
        resource: 'pur_order_item_material',
        recordId: dto.id,
        recordLabel: dto.materialCode,
        companyId: dto.companyId,
        actionType: 'update',
        actionName: 'update',
        changes,
      })
    }
    return dto
  })
}

  async function deleteMaterial(permit: Permit, id: string) {
    await withTx(db, async (trx) => {
    const cur = await sql<{ order_item_id: string }>`
      SELECT order_item_id FROM pur_order_item_material WHERE id=${id}::uuid
    `.execute(trx)
    if (!cur.rows[0]) throw new ApiError('not_found', '发料清单行不存在')
    await lockOrderOfItem(trx, permit, cur.rows[0].order_item_id)
    const before = (await loadIssueLines(trx, 'id', id))[0]
    if (!before) throw new ApiError('not_found', '发料清单行不存在')
    await writeAudit(trx, permit.actor, {
      resource: 'pur_order_item_material',
      recordId: before.id,
      recordLabel: before.materialCode,
      companyId: before.companyId,
      actionType: 'destroy',
      actionName: 'destroy',
      changes: auditDestroyed(materialSnap(before), MATERIAL_AUDIT),
    })
    await sql`DELETE FROM pur_order_item_material WHERE id=${id}::uuid`.execute(trx)
  })
}

  async function listByproducts(permit: Permit, query: Partial<ListQuery>) {
    return listAuthorized({
    db,
    permit,
    target: byproductTarget,
    alias: BYPRODUCT_ALIAS,
    resource: orderByproductMeta(),
    source: BYPRODUCT_SOURCE,
    select: LINE_SELECT,
    defaultOrder: sql`"id" ASC`,
    query,
    mapRow: (r) => mapByproduct(r),
  })
}

  async function getByproduct(permit: Permit, id: string): Promise<OutsourcedSavedLine> {
    return loadLine<OutsourcedSavedLine>(db, permit, 'byproduct', id)
}

  async function createByproduct(
    permit: Permit,
    input: {
    orderItemId: string
    materialId: string
    unitId: string
    quantity: string
    remarks?: string | null
  },
  ) {
    return withTx(db, async (trx) => {
    const parent = await lockOrderOfItem(trx, permit, input.orderItemId)
    if (!parent.isOutsourced) {
      throw ApiError.validation('副产物清单参数不合法', {
        orderItemId: ['仅委外订单可维护副产物清单'],
      })
    }
    const snap = await loadMaterialSnap(trx, input.materialId, input.unitId)
    guardMaterialType(snap, ['STOCK'], '副产物清单行')
    const qty = decimal(input.quantity)
    if (!qty.isPositive()) {
      throw ApiError.validation('副产物清单参数不合法', { quantity: ['必须大于 0'] })
    }
    const ins = await sql<{ id: string }>`
      INSERT INTO pur_order_item_byproduct (
        quantity,remarks,order_item_id,company_id,material_id,unit_id
      ) VALUES (
        ${wireRequiredDecimal(qty)},${input.remarks ?? null},${input.orderItemId}::uuid,
        ${parent.companyId}::uuid,${input.materialId}::uuid,${input.unitId}::uuid
      ) RETURNING id
    `.execute(trx)
    const id = ins.rows[0]!.id
    // 事务内权威重读（已授权）：新建行的投影快照
    const dto = (await loadByproductLines(trx, 'id', id))[0]!
    await writeAudit(trx, permit.actor, {
      resource: 'pur_order_item_byproduct',
      recordId: dto.id,
      recordLabel: dto.materialCode,
      companyId: dto.companyId,
      actionType: 'create',
      actionName: 'create',
      changes: auditCreated(byproductSnap(dto), BYPRODUCT_AUDIT),
    })
    return dto
  })
}

  async function updateByproduct(
    permit: Permit,
    id: string,
    input: {
    materialId?: string
    unitId?: string
    quantity?: string
    remarks?: string | null
    remarksPresent?: boolean
  },
  ) {
    return withTx(db, async (trx) => {
    const cur = await sql<{ order_item_id: string }>`
      SELECT order_item_id FROM pur_order_item_byproduct WHERE id=${id}::uuid
    `.execute(trx)
    if (!cur.rows[0]) throw new ApiError('not_found', '副产物清单行不存在')
    await lockOrderOfItem(trx, permit, cur.rows[0].order_item_id)
    const before = await loadLine<OutsourcedSavedLine>(trx, permit, 'byproduct', id)
    const materialId = input.materialId ?? before.materialId
    const unitId = input.unitId ?? before.unitId
    const snap = await loadMaterialSnap(trx, materialId, unitId)
    guardMaterialType(snap, ['STOCK'], '副产物清单行')
    const quantity = input.quantity ?? before.quantity
    await sql`
      UPDATE pur_order_item_byproduct SET
        quantity=${quantity}, material_id=${materialId}::uuid, unit_id=${unitId}::uuid,
        remarks=${input.remarksPresent ? (input.remarks ?? null) : before.remarks},
        updated_at=(now() AT TIME ZONE 'utc')
      WHERE id=${id}::uuid
    `.execute(trx)
    // 事务内重读：审计 diff 与返回值都取更新后权威状态
    const dto = (await loadByproductLines(trx, 'id', id))[0]
    if (!dto) throw new ApiError('not_found', '副产物清单行不存在')
    const changes = auditDiff(byproductSnap(before), byproductSnap(dto), BYPRODUCT_AUDIT)
    if (Object.keys(changes).length > 0) {
      await writeAudit(trx, permit.actor, {
        resource: 'pur_order_item_byproduct',
        recordId: dto.id,
        recordLabel: dto.materialCode,
        companyId: dto.companyId,
        actionType: 'update',
        actionName: 'update',
        changes,
      })
    }
    return dto
  })
}

  async function deleteByproduct(permit: Permit, id: string) {
    await withTx(db, async (trx) => {
    const cur = await sql<{ order_item_id: string }>`
      SELECT order_item_id FROM pur_order_item_byproduct WHERE id=${id}::uuid
    `.execute(trx)
    if (!cur.rows[0]) throw new ApiError('not_found', '副产物清单行不存在')
    await lockOrderOfItem(trx, permit, cur.rows[0].order_item_id)
    const before = (await loadByproductLines(trx, 'id', id))[0]
    if (!before) throw new ApiError('not_found', '副产物清单行不存在')
    await writeAudit(trx, permit.actor, {
      resource: 'pur_order_item_byproduct',
      recordId: before.id,
      recordLabel: before.materialCode,
      companyId: before.companyId,
      actionType: 'destroy',
      actionName: 'destroy',
      changes: auditDestroyed(byproductSnap(before), BYPRODUCT_AUDIT),
    })
    await sql`DELETE FROM pur_order_item_byproduct WHERE id=${id}::uuid`.execute(trx)
  })
}

  async function queryDemandPool(
    permit: Permit,
    input: { companyId: string; isOutsourced?: boolean; limit?: number },
  ) {
    // 跨资源单公司聚合（需求池取 mfg_demand 行）：只做码级门控 + 单公司边界，
    // 不套本资源行过滤（谓词会编到别的表上）；公司未授权即空结果，不泄露存在性。
    if (!companyInPermitScope(permit, input.companyId)) {
    return { results: [] as Record<string, unknown>[] }
  }
    const limit = input.limit && input.limit > 0 ? Math.min(input.limit, 200) : 50
    const rows = await sql<Record<string, unknown>>`
    SELECT dl.id, dl.demand_id, d.demand_no, dl.idx, dl.need_date, d.company_id,
      dl.material_id, dl.unit_id, m.code AS material_code, m.name AS material_name, m.spec AS material_spec,
      u.name AS unit_name, dl.base_qty, dl.ordered_qty, dl.arranged_qty,
      greatest(dl.base_qty - dl.arranged_qty, 0) AS remaining_base_qty,
      greatest(dl.base_qty - dl.arranged_qty, 0) AS suggested_qty
    FROM mfg_demand_item dl
    JOIN mfg_demand d ON d.id=dl.demand_id
    JOIN inv_material m ON m.id=dl.material_id
    JOIN bas_unit u ON u.id=dl.unit_id
    WHERE d.company_id=${input.companyId}::uuid
      AND d.status = 'confirmed'
      AND dl.status <> 'completed'
      AND greatest(dl.base_qty - dl.arranged_qty, 0) > 0
    ORDER BY dl.need_date NULLS LAST, dl.idx, dl.id
    LIMIT ${limit}
    `.execute(db)
  return {
    results: rows.rows.map((r) => ({
      id: String(r.id),
      demandId: String(r.demand_id),
      demandNo: String(r.demand_no),
      idx: Number(r.idx),
      needDate: r.need_date ? asDate(r.need_date) : null,
      companyId: String(r.company_id),
      materialId: String(r.material_id),
      unitId: String(r.unit_id),
      materialCode: String(r.material_code),
      materialName: String(r.material_name),
      materialSpec: asOptionalString(r.material_spec),
      unitName: String(r.unit_name),
      baseQty: wireRequiredDecimal(String(r.base_qty)),
      orderedQty: wireRequiredDecimal(String(r.ordered_qty)),
      arrangedQty: wireRequiredDecimal(String(r.arranged_qty ?? 0)),
      remainingBaseQty: wireRequiredDecimal(String(r.remaining_base_qty)),
      suggestedQty: wireRequiredDecimal(String(r.suggested_qty)),
    })),
  }
}

  async function expandBom(
    permit: Permit,
    input: { bomId: string; quantity: string },
  ) {
    // BOM 展开是纯计算读（全局主数据，无公司列）：码级门控由路由 guard 承担
    void permit
    const qty = decimal(input.quantity)
    if (!qty.isPositive()) {
    throw ApiError.validation('BOM 展开参数不合法', { quantity: ['必须大于 0'] })
  }
    const bom = await sql<{ id: string }>`
      SELECT id FROM mfg_bom WHERE id=${input.bomId}::uuid AND status='active'
    `.execute(db)
    if (!bom.rows[0]) {
    throw ApiError.validation('BOM 展开参数不合法', { bomId: ['BOM 不存在或未启用'] })
  }
    const materials = await sql<Record<string, unknown>>`
    SELECT c.material_id, m.code AS material_code, m.name AS material_name, c.unit_id, u.name AS unit_name,
      (c.quantity * (1 + coalesce(c.loss_rate,0)) * ${wireRequiredDecimal(qty)}) AS quantity,
      c.note AS remarks
    FROM mfg_bom_component c
    JOIN inv_material m ON m.id=c.material_id
    JOIN bas_unit u ON u.id=c.unit_id
    WHERE c.bom_id=${input.bomId}::uuid
    ORDER BY c.id
    `.execute(db)
    const byproducts = await sql<Record<string, unknown>>`
    SELECT b.material_id, m.code AS material_code, m.name AS material_name, b.unit_id, u.name AS unit_name,
      (b.quantity * ${wireRequiredDecimal(qty)}) AS quantity, b.note AS remarks
    FROM mfg_bom_byproduct b
    JOIN inv_material m ON m.id=b.material_id
    JOIN bas_unit u ON u.id=b.unit_id
    WHERE b.bom_id=${input.bomId}::uuid
    ORDER BY b.id
    `.execute(db)
    const mapLine = (r: Record<string, unknown>) => ({
    materialId: String(r.material_id),
    materialCode: String(r.material_code),
    materialName: String(r.material_name),
    unitId: String(r.unit_id),
    unitName: String(r.unit_name),
    quantity: wireRequiredDecimal(String(r.quantity)),
    remarks: asOptionalString(r.remarks),
  })
  return {
    materials: materials.rows.map(mapLine),
    byproducts: byproducts.rows.map(mapLine),
  }
}

  /**
   * 订单聚合专用 seam：完整读取全部委外清单，不经过分页列表。
   * 母单可达性由平台执行点判定（不命中 not_found），不再手写公司闸。
   */
  async function loadOrderDraftLines(
    handle: DbHandle,
    permit: Permit,
    orderId: string,
  ): Promise<OutsourcedDraftLines> {
    await loadAuthorized({
      db: handle,
      permit,
      target: orderTarget,
      table: spec.headTable,
      id: orderId,
      notFoundMessage: '采购订单不存在',
    })
    const issueRows = await sql<Record<string, unknown>>`
      SELECT m.id,m.quantity,m.issued_qty,m.remarks,m.inserted_at,m.updated_at,m.order_item_id,
        m.company_id,m.material_id,mat.code AS material_code,mat.name AS material_name,
        mat.spec AS material_spec,m.unit_id,u.name AS unit_name,
        o.order_no,o.status AS order_status,o.is_outsourced AS order_is_outsourced,
        o.party_type,o.party_id,(m.quantity - m.issued_qty) AS remaining_issue_qty
      FROM pur_order_item_material m
      JOIN pur_order_item oi ON oi.id=m.order_item_id
      JOIN pur_order o ON o.id=oi.order_id
      JOIN inv_material mat ON mat.id=m.material_id
      JOIN bas_unit u ON u.id=m.unit_id
      WHERE oi.order_id=${orderId}::uuid
      ORDER BY oi.idx,m.id
    `.execute(handle)
    const byproductRows = await sql<Record<string, unknown>>`
      SELECT b.id,b.quantity,b.remarks,b.inserted_at,b.updated_at,b.order_item_id,b.company_id,
        b.material_id,mat.code AS material_code,mat.name AS material_name,
        mat.spec AS material_spec,b.unit_id,u.name AS unit_name
      FROM pur_order_item_byproduct b
      JOIN pur_order_item oi ON oi.id=b.order_item_id
      JOIN inv_material mat ON mat.id=b.material_id
      JOIN bas_unit u ON u.id=b.unit_id
      WHERE oi.order_id=${orderId}::uuid
      ORDER BY oi.idx,b.id
    `.execute(handle)
    return {
      issueLines: issueRows.rows.map(mapMaterial),
      byproductLines: byproductRows.rows.map(mapByproduct),
    }
  }

  /**
   * 订单聚合专用 seam：以一个条目的完整子快照替换发料/副产物清单。
   * 调用者传入同一个 TrxHandle，因此任一嵌套行失败会回滚订单头、条目及全部清单。
   */
  async function replaceItemDraftLines(
    trx: TrxHandle,
    permit: Permit,
    orderItemId: string,
    input: OutsourcedDraftItemInput,
  ): Promise<void> {
    const parent = await lockOrderOfItem(trx, permit, orderItemId)
    if (!parent.isOutsourced && (input.issueLines.length > 0 || input.byproductLines.length > 0)) {
      throw ApiError.validation('委外配置参数不合法', {
        issueLines: ['仅委外订单可维护发料清单'],
        byproductLines: ['仅委外订单可维护副产物清单'],
      })
    }

    await replaceDraftLineKind(
      trx,
      permit,
      'issue',
      orderItemId,
      parent.companyId,
      input.issueLines,
    )
    await replaceDraftLineKind(
      trx,
      permit,
      'byproduct',
      orderItemId,
      parent.companyId,
      input.byproductLines,
    )
  }

  return {
    listMaterials,
    getMaterial,
    createMaterial,
    updateMaterial,
    deleteMaterial,
    listByproducts,
    getByproduct,
    createByproduct,
    updateByproduct,
    deleteByproduct,
    queryDemandPool,
    expandBom,
    draft: {
      loadOrderLines: loadOrderDraftLines,
      replaceItemLines: replaceItemDraftLines,
    },
  }
}

export type OutsourcedConfigService = ReturnType<typeof createOutsourcedConfigService>

type DraftLineKind = 'issue' | 'byproduct'

async function replaceDraftLineKind(
  trx: TrxHandle,
  permit: Permit,
  kind: DraftLineKind,
  orderItemId: string,
  companyId: string,
  input: OutsourcedDraftLineInput[],
): Promise<void> {
  const resource = kind === 'issue' ? 'pur_order_item_material' : 'pur_order_item_byproduct'
  const allowed = kind === 'issue' ? MATERIAL_AUDIT : BYPRODUCT_AUDIT
  const existingLines = kind === 'issue'
    ? await loadIssueLines(trx, 'order_item_id', orderItemId)
    : await loadByproductLines(trx, 'order_item_id', orderItemId)
  const existingById = new Map(existingLines.map((line) => [line.id, line]))
  const existingIds = new Set(existingById.keys())
  const seenIds = new Set<string>()
  const seenMaterialUnits = new Set<string>()
  const fields: Record<string, string[]> = {}
  const fieldPrefix = kind === 'issue' ? 'issueLines' : 'byproductLines'

  for (let index = 0; index < input.length; index++) {
    const line = input[index]!
    if (line.id !== undefined) {
      if (seenIds.has(line.id)) {
        fields[`${fieldPrefix}[${index}].id`] = ['同一清单中不能重复']
      } else if (!existingIds.has(line.id)) {
        fields[`${fieldPrefix}[${index}].id`] = ['不属于该订单条目']
      }
      seenIds.add(line.id)
    }
    const materialUnit = `${line.materialId}:${line.unitId}`
    if (seenMaterialUnits.has(materialUnit)) {
      fields[`${fieldPrefix}[${index}].materialId`] = ['同一物料与单位在本清单中不能重复']
    }
    seenMaterialUnits.add(materialUnit)
    try {
      const snap = await loadMaterialSnap(trx, line.materialId, line.unitId)
      guardMaterialType(snap, ['STOCK'], kind === 'issue' ? '发料清单行' : '副产物清单行')
    } catch (error) {
      if (error instanceof ApiError && error.code === 'validation' && error.fields) {
        for (const [field, messages] of Object.entries(error.fields)) {
          fields[`${fieldPrefix}[${index}].${field}`] = messages
        }
      } else {
        throw error
      }
    }
    if (!decimal(line.quantity).gt(0)) {
      fields[`${fieldPrefix}[${index}].quantity`] = ['必须大于 0']
    }
  }
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation(
      kind === 'issue' ? '发料清单参数不合法' : '副产物清单参数不合法',
      fields,
    )
  }

  const requestedIds = new Set(
    input.flatMap((line) => (line.id === undefined ? [] : [line.id])),
  )
  for (const line of existingLines) {
    if (requestedIds.has(line.id)) continue
    await writeAudit(trx, permit.actor, {
      resource,
      recordId: line.id,
      recordLabel: line.materialCode,
      companyId: line.companyId,
      actionType: 'destroy',
      actionName: 'destroy',
      changes: auditDestroyed(lineSnap(kind, line), allowed),
    })
    if (kind === 'issue') {
      await sql`DELETE FROM pur_order_item_material WHERE id=${line.id}::uuid`.execute(trx)
    } else {
      await sql`DELETE FROM pur_order_item_byproduct WHERE id=${line.id}::uuid`.execute(trx)
    }
  }

  for (const line of input) {
    const quantity = wireRequiredDecimal(decimal(line.quantity))
    if (line.id === undefined) {
      let createdId: string
      if (kind === 'issue') {
        const ins = await sql<{ id: string }>`
          INSERT INTO pur_order_item_material (
            quantity,remarks,order_item_id,company_id,material_id,unit_id
          ) VALUES (
            ${quantity},${line.remarks ?? null},${orderItemId}::uuid,${companyId}::uuid,
            ${line.materialId}::uuid,${line.unitId}::uuid
          ) RETURNING id
        `.execute(trx)
        createdId = ins.rows[0]!.id
      } else {
        const ins = await sql<{ id: string }>`
          INSERT INTO pur_order_item_byproduct (
            quantity,remarks,order_item_id,company_id,material_id,unit_id
          ) VALUES (
            ${quantity},${line.remarks ?? null},${orderItemId}::uuid,${companyId}::uuid,
            ${line.materialId}::uuid,${line.unitId}::uuid
          ) RETURNING id
        `.execute(trx)
        createdId = ins.rows[0]!.id
      }
      const created = kind === 'issue'
        ? (await loadIssueLines(trx, 'id', createdId))[0]!
        : (await loadByproductLines(trx, 'id', createdId))[0]!
      await writeAudit(trx, permit.actor, {
        resource,
        recordId: created.id,
        recordLabel: created.materialCode,
        companyId: created.companyId,
        actionType: 'create',
        actionName: 'create',
        changes: auditCreated(lineSnap(kind, created), allowed),
      })
      continue
    }
    if (kind === 'issue') {
      await sql`
        UPDATE pur_order_item_material SET
          quantity=${quantity},material_id=${line.materialId}::uuid,
          unit_id=${line.unitId}::uuid,remarks=${line.remarks ?? null},
          updated_at=(now() AT TIME ZONE 'utc')
        WHERE id=${line.id}::uuid
      `.execute(trx)
    } else {
      await sql`
        UPDATE pur_order_item_byproduct SET
          quantity=${quantity},material_id=${line.materialId}::uuid,
          unit_id=${line.unitId}::uuid,remarks=${line.remarks ?? null},
          updated_at=(now() AT TIME ZONE 'utc')
        WHERE id=${line.id}::uuid
      `.execute(trx)
    }
    const before = existingById.get(line.id)!
    const after = kind === 'issue'
      ? (await loadIssueLines(trx, 'id', line.id))[0]!
      : (await loadByproductLines(trx, 'id', line.id))[0]!
    const changes = auditDiff(lineSnap(kind, before), lineSnap(kind, after), allowed)
    if (Object.keys(changes).length > 0) {
      await writeAudit(trx, permit.actor, {
        resource,
        recordId: after.id,
        recordLabel: after.materialCode,
        companyId: after.companyId,
        actionType: 'update',
        actionName: 'update',
        changes,
      })
    }
  }

}

/** 事务内权威重读（授权已由母单执行点完成）：审计 before/after 快照与 delete 留痕共用 */
async function loadIssueLines(
  handle: DbHandle,
  col: 'id' | 'order_item_id',
  value: string,
): Promise<OutsourcedSavedIssueLine[]> {
  const rows = await sql<Record<string, unknown>>`
    SELECT m.id,m.quantity,m.issued_qty,m.remarks,m.inserted_at,m.updated_at,m.order_item_id,
      m.company_id,m.material_id,mat.code AS material_code,mat.name AS material_name,
      mat.spec AS material_spec,m.unit_id,u.name AS unit_name,
      o.order_no,o.status AS order_status,o.is_outsourced AS order_is_outsourced,
      o.party_type,o.party_id,(m.quantity - m.issued_qty) AS remaining_issue_qty
    FROM pur_order_item_material m
    JOIN pur_order_item oi ON oi.id=m.order_item_id
    JOIN pur_order o ON o.id=oi.order_id
    JOIN inv_material mat ON mat.id=m.material_id
    JOIN bas_unit u ON u.id=m.unit_id
    WHERE ${sql.raw(col === 'id' ? 'm.id' : 'm.order_item_id')}=${value}::uuid
    ORDER BY m.inserted_at, m.id
  `.execute(handle)
  return rows.rows.map(mapMaterial)
}

async function loadByproductLines(
  handle: DbHandle,
  col: 'id' | 'order_item_id',
  value: string,
): Promise<OutsourcedSavedLine[]> {
  const rows = await sql<Record<string, unknown>>`
    SELECT b.id,b.quantity,b.remarks,b.inserted_at,b.updated_at,b.order_item_id,b.company_id,
      b.material_id,mat.code AS material_code,mat.name AS material_name,
      mat.spec AS material_spec,b.unit_id,u.name AS unit_name
    FROM pur_order_item_byproduct b
    JOIN inv_material mat ON mat.id=b.material_id
    JOIN bas_unit u ON u.id=b.unit_id
    WHERE ${sql.raw(col === 'id' ? 'b.id' : 'b.order_item_id')}=${value}::uuid
    ORDER BY b.inserted_at, b.id
  `.execute(handle)
  return rows.rows.map(mapByproduct)
}

function materialSnap(line: OutsourcedSavedIssueLine): Record<string, unknown> {
  return {
    quantity: line.quantity,
    issued_qty: line.issuedQty,
    remarks: line.remarks,
    order_item_id: line.orderItemId,
    company_id: line.companyId,
    material_id: line.materialId,
    unit_id: line.unitId,
  }
}

function byproductSnap(line: OutsourcedSavedLine): Record<string, unknown> {
  return {
    quantity: line.quantity,
    remarks: line.remarks,
    order_item_id: line.orderItemId,
    company_id: line.companyId,
    material_id: line.materialId,
    unit_id: line.unitId,
  }
}

function lineSnap(kind: DraftLineKind, line: OutsourcedSavedLine): Record<string, unknown> {
  return kind === 'issue'
    ? materialSnap(line as OutsourcedSavedIssueLine)
    : byproductSnap(line)
}

function mapMaterial(row: Record<string, unknown>): OutsourcedSavedIssueLine {
  return {
    id: String(row.id),
    quantity: wireRequiredDecimal(String(row.quantity)),
    issuedQty: wireRequiredDecimal(String(row.issued_qty ?? 0)),
    remarks: asOptionalString(row.remarks),
    insertedAt: asDateTime(row.inserted_at)!,
    updatedAt: asDateTime(row.updated_at)!,
    orderItemId: String(row.order_item_id),
    companyId: String(row.company_id),
    materialId: String(row.material_id),
    materialCode: String(row.material_code),
    materialName: String(row.material_name),
    materialSpec: asOptionalString(row.material_spec),
    unitId: String(row.unit_id),
    unitName: String(row.unit_name),
    orderNo: String(row.order_no ?? ''),
    orderStatus: upperStatus(String(row.order_status ?? 'DRAFT')),
    orderIsOutsourced: Boolean(row.order_is_outsourced),
    partyType: upperStatus(String(row.party_type ?? '')),
    partyId: String(row.party_id ?? ''),
    remainingIssueQty: wireRequiredDecimal(String(row.remaining_issue_qty ?? 0)),
  }
}

function mapByproduct(row: Record<string, unknown>): OutsourcedSavedLine {
  return {
    id: String(row.id),
    quantity: wireRequiredDecimal(String(row.quantity)),
    remarks: asOptionalString(row.remarks),
    insertedAt: asDateTime(row.inserted_at)!,
    updatedAt: asDateTime(row.updated_at)!,
    orderItemId: String(row.order_item_id),
    companyId: String(row.company_id),
    materialId: String(row.material_id),
    materialCode: String(row.material_code),
    materialName: String(row.material_name),
    materialSpec: asOptionalString(row.material_spec),
    unitId: String(row.unit_id),
    unitName: String(row.unit_name),
  }
}
