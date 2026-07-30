/**
 * 采购委外配置：发料清单 / 副产物 / 需求池 / BOM 展开。
 * 从 order/service 拆出，与订单主聚合弱关联、与 outsourced 天然同组。
 */
import type { ListQuery } from '@synie/shared'
import { decimal } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { withTx, type DbHandle } from '~/db/tx.ts'
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
  }
}

export type OutsourcedConfigService = ReturnType<typeof createOutsourcedConfigService>

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
function mapMaterial(row: Record<string, unknown>) {
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

function mapByproduct(row: Record<string, unknown>) {
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
