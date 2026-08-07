import { useCallback, useEffect, useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { parseDate } from '@internationalized/date'
import { AlertDialog, Button, Calendar, DateField, DatePicker, Label, toast } from '@heroui/react'
import { toastError } from '~/lib/toast'
import { useRequestGuard } from '~/lib/use-request-guard'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import {
  glJournalClient,
  glJournalLineClient,
} from '~/lib/resources/accounting'
import { accountClient } from '~/lib/resources/accounts'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'
import { executeCommandWithInvalidation } from '~/lib/resources/command-invalidation'
import { persistChildRows } from '~/lib/resources/persist-child-rows'
import { ensureDefaultGridPage } from '~/lib/route-prefetch'
import { resourceBindingFor } from '~/lib/resources/registry'
import { useRecordDrawerUrl } from '~/lib/use-record-drawer-url'

const RESOURCE = 'accGlJournals'

export const Route = createFileRoute('/_app/finance/journals')({
  loader: ({ context: { queryClient } }) =>
    ensureDefaultGridPage(queryClient, RESOURCE),
  component: JournalsPage,
})

// REST input 只收行自身字段:本地草稿 id、companyId(冗余自凭证,后端回填)、currencyId(科目复制,不可手改)
// 与行上挂的 account/currency join 对象一律不进 payload
function lineInput(row: Row) {
  return {
    idx: row.idx,
    accountId: row.accountId,
    debit: row.debit,
    credit: row.credit,
    partyType: row.partyType ?? null,
    partyId: row.partyId ?? null,
    remarks: row.remarks ?? null,
  }
}

/** 行差异持久化:本地草稿行 create;存量行有变 update;快照有、当前无 destroy。全程收集错误文案(带行号定位),不中途抛出 */
async function persistLines(
  journalId: string,
  current: Row[],
  snapshot: Row[],
): Promise<string[]> {
  return persistChildRows({
    current,
    snapshot,
    client: glJournalLineClient,
    parentIdField: 'journalId',
    parentId: journalId,
    compareKeys: [
      'idx',
      'accountId',
      'debit',
      'credit',
      'partyType',
      'partyId',
      'remarks',
    ],
    inputOf: lineInput,
  })
}

const safeParseDate = (v: string | null) => {
  if (!v) return null
  try {
    return parseDate(v)
  } catch {
    return null
  }
}

// 状态胶囊配色:草稿灰、已审核绿、已取消红
// 卡片:凭证号标题、摘要副标题、日期/状态/借方合计摘要
const GRID_OVERRIDES = {
  companyId: { mobileRole: 'hide' },
  voucherNo: { mobileRole: 'title' },
  remarks: { mobileRole: 'subtitle' },
  date: { mobileRole: 'summary' },
  status: {
    mobileRole: 'summary',
    enumColors: { DRAFT: 'default', AUDITED: 'success', CANCELLED: 'danger' },
  },
  debitTotal: { mobileRole: 'summary' },
} satisfies Record<string, ColumnOverride>

// 公司放首列;提交/创建/更新时间不进表格(有序白名单,兼当 exclude)
const GRID_COLUMNS = [
  'companyId',
  'voucherNo',
  'date',
  'postingDate',
  'remarks',
  'status',
  'createdById',
  'submittedById',
  'debitTotal',
  'creditTotal',
]

function JournalsPage() {
  // 页面级主抽屉:开/关/模式走 URL(?record=&mode=);分录明细本地 + 深链补拉
  const {
    drawer,
    open,
    setMode,
    close,
    row: drawerRow,
  } = useRecordDrawerUrl(RESOURCE)
  const [lines, setLines] = useState<Row[]>([])
  const [linesSnapshot, setLinesSnapshot] = useState<Row[]>([])
  // edit/view 态分录行靠 REST 异步拉取,未完成前禁止编辑,防回填覆盖在输行
  const [linesLoaded, setLinesLoaded] = useState(false)
  const queryClient = useQueryClient()
  // 请求守卫:每次开/关抽屉自增,异步回填前比对最新序号——防止慢响应把上一张凭证的行回填到当前凭证
  const guard = useRequestGuard()
  // 已为哪张凭证拉过分录;深链 effect 与 openDrawer 去重,避免双发
  const loadedIdRef = useRef<string | null>(null)

  const isOpen = drawer !== null
  const mode: DrawerMode = drawer?.mode ?? 'view'
  const rowId = drawer?.recordId ?? undefined

  // 行内「审核」确认框允许补填/修正过账日期(草稿可不填,审核时必填);
  // 抽屉「保存并审核」由标准组件在保存成功后调用同一 REST client action
  const [auditDialog, setAuditDialog] = useState<{ id: string } | null>(null)
  const [auditDate, setAuditDate] = useState<string | null>(null)
  const [auditing, setAuditing] = useState(false)

  const openAudit = (row: Row) => {
    // 默认过账日期:凭证已填的优先,否则用单据日期
    setAuditDate((row.postingDate as string | null) ?? (row.date as string | null) ?? null)
    setAuditDialog({ id: row.id })
  }

  const confirmAudit = async () => {
    if (!auditDialog || !auditDate) return
    setAuditing(true)
    try {
      await executeCommandWithInvalidation(
        resourceBindingFor(RESOURCE),
        'audit',
        { id: auditDialog.id, postingDate: auditDate },
        queryClient,
      )
      toast.success('凭证已审核过账')
      setAuditDialog(null)
    } catch (e) {
      toastError('审核失败')(e)
    } finally {
      setAuditing(false)
    }
  }

  function resetLines() {
    loadedIdRef.current = null
    setLines([])
    setLinesSnapshot([])
    setLinesLoaded(true)
  }

  function loadLines(journalId: string) {
    const my = guard.begin()
    loadedIdRef.current = journalId
    setLinesLoaded(false)
    glJournalLineClient
      .query({
        limit: 200,
        offset: 0,
        sort: { column: 'idx', direction: 'ascending' },
        filter: { journalId: { kind: 'fk', values: [journalId], labels: [] } },
      })
      .then((d) => {
        if (!guard.isCurrent(my)) return
        setLines(d.results)
        setLinesSnapshot(d.results)
        setLinesLoaded(true)
      })
      .catch((e) => {
        if (!guard.isCurrent(my)) return
        toastError('分录行加载失败')(e)
        setLines([])
        setLinesSnapshot([])
      })
  }

  // 打开头抽屉:create 行清空;view/edit 按凭证 id 拉行(快照留作提交时 diff 基准)
  const openDrawer = useCallback(
    (nextMode: DrawerMode, row: Row | null) => {
      open(nextMode, row?.id != null ? String(row.id) : null)
      if (nextMode === 'create' || !row) {
        resetLines()
        return
      }
      loadLines(String(row.id))
    },
    [open],
  )

  // 深链/前进后退:URL 驱动打开时 openDrawer 未走,按 recordId 补拉分录
  useEffect(() => {
    const d = drawer
    if (!d) {
      if (loadedIdRef.current != null) {
        guard.invalidate()
        resetLines()
      }
      return
    }
    if (d.mode === 'create' || d.recordId == null) {
      if (loadedIdRef.current != null) resetLines()
      return
    }
    if (loadedIdRef.current !== d.recordId) {
      loadLines(d.recordId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅 URL 抽屉身份变化时响应
  }, [drawer?.recordId, drawer?.mode])

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">会计凭证</h1>
      <p className="mt-2 text-sm text-ink-500">手工录入记账凭证,草稿态可自由增删改行,审核后生成总账分录。</p>

      <div className="mt-6">
        <SynieDataGrid
          resource={RESOURCE}
          columns={GRID_COLUMNS}
          overrides={GRID_OVERRIDES}
          onView={(row) => openDrawer('view', row)}
          onCreate={() => openDrawer('create', null)}
          onEdit={(row) => openDrawer(row.status === 'DRAFT' ? 'edit' : 'view', row)}
          actionHandlers={{ audit: (rows) => openAudit(rows[0]) }}
          actionVisible={{
            audit: (row) => row.status === 'DRAFT',
            cancel: (row) => row.status === 'AUDITED',
            edit: (row) => row.status === 'DRAFT',
            delete: (row) => row.status === 'DRAFT',
          }}
        />
      </div>

      <SynieRecordDrawer
        resource={RESOURCE}
        label="凭证"
        mode={mode}
        isOpen={isOpen}
        onOpenChange={(isDrawerOpen) => {
          if (isDrawerOpen) return
          // 关闭即作废在途请求并清空快照,防止残留快照被下次提交按差异写误用到别的凭证
          guard.invalidate()
          close()
          setLines([])
          setLinesSnapshot([])
          loadedIdRef.current = null
        }}
        // 表格列是白名单子集,行数据不全;不传 row,走 rowId 自查完整记录
        rowId={rowId}
        // 分录行表 7 列,默认 480px 太挤,凭证抽屉加宽(移动端仍全宽)
        contentClassName="w-full lg:w-[880px]"
        // 状态/提交时间/编写人/提交人是系统内部字段,不给用户看;借贷合计是行聚合(只在表格展示),
        // 不进表单;创建/更新时间表格已隐藏,行数据不带,view 态只会显示占位
        exclude={[
          'status',
          'submittedAt',
          'createdById',
          'submittedById',
          'debitTotal',
          'creditTotal',
          'insertedAt',
          'updatedAt',
        ]}
        fields={{
          // 公司提到最前(分录行科目候选依赖它);建后不可改(update 动作不收 company_id)
          companyId: { required: true, order: -1, edit: 'createOnly' },
          voucherNo: { placeholder: '保存后自动编号' },
          date: { required: true, cols: 6 },
          // 过账日期草稿可留空,审核时填入;新增时填了保存后会提示直接审核过账
          postingDate: { cols: 6 },
        }}
        onEdit={drawerRow?.status === 'DRAFT' ? () => setMode('edit') : undefined}
        extraContent={(mode, row, values) => {
          // 凭证公司:存量凭证取行数据(建后不可改),新建取表单草稿;未选公司前不能录行
          const journalCompanyId = (row?.companyId ?? values.companyId ?? null) as string | null
          return (
            <SynieEditableTable
              resource="accGlJournalLines"
              label="分录行"
              items={lines}
              onChange={setLines}
              readOnly={mode === 'view' || (row != null && row.status !== 'DRAFT') || journalCompanyId == null || (mode !== 'create' && !linesLoaded)}
              toolbar={
                mode === 'create' && journalCompanyId == null ? (
                  <span className="text-xs text-muted">选择公司后可录入分录行</span>
                ) : undefined
              }
              // 行表单金额/对手双列排布,默认 420px 局促,加宽一档
              drawerClassName="w-full lg:w-[560px]"
              exclude={['journalId', 'companyId']}
              columns={['idx', 'accountId', 'debit', 'credit', 'partyType', 'partyId', 'remarks']}
              fields={{
                // 行号系统自动分配(transformItem),表格照常展示
                idx: { visible: () => false },
                accountId: {
                  required: true,
                  // 候选限定在凭证公司、非汇总、启用科目(后端另有同公司/汇总/停用校验兜底)
                  remote: {
                    client: accountClient,
                    filterState: {
                      companyId: {
                        kind: 'fk',
                        values: journalCompanyId ? [journalCompanyId] : [],
                        labels: [],
                      },
                      isGroup: { kind: 'bool', eq: false },
                      active: { kind: 'bool', eq: true },
                    },
                  },
                },
                debit: { cols: 6, defaultValue: 0 },
                credit: { cols: 6, defaultValue: 0 },
                // 切换对手类型时清掉已选对手,避免客户 id 挂在供应商数据源下
                partyType: { cols: 6, effects: () => ({ partyId: null }) },
                partyId: {
                  cols: 6,
                  // 未选对手类型时不出现；四类往来对手均由 resource binding 解析。
                  visible: (values) =>
                    ['SUPPLIER', 'CUSTOMER', 'COMPANY', 'EMPLOYEE'].includes(
                      String(values.partyType ?? ''),
                    ),
                  input: ({ value, onChange, isDisabled, values }) => {
                    const party = {
                      SUPPLIER: {
                        resource: 'purSuppliers',
                        label: '供应商',
                      },
                      CUSTOMER: {
                        resource: 'salCustomers',
                        label: '客户',
                      },
                      COMPANY: {
                        resource: 'basCompanies',
                        label: '内部公司',
                      },
                      EMPLOYEE: {
                        resource: 'hrEmployees',
                        label: '员工',
                      },
                    }[String(values.partyType ?? '')]
                    if (!party) return null
                    return (
                      <RemoteSelect
                        resource={party.resource}
                        label={party.label}
                        placeholder={`选择${party.label}…`}
                        value={value == null ? null : String(value)}
                        onChange={(id) => onChange(id)}
                        isDisabled={isDisabled}
                      />
                    )
                  },
                },
                // 币种由科目复制,不可手改;仅在编辑存量行时展示已复制的值
                currencyId: { edit: 'readOnly' },
              }}
              transformItem={(values, editing) => ({
                ...values,
                // 行号自动:存量行保号,新行取当前最大 idx+1(而非 length+1,避免删行后撞号)
                idx: editing ? editing.idx : lines.reduce((max, r) => Math.max(max, Number(r.idx) || 0), 0) + 1,
              })}
            />
          )
        }}
        onSubmit={async (values, mode) => {
          // 返回值供抽屉「保存并审核」取 id 调审核动作(通用约定)
          let savedId: string
          if (mode === 'create') {
            const journal = await glJournalClient.create(values)
            const journalId = journal.id
            const lineErrors = await persistLines(journalId, lines, [])
            if (lineErrors.length > 0) {
              toast.danger('凭证已创建,但部分分录行保存失败', { description: lineErrors.join('; ') })
            } else {
              toast.success('凭证已创建')
            }
            savedId = journalId
          } else {
            const journalId = String(drawer!.recordId)
            await glJournalClient.update(journalId, values)
            const lineErrors = await persistLines(journalId, lines, linesSnapshot)
            if (lineErrors.length > 0) {
              toast.danger('凭证已更新,但部分分录行保存失败', { description: lineErrors.join('; ') })
            } else {
              toast.success('凭证已更新')
            }
            savedId = journalId
          }
          await resourceBindingFor(RESOURCE).cache.invalidateGrid(queryClient)
          return savedId
        }}
      />

      <AlertDialog.Backdrop isOpen={auditDialog !== null} onOpenChange={(open) => !open && setAuditDialog(null)}>
        <AlertDialog.Container>
          {/* 退场动画期间 auditDialog 已清空、Heading 不在,显式 aria-label 防 RAC 无标题警告 */}
          <AlertDialog.Dialog className="sm:max-w-[400px]" aria-label="审核过账">
            {auditDialog && (
              <>
                <AlertDialog.Header>
                  <AlertDialog.Icon status="accent" />
                  <AlertDialog.Heading>审核过账</AlertDialog.Heading>
                </AlertDialog.Header>
                <AlertDialog.Body>
                  <p className="mb-3">确认后凭证将审核并生成总账分录。</p>
                  <DatePicker
                    value={safeParseDate(auditDate)}
                    onChange={(v) => setAuditDate(v ? v.toString() : null)}
                  >
                    <Label>过账日期</Label>
                    <DateField.Group fullWidth>
                      <DateField.Input>{(segment) => <DateField.Segment segment={segment} />}</DateField.Input>
                      <DateField.Suffix>
                        <DatePicker.Trigger>
                          <DatePicker.TriggerIndicator />
                        </DatePicker.Trigger>
                      </DateField.Suffix>
                    </DateField.Group>
                    <DatePicker.Popover>
                      <Calendar aria-label="过账日期">
                        <Calendar.Header>
                          <Calendar.YearPickerTrigger>
                            <Calendar.YearPickerTriggerHeading />
                            <Calendar.YearPickerTriggerIndicator />
                          </Calendar.YearPickerTrigger>
                          <Calendar.NavButton slot="previous" />
                          <Calendar.NavButton slot="next" />
                        </Calendar.Header>
                        <Calendar.Grid>
                          <Calendar.GridHeader>
                            {(day) => <Calendar.HeaderCell>{day}</Calendar.HeaderCell>}
                          </Calendar.GridHeader>
                          <Calendar.GridBody>{(date) => <Calendar.Cell date={date} />}</Calendar.GridBody>
                        </Calendar.Grid>
                        <Calendar.YearPickerGrid>
                          <Calendar.YearPickerGridBody>
                            {({ year }) => <Calendar.YearPickerCell year={year} />}
                          </Calendar.YearPickerGridBody>
                        </Calendar.YearPickerGrid>
                      </Calendar>
                    </DatePicker.Popover>
                  </DatePicker>
                </AlertDialog.Body>
                <AlertDialog.Footer>
                  <Button slot="close" variant="tertiary" isDisabled={auditing}>
                    取消
                  </Button>
                  <Button isPending={auditing} isDisabled={!auditDate} onPress={confirmAudit}>
                    审核过账
                  </Button>
                </AlertDialog.Footer>
              </>
            )}
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </>
  )
}
