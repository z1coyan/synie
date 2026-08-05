/**
 * mfg.work_order 打印装配：工单头 + BOM 快照循环（配料/路线/副产品）。
 * 键名对齐打印字段目录（db 列名 / relation.field）。
 */
import { sql } from 'kysely'
import { findAuthorized } from '~/db/load.ts'
import type { DbHandle } from '~/db/tx.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { DocBuilder } from '~/platform/printing/docbuilder.ts'
import {
  enumLabel,
  formatBool,
  formatDate,
  formatDateTime,
  formatDecimal,
  formatInt,
  formatText,
} from '~/platform/printing/format.ts'
import type { BuiltDoc, PrintDoc } from '~/platform/printing/types.ts'
import { WORK_ORDER_RESOURCE } from './work-order-service.ts'

const WO_STATUS_LABELS: Record<string, string> = {
  in_progress: '进行中',
  IN_PROGRESS: '进行中',
  completed: '已完工',
  COMPLETED: '已完工',
  voided: '已作废',
  VOIDED: '已作废',
}

interface HeadRow {
  work_order_no: string
  qty: string
  base_qty: string
  received_base_qty: string
  remaining_base_qty: string
  need_date: Date | string | null
  material_code: string
  material_name: string
  material_spec: string | null
  unit_name: string
  status: string
  company_id: string
  company_code: string
  company_name: string
  company_short: string | null
  demand_no: string | null
  owner_dept_code: string | null
  owner_dept_name: string | null
  bom_code: string | null
  bom_plan_name: string | null
  creator_name: string | null
  inserted_at: Date | string
  updated_at: Date | string
}

interface ComponentRow {
  quantity: string
  loss_rate: string | null
  note: string | null
  idx: string | number
  m_code: string
  m_name: string
  m_spec: string | null
  u_name: string
  u_symbol: string | null
}

interface RouteRow {
  seq: string | number
  requirement: string | null
  is_outsourced: boolean
  op_code: string
  op_name: string
}

interface ByproductRow {
  quantity: string
  note: string | null
  idx: string | number
  m_code: string
  m_name: string
  m_spec: string | null
  u_name: string
  u_symbol: string | null
}

export function createWorkOrderDocBuilder(db: DbHandle, registry: Registry): DocBuilder {
  const target = registry.authzTarget(WORK_ORDER_RESOURCE)
  return {
    label: () => '生产工单',
    async buildDocs(permit, ids) {
      const result: BuiltDoc[] = []
      for (const id of ids) {
        // 行可达性一次编译到 WHERE（公司/部门/属主）；不命中与不存在同为 not_found
        const reachable = await findAuthorized({
          db,
          permit,
          target,
          table: 'mfg_work_order',
          id,
        })
        const head = reachable ? await loadHead(db, id) : undefined
        if (!head) {
          throw new ApiError('not_found', '部分单据不存在或无权查看')
        }
        const [components, routes, byproducts] = await Promise.all([
          loadComponents(db, id),
          loadRoutes(db, id),
          loadByproducts(db, id),
        ])
        result.push({
          sheetName: head.work_order_no,
          doc: toDoc(head, components, routes, byproducts),
        })
      }
      return result
    },
  }
}

export function registerWorkOrderDocBuilder(
  printing: { registerDocBuilder: (resource: string, builder: DocBuilder) => void },
  db: DbHandle,
  registry: Registry,
): void {
  printing.registerDocBuilder('mfg.work_order', createWorkOrderDocBuilder(db, registry))
}

async function loadHead(db: DbHandle, id: string): Promise<HeadRow | undefined> {
  const rows = await sql<HeadRow>`
SELECT
  w.work_order_no,
  w.qty::text AS qty,
  w.base_qty::text AS base_qty,
  w.received_base_qty::text AS received_base_qty,
  (w.base_qty - w.received_base_qty)::text AS remaining_base_qty,
  w.need_date,
  w.material_code,
  w.material_name,
  w.material_spec,
  w.unit_name,
  w.status,
  w.company_id::text AS company_id,
  c.code AS company_code,
  c.name AS company_name,
  c.short_name AS company_short,
  d.demand_no,
  owner_dept.code AS owner_dept_code,
  owner_dept.name AS owner_dept_name,
  b.code AS bom_code,
  b.plan_name AS bom_plan_name,
  creator.name AS creator_name,
  w.inserted_at,
  w.updated_at
FROM mfg_work_order w
JOIN bas_company c ON c.id = w.company_id
LEFT JOIN mfg_demand d ON d.id = w.demand_id
LEFT JOIN sys_department owner_dept ON owner_dept.id = w.owner_dept_id
LEFT JOIN mfg_bom b ON b.id = w.bom_id
LEFT JOIN sys_user creator ON creator.id = w.created_by_id
WHERE w.id = ${id}::uuid
`.execute(db)
  return rows.rows[0]
}

