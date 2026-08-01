import { useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { isLocalRow } from '~/components/synie-editable-table/editable'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/extension-drawer-props'
import {
  aggregateDraftFor,
  resourceBindingFor,
} from '~/lib/resources/registry'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

const processTemplateDraft = aggregateDraftFor('mfgProcessTemplates')

export const Route = createFileRoute('/_app/mfg/process-templates')({
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

function draftItems(rows: Row[]) {
  return rows.map((row) => ({
    ...(isLocalRow(row) ? {} : { id: row.id }),
    ...itemInput(row),
  }))
}

// 列白名单:时间戳不进表格
const GRID_COLUMNS = ['code', 'name', 'note']

function ProcessTemplatesPage() {
  const [drawer, setDrawer] = useState<{
    mode: DrawerMode
    row: Row | null
  } | null>(null)
  const [items, setItems] = useState<Row[]>([])
  // edit/view 态工艺步骤靠 FETCH_ITEMS 异步拉取,未完成前禁止编辑,防回填覆盖在输行
  const [itemsLoaded, setItemsLoaded] = useState(false)
  const queryClient = useQueryClient()
  // 请求守卫:防止慢响应把上一个模板的步骤行回填到当前模板(同物料先例)
  const reqIdRef = useRef(0)

  // 打开抽屉:create 清空步骤行;view/edit 按模板 id 拉行(快照留作提交时 diff 基准)
  const openDrawer = (mode: DrawerMode, row: Row | null) => {
    const my = ++reqIdRef.current
    setDrawer({ mode, row })
    if (mode === 'create' || !row) {
      setItems([])
      setItemsLoaded(true)
      return
    }
    setItemsLoaded(false)
    processTemplateDraft
      .loadDraft(row.id)
      .then((d) => {
        if (my !== reqIdRef.current) return
        setItems(((d as Row).items as Row[] | undefined) ?? [])
        setItemsLoaded(true)
      })
      .catch((e) => {
        if (my !== reqIdRef.current) return
        toast.danger('工艺步骤加载失败', { description: (e as Error).message })
        setItems([])
      })
  }

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">工艺模板</h1>
      <p className="mt-2 text-sm text-ink-500">
        全局共享的工艺路线模板:建 BOM 工艺路线时选模板复制带入为 BOM
        私行,此后模板再改不影响已建 BOM。
      </p>

      <div className="mt-6">
        <SynieDataGrid
          resource="mfgProcessTemplates"
          columns={GRID_COLUMNS}
          onView={(row) => openDrawer('view', row)}
          onCreate={() => openDrawer('create', null)}
          onEdit={(row) => openDrawer('edit', row)}
        />
      </div>

      <SynieRecordDrawer
        resource="mfgProcessTemplates"
        {...drawerConfig('mfgProcessTemplates')}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        // 表格列是白名单子集,行数据不全;不传 row,走 rowId 自查完整记录
        rowId={drawer?.row?.id}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        tabExtraContent={{
          items: (mode) => (
            <SynieEditableTable
              resource="mfgProcessTemplateItems"
              label="工艺步骤"
              items={items}
              onChange={setItems}
              readOnly={mode === 'view' || (mode !== 'create' && !itemsLoaded)}
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
          const input = { ...values, items: draftItems(items) }
          if (mode === 'create') {
            const created = await processTemplateDraft.createDraft(input) as Row
            toast.success('工艺模板已创建')
            await resourceBindingFor('mfgProcessTemplates').cache.invalidateAll(queryClient)
            return created.id
          } else {
            const templateId = drawer!.row!.id
            await processTemplateDraft.replaceDraft(templateId, input)
            toast.success('工艺模板已更新')
            await resourceBindingFor('mfgProcessTemplates').cache.invalidateAll(queryClient)
            return templateId
          }
        }}
      />
    </>
  )
}
