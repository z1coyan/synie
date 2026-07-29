import { useEffect, useState } from 'react'

/**
 * 响应式媒体查询钩子:SSR 期返回 false(桌面分支),hydrate 后按真实视口纠正。
 * 与 options-popover 的一次性 matchMedia 判断同口径,这里追加 change 监听。
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches
  )

  useEffect(() => {
    const media = window.matchMedia(query)
    setMatches(media.matches)
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [query])

  return matches
}
