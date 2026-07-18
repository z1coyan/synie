import { useCallback, useEffect, useState } from 'react'
import {
  APPEARANCE_EVENT,
  APPEARANCE_STORAGE_KEY,
  applyResolvedAppearance,
  isAppearanceMode,
  readAppearanceMode,
  resolveAppearance,
  setAppearanceMode,
  type AppearanceMode,
  type ResolvedAppearance,
} from './appearance'

/**
 * 外观模式 React 钩子:读本机偏好、切换、跟随 OS、多标签同步。
 * FOUC 已由根文档内联脚本处理;本钩子负责交互期一致性。
 */
export function useAppearance(): {
  mode: AppearanceMode
  resolved: ResolvedAppearance
  setMode: (mode: AppearanceMode) => void
} {
  const [mode, setModeState] = useState<AppearanceMode>(() => readAppearanceMode())
  const [resolved, setResolved] = useState<ResolvedAppearance>(() =>
    resolveAppearance(readAppearanceMode())
  )

  const sync = useCallback((next: AppearanceMode) => {
    const r = resolveAppearance(next)
    applyResolvedAppearance(r)
    setModeState(next)
    setResolved(r)
  }, [])

  useEffect(() => {
    sync(readAppearanceMode())

    const onStorage = (event: StorageEvent) => {
      if (event.key !== APPEARANCE_STORAGE_KEY) return
      const next = isAppearanceMode(event.newValue) ? event.newValue : 'system'
      sync(next)
    }

    const onLocal = (event: Event) => {
      const next = (event as CustomEvent<unknown>).detail
      if (isAppearanceMode(next)) {
        setModeState(next)
        setResolved(resolveAppearance(next))
      }
    }

    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onMedia = () => {
      const current = readAppearanceMode()
      if (current === 'system') sync('system')
    }

    window.addEventListener('storage', onStorage)
    window.addEventListener(APPEARANCE_EVENT, onLocal)
    media.addEventListener('change', onMedia)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener(APPEARANCE_EVENT, onLocal)
      media.removeEventListener('change', onMedia)
    }
  }, [sync])

  const setMode = useCallback(
    (next: AppearanceMode) => {
      setAppearanceMode(next)
      setModeState(next)
      setResolved(resolveAppearance(next))
    },
    []
  )

  return { mode, resolved, setMode }
}
