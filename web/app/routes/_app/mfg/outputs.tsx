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

export const Route = createFileRoute('/_app/mfg/outputs')({
  component: OutputsPage,
})

const CREATE_OUTPUT = `
  mutation ($input: CreateMfgOutputInput!) {
    createMfgOutput(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_OUTPUT = `
  mutation ($id: ID!, $input: UpdateMfgOutputInput!) {
    updateMfgOutput(id: $id, input: $input) { result { id } errors { message } }
  }
`
const FETCH_ITEMS = `
  query ($outputId: ID!) {
    mfgOutputItems(filter: {outputId: {eq: $outputId}}, sort: [{field: IDX, order: ASC}], limit: 200, offset: 0) {
      results {
        id idx workOrderId unitId qty warehouseId remarks
        workOrder { id workOrderNo materialCode materialName }
        unit { id name } warehouse { id name }
      }
    }
  }
`
const CREATE_ITEM = `
  mutation ($input: CreateMfgOutputItemInput!) {
    createMfgOutputItem(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_ITEM = `
  mutation ($id: ID!, $input: UpdateMfgOutputItemInput!) {
    updateMfgOutputItem(id: $id, input: $input) { result { id } errors { message } }
  }
`
const DESTROY_ITEM = `
  mutation ($id: ID!) {
    destroyMfgOutputItem(id: $id) { errors { message } }
  }
`

function itemInput(row: Row) {
  return {
    idx: row.idx,
    workOrderId: row.workOrderId,
    unitId: row.unitId,
    qty: row.qty,
    warehouseId: row.warehouseId,
    remarks: row.remarks ?? null,
  }
}

const ITEM_KEYS = ['idx', 'workOrderId', 'unitId', 'qty', 'warehouseId', 'remarks'] as const

function itemChanged(before: Row, after: Row): boolean {
  return ITEM_KEYS.some((k) => String(before[k] ?? '') !== String(after[k] ?? ''))
}

async function persistItems(outputId: string, current: Row[], snapshot: Row[]): Promise<string[]> {
  const errors: string[] = []
  const collect = (label: unknown, msgs: { message: string }[] | null | undefined) => {
    if (msgs?.length) errors.push(...msgs.map((e) => `${label}:${e.message}`))
  }
  const currentIds = new Set(current.filter((r) => !isLocalRow(r)).map((r) => r.id))

  for (const old of snapshot) {
    if (currentIds.has(old.id)) continue
    const data = await gqlFetch<{ destroyMfgOutputItem: { errors: { message: string }[] | null } }>(
      DESTROY_ITEM,
      { id: old.id },
    )
    collect(old.idx ?? '行', data.destroyMfgOutputItem.errors)
  }

  for (const row of current) {
    if (isLocalRow(row)) {
      const data = await gqlFetch<{
        createMfgOutputItem: { errors: { message: string }[] | null }
      }>(CREATE_ITEM, { input: { outputId, ...itemInput(row) } })
      collect(row.idx ?? '行', data.createMfgOutputItem.errors)
      continue
    }
    const old = snapshot.find((s) => s.id === row.id)
    if (old && itemChanged(old, row)) {
      const data = await gqlFetch<{
        updateMfgOutputItem: { errors: { message: string }[] | null }
      }>(UPDATE_ITEM, { id: row.id, input: itemInput(row) })
      collect(row.idx ?? '行', data.updateMfgOutputItem.errors)
    }
  }
  return errors
}

const GRID_COLUMNS = ['outputNo', 'outputDate', 'companyId', 'warehouseId', 'status', 'remarks']

function OutputsPage() {
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
    gqlFetch<{ mfgOutputItems: { results: Row[] } }>(FETCH_ITEMS, { outputId: row.id })
      .then((d) => {
        if (my !== reqIdRef.current) return
        setItems(d.mfgOutputItems.results)
        setItemsSnapshot(d.mfgOutputItems.results)
        setItemsLoaded(true)
      })
      .catch((e) => {
        if (my !== reqIdRef.current) return
        toast.danger('入库行加载失败', { description: (e as Error).message })
        setItems([])
        setItemsSnapshot([])
      })
  }

  const draftOnly = !drawer?.row || drawer.row.status === 'DRAFT'

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">生产入库</h1>
      <p className="mt-2 text-sm text-ink-500">
        对生产工单成品入账：行挂工单、可分次；审核写库存分录并累加工单已入，满量后工单完工。
      </p>

      <div className="mt-6">
        <SynieDataGrid
          resource="mfgOutputs"
          columns={GRID_COLUMNS}
          onView={(row) => openDrawer('view', row)}
          onCreate={() => openDrawer('create', null)}
          onEdit={(row) => openDrawer('edit', row)}
        />
      </div>

      <SynieRecordDrawer
        resource="mfgOutputs"
        {...drawerConfig('mfgOutputs')}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        rowId={drawer?.row?.id}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        tabExtraContent={{
          items: (mode) => (
            <SynieEditableTable
              resource="mfgOutputItems"
              label="入库行"
              items={items}
              onChange={setItems}
              readOnly={mode === 'view' || !draftOnly || (mode !== 'create' && !itemsLoaded)}
              exclude={[
                'outputId',
                'companyId',
                'materialId',
                'baseQty',
                'materialCode',
                'materialName',
                'materialSpec',
                'unitName',
              ]}
              columns={['idx', 'workOrderId', 'unitId', 'qty', 'warehouseId', 'remarks']}
              fields={{
                idx: { order: 0, required: true },
                workOrderId: { order: 1, required: true, label: '生产工单' },
                unitId: { order: 2, required: true },
                qty: { order: 3, required: true },
                warehouseId: { order: 4, required: true },
                remarks: { order: 5 },
              }}
            />
          ),
        }}
        onSubmit={async (values, mode) => {
          if (mode === 'create') {
            const data = await gqlFetch<{
              createMfgOutput: {
                result: { id: string } | null
                errors: { message: string }[] | null
              }
            }>(CREATE_OUTPUT, { input: values })
            if (data.createMfgOutput.errors?.length) {
              throw new Error(data.createMfgOutput.errors.map((e) => e.message).join('; '))
            }
            const id = data.createMfgOutput.result!.id
            const lineErrors = await persistItems(id, items, [])
            if (lineErrors.length) throw new Error(lineErrors.join('; '))
            toast.success('生产入库单已创建')
          } else {
            const data = await gqlFetch<{
              updateMfgOutput: { errors: { message: string }[] | null }
            }>(UPDATE_OUTPUT, { id: drawer!.row!.id, input: values })
            if (data.updateMfgOutput.errors?.length) {
              throw new Error(data.updateMfgOutput.errors.map((e) => e.message).join('; '))
            }
            if (draftOnly) {
              const lineErrors = await persistItems(drawer!.row!.id as string, items, itemsSnapshot)
              if (lineErrors.length) throw new Error(lineErrors.join('; '))
            }
            toast.success('生产入库单已更新')
          }
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'mfgOutputs'] })
        }}
      />
    </>
  )
}
