import { useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { isLocalRow } from '~/components/synie-editable-table/editable'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/registry'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/mfg/process-templates')({
  component: ProcessTemplatesPage,
})

const CREATE_TEMPLATE = `
  mutation ($input: CreateMfgProcessTemplateInput!) {
    createMfgProcessTemplate(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_TEMPLATE = `
  mutation ($id: ID!, $input: UpdateMfgProcessTemplateInput!) {
    updateMfgProcessTemplate(id: $id, input: $input) { result { id } errors { message } }
  }
`
const FETCH_ITEMS = `
  query ($templateId: ID!) {
    mfgProcessTemplateItems(filter: {templateId: {eq: $templateId}}, sort: [{field: SEQ, order: ASC}], limit: 200, offset: 0) {
      results { id operationId seq requirement isOutsourced operation { id code name } }
    }
  }
`
const CREATE_ITEM = `
  mutation ($input: CreateMfgProcessTemplateItemInput!) {
    createMfgProcessTemplateItem(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_ITEM = `
  mutation ($id: ID!, $input: UpdateMfgProcessTemplateItemInput!) {
    updateMfgProcessTemplateItem(id: $id, input: $input) { result { id } errors { message } }
  }
`
const DESTROY_ITEM = `
  mutation ($id: ID!) {
    destroyMfgProcessTemplateItem(id: $id) { errors { message } }
  }
`

// mutation input 只收行自身字段,行上挂的 operation join 对象不进 payload
function itemInput(row: Row) {
  return {
    operationId: row.operationId,
    seq: row.seq,
    requirement: row.requirement ?? null,
    isOutsourced: row.isOutsourced,
  }
}

const ITEM_COMPARE_KEYS = ['operationId', 'seq', 'requirement', 'isOutsourced'] as const

function itemChanged(before: Row, after: Row): boolean {
  return ITEM_COMPARE_KEYS.some((k) => String(before[k] ?? '') !== String(after[k] ?? ''))
}

/** 工艺步骤差异持久化:本地草稿行 create;存量行有变 update;快照有、当前无 destroy(同物料单位转换先例) */
async function persistItems(templateId: string, current: Row[], snapshot: Row[]): Promise<string[]> {
  const errors: string[] = []
  const collect = (label: unknown, msgs: { message: string }[] | null | undefined) => {
    if (msgs?.length) errors.push(...msgs.map((e) => `${label}:${e.message}`))
  }
  const itemLabel = (row: Row) => (row.operation as Row | undefined)?.name ?? '工艺步骤'
  const currentIds = new Set(current.filter((r) => !isLocalRow(r)).map((r) => r.id))

  for (const old of snapshot) {
    if (currentIds.has(old.id)) continue
    const data = await gqlFetch<{ destroyMfgProcessTemplateItem: { errors: { message: string }[] | null } }>(
      DESTROY_ITEM,
      { id: old.id }
    )
    collect(itemLabel(old), data.destroyMfgProcessTemplateItem.errors)
  }

  for (const row of current) {
    if (isLocalRow(row)) {
      const data = await gqlFetch<{ createMfgProcessTemplateItem: { errors: { message: string }[] | null } }>(
        CREATE_ITEM,
        { input: { templateId, ...itemInput(row) } }
      )
      collect(itemLabel(row), data.createMfgProcessTemplateItem.errors)
      continue
    }
    const old = snapshot.find((s) => s.id === row.id)
    if (old && itemChanged(old, row)) {
      const data = await gqlFetch<{ updateMfgProcessTemplateItem: { errors: { message: string }[] | null } }>(
        UPDATE_ITEM,
        { id: row.id, input: itemInput(row) }
      )
      collect(itemLabel(row), data.updateMfgProcessTemplateItem.errors)
    }
  }
  return errors
}

// 列白名单:时间戳不进表格
const GRID_COLUMNS = ['code', 'name', 'note']

function ProcessTemplatesPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const [items, setItems] = useState<Row[]>([])
  const [itemsSnapshot, setItemsSnapshot] = useState<Row[]>([])
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
      setItemsSnapshot([])
      setItemsLoaded(true)
      return
    }
    setItemsLoaded(false)
    gqlFetch<{ mfgProcessTemplateItems: { results: Row[] } }>(FETCH_ITEMS, { templateId: row.id })
      .then((d) => {
        if (my !== reqIdRef.current) return
        setItems(d.mfgProcessTemplateItems.results)
        setItemsSnapshot(d.mfgProcessTemplateItems.results)
        setItemsLoaded(true)
      })
      .catch((e) => {
        if (my !== reqIdRef.current) return
        toast.danger('工艺步骤加载失败', { description: (e as Error).message })
        setItems([])
        setItemsSnapshot([])
      })
  }

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">工艺模板</h1>
      <p className="mt-2 text-sm text-ink-500">
        全局共享的工艺路线模板:建 BOM 工艺路线时选模板复制带入为 BOM 私行,此后模板再改不影响已建 BOM。
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
                seq: { order: 1, required: true, placeholder: '工序顺序,如 10' },
                requirement: { order: 2 },
                isOutsourced: { order: 3, label: '外协', defaultValue: false },
              }}
              validateItem={(vals) => {
                if (!vals.operationId) return '请选择工序'
                if (!(Number.isInteger(Number(vals.seq)) && Number(vals.seq) > 0)) return '序号必须为正整数'
              }}
            />
          ),
        }}
        onSubmit={async (values, mode) => {
          if (mode === 'create') {
            const data = await gqlFetch<{
              createMfgProcessTemplate: { result: { id: string } | null; errors: { message: string }[] | null }
            }>(CREATE_TEMPLATE, { input: values })
            if (data.createMfgProcessTemplate.errors && data.createMfgProcessTemplate.errors.length > 0) {
              throw new Error(data.createMfgProcessTemplate.errors.map((e) => e.message).join('; '))
            }
            const templateId = data.createMfgProcessTemplate.result!.id
            const itemErrors = await persistItems(templateId, items, [])
            if (itemErrors.length > 0) {
              toast.danger('工艺模板已创建,但部分工艺步骤保存失败', { description: itemErrors.join('; ') })
            } else {
              toast.success('工艺模板已创建')
            }
          } else {
            const templateId = drawer!.row!.id
            const data = await gqlFetch<{ updateMfgProcessTemplate: { errors: { message: string }[] | null } }>(
              UPDATE_TEMPLATE,
              { id: templateId, input: values }
            )
            if (data.updateMfgProcessTemplate.errors && data.updateMfgProcessTemplate.errors.length > 0) {
              throw new Error(data.updateMfgProcessTemplate.errors.map((e) => e.message).join('; '))
            }
            const itemErrors = await persistItems(templateId, items, itemsSnapshot)
            if (itemErrors.length > 0) {
              toast.danger('工艺模板已更新,但部分工艺步骤保存失败', { description: itemErrors.join('; ') })
            } else {
              toast.success('工艺模板已更新')
            }
          }
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'mfgProcessTemplates'] })
          // 抽屉走 rowId 自查,一并失效行缓存,重开详情不吃 30s staleTime 的旧行
          queryClient.invalidateQueries({ queryKey: ['rowById', 'mfgProcessTemplates'] })
        }}
      />
    </>
  )
}
