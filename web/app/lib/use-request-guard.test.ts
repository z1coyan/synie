import { describe, expect, test } from 'bun:test'
import { createRequestGuard } from './use-request-guard'

describe('createRequestGuard', () => {
  test('begin 自增占号,最新序号 isCurrent 为 true', () => {
    const g = createRequestGuard()
    const a = g.begin()
    expect(a).toBe(1)
    expect(g.isCurrent(a)).toBe(true)
  })

  test('再开一张单据后,旧序号失效(慢响应 A 不覆盖已切到 B 的回填)', () => {
    const g = createRequestGuard()
    const a = g.begin() // 开单据 A
    const b = g.begin() // A 请求在途时又开单据 B
    expect(g.isCurrent(a)).toBe(false)
    expect(g.isCurrent(b)).toBe(true)
  })

  test('invalidate 作废全部在途请求(关抽屉场景)', () => {
    const g = createRequestGuard()
    const a = g.begin()
    g.invalidate() // 抽屉关闭
    expect(g.isCurrent(a)).toBe(false)
    // 之后重新开抽屉占新号,互不干扰
    const b = g.begin()
    expect(g.isCurrent(b)).toBe(true)
  })

  test('create 态同步回填也占号,同样能作废上一张单据的在途请求', () => {
    const g = createRequestGuard()
    const a = g.begin() // view 单据 A,请求在途
    const b = g.begin() // 直接点「新增」(create 同步回填,仍占号)
    expect(g.isCurrent(a)).toBe(false)
    expect(g.isCurrent(b)).toBe(true)
  })

  test('多个守卫实例互不影响', () => {
    const g1 = createRequestGuard()
    const g2 = createRequestGuard()
    const a = g1.begin()
    g2.begin()
    expect(g1.isCurrent(a)).toBe(true)
  })
})
