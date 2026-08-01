import { engineOperationMatrix, legacyEngineTestMap } from '../convex/migration/engineMatrix'

const files = [...new Set(legacyEngineTestMap.map(([file]) => file))]
const expected = new Set(legacyEngineTestMap.map(([file, title]) => `${file}\0${title}`))
const discovered = new Set<string>()
for (const file of files) {
  const source = await Bun.file(file).text()
  for (const match of source.matchAll(/\btest\(\s*(['"])(.*?)\1/g)) {
    discovered.add(`${file}\0${match[2]}`)
  }
}
const missing = [...discovered].filter((key) => !expected.has(key))
const stale = [...expected].filter((key) => !discovered.has(key))
const invalidNa = legacyEngineTestMap.filter(
  ([, title, status]) => status === 'not-applicable' && title !== 'seed fixture',
)
const incompleteOperations = Object.entries(engineOperationMatrix).filter(
  ([, row]) => !row.readSet || !row.writes || !row.idempotency || !row.budget,
)
if (missing.length || stale.length || invalidNa.length || incompleteOperations.length) {
  console.error(JSON.stringify({ missing, stale, invalidNa, incompleteOperations }, null, 2))
  process.exit(1)
}
console.log(
  `Convex engine matrix: ${discovered.size}/${discovered.size} legacy tests mapped; ` +
    `${Object.keys(engineOperationMatrix).length} write operations budgeted`,
)
