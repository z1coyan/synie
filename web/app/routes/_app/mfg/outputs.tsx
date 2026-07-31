import { useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { useDocItems } from '~/components/synie-editable-table/use-doc-items'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/extension-drawer-props'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'
import {
  auditOutput,
  outputClient,
  outputItemClient,
} from '~/lib/resources/manufacturing'
import {
  auditMaterialCell,
  useAuditDoc,
  type AuditDocConfig,
} from '../scm/-audit-doc'
import { materialCellRender } from '~/components/synie-material-cell/MaterialCell'

export const Route = createFileRoute('/_app/mfg/outputs')({
  component: OutputsPage,
})

// 入库行脚手架(取数/持久化)走共用 useDocItems;变量名统一 $docId
const ITEMS = {
  label: '入库行',
  docIdField: 'outputId',
  client: outputItemClient,
  itemInput: (row: Row) => ({
    idx: row.idx,
    workOrderId: row.workOrderId,
    unitId: row.unitId,
    qty: row.qty,
    warehouseId: row.warehouseId,
    remarks: row.remarks ?? null,
  }),
  itemKeys: [
    'idx',
    'workOrderId',
    'unitId',
    'qty',
    'warehouseId',
    'remarks',
  ] as const,
}

const GRID_COLUMNS = [
  'outputNo',
  'outputDate',
  'companyId',
  'warehouseId',
  'status',
  'remarks',
]

// 卡片:单号标题、日期副标题、状态/仓库摘要
const GRID_OVERRIDES = {
  companyId: { mobileRole: 'hide' },
  outputNo: { mobileRole: 'title' },
  outputDate: { mobileRole: 'subtitle' },
  status: { mobileRole: 'summary' },
  warehouseId: { mobileRole: 'summary' },
} satisfies Record<string, ColumnOverride>

// 「审核整单」确认弹窗配置(同 scm 单据先例:只取行快照字段,不 join 工单/单位等 fk)
const OUTPUT_AUDIT_CONFIG = {
  docLabel: '生产入库单',
  itemsResource: 'mfgOutputItems',
  loadItems: (docId) =>
    outputItemClient
      .query({
        limit: 500,
        offset: 0,
        filter: {
          outputId: {
            kind: 'fk',
            op: 'in',
            values: [docId],
            labels: [],
          },
        },
        sort: { column: 'idx', direction: 'ascending' },
      })
      .then((result) => result.results),
  audit: auditOutput,
  columns: [
    { key: 'materialName', label: '物料', render: auditMaterialCell() },
    { key: 'unitName', label: '单位' },
    { key: 'qty', label: '入库数量', align: 'end' },
    { key: 'baseQty', label: '折算数量', align: 'end' },
    { key: 'remarks', label: '行备注' },
  ],
} satisfies AuditDocConfig

// 条目表格物料列:全站统一富单元格(生产入库行无图纸挂接,缩略图回退物料当前图纸);
// 本地新行物料由所选工单派生、尚无快照,返回 undefined 回落默认渲染(空值显 —)
const outputItemMaterialCell = materialCellRender()
const hasMaterialSnapshot = (row: Row) =>
  (row.materialCode != null && row.materialCode !== '') ||
  (row.materialName != null && row.materialName !== '')

function OutputsPage() {
  const [drawer, setDrawer] = useState<{
    mode: DrawerMode
    row: Row | null
  } | null>(null)
  const { items, setItems, itemsLoaded, load, persistItems } =
    useDocItems(ITEMS)
  const queryClient = useQueryClient()
  const { requestAudit, auditDialog } = useAuditDoc(OUTPUT_AUDIT_CONFIG)
  // 行表单最近一次选中的工单整行:effects 写表单草稿时 collectValues 会剥掉
  // 非字段键(物料快照在 exclude),transformItem 从这里取快照并入本地行,
  // 与服务端建行时从工单复制物料快照同口径
  const pickedWorkOrderRef = useRef<Row | null>(null)

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
          client={outputClient}
          columns={GRID_COLUMNS}
          overrides={GRID_OVERRIDES}
          onView={(row) => openDrawer('view', row)}
          onCreate={() => openDrawer('create', null)}
          onEdit={(row) => openDrawer('edit', row)}
          // 审核改走「列出全部条目核对」的确认弹窗(同 scm 单据页先例)
          actionHandlers={{
            audit: (rows, ctx) => requestAudit(String(rows[0].id), ctx.refetch),
          }}
        />
      </div>
      {auditDialog}

      <SynieRecordDrawer
        resource="mfgOutputs"
        client={outputClient}
        {...drawerConfig('mfgOutputs')}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        rowId={drawer?.row?.id}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        extraContent={(mode) => (
          <SynieEditableTable
            resource="mfgOutputItems"
            client={outputItemClient}
            label="入库行"
            items={items}
            onChange={setItems}
            readOnly={
              mode === 'view' ||
              !draftOnly ||
              (mode !== 'create' && !itemsLoaded)
            }
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
            // materialCode 在 exclude(快照列不进录入表单),此处借 overrides 同名声明合成
            // 纯展示计算列(displayColumns 约定):值由 render 从行快照现算
            columns={[
              'idx',
              'materialCode',
              'workOrderId',
              'unitId',
              'qty',
              'warehouseId',
              'remarks',
            ]}
            fields={{
              // 行号系统自动分配(transformItem),表格照常展示
              idx: { visible: () => false },
              workOrderId: {
                order: 1,
                required: true,
                label: '生产工单',
                // 工单字段多,弹窗表格选择(同工单选需求行先例)
                picker: 'dialog',
                dialog: {
                  dialogTitle: '选择生产工单',
                  dialogClassName: 'max-w-6xl',
                  gridColumns: [
                    'workOrderNo',
                    'companyId',
                    'materialCode',
                    'materialName',
                    'materialSpec',
                    'qty',
                    'unitName',
                    'needDate',
                    'status',
                  ],
                  // 确认选中时带工单单位,供 effects 锁到行单位
                  gridExtraFields: ['unitId'],
                  gridOverrides: {
                    workOrderNo: { mobileRole: 'title' },
                    companyId: { mobileRole: 'hide' },
                    materialCode: { label: '物料编号', mobileRole: 'hide' },
                    materialName: { label: '物料名称', mobileRole: 'subtitle' },
                    materialSpec: { label: '规格', mobileRole: 'hide' },
                    qty: { mobileRole: 'summary' },
                    unitName: { label: '单位', mobileRole: 'hide' },
                    needDate: { mobileRole: 'summary' },
                    status: { mobileRole: 'summary' },
                  },
                  gridDefaultSort: { column: 'needDate', direction: 'ascending' },
                },
                // 单位锁定工单单位:选中/清空工单时同步行单位;
                // 物料快照一并 stash 进草稿供下方只读展示(collectValues 会剥,不进提交)
                effects: (_value, selectedRow) => {
                  pickedWorkOrderRef.current = selectedRow ?? null
                  return {
                    unitId: selectedRow?.unitId ?? null,
                    materialCode: selectedRow?.materialCode ?? '',
                    materialName: selectedRow?.materialName ?? '',
                    materialSpec: selectedRow?.materialSpec ?? '',
                  }
                },
              },
              // 单位不任选:由所选工单带入,控件禁用只读展示(不用 edit:'readOnly',
              // 那会被 collectValues 跳过提交;服务端 unitId 必填)
              unitId: {
                order: 2,
                required: true,
                // 工单物料只读展示:create 态读 effects stash,edit 态回落行上已持久化快照;
                // 未选工单不渲染(同 before 槽约定)
                before: (_mode, row, values) => {
                  const code = (values.materialCode ?? row?.materialCode) as
                    | string
                    | undefined
                  const name = (values.materialName ?? row?.materialName) as
                    | string
                    | undefined
                  const spec = (values.materialSpec ?? row?.materialSpec) as
                    | string
                    | undefined
                  if (!code && !name) return null
                  return (
                    <div className="flex flex-col gap-1">
                      <span className="text-sm text-muted">
                        物料(由生产工单带入)
                      </span>
                      <div className="text-sm">
                        {[code, name, spec].filter(Boolean).join(' · ')}
                      </div>
                    </div>
                  )
                },
                input: ({ value }) => (
                  <RemoteSelect
                    resource="basUnits"
                    label="单位"
                    placeholder="由生产工单带入"
                    value={value == null ? null : String(value)}
                    onChange={() => {}}
                    isDisabled
                  />
                ),
              },
              qty: { order: 3, required: true },
              warehouseId: { order: 4, required: true },
              remarks: { order: 5 },
            }}
            overrides={{
              materialCode: {
                label: '物料',
                render: (v, row) =>
                  hasMaterialSnapshot(row)
                    ? outputItemMaterialCell(v, row)
                    : undefined,
              },
            }}
            transformItem={(values, editing) => {
              // 本次新选(或重选)了工单才把物料快照并入本地行,表格物料列立即可见;
              // 未动选择器时 ref 可能是上一行的旧工单,id 比对不上则不覆盖行原有快照
              const wo = pickedWorkOrderRef.current
              const snapshot =
                wo && wo.id === values.workOrderId
                  ? {
                      materialCode: wo.materialCode ?? '',
                      materialName: wo.materialName ?? '',
                      materialSpec: wo.materialSpec ?? '',
                    }
                  : {}
              return {
                ...values,
                ...snapshot,
                // 行号自动:存量行保号,新行取当前最大 idx+1(而非 length+1,避免删行后撞号)
                idx: editing
                  ? editing.idx
                  : items.reduce(
                      (max, r) => Math.max(max, Number(r.idx) || 0),
                      0,
                    ) + 1,
              }
            }}
          />
        )}
        onSubmit={async (values, mode) => {
          // 返回值供抽屉「保存并审核」取 id 调审核 mutation(通用约定)
          let savedId: string
          if (mode === 'create') {
            const created = await outputClient.create(values)
            const id = created.id
            const lineErrors = await persistItems(id)
            if (lineErrors.length) throw new Error(lineErrors.join('; '))
            toast.success('生产入库单已创建')
            savedId = id
          } else {
            await outputClient.update(drawer!.row!.id, values)
            if (draftOnly) {
              const lineErrors = await persistItems(drawer!.row!.id as string)
              if (lineErrors.length) throw new Error(lineErrors.join('; '))
            }
            toast.success('生产入库单已更新')
            savedId = drawer!.row!.id as string
          }
          queryClient.invalidateQueries({
            queryKey: ['gridRows', 'mfgOutputs'],
          })
          return savedId
        }}
      />
    </>
  )
}
