/**
 * 采购委外配置：发料清单 / 副产物 / 需求池 / BOM 展开。
 * 从 order/service 拆出，与订单主聚合弱关联、与 outsourced 天然同组。
 */
import type { ListQuery } from '@synie/shared'
import { decimal } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { withTx, type DbHandle, type TrxHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import { canAccessCompany, type Actor } from '~/platform/authz/actor.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { companyScopeWhere, listFromSource } from '~/db/list.ts'
import {
  asDate,
  asDateTime,
  asOptionalString,
  loadMaterialSnap,
  requirePerm,
  upperStatus,
  wireRequiredDecimal,
} from '../common.ts'
import { orderByproductMeta, orderMaterialMeta } from './spec.ts'

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

export function createOutsourcedConfigService(db: Kysely<Database>) {

  async function listMaterials(actor: Actor, query: Partial<ListQuery>) {
    requirePerm(actor, 'purchase.order', 'read', '无权限执行该采购订单操作')
    const scope = companyScopeWhere(actor)
    if (scope.empty) return { count: 0, results: [] as Record<string, unknown>[] }
    return listFromSource({
    db,
    resource: orderMaterialMeta(),
    source: sql` FROM (
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
    ) order_item_materials`,
    select: sql`SELECT *`,
    defaultOrder: sql`"id" ASC`,
    query,
    extraWhere: scope.where,
    mapRow: (r) => mapMaterial(r),
  })
}

  async function getMaterial(actor: Actor, id: string) {
    requirePerm(actor, 'purchase.order', 'read', '无权限执行该采购订单操作')
    const rows = await sql<Record<string, unknown>>`
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
    WHERE m.id=${id}::uuid
    `.execute(db)
    if (!rows.rows[0] || !canAccessCompany(actor, String(rows.rows[0].company_id))) {
    throw new ApiError('not_found', '发料清单行不存在')
  }
    return mapMaterial(rows.rows[0])
}

  async function createMaterial(
    actor: Actor,
    input: {
    orderItemId: string
    materialId: string
    unitId: string
    quantity: string
    remarks?: string | null
  },
  ) {
    requirePerm(actor, 'purchase.order', 'create', '无权限执行该采购订单操作')
    return withTx(db, async (trx) => {
    const parent = await lockPurchaseItemParent(trx, actor, input.orderItemId)
    if (!parent.isOutsourced) {
      throw ApiError.validation('发料清单参数不合法', { orderItemId: ['仅委外订单可维护发料清单'] })
    }
    const snap = await loadMaterialSnap(trx, input.materialId, input.unitId)
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
    const rows = await sql<Record<string, unknown>>`
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
      WHERE m.id=${id}::uuid
    `.execute(trx)
    return mapMaterial(rows.rows[0]!)
  })
}

  async function updateMaterial(
    actor: Actor,
    id: string,
    input: {
    materialId?: string
    unitId?: string
    quantity?: string
    remarks?: string | null
    remarksPresent?: boolean
  },
  ) {
    requirePerm(actor, 'purchase.order', 'update', '无权限执行该采购订单操作')
    return withTx(db, async (trx) => {
    const cur = await sql<{ order_item_id: string }>`
      SELECT order_item_id FROM pur_order_item_material WHERE id=${id}::uuid
    `.execute(trx)
    if (!cur.rows[0]) throw new ApiError('not_found', '发料清单行不存在')
    await lockPurchaseItemParent(trx, actor, cur.rows[0].order_item_id)
    const before = await getMaterial(actor, id)
    const materialId = input.materialId ?? before.materialId
    const unitId = input.unitId ?? before.unitId
    const snap = await loadMaterialSnap(trx, materialId, unitId)
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
    const rows = await sql<Record<string, unknown>>`
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
      WHERE m.id=${id}::uuid
    `.execute(trx)
    return mapMaterial(rows.rows[0]!)
  })
}

  async function deleteMaterial(actor: Actor, id: string) {
    requirePerm(actor, 'purchase.order', 'delete', '无权限执行该采购订单操作')
    await withTx(db, async (trx) => {
    const cur = await sql<{ order_item_id: string }>`
      SELECT order_item_id FROM pur_order_item_material WHERE id=${id}::uuid
    `.execute(trx)
    if (!cur.rows[0]) throw new ApiError('not_found', '发料清单行不存在')
    await lockPurchaseItemParent(trx, actor, cur.rows[0].order_item_id)
    await sql`DELETE FROM pur_order_item_material WHERE id=${id}::uuid`.execute(trx)
  })
}

  async function listByproducts(actor: Actor, query: Partial<ListQuery>) {
    requirePerm(actor, 'purchase.order', 'read', '无权限执行该采购订单操作')
    const scope = companyScopeWhere(actor)
    if (scope.empty) return { count: 0, results: [] as Record<string, unknown>[] }
    return listFromSource({
    db,
    resource: orderByproductMeta(),
    source: sql` FROM (
      SELECT b.id,b.quantity,b.remarks,b.inserted_at,b.updated_at,b.order_item_id,b.company_id,
        b.material_id,mat.code AS material_code,mat.name AS material_name,mat.spec AS material_spec,
        b.unit_id,u.name AS unit_name
      FROM pur_order_item_byproduct b
      JOIN inv_material mat ON mat.id=b.material_id
      JOIN bas_unit u ON u.id=b.unit_id
    ) order_item_byproducts`,
    select: sql`SELECT *`,
    defaultOrder: sql`"id" ASC`,
    query,
    extraWhere: scope.where,
    mapRow: (r) => mapByproduct(r),
  })
}

  async function getByproduct(actor: Actor, id: string) {
    requirePerm(actor, 'purchase.order', 'read', '无权限执行该采购订单操作')
    const rows = await sql<Record<string, unknown>>`
    SELECT b.id,b.quantity,b.remarks,b.inserted_at,b.updated_at,b.order_item_id,b.company_id,
      b.material_id,mat.code AS material_code,mat.name AS material_name,mat.spec AS material_spec,
      b.unit_id,u.name AS unit_name
    FROM pur_order_item_byproduct b
    JOIN inv_material mat ON mat.id=b.material_id
    JOIN bas_unit u ON u.id=b.unit_id
    WHERE b.id=${id}::uuid
    `.execute(db)
    if (!rows.rows[0] || !canAccessCompany(actor, String(rows.rows[0].company_id))) {
    throw new ApiError('not_found', '副产物清单行不存在')
  }
    return mapByproduct(rows.rows[0])
}

  async function createByproduct(
    actor: Actor,
    input: {
    orderItemId: string
    materialId: string
    unitId: string
    quantity: string
    remarks?: string | null
  },
  ) {
    requirePerm(actor, 'purchase.order', 'create', '无权限执行该采购订单操作')
    return withTx(db, async (trx) => {
    const parent = await lockPurchaseItemParent(trx, actor, input.orderItemId)
    if (!parent.isOutsourced) {
      throw ApiError.validation('副产物清单参数不合法', {
        orderItemId: ['仅委外订单可维护副产物清单'],
      })
    }
    const snap = await loadMaterialSnap(trx, input.materialId, input.unitId)
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
    const rows = await sql<Record<string, unknown>>`
      SELECT b.id,b.quantity,b.remarks,b.inserted_at,b.updated_at,b.order_item_id,b.company_id,
        b.material_id,mat.code AS material_code,mat.name AS material_name,mat.spec AS material_spec,
        b.unit_id,u.name AS unit_name
      FROM pur_order_item_byproduct b
      JOIN inv_material mat ON mat.id=b.material_id
      JOIN bas_unit u ON u.id=b.unit_id
      WHERE b.id=${id}::uuid
    `.execute(trx)
    return mapByproduct(rows.rows[0]!)
  })
}

  async function updateByproduct(
    actor: Actor,
    id: string,
    input: {
    materialId?: string
    unitId?: string
    quantity?: string
    remarks?: string | null
    remarksPresent?: boolean
  },
  ) {
    requirePerm(actor, 'purchase.order', 'update', '无权限执行该采购订单操作')
    return withTx(db, async (trx) => {
    const cur = await sql<{ order_item_id: string }>`
      SELECT order_item_id FROM pur_order_item_byproduct WHERE id=${id}::uuid
    `.execute(trx)
    if (!cur.rows[0]) throw new ApiError('not_found', '副产物清单行不存在')
    await lockPurchaseItemParent(trx, actor, cur.rows[0].order_item_id)
    const before = await getByproduct(actor, id)
    const materialId = input.materialId ?? before.materialId
    const unitId = input.unitId ?? before.unitId
    const snap = await loadMaterialSnap(trx, materialId, unitId)
    const quantity = input.quantity ?? before.quantity
    await sql`
      UPDATE pur_order_item_byproduct SET
        quantity=${quantity}, material_id=${materialId}::uuid, unit_id=${unitId}::uuid,
        remarks=${input.remarksPresent ? (input.remarks ?? null) : before.remarks},
        updated_at=(now() AT TIME ZONE 'utc')
      WHERE id=${id}::uuid
    `.execute(trx)
    return getByproduct(actor, id)
  })
}

  async function deleteByproduct(actor: Actor, id: string) {
    requirePerm(actor, 'purchase.order', 'delete', '无权限执行该采购订单操作')
    await withTx(db, async (trx) => {
    const cur = await sql<{ order_item_id: string }>`
      SELECT order_item_id FROM pur_order_item_byproduct WHERE id=${id}::uuid
    `.execute(trx)
    if (!cur.rows[0]) throw new ApiError('not_found', '副产物清单行不存在')
    await lockPurchaseItemParent(trx, actor, cur.rows[0].order_item_id)
    await sql`DELETE FROM pur_order_item_byproduct WHERE id=${id}::uuid`.execute(trx)
  })
}

  async function queryDemandPool(
    actor: Actor,
    input: { companyId: string; isOutsourced?: boolean; limit?: number },
  ) {
    requirePerm(actor, 'purchase.order', 'read', '无权限执行该采购订单操作')
    if (!canAccessCompany(actor, input.companyId)) {
    throw new ApiError('not_found', '公司不存在')
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
    actor: Actor,
    input: { bomId: string; quantity: string },
  ) {
    requirePerm(actor, 'purchase.order', 'read', '无权限执行该采购订单操作')
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
   * 权限由订单 Aggregate Draft 入口负责；这里仍执行公司范围 fail-closed。
   */
  async function loadOrderDraftLines(
    handle: DbHandle,
    actor: Actor,
    orderId: string,
  ): Promise<OutsourcedDraftLines> {
    const head = await sql<{ company_id: string }>`
      SELECT company_id FROM pur_order WHERE id=${orderId}::uuid
    `.execute(handle)
    if (!head.rows[0] || !canAccessCompany(actor, head.rows[0].company_id)) {
      throw new ApiError('not_found', '采购订单不存在')
    }
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
    actor: Actor,
    orderItemId: string,
    input: OutsourcedDraftItemInput,
  ): Promise<void> {
    const parent = await lockPurchaseItemParent(trx, actor, orderItemId)
    if (!parent.isOutsourced && (input.issueLines.length > 0 || input.byproductLines.length > 0)) {
      throw ApiError.validation('委外配置参数不合法', {
        issueLines: ['仅委外订单可维护发料清单'],
        byproductLines: ['仅委外订单可维护副产物清单'],
      })
    }

    await replaceDraftLineKind(
      trx,
      'issue',
      orderItemId,
      parent.companyId,
      input.issueLines,
    )
    await replaceDraftLineKind(
      trx,
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
  kind: DraftLineKind,
  orderItemId: string,
  companyId: string,
  input: OutsourcedDraftLineInput[],
): Promise<void> {
  const existing = kind === 'issue'
    ? await sql<{ id: string }>`
        SELECT id FROM pur_order_item_material
        WHERE order_item_id=${orderItemId}::uuid
      `.execute(trx)
    : await sql<{ id: string }>`
        SELECT id FROM pur_order_item_byproduct
        WHERE order_item_id=${orderItemId}::uuid
      `.execute(trx)
  const existingIds = new Set(existing.rows.map((line) => line.id))
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
      await loadMaterialSnap(trx, line.materialId, line.unitId)
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
  for (const id of existingIds) {
    if (requestedIds.has(id)) continue
    if (kind === 'issue') {
      await sql`DELETE FROM pur_order_item_material WHERE id=${id}::uuid`.execute(trx)
    } else {
      await sql`DELETE FROM pur_order_item_byproduct WHERE id=${id}::uuid`.execute(trx)
    }
  }

  for (const line of input) {
    const quantity = wireRequiredDecimal(decimal(line.quantity))
    if (line.id === undefined) {
      if (kind === 'issue') {
        await sql`
          INSERT INTO pur_order_item_material (
            quantity,remarks,order_item_id,company_id,material_id,unit_id
          ) VALUES (
            ${quantity},${line.remarks ?? null},${orderItemId}::uuid,${companyId}::uuid,
            ${line.materialId}::uuid,${line.unitId}::uuid
          )
        `.execute(trx)
      } else {
        await sql`
          INSERT INTO pur_order_item_byproduct (
            quantity,remarks,order_item_id,company_id,material_id,unit_id
          ) VALUES (
            ${quantity},${line.remarks ?? null},${orderItemId}::uuid,${companyId}::uuid,
            ${line.materialId}::uuid,${line.unitId}::uuid
          )
        `.execute(trx)
      }
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
  }

}

async function lockPurchaseItemParent(
  db: DbHandle,
  actor: Actor,
  orderItemId: string,
): Promise<{ companyId: string; isOutsourced: boolean; status: string }> {
  const rows = await sql<{
    company_id: string
    is_outsourced: boolean
    status: string
    order_id: string
  }>`
    SELECT o.company_id, o.is_outsourced, o.status, o.id AS order_id
    FROM pur_order_item oi
    JOIN pur_order o ON o.id=oi.order_id
    WHERE oi.id=${orderItemId}::uuid
    FOR UPDATE OF o
  `.execute(db)
  const row = rows.rows[0]
  if (!row || !canAccessCompany(actor, row.company_id)) {
    throw new ApiError('not_found', '订单条目不存在')
  }
  if (row.status.toLowerCase() !== 'draft') {
    throw new ApiError('conflict', '仅草稿订单可编辑条目')
  }
  return {
    companyId: row.company_id,
    isOutsourced: row.is_outsourced,
    status: row.status,
  }
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