async function loadComponents(db: DbHandle, workOrderId: string): Promise<ComponentRow[]> {
  const rows = await sql<ComponentRow>`
SELECT
  c.quantity::text AS quantity,
  c.loss_rate::text AS loss_rate,
  c.note,
  c.idx,
  m.code AS m_code,
  m.name AS m_name,
  m.spec AS m_spec,
  u.name AS u_name,
  u.symbol AS u_symbol
FROM mfg_work_order_component c
JOIN inv_material m ON m.id = c.material_id
JOIN bas_unit u ON u.id = c.unit_id
WHERE c.work_order_id = ${workOrderId}::uuid
ORDER BY c.idx, c.id
`.execute(db)
  return rows.rows
}

async function loadRoutes(db: DbHandle, workOrderId: string): Promise<RouteRow[]> {
  const rows = await sql<RouteRow>`
SELECT
  r.seq,
  r.requirement,
  r.is_outsourced,
  o.code AS op_code,
  o.name AS op_name
FROM mfg_work_order_route r
JOIN mfg_operation o ON o.id = r.operation_id
WHERE r.work_order_id = ${workOrderId}::uuid
ORDER BY r.seq, r.id
`.execute(db)
  return rows.rows
}

async function loadByproducts(db: DbHandle, workOrderId: string): Promise<ByproductRow[]> {
  const rows = await sql<ByproductRow>`
SELECT
  b.quantity::text AS quantity,
  b.note,
  b.idx,
  m.code AS m_code,
  m.name AS m_name,
  m.spec AS m_spec,
  u.name AS u_name,
  u.symbol AS u_symbol
FROM mfg_work_order_byproduct b
JOIN inv_material m ON m.id = b.material_id
JOIN bas_unit u ON u.id = b.unit_id
WHERE b.work_order_id = ${workOrderId}::uuid
ORDER BY b.idx, b.id
`.execute(db)
  return rows.rows
}

function toDoc(
  head: HeadRow,
  components: ComponentRow[],
  routes: RouteRow[],
  byproducts: ByproductRow[],
): PrintDoc {
  return {
    fields: {
      work_order_no: head.work_order_no,
      qty: formatDecimal(head.qty),
      base_qty: formatDecimal(head.base_qty),
      received_base_qty: formatDecimal(head.received_base_qty),
      remaining_base_qty: formatDecimal(head.remaining_base_qty),
      need_date: formatDate(head.need_date),
      material_code: head.material_code,
      material_name: head.material_name,
      material_spec: formatText(head.material_spec),
      unit_name: head.unit_name,
      status: enumLabel(WO_STATUS_LABELS, head.status),
      'company.code': head.company_code,
      'company.name': head.company_name,
      'company.short_name': formatText(head.company_short),
      'demand.demand_no': formatText(head.demand_no),
      'owner_dept.code': formatText(head.owner_dept_code),
      'owner_dept.name': formatText(head.owner_dept_name),
      'bom.code': formatText(head.bom_code),
      'bom.plan_name': formatText(head.bom_plan_name),
      'created_by.name': formatText(head.creator_name),
      inserted_at: formatDateTime(head.inserted_at),
      updated_at: formatDateTime(head.updated_at),
    },
    loops: {
      components: components.map((c) => ({
        quantity: formatDecimal(c.quantity),
        loss_rate: formatDecimal(c.loss_rate),
        note: formatText(c.note),
        idx: formatInt(c.idx),
        'material.code': c.m_code,
        'material.name': c.m_name,
        'material.spec': formatText(c.m_spec),
        'unit.name': c.u_name,
        'unit.symbol': formatText(c.u_symbol),
      })),
      routes: routes.map((r) => ({
        seq: formatInt(r.seq),
        requirement: formatText(r.requirement),
        is_outsourced: formatBool(r.is_outsourced),
        'operation.code': r.op_code,
        'operation.name': r.op_name,
      })),
      byproducts: byproducts.map((b) => ({
        quantity: formatDecimal(b.quantity),
        note: formatText(b.note),
        idx: formatInt(b.idx),
        'material.code': b.m_code,
        'material.name': b.m_name,
        'material.spec': formatText(b.m_spec),
        'unit.name': b.u_name,
        'unit.symbol': formatText(b.u_symbol),
      })),
    },
  }
}
