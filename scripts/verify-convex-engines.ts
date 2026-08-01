import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'

type Fixture = {
  actorUserId: string
  companyId: string
  otherCompanyId: string
  warehouseId: string
  secondWarehouseId: string
  allowNegativeWarehouseId: string
  materialId: string
  secondMaterialId: string
  debitAccountId: string
  creditAccountId: string
  partyAccountId: string
}
type InventoryInspection = {
  generation: number; current: bigint; factSum: bigint; mismatch: boolean; asOf: bigint; scannedBuckets: number
}
type PostingInspection = { heads: number; stock: number; gl: number; audits: number; secretLeak: boolean }
type GlInspection = { liveFacts: number; allFacts: number; debit: bigint; credit: bigint }

const prepareRef = makeFunctionReference<'mutation', { spikeSecret: string; marker: string }, Fixture>('test/engineProbe:prepare')
const numberRef = makeFunctionReference<'mutation', { spikeSecret: string; companyId: string; marker: string; failAfterNumber: boolean }, string>('test/engineProbe:takeNumber')
const inventoryPostRef = makeFunctionReference<'mutation', {
  spikeSecret: string; voucherId: string; companyId: string; warehouseId: string; materialId: string
  quantity: string; direction: 'in' | 'out'; postingDate?: string
}, number>('test/engineProbe:inventoryPost')
const inventoryCancelRef = makeFunctionReference<'mutation', { spikeSecret: string; voucherId: string }, number>('test/engineProbe:inventoryCancel')
const inspectInventoryRef = makeFunctionReference<'query', {
  spikeSecret: string; companyId: string; warehouseId: string; materialId: string; asOf?: string
}, InventoryInspection>('test/engineProbe:inspectInventory')
const corruptInventoryRef = makeFunctionReference<'mutation', {
  spikeSecret: string; companyId: string; warehouseId: string; materialId: string
}, null>('test/engineProbe:corruptInventory')
const rebuildInventoryRef = makeFunctionReference<'mutation', { spikeSecret: string }, number>('test/engineProbe:rebuildInventoryForSmoke')
const seedHistoryRef = makeFunctionReference<'mutation', {
  spikeSecret: string; companyId: string; warehouseId: string; materialId: string; dates: string[]; marker: string
}, number>('test/engineProbe:seedHistoryChunk')
const glPostRef = makeFunctionReference<'mutation', {
  spikeSecret: string; voucherId: string; companyId: string; debitAccountId: string; creditAccountId: string
  amount: string; partyType?: string; partyId?: string
}, number>('test/engineProbe:glPost')
const glReverseRef = makeFunctionReference<'mutation', { spikeSecret: string; voucherId: string }, number>('test/engineProbe:glReverse')
const glCancelRef = makeFunctionReference<'mutation', { spikeSecret: string; voucherId: string }, number>('test/engineProbe:glCancel')
const inspectGlRef = makeFunctionReference<'query', {
  spikeSecret: string; voucherId: string; companyId: string; accountId: string
}, GlInspection>('test/engineProbe:inspectGl')
const postWithFaultRef = makeFunctionReference<'mutation', {
  spikeSecret: string; marker: string; actorUserId: string; companyId: string; warehouseId: string
  materialId: string; debitAccountId: string; creditAccountId: string
  faultAfter?: 'after_validate' | 'after_controlled_projection' | 'after_inventory' | 'after_gl' | 'after_head' | 'after_audit'
}, string>('test/engineProbe:postWithFault')
const inspectPostingRef = makeFunctionReference<'query', { spikeSecret: string; marker: string }, PostingInspection>('test/engineProbe:inspectPosting')

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`缺少环境变量 ${name}`)
  return value
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function rejected(run: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await run()
  } catch {
    return
  }
  throw new Error(`${label} 未被拒绝`)
}

function p95(values: number[]): number {
  return [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * 0.95) - 1)] ?? 0
}

function allDates(from: string, to: string): string[] {
  const dates: string[] = []
  const cursor = new Date(`${from}T00:00:00.000Z`)
  const end = new Date(`${to}T00:00:00.000Z`)
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return dates
}

const convexUrl = requiredEnv('CONVEX_SELF_HOSTED_URL')
const spikeSecret = requiredEnv('SYNIE_ENGINE_SPIKE_SECRET')
const client = new ConvexHttpClient(convexUrl, { skipConvexDeploymentUrlCheck: true, logger: false })
const marker = crypto.randomUUID().replaceAll('-', '').slice(0, 10)
const fixture = await client.mutation(prepareRef, { spikeSecret, marker })

