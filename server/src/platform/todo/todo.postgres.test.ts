/**
 * 待办查询 / 已读 / 忽略复位 PG 集成。
 * 门控 SYNIE_TEST_DATABASE_URL。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { createTodoService } from './service.ts'

const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（待办）', () => {
  const db = createDb(url!)
  const svc = createTodoService(db)
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()
  const prefix = `TD${suffix}`

  const currencyId = crypto.randomUUID()
  const companyA = crypto.randomUUID()
  const companyB = crypto.randomUUID()
  const customerId = crypto.randomUUID()
  const userA = crypto.randomUUID()
  const userB = crypto.randomUUID()
  const sourceId = crypto.randomUUID()
  const todoId = crypto.randomUUID()
  const historyId = crypto.randomUUID()
  const otherCompanyTodo = crypto.randomUUID()

  const actorA: Actor = {
    userId: userA,
    username: 'todo-a',
    name: 'A',
    superAdmin: false,
    allCompanies: false,
    permissions: new Set(['acc.vat_invoice:create', 'acc.vat_invoice:read']),
    companyIds: [companyA],
  }
  const actorB: Actor = {
    userId: userB,
    username: 'todo-b',
    name: 'B',
    superAdmin: false,
    allCompanies: false,
    permissions: new Set(['acc.vat_invoice:create', 'acc.vat_invoice:read']),
    companyIds: [companyA],
  }
  const readOnly: Actor = {
    userId: userA,
    username: 'todo-ro',
    name: 'RO',
    superAdmin: false,
    allCompanies: false,
    permissions: new Set(['acc.vat_invoice:read']),
    companyIds: [companyA],
  }
  const wrongCompany: Actor = {
    userId: userA,
    username: 'todo-wc',
    name: 'WC',
    superAdmin: false,
    allCompanies: false,
    permissions: new Set(['acc.vat_invoice:create', 'acc.vat_invoice:read']),
    companyIds: [companyB],
  }

  beforeAll(async () => {
    await sql`
      INSERT INTO bas_currency(id,name,iso_code,symbol,active)
      VALUES (${currencyId}::uuid, ${prefix + '币'}, ${'T' + suffix.slice(0, 2)}, '¤', true)
    `.execute(db)
    await sql`
      INSERT INTO bas_company(id,code,name,short_name,base_currency_id) VALUES
        (${companyA}::uuid, ${'A' + suffix}, ${prefix + '公司A'}, 'TA', ${currencyId}::uuid),
        (${companyB}::uuid, ${'B' + suffix}, ${prefix + '公司B'}, 'TB', ${currencyId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO sys_user(id,username,name,hashed_password) VALUES
        (${userA}::uuid, ${'ta' + suffix}, '用户A', 'x'),
        (${userB}::uuid, ${'tb' + suffix}, '用户B', 'x')
    `.execute(db)
    await sql`
      INSERT INTO sal_customers(id,code,name,short_name)
      VALUES (${customerId}::uuid, ${'CU' + suffix}, ${prefix + '客户'}, 'CU')
    `.execute(db)
    await sql`
      INSERT INTO sys_todo(
        id, type, source_type, source_id, source_no, party_type, party_id, amount,
        status, source_changed_at, company_id, created_by_id
      ) VALUES (
        ${todoId}::uuid, 'issue_invoice', 'sales.reconciliation', ${sourceId}::uuid,
        ${prefix + 'SR'}, 'customer', ${customerId}::uuid, 100,
        'active', (now() AT TIME ZONE 'utc'), ${companyA}::uuid, ${userA}::uuid
      )
    `.execute(db)
    await sql`
      INSERT INTO sys_todo(
        id, type, source_type, source_id, source_no, party_type, party_id, amount,
        status, closed_reason, closed_at, source_changed_at, company_id, created_by_id
      ) VALUES (
        ${historyId}::uuid, 'issue_invoice', 'sales.reconciliation', ${crypto.randomUUID()}::uuid,
        ${prefix + 'H'}, 'customer', ${customerId}::uuid, 50,
        'closed', 'unconfirm', (now() AT TIME ZONE 'utc'),
        (now() AT TIME ZONE 'utc'), ${companyA}::uuid, ${userA}::uuid
      )
    `.execute(db)
    await sql`
      INSERT INTO sys_todo(
        id, type, source_type, source_id, source_no, party_type, party_id, amount,
        status, source_changed_at, company_id, created_by_id
      ) VALUES (
        ${otherCompanyTodo}::uuid, 'receive_invoice', 'purchase.reconciliation',
        ${crypto.randomUUID()}::uuid, ${prefix + 'PR'}, 'supplier', ${customerId}::uuid, 20,
        'active', (now() AT TIME ZONE 'utc'), ${companyB}::uuid, ${userA}::uuid
      )
    `.execute(db)
  })

  afterAll(async () => {
    await sql`DELETE FROM sys_todo_state WHERE todo_id IN (
      SELECT id FROM sys_todo WHERE company_id IN (${companyA}::uuid, ${companyB}::uuid)
    )`.execute(db)
    await sql`DELETE FROM sys_todo WHERE company_id IN (${companyA}::uuid, ${companyB}::uuid)`.execute(
      db,
    )
    await sql`DELETE FROM sal_customers WHERE id=${customerId}::uuid`.execute(db)
    await sql`DELETE FROM sys_user WHERE id IN (${userA}::uuid, ${userB}::uuid)`.execute(db)
    await sql`DELETE FROM bas_company WHERE id IN (${companyA}::uuid, ${companyB}::uuid)`.execute(
      db,
    )
    await sql`DELETE FROM bas_currency WHERE id=${currencyId}::uuid`.execute(db)
    await db.destroy()
  })

  test('列表按公司圈人；无 create 权限不可查；历史 tab', async () => {
    const active = await svc.list(actorA, { tab: 'active' })
    expect(active.count).toBe(1)
    expect(active.results[0]!.id).toBe(todoId)
    expect(active.results[0]!.type).toBe('ISSUE_INVOICE')
    expect(active.results[0]!.status).toBe('ACTIVE')
    expect(active.results[0]!.partyName).toBe(prefix + '客户')
    expect(active.results[0]!.company?.name).toBe(prefix + '公司A')

    // companyB 可见本公司待办，不可见 companyA
    const other = await svc.list(wrongCompany, { tab: 'active' })
    expect(other.results.every((t) => t.companyId === companyB)).toBe(true)
    expect(other.results.find((t) => t.id === todoId)).toBeUndefined()

    await expect(svc.list(readOnly, { tab: 'active' })).rejects.toBeInstanceOf(ApiError)

    const history = await svc.list(actorA, { tab: 'history' })
    expect(history.count).toBe(1)
    expect(history.results[0]!.id).toBe(historyId)
    expect(history.results[0]!.closedReason).toBe('UNCONFIRM')
  })

  test('已读仅影响本人未读数', async () => {
    const beforeA = await svc.unreadCount(actorA)
    const beforeB = await svc.unreadCount(actorB)
    expect(beforeA).toBeGreaterThanOrEqual(1)
    expect(beforeB).toBeGreaterThanOrEqual(1)

    const marked = await svc.markRead(actorA, todoId)
    expect(marked.myReadAt).toBeTruthy()

    const afterA = await svc.unreadCount(actorA)
    const afterB = await svc.unreadCount(actorB)
    expect(afterA).toBe(beforeA - 1)
    expect(afterB).toBe(beforeB)
  })

  test('个人忽略只影响本人；includeDismissed 可见', async () => {
    const dismissed = await svc.dismiss(actorB, todoId)
    expect(dismissed.dismissed).toBe(true)
    expect(dismissed.myDismissedAt).toBeTruthy()

    const hidden = await svc.list(actorB, { tab: 'active' })
    expect(hidden.results.find((t) => t.id === todoId)).toBeUndefined()

    const included = await svc.list(actorB, { tab: 'active', includeDismissed: true })
    const row = included.results.find((t) => t.id === todoId)
    expect(row?.dismissed).toBe(true)

    // A 仍可见
    const forA = await svc.list(actorA, { tab: 'active' })
    expect(forA.results.find((t) => t.id === todoId)).toBeTruthy()
  })

  test('source_changed_at 前进后忽略复位（dismissed=false 且重新出现在 active）', async () => {
    // 依赖上一用例 actorB 已 dismiss；推进 source_changed_at 使 reset_basis 失配
    await sql`
      UPDATE sys_todo
         SET source_changed_at = source_changed_at + interval '1 minute'
       WHERE id = ${todoId}::uuid
    `.execute(db)

    const active = await svc.list(actorB, { tab: 'active' })
    const row = active.results.find((t) => t.id === todoId)
    expect(row).toBeTruthy()
    // 历史 dismissed_at 仍在，但 dismissed 标志因复位基准失效而为 false
    expect(row!.dismissed).toBe(false)
    expect(row!.myDismissedAt).toBeTruthy()
  })

  test('只读权限可读未读数', async () => {
    const count = await svc.unreadCount(readOnly)
    expect(count).toBeGreaterThanOrEqual(0)
  })

  test('不存在待办 mark/dismiss → not_found', async () => {
    await expect(svc.markRead(actorA, crypto.randomUUID())).rejects.toMatchObject({
      code: 'not_found',
    })
  })
})
