import { afterAll, describe, expect, test } from 'bun:test'
import { createDb } from '~/db/index.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import { buildNumberingCatalog, createNumberingService } from '~/platform/numbering/index.ts'
import type { Actor } from '~/platform/authz/actor.ts'

const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（numbering）', () => {
  const db = createDb(url!)
  const numbering = createNumberingService(db, buildNumberingCatalog(createSealedResourceRegistry()))
  const actor: Actor = {
    userId: crypto.randomUUID(),
    username: 'numbering-test',
    name: null,
    superAdmin: true,
    allCompanies: true,
    permissions: new Set(),
    companyIds: [],
  }

  afterAll(async () => {
    await db.destroy()
  })

  test('目录规模 + 规则 CRUD + 计数器校正 + 级联删除', async () => {
    const catalog = await numbering.numberableResources(actor)
    const fieldCount = catalog.reduce((n, r) => n + r.fields.length, 0)
    // 目录自 Registry 派生；旧 numberables.json 的 25 资源 / 695 字段是下限
    // （超集约束见 src/platform/numbering/catalog.test.ts 特征化测试）
    expect(catalog.length).toBeGreaterThanOrEqual(25)
    expect(fieldCount).toBeGreaterThanOrEqual(695)

    const current = await numbering.listRules(actor, { limit: 200, offset: 0 })
    const occupied = new Set(current.results.filter((r) => r.enabled).map((r) => r.resource))
    let resource = catalog.find((item) => !occupied.has(item.prefix))?.prefix
    // setup 基础种子会占满全部资源；无空位时先关掉一条启用规则腾出资源
    if (!resource) {
      const blocker = current.results.find((r) => r.enabled)
      expect(blocker).toBeTruthy()
      await numbering.updateRule(actor, blocker!.id, { enabled: false })
      resource = blocker!.resource
    }
    expect(resource).toBeTruthy()

    const suffix = crypto.randomUUID().slice(0, 8)
    const created = await numbering.create(actor, {
      resource: resource!,
      name: `单测-${suffix}`,
      segments: [
        { type: 'text', value: 'T-' },
        { type: 'seq', padding: 3 },
      ],
      perCompany: false,
    })
    expect(created.segments.length).toBe(2)

    const updated = await numbering.updateRule(actor, created.id, {
      name: `单测已更新-${suffix}`,
      enabled: false,
    })
    expect(updated.enabled).toBe(false)

    await db
      .insertInto('sys_numbering_counter')
      .values({ rule_id: created.id, scope_key: `T|${suffix}`, value: 7 })
      .execute()
    const counters = await numbering.listCounters(actor, {
      limit: 200,
      offset: 0,
      filter: { ruleId: { kind: 'fk', values: [created.id], labels: [] } },
    })
    expect(counters.count).toBe(1)
    const counterId = counters.results[0]!.id
    const counter = await numbering.updateCounter(actor, counterId, 41)
    expect(counter.value).toBe(41)

    await numbering.deleteRule(actor, created.id)
    await expect(numbering.getCounter(actor, counterId)).rejects.toMatchObject({ code: 'not_found' })
  })

  test('同一资源第二条启用规则 → conflict（非 500）', async () => {
    const catalog = await numbering.numberableResources(actor)
    const current = await numbering.listRules(actor, { limit: 200, offset: 0 })
    const occupied = new Set(current.results.filter((r) => r.enabled).map((r) => r.resource))
    let resource = catalog.find((item) => !occupied.has(item.prefix))?.prefix
    if (!resource) {
      const blocker = current.results.find((r) => r.enabled)
      expect(blocker).toBeTruthy()
      await numbering.updateRule(actor, blocker!.id, { enabled: false })
      resource = blocker!.resource
    }
    const suffix = crypto.randomUUID().slice(0, 8)
    const first = await numbering.create(actor, {
      resource: resource!,
      name: `冲突甲-${suffix}`,
      segments: [
        { type: 'text', value: 'A-' },
        { type: 'seq', padding: 2 },
      ],
      perCompany: false,
      enabled: true,
    })
    try {
      await expect(
        numbering.create(actor, {
          resource: resource!,
          name: `冲突乙-${suffix}`,
          segments: [
            { type: 'text', value: 'B-' },
            { type: 'seq', padding: 2 },
          ],
          perCompany: false,
          enabled: true,
        }),
      ).rejects.toMatchObject({
        code: 'conflict',
        message: '该资源已有启用的编号规则,同一资源只能启用一条',
      })
    } finally {
      await numbering.deleteRule(actor, first.id)
    }
  })
})