const numberLatencies: number[] = []
const numbers = await Promise.all(Array.from({ length: 100 }, async (_, index) => {
  const started = performance.now()
  const value = await client.mutation(numberRef, {
    spikeSecret, companyId: fixture.companyId, marker: `number-${index}`, failAfterNumber: false,
  })
  numberLatencies.push(performance.now() - started)
  return value
}))
invariant(new Set(numbers).size === 100, '100 并发取号出现重复')
await rejected(() => client.mutation(numberRef, {
  spikeSecret, companyId: fixture.companyId, marker: 'number-fault', failAfterNumber: true,
}), '取号后业务校验')
const afterRollback = await client.mutation(numberRef, {
  spikeSecret, companyId: fixture.companyId, marker: 'number-after-rollback', failAfterNumber: false,
})
invariant(afterRollback.endsWith('0101'), `失败 mutation 消耗编号：${afterRollback}`)

await client.mutation(inventoryPostRef, {
  spikeSecret, voucherId: 'stock-in-10', companyId: fixture.companyId, warehouseId: fixture.warehouseId,
  materialId: fixture.materialId, quantity: '10', direction: 'in',
})
const stockLatencies: number[] = []
const race = await Promise.allSettled(Array.from({ length: 50 }, async (_, index) => {
  const started = performance.now()
  try {
    return await client.mutation(inventoryPostRef, {
      spikeSecret, voucherId: `stock-out-${index}`, companyId: fixture.companyId, warehouseId: fixture.warehouseId,
      materialId: fixture.materialId, quantity: '1', direction: 'out',
    })
  } finally {
    stockLatencies.push(performance.now() - started)
  }
}))
invariant(race.filter((result) => result.status === 'fulfilled').length === 10, '50 同 key 并发出库未严格受余额约束')
let inventory = await client.query(inspectInventoryRef, {
  spikeSecret, companyId: fixture.companyId, warehouseId: fixture.warehouseId, materialId: fixture.materialId,
})
invariant(inventory.current === 0n && !inventory.mismatch, '并发出库后 facts/current 不一致')

const distinct = await Promise.all([
  client.mutation(inventoryPostRef, {
    spikeSecret, voucherId: 'distinct-a', companyId: fixture.companyId, warehouseId: fixture.secondWarehouseId,
    materialId: fixture.materialId, quantity: '1', direction: 'in',
  }),
  client.mutation(inventoryPostRef, {
    spikeSecret, voucherId: 'distinct-b', companyId: fixture.companyId, warehouseId: fixture.warehouseId,
    materialId: fixture.secondMaterialId, quantity: '1', direction: 'in',
  }),
])
invariant(distinct.length === 2, '不同库存 key 未能并发提交')

await client.mutation(inventoryPostRef, {
  spikeSecret, voucherId: 'cancel-source', companyId: fixture.companyId, warehouseId: fixture.warehouseId,
  materialId: fixture.materialId, quantity: '5', direction: 'in',
})
await client.mutation(inventoryPostRef, {
  spikeSecret, voucherId: 'cancel-consumer', companyId: fixture.companyId, warehouseId: fixture.warehouseId,
  materialId: fixture.materialId, quantity: '5', direction: 'out',
})
await rejected(() => client.mutation(inventoryCancelRef, { spikeSecret, voucherId: 'cancel-source' }), '作废致负库存')
invariant(await client.mutation(inventoryCancelRef, { spikeSecret, voucherId: 'cancel-consumer' }) === 1, '库存作废未处理事实')
invariant(await client.mutation(inventoryCancelRef, { spikeSecret, voucherId: 'cancel-consumer' }) === 0, '库存重复作废非幂等')
await client.mutation(inventoryPostRef, {
  spikeSecret, voucherId: 'allow-negative', companyId: fixture.companyId, warehouseId: fixture.allowNegativeWarehouseId,
  materialId: fixture.materialId, quantity: '1.0000004', direction: 'out',
})

inventory = await client.query(inspectInventoryRef, {
  spikeSecret, companyId: fixture.companyId, warehouseId: fixture.warehouseId, materialId: fixture.materialId,
})
invariant(!inventory.mismatch, '破坏前库存 projection 已不一致')
await client.mutation(corruptInventoryRef, {
  spikeSecret, companyId: fixture.companyId, warehouseId: fixture.warehouseId, materialId: fixture.materialId,
})
invariant((await client.query(inspectInventoryRef, {
  spikeSecret, companyId: fixture.companyId, warehouseId: fixture.warehouseId, materialId: fixture.materialId,
})).mismatch, 'projection 破坏未被 verify 精确检出')
const rebuiltGeneration = await client.mutation(rebuildInventoryRef, { spikeSecret })
inventory = await client.query(inspectInventoryRef, {
  spikeSecret, companyId: fixture.companyId, warehouseId: fixture.warehouseId, materialId: fixture.materialId,
})
invariant(inventory.generation === rebuiltGeneration && !inventory.mismatch, '新 generation 重建/切换后仍不一致')

