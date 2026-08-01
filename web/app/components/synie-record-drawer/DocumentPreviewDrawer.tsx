import { useQueries } from '@tanstack/react-query'
import { Chip, Spinner } from '@heroui/react'
import { EmptyState } from '@heroui-pro/react'
import type { ResourceBinding } from '~/lib/resources/catalog'
import { readResourceRowsBounded } from '~/lib/resources/bounded-reader'
import { resourceBindingFor } from '~/lib/resources/registry'
import { useGridMeta } from '../synie-data-grid/meta'
import type { Row } from '../synie-data-grid/types'
import { cellText } from '../synie-data-grid/format'
import { SynieEditableTable } from '../synie-editable-table/SynieEditableTable'
import {
  getDocumentPreview,
  type DocumentPreviewConfig,
  type DocumentPreviewLineTable,
} from './document-preview'
import { SynieRecordDrawer } from './SynieRecordDrawer'

export interface DocumentPreviewDrawerProps {
  resource: string
  id: string
  isOpen: boolean
  onOpenChange: (open: boolean) => void
}

export type DocumentPreviewBindingResolver = (
  resource: string,
) => Pick<ResourceBinding, 'reader' | 'cache'>

const DEFAULT_DOCUMENT_PREVIEW_LIMIT = 200

/**
 * Preview 子表查询的唯一 runtime seam：Reader、query key 与失效 scope 来自同一 binding。
 * resolver 参数让测试或嵌入方可替换为 memory binding，而不改 Presentation 配置。
 */
export function documentPreviewLineQuery(
  table: DocumentPreviewLineTable,
  documentResource: string,
  documentId: string,
  resolveBinding: DocumentPreviewBindingResolver = resourceBindingFor,
) {
  const binding = resolveBinding(table.resource)
  return {
    queryKey: binding.cache.gridKey(
      'documentPreview',
      documentResource,
      documentId,
    ),
    queryFn: async (): Promise<{ results: Row[] }> => {
      if (table.load) {
        return {
          results: await table.load(
            documentId,
            (resource) => resolveBinding(resource).reader,
          ),
        }
      }
      const limit = table.limit ?? DEFAULT_DOCUMENT_PREVIEW_LIMIT
      return {
        results: await readResourceRowsBounded(
          binding.reader,
          {
            profile: 'default',
            sort: {
              column: table.sortColumn ?? 'idx',
              direction: 'ascending',
            },
            fixedFilter: {
              [table.parentIdField]: {
                kind: 'fk',
                op: 'in',
                values: [documentId],
                labels: [],
              },
            },
          },
          limit,
        ),
      }
    },
  }
}

/**
 * 已登记资源的单据只读速览：标题区单号+状态、业务抽屉对齐头字段、库存相关子表只读。
 * 无编辑/审核；头 get 与子表 query 走各资源 ResourceBinding（权限 fail-closed）。
 */
export function DocumentPreviewDrawer({
  resource,
  id,
  isOpen,
  onOpenChange,
}: DocumentPreviewDrawerProps) {
  const config = getDocumentPreview(resource)
  if (!config) {
    throw new Error(`资源「${resource}」未登记单据只读速览`)
  }

  const meta = useGridMeta(resource, isOpen)
  const statusField = config.statusField ?? 'status'
  const statusCol = meta.data?.columns.find((c) => c.name === statusField)

  const lineQueries = useQueries({
    queries: config.lineTables.map((table) => ({
      ...documentPreviewLineQuery(table, resource, id),
      enabled: isOpen && !!id,
      staleTime: 30_000,
    })),
  })

  const linesPending = lineQueries.some((q) => q.isPending)
  const linesError = lineQueries.find((q) => q.isError)

  return (
    <SynieRecordDrawer
      resource={resource}
      mode="view"
      rowId={id}
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      label={config.label}
      exclude={config.head.exclude}
      fields={config.head.fields}
      contentClassName={config.head.contentClassName ?? 'w-full lg:w-[880px]'}
      headerContent={(_mode, row) => {
        if (!row) return null
        const docNo =
          row[config.docNoField] != null && row[config.docNoField] !== ''
            ? String(row[config.docNoField])
            : null
        const statusRaw = row[statusField]
        const statusLabel =
          statusRaw == null || statusRaw === ''
            ? null
            : statusCol
              ? cellText(statusCol, statusRaw, row) || String(statusRaw)
              : String(statusRaw)
        if (!docNo && !statusLabel) return null
        return (
          <div className="flex flex-wrap items-center gap-2">
            {docNo != null ? (
              <span className="font-medium tabular-nums tracking-wide">
                {docNo}
              </span>
            ) : (
              <span className="text-muted">无单号</span>
            )}
            {statusLabel != null ? (
              <Chip
                size="sm"
                variant="soft"
                color={statusChipColor(String(statusRaw ?? ''))}
              >
                {statusLabel}
              </Chip>
            ) : null}
          </div>
        )
      }}
      extraContent={() => (
        <PreviewLineTables
          config={config}
          lineQueries={lineQueries}
          linesPending={linesPending}
          linesError={linesError}
        />
      )}
    />
  )
}

function PreviewLineTables({
  config,
  lineQueries,
  linesPending,
  linesError,
}: {
  config: DocumentPreviewConfig
  lineQueries: {
    data?: { results: Row[] }
    isPending: boolean
    isError: boolean
    error: unknown
  }[]
  linesPending: boolean
  linesError: { error: unknown } | undefined
}) {
  if (linesError) {
    return (
      <EmptyState size="sm" className="py-8">
        <EmptyState.Header>
          <EmptyState.Title>子表加载失败</EmptyState.Title>
          <EmptyState.Description>
            {(linesError.error as Error).message}
          </EmptyState.Description>
        </EmptyState.Header>
      </EmptyState>
    )
  }
  if (linesPending) {
    return (
      <div className="flex h-24 items-center justify-center">
        <Spinner />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-8">
      {config.lineTables.map((table, i) => {
        const items = lineQueries[i]?.data?.results ?? []
        return (
          <SynieEditableTable
            key={table.resource}
            resource={table.resource}
            label={table.title}
            title={table.title}
            items={items}
            onChange={() => {
              /* 只读速览：不接受编辑 */
            }}
            readOnly
            columns={table.columns}
            exclude={table.exclude}
            overrides={table.overrides}
          />
        )
      })}
    </div>
  )
}

function statusChipColor(
  status: string,
): 'default' | 'accent' | 'success' | 'warning' | 'danger' {
  const s = status.toUpperCase()
  if (s === 'DRAFT') return 'default'
  if (s === 'AUDITED' || s === 'RECEIVED' || s === 'CLOSED' || s === 'POSTED')
    return 'success'
  if (s === 'SHIPPED' || s === 'CONFIRMED') return 'accent'
  if (s === 'VOID' || s === 'CANCELLED' || s === 'VOIDED') return 'danger'
  return 'default'
}
