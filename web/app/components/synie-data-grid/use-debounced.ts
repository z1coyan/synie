import { useEffect, useState } from 'react'

/** trailing 防抖:值停稳 ms 后才透出 */
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return debounced
}

/**
 * 本地草稿 + 停稳提交:输入即时回显,300ms 停稳后才向上 commit,
 * 避免每个键击触发父级(整表)重渲染与查询。
 * committed 被外部清空(chips/清除全部)时不回写草稿:弹层关闭即卸载,重开自然回填。
 */
export function useDraft(committed: string, commit: (v: string) => void): [string, (v: string) => void] {
  const [draft, setDraft] = useState(committed)
  const debounced = useDebounced(draft, 300)
  useEffect(() => {
    if (debounced !== committed) commit(debounced)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅草稿停稳时提交,commit/committed 取当次渲染最新值
  }, [debounced])
  return [draft, setDraft]
}
