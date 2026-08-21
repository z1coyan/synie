/**
 * 发票↔对账互锁接缝：close/reopen/exists/load。
 * 收 Actor + 外层 trx，不进 workflow（语义逐字冻结）。
 */
import { sql } from 'kysely'
import type { DbHandle } from '~/db/tx.ts'
import { auditFieldsOf } from '~/platform/audit/spec.ts'
import { auditDiff, writeAudit } from '~/platform/audit/write.ts'
import type { Actor } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import { closeTodos, openTodo } from './domain.ts'
import {
  reconciliationSpec,
  type ReconciliationSideSpec,
  type ReconciliationStatus,
} from './spec.ts'
import type { ReconciliationHead } from './types.ts'
import { mapHeadPropsFromDb } from './views.ts'

export interface InvoiceReconHead {
  reconciliationType: string
  status: string
  companyId: string
  partyType: string
  partyId: string
  gross: string
  debitAccountId: string
  creditAccountId: string
}

async function loadHeadRow(
  dbHandle: DbHandle,
  spec: ReconciliationSideSpec,
  id: string,
): Promise<Record<string, unknown> | null> {
  const rows = await sql<Record<string, unknown>>`
    SELECT h.id,h.reconciliation_no,h.reconciliation_type,h.party_type,h.party_id,
      h.posting_date,h.remarks,h.status,h.inserted_at,h.updated_at,h.company_id,
      h.debit_account_id,h.credit_account_id,h.created_by_id,
      COALESCE(SUM(i.amount),0) AS gross_total,
      COALESCE(SUM(i.base_amount),0) AS base_gross_total
    FROM ${sql.raw(spec.table)} h
    LEFT JOIN ${sql.raw(spec.itemTable)} i ON i.reconciliation_id=h.id
    WHERE h.id=${id}::uuid
    GROUP BY h.id
  `.execute(dbHandle)
  return rows.rows[0] ?? null
}

function headSnap(row: Record<string, unknown>) {
  return {
    reconciliation_no: String(row.reconciliation_no),
    reconciliation_type: String(row.reconciliation_type),
    party_type: String(row.party_type),
    party_id: String(row.party_id),
    posting_date: row.posting_date != null ? String(row.posting_date).slice(0, 10) : null,
    remarks: row.remarks != null ? String(row.remarks) : null,
    status: String(row.status),
    company_id: String(row.company_id),
    debit_account_id: String(row.debit_account_id),
    credit_account_id: String(row.credit_account_id),
    created_by_id: row.created_by_id != null ? String(row.created_by_id) : null,
  }
}

async function invoiceState(
  dbHandle: DbHandle,
  actor: Actor,
  registry: Registry,
  side: 'sales' | 'purchase',
  id: string,
  from: ReconciliationStatus,
  to: ReconciliationStatus,
  action: string,
  effect: (spec: ReconciliationSideSpec, head: ReconciliationHead) => Promise<void>,
): Promise<ReconciliationHead> {
  const spec = reconciliationSpec(side)
  const locked = await sql<{ status: string; reconciliation_type: string }>`
    SELECT status, reconciliation_type FROM ${sql.raw(spec.table)}
    WHERE id=${id}::uuid FOR UPDATE
  `.execute(dbHandle)
  if (!locked.rows[0]) throw new ApiError('not_found', `${spec.label}不存在`)
  if (locked.rows[0].status !== from || locked.rows[0].reconciliation_type !== 'regular') {
    throw new ApiError('conflict', '常规对账单状态不允许发票联动')
  }
  const before = await loadHeadRow(dbHandle, spec, id)
  if (!before) throw new ApiError('not_found', `${spec.label}不存在`)
  await effect(spec, mapHeadPropsFromDb(before))
  await sql`
    UPDATE ${sql.raw(spec.table)} SET status=${to}, updated_at=(now() AT TIME ZONE 'utc')
    WHERE id=${id}::uuid
  `.execute(dbHandle)
  const after = await loadHeadRow(dbHandle, spec, id)
  if (!after) throw new ApiError('not_found', `${spec.label}不存在`)
  const auditMeta = auditFieldsOf(registry.get(spec.headResource)!)
  await writeAudit(dbHandle, actor, {
    resource: spec.table,
    recordId: id,
    recordLabel: String(before.reconciliation_no),
    companyId: String(before.company_id),
    actionType: 'update',
    actionName: action,
    changes: auditDiff(headSnap(before), headSnap(after), auditMeta),
  })
  return mapHeadPropsFromDb(after)
}

export async function closeFromInvoice(
  dbHandle: DbHandle,
  actor: Actor,
  registry: Registry,
  side: 'sales' | 'purchase',
  id: string,
): Promise<ReconciliationHead> {
  return invoiceState(
    dbHandle,
    actor,
    registry,
    side,
    id,
    'confirmed',
    'closed',
    'close_from_invoice',
    async (spec) => {
      await closeTodos(dbHandle, spec, id, 'invoice_audit')
    },
  )
}

export async function reopenFromInvoice(
  dbHandle: DbHandle,
  actor: Actor,
  registry: Registry,
  side: 'sales' | 'purchase',
  id: string,
): Promise<ReconciliationHead> {
  return invoiceState(
    dbHandle,
    actor,
    registry,
    side,
    id,
    'closed',
    'confirmed',
    'reopen_from_invoice',
    async (spec, head) => {
      await openTodo(dbHandle, spec, head as unknown as Record<string, unknown>, null)
    },
  )
}

export async function existsForInvoice(
  dbHandle: DbHandle,
  side: 'sales' | 'purchase',
  id: string,
): Promise<boolean> {
  const spec = reconciliationSpec(side)
  const rows = await sql<{ e: boolean }>`
    SELECT EXISTS(SELECT 1 FROM ${sql.raw(spec.table)} WHERE id=${id}::uuid) AS e
  `.execute(dbHandle)
  return Boolean(rows.rows[0]?.e)
}

export async function loadForInvoiceAudit(
  dbHandle: DbHandle,
  side: 'sales' | 'purchase',
  id: string,
): Promise<InvoiceReconHead | null> {
  const spec = reconciliationSpec(side)
  const head = await sql<{
    reconciliation_type: string
    status: string
    company_id: string
    party_type: string
    party_id: string
    gross: string
    debit_account_id: string
    credit_account_id: string
  }>`
    SELECT h.reconciliation_type, h.status, h.company_id::text, h.party_type, h.party_id::text,
      (SELECT COALESCE(sum(i.base_amount),0)::text FROM ${sql.raw(spec.itemTable)} i
        WHERE i.reconciliation_id=h.id) AS gross,
      h.debit_account_id::text, h.credit_account_id::text
    FROM ${sql.raw(spec.table)} h WHERE h.id=${id}::uuid FOR UPDATE
  `.execute(dbHandle)
  if (head.rows.length === 0) return null
  const h = head.rows[0]!
  return {
    reconciliationType: h.reconciliation_type,
    status: h.status,
    companyId: h.company_id,
    partyType: h.party_type,
    partyId: h.party_id,
    gross: h.gross,
    debitAccountId: h.debit_account_id,
    creditAccountId: h.credit_account_id,
  }
}
