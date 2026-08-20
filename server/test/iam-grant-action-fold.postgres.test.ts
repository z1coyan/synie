/**
 * 生产存量授权收口迁移：把 leftover 旧动作补写成八动作行。
 * 门控 SYNIE_TEST_DATABASE_URL；SQL 由 migrate.ts 按文件执行，本测试再跑一遍以验幂等。
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { FOLDED_ACTIONS } from '~/platform/authz/action-compat.ts'
import { createDb } from '~/db/index.ts'
import { testDatabaseUrl } from './helpers.ts'

const MIGRATION_FILE = '00016_fold_legacy_role_permissions.sql'
const MIGRATION_URL = new URL(`../db/migrations/${MIGRATION_FILE}`, import.meta.url)

async function migrationSql(): Promise<string> {
  return Bun.file(MIGRATION_URL).text()
}

describe('存量授权收口迁移（SQL 约定）', () => {
  test('映射与 FOLDED_ACTIONS 对齐：reverse→create，不删行、不授 ar_ap:read', async () => {
    const text = await migrationSql()
    expect(text).toContain('WHERE scope IS NULL')
    expect(text).not.toMatch(/\bDELETE\s+FROM\b/i)
    expect(text).not.toMatch(/'acc\.ar_ap:read'/)
    for (const [from, to] of Object.entries(FOLDED_ACTIONS)) {
      expect(text).toContain(`('${from}', '${to}')`)
    }
    expect(text).toContain("('reverse', 'create')")
    expect(text).not.toContain("('reverse', 'void')")
  })
})

const url = testDatabaseUrl()
const run = url ? describe : describe.skip

run('存量授权收口迁移（PG）', () => {
  const db = createDb(url!)
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8)
  const roleIds: string[] = []

  afterAll(async () => {
    if (roleIds.length > 0) {
      await db.deleteFrom('sys_role_permission').where('role_id', 'in', roleIds).execute()
      await db.deleteFrom('sys_role').where('id', 'in', roleIds).execute()
    }
    await db.destroy()
  })

  test('leftover reverse→create；未映射行保留；空范围 all；不发明 ar_ap:read', async () => {
    const normal = await db
      .insertInto('sys_role')
      .values({ code: `fold-${suffix}`, name: `fold-${suffix}`, grants_all: false })
      .returning('id')
      .executeTakeFirstOrThrow()
    const adminLike = await db
      .insertInto('sys_role')
      .values({ code: `fold-all-${suffix}`, name: `fold-all-${suffix}`, grants_all: true })
      .returning('id')
      .executeTakeFirstOrThrow()
    roleIds.push(normal.id, adminLike.id)

    await db
      .insertInto('sys_role_permission')
      .values([
        { role_id: normal.id, permission: 'acc.vat_invoice:reverse', scope: 'all' },
        { role_id: normal.id, permission: 'sales.return:generate_replenishment', scope: 'all' },
        { role_id: normal.id, permission: 'mfg.work_order:generate_material_demand', scope: 'all' },
        { role_id: normal.id, permission: 'acc.ar_ap:export', scope: 'all' },
        { role_id: normal.id, permission: 'acc.ar_ap:print', scope: 'all' },
        { role_id: normal.id, permission: 'sales.order:read', scope: 'self' },
        { role_id: normal.id, permission: 'mystery.thing:leftover_unknown', scope: 'all' },
        { role_id: adminLike.id, permission: 'acc.vat_invoice:reverse', scope: 'all' },
      ])
      .execute()

    // 列已 NOT NULL DEFAULT all；事务内短暂放开以模拟「无范围」存量行，结束即回滚。
    await db.transaction().execute(async (trx) => {
      await sql`
        ALTER TABLE public.sys_role_permission ALTER COLUMN scope DROP NOT NULL
      `.execute(trx)
      await sql`
        INSERT INTO public.sys_role_permission (role_id, permission, scope)
        VALUES (${normal.id}::uuid, 'inv.stock_transfer:ship', NULL)
      `.execute(trx)

      const arApReadBefore = await trx
        .selectFrom('sys_role_permission')
        .select(trx.fn.countAll().as('n'))
        .where('permission', '=', 'acc.ar_ap:read')
        .executeTakeFirstOrThrow()

      const foldSql = await migrationSql()
      await sql.raw(foldSql).execute(trx)
      await sql.raw(foldSql).execute(trx)

      const rowsOf = async (roleId: string) => {
        const rows = await trx
          .selectFrom('sys_role_permission')
          .select(['permission', 'scope'])
          .where('role_id', '=', roleId)
          .orderBy('permission')
          .execute()
        return new Map(rows.map((row) => [row.permission, row.scope]))
      }

      const normalGrants = await rowsOf(normal.id)
      expect(normalGrants.get('acc.vat_invoice:reverse')).toBe('all')
      expect(normalGrants.get('acc.vat_invoice:create')).toBe('all')
      expect(normalGrants.has('acc.vat_invoice:void')).toBe(false)
      expect(normalGrants.get('sales.return:generate_replenishment')).toBe('all')
      expect(normalGrants.has('sales.return:create')).toBe(false)
      expect(normalGrants.get('mfg.work_order:generate_material_demand')).toBe('all')
      expect(normalGrants.has('mfg.work_order:create')).toBe(false)
      expect(normalGrants.get('mystery.thing:leftover_unknown')).toBe('all')
      expect(normalGrants.get('sales.order:read')).toBe('self')
      expect(normalGrants.get('inv.stock_transfer:ship')).toBe('all')
      expect(normalGrants.get('inv.stock_transfer:audit')).toBe('all')
      expect(normalGrants.get('acc.ar_ap:export')).toBe('all')
      expect(normalGrants.get('acc.ar_ap:print')).toBe('all')
      expect(normalGrants.has('acc.ar_ap:read')).toBe(false)

      const adminGrants = await rowsOf(adminLike.id)
      expect(adminGrants.get('acc.vat_invoice:reverse')).toBe('all')
      expect(adminGrants.has('acc.vat_invoice:create')).toBe(false)

      const arApReadAfter = await trx
        .selectFrom('sys_role_permission')
        .select(trx.fn.countAll().as('n'))
        .where('permission', '=', 'acc.ar_ap:read')
        .executeTakeFirstOrThrow()
      expect(Number(arApReadAfter.n)).toBe(Number(arApReadBefore.n))

      // 回滚 ALTER / 夹具写入，避免并行用例看到可空 scope 列
      throw new Rollback()
    }).catch((err) => {
      if (!(err instanceof Rollback)) throw err
    })
  })
})

class Rollback extends Error {
  constructor() {
    super('rollback fold-migration fixture')
  }
}
