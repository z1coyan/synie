import { afterAll, describe, expect, test } from 'bun:test'
import { createDb } from '~/db/index.ts'
import { createNumberingService } from '~/platform/numbering/index.ts'
import type { Actor } from '~/platform/authz/actor.ts'

const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（numbering）', () => {
  const db = createDb(url!)
  const numbering = createNumberingService(db)
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
    const catalog = await numbering.numberableResources()
    const fieldCount = catalog.reduce((n, r) => n + r.fields.length, 0)
    expect(catalog.length).toBe(25)
    expect(fieldCount).toBe(695)

    const current = await numbering.listRules({ limit: 200, offset: 0 })
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
    const counters = await numbering.listCounters({
      limit: 200,
      offset: 0,
      filter: { ruleId: { kind: 'fk', values: [created.id], labels: [] } },
    })
    expect(counters.count).toBe(1)
    const counterId = counters.results[0]!.id
    const counter = await numbering.updateCounter(actor, counterId, 41)
    expect(counter.value).toBe(41)

    await numbering.deleteRule(actor, created.id)
    await expect(numbering.getCounter(counterId)).rejects.toMatchObject({ code: 'not_found' })
  })
})
