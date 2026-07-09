import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { CodeBlock } from '@heroui-pro/react'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/system/logs')({
  component: LogsPage,
})

const ACTION_LABELS: Record<string, string> = { create: '创建', update: '更新', destroy: '删除' }

// 值为 Track 落库的 GraphQL type 名;新资源接审计后在此补中文,漏了则原样显示英文
const RESOURCE_LABELS: Record<string, string> = {
  sys_role: '角色',
  sys_user: '用户',
  sys_user_role: '用户角色',
  sys_role_permission: '角色权限',
  sys_user_company: '用户公司授权',
  bas_company: '公司',
  bas_currency: '货币',
  bas_unit: '计量单位',
  bas_account: '会计科目',
}

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

const actionLabel = (value: unknown) => ACTION_LABELS[String(value)] ?? String(value)
const resourceLabel = (value: unknown) => RESOURCE_LABELS[String(value)] ?? String(value)

function changesSummary(value: unknown) {
  const changes = parseChanges(value)
  const count = changes ? Object.keys(changes).length : 0
  return count > 0 ? `${count} 项变更` : <span className="text-muted">—</span>
}

/** 抽屉详情:变更 JSON 代码块(带复制) */
function ChangesJson({ value }: { value: unknown }) {
  const changes = parseChanges(value)
  if (!changes || Object.keys(changes).length === 0) return <span className="text-muted">—</span>
  const code = JSON.stringify(changes, null, 2)
  return (
    <CodeBlock>
      <CodeBlock.Header>
        <span className="text-muted text-xs uppercase">json</span>
        <CodeBlock.CopyButton code={code} />
      </CodeBlock.Header>
      <CodeBlock.Code code={code} language="json" />
    </CodeBlock>
  )
}

// 模块级稳定引用:内联对象会让 SynieDataGrid 的列 memo 每次渲染失效
const GRID_OVERRIDES: Record<string, ColumnOverride> = {
  resource: { render: resourceLabel },
  actionType: { render: actionLabel },
  actionName: { render: actionLabel },
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
          resource: { render: resourceLabel },
          actionType: { render: actionLabel, cols: 6 },
          actionName: { render: actionLabel, cols: 6 },
          changes: { render: (v) => <ChangesJson value={v} /> },
        }}
      />
    </>
  )
}