const history = allDates('2016-01-01', '2025-12-31')
for (let offset = 0; offset < history.length; offset += 60) {
  const dates = history.slice(offset, offset + 60)
  await client.mutation(seedHistoryRef, {
    spikeSecret, companyId: fixture.companyId, warehouseId: fixture.secondWarehouseId,
    materialId: fixture.secondMaterialId, dates, marker: `history-${offset}`,
  })
}
const historyInspection = await client.query(inspectInventoryRef, {
  spikeSecret, companyId: fixture.companyId, warehouseId: fixture.secondWarehouseId,
  materialId: fixture.secondMaterialId, asOf: '2025-12-31',
})
invariant(historyInspection.asOf === BigInt(history.length), '10 年每日 movement as-of 结果错误')
invariant(historyInspection.scannedBuckets <= 151, `as-of 扫描桶数失控：${historyInspection.scannedBuckets}`)

await client.mutation(glPostRef, {
  spikeSecret, voucherId: 'gl-main', companyId: fixture.companyId,
  debitAccountId: fixture.debitAccountId, creditAccountId: fixture.creditAccountId, amount: '10.00',
})
let gl = await client.query(inspectGlRef, {
  spikeSecret, voucherId: 'gl-main', companyId: fixture.companyId, accountId: fixture.debitAccountId,
})
invariant(gl.liveFacts === 2 && gl.debit === 1_000n, 'GL post facts/projection 错误')
invariant(await client.mutation(glReverseRef, { spikeSecret, voucherId: 'gl-main' }) === 2, 'GL reverse 数量错误')
await rejected(() => client.mutation(glReverseRef, { spikeSecret, voucherId: 'gl-main' }), 'GL 重复 reverse')
gl = await client.query(inspectGlRef, {
  spikeSecret, voucherId: 'gl-main', companyId: fixture.companyId, accountId: fixture.debitAccountId,
})
invariant(gl.allFacts === 4 && gl.debit === 0n, 'GL reverse 后 projection 未归零')
invariant(await client.mutation(glCancelRef, { spikeSecret, voucherId: 'gl-main' }) === 4, 'GL cancel 数量错误')
invariant(await client.mutation(glCancelRef, { spikeSecret, voucherId: 'gl-main' }) === 0, 'GL cancel 非幂等')
await client.mutation(glCancelRef, { spikeSecret, voucherId: 'gl-empty' })
await rejected(() => client.mutation(glReverseRef, { spikeSecret, voucherId: 'gl-empty' }), '空 GL reverse')
await rejected(() => client.mutation(glPostRef, {
  spikeSecret, voucherId: 'party-missing', companyId: fixture.companyId,
  debitAccountId: fixture.partyAccountId, creditAccountId: fixture.creditAccountId, amount: '1',
}), '往来科目缺对手')
await client.mutation(glPostRef, {
  spikeSecret, voucherId: 'party-valid', companyId: fixture.companyId,
  debitAccountId: fixture.partyAccountId, creditAccountId: fixture.creditAccountId, amount: '1',
  partyType: 'customer', partyId: 'customer-1',
})

const stages = ['after_validate', 'after_controlled_projection', 'after_inventory', 'after_gl', 'after_head', 'after_audit'] as const
for (const stage of stages) {
  const faultMarker = `posting-${stage}`
  await rejected(() => client.mutation(postWithFaultRef, {
    spikeSecret, marker: faultMarker, actorUserId: fixture.actorUserId, companyId: fixture.companyId,
    warehouseId: fixture.warehouseId, materialId: fixture.materialId,
    debitAccountId: fixture.debitAccountId, creditAccountId: fixture.creditAccountId, faultAfter: stage,
  }), `posting ${stage}`)
  const state = await client.query(inspectPostingRef, { spikeSecret, marker: faultMarker })
  invariant(Object.values(state).every((value) => value === 0 || value === false), `${stage} 留下半状态`)
}
const successMarker = 'posting-success'
await client.mutation(postWithFaultRef, {
  spikeSecret, marker: successMarker, actorUserId: fixture.actorUserId, companyId: fixture.companyId,
  warehouseId: fixture.warehouseId, materialId: fixture.materialId,
  debitAccountId: fixture.debitAccountId, creditAccountId: fixture.creditAccountId,
})
const posting = await client.query(inspectPostingRef, { spikeSecret, marker: successMarker })
invariant(posting.heads === 1 && posting.stock === 1 && posting.gl === 2 && posting.audits === 1, '成功 posting 闭包不完整')
invariant(!posting.secretLeak, '正式 audit 泄漏敏感值')

const metrics = {
  numberingP95Ms: Math.round(p95(numberLatencies)),
  hotStockP95Ms: Math.round(p95(stockLatencies)),
  numberingCommitted: numbers.length + 1,
  stockRaceCommitted: race.filter((result) => result.status === 'fulfilled').length,
  stockRaceRejected: race.filter((result) => result.status === 'rejected').length,
  historyDays: history.length,
  historyScannedBuckets: historyInspection.scannedBuckets,
}
invariant(metrics.numberingP95Ms < 8_000 && metrics.hotStockP95Ms < 8_000, `事实引擎 P95 超过 8s 门槛：${JSON.stringify(metrics)}`)
console.log(`Convex engine smoke 通过：${JSON.stringify(metrics)}`)
