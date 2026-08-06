/**
 * 标准动作合同测试：对每个标准派生资源跑同一组断言。
 *
 * 合同（写一次，所有接入资源免费继承）：
 * - create 落库并写 create 审计
 * - update 有差异才落库+审计；无差异直接返回现值（updated_at 不动、无审计）
 * - delete 写 destroy 审计；之后 get 即 not_found
 * - 批量动作单事务全成全败（一行失败全量回滚）
 * - 授权决策 fail-closed：无授权 actor 在决策层即 deny（与路由 guard 同一路径）
 * - update schema 不含 createOnly 字段
 *
 * 新资源迁入标准派生后在 CASES 里加一行描述符即可。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import { createCurrencyService } from '~/modules/base/currency-service.ts'
import { createUnitService } from '~/modules/base/unit-service.ts'
import { createBankAccountService } from '~/modules/finance/banking-accounts.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { createAuthzEnforcer } from '~/platform/authz/enforce.ts'
import { testActor } from '~/platform/authz/testing.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import type { StandardService } from './service.ts'
import { deriveWireSchemas } from './wire.ts'

const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10)

/** 从随机串派生 n 位大写字母（ISO 编码等格式约束字段用） */
function letters(n: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const seed = crypto.randomUUID().replace(/-/g, '')
  let out = ''
  for (let i = 0; i < n; i++) out += alphabet[seed.charCodeAt(i) % 26]!
  return out
}

interface ContractCase {
  title: string
  resource: string
  make: (db: ReturnType<typeof createDb>, registry: ReturnType<typeof createSealedResourceRegistry>) => StandardService
  /** 每次调用生成一份可创建载荷（相互不撞唯一约束） */
  valid: () => Record<string, unknown>
  /** 对任意现值都构成差异的补丁 */
  patch: () => Record<string, unknown>
}

const CASES: ContractCase[] = [
  {
    title: '计量单位',
    resource: 'basUnits',
    make: (db, registry) => createUnitService(db, registry),
    valid: () => ({
      unitType: 'WEIGHT',
      name: `合同-${crypto.randomUUID().slice(0, 8)}`,
      symbol: `ct${crypto.randomUUID().slice(0, 8)}`,
      ratio: '2',
    }),
    patch: () => ({ name: `合同改-${crypto.randomUUID().slice(0, 8)}` }),
  },
  {
    title: '币种',
    resource: 'basCurrencies',
    make: (db, registry) => createCurrencyService(db, registry),
    valid: () => ({ name: `合同币-${crypto.randomUUID().slice(0, 8)}`, isoCode: letters(3) }),
    patch: () => ({ name: `合同币改-${crypto.randomUUID().slice(0, 8)}` }),
  },
]

