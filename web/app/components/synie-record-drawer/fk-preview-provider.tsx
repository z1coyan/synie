import { useCallback, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { FkPreviewContext } from './fk-preview'
import { SynieRecordDrawer } from './SynieRecordDrawer'
import { DocumentPreviewDrawer } from './DocumentPreviewDrawer'
import { getDocumentPreview } from './document-preview'
// 侧效登记库存来源单据只读速览
import './document-preview-registry'
import { basicFormDrawerProps, fetchResourceDocument } from '~/lib/resources/catalog'
import {
  resourceBindingFor,
  resourceTransportFromResourceBinding,
} from '~/lib/resources/registry'

interface Entry {
  key: number
  resource: string
  id: string
  open: boolean
}

let seq = 0

/** 未登记单据速览：仅基础资源表单头字段（历史行为） */
function BasicFkPreviewDrawer({
  entry,
  onClose,
}: {
  entry: Entry
  onClose: () => void
}) {
  const docQuery = useQuery({
    queryKey: ['fkPreviewMeta', entry.resource],
    queryFn: () => fetchResourceDocument(entry.resource),
    staleTime: 5 * 60_000,
  })
  const formProps =
    docQuery.data?.form.kind === 'basic'
      ? basicFormDrawerProps(docQuery.data)
      : {
          label: docQuery.data?.label ?? entry.resource,
          exclude: [] as string[],
          fields: {},
        }

  const client = resourceTransportFromResourceBinding(entry.resource)

  return (
    <SynieRecordDrawer
      resource={entry.resource}
      client={client}
      mode="view"
      rowId={entry.id}
      isOpen={entry.open}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
      label={formProps.label}
      exclude={formProps.exclude}
      fields={formProps.fields}
    />
  )
}

function FkPreviewDrawer({
  entry,
  onClose,
}: {
  entry: Entry
  onClose: () => void
}) {
  if (getDocumentPreview(entry.resource)) {
    return (
      <DocumentPreviewDrawer
        resource={entry.resource}
        id={entry.id}
        isOpen={entry.open}
        onOpenChange={(o) => {
          if (!o) onClose()
        }}
      />
    )
  }
  return <BasicFkPreviewDrawer entry={entry} onClose={onClose} />
}

/**
 * 全局 fk 速览栈:每层一个 view 态抽屉(按 rowId 自取数)。
 * 已登记 DocumentPreview 的资源 → 头+库存相关子表；否则 ResourceDocument 基础表单。
 */
export function FkPreviewProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<Entry[]>([])

  const open = useCallback((resource: string, id: string) => {
    resourceBindingFor(resource)
    setStack((s) => [...s.filter((e) => e.open), { key: ++seq, resource, id, open: true }])
  }, [])

  return (
    <FkPreviewContext.Provider value={open}>
      {children}
      {stack.map((e) => (
        <FkPreviewDrawer
          key={e.key}
          entry={e}
          onClose={() =>
            setStack((s) => s.map((x) => (x.key === e.key ? { ...x, open: false } : x)))
          }
        />
      ))}
    </FkPreviewContext.Provider>
  )
}
