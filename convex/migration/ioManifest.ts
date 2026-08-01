export type IoMigrationEntry = {
  legacySource: string
  operation: string
  target: string
  timeoutMs: number | null
  retry: string
  idempotency: string
  secretLocation: 'convex-deployment-env' | 'server-runtime-env' | 'none'
  status: 'convex-verified'
}

/** Closed inventory of legacy process/network/file-system side effects. */
export const ioMigrationManifest: readonly IoMigrationEntry[] = [
  {
    legacySource: 'server/src/platform/files/object-storage.ts',
    operation: 'S3 bytes/signing/delete', target: 'convex/files/{actions,s3,maintenance}.ts',
    timeoutMs: 20_000, retry: 'fileDeleteJobs + ioJobs exponential backoff',
    idempotency: 'immutable object key + intent/file job ids', secretLocation: 'convex-deployment-env',
    status: 'convex-verified',
  },
  {
    legacySource: 'server/src/platform/files/service.ts',
    operation: 'upload/download/attachment lifecycle', target: 'convex/files/domain.ts',
    timeoutMs: null, retry: 'durable cleanup cron', idempotency: 'uploadIntent/fileId',
    secretLocation: 'none', status: 'convex-verified',
  },
  {
    legacySource: 'server/src/modules/finance/bank-parser.ts',
    operation: 'bank file parse/import', target: 'convex/domains/finance/bankImportActions.ts',
    timeoutMs: null, retry: 'ioJobs lease recovery', idempotency: 'actor+file+template hash and chunk witness',
    secretLocation: 'convex-deployment-env', status: 'convex-verified',
  },
  {
    legacySource: 'server/src/modules/hr/attendance-import.ts',
    operation: 'attendance file parse/import', target: 'convex/domains/hr/attendanceImportActions.ts',
    timeoutMs: null, retry: 'ioJobs lease recovery', idempotency: 'actor+file hash, chunk witness, projection generation',
    secretLocation: 'convex-deployment-env', status: 'convex-verified',
  },
  {
    legacySource: 'server/src/modules/finance/ocr.ts',
    operation: 'Aliyun OCR ACS3 request', target: 'convex/domains/finance/ocrActions.ts',
    timeoutMs: 20_000, retry: 'explicit user retry', idempotency: 'prefill-only, no business write',
    secretLocation: 'convex-deployment-env', status: 'convex-verified',
  },
  {
    legacySource: 'server/src/modules/base/market/fetch.ts',
    operation: 'Sina/SHFE market fetch', target: 'convex/domains/market/actions.ts',
    timeoutMs: 15_000, retry: 'ioJobs exponential backoff/dead-letter',
    idempotency: 'provider slot + active instrument/time/kind point', secretLocation: 'none',
    status: 'convex-verified',
  },
  {
    legacySource: 'server/src/jobs/marketsched/scheduler.ts',
    operation: 'process timer', target: 'convex/crons.ts + convex/jobs/runner.ts',
    timeoutMs: null, retry: 'persisted lease recovery', idempotency: 'Shanghai schedule slot',
    secretLocation: 'none', status: 'convex-verified',
  },
  {
    legacySource: 'server/src/platform/printing/pdf.ts',
    operation: 'LibreOffice XLSX to PDF', target: 'web/app/server/printing/worker.ts',
    timeoutMs: 60_000, retry: 'print job lease recovery', idempotency: 'print job id',
    secretLocation: 'server-runtime-env', status: 'convex-verified',
  },
] as const
