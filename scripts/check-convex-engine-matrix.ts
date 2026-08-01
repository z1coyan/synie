import { existsSync } from 'node:fs'
import { engineOperationMatrix, legacyEngineTestMap } from '../convex/migration/engineMatrix'

const replacementFiles = [...new Set(legacyEngineTestMap.map(([, , , file]) => file))]
const discoveredReplacementTests = new Map<string, Set<string>>()
for (const file of replacementFiles.filter((path) => path.endsWith('.test.ts'))) {
  const source = await Bun.file(file).text()
  const titles = new Set<string>()
  for (const match of source.matchAll(/\btest\(\s*(['"])(.*?)\1/g)) {
    titles.add(match[2])
  }
  discoveredReplacementTests.set(file, titles)
}
const missingEvidence = replacementFiles.filter((file) => !existsSync(file))
const missingReplacementTests = legacyEngineTestMap
  .filter(([, title, status, file]) =>
    status === 'ported' && file.endsWith('.test.ts') && !discoveredReplacementTests.get(file)?.has(title),
  )
const duplicateHistoricalCases = legacyEngineTestMap.filter(([source, title], index) =>
  legacyEngineTestMap.findIndex(([candidateSource, candidateTitle]) =>
    source === candidateSource && title === candidateTitle,
  ) !== index,
)
const invalidNa = legacyEngineTestMap.filter(
  ([, title, status]) =>
    (status !== 'ported' && status !== 'not-applicable') ||
    (status === 'not-applicable' && title !== 'seed fixture'),
)
const incompleteOperations = Object.entries(engineOperationMatrix).filter(
  ([, row]) => !row.readSet || !row.writes || !row.idempotency || !row.budget,
)
if (missingEvidence.length || missingReplacementTests.length || duplicateHistoricalCases.length || invalidNa.length || incompleteOperations.length) {
  console.error(JSON.stringify({ missingEvidence, missingReplacementTests, duplicateHistoricalCases, invalidNa, incompleteOperations }, null, 2))
  process.exit(1)
}
console.log(
  `Convex engine matrix: ${legacyEngineTestMap.length}/${legacyEngineTestMap.length} historical cases mapped to live evidence; ` +
    `${Object.keys(engineOperationMatrix).length} write operations budgeted`,
)
