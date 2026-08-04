import { useCallback, useSyncExternalStore } from 'react'

/**
 * 响应式媒体查询钩子:SSR 与 hydration 首帧取 false(桌面分支),
 * 注水完成后按真实视口纠正并持续监听 change。
 * useSyncExternalStore 的服务端快照保证首帧一致,不产生 hydration mismatch。
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const media = window.matchMedia(query)
      media.addEventListener('change', onChange)
      return () => media.removeEventListener('change', onChange)
    },
    [query],
  )

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  )
}
