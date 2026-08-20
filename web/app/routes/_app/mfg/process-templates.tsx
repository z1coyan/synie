import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/extension-drawer-props'
import {
  processTemplateClient,
  processTemplateItemClient,
} from '~/lib/resources/manufacturing'
import { resourceLabel } from '~/lib/resources/catalog'
import type { Row } from '~/components/synie-data-grid/types'
import { persistChildRows } from '~/lib/resources/persist-child-rows'
import { resourceBindingFor } from '~/lib/resources/registry'
import { toastError } from '~/lib/toast'
import { ensureDefaultGridPage } from '~/lib/route-prefetch'
import { useDocumentDrawer } from '~/lib/use-document-drawer'

const RESOURCE = 'mfgProcessTemplates'

export const Route = createFileRoute('/_app/mfg/process-templates')({
  loader: ({ context: { queryClient } }) =>
    ensureDefaultGridPage(queryClient, RESOURCE),
  component: ProcessTemplatesPage,
})

// mutation input 只收行自身字段,行上挂的 operation join 对象不进 payload
function itemInput(row: Row) {
  return {
    operationId: row.operationId,
    seq: row.seq,
    requirement: row.requirement ?? null,
    isOutsourced: row.isOutsourced,
  }
}

/** 工艺步骤差异持久化:本地草稿行 create;存量行有变 update;快照有、当前无 destroy(同物料单位转换先例) */
async function persistItems(
  templateId: string,
  current: Row[],
  snapshot: Row[],
): Promise<string[]> {
  return persistChildRows({
    current,
    snapshot,
    client: processTemplateItemClient,
    parentIdField: 'templateId',
    parentId: templateId,
    compareKeys: ['operationId', 'seq', 'requirement', 'isOutsourced'],
    inputOf: itemInput,
    rowLabel: (row) =>
      String((row.operation as Row | undefined)?.name ?? '工艺步骤'),
  })
}

// 列白名单:时间戳不进表格
const GRID_COLUMNS = ['code', 'name', 'note']

function ProcessTemplatesPage() {
  // 单据抽屉骨架:URL 双态 + 工艺步骤装载竞态协议
  const drawer = useDocumentDrawer<Row[]>({
    resource: RESOURCE,
    urlSync: true,
    loadErrorLabel: '工艺步骤加载失败',
    loadDraft: (templateId) =>
      processTemplateItemClient
        .query({
          limit: 200,
          offset: 0,
          filter: {
            templateId: {
              kind: 'fk',
              op: 'in',
              values: [templateId],
              labels: [],
            },
          },
          sort: { column: 'seq', direction: 'ascending' },
        })
        .then((d) => d.results ?? []),
  })
  const [items, setItems] = useState<Row[]>([])
  const [itemsSnapshot, setItemsSnapshot] = useState<Row[]>([])
  const queryClient = useQueryClient()

  // 草稿 → 工艺步骤状态派生
  useEffect(() => {
    const rows = drawer.draft ?? []
    setItems(rows)
    setItemsSnapshot(rows)
  }, [drawer.draft, drawer.generation])

  return (
    <>
      <h1 className="font-brand text-xl">工艺模板</h1>
      <p className="mt-1 text-xs text-ink-500">
        全局共享的工艺路线模板:建 BOM 工艺路线时选模板复制带入为 BOM
        私行,此后模板再改不影响已建 BOM。
      </p>

      <div className="mt-6">
        <SynieDataGrid
          resource={RESOURCE}
          columns={GRID_COLUMNS}
          onView={(row) => drawer.open('view', row)}
          onCreate={() => drawer.open('create', null)}
          onEdit={(row) => drawer.open('edit', row)}
        />
      </div>

      <SynieRecordDrawer
        resource={RESOURCE}
        {...drawerConfig(RESOURCE)}
        mode={drawer.mode}
        isOpen={drawer.isOpen}
        onOpenChange={(isOpen) => {
          if (!isOpen) drawer.close()
        }}
        // 表格列是白名单子集,行数据不全;不传 row,走 rowId 自查完整记录
        rowId={drawer.rowId}
        onEdit={() => drawer.setMode('edit')}
        tabExtraContent={{
          items: (mode) => (
            <SynieEditableTable
              resource="mfgProcessTemplateItems"
              label="工艺步骤"
              items={items}
              onChange={setItems}
              readOnly={mode === 'view' || (mode !== 'create' && !drawer.detailLoaded)}
              exclude={['templateId']}
              columns={['seq', 'operationId', 'requirement', 'isOutsourced']}
              fields={{
                operationId: { order: 0, required: true },
                seq: {
                  order: 1,
                  required: true,
                  placeholder: '工序顺序,如 10',
                },
                requirement: { order: 2 },
                isOutsourced: { order: 3, label: '外协', defaultValue: false },
              }}
              validateItem={(vals) => {
                if (!vals.operationId) return '请选择工序'
                if (!(
                  Number.isInteger(Number(vals.seq)) && Number(vals.seq) > 0
                ))
                  return '序号必须为正整数'
              }}
            />
          ),
        }}
        onSubmit={async (values, mode) => {
          if (mode === 'create') {
            const created = await processTemplateClient.create(values)
            const templateId = created.id
            const itemErrors = await persistItems(templateId, items, [])
            if (itemErrors.length > 0) {
              toast.danger('工艺模板已创建,但部分工艺步骤保存失败', {
                description: itemErrors.join('; '),
              })
            } else {
              toast.success(`${resourceLabel('mfgProcessTemplates')}已创建`)
            }
          } else {
            const templateId = String(drawer.rowId)
            await processTemplateClient.update(templateId, values)
            const itemErrors = await persistItems(
              templateId,
              items,
              itemsSnapshot,
            )
            if (itemErrors.length > 0) {
              toast.danger('工艺模板已更新,但部分工艺步骤保存失败', {
                description: itemErrors.join('; '),
              })
            } else {
              toast.success(`${resourceLabel('mfgProcessTemplates')}已更新`)
            }
          }
          // 抽屉走 rowId 自查,一并失效行缓存,重开详情不吃 30s staleTime 的旧行
          await resourceBindingFor(RESOURCE).cache.invalidateAll(queryClient)
        }}
      />
    </>
  )
}
