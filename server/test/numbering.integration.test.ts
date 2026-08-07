import { testActor } from '~/platform/authz/testing.ts'
import { afterAll, describe, expect, test } from 'bun:test'
import { createDb } from '~/db/index.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import { buildNumberingCatalog, createNumberingService } from '~/platform/numbering/index.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { createAuthzEnforcer } from '~/platform/authz/enforce.ts'
import { RULE_RESOURCE_NAME } from '~/platform/numbering/meta.ts'


/** 编号服务需要 sealed registry（授权归宿解析） */
const numberingRegistry = createSealedResourceRegistry()
const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（numbering）', () => {
  const db = createDb(url!)
  const numbering = createNumberingService(db, buildNumberingCatalog(numberingRegistry), numberingRegistry)
  const actor: Actor = testActor({
    userId: crypto.randomUUID(),
    username: 'numbering-test',
    name: null,
    superAdmin: true,
    allCompanies: true,
    permissions: new Set(),
    companyIds: [],
  })
  const authz = createAuthzEnforcer(numberingRegistry)
  /** superAdmin 凭证：编号规则与计数器都是 global，rowFilter 恒全集 */
  const permit = (action: string): Permit => {
    const decision = authz.decideFor(actor, RULE_RESOURCE_NAME, action)
    if (decision.outcome !== 'permit') throw new Error(`夹具应当 permit：${action}`)
    return decision.permit
  }

  afterAll(async () => {
    await db.destroy()
  })

  test('目录规模 + 规则 CRUD + 计数器校正 + 级联删除', async () => {
    const catalog = await numbering.numberableResources(permit('read'))
    const fieldCount = catalog.reduce((n, r) => n + r.fields.length, 0)
    // 目录自 Registry 派生；旧 numberables.json 的 25 资源 / 695 字段是下限
    // （超集约束见 src/platform/numbering/catalog.test.ts 特征化测试）
    expect(catalog.length).toBeGreaterThanOrEqual(25)
    expect(fieldCount).toBeGreaterThanOrEqual(695)

    const current = await numbering.listRules(permit('read'), { limit: 200, offset: 0 })
    const occupied = new Set(current.results.filter((r) => r.enabled).map((r) => r.resource))
    let resource = catalog.find((item) => !occupied.has(item.prefix))?.prefix
    // setup 基础种子会占满全部资源；无空位时先关掉一条启用规则腾出资源（测完恢复启用——
    // 共享库上被停用的可能是仓库/部门等迁移预置规则，不恢复会坑后续套件）
    let blockerId: string | undefined
    if (!resource) {
      const blocker = current.results.find((r) => r.enabled)
      expect(blocker).toBeTruthy()
      await numbering.updateRule(permit('update'), blocker!.id, { enabled: false })
      blockerId = blocker!.id
      resource = blocker!.resource
    }
    expect(resource).toBeTruthy()

    try {
      const suffix = crypto.randomUUID().slice(0, 8)
      const created = await numbering.create(permit('create'), {
        resource: resource!,
        name: `单测-${suffix}`,
        segments: [
          { type: 'text', value: 'T-' },
          { type: 'seq', padding: 3 },
        ],
        perCompany: false,
      })
      expect(created.segments.length).toBe(2)

      const updated = await numbering.updateRule(permit('update'), created.id, {
        name: `单测已更新-${suffix}`,
        enabled: false,
      })
      expect(updated.enabled).toBe(false)

      await db
        .insertInto('sys_numbering_counter')
        .values({ rule_id: created.id, scope_key: `T|${suffix}`, value: 7 })
        .execute()
      const counters = await numbering.listCounters(permit('read'), {
        limit: 200,
        offset: 0,
        filter: { ruleId: { kind: 'fk', values: [created.id], labels: [] } },
      })
      expect(counters.count).toBe(1)
      const counterId = counters.results[0]!.id
      const counter = await numbering.updateCounter(permit('update'), counterId, 41)
      expect(counter.value).toBe(41)

      await numbering.deleteRule(permit('delete'), created.id)
      await expect(numbering.getCounter(permit('read'), counterId)).rejects.toMatchObject({ code: 'not_found' })
    } finally {
      if (blockerId) await numbering.updateRule(permit('update'), blockerId, { enabled: true })
    }
  })

  test('同一资源第二条启用规则 → conflict（非 500）', async () => {
    const catalog = await numbering.numberableResources(permit('read'))
    const current = await numbering.listRules(permit('read'), { limit: 200, offset: 0 })
    const occupied = new Set(current.results.filter((r) => r.enabled).map((r) => r.resource))
    let resource = catalog.find((item) => !occupied.has(item.prefix))?.prefix
    let blockerId: string | undefined
    if (!resource) {
      const blocker = current.results.find((r) => r.enabled)
      expect(blocker).toBeTruthy()
      await numbering.updateRule(permit('update'), blocker!.id, { enabled: false })
      blockerId = blocker!.id
      resource = blocker!.resource
    }
    const suffix = crypto.randomUUID().slice(0, 8)
    const first = await numbering.create(permit('create'), {
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
        numbering.create(permit('create'), {
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
      await numbering.deleteRule(permit('delete'), first.id)
      if (blockerId) await numbering.updateRule(permit('update'), blockerId, { enabled: true })
    }
  })
})
