import { useCallback, useEffect, useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertDialog, Button, Label, NumberField, Spinner, toast } from '@heroui/react'
import { EmptyState } from '@heroui-pro/react'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import type { Row } from '~/components/synie-data-grid/types'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/registry'
import type { DrawerMode, FieldOverride } from '~/components/synie-record-drawer/fields'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { isLocalRow } from '~/components/synie-editable-table/editable'
import { MaterialUnitSelect } from '~/components/synie-material-unit-select/MaterialUnitSelect'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'

export const Route = createFileRoute('/_app/scm/stock-transfers')({
  component: StockTransfersPage,
})

/**
 * 手工调拨单:同公司三仓(调出/调入/在途)间的库存移动,一单两动作走在途
 * (ADR 2026-07-19-stock-ledger):发货写「调出仓负+在途仓正」,收货按行实收写「在途仓负+调入仓正」。
 * 状态机 草稿→已发货→已收货:仅草稿可改可删;发货(grid_actions 内建确认)后锁定;
 * 收货走自定义对话框(逐行实收,默认=已发折算数量,可改小不可改大,差额留在在途仓)。
 * 在途仓默认预填公司种子在途仓("{公司编号} - 在途"),匹配不到留空手选。
 */

const CREATE_DOC = `
  mutation ($input: CreateInvStockTransferInput!) {
    createInvStockTransfer(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_DOC = `
  mutation ($id: ID!, $input: UpdateInvStockTransferInput!) {
    updateInvStockTransfer(id: $id, input: $input) { result { id } errors { message } }
  }
