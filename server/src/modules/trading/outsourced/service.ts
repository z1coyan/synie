/**
 * 委外发料/入库最小头 CRUD（工单 06 仅为 verify-fulfillment 标准脚本所需；完整委外见工单 10）。
 */
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { withTx } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import { canAccessCompany, type Actor } from '~/platform/authz/actor.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import {
  asDate,
  asDateTime,
  asOptionalString,
  lowerParty,
  partyExists,
  requirePerm,
  todayUTC,
  toDateOnly,
  upperStatus,
} from '../common.ts'

export {
  outsourcedIssueMeta,
  outsourcedIssueItemMeta,
  outsourcedReceiptMeta,
  outsourcedReceiptItemMeta,
  outsourcedReceiptItemMaterialMeta,
  outsourcedReceiptItemByproductMeta,
} from './meta.ts'

type Numberer = Pick<NumberingService, 'nextInTx'>

export function createOutsourcedService(db: Kysely<Database>, numberer: Numberer) {
  async function listEmpty(actor: Actor, prefix: string) {
    requirePerm(actor, prefix, 'read', '无权限执行该委外操作')
    return { count: 0, results: [] as Record<string, unknown>[] }
  }

  async function createIssue(
    actor: Actor,
    input: {
      companyId: string
      issueNo?: string | null
      issueDate?: string | null
      partyType: string
      partyId: string
      remarks?: string | null
    },
  ) {
    requirePerm(actor, 'purchase.outsourced_issue', 'create', '无权限执行该委外操作')
    if (!canAccessCompany(actor, input.companyId)) {
      throw new ApiError('forbidden', '无权在该公司创建委外单')
    }
    return withTx(db, async (trx) => {
      const issueDate = input.issueDate ? toDateOnly(input.issueDate) : todayUTC()
      let issueNo = (input.issueNo ?? '').trim()
      if (!issueNo) {
        issueNo = await numberer.nextInTx(trx, {
          resource: 'purchase.outsourced_issue',
          values: { company_id: input.companyId, document_date: issueDate },
        })
      }
      if (!(await partyExists(trx, input.partyType, input.partyId))) {
        throw ApiError.validation('委外发料参数不合法', { partyId: ['对手不存在'] })
      }
      const ins = await sql<{ id: string }>`
        INSERT INTO pur_outsourced_issue (issue_no, issue_date, party_type, party_id, remarks, company_id, created_by_id)
        VALUES (
          ${issueNo}, ${issueDate}::date, ${lowerParty(input.partyType)}, ${input.partyId}::uuid,
          ${input.remarks ?? null}, ${input.companyId}::uuid, ${actor.userId || null}::uuid
        ) RETURNING id
      `.execute(trx)
      const rows = await sql<Record<string, unknown>>`
        SELECT * FROM pur_outsourced_issue WHERE id=${ins.rows[0]!.id}::uuid
      `.execute(trx)
      return mapIssue(rows.rows[0]!)
    })
  }

  async function getIssue(actor: Actor, id: string) {
    requirePerm(actor, 'purchase.outsourced_issue', 'read', '无权限执行该委外操作')
    const rows = await sql<Record<string, unknown>>`
      SELECT * FROM pur_outsourced_issue WHERE id=${id}::uuid
    `.execute(db)
    const row = rows.rows[0]
    if (!row || !canAccessCompany(actor, String(row.company_id))) {
      throw new ApiError('not_found', '委外发料单不存在')
    }
    return mapIssue(row)
  }

  async function updateIssue(actor: Actor, id: string, input: { remarks?: string | null }) {
    requirePerm(actor, 'purchase.outsourced_issue', 'update', '无权限执行该委外操作')
    return withTx(db, async (trx) => {
      const cur = await getIssue(actor, id)
      if (cur.status !== 'DRAFT') throw new ApiError('conflict', '仅草稿可编辑')
      await sql`
        UPDATE pur_outsourced_issue SET remarks=${input.remarks ?? null}, updated_at=(now() AT TIME ZONE 'utc')
        WHERE id=${id}::uuid
      `.execute(trx)
      const rows = await sql<Record<string, unknown>>`
        SELECT * FROM pur_outsourced_issue WHERE id=${id}::uuid
      `.execute(trx)
      return mapIssue(rows.rows[0]!)
    })
  }

  async function deleteIssue(actor: Actor, id: string) {
    requirePerm(actor, 'purchase.outsourced_issue', 'delete', '无权限执行该委外操作')
    await withTx(db, async (trx) => {
      const cur = await getIssue(actor, id)
      if (cur.status !== 'DRAFT') throw new ApiError('conflict', '仅草稿可删除')
      await sql`DELETE FROM pur_outsourced_issue WHERE id=${id}::uuid`.execute(trx)
    })
  }

  async function createReceipt(
    actor: Actor,
    input: {
      companyId: string
      receiptNo?: string | null
      receiptDate?: string | null
      partyType: string
      partyId: string
      remarks?: string | null
      debitAccountId: string
      creditAccountId: string
    },
  ) {
    requirePerm(actor, 'purchase.outsourced_receipt', 'create', '无权限执行该委外操作')
    if (!canAccessCompany(actor, input.companyId)) {
      throw new ApiError('forbidden', '无权在该公司创建委外单')
    }
    return withTx(db, async (trx) => {
      const receiptDate = input.receiptDate ? toDateOnly(input.receiptDate) : todayUTC()
      let receiptNo = (input.receiptNo ?? '').trim()
      if (!receiptNo) {
        receiptNo = await numberer.nextInTx(trx, {
          resource: 'purchase.outsourced_receipt',
          values: { company_id: input.companyId, document_date: receiptDate },
        })
      }
      if (!(await partyExists(trx, input.partyType, input.partyId))) {
        throw ApiError.validation('委外入库参数不合法', { partyId: ['对手不存在'] })
      }
      const ins = await sql<{ id: string }>`
        INSERT INTO pur_outsourced_receipt (
          receipt_no, receipt_date, party_type, party_id, remarks, company_id,
          debit_account_id, credit_account_id, created_by_id
        ) VALUES (
          ${receiptNo}, ${receiptDate}::date, ${lowerParty(input.partyType)}, ${input.partyId}::uuid,
          ${input.remarks ?? null}, ${input.companyId}::uuid,
          ${input.debitAccountId}::uuid, ${input.creditAccountId}::uuid, ${actor.userId || null}::uuid
        ) RETURNING id
      `.execute(trx)
      const rows = await sql<Record<string, unknown>>`
        SELECT * FROM pur_outsourced_receipt WHERE id=${ins.rows[0]!.id}::uuid
      `.execute(trx)
      return mapReceipt(rows.rows[0]!)
    })
  }

  async function getReceipt(actor: Actor, id: string) {
    requirePerm(actor, 'purchase.outsourced_receipt', 'read', '无权限执行该委外操作')
    const rows = await sql<Record<string, unknown>>`
      SELECT * FROM pur_outsourced_receipt WHERE id=${id}::uuid
    `.execute(db)
    const row = rows.rows[0]
    if (!row || !canAccessCompany(actor, String(row.company_id))) {
      throw new ApiError('not_found', '委外入库单不存在')
    }
    return mapReceipt(row)
  }

  async function updateReceipt(actor: Actor, id: string, input: { remarks?: string | null }) {
    requirePerm(actor, 'purchase.outsourced_receipt', 'update', '无权限执行该委外操作')
    return withTx(db, async (trx) => {
      const cur = await getReceipt(actor, id)
      if (cur.status !== 'DRAFT') throw new ApiError('conflict', '仅草稿可编辑')
      await sql`
        UPDATE pur_outsourced_receipt SET remarks=${input.remarks ?? null}, updated_at=(now() AT TIME ZONE 'utc')
        WHERE id=${id}::uuid
      `.execute(trx)
      const rows = await sql<Record<string, unknown>>`
        SELECT * FROM pur_outsourced_receipt WHERE id=${id}::uuid
      `.execute(trx)
      return mapReceipt(rows.rows[0]!)
    })
  }

  async function deleteReceipt(actor: Actor, id: string) {
    requirePerm(actor, 'purchase.outsourced_receipt', 'delete', '无权限执行该委外操作')
    await withTx(db, async (trx) => {
      const cur = await getReceipt(actor, id)
      if (cur.status !== 'DRAFT') throw new ApiError('conflict', '仅草稿可删除')
      await sql`DELETE FROM pur_outsourced_receipt WHERE id=${id}::uuid`.execute(trx)
    })
  }

  return {
    listEmpty,
    createIssue,
    getIssue,
    updateIssue,
    deleteIssue,
    createReceipt,
    getReceipt,
    updateReceipt,
    deleteReceipt,
  }
}

export type OutsourcedService = ReturnType<typeof createOutsourcedService>

function mapIssue(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    issueNo: String(row.issue_no),
    issueDate: asDate(row.issue_date),
    partyType: upperStatus(String(row.party_type)),
    partyId: String(row.party_id),
    remarks: asOptionalString(row.remarks),
    status: upperStatus(String(row.status)),
    companyId: String(row.company_id),
    insertedAt: asDateTime(row.inserted_at)!,
    updatedAt: asDateTime(row.updated_at)!,
  }
}

function mapReceipt(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    receiptNo: String(row.receipt_no),
    receiptDate: asDate(row.receipt_date),
    partyType: upperStatus(String(row.party_type)),
    partyId: String(row.party_id),
    remarks: asOptionalString(row.remarks),
    status: upperStatus(String(row.status)),
    companyId: String(row.company_id),
    debitAccountId: String(row.debit_account_id),
    creditAccountId: String(row.credit_account_id),
    insertedAt: asDateTime(row.inserted_at)!,
    updatedAt: asDateTime(row.updated_at)!,
  }
}
