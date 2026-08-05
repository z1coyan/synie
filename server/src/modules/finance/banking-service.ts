/**
 * 银行领域工厂：账户/流水/导入/对账。
 */
import type { Kysely } from 'kysely'
import type { DB as Database } from '~/db/types.ts'
import type { JournalService } from '~/modules/accounting/journal-service.ts'
import type { FileService } from '~/platform/files/service.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import { createAccountAndTxnOps } from './banking-accounts.ts'
import { createImportOps } from './banking-import.ts'
import { createReconOps } from './banking-recon.ts'

export {
  BANK_ACCOUNT_RESOURCE,
  BANK_TRANSACTION_RESOURCE,
} from './banking-accounts.ts'
export {
  BANK_IMPORT_ITEM_RESOURCE,
  BANK_IMPORT_RESOURCE,
  BANK_IMPORT_TEMPLATE_RESOURCE,
} from './banking-import.ts'
export { BANK_RECONCILIATION_RESOURCE } from './banking-recon.ts'
export type { BankAccount } from './banking-accounts.ts'
export type { BankTransaction } from './banking-shared.ts'
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
    /** 判定归宿解析（三个执行点共用） */
    registry: Registry
  },
) {
  const accounts = createAccountAndTxnOps(db, deps.registry)
  const imports = createImportOps(db, deps.registry, {
    files: deps.files ?? null,
    createTransactionInTx: accounts.createTransactionInTx,
    utcOffsetMs: deps.utcOffsetMs,
  })
  const recon = createReconOps(db, deps.registry, {
    journals: deps.journals,
    authorizedTransaction: accounts.authorizedTransaction,
  })
  return {
    ...accounts,
    ...imports,
    ...recon,
  }
}
