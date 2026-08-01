import { existsSync } from 'node:fs'
import { ioMigrationManifest } from '../convex/migration/ioManifest'
import { resourceManifest } from '../convex/migration/resourceManifest'
import { tableManifest } from '../convex/migration/tableManifest'
import { transactionClosures, transactionSourceRules } from '../convex/migration/closureManifest'

type CutoverReport = {
  baseline: {
    resources: number
    activeResources: number
    retiredResources: number
    sqlTables: number
    transactionSourceCalls: number
    transactionClosures: number
    externalIoOperations: number
  }
  evidence: { replacementTests: string[] }
  dataPremise: { productionDataToMigrate: boolean; importerRequired: boolean }
}

const report = await Bun.file(
  new URL('../convex/migration/cutoverReport.json', import.meta.url),
).json() as CutoverReport

const legacyResources = resourceManifest.filter((entry) =>
  (entry.status !== 'convex-verified' && entry.status !== 'retired') ||
  entry.writerAuthority.legacyMode !== 'none' ||
  (entry.status === 'convex-verified' && entry.writerAuthority.convexMode !== 'convex') ||
  (entry.status === 'retired' && entry.writerAuthority.convexMode !== 'none') ||
  (entry.status !== 'retired' && !existsSync(entry.targetFunctionModule)),
).length + Math.abs(resourceManifest.length - report.baseline.resources)

const unmappedTables = tableManifest.filter((entry) =>
  Object.keys(entry.disposition).length !== 1,
).length + Math.abs(tableManifest.length - report.baseline.sqlTables)

const forbiddenWebPatterns = [
  /\/api\/v1/,
  /\bapiData\b/,
  /api\/client/,
  /\brest:/,
  /VITE_SYNIE_BACKEND/,
  /backend-mode/,
  /hono\/client/,
  /@synie\/server/,
  /synie:token/,
]
const webFiles = [
  'web/package.json',
  'web/vite.config.ts',
  'web/Dockerfile',
]
const sourceGlob = new Bun.Glob('web/app/**/*.{ts,tsx}')
for await (const file of sourceGlob.scan({ cwd: '.', onlyFiles: true })) {
  if (file.includes('.test.') || file.endsWith('-checks.ts') || file.endsWith('.gen.ts')) continue
  webFiles.push(file)
}
let restBindings = 0
for (const file of webFiles) {
  if (!existsSync(file)) continue
  const source = await Bun.file(file).text()
  if (forbiddenWebPatterns.some((pattern) => pattern.test(source))) restBindings += 1
}

const mappedCalls = transactionSourceRules.reduce((sum, entry) => sum + entry[3], 0)
const invalidSources = transactionSourceRules.filter(([, closure, target, calls]) =>
  !transactionClosures.some((entry) => entry.id === closure) ||
  !existsSync(target) ||
  !Number.isSafeInteger(calls) ||
  calls < 0,
).length
const unmappedTransactions = invalidSources + Math.abs(
  mappedCalls - report.baseline.transactionSourceCalls,
)

const crossBackendClosures = transactionClosures.filter((entry) =>
  entry.status !== 'convex-verified',
).length + resourceManifest.filter((entry) =>
  entry.writerAuthority.legacyMode !== 'none',
).length + ioMigrationManifest.filter((entry) =>
  entry.status !== 'convex-verified',
).length + (report.dataPremise.productionDataToMigrate || report.dataPremise.importerRequired ? 1 : 0)

const reportDrift =
  Math.abs(resourceManifest.filter((entry) => entry.status === 'convex-verified').length - report.baseline.activeResources) +
  Math.abs(resourceManifest.filter((entry) => entry.status === 'retired').length - report.baseline.retiredResources) +
  Math.abs(transactionClosures.length - report.baseline.transactionClosures) +
  Math.abs(ioMigrationManifest.length - report.baseline.externalIoOperations) +
  report.evidence.replacementTests.filter((path) => !existsSync(path)).length

const finalCrossBackendClosures = crossBackendClosures + reportDrift

console.log(`legacyResources=${legacyResources}`)
console.log(`unmappedTables=${unmappedTables}`)
console.log(`restBindings=${restBindings}`)
console.log(`unmappedTransactions=${unmappedTransactions}`)
console.log(`crossBackendClosures=${finalCrossBackendClosures}`)

if (legacyResources || unmappedTables || restBindings || unmappedTransactions || finalCrossBackendClosures) {
  process.exit(1)
}
