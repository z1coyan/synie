import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  clearColumnPrefs,
  readColumnPrefs,
  resolveVisibleOrder,
  storageKeyForColumnPrefs,
  writeColumnPrefs,
  type GridColumnPrefs,
} from './column-prefs'

export interface UseColumnPrefsOptions {
  /** 稳定视图身份（columnPrefsKey ?? resource） */
  prefsKey: string
  enabled: boolean
  /** 无偏好时的默认可见序 */
  defaultOrder: string[]
  /** 可选列名全集 */
  candidates: string[]
}

export interface UseColumnPrefsResult {
  /** 当前可见列有序 */
  order: string[]
  /** 是否存在用户偏好（非默认） */
  isCustomized: boolean
  setOrder: (next: string[]) => void
  reset: () => void
}

/**
 * 列显示偏好：同步读 localStorage 初值，变更立即写回。
 * enabled=false 时恒返回 defaultOrder 解析结果，不读写 storage。
 */
export function useColumnPrefs(options: UseColumnPrefsOptions): UseColumnPrefsResult {
  const { prefsKey, enabled, defaultOrder, candidates } = options
  const storageKey = storageKeyForColumnPrefs(prefsKey)

  const [prefs, setPrefs] = useState<GridColumnPrefs | null>(() =>
    enabled ? readColumnPrefs(storageKey) : null,
  )

  // prefsKey / enabled 变化时重新对齐 storage
  useEffect(() => {
    if (!enabled) {
      setPrefs(null)
      return
    }
    setPrefs(readColumnPrefs(storageKey))
  }, [enabled, storageKey])

  const order = useMemo(
    () => resolveVisibleOrder(enabled ? prefs : null, defaultOrder, candidates),
    [enabled, prefs, defaultOrder, candidates],
  )

  const setOrder = useCallback(
    (next: string[]) => {
      if (!enabled) return
      const resolved = resolveVisibleOrder({ v: 1, order: next }, defaultOrder, candidates)
      if (resolved.length === 0) return
      const nextPrefs: GridColumnPrefs = prefs?.widths
        ? { v: 1, order: resolved, widths: prefs.widths }
        : { v: 1, order: resolved }
      setPrefs(nextPrefs)
      writeColumnPrefs(storageKey, nextPrefs)
    },
    [enabled, defaultOrder, candidates, prefs?.widths, storageKey],
  )

  const reset = useCallback(() => {
    if (!enabled) return
    setPrefs(null)
    clearColumnPrefs(storageKey)
  }, [enabled, storageKey])

  return {
    order,
    isCustomized: enabled && prefs != null,
    setOrder,
    reset,
  }
}
