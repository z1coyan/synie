import { createContext, useContext } from 'react'
import { Link } from '@heroui/react'
import type { GridColumnMeta, Row } from '../synie-data-grid/types'
import { resolveFkTarget, resolveSource } from '../synie-remote-select/remote-query'
import { useRemoteRecords } from '../synie-remote-select/use-remote'

/**
 * fk 速览:openPreview(resource, id) 压栈打开一层 view 态 SynieRecordDrawer,
 * 速览里再点 fk 继续叠层。Provider 在 _app 布局挂载(fk-preview-provider.tsx),
 * 拆两个文件是为了断开 SynieRecordDrawer ↔ Provider 的循环引用。
 */
export const FkPreviewContext = createContext<(resource: string, id: string) => void>(() => {})

export function useFkPreview() {
  return useContext(FkPreviewContext)
}

/** 外键文本:行数据有 join 直接用;否则按 id 反查;都拿不到显示截断 id */
export function FkText({ col, row }: { col: GridColumnMeta; row: Row }) {
  const ref = col.ref!
  const id = row[col.name] == null ? null : String(row[col.name])
  const rel = ref.relation ? ((row[ref.relation] as Row | null | undefined) ?? null) : null
  const target = resolveFkTarget(ref, row)
  // ponytail: 多态 fk 无 join,逐单元格按 id 反查(有 5min 缓存);量大再上批量反查/后端计算字段
  const resolved = useRemoteRecords(target ? resolveSource(target) : null, rel || !id ? [] : [id])
  if (!id) return <span className="text-muted">—</span>
  const hit = rel ?? resolved.data?.[0]
  const label = target ? hit?.[target.labelField] : null
  return <>{label != null ? String(label) : id.slice(0, 8)}</>
}

/** 外键单元格/字段默认渲染:link 点击开速览抽屉;空值显示 —(表格/抽屉/子条目表三处共用) */
export function FkLink({ col, row }: { col: GridColumnMeta; row: Row }) {
  const openPreview = useFkPreview()
  const ref = col.ref!
  const raw = row[col.name]
  const id = raw == null || raw === '' ? null : String(raw)
  const target = resolveFkTarget(ref, row)
  if (!id) return <span className="text-muted">—</span>
  // 目标解析不了(多态判别值未知/变体被权限裁剪):退纯文本截断 id,不给点不开的 link
  if (!target) return <>{id.slice(0, 8)}</>
  return (
    <Link
      onPress={() => openPreview(target.resource, id)}
      className="inline-block max-w-80 cursor-pointer truncate align-bottom text-inherit underline-offset-2 hover:underline"
    >
      <FkText col={col} row={row} />
    </Link>
  )
}
