/**
 * 部门 PG 集成（工单 05）：新授权体系（guard/Permit）的首个真实业务消费者。
 *
 * 覆盖：公司边界（读/写两侧）、物化路径维护（建/移动子树）、成环与跨公司父级拒绝、
 * 启停与「停用后不可再挂用户、存量挂接保留」、删除守卫（下级/在职用户）。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import { createAuthzEnforcer } from '~/platform/authz/enforce.ts'
import { testActor } from '~/platform/authz/testing.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import { buildNumberingCatalog, createNumberingService } from '~/platform/numbering/index.ts'
import { createDepartmentService } from './department-service.ts'
import { createIamService } from './service.ts'
import { DEPARTMENT_RESOURCE, USER_RESOURCE } from './meta.ts'

const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（部门）', () => {
  const db = createDb(url!)
  const registry = createSealedResourceRegistry()
  const authz = createAuthzEnforcer(registry)
  const departments = createDepartmentService(
    db,
    createNumberingService(db, buildNumberingCatalog(registry), registry),
    registry,
  )
  const iam = createIamService(db, registry)

  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8)
  const currencyId = crypto.randomUUID()
  const companyA = crypto.randomUUID()
  const companyB = crypto.randomUUID()
  const userId = crypto.randomUUID()
  const created: string[] = []

  /** 取一张真凭证（走 decide，与路由 guard 同一路径） */
  function permit(action: string, actorInput: Parameters<typeof testActor>[0]): Permit {
    const decision = authz.decideFor(testActor(actorInput), DEPARTMENT_RESOURCE, action)
    if (decision.outcome !== 'permit') throw new Error(`夹具应当 permit: ${action}`)
    return decision.permit
  }

  /** 用户资源（global）的 superAdmin 凭证：部门挂接经 IamService 写侧校验 */
  function userPermit(action: string): Permit {
    const decision = authz.decideFor(testActor({ superAdmin: true }), USER_RESOURCE, action)
    if (decision.outcome !== 'permit') throw new Error(`夹具应当 permit: ${action}`)
    return decision.permit
  }

  /** 公司 A 的读写凭证（仅授权公司 A） */
  const codes = ['sys.department:read', 'sys.department:create', 'sys.department:update', 'sys.department:delete']
  const inA = (action: string): Permit =>
    permit(action, { userId, companyIds: [companyA], permissions: codes })
  const inB = (action: string): Permit =>
    permit(action, { userId, companyIds: [companyB], permissions: codes })

  async function pathOf(id: string): Promise<string> {
    const row = await sql<{ path: string }>`
      SELECT path FROM sys_department WHERE id = ${id}::uuid
    `.execute(db)
    return row.rows[0]!.path
  }

  async function newDept(
    p: Permit,
    input: { name: string; companyId: string; parentId?: string | null },
  ) {
    const item = await departments.create(p, input)
    created.push(item.id)
    return item
  }

  beforeAll(async () => {
    await sql`
      INSERT INTO bas_currency (id, name, iso_code, symbol, active)
      VALUES (${currencyId}::uuid, ${'部门币-' + suffix}, ${'D' + suffix.slice(0, 2).toUpperCase()}, 'D', true)
    `.execute(db)
    for (const [id, code] of [
      [companyA, 'DA'],
      [companyB, 'DB'],
    ] as const) {
      await sql`
        INSERT INTO bas_company (id, code, name, short_name, base_currency_id)
        VALUES (${id}::uuid, ${code + suffix}, ${'部门公司' + code}, ${code}, ${currencyId}::uuid)
      `.execute(db)
    }
    await sql`
      INSERT INTO sys_user (id, username, name, hashed_password)
      VALUES (${userId}::uuid, ${'dept-' + suffix}, '部门测试员', 'x')
    `.execute(db)
    await sql`
      INSERT INTO sys_user_company (user_id, company_id)
      VALUES (${userId}::uuid, ${companyA}::uuid)
    `.execute(db)
  })

  afterAll(async () => {
    await sql`UPDATE sys_user SET department_id = NULL WHERE id = ${userId}::uuid`.execute(db)
    await sql`DELETE FROM sys_audit_log WHERE resource = 'sys_department'`.execute(db)
    // 子树先删（自引用 FK）
    await sql`
      DELETE FROM sys_department WHERE company_id = ANY(${[companyA, companyB]}::uuid[])
      AND id IN (SELECT id FROM sys_department ORDER BY length(path) DESC)
    `.execute(db)
    await sql`DELETE FROM sys_user_company WHERE user_id = ${userId}::uuid`.execute(db)
    await sql`DELETE FROM sys_user WHERE id = ${userId}::uuid`.execute(db)
    await sql`DELETE FROM bas_company WHERE id = ANY(${[companyA, companyB]}::uuid[])`.execute(db)
    await sql`DELETE FROM bas_currency WHERE id = ${currencyId}::uuid`.execute(db)
    await db.destroy()
  })

  describe('创建与物化路径', () => {
    test('一级部门：path = /{id}/，无上级', async () => {
      const root = await newDept(inA('create'), {
        name: '总部',
        companyId: companyA,
      })
      expect(root.parentId).toBeNull()
      expect(root.company.id).toBe(companyA)
      expect(await pathOf(root.id)).toBe(`/${root.id}/`)
      expect(root.enabled).toBe(true)
    })

    test('子部门：path 追加在父路径之后，父级 hasChildren 翻真', async () => {
      const parent = await newDept(inA('create'), {
        name: '生产部',
        companyId: companyA,
      })
      const child = await newDept(inA('create'), {
        name: '冲压车间',
        companyId: companyA,
        parentId: parent.id,
      })
      expect(await pathOf(child.id)).toBe(`/${parent.id}/${child.id}/`)
      expect(child.parent).toEqual({ id: parent.id, name: '生产部' })
      expect((await departments.get(inA('read'), parent.id)).hasChildren).toBe(true)
    })

    test('公司不在凭证边界内 → not_found（不泄露公司存在性）', async () => {
      const err = await departments
        .create(inA('create'), { name: '越界部', companyId: companyB })
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).code).toBe('not_found')
    })

    test('上级部门跨公司 → 校验失败', async () => {
      const foreign = await newDept(inB('create'), {
        name: 'B 公司总部',
        companyId: companyB,
      })
      const err = await departments
        .create(inA('create'), {
          name: '错挂部',
          companyId: companyA,
          parentId: foreign.id,
        })
        .catch((e: unknown) => e)
      expect((err as ApiError).code).toBe('validation')
    })

    test('系统生成编码：唯一、按规则成形、手填一律 422', async () => {
      const one = await newDept(inA('create'), { name: '编码甲', companyId: companyA })
      const two = await newDept(inA('create'), { name: '编码乙', companyId: companyA })
      expect(one.code).not.toBe(two.code)
      // 迁移 00022 预置规则：B(D)- + 4 位补零序号，按公司分桶
      expect(one.code).toMatch(/^B\(D\)-\d{4}$/)
      expect(two.code).toMatch(/^B\(D\)-\d{4}$/)

      const manual = await departments
        .create(inA('create'), { code: 'HQ-1', name: '手填部', companyId: companyA } as never)
        .catch((e: unknown) => e)
      expect((manual as ApiError).code).toBe('validation')
      expect((manual as ApiError).message).toContain('编号由系统生成,不接受手填')

      // 服务层撞号已无入口；DB 唯一索引仍是最后防线（直插重码 → 23505）
      const dup = await sql`
        INSERT INTO sys_department (company_id, code, name, path)
        VALUES (${companyA}::uuid, ${one.code}, '重码部', ${`/${crypto.randomUUID()}/`})
      `
        .execute(db)
        .catch((e: unknown) => e)
      expect((dup as { code?: string }).code).toBe('23505')
    })
  })

  describe('列表与单条的公司边界', () => {
    test('只看到本公司部门', async () => {
      const listA = await departments.list(inA('read'), { limit: 100, offset: 0 })
      const companies = new Set(listA.results.map((d) => d.company.id))
      expect(companies).toEqual(new Set([companyA]))
      expect(listA.results.length).toBeGreaterThanOrEqual(3)
    })

    test('跨公司单条读取 → not_found', async () => {
      const foreign = await departments.list(inB('read'), { limit: 10, offset: 0 })
      const target = foreign.results[0]!
      const err = await departments.get(inA('read'), target.id).catch((e: unknown) => e)
      expect((err as ApiError).code).toBe('not_found')
    })

    test('零公司授权：列表空集而非报错', async () => {
      const none = permit('read', { userId, companyIds: [], permissions: codes })
      expect((await departments.list(none, { limit: 10, offset: 0 })).count).toBe(0)
    })
  })

  describe('移动节点：整棵子树重算路径', () => {
    test('移动后子树 path 全部改写，子树查询随之生效', async () => {
      const a = await newDept(inA('create'), { name: '甲', companyId: companyA })
      const b = await newDept(inA('create'), {
        name: '乙',
        companyId: companyA,
        parentId: a.id,
      })
      const c = await newDept(inA('create'), {
        name: '丙',
        companyId: companyA,
        parentId: b.id,
      })
      const target = await newDept(inA('create'), {
        name: '丁',
        companyId: companyA,
      })

      await departments.update(inA('update'), b.id, { parentId: target.id })

      expect(await pathOf(b.id)).toBe(`/${target.id}/${b.id}/`)
      expect(await pathOf(c.id)).toBe(`/${target.id}/${b.id}/${c.id}/`)
      expect(await pathOf(a.id)).toBe(`/${a.id}/`)
    })

    test('移到自身或自身后代 → 校验失败（防成环）', async () => {
      const p = await newDept(inA('create'), { name: '环父', companyId: companyA })
      const kid = await newDept(inA('create'), {
        name: '环子',
        companyId: companyA,
        parentId: p.id,
      })
      const self = await departments
        .update(inA('update'), p.id, { parentId: p.id })
        .catch((e: unknown) => e)
      expect((self as ApiError).code).toBe('validation')
      const cycle = await departments
        .update(inA('update'), p.id, { parentId: kid.id })
        .catch((e: unknown) => e)
      expect((cycle as ApiError).code).toBe('validation')
    })

    test('置空上级 → 升为一级部门', async () => {
      const p = await newDept(inA('create'), { name: '提升父', companyId: companyA })
      const kid = await newDept(inA('create'), {
        name: '提升子',
        companyId: companyA,
        parentId: p.id,
      })
      const moved = await departments.update(inA('update'), kid.id, { parentId: null })
      expect(moved.parentId).toBeNull()
      expect(await pathOf(kid.id)).toBe(`/${kid.id}/`)
    })

    test('跨公司写入被拒（update 也过公司边界）', async () => {
      const mine = await departments.list(inA('read'), { limit: 1, offset: 0 })
      const err = await departments
        .update(inB('update'), mine.results[0]!.id, { name: '越界改名' })
        .catch((e: unknown) => e)
      expect((err as ApiError).code).toBe('not_found')
    })
  })

  describe('启停与用户挂接', () => {
    test('停用部门后不可再挂用户；已挂接的存量保留', async () => {
      const dept = await newDept(inA('create'), {
        name: '待停用部',
        companyId: companyA,
      })
      await iam.updateUser(userPermit('update'), userId, { departmentId: dept.id, departmentIdPresent: true })

      await departments.update(inA('update'), dept.id, { enabled: false })

      // 存量挂接保留：改别的字段不受停用影响
      const kept = await iam.updateUser(userPermit('update'), userId, { name: '部门测试员2', namePresent: true })
      expect(kept.departmentId).toBe(dept.id)

      // 换到停用部门 → 校验失败
      await iam.updateUser(userPermit('update'), userId, { departmentId: null, departmentIdPresent: true })
      const err = await iam
        .updateUser(userPermit('update'), userId, { departmentId: dept.id, departmentIdPresent: true })
        .catch((e: unknown) => e)
      expect((err as ApiError).code).toBe('validation')
      expect(JSON.stringify((err as ApiError).fields)).toContain('停用')
    })

    test('停用部门不得作为上级（建与移动两侧）', async () => {
      const off = await newDept(inA('create'), {
        name: '停用上级',
        companyId: companyA,
      })
      await departments.update(inA('update'), off.id, { enabled: false })

      const onCreate = await departments
        .create(inA('create'), {
          name: '挂停用父',
          companyId: companyA,
          parentId: off.id,
        })
        .catch((e: unknown) => e)
      expect((onCreate as ApiError).code).toBe('validation')
      expect(JSON.stringify((onCreate as ApiError).fields)).toContain('上级部门已停用')

      const free = await newDept(inA('create'), {
        name: '待移动部',
        companyId: companyA,
      })
      const onMove = await departments
        .update(inA('update'), free.id, { parentId: off.id })
        .catch((e: unknown) => e)
      expect((onMove as ApiError).code).toBe('validation')
      expect(JSON.stringify((onMove as ApiError).fields)).toContain('上级部门已停用')
    })

    test('用户读取面带部门名（fk 列需要 department 关系,否则前端只能印 uuid）', async () => {
      const dept = await newDept(inA('create'), {
        name: '有名字的部',
        companyId: companyA,
      })
      const updated = await iam.updateUser(userPermit('update'), userId, {
        departmentId: dept.id,
        departmentIdPresent: true,
      })
      expect(updated.department).toEqual({ id: dept.id, name: '有名字的部' })
      expect((await iam.getUser(userPermit('read'), userId)).department).toEqual({
        id: dept.id,
        name: '有名字的部',
      })
      const listed = await iam.listUsers(userPermit('read'), {
        limit: 200,
        offset: 0,
        filter: { username: { kind: 'text', op: 'eq', value: `dept-${suffix}` } },
      })
      expect(listed.results[0]?.department).toEqual({ id: dept.id, name: '有名字的部' })

      await iam.updateUser(userPermit('update'), userId, { departmentId: null, departmentIdPresent: true })
      expect((await iam.getUser(userPermit('read'), userId)).department).toBeNull()
    })

    test('部门所在公司不在用户公司授权集内 → 校验失败并提示先授权', async () => {
      const foreign = await newDept(inB('create'), {
        name: 'B 公司部门',
        companyId: companyB,
      })
      const err = await iam
        .updateUser(userPermit('update'), userId, {
          departmentId: foreign.id,
          departmentIdPresent: true,
        })
        .catch((e: unknown) => e)
      expect((err as ApiError).code).toBe('validation')
      expect(JSON.stringify((err as ApiError).fields)).toContain('公司授权')
    })
  })

  describe('删除守卫', () => {
    test('有下级部门不可删', async () => {
      const p = await newDept(inA('create'), { name: '删父', companyId: companyA })
      await newDept(inA('create'), {
        name: '删子',
        companyId: companyA,
        parentId: p.id,
      })
      const err = await departments.remove(inA('delete'), p.id).catch((e: unknown) => e)
      expect((err as ApiError).code).toBe('conflict')
    })

    test('仍有用户挂接不可删', async () => {
      const dept = await newDept(inA('create'), {
        name: '有人部',
        companyId: companyA,
      })
      await iam.updateUser(userPermit('update'), userId, { departmentId: dept.id, departmentIdPresent: true })
      const err = await departments.remove(inA('delete'), dept.id).catch((e: unknown) => e)
      expect((err as ApiError).code).toBe('conflict')
      await iam.updateUser(userPermit('update'), userId, { departmentId: null, departmentIdPresent: true })
    })

    test('叶子且无人挂接可删；跨公司删除 → not_found', async () => {
      const leaf = await newDept(inA('create'), {
        name: '可删部',
        companyId: companyA,
      })
      const denied = await departments.remove(inB('delete'), leaf.id).catch((e: unknown) => e)
      expect((denied as ApiError).code).toBe('not_found')
      await departments.remove(inA('delete'), leaf.id)
      const gone = await departments.get(inA('read'), leaf.id).catch((e: unknown) => e)
      expect((gone as ApiError).code).toBe('not_found')
    })
  })

  describe('审计', () => {
    test('创建/更新/删除均落审计行', async () => {
      const dept = await newDept(inA('create'), {
        name: '审计部',
        companyId: companyA,
      })
      await departments.update(inA('update'), dept.id, { name: '审计部2' })
      await departments.remove(inA('delete'), dept.id)
      const rows = await sql<{ action_type: string }>`
        SELECT action_type FROM sys_audit_log
        WHERE resource = 'sys_department' AND record_id = ${dept.id}::uuid
        ORDER BY inserted_at
      `.execute(db)
      expect(rows.rows.map((r) => r.action_type)).toEqual(['create', 'update', 'destroy'])
    })
  })
})
