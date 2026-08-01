import type { ConvexReactClient } from 'convex/react'
import type { AggregateDraftAdapter } from './catalog/types'
import { createConvexBindingResolver } from './convex-bindings'
import { CONVEX_DOMAIN_MANIFEST } from './convex-domain-manifest'
import { expenseReportClient } from './finance-operations'
import {
  activateConvexResourceBindings,
  aggregateDraftFor,
  listAggregateDraftResourceKeys,
  resourceBindingFor,
} from './registry'

type Call = { kind: 'query' | 'mutation'; args: unknown }

const calls: Call[] = []
const client = {
  async query(_reference: unknown, args: unknown) {
    calls.push({ kind: 'query', args })
    return { id: 'loaded-1', items: [] }
  },
  async mutation(_reference: unknown, args: unknown) {
    calls.push({ kind: 'mutation', args })
    return { id: 'saved-1', items: [] }
  },
} as unknown as ConvexReactClient

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const expected = Object.entries(CONVEX_DOMAIN_MANIFEST)
  .filter(([, manifest]) => manifest.aggregate)
  .map(([resource]) => resource)
  .sort()

activateConvexResourceBindings(createConvexBindingResolver(client))

assert(expenseReportClient.create === undefined, '普通报销单 create 未被移除')
assert(expenseReportClient.update === undefined, '普通报销单 update 未被移除')

const resources = listAggregateDraftResourceKeys()
assert(JSON.stringify(resources) === JSON.stringify(expected), 'registry 与 manifest 聚合资源不一致')

for (const resource of resources) {
  const draft = aggregateDraftFor(resource) as AggregateDraftAdapter<
    Record<string, unknown>,
    unknown
  >
  const saved = await draft.createDraft({ marker: resource, items: [] })
  assert(
    typeof saved === 'object' && saved !== null && (saved as { id?: unknown }).id === 'saved-1',
    `${resource} 聚合保存未返回权威快照`,
  )
}

const createCalls = [...calls]
assert(createCalls.length === resources.length, '聚合保存不是每单一次 mutation')
for (const [index, resource] of resources.entries()) {
  assert(
    JSON.stringify(createCalls[index]) === JSON.stringify({
      kind: 'mutation',
      args: { resource, input: { marker: resource, items: [] } },
    }),
    `${resource} 聚合保存 mutation 参数错误`,
  )
}

calls.length = 0
for (const resource of resources) {
  await resourceBindingFor(resource).writer!.delete!(`${resource}-1`)
}
assert(calls.length === resources.length, '聚合删除不是每单一次 mutation')
for (const [index, resource] of resources.entries()) {
  assert(
    JSON.stringify(calls[index]) === JSON.stringify({
      kind: 'mutation',
      args: { resource, id: `${resource}-1` },
    }),
    `${resource} removeDraft mutation 参数错误`,
  )
}

console.log(JSON.stringify({
  resources,
  createMutations: createCalls.length,
  deleteMutations: calls.length,
}))
