import { existsSync } from 'node:fs'
import { closureForResource, transactionClosures, transactionSourceRules } from '../convex/migration/closureManifest'
import { resourceManifest } from '../convex/migration/resourceManifest'

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const ids = new Set(transactionClosures.map((closure) => closure.id))
for (const closure of transactionClosures) {
  invariant(closure.status === 'convex-verified', `${closure.id} 未验收`)
  for (const dependency of closure.dependsOn) invariant(ids.has(dependency), `${closure.id} 依赖未知闭包 ${dependency}`)
}

const visiting = new Set<string>()
const visited = new Set<string>()
function visit(id: string): void {
  if (visited.has(id)) return
  invariant(!visiting.has(id), `事务闭包 DAG 存在 cycle: ${id}`)
  visiting.add(id)
  const closure = transactionClosures.find((candidate) => candidate.id === id)!
  for (const dependency of closure.dependsOn) visit(dependency)
  visiting.delete(id)
  visited.add(id)
}
for (const id of ids) visit(id)

for (const entry of resourceManifest) {
  invariant(entry.transactionClosure === closureForResource(entry.resource), `${entry.resource} 闭包映射漂移`)
}

const sources = new Set<string>()
let sourceCalls = 0
for (const [source, closure, target, calls] of transactionSourceRules) {
  invariant(!sources.has(source), `重复事务 source: ${source}`)
  sources.add(source)
  invariant(ids.has(closure), `${source} 映射未知闭包 ${closure}`)
  invariant(existsSync(target), `${source} target 不存在: ${target}`)
  invariant(Number.isSafeInteger(calls) && calls >= 0, `${source} sourceCalls 非法`)
  sourceCalls += calls
}
invariant(sourceCalls === 279, `withTx 基线漂移: ${sourceCalls}/279`)

console.log(
  `Convex closure DAG 通过：${transactionClosures.length} closures，` +
    `${resourceManifest.length} resources，${sourceCalls}/279 source calls mapped`,
)