`
const CREATE_ITEM = `
  mutation ($input: CreateInvStockTransferItemInput!) {
    createInvStockTransferItem(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_ITEM = `
  mutation ($id: ID!, $input: UpdateInvStockTransferItemInput!) {
    updateInvStockTransferItem(id: $id, input: $input) { result { id } errors { message } }
  }
`
const DESTROY_ITEM = `
  mutation ($id: ID!) {
    destroyInvStockTransferItem(id: $id) { errors { message } }
  }
`
// receipts 是 JsonString 标量数组(每个元素为 {"item_id","qty"} 的 JSON 串,服务端 decode 成 map)
const RECEIVE_DOC = `
  mutation ($id: ID!, $input: ReceiveInvStockTransferInput!) {
    receiveInvStockTransfer(id: $id, input: $input) { result { id } errors { message } }
  }
`
const FETCH_ITEMS = `
  query ($docId: ID!) {
    invStockTransferItems(filter: {stockTransferId: {eq: $docId}}, sort: [{field: IDX, order: ASC}], limit: 200, offset: 0) {
      results {
        id idx materialId unitId qty baseQty receivedQty remark materialName unitName
        material { id name }
        unit { id name }
      }
    }
  }
`
// 在途仓预填:按公司查启用叶子仓,匹配种子名「{公司编号} - 在途」
const FETCH_LEAF_WAREHOUSES = `
  query ($companyId: ID!) {
    invWarehouses(filter: {companyId: {eq: $companyId}, isLeaf: {eq: true}}, limit: 200, offset: 0) {
      results { id name }
    }
  }
`

// 列表列白名单:公司由页面顶部选定不进列,操作人/时间戳不进表格
const GRID_COLUMNS = [
  'docNo',
  'docDate',
  'fromWarehouseId',
  'toWarehouseId',
  'transitWarehouseId',
  'status',
  'summary',
]

// 状态胶囊配色:草稿灰、已发货蓝(在途)、已收货绿
const GRID_OVERRIDES = {
  status: { enumColors: { DRAFT: 'default', SHIPPED: 'accent', RECEIVED: 'success' } },
  summary: { width: 200 },
} satisfies Record<string, ColumnOverride>

// 状态机动作显隐:发货/编辑/删除仅草稿,收货仅已发货(后端权威校验兜底,这里做体验层)
const ACTION_VISIBLE = {
  ship: (row: Row) => row.status === 'DRAFT',
  receive: (row: Row) => row.status === 'SHIPPED',
  edit: (row: Row) => row.status === 'DRAFT',
  delete: (row: Row) => row.status === 'DRAFT',
} satisfies Record<string, (row: Row) => boolean>

// 本地日期 YYYY-MM-DD(同销售订单先例)
function todayLocal(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

interface MutationResult {
  result?: { id: string } | null
  errors: { message: string }[] | null
}

// mutation input 只收行自身字段:baseQty/receivedQty 系统算、companyId 冗余自母单、快照后端重拍
function itemInput(row: Row) {
  return {
    idx: row.idx,
    materialId: row.materialId,
    unitId: row.unitId,
    qty: row.qty,
    remark: row.remark ?? null,
  }
}

const ITEM_COMPARE_KEYS = ['idx', 'materialId', 'unitId', 'qty', 'remark'] as const

function itemChanged(before: Row, after: Row): boolean {
  return ITEM_COMPARE_KEYS.some((k) => String(before[k] ?? '') !== String(after[k] ?? ''))
}

/** 行差异持久化(同手工出入库单先例):草稿行 create;存量行有变 update;快照有、当前无 destroy;错误带行号收集 */
async function persistItems(docId: string, current: Row[], snapshot: Row[]): Promise<string[]> {
  const errors: string[] = []
  const collect = (idx: unknown, msgs: { message: string }[] | null | undefined) => {
    if (msgs?.length) errors.push(...msgs.map((e) => `第${idx}行:${e.message}`))
  }
  const currentIds = new Set(current.filter((r) => !isLocalRow(r)).map((r) => r.id))

  for (const old of snapshot) {
    if (currentIds.has(old.id)) continue
    const data = await gqlFetch<{ destroyInvStockTransferItem: MutationResult }>(DESTROY_ITEM, { id: old.id })
    collect(old.idx, data.destroyInvStockTransferItem.errors)
  }

  for (const row of current) {
    if (isLocalRow(row)) {
      const data = await gqlFetch<{ createInvStockTransferItem: MutationResult }>(CREATE_ITEM, {
        input: { stockTransferId: docId, ...itemInput(row) },
      })
      collect(row.idx, data.createInvStockTransferItem.errors)
      continue
    }
    const old = snapshot.find((s) => s.id === row.id)
    if (old && itemChanged(old, row)) {
      const data = await gqlFetch<{ updateInvStockTransferItem: MutationResult }>(UPDATE_ITEM, {
        id: row.id,
        input: itemInput(row),
      })
      collect(row.idx, data.updateInvStockTransferItem.errors)
    }
  }
  return errors
}

/**
 * 在途仓预填(渲染为 null 的表单伴生组件,照 CompanyCurrencySync 先例):
 * create 态按公司查叶子仓,命中种子名「{公司编号} - 在途」且在途仓未填时预填;
 * 匹配不到(种子被改名/删除)留空手选,不阻塞表单。
 */
function TransitWarehouseSync({
  mode,
  companyId,
  companyCode,
  values,
  patchValues,
}: {
  mode: DrawerMode
  companyId: string | null
  companyCode: string | null
  values: Record<string, unknown>
  patchValues: (patch: Record<string, unknown>) => void
}) {
  const query = useQuery({
    queryKey: ['transitWarehouse', companyId, companyCode],
    enabled: mode === 'create' && companyId != null && companyCode != null,
    staleTime: 300_000,
    queryFn: () =>
      gqlFetch<{ invWarehouses: { results: { id: string; name: string }[] } }>(FETCH_LEAF_WAREHOUSES, {
        companyId,
      }).then(
        (d) => d.invWarehouses.results.find((w) => w.name === `${companyCode} - 在途`)?.id ?? null
      ),
  })
  const found = query.data ?? null
  const current = values.transitWarehouseId

  useEffect(() => {
    if (mode !== 'create' || found == null) return
    if (current == null || current === '') patchValues({ transitWarehouseId: found })
    // patchValues 每次渲染重建,依赖它会空转;补丁条件由 found/current 驱动
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, found, current])

  return null
}

function StockTransfersPage() {
  const [companyId, setCompanyId] = useState<string | null>(null)
  const [companyRow, setCompanyRow] = useState<Row | null>(null)
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const [items, setItems] = useState<Row[]>([])
  const [itemsSnapshot, setItemsSnapshot] = useState<Row[]>([])
  // edit/view 态行靠异步拉取,未完成前禁止编辑,防回填覆盖在输行(同销售订单先例)
  const [detailLoaded, setDetailLoaded] = useState(false)
  // 收货对话框:目标单据 + 逐行实收草稿(行到达后初始化为已发 baseQty)
  const [receiveDoc, setReceiveDoc] = useState<Row | null>(null)
  const [receipts, setReceipts] = useState<Record<string, number>>({})
  const [receiving, setReceiving] = useState(false)
  const queryClient = useQueryClient()
  const reqIdRef = useRef(0)

  // 公司列表:仅一家时自动选中(照仓库管理页先例);code 用于在途仓种子名匹配
  const companies = useQuery({
    queryKey: ['stockTransferCompanies'],
    queryFn: () =>
      gqlFetch<{ basCompanies: { count: number; results: Row[] } }>(
        `query { basCompanies(limit: 50, offset: 0, sort: [{field: CODE, order: ASC}]) { count results { id name code } } }`
      ).then((d) => d.basCompanies),
  })

  useEffect(() => {
    if (companyId == null && companies.data?.count === 1) {
      const only = companies.data.results[0]
      setCompanyId(only.id)
      setCompanyRow(only)
    }
  }, [companies.data, companyId])

  const openDrawer = useCallback((mode: DrawerMode, row: Row | null) => {
    const my = ++reqIdRef.current
    setDrawer({ mode, row })
    if (mode === 'create') {
      setItems([])
      setItemsSnapshot([])
      setDetailLoaded(true)
      return
    }
    setDetailLoaded(false)
    gqlFetch<{ invStockTransferItems: { results: Row[] } }>(FETCH_ITEMS, { docId: row!.id })
      .then((d) => {
        if (my !== reqIdRef.current) return
        const rows = d.invStockTransferItems.results
        setItems(rows)
        setItemsSnapshot(rows)
        setDetailLoaded(true)
      })
      .catch((e) => {
        if (my !== reqIdRef.current) return
        toast.danger('调拨单行加载失败', { description: (e as Error).message })
        setItems([])
        setItemsSnapshot([])
      })
  }, [])

  // 收货对话框行数据:打开时按单据拉行(含快照名与已发折算数量)
  const receiveItems = useQuery({
    queryKey: ['transferReceiveItems', receiveDoc?.id],
    enabled: receiveDoc != null,
    queryFn: () =>
      gqlFetch<{ invStockTransferItems: { results: Row[] } }>(FETCH_ITEMS, {
        docId: receiveDoc!.id,
      }).then((d) => d.invStockTransferItems.results),
  })

  // 行到达后初始化实收=已发(折算口径);全部足额时用户直接确认即可
  useEffect(() => {
    if (receiveItems.data) {
      setReceipts(Object.fromEntries(receiveItems.data.map((r) => [r.id, Number(r.baseQty)])))
    }
  }, [receiveItems.data])

  const invalidateGrids = () => {
    queryClient.invalidateQueries({ queryKey: ['gridRows', 'invStockTransfers'] })
    queryClient.invalidateQueries({ queryKey: ['rowById', 'invStockTransfers'] })
  }

  const submitReceive = async () => {
    if (!receiveDoc || !receiveItems.data) return
    setReceiving(true)
    try {
      const input = {
        receipts: receiveItems.data.map((r) =>
          JSON.stringify({ item_id: r.id, qty: Number.isFinite(receipts[r.id]) ? receipts[r.id] : 0 })
        ),
      }
      const data = await gqlFetch<{ receiveInvStockTransfer: MutationResult }>(RECEIVE_DOC, {
        id: receiveDoc.id,
        input,
      })
      const errors = data.receiveInvStockTransfer.errors
      if (errors && errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '))
      toast.success('调拨单已收货')
      setReceiveDoc(null)
      invalidateGrids()
    } catch (e) {
      toast.danger('收货失败', { description: (e as Error).message })
    } finally {
      setReceiving(false)
    }
  }

  // 三仓候选:本公司、叶子、启用(与后端 WarehouseUsable 保存/发货校验同口径)
  const warehouseFilter = `{companyId: {eq: ${JSON.stringify(companyId)}}, isLeaf: {eq: true}, active: {eq: true}}`

  const baseCfg = drawerConfig('invStockTransfers')
  const drawerCfg = {
    ...baseCfg,
    fields: {
      ...baseCfg.fields,
      // 公司由页面顶部选定,表单不显示,提交时注入(照仓库管理页先例)
      companyId: { ...baseCfg.fields?.companyId, visible: () => false },
      fromWarehouseId: { ...baseCfg.fields?.fromWarehouseId, remote: { filter: warehouseFilter } },
      toWarehouseId: { ...baseCfg.fields?.toWarehouseId, remote: { filter: warehouseFilter } },
      transitWarehouseId: { ...baseCfg.fields?.transitWarehouseId, remote: { filter: warehouseFilter } },
      docDate: { ...baseCfg.fields?.docDate, defaultValue: todayLocal() },
    },
  }

  // 行录入字段:与手工出入库单行同构;receivedQty 收货回写,不出表单但上表格(表单 visible:false 隐藏)
  const itemFields: Record<string, FieldOverride> = {
    idx: { visible: () => false },
    materialId: {
      order: 0,
      required: true,
      effects: () => ({ unitId: null }),
    },
    unitId: {
      order: 1,
      cols: 6,
      required: true,
      input: ({ value, onChange, isDisabled, values: itemValues }) => (
        <MaterialUnitSelect
          materialId={itemValues.materialId == null ? null : String(itemValues.materialId)}
          value={value}
          onChange={onChange}
          isDisabled={isDisabled}
        />
      ),
    },
    qty: { order: 2, cols: 6, required: true, label: '数量' },
    // 折算数量系统算(后端 writable? false):表单只读展示存量值,新行占位提示,不录入(提交见 itemInput)
    baseQty: {
      order: 3,
      cols: 6,
      label: '折算数量',
      input: ({ value }) => (
        <NumberField fullWidth isDisabled value={value == null || value === '' ? NaN : Number(value)}>
          <Label>折算数量(物料默认单位)</Label>
          <NumberField.Group className="grid-cols-[1fr]">
            <NumberField.Input placeholder="保存后系统折算" />
          </NumberField.Group>
        </NumberField>
      ),
    },
    receivedQty: { visible: () => false },
    remark: { order: 4, label: '行备注' },
  }

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">手工调拨单</h1>
      <p className="mt-2 text-sm text-ink-500">
        同公司三仓(调出/调入/在途)间的库存移动:发货后货在在途仓,收货按行确认实收,差额留在在途仓由手工出入库单(出库)清理。
      </p>

      <div className="mt-6 max-w-xs">
        <RemoteSelect
          resource="basCompanies"
          label="公司"
          placeholder="选择公司…"
          value={companyId}
          initialRows={companyRow ? [companyRow] : (companies.data?.results ?? [])}
          onChange={(id, row) => {
            setCompanyId(id)
            setCompanyRow(row)
          }}
        />
      </div>

      <div className="mt-6">
        {companyId == null ? (
          <EmptyState size="md" className="h-64 justify-center">
            <EmptyState.Header>
              <EmptyState.Title>请先选择公司</EmptyState.Title>
              <EmptyState.Description>调拨限同公司仓库之间,选择公司后查看与新建调拨单。</EmptyState.Description>
            </EmptyState.Header>
          </EmptyState>
        ) : (
          <SynieDataGrid
            key={companyId}
            resource="invStockTransfers"
            columns={GRID_COLUMNS}
            overrides={GRID_OVERRIDES}
            fixedFilter={{ companyId: { eq: companyId } }}
            defaultSort={{ column: 'docDate', direction: 'descending' }}
            onView={(row) => openDrawer('view', row)}
            onCreate={() => openDrawer('create', null)}
            onEdit={(row) => openDrawer(row.status === 'DRAFT' ? 'edit' : 'view', row)}
            actionVisible={ACTION_VISIBLE}
            // 收货需要逐行实收参数,不走内建「确认即提交」:覆盖为打开收货对话框
            actionHandlers={{ receive: (rows) => setReceiveDoc(rows[0]) }}
          />
        )}
      </div>

      <SynieRecordDrawer
        resource="invStockTransfers"
        {...drawerCfg}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => {
          if (open) return
          reqIdRef.current++
          setDrawer(null)
          setItems([])
          setItemsSnapshot([])
        }}
        rowId={drawer?.row?.id}
        onEdit={
          drawer?.row?.status === 'DRAFT' ? () => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d)) : undefined
        }
        extraContent={(mode, row, values, patchValues) => (
          <>
            <TransitWarehouseSync
              mode={mode}
              companyId={companyId}
              companyCode={(companyRow?.code as string | undefined) ?? null}
              values={values}
              patchValues={patchValues}
            />
            <SynieEditableTable
              resource="invStockTransferItems"
              label="调拨行"
              items={items}
              onChange={setItems}
              readOnly={
                mode === 'view' || (row != null && row.status !== 'DRAFT') || (mode !== 'create' && !detailLoaded)
              }
              drawerProps={{ contentClassName: 'w-full lg:w-[560px]' }}
              exclude={[
                'stockTransferId',
                'companyId',
                // 快照列由后端保存时重拍,不进录入表单;不影响表格显示(快照经 overrides 渲染)
                'materialCode',
                'materialName',
                'materialSpec',
                'unitName',
              ]}
              columns={['idx', 'materialId', 'unitId', 'qty', 'baseQty', 'receivedQty', 'remark']}
              overrides={{
                materialId: {
                  render: (_v, r) =>
                    r.materialName != null && r.materialName !== '' ? String(r.materialName) : undefined,
                },
                unitId: {
                  render: (_v, r) => (r.unitName != null && r.unitName !== '' ? String(r.unitName) : undefined),
                },
                baseQty: { label: '折算数量' },
                receivedQty: { label: '实收数量' },
                remark: { label: '行备注' },
              }}
              fields={itemFields}
              validateItem={(vals) => {
                if (!(Number(vals.qty) > 0)) return '数量必须大于零'
              }}
              transformItem={(values, editing) => ({
                ...values,
                idx: editing ? editing.idx : items.reduce((max, r) => Math.max(max, Number(r.idx) || 0), 0) + 1,
                ...(editing != null && values.materialId !== editing.materialId ? { materialName: null } : {}),
                ...(editing != null && values.unitId !== editing.unitId ? { unitName: null } : {}),
              })}
            />
          </>
        )}
        onSubmit={async (values, mode) => {
          // 三仓两两不同(后端 StockTransferWarehousesDistinct 兜底,前端先拦一道)
          const warehouses = [values.fromWarehouseId, values.toWarehouseId, values.transitWarehouseId].filter(
            (v) => v != null && v !== ''
          )
          if (new Set(warehouses.map(String)).size !== warehouses.length) {
            throw new Error('调出、调入与在途仓库必须两两不同')
          }
          if (mode === 'create') {
            const data = await gqlFetch<{ createInvStockTransfer: MutationResult }>(CREATE_DOC, {
              input: { ...values, companyId },
            })
            const res = data.createInvStockTransfer
            if (res.errors && res.errors.length > 0) throw new Error(res.errors.map((e) => e.message).join('; '))
            const itemErrors = await persistItems(res.result!.id, items, [])
            if (itemErrors.length > 0) {
              toast.danger('调拨单已创建,但部分调拨行保存失败', { description: itemErrors.join('; ') })
            } else {
              toast.success('调拨单已创建')
            }
          } else {
            const data = await gqlFetch<{ updateInvStockTransfer: MutationResult }>(UPDATE_DOC, {
              id: drawer!.row!.id,
              input: values,
            })
            const res = data.updateInvStockTransfer
            if (res.errors && res.errors.length > 0) throw new Error(res.errors.map((e) => e.message).join('; '))
            const itemErrors = await persistItems(drawer!.row!.id, items, itemsSnapshot)
            if (itemErrors.length > 0) {
              toast.danger('调拨单已更新,但部分调拨行保存失败', { description: itemErrors.join('; ') })
            } else {
              toast.success('调拨单已更新')
            }
          }
          invalidateGrids()
        }}
      />

      {/* 收货对话框:逐行确认实收(默认=已发折算数量,0~已发);全部足额直接确认即可 */}
      <AlertDialog.Backdrop
        isOpen={receiveDoc !== null}
        onOpenChange={(open) => {
          if (!open && !receiving) setReceiveDoc(null)
        }}
      >
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-[560px]" aria-label="调拨收货">
            <AlertDialog.Header>
              <AlertDialog.Heading>调拨收货{receiveDoc ? `(${String(receiveDoc.docNo ?? '')})` : ''}</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p className="text-sm text-ink-500">
                逐行确认实收数量(0 ~ 已发数量);差额留在在途仓,后续用手工出入库单(出库)清理。
              </p>
              {receiveItems.isPending ? (
                <div className="flex h-24 items-center justify-center">
                  <Spinner />
                </div>
              ) : receiveItems.isError ? (
                <EmptyState size="sm" className="h-32 justify-center">
                  <EmptyState.Header>
                    <EmptyState.Title>调拨行加载失败</EmptyState.Title>
                    <EmptyState.Description>{(receiveItems.error as Error).message}</EmptyState.Description>
                  </EmptyState.Header>
                  <EmptyState.Content>
                    <Button variant="secondary" onPress={() => receiveItems.refetch()}>
                      重试
                    </Button>
                  </EmptyState.Content>
                </EmptyState>
              ) : (
                <div className="mt-4 flex flex-col gap-3">
                  {(receiveItems.data ?? []).map((r) => {
                    const shipped = Number(r.baseQty)
                    return (
                      <div key={r.id} className="flex items-end justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm">{String(r.materialName ?? '')}</p>
                          <p className="text-xs text-muted">
                            第{String(r.idx)}行 · 已发 {shipped} {String(r.unitName ?? '')}
                          </p>
                        </div>
                        <NumberField
                          className="w-32 shrink-0"
                          minValue={0}
                          maxValue={shipped}
                          value={receipts[r.id] ?? shipped}
                          onChange={(n) => setReceipts((prev) => ({ ...prev, [r.id]: Number.isFinite(n) ? n : 0 }))}
                        >
                          <Label>实收数量</Label>
                          <NumberField.Group className="grid-cols-[1fr]">
                            <NumberField.Input />
                          </NumberField.Group>
                        </NumberField>
                      </div>
                    )
                  })}
                </div>
              )}
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button slot="close" variant="tertiary" isDisabled={receiving}>
                取消
              </Button>
              <Button
                variant="primary"
                isPending={receiving}
                isDisabled={!receiveItems.data || receiveItems.data.length === 0}
                onPress={submitReceive}
              >
                确认收货
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </>
  )
}
