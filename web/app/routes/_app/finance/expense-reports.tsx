import { useCallback, useEffect, useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import { formatAmount } from '~/lib/amount'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import type { DrawerMode, FieldOverride } from '~/components/synie-record-drawer/fields'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import { ExpenseRoleSelect, expenseRoleLabel, findRoleAccounts } from './-expense-role'
import {
  expenseReportClient,
  expenseReportItemClient,
  queryExpenseReportItems,
  saveExpenseReportItems,
  vatInvoiceClient,
} from '~/lib/resources/finance-operations'

export const Route = createFileRoute('/_app/finance/expense-reports')({
  component: ExpenseReportsPage,
})

/** 提交 mutation:两类行互斥槽位在此归一(后端 KindRules 同口径);展示用发票字段不带 */
function itemInput(row: Row) {
  const invoiced = row.kind === 'INVOICED'
  return {
    idx: row.idx,
    kind: row.kind,
    invoiceId: invoiced ? row.invoiceId : null,
    summary: invoiced ? null : (row.summary ?? null),
    amount: invoiced ? null : (row.amount ?? null),
    expenseAccountId: invoiced ? null : (row.expenseAccountId ?? null),
    remarks: row.remarks ?? null,
  }
}

// 科目候选限：本公司、非汇总、启用。
function accountFilter(companyId: string | null): FilterState | undefined {
  if (!companyId) return undefined
  return {
    companyId: { kind: 'fk', values: [companyId], labels: [] },
    isGroup: { kind: 'bool', eq: false },
    active: { kind: 'bool', eq: true },
  }
}

function todayLocal(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 挂票行发票选择:候选限本公司、开入、员工对手、当前员工名下、已审核
 * (「未被其他报销单引用」前端过滤不了,交后端 BindInvoice 校验,报错是中文);
 * 选中后展示发票号码/价税合计供核对。
 */
function InvoicePickInput({
  value,
  onChange,
  isDisabled,
  filterState,
  invoiceCache,
}: {
  value: unknown
  onChange: (id: string | null) => void
  isDisabled: boolean
  filterState: FilterState | undefined
  invoiceCache: Map<string, Row>
}) {
  const id = value == null || value === '' ? null : String(value)
  const inv = id != null ? (invoiceCache.get(id) ?? null) : null
  return (
    <div className="flex flex-col gap-1">
      <RemoteSelect
        resource="accVatInvoices"
        label="挂票发票"
        isRequired
        placeholder={filterState ? '选择该员工已审核的报销发票…' : '先选齐公司与员工'}
        labelField="docNo"
        searchFields={['docNo', 'invoiceNo']}
        itemSubtitleFields={['invoiceNo']}
        fields={['docNo', 'invoiceNo', 'grossTotal']}
        value={id}
        onChange={(iid, row) => {
          if (iid && row) invoiceCache.set(iid, row)
          onChange(iid)
        }}
        isDisabled={isDisabled || filterState == null}
        filterState={filterState}
      />
      {inv && (
        <p className="text-xs text-muted">
          发票号码 {inv.invoiceNo != null && inv.invoiceNo !== '' ? String(inv.invoiceNo) : '—'}
          ;价税合计 {formatAmount(inv.grossTotal)}
        </p>
      )}
    </div>
  )
}

/** 无票行费用科目录入:报销类型选择器(自动带费用科目,纯录入辅助)+ 科目手选 */
function ManualExpenseAccountInput({
  value,
  onChange,
  isDisabled,
  companyId,
}: {
  value: unknown
  onChange: (id: string | null) => void
  isDisabled: boolean
  companyId: string | null
}) {
  const [role, setRole] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  return (
    <div className="flex flex-col gap-2">
      <ExpenseRoleSelect
        value={role}
        isDisabled={isDisabled || companyId == null || busy}
        onChange={async (r) => {
          setRole(r)
          if (!r || !companyId) return
          setBusy(true)
          try {
            const accounts = await findRoleAccounts(companyId, r)
            if (accounts.length === 1) {
              onChange(String(accounts[0].id))
            } else {
              toast.warning(
                `角色「${expenseRoleLabel(r)}」挂有 ${accounts.length} 个科目,请手选费用科目`,
              )
            }
          } catch (e) {
            toast.danger('按报销类型带科目失败', { description: (e as Error).message })
          } finally {
            setBusy(false)
          }
        }}
      />
      <RemoteSelect
        resource="basAccounts"
        label="费用科目"
        isRequired
        placeholder={companyId ? '选择费用科目…' : '先选择公司'}
        value={value == null || value === '' ? null : String(value)}
        onChange={(id) => onChange(id)}
        isDisabled={isDisabled || companyId == null}
        filterState={accountFilter(companyId)}
        labelField="name"
        searchFields={['name', 'code']}
        itemSubtitleFields={['code']}
      />
    </div>
  )
}

/**
 * 头关键字段变更清行:公司/员工任一变则清空报销行草稿(挂票行发票不再匹配条目池;
 * 与对账抽屉 ItemsResetGuard 同构,edit 等行主数据回填后再布防)。
 */
function ItemsResetGuard({
  mode,
  row,
  values,
  onReset,
}: {
  mode: DrawerMode
  row: Row | null | undefined
  values: Record<string, unknown>
  onReset: () => void
}) {
  const armedRef = useRef(false)
  const baselineRef = useRef('')
  const fpOf = (v: Record<string, unknown>) => [v.companyId, v.employeeId].map((x) => String(x ?? '')).join('|')
  const fp = fpOf(values)
  const rowFp = row != null ? fpOf(row) : null

  useEffect(() => {
    if (mode === 'view') return
    if (!armedRef.current) {
      if (mode === 'create' || (rowFp != null && fp === rowFp)) {
        baselineRef.current = fp
        armedRef.current = true
      }
      return
    }
    if (fp !== baselineRef.current) {
      baselineRef.current = fp
      onReset()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fp, rowFp, mode, onReset])

  return null
}

const GRID_COLUMNS = ['companyId', 'employeeId', 'docNo', 'expenseDate', 'postingDate', 'status', 'auditedAt']

// 状态胶囊配色:草稿灰、已审核绿、已作废红
const GRID_OVERRIDES = {
  status: { enumColors: { DRAFT: 'default', AUDITED: 'success', VOIDED: 'danger' } },
} satisfies Record<string, ColumnOverride>

// 行操作按状态出:草稿(编辑/删除/审核)、已审核(作废;无红冲,纠错=作废+重开)
const ACTION_VISIBLE = {
  audit: (row: Row) => row.status === 'DRAFT',
  void: (row: Row) => row.status === 'AUDITED',
  edit: (row: Row) => row.status === 'DRAFT',
  delete: (row: Row) => row.status === 'DRAFT',
} satisfies Record<string, (row: Row) => boolean>

function ExpenseReportsPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const [items, setItems] = useState<Row[]>([])
  const [itemsSnapshot, setItemsSnapshot] = useState<Row[]>([])
  // edit/view 态行靠 FETCH_ITEMS 异步拉取,未就绪前表格只读(同发票页 itemsLoaded 纪律)
  const [detailLoaded, setDetailLoaded] = useState(false)
  // 挂票发票缓存:选择时写入完整行,行表单核对提示与表格金额列共用
  const invoiceCacheRef = useRef(new Map<string, Row>())
  const queryClient = useQueryClient()
  const reqIdRef = useRef(0)

  const resetItems = useCallback(() => setItems((cur) => (cur.length === 0 ? cur : [])), [])

  const openDrawer = (mode: DrawerMode, row: Row | null) => {
    const my = ++reqIdRef.current
    setDrawer({ mode, row })
    invoiceCacheRef.current = new Map()
    if (mode === 'create' || row == null) {
      setItems([])
      setItemsSnapshot([])
      setDetailLoaded(true)
      return
    }
    setDetailLoaded(false)
    queryExpenseReportItems(row.id)
      .then(async (result) => {
        if (my !== reqIdRef.current) return
        // REST 行不做 relationship join；只对挂票行按公开发票 get 补展示信息。
        const invoices = await Promise.all(
          result.map((item) =>
            item.invoiceId
              ? vatInvoiceClient.get(String(item.invoiceId)).catch(() => null)
              : Promise.resolve(null),
          ),
        )
        const rows = result.map((item, index) => {
          const invoice = invoices[index]
          if (invoice && item.invoiceId) {
            invoiceCacheRef.current.set(String(item.invoiceId), invoice)
          }
          return {
            ...item,
            invoice,
            invoiceGrossTotal: invoice?.grossTotal ?? null,
          }
        })
        setItems(rows)
        setItemsSnapshot(rows)
        setDetailLoaded(true)
      })
      .catch((e) => {
        if (my !== reqIdRef.current) return
        toast.danger('报销行加载失败', { description: (e as Error).message })
        // 加载失败保持空快照:提交不会误删后端原行(同对账抽屉语义)
        setItems([])
        setItemsSnapshot([])
      })
  }

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">报销单</h1>
      <p className="mt-2 text-sm text-ink-500">
        员工费用报销的付款核销:挂票行引用已审核的报销发票,无票行手填非税支出;审核过账核销欠款,草稿可自由编辑。
      </p>

      <div className="mt-6">
        <SynieDataGrid
          resource="accExpenseReports"
          client={expenseReportClient}
          columns={GRID_COLUMNS}
          overrides={GRID_OVERRIDES}
          onView={(row) => openDrawer('view', row)}
          onCreate={() => openDrawer('create', null)}
          onEdit={(row) => openDrawer(row.status === 'DRAFT' ? 'edit' : 'view', row)}
          actionVisible={ACTION_VISIBLE}
        />
      </div>

      <SynieRecordDrawer
        resource="accExpenseReports"
        client={expenseReportClient}
        label="报销单"
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => {
          if (open) return
          reqIdRef.current++
          setDrawer(null)
          setItems([])
          setItemsSnapshot([])
          invoiceCacheRef.current = new Map()
        }}
        // 表格列是白名单子集(备注/付款科目等不在其中),行数据不全;走 rowId 自查完整记录
        rowId={drawer?.row?.id}
        contentClassName="w-full lg:w-[880px]"
        exclude={['status', 'auditedAt', 'auditedById', 'createdById', 'insertedAt', 'updatedAt']}
        fields={{
          // 公司建后不可改(update 动作不收 company_id,同发票先例)
          companyId: {
            required: true,
            order: 0,
            cols: 6,
            edit: 'createOnly',
            // 换公司清员工与付款科目(员工候选与科目均按公司口径);报销行由 ItemsResetGuard 清
            effects: () => ({ employeeId: null, paymentAccountId: null }),
          },
          employeeId: { required: true, order: 1, cols: 6, label: '员工' },
          expenseDate: { required: true, order: 2, cols: 6, label: '报销日期', defaultValue: todayLocal() },
          postingDate: { order: 3, cols: 6, label: '过账日期', placeholder: '审核前必填' },
          docNo: { order: 4, cols: 6, label: '单据编号', placeholder: '留空自动编号' },
          paymentAccountId: {
            required: true,
            order: 5,
            cols: 6,
            label: '付款科目',
            input: ({ value, onChange, isDisabled, values }) => {
              const companyId = (values.companyId ?? null) as string | null
              return (
                <RemoteSelect
                  resource="basAccounts"
                  label="付款科目"
                  placeholder={companyId ? '银行存款/库存现金类科目…' : '先选择公司'}
                  value={value == null ? null : String(value)}
                  onChange={(id) => onChange(id)}
                  isDisabled={isDisabled || companyId == null}
                  filterState={accountFilter(companyId)}
                  labelField="name"
                  searchFields={['name', 'code']}
                  itemSubtitleFields={['code']}
                />
              )
            },
          },
          remarks: { order: 6, label: '备注' },
        }}
        onEdit={
          drawer?.row?.status === 'DRAFT'
            ? () => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))
            : undefined
        }
        extraContent={(mode, row, values, _patchValues) => {
          const companyId = (values.companyId ?? null) as string | null
          const employeeId = (values.employeeId ?? null) as string | null
          const headerReady = Boolean(companyId && employeeId)
          // 挂票候选：本公司、开入、员工对手、当前员工名下、已审核。
          const invoiceFilterState: FilterState | undefined = headerReady
            ? {
                companyId: { kind: 'fk', values: [companyId!], labels: [] },
                direction: { kind: 'enum', values: ['INBOUND'] },
                partyType: { kind: 'enum', values: ['EMPLOYEE'] },
                partyId: { kind: 'fk', values: [employeeId!], labels: [] },
                status: { kind: 'enum', values: ['AUDITED'] },
              }
            : undefined
          const itemsReadOnly =
            mode === 'view' || (row != null && row.status !== 'DRAFT') || (mode !== 'create' && !detailLoaded)

          const itemFields: Record<string, FieldOverride> = {
            // 行号系统排(transformItem 取 max+1),不进表单
            idx: { visible: () => false },
            kind: {
              order: 0,
              cols: 6,
              required: true,
              label: '行类型',
              // 换行类型清互斥槽位(挂票=发票;无票=摘要/金额/费用科目)
              effects: () => ({ invoiceId: null, summary: null, amount: null, expenseAccountId: null }),
            },
            invoiceId: {
              order: 1,
              required: true,
              label: '挂票发票',
              visible: (v) => v.kind === 'INVOICED',
              input: ({ value, onChange, isDisabled }) => (
                <InvoicePickInput
                  value={value}
                  onChange={onChange}
                  isDisabled={isDisabled}
                  filterState={invoiceFilterState}
                  invoiceCache={invoiceCacheRef.current}
                />
              ),
            },
            summary: {
              order: 2,
              required: true,
              label: '摘要',
              visible: (v) => v.kind === 'MANUAL',
            },
            amount: {
              order: 3,
              cols: 6,
              required: true,
              label: '金额',
              visible: (v) => v.kind === 'MANUAL',
            },
            expenseAccountId: {
              order: 4,
              required: true,
              label: '费用科目',
              visible: (v) => v.kind === 'MANUAL',
              input: ({ value, onChange, isDisabled }) => (
                <ManualExpenseAccountInput
                  value={value}
                  onChange={onChange}
                  isDisabled={isDisabled}
                  companyId={companyId}
                />
              ),
            },
            remarks: { order: 5, label: '行备注' },
          }

          const rowAmount = (r: Row) => Number(r.amount ?? r.invoiceGrossTotal ?? 0) || 0
          const totalAmount = items.reduce((acc, r) => acc + rowAmount(r), 0)

          return (
            <>
              {/* key 随开抽屉世代变,保证每次打开重新布防基线 */}
              <ItemsResetGuard
                key={`${drawer?.row?.id ?? 'create'}-${reqIdRef.current}`}
                mode={mode}
                row={row}
                values={values}
                onReset={resetItems}
              />
              <SynieEditableTable
                resource="accExpenseReportItems"
                client={expenseReportItemClient}
                label="报销行"
                items={items}
                onChange={setItems}
                readOnly={itemsReadOnly}
                canCreate={headerReady}
                toolbar={
                  itemsReadOnly || headerReady ? undefined : (
                    <span className="text-xs text-muted">先选齐公司与员工</span>
                  )
                }
                drawerProps={{ contentClassName: 'w-full lg:w-[480px]' }}
                exclude={['reportId', 'companyId']}
                columns={['idx', 'kind', 'invoiceId', 'summary', 'amount', 'remarks']}
                overrides={{
                  kind: { label: '类型' },
                  invoiceId: { label: '挂票发票' },
                  summary: { label: '摘要' },
                  // 挂票行金额取发票价税合计(行上不冗余存储),无票行取行金额
                  amount: { label: '金额', render: (v, r) => formatAmount(v ?? r.invoiceGrossTotal) || undefined },
                  remarks: { label: '行备注' },
                }}
                fields={itemFields}
                validateItem={(vals, curItems, editing) => {
                  if (vals.kind === 'INVOICED') {
                    if (!vals.invoiceId) return '请选择挂票发票'
                    if (
                      curItems.some(
                        (r) =>
                          r.id !== editing?.id &&
                          r.invoiceId != null &&
                          String(r.invoiceId) === String(vals.invoiceId),
                      )
                    )
                      return '该发票已在清单中'
                  } else if (vals.kind === 'MANUAL') {
                    if (vals.summary == null || String(vals.summary).trim() === '') return '无票行必须填写摘要'
                    if (!(Number(vals.amount) > 0)) return '金额必须大于零'
                    if (!vals.expenseAccountId) return '无票行必须选择费用科目'
                  } else {
                    return '请选择行类型'
                  }
                }}
                transformItem={(vals, editing) => {
                  const inv =
                    vals.invoiceId != null ? invoiceCacheRef.current.get(String(vals.invoiceId)) : undefined
                  return {
                    ...vals,
                    idx: editing
                      ? editing.idx
                      : items.reduce((max, r) => Math.max(max, Number(r.idx) || 0), 0) + 1,
                    // 展示冗余:挂票行金额列读发票价税合计(提交时 itemInput 剔除)
                    invoiceGrossTotal: inv?.grossTotal ?? null,
                  }
                }}
              />
              {items.length > 0 && (
                <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
                  <span className="text-muted">
                    合计金额:
                    <span className="ml-1 font-medium text-ink-900">{formatAmount(totalAmount)}</span>
                  </span>
                </div>
              )}
            </>
          )
        }}
        onSubmit={async (values, mode) => {
          // 返回值供抽屉「保存并审核」取 id 调审核 mutation(通用约定)
          let savedId: string
          if (mode === 'create') {
            const reportId = (await expenseReportClient.create(values)).id
            const itemErrors = await saveExpenseReportItems(
              reportId,
              items,
              [],
              itemInput,
            )
            if (itemErrors.length > 0) {
              toast.danger('报销单已创建,但部分报销行保存失败', { description: itemErrors.join('; ') })
            } else {
              toast.success('报销单已创建')
            }
            savedId = reportId
          } else {
            const reportId = drawer!.row!.id
            await expenseReportClient.update(reportId, values)
            const itemErrors = await saveExpenseReportItems(
              reportId,
              items,
              itemsSnapshot,
              itemInput,
            )
            if (itemErrors.length > 0) {
              toast.danger('报销单已更新,但部分报销行保存失败', { description: itemErrors.join('; ') })
            } else {
              toast.success('报销单已更新')
            }
            savedId = reportId
          }
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'accExpenseReports'] })
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'accExpenseReportItems'] })
          queryClient.invalidateQueries({ queryKey: ['rowById', 'accExpenseReports'] })
          return savedId
        }}
      />
    </>
  )
}
