import { useCallback, useState, type ReactNode } from 'react'
import { FkPreviewContext } from './fk-preview'
import { SynieRecordDrawer } from './SynieRecordDrawer'
import { drawerConfig } from './registry'

interface Entry {
  key: number
  resource: string
  id: string
  open: boolean
}

let seq = 0

/**
 * 全局 fk 速览栈:每层一个 view 态 SynieRecordDrawer(按 rowId 自取数),
 * 速览里再点 fk 继续叠层。关闭只翻 open 标志让 Sheet 退场动画播完,
 * 已关的层留在栈里不可见,下次 push 时顺手清掉。
 */
export function FkPreviewProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<Entry[]>([])

  const open = useCallback((resource: string, id: string) => {
    setStack((s) => [...s.filter((e) => e.open), { key: ++seq, resource, id, open: true }])
  }, [])

  return (
    <FkPreviewContext.Provider value={open}>
      {children}
      {stack.map((e) => (
        <SynieRecordDrawer
          key={e.key}
          resource={e.resource}
          mode="view"
          rowId={e.id}
          isOpen={e.open}
          onOpenChange={(o) => {
            if (!o) setStack((s) => s.map((x) => (x.key === e.key ? { ...x, open: false } : x)))
          }}
          {...drawerConfig(e.resource)}
        />
      ))}
    </FkPreviewContext.Provider>
  )
}
