/**
 * 银行领域工厂：账户/流水/导入/对账。
 */
import type { Kysely } from 'kysely'
import type { DB as Database } from '~/db/types.ts'
import type { JournalService } from '~/modules/accounting/journal-service.ts'
import type { FileService } from '~/platform/files/service.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import { createAccountAndTxnOps } from './banking-accounts.ts'
import { createImportOps } from './banking-import.ts'
import { createReconOps } from './banking-recon.ts'

export type {
  BankAccount, BankTransaction,
} from './banking-accounts.ts'
export type {
  BankImport, BankImportItem, BankImportTemplate,
} from './banking-import.ts'
export type { BankReconciliation } from './banking-recon.ts'

export type BankingService = ReturnType<typeof createBankingService>

export function createBankingService(
  db: Kysely<Database>,
  numbering: NumberingService,
  deps: {
    /** 快速对账凭证的凭证 seam（accounting 注入，装配期必填） */
    journals: Pick<JournalService, 'createAndAuditJournal'>
    files?: Pick<FileService, 'readStoredFile'> | null
    utcOffsetMs?: number
  },
) {
  const accounts = createAccountAndTxnOps(db)
  const imports = createImportOps(db, {
    files: deps.files ?? null,
    createTransactionInTx: accounts.createTransactionInTx,
    utcOffsetMs: deps.utcOffsetMs,
  })
  const recon = createReconOps(db, { journals: deps.journals })
  return {
    ...accounts,
    ...imports,
    ...recon,
  }
}
