import { useCallback, useEffect, useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import { formatAmount } from '~/lib/amount'
import { toastError } from '~/lib/toast'
import { todayLocal } from '~/lib/form-defaults'
import { AUDIT_DOC_STATUS_ENUM_COLORS, AUDIT_DOC_EDIT_ACTION_VISIBLE } from '~/lib/doc-status'
import { ItemsResetGuard } from '~/components/items-reset-guard'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import type { DrawerMode, FieldOverride } from '~/components/synie-record-drawer/fields'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import { ExpenseRoleSelect, expenseRoleLabel } from './-expense-role'
import { findRoleAccounts } from '~/lib/resources/accounts'
import {
  expenseReportClient,
  queryExpenseReportItems,
  saveExpenseReportItems,
  vatInvoiceClient,
} from '~/lib/resources/finance-operations'
import { ensureDefaultGridPage } from '~/lib/route-prefetch'
import { resourceBindingFor } from '~/lib/resources/registry'
import { useDocumentDrawer } from '~/lib/use-document-drawer'

const RESOURCE = 'accExpenseReports'

export const Route = createFileRoute('/_app/finance/expense-reports')({
  loader: ({ context: { queryClient } }) =>
    ensureDefaultGridPage(queryClient, RESOURCE),
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
            toastError('按报销类型带科目失败')(e)
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

// 头关键字段变更清行:公司/员工任一变则清空报销行草稿(挂票行发票不再匹配条目池);
// 指纹字段清单(共享 ItemsResetGuard 的 fields prop,顺序影响指纹串,勿改)
const ITEMS_RESET_FIELDS = ['companyId', 'employeeId'] as const

const GRID_COLUMNS = ['companyId', 'employeeId', 'docNo', 'expenseDate', 'postingDate', 'status', 'auditedAt']

// 状态胶囊配色:草稿灰、已审核绿、已作废红
// 卡片:单号标题、报销人副标题、费用日/状态摘要
const GRID_OVERRIDES = {
  companyId: { mobileRole: 'hide' },
  docNo: { mobileRole: 'title' },
  employeeId: { mobileRole: 'subtitle' },
  expenseDate: { mobileRole: 'summary' },
  status: {
    mobileRole: 'summary',
    enumColors: AUDIT_DOC_STATUS_ENUM_COLORS,
  },
} satisfies Record<string, ColumnOverride>

// 行操作按状态出:草稿(编辑/删除/审核)、已审核(作废;无红冲,纠错=作废+重开)
const ACTION_VISIBLE = AUDIT_DOC_EDIT_ACTION_VISIBLE

async function loadExpenseReportDraft(reportId: string): Promise<Row[]> {
  const result = await queryExpenseReportItems(reportId)
  // REST 行不做 relationship join；只对挂票行按公开发票 get 补展示信息。
  const invoices = await Promise.all(
    result.map((item) =>
      item.invoiceId
        ? vatInvoiceClient.get(String(item.invoiceId)).catch(() => null)
        : Promise.resolve(null),
    ),
  )
  return result.map((item, index) => {
    const invoice = invoices[index]
    return {
      ...item,
      invoice,
      invoiceGrossTotal: invoice?.grossTotal ?? null,
    }
  })
}

function ExpenseReportsPage() {
  // 单据抽屉骨架:URL 双态 + 报销行装载竞态协议
  const drawer = useDocumentDrawer<Row[]>({
    resource: RESOURCE,
    urlSync: true,
    loadErrorLabel: '报销行加载失败',
    loadDraft: loadExpenseReportDraft,
  })
  const { isOpen, mode, rowId } = drawer
  const drawerRow = drawer.row
  const [items, setItems] = useState<Row[]>([])
  const [itemsSnapshot, setItemsSnapshot] = useState<Row[]>([])
  // 挂票发票缓存:选择时写入完整行,行表单核对提示与表格金额列共用
  const invoiceCacheRef = useRef(new Map<string, Row>())
  const queryClient = useQueryClient()

  const resetItems = useCallback(() => setItems((cur) => (cur.length === 0 ? cur : [])), [])

  // 草稿 → 报销行状态派生;重建发票缓存(装载期预热结果在 draft 行上)
  useEffect(() => {
    const rows = drawer.draft ?? []
    const cache = new Map<string, Row>()
    for (const row of rows) {
      if (row.invoiceId && row.invoice) {
        cache.set(String(row.invoiceId), row.invoice as Row)
      }
    }
    invoiceCacheRef.current = cache
    setItems(rows)
    setItemsSnapshot(rows)
  }, [drawer.draft, drawer.generation])

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">报销单</h1>
      <p className="mt-2 text-sm text-ink-500">
        员工费用报销的付款核销:挂票行引用已审核的报销发票,无票行手填非税支出;审核过账核销欠款,草稿可自由编辑。
      </p>

      <div className="mt-6">
        <SynieDataGrid
          resource={RESOURCE}
          columns={GRID_COLUMNS}
          overrides={GRID_OVERRIDES}
          onView={(row) => drawer.open('view', row)}
          onCreate={() => drawer.open('create', null)}
          onEdit={(row) => drawer.open(row.status === 'DRAFT' ? 'edit' : 'view', row)}
          actionVisible={ACTION_VISIBLE}
        />
      </div>

      <SynieRecordDrawer
        resource={RESOURCE}
        label="报销单"
        mode={mode}
        isOpen={isOpen}
        onOpenChange={(isDrawerOpen) => {
          if (!isDrawerOpen) drawer.close()
        }}
        // 表格列是白名单子集(备注/付款科目等不在其中),行数据不全;走 rowId 自查完整记录
        rowId={rowId}
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
          docNo: { order: 4, cols: 6, label: '单据编号', placeholder: '保存后自动编号' },
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
          drawerRow?.status === 'DRAFT' ? () => drawer.setMode('edit') : undefined
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
            mode === 'view' || (row != null && row.status !== 'DRAFT') || (mode !== 'create' && !drawer.detailLoaded)

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
                key={`${rowId ?? 'create'}-${drawer.generation}`}
                mode={mode}
                row={row}
                values={values}
                fields={ITEMS_RESET_FIELDS}
                onReset={resetItems}
              />
              <SynieEditableTable
                resource="accExpenseReportItems"
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
                drawerClassName="w-full lg:w-[480px]"
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
            const reportId = String(drawer.rowId)
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
          await Promise.all([
            resourceBindingFor(RESOURCE).cache.invalidateAll(queryClient),
            resourceBindingFor('accExpenseReportItems').cache.invalidateGrid(queryClient),
          ])
          return savedId
        }}
      />
    </>
  )
}