run('标准动作合同（postgres）', () => {
  const db = createDb(url!)
  const registry = createSealedResourceRegistry()
  const authz = createAuthzEnforcer(registry)
  /** table → 已创建 id（清理用） */
  const created: Array<{ table: string; id: string }> = []

  function permitOf(actor: Actor, resource: string, action: string): Permit {
    const decision = authz.decideFor(actor, resource, action)
    if (decision.outcome !== 'permit') throw new Error(`夹具应当 permit：${resource}:${action}`)
    return decision.permit
  }

  const admin = testActor({ username: `std-contract-${suffix}`, superAdmin: true, allCompanies: true })

  async function auditCount(table: string, recordId: string, actionType: string): Promise<number> {
    const rows = await db
      .selectFrom('sys_audit_log')
      .select('id')
      .where('resource', '=', table)
      .where('record_id', '=', recordId)
      .where('action_type', '=', actionType)
      .execute()
    return rows.length
  }

  afterAll(async () => {
    for (const entry of created.reverse()) {
      await db.deleteFrom('sys_audit_log').where('resource', '=', entry.table).where('record_id', '=', entry.id).execute()
      await db
        .deleteFrom(entry.table as 'bas_unit')
        .where('id', '=', entry.id)
        .execute()
    }
    await db.destroy()
  })

  describe('公司域路径（银行账户）：边界 fail-closed + 审计 company_id + 引用钩子', () => {
    const bankAccounts = createBankAccountService(db, registry)
    let companyA = ''
    let companyB = ''
    let currencyId = ''

    /** 公司夹具裸插入：本合同只验公司边界语义，不经公司服务（避免联动种子） */
    async function insertCompany(name: string): Promise<string> {
      const result = await sql<{ id: string }>`
        INSERT INTO bas_company(code, name, short_name, base_currency_id)
        VALUES (${letters(2) + suffix.slice(0, 4).toUpperCase()}, ${name}, ${name}, ${currencyId}::uuid)
        RETURNING id
      `.execute(db)
      return result.rows[0]!.id
    }

    beforeAll(async () => {
      const cur = await sql<{ id: string }>`
        INSERT INTO bas_currency(name, iso_code) VALUES (${`合同夹具币-${suffix}`}, ${letters(3)})
        RETURNING id
      `.execute(db)
      currencyId = cur.rows[0]!.id
      companyA = await insertCompany(`合同公司A-${suffix}`)
      companyB = await insertCompany(`合同公司B-${suffix}`)
    })

    afterAll(async () => {
      await db.deleteFrom('acc_bank_account').where('company_id', 'in', [companyA, companyB]).execute()
      await db.deleteFrom('bas_company').where('id', 'in', [companyA, companyB]).execute()
      await db.deleteFrom('bas_currency').where('id', '=', currencyId).execute()
    })

    const scoped = () =>
      testActor({
        username: `std-scoped-${suffix}`,
        companyIds: [companyA],
        permissions: [
          'acc.bank_account:read',
          'acc.bank_account:create',
          'acc.bank_account:update',
          'acc.bank_account:delete',
        ],
      })

    function payload(companyId: string): Record<string, unknown> {
      return {
        alias: `合同户-${crypto.randomUUID().slice(0, 8)}`,
        bankName: '合同银行',
        holderName: '合同持有人',
        accountNo: `62${crypto.randomUUID().replace(/\D/g, '').slice(0, 10)}`,
        companyId,
        currencyId,
      }
    }

    test('本公司可建；审计带 company_id；列表只见本公司', async () => {
      const actor = scoped()
      const item = await bankAccounts.create(permitOf(actor, 'accBankAccounts', 'create'), payload(companyA))
      created.push({ table: 'acc_bank_account', id: item.id })
      expect(item.companyId).toBe(companyA)

      const audit = await db
        .selectFrom('sys_audit_log')
        .select(['company_id'])
        .where('resource', '=', 'acc_bank_account')
        .where('record_id', '=', item.id)
        .where('action_type', '=', 'create')
        .executeTakeFirst()
      expect(audit?.company_id).toBe(companyA)

      const listed = await bankAccounts.list(permitOf(actor, 'accBankAccounts', 'read'), { limit: 200, offset: 0 })
      expect(listed.results.every((r) => r.companyId === companyA)).toBe(true)
    })

    test('越公司边界创建 → not_found（不泄露存在性）', async () => {
      const actor = scoped()
      await expect(
        bankAccounts.create(permitOf(actor, 'accBankAccounts', 'create'), payload(companyB)),
      ).rejects.toMatchObject({ code: 'not_found' })
    })

    test('引用钩子：货币不存在 → validation', async () => {
      const actor = scoped()
      await expect(
        bankAccounts.create(permitOf(actor, 'accBankAccounts', 'create'), {
          ...payload(companyA),
          currencyId: crypto.randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'validation' })
    })
  })

  for (const c of CASES) {
    describe(c.title, () => {
      const service = c.make(db, registry)
      const table = service.meta.table
      const track = (id: string) => created.push({ table, id })

      test('update schema 不含 createOnly 字段；create/update 均拒绝未知键', () => {
        const schemas = deriveWireSchemas(service.meta, service.stampedColumns)
        const createOnly = service.meta.fields.filter((f) => f.createOnly).map((f) => f.apiName)
        for (const apiName of createOnly) {
          expect(schemas.update.safeParse({ [apiName]: 'X' }).success).toBe(false)
        }
        expect(schemas.create.safeParse({ __bogus: 1 }).success).toBe(false)
        expect(schemas.update.safeParse({ __bogus: 1 }).success).toBe(false)
      })

      test('无授权 actor 决策层即 deny（fail-closed）', () => {
        const nobody = testActor({ username: `std-nobody-${suffix}` })
        for (const action of ['read', 'create', 'update', 'delete']) {
          expect(authz.decideFor(nobody, c.resource, action).outcome).not.toBe('permit')
        }
      })

      test('create 落库+审计；get/list 可见', async () => {
        const item = await service.create(permitOf(admin, c.resource, 'create'), c.valid())
        track(item.id)
        expect(item.id).toBeTruthy()
        expect(await auditCount(table, item.id, 'create')).toBe(1)

        const got = await service.get(permitOf(admin, c.resource, 'read'), item.id)
        expect(got.id).toBe(item.id)
        const listed = await service.list(permitOf(admin, c.resource, 'read'), { limit: 200, offset: 0 })
        expect(listed.results.some((r) => r.id === item.id)).toBe(true)
      })

      test('update 有差异才审计；无差异不落库', async () => {
        const item = await service.create(permitOf(admin, c.resource, 'create'), c.valid())
        track(item.id)
        const patch = c.patch()
        const updated = await service.update(permitOf(admin, c.resource, 'update'), item.id, patch)
        expect(await auditCount(table, item.id, 'update')).toBe(1)

        // 同一补丁再来一次：无差异，返回现值，不写审计不碰 updated_at
        const noop = await service.update(permitOf(admin, c.resource, 'update'), item.id, patch)
        expect(await auditCount(table, item.id, 'update')).toBe(1)
        expect((noop.updatedAt as Date).getTime()).toBe((updated.updatedAt as Date).getTime())
      })

      test('delete 落 destroy 审计；之后 not_found', async () => {
        const item = await service.create(permitOf(admin, c.resource, 'create'), c.valid())
        track(item.id)
        await service.remove(permitOf(admin, c.resource, 'delete'), item.id)
        expect(await auditCount(table, item.id, 'destroy')).toBe(1)
        await expect(service.get(permitOf(admin, c.resource, 'read'), item.id)).rejects.toMatchObject({
          code: 'not_found',
        })
      })

      test('批量单事务全成全败', async () => {
        const a = await service.create(permitOf(admin, c.resource, 'create'), c.valid())
        const b = await service.create(permitOf(admin, c.resource, 'create'), c.valid())
        track(a.id)
        track(b.id)

        // 一行不存在 → 全量回滚，a 仍在
        const ghost = crypto.randomUUID()
        await expect(
          service.bulkRemove(permitOf(admin, c.resource, 'delete'), [a.id, ghost]),
        ).rejects.toMatchObject({ code: 'not_found' })
        const still = await service.get(permitOf(admin, c.resource, 'read'), a.id)
        expect(still.id).toBe(a.id)

        // 批量更新逐行审计
        const items = await service.bulkUpdate(permitOf(admin, c.resource, 'update'), [a.id, b.id], c.patch())
        expect(items).toHaveLength(2)
        expect(await auditCount(table, a.id, 'update')).toBe(1)
        expect(await auditCount(table, b.id, 'update')).toBe(1)

        // 全部存在 → 批量删除成功
        const count = await service.bulkRemove(permitOf(admin, c.resource, 'delete'), [a.id, b.id])
        expect(count).toBe(2)
        expect(await auditCount(table, a.id, 'destroy')).toBe(1)
      })
    })
  }
})
