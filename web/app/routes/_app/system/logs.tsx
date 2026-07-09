import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/system/logs')({
  component: LogsPage,
})

const ACTION_LABELS: Record<string, string> = { create: '创建', update: '更新', destroy: '删除' }

// id 列展示原始 uuid 无阅读价值,记录名称/操作人已够定位;需要按 id 排查时直接查库
const EXCLUDE = ['recordId', 'actorId', 'companyId']

/** changes 经 GraphQL JsonString 标量到达是 JSON 串;兼容将来切 Json 标量直接给对象的情况 */
function parseChanges(value: unknown): Record<string, { from?: unknown; to?: unknown }> | null {
  const parsed = typeof value === 'string' && value ? safeJsonParse(value) : value
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, { from?: unknown; to?: unknown }>)
    : null
}

function safeJsonParse(v: string): unknown {
  try {
    return JSON.parse(v)
  } catch {
    return null
  }
}

const fmtVal = (v: unknown): string => {
  if (v == null) return '空'
  if (typeof v === 'boolean') return v ? '是' : '否'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

const actionLabel = (value: unknown) => ACTION_LABELS[String(value)] ?? String(value)

function changesSummary(value: unknown) {
  const changes = parseChanges(value)
  const count = changes ? Object.keys(changes).length : 0
  return count > 0 ? `${count} 项变更` : <span className="text-muted">—</span>
}

/** 抽屉详情:逐字段 旧值 → 新值(create 只有 to,destroy 只有 from) */
function ChangesDetail({ value }: { value: unknown }) {
  const changes = parseChanges(value)
  const entries = changes ? Object.entries(changes) : []
  if (entries.length === 0) return <span className="text-muted">—</span>
  return (
    <div className="flex flex-col gap-1.5">
      {entries.map(([field, c]) => (
        <div key={field} className="text-sm">
          <span className="font-medium">{field}</span>
          <span className="text-muted">:</span>{' '}
          {'from' in c && <span className="text-muted line-through">{fmtVal(c.from)}</span>}
          {'from' in c && 'to' in c && <span className="text-muted"> → </span>}
          {'to' in c && <span>{fmtVal(c.to)}</span>}
        </div>
      ))}
    </div>
  )
}

// 模块级稳定引用:内联对象会让 SynieDataGrid 的列 memo 每次渲染失效
const GRID_OVERRIDES: Record<string, ColumnOverride> = {
  actionType: { render: actionLabel },
  changes: { render: changesSummary },
}

function LogsPage() {
  const [row, setRow] = useState<Row | null>(null)

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">操作日志</h1>
      <p className="mt-2 text-sm text-ink-500">系统数据变更的审计记录,只读。</p>

      <div className="mt-6">
        {/* 审计日志只读:不传 onCreate/onEdit 即无新增/编辑入口 */}
        <SynieDataGrid
          resource="sysAuditLogs"
          exclude={EXCLUDE}
          overrides={GRID_OVERRIDES}
          onView={setRow}
        />
      </div>

      <SynieRecordDrawer
        resource="sysAuditLogs"
        label="操作日志"
        mode="view"
        isOpen={row !== null}
        onOpenChange={(open) => !open && setRow(null)}
        row={row}
        exclude={EXCLUDE}
        fields={{
          actionType: { render: actionLabel, cols: 6 },
          actionName: { cols: 6 },
          changes: { render: (v) => <ChangesDetail value={v} /> },
        }}
      />
    </>
  )
}
