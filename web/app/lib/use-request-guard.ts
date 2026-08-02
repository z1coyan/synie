/**
 * 「开抽屉自增序号、异步回填前比对」请求守卫。
 * 下沉自 system/users.tsx、finance/journals.tsx、scm/sales-orders/-order-drawer.tsx 等
 * 逐字同款的 reqIdRef 用法:开抽屉占号 → await 回来比对最新序号,过期响应丢弃;
 * 关抽屉自增序号,作废全部在途请求,防慢响应回填到下一张单据。
 */
import { useRef } from 'react'

export interface RequestGuard {
  /** 占号:每次开抽屉调用(含 create 同步回填),返回本次序号 */
  begin(): number
  /** 比对:异步回填前调用,false 表示抽屉已切走/关闭,响应应丢弃 */
  isCurrent(id: number): boolean
  /** 作废:关抽屉时调用,使全部在途请求失效 */
  invalidate(): void
}

/** 纯工厂,便于脱离 React 测试 */
export function createRequestGuard(): RequestGuard {
  let seq = 0
  return {
    begin: () => ++seq,
    isCurrent: (id) => id === seq,
    invalidate: () => {
      seq++
    },
  }
}

/** 组件内使用:守卫实例随组件存活,重渲染不重置序号 */
export function useRequestGuard(): RequestGuard {
  const ref = useRef<RequestGuard | null>(null)
  if (ref.current === null) ref.current = createRequestGuard()
  return ref.current
}
