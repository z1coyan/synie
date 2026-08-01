import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tableManifest } from '../convex/migration/tableManifest'
import { decimalManifest, legacyNumericColumns } from '../convex/migration/decimalManifest'
import {
  legacyResourceInventory,
  migrationStatuses,
  resourceManifest,
} from '../convex/migration/resourceManifest'

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function exists(path: string): boolean {
  return existsSync(join(import.meta.dir, '..', path))
}

const tableNames = tableManifest.map((entry) => entry.legacyTable)
invariant(tableManifest.length === 105, `table baseline 漂移: ${tableManifest.length}/105`)
invariant(new Set(tableNames).size === tableNames.length, 'table manifest 存在重复项')
for (const entry of tableManifest) {
  invariant(Object.keys(entry.disposition).length === 1, `${entry.legacyTable} disposition 不唯一`)
}

invariant(legacyNumericColumns.length === 148, 'decimal baseline 漂移')
invariant(decimalManifest.length === legacyNumericColumns.length, 'decimal manifest 数量不一致')
for (const entry of decimalManifest) {
  invariant(entry.storage === 'int64', `${entry.legacyColumn} 未使用 int64`)
  invariant(entry.maxAbsScaled <= 9_223_372_036_854_775_807n, `${entry.legacyColumn} 超出 signed int64`)
}

invariant(resourceManifest.length === 100, `resource baseline 漂移: ${resourceManifest.length}/100`)
invariant(legacyResourceInventory.length === resourceManifest.length, 'resource inventory/manifest 数量不一致')
const names = resourceManifest.map((entry) => entry.resource)
invariant(new Set(names).size === names.length, 'resource manifest 存在重复项')
for (const entry of resourceManifest) {
  invariant(migrationStatuses.includes(entry.status), `${entry.resource} status 非法`)
  invariant(entry.status === 'convex-verified' || entry.status === 'retired', `${entry.resource} 未完成切流`)
  invariant(entry.writerAuthority.legacyMode === 'none', `${entry.resource} 仍声明旧写权威`)
  invariant(entry.status === 'retired'
    ? entry.writerAuthority.convexMode === 'none'
    : entry.writerAuthority.convexMode === 'convex', `${entry.resource} Convex 写权威漂移`)
  invariant(entry.audit === 'convex-formal', `${entry.resource} 未接入正式审计`)
  invariant(entry.constraints.length > 0, `${entry.resource} 缺少约束清单`)
  if (entry.status !== 'retired') {
    invariant(exists(entry.targetFunctionModule), `${entry.resource} target 不存在: ${entry.targetFunctionModule}`)
    invariant(entry.portedTests.length > 0 && entry.portedTests.every(exists), `${entry.resource} replacement tests 不完整`)
    invariant(!entry.frontendBinding || entry.frontendRoutes.every(exists), `${entry.resource} frontend binding evidence 不存在`)
  }
}

const storage = resourceManifest.find((entry) => entry.resource === 'sysStorages')
invariant(storage?.retirementPlan === 'retired-by-006', 'sysStorages 退役记录缺失')

console.log(
  `Convex final manifest 通过：${tableManifest.length} tables，` +
    `${resourceManifest.length} resources，${decimalManifest.length} numeric，0 未解释`,
)
