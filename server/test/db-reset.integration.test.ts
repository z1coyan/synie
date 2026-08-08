/**
 * db:reset 回归测试：truncate 后重放幂等种子，须恢复「仅 migrate 完成」的库状态——
 * 尤其是仓库/部门编号规则（00024）。缺失时 setup 向导首张公司创建会在同事务
 * 种子三仓取号处失败（「创建默认仓库失败」）。
 *
 * 全程在事务内跑并整体回滚，不污染共享 synie_test。
 */
import { describe, expect, test } from 'bun:test'
import { createDb } from '~/db/index.ts'
import { seedCompanyDefaultWarehouses } from '~/modules/base/warehouse-seed.ts'
import { buildNumberingCatalog } from '~/platform/numbering/catalog.ts'
import { createNumberingService } from '~/platform/numbering/service.ts'
import { testActor } from '~/platform/authz/testing.ts'
import { reseedIdempotentSeeds } from '../db/reset.ts'
import { createPlatformRegistry, testDatabaseUrl } from './helpers.ts'

const url = testDatabaseUrl()
const run = url ? describe : describe.skip

run('PG 集成（db:reset 种子重放）', () => {
  test('truncate 后重放种子：编号规则恢复，公司种子三仓可取号', async () => {
    const db = createDb(url!)
    try {
      await db.transaction().execute(async (trx) => {
        // 模拟 db:reset 的 truncate 后状态
        await trx.deleteFrom('sys_numbering_counter').execute()
        await trx.deleteFrom('sys_numbering_rule').execute()

        await reseedIdempotentSeeds(trx)

        const rules = await trx
          .selectFrom('sys_numbering_rule')
          .select('resource')
          .where('enabled', '=', true)
          .execute()
        const resources = rules.map((r) => r.resource).sort()
        expect(resources).toContain('base.warehouse')
        expect(resources).toContain('sys.department')

        // 端到端验证原始故障路径：建公司同事务种子三仓
        const registry = createPlatformRegistry()
        const numbering = createNumberingService(db, buildNumberingCatalog(registry), registry)
        // synie_test 可能被其它集成包清过基础数据；事务内补齐、整体回滚
        await trx
          .insertInto('bas_currency')
          .values({ name: '人民币', iso_code: 'CNY', symbol: '￥' })
          .onConflict((oc) => oc.doNothing())
          .execute()
        const currency = await trx
          .selectFrom('bas_currency')
          .select('id')
          .where('iso_code', '=', 'CNY')
          .executeTakeFirstOrThrow()
        const company = await trx
          .insertInto('bas_company')
          .values({
            code: 'ZZ',
            name: 'reset 回归公司',
            short_name: '回归',
            base_currency_id: currency.id,
          })
          .returningAll()
          .executeTakeFirstOrThrow()
        const seeded = await seedCompanyDefaultWarehouses(
          trx,
          numbering,
          testActor({ allCompanies: true }),
          company.id,
          company.code,
        )
        expect(seeded).toBe(3)

        throw new Error('__rollback__')
      })
    } catch (err) {
      if (!(err instanceof Error && err.message === '__rollback__')) throw err
    } finally {
      await db.destroy()
    }
  })
})
