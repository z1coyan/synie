import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Label, NumberField, toast } from '@heroui/react'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { useDocItems } from '~/components/synie-editable-table/use-doc-items'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/extension-drawer-props'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'
import { formatQty } from '~/lib/amount'
import {
  outputClient,
  outputItemClient,
  workOrderClient,
} from '~/lib/resources/manufacturing'
import {
  auditMaterialCell,
  type AuditDocConfig,
} from '../../scm/-audit-doc'
import { materialCellRender } from '~/components/synie-material-cell/MaterialCell'
import { useRecordDrawerUrl } from '~/lib/use-record-drawer-url'
import { WorkOrderProgressCell } from '../-work-order-progress-cell'
import { resourceBindingFor } from '~/lib/resources/registry'

/**
 * 生产入库共享抽屉:入库条目与入库单两个列表共用同一份整单录入界面。
 */

export interface OutputRef {
  id: string
  status?: unknown
}

export type OpenOutputDrawer = (
  mode: DrawerMode,
  output: OutputRef | null,
) => void

const OutputDrawerContext = createContext<OpenOutputDrawer>(() => {})

export function useOutputDrawer(): OpenOutputDrawer {
  return useContext(OutputDrawerContext)
}

/**
 * 工单「当前未入」折回行单位（与 WorkOrderProgressCell 同口径）。
 * receivedBaseQty/remainingBaseQty 是默认单位；qty/baseQty 比把未入折回工单行单位展示。
 */
function remainingInItemUnit(wo: Row | null | undefined): string | null {
  if (wo == null) return null
  const qty = Number(wo.qty)
  const base = Number(wo.baseQty)
  const received = Number(wo.receivedBaseQty)
  const unit =
    wo.unitName != null && wo.unitName !== '' ? String(wo.unitName) : ''
  if (
    Number.isFinite(qty) &&
    Number.isFinite(base) &&
    Number.isFinite(received) &&
    base > 0
  ) {
    const remainingItem = qty - (qty * received) / base
    return `${formatQty(remainingItem, 4)}${unit ? ` ${unit}` : ''}`
  }
  const rem = Number(wo.remainingBaseQty)
  if (!Number.isFinite(rem)) return null
  return `${formatQty(rem, 4)}${unit ? ` ${unit}` : ''}`
}

/** 入库数量 + 尾部「未入」提示；按工单实时取当前未完成量 */
function OutputQtyField({
  value,
  onChange,
  isDisabled,
  workOrderId,
}: {
  value: unknown
  onChange: (v: unknown) => void
  isDisabled: boolean
  workOrderId: unknown
}) {
  const id =
    workOrderId == null || workOrderId === '' ? null : String(workOrderId)
  const woQuery = useQuery({
    queryKey: ['mfgWorkOrder', 'remaining-hint', id],
    enabled: id != null,
    staleTime: 15_000,
    queryFn: () => workOrderClient.get(id!),
  })
  const remaining = remainingInItemUnit(woQuery.data)

  return (
    <div className="flex items-end gap-2">
      <div className="min-w-0 flex-1">
        <NumberField
          fullWidth
          isDisabled={isDisabled}
          isRequired
          value={value == null || value === '' ? NaN : Number(value)}
          onChange={(n) => onChange(Number.isFinite(n) ? n : null)}
        >
          <Label>数量</Label>
          <NumberField.Group className="grid-cols-[1fr]">
            <NumberField.Input placeholder="本次入库数量" />
          </NumberField.Group>
        </NumberField>
      </div>
      {remaining != null ? (
        <span
          className="mb-2.5 shrink-0 text-xs tabular-nums text-muted"
          title="工单当前未入库数量（已审核入库累计后的剩余，不含本单草稿）"
        >
          未入 {remaining}
        </span>
      ) : id != null && woQuery.isPending ? (
        <span className="mb-2.5 shrink-0 text-xs text-muted">未入 …</span>
      ) : null}
    </div>
  )
}

