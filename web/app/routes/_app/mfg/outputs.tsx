import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { useDocItems } from '~/components/synie-editable-table/use-doc-items'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/registry'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'
import { auditMaterialCell, useAuditDoc, type AuditDocConfig } from '../scm/-audit-doc'

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

// 入库行脚手架(取数/持久化)走共用 useDocItems;变量名统一 $docId
const ITEMS = {
  label: '入库行',
  docIdField: 'outputId',
  fetchQuery: `
    query ($docId: ID!) {
      mfgOutputItems(filter: {outputId: {eq: $docId}}, sort: [{field: IDX, order: ASC}], limit: 200, offset: 0) {
        results {
          id idx workOrderId unitId qty warehouseId remarks
          workOrder { id workOrderNo materialCode materialName }
          unit { id name } warehouse { id name }
        }
      }
    }
  `,
  fetchKey: 'mfgOutputItems',
  createMutation: `
    mutation ($input: CreateMfgOutputItemInput!) {
      createMfgOutputItem(input: $input) { result { id } errors { message } }
    }
  `,
  createKey: 'createMfgOutputItem',
  updateMutation: `
    mutation ($id: ID!, $input: UpdateMfgOutputItemInput!) {
      updateMfgOutputItem(id: $id, input: $input) { result { id } errors { message } }
    }
  `,
  updateKey: 'updateMfgOutputItem',
  destroyMutation: `
    mutation ($id: ID!) {
      destroyMfgOutputItem(id: $id) { errors { message } }
    }
  `,
  destroyKey: 'destroyMfgOutputItem',
  itemInput: (row: Row) => ({
    idx: row.idx,
    workOrderId: row.workOrderId,
    unitId: row.unitId,
    qty: row.qty,
    warehouseId: row.warehouseId,
    remarks: row.remarks ?? null,
  }),
  itemKeys: ['idx', 'workOrderId', 'unitId', 'qty', 'warehouseId', 'remarks'] as const,
}

const GRID_COLUMNS = ['outputNo', 'outputDate', 'companyId', 'warehouseId', 'status', 'remarks']

// 「审核整单」确认弹窗配置(同 scm 单据先例:只取行快照字段,不 join 工单/单位等 fk)
const OUTPUT_AUDIT_CONFIG = {
  docLabel: '生产入库单',
  mutation: 'auditMfgOutput',
  itemsResource: 'mfgOutputItems',
  docIdField: 'outputId',
  itemFields: 'id idx materialCode materialName materialSpec unitName qty baseQty remarks',
  columns: [
    { key: 'materialName', label: '物料', render: auditMaterialCell() },
    { key: 'unitName', label: '单位' },
    { key: 'qty', label: '入库数量', align: 'end' },
    { key: 'baseQty', label: '折算数量', align: 'end' },
    { key: 'remarks', label: '行备注' },
  ],
} satisfies AuditDocConfig

function OutputsPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const { items, setItems, itemsLoaded, load, persistItems } = useDocItems(ITEMS)
  const queryClient = useQueryClient()
  const { requestAudit, auditDialog } = useAuditDoc(OUTPUT_AUDIT_CONFIG)

  const openDrawer = (mode: DrawerMode, row: Row | null) => {
    setDrawer({ mode, row })
    load(mode === 'create' || !row ? null : String(row.id))
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
          // 审核改走「列出全部条目核对」的确认弹窗(同 scm 单据页先例)
          actionHandlers={{ audit: (rows, ctx) => requestAudit(String(rows[0].id), ctx.refetch) }}
        />
      </div>
      {auditDialog}

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
          // 返回值供抽屉「保存并审核」取 id 调审核 mutation(通用约定)
          let savedId: string
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
            const lineErrors = await persistItems(id)
            if (lineErrors.length) throw new Error(lineErrors.join('; '))
            toast.success('生产入库单已创建')
            savedId = id
          } else {
            const data = await gqlFetch<{
              updateMfgOutput: { errors: { message: string }[] | null }
            }>(UPDATE_OUTPUT, { id: drawer!.row!.id, input: values })
            if (data.updateMfgOutput.errors?.length) {
              throw new Error(data.updateMfgOutput.errors.map((e) => e.message).join('; '))
            }
            if (draftOnly) {
              const lineErrors = await persistItems(drawer!.row!.id as string)
              if (lineErrors.length) throw new Error(lineErrors.join('; '))
            }
            toast.success('生产入库单已更新')
            savedId = drawer!.row!.id as string
          }
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'mfgOutputs'] })
          return savedId
        }}
      />
    </>
  )
}
