/**
 * guard 中间件的 HTTP 契约（工单 04）：Permit 入 ctx、码不满足 = forbidden、
 * 分支内二次取凭证、systemPermit 旁路。业务模块迁移见 06-08。
 */
import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { onError } from '../http/errors.ts'
import type { AppEnv } from '../http/context.ts'
import { createSealedResourceRegistry } from '../meta/register-all.ts'
import { systemPermit } from './core/index.ts'
import { createAuthzEnforcer, permitOf } from './enforce.ts'
import { testActor } from './testing.ts'
import type { Actor } from './core/index.ts'

const registry = createSealedResourceRegistry()
const authz = createAuthzEnforcer(registry)

function appWith(actor: Actor) {
  return new Hono<AppEnv>()
    .onError(onError)
    .use('*', async (c, next) => {
      c.set('actor', actor)
      await next()
    })
    .get('/orders', authz.guard('salOrders', 'read'), (c) => {
      const permit = permitOf(c)
      return c.json({
        resource: permit.resource,
        action: permit.action,
        company: permit.rowFilter.company,
        atoms: permit.rowFilter.atoms,
      })
    })
    .post('/orders/audit', authz.guard('salOrders', 'audit'), (c) => c.json({ ok: true }))
    .post('/orders/import', authz.guard('salOrders', 'create'), (c) => {
      // 分支内二次授权：导入顺带建客户需要另一张凭证
      const extra = authz.permitFor(c, 'salCustomers', 'create')
      return c.json({ ok: true, extra: extra.resource })
    })
    .get('/unguarded', (c) => {
      permitOf(c)
      return c.json({ ok: true })
    })
}

describe('guard 中间件', () => {
  test('通过则 Permit 入 ctx，携带资源/动作/行过滤', async () => {
    const app = appWith(
      testActor({ companyIds: ['c1', 'c2'], permissions: ['sales.order:read'] }),
    )
    const res = await app.request('/orders')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      resource: 'salOrders',
      action: 'read',
      company: { ids: ['c1', 'c2'] },
      atoms: ['all'],
    })
  })

  test('码不满足 → 403 forbidden（不是 404）', async () => {
    const app = appWith(testActor({ companyIds: ['c1'], permissions: ['sales.order:read'] }))
    const res = await app.request('/orders/audit', { method: 'POST' })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: { code: 'forbidden' } })
  })

  test('零公司授权仍是 permit（行级空集，语义 not_found 由执行点落地）', async () => {
    const app = appWith(testActor({ companyIds: [], permissions: ['sales.order:read'] }))
    const res = await app.request('/orders')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ company: 'none' })
  })

  test('超管 bypass 全部', async () => {
    const app = appWith(testActor({ superAdmin: true }))
    expect((await app.request('/orders')).status).toBe(200)
    expect((await app.request('/orders/audit', { method: 'POST' })).status).toBe(200)
  })

  test('分支内二次取凭证：缺第二张码即 forbidden', async () => {
    const withBoth = appWith(
      testActor({
        allCompanies: true,
        permissions: ['sales.order:create', 'base.customer:create'],
      }),
    )
    expect((await withBoth.request('/orders/import', { method: 'POST' })).status).toBe(200)

    const onlyFirst = appWith(
      testActor({ allCompanies: true, permissions: ['sales.order:create'] }),
    )
    expect((await onlyFirst.request('/orders/import', { method: 'POST' })).status).toBe(403)
  })

  test('未挂 guard 的路由取 Permit 直接失败（fail-closed，不静默放行）', async () => {
    const app = appWith(testActor({ superAdmin: true }))
    const res = await app.request('/unguarded')
    expect(res.status).toBe(500)
  })
})

describe('systemPermit', () => {
  test('系统主体凭证恒 bypass；调度器/种子走此路径', () => {
    const permit = systemPermit('salOrders', 'audit')
    expect(permit.actor.kind).toBe('system')
    expect(permit.rowFilter).toEqual({ company: 'bypass', atoms: ['all'] })
  })

  test('system 主体经 decideFor 亦恒 permit（无需授权行）', () => {
    const actor = testActor({ kind: 'system', allCompanies: true })
    expect(authz.decideFor(actor, 'salOrders', 'audit').outcome).toBe('permit')
  })
})

describe('via 资源的动作解析', () => {
  test('子行动作按宿主声明校验（宿主有 audit，子行 meta 只有 read）', () => {
    expect(authz.decideFor(testActor({ superAdmin: true }), 'salOrderItems', 'audit').outcome).toBe(
      'permit',
    )
  })

  test('宿主也没有的动作即抛（动作码唯一事实源是 meta）', () => {
    expect(() =>
      authz.decideFor(testActor({ superAdmin: true }), 'salOrderItems', 'teleport'),
    ).toThrow(/未声明动作/)
  })
})