// 入库条目脚手架(取数/持久化)走共用 useDocItems
const ITEMS = {
  label: '入库条目',
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

// 「审核整单」确认弹窗配置(同 scm 单据先例:只取行快照字段)
export const outputAuditConfig = {
  docLabel: '生产入库单',
  resource: 'mfgOutputs',
  commandKey: 'audit',
  itemsResource: 'mfgOutputItems',
  loadItems: (docId) =>
    outputItemClient
      .query({
        limit: 200,
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
  columns: [
    { key: 'materialName', label: '物料', render: auditMaterialCell() },
    { key: 'unitName', label: '单位' },
    { key: 'qty', label: '入库数量', align: 'end' },
    { key: 'baseQty', label: '折算数量', align: 'end' },
    { key: 'remarks', label: '行备注' },
  ],
} satisfies AuditDocConfig

// 条目表格物料列:全站统一富单元格(生产入库条目无图纸挂接,缩略图回退物料当前图纸);
// 本地新行物料由所选工单派生、尚无快照,返回 undefined 回落默认渲染(空值显 —)
const outputItemMaterialCell = materialCellRender()
const hasMaterialSnapshot = (row: Row) =>
  (row.materialCode != null && row.materialCode !== '') ||
  (row.materialName != null && row.materialName !== '')

/**
 * 生产入库创建/编辑抽屉(头+入库条目)。
 * 入库单/入库条目两 tab 共用;列表 layout 传 urlSync,开/关/模式走 URL。
 *
 * @param urlSync 列表页传 true:抽屉开/关/模式写 ?record=&mode=,深链/刷新/后退可寻址。
 */
export function OutputDrawerProvider({
  children,
  urlSync = false,
}: {
  children: ReactNode
  urlSync?: boolean
}) {
  // URL 源(列表 layout)与本地态二选一;明细始终本地
  const url = useRecordDrawerUrl('mfgOutputs', { enabled: urlSync })
  const [localDrawer, setLocalDrawer] = useState<{
    mode: DrawerMode
    output: OutputRef | null
  } | null>(null)
  const { items, setItems, itemsLoaded, load, persistItems } =
    useDocItems(ITEMS)
  const queryClient = useQueryClient()
  // 行表单最近一次选中的工单整行:effects 写表单草稿时 collectValues 会剥掉
  // 非字段键(物料快照在 exclude),transformItem 从这里取快照并入本地行
  const pickedWorkOrderRef = useRef<Row | null>(null)
  // 已为哪张入库单拉过明细;深链 effect 与 openDrawer 去重
  const loadedIdRef = useRef<string | null>(null)

  const isOpen = urlSync ? url.drawer !== null : localDrawer !== null
  const mode: DrawerMode = urlSync
    ? (url.drawer?.mode ?? 'view')
    : (localDrawer?.mode ?? 'view')
  const rowId: string | undefined = urlSync
    ? (url.drawer?.recordId ?? undefined)
    : localDrawer?.output?.id != null
      ? String(localDrawer.output.id)
      : undefined
  // 编辑入口:urlSync 用 hook 自查行 status;本地态用 open 传入的 output.status
  const outputStatus = urlSync
    ? url.row?.status
    : localDrawer?.output?.status

  const loadItems = (docId: string | null) => {
    loadedIdRef.current = docId
    load(docId)
  }

  const openDrawer: OpenOutputDrawer = (nextMode, output) => {
    if (urlSync) {
      url.open(nextMode, output?.id != null ? String(output.id) : null)
    } else {
      setLocalDrawer({ mode: nextMode, output })
    }
    if (nextMode === 'create' || !output) {
      loadItems(null)
      return
    }
    loadItems(String(output.id))
  }

  // 深链/前进后退:URL 驱动打开时 openDrawer 未走,按 recordId 补拉明细
  useEffect(() => {
    if (!urlSync) return
    const d = url.drawer
    if (!d) {
      if (loadedIdRef.current != null) loadItems(null)
      return
    }
    if (d.mode === 'create' || d.recordId == null) {
      if (loadedIdRef.current != null) loadItems(null)
      return
    }
    if (loadedIdRef.current !== d.recordId) {
      loadItems(d.recordId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅 URL 抽屉身份变化时响应
  }, [urlSync, url.drawer?.recordId, url.drawer?.mode])

  const draftOnly =
    mode === 'create' || !outputStatus || outputStatus === 'DRAFT'

  return (
    <OutputDrawerContext.Provider value={openDrawer}>
      {children}

      <SynieRecordDrawer
        resource="mfgOutputs"
        {...drawerConfig('mfgOutputs')}
        mode={mode}
        isOpen={isOpen}
        onOpenChange={(open) => {
          if (open) return
          if (urlSync) url.close()
          else setLocalDrawer(null)
          loadedIdRef.current = null
        }}
        rowId={rowId}
        onEdit={
          outputStatus === 'DRAFT'
            ? () => {
                if (urlSync) url.setMode('edit')
                else
                  setLocalDrawer((current) =>
                    current ? { ...current, mode: 'edit' } : current,
                  )
              }
            : undefined
        }
        extraContent={(m) => (
          <SynieEditableTable
            resource="mfgOutputItems"
            label="入库条目"
            items={items}
            onChange={setItems}
            readOnly={
              m === 'view' ||
              !draftOnly ||
              (m !== 'create' && !itemsLoaded)
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
              'outputNo',
              'outputDate',
              'outputStatus',
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
                    // 入库进度列本体是 remainingBaseQty;数量明细随 wire 全量返回
                    'remainingBaseQty',
                    'needDate',
                    'status',
                  ],
                  // 确认选中时带工单单位,供 effects 锁到行单位
                  gridExtraFields: [
                    'unitId',
                    'qty',
                    'baseQty',
                    'receivedBaseQty',
                    'unitName',
                  ],
                  gridOverrides: {
                    workOrderNo: { mobileRole: 'title' },
                    companyId: { mobileRole: 'hide' },
                    materialCode: { label: '物料编号', mobileRole: 'hide' },
                    materialName: { label: '物料名称', mobileRole: 'subtitle' },
                    materialSpec: { label: '规格', mobileRole: 'hide' },
                    remainingBaseQty: {
                      label: '入库进度',
                      mobileRole: 'summary',
                      align: 'start' as const,
                      render: (_v: unknown, row: Row) => (
                        <WorkOrderProgressCell row={row} />
                      ),
                    },
                    needDate: { mobileRole: 'summary' },
                    status: { mobileRole: 'summary' },
                  },
                  gridDefaultSort: {
                    column: 'needDate',
                    direction: 'ascending',
                  },
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
                // 工单物料只读展示:create 态读 effects stash,edit 态回落行上已持久化快照
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
              // 数量尾部展示工单当前未入(行单位);实时 GET 工单,编辑存量行也准确
              qty: {
                order: 3,
                required: true,
                input: ({ value, onChange, isDisabled, values }) => (
                  <OutputQtyField
                    value={value}
                    onChange={onChange}
                    isDisabled={isDisabled}
                    workOrderId={values.workOrderId}
                  />
                ),
              },
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
        onSubmit={async (values, submitMode) => {
          // 返回值供抽屉「保存并审核」取 id 调审核 mutation(通用约定)
          let savedId: string
          if (submitMode === 'create') {
            const created = await outputClient.create(values)
            const id = created.id
            const lineErrors = await persistItems(id)
            if (lineErrors.length) throw new Error(lineErrors.join('; '))
            toast.success('生产入库单已创建')
            savedId = id
          } else {
            savedId = String(rowId)
            await outputClient.update(savedId, values)
            if (draftOnly) {
              const lineErrors = await persistItems(savedId)
              if (lineErrors.length) throw new Error(lineErrors.join('; '))
            }
            toast.success('生产入库单已更新')
          }
          await Promise.all([
            resourceBindingFor('mfgOutputs').cache.invalidateGrid(queryClient),
            resourceBindingFor('mfgOutputItems').cache.invalidateGrid(queryClient),
          ])
          return savedId
        }}
      />
    </OutputDrawerContext.Provider>
  )
}
