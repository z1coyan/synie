/**
 * 银行领域工厂：账户/流水/导入/对账。
 */
import type { Kysely } from 'kysely'
import type { DB as Database } from '~/db/types.ts'
import { createGlEngine, type GlEngine } from '~/engines/gl/index.ts'
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
    files?: Pick<FileService, 'readStoredFile'> | null
    gl?: GlEngine
    utcOffsetMs?: number
  } = {},
) {
  const gl = deps.gl ?? createGlEngine()
  const accounts = createAccountAndTxnOps(db)
  const imports = createImportOps(db, {
    files: deps.files ?? null,
    createTransactionInTx: accounts.createTransactionInTx,
    utcOffsetMs: deps.utcOffsetMs,
  })
  const recon = createReconOps(db, numbering, gl)
  return {
    ...accounts,
    ...imports,
    ...recon,
  }
}
