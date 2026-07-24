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

export const Route = createFileRoute('/_app/mfg/demands')({
  component: DemandsPage,
})

const CREATE_DEMAND = `
  mutation ($input: CreateMfgDemandInput!) {
    createMfgDemand(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_DEMAND = `
  mutation ($id: ID!, $input: UpdateMfgDemandInput!) {
    updateMfgDemand(id: $id, input: $input) { result { id } errors { message } }
  }
`
const FETCH_ITEMS = `
  query ($demandId: ID!) {
    mfgDemandItems(filter: {demandId: {eq: $demandId}}, sort: [{field: IDX, order: ASC}], limit: 200, offset: 0) {
      results {
        id idx materialId unitId qty needDate fulfillmentMethod salesOrderItemId remarks status
        material { id code name } unit { id name }
      }
    }
  }
`
const CREATE_ITEM = `
  mutation ($input: CreateMfgDemandItemInput!) {
    createMfgDemandItem(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_ITEM = `
  mutation ($id: ID!, $input: UpdateMfgDemandItemInput!) {
    updateMfgDemandItem(id: $id, input: $input) { result { id } errors { message } }
  }
`
const DESTROY_ITEM = `
  mutation ($id: ID!) {
    destroyMfgDemandItem(id: $id) { errors { message } }
  }
`

function itemInput(row: Row) {
  return {
    idx: row.idx,
    materialId: row.materialId,
    unitId: row.unitId,
    qty: row.qty,
    needDate: row.needDate ?? null,
    fulfillmentMethod: row.fulfillmentMethod,
    salesOrderItemId: row.salesOrderItemId || null,
    remarks: row.remarks ?? null,
  }
}

const ITEM_KEYS = [
  'idx',
  'materialId',
  'unitId',
  'qty',
  'needDate',
  'fulfillmentMethod',
  'salesOrderItemId',
  'remarks',
] as const

function itemChanged(before: Row, after: Row): boolean {
  return ITEM_KEYS.some((k) => String(before[k] ?? '') !== String(after[k] ?? ''))
}

async function persistItems(demandId: string, current: Row[], snapshot: Row[]): Promise<string[]> {
  const errors: string[] = []
  const collect = (label: unknown, msgs: { message: string }[] | null | undefined) => {
    if (msgs?.length) errors.push(...msgs.map((e) => `${label}:${e.message}`))
  }
  const currentIds = new Set(current.filter((r) => !isLocalRow(r)).map((r) => r.id))

  for (const old of snapshot) {
    if (currentIds.has(old.id)) continue
    const data = await gqlFetch<{ destroyMfgDemandItem: { errors: { message: string }[] | null } }>(
      DESTROY_ITEM,
      { id: old.id },
    )
    collect(old.idx ?? '行', data.destroyMfgDemandItem.errors)
  }

  for (const row of current) {
    if (isLocalRow(row)) {
      const data = await gqlFetch<{
        createMfgDemandItem: { errors: { message: string }[] | null }
      }>(CREATE_ITEM, { input: { demandId, ...itemInput(row) } })
      collect(row.idx ?? '行', data.createMfgDemandItem.errors)
      continue
    }
    const old = snapshot.find((s) => s.id === row.id)
    if (old && itemChanged(old, row)) {
      const data = await gqlFetch<{
        updateMfgDemandItem: { errors: { message: string }[] | null }
      }>(UPDATE_ITEM, { id: row.id, input: itemInput(row) })
      collect(row.idx ?? '行', data.updateMfgDemandItem.errors)
    }
  }
  return errors
}

const GRID_COLUMNS = ['demandNo', 'demandDate', 'companyId', 'status', 'remarks']

function DemandsPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const [items, setItems] = useState<Row[]>([])
  const [itemsSnapshot, setItemsSnapshot] = useState<Row[]>([])
  const [itemsLoaded, setItemsLoaded] = useState(false)
  const queryClient = useQueryClient()
  const reqIdRef = useRef(0)

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
    gqlFetch<{ mfgDemandItems: { results: Row[] } }>(FETCH_ITEMS, { demandId: row.id })
      .then((d) => {
        if (my !== reqIdRef.current) return
        setItems(d.mfgDemandItems.results)
        setItemsSnapshot(d.mfgDemandItems.results)
        setItemsLoaded(true)
      })
      .catch((e) => {
        if (my !== reqIdRef.current) return
        toast.danger('需求行加载失败', { description: (e as Error).message })
        setItems([])
        setItemsSnapshot([])
      })
  }

  const draftOnly = !drawer?.row || drawer.row.status === 'DRAFT'

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">需求单</h1>
      <p className="mt-2 text-sm text-ink-500">
        履约需求单：计划从销售勾选或手工建独立需求；确认后锁口径，自制派生工单，外购/委外/库存可点完成。
      </p>

      <div className="mt-6">
        <SynieDataGrid
          resource="mfgDemands"
          columns={GRID_COLUMNS}
          onView={(row) => openDrawer('view', row)}
          onCreate={() => openDrawer('create', null)}
          onEdit={(row) => openDrawer('edit', row)}
        />
      </div>

      <SynieRecordDrawer
        resource="mfgDemands"
        {...drawerConfig('mfgDemands')}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        rowId={drawer?.row?.id}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        tabExtraContent={{
          items: (mode) => (
            <SynieEditableTable
              resource="mfgDemandItems"
              label="需求行"
              items={items}
              onChange={setItems}
              readOnly={mode === 'view' || !draftOnly || (mode !== 'create' && !itemsLoaded)}
              exclude={['demandId', 'companyId', 'baseQty', 'status', 'materialCode', 'materialName', 'materialSpec', 'unitName']}
              columns={[
                'idx',
                'materialId',
                'unitId',
                'qty',
                'needDate',
                'fulfillmentMethod',
                'salesOrderItemId',
                'remarks',
              ]}
              fields={{
                idx: { order: 0, required: true },
                materialId: { order: 1, required: true, picker: 'dialog' },
                unitId: { order: 2, required: true },
                qty: { order: 3, required: true },
                needDate: { order: 4 },
                fulfillmentMethod: { order: 5, required: true, defaultValue: 'MAKE' },
                salesOrderItemId: { order: 6, label: '来源销售条目' },
                remarks: { order: 7 },
              }}
            />
          ),
        }}
        onSubmit={async (values, mode) => {
          if (mode === 'create') {
            const data = await gqlFetch<{
              createMfgDemand: {
                result: { id: string } | null
                errors: { message: string }[] | null
              }
            }>(CREATE_DEMAND, { input: values })
            if (data.createMfgDemand.errors?.length) {
              throw new Error(data.createMfgDemand.errors.map((e) => e.message).join('; '))
            }
            const id = data.createMfgDemand.result!.id
            const lineErrors = await persistItems(id, items, [])
            if (lineErrors.length) throw new Error(lineErrors.join('; '))
            toast.success('需求单已创建')
          } else {
            const data = await gqlFetch<{
              updateMfgDemand: { errors: { message: string }[] | null }
            }>(UPDATE_DEMAND, { id: drawer!.row!.id, input: values })
            if (data.updateMfgDemand.errors?.length) {
              throw new Error(data.updateMfgDemand.errors.map((e) => e.message).join('; '))
            }
            if (draftOnly) {
              const lineErrors = await persistItems(drawer!.row!.id as string, items, itemsSnapshot)
              if (lineErrors.length) throw new Error(lineErrors.join('; '))
            }
            toast.success('需求单已更新')
          }
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'mfgDemands'] })
          queryClient.invalidateQueries({ queryKey: ['rowById', 'mfgDemands'] })
        }}
      />
    </>
  )
}
