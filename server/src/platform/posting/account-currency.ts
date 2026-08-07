/**
 * 借贷科目币种解析（原 skeleton 内联；履约/委外审核 effect 共用）。
 */
import { sql } from 'kysely'
import type { DbHandle } from '~/db/tx.ts'

export async function accountCurrencies(db: DbHandle, debitId: string, creditId: string) {
  const rows = await sql<{ id: string; currency_id: string | null }>`
    SELECT id, currency_id FROM bas_account WHERE id = ANY(${[debitId, creditId]}::uuid[])
  `.execute(db)
  const map = new Map(rows.rows.map((r) => [r.id, r.currency_id]))
  return { debit: map.get(debitId) ?? null, credit: map.get(creditId) ?? null }
}
