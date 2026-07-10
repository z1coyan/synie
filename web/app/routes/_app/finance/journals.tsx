import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { parseDate } from '@internationalized/date'
import { AlertDialog, Button, Calendar, DateField, DatePicker, Label, toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { isLocalRow } from '~/components/synie-editable-table/editable'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/finance/journals')({
  component: JournalsPage,
})

const CREATE_JOURNAL = `
  mutation ($input: CreateAccGlJournalInput!) {
    createAccGlJournal(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_JOURNAL = `
  mutation ($id: ID!, $input: UpdateAccGlJournalInput!) {
    updateAccGlJournal(id: $id, input: $input) { result { id } errors { message } }
  }
`
const AUDIT_JOURNAL = `
  mutation ($id: ID!, $input: AuditAccGlJournalInput!) {
    auditAccGlJournal(id: $id, input: $input) { result { id } errors { message } }
  }
`
const FETCH_LINES = `
  query ($journalId: ID!) {
    accGlJournalLines(filter: {journalId: {eq: $journalId}}, sort: [{field: IDX, order: ASC}], limit: 200, offset: 0) {
      results {
        id idx accountId debit credit partyType partyId remarks currencyId
        account { id name }
        currency { id name }
      }
    }
  }
`
const CREATE_LINE = `
  mutation ($input: CreateAccGlJournalLineInput!) {
    createAccGlJournalLine(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_LINE = `
  mutation ($id: ID!, $input: UpdateAccGlJournalLineInput!) {
    updateAccGlJournalLine(id: $id, input: $input) { result { id } errors { message } }
  }
`
const DESTROY_LINE = `
  mutation ($id: ID!) {
    destroyAccGlJournalLine(id: $id) { errors { message } }
  }
`

// mutation input 只收行自身字段:本地草稿 id、companyId(冗余自凭证,后端回填)、currencyId(科目复制,不可手改)
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

const LINE_COMPARE_KEYS = ['idx', 'accountId', 'debit', 'credit', 'partyType', 'partyId', 'remarks'] as const

function lineChanged(before: Row, after: Row): boolean {
  return LINE_COMPARE_KEYS.some((k) => String(before[k] ?? '') !== String(after[k] ?? ''))
}

/** 行差异持久化:本地草稿行 create;存量行有变 update;快照有、当前无 destroy。全程收集错误文案(带行号定位),不中途抛出 */
async function persistLines(journalId: string, current: Row[], snapshot: Row[]): Promise<string[]> {
  const errors: string[] = []
  // 多行部分失败时用户要能定位到行,错误文案统一冠以行号(destroy 分支用被删行的 idx)
  const collect = (idx: unknown, msgs: { message: string }[] | null | undefined) => {
    if (msgs?.length) errors.push(...msgs.map((e) => `第${idx}行:${e.message}`))
  }
  const currentIds = new Set(current.filter((r) => !isLocalRow(r)).map((r) => r.id))

  for (const old of snapshot) {
    if (currentIds.has(old.id)) continue
    const data = await gqlFetch<{ destroyAccGlJournalLine: { errors: { message: string }[] | null } }>(
      DESTROY_LINE,
      { id: old.id }
    )
    collect(old.idx, data.destroyAccGlJournalLine.errors)
  }

  for (const row of current) {
    if (isLocalRow(row)) {
      const data = await gqlFetch<{ createAccGlJournalLine: { errors: { message: string }[] | null } }>(
        CREATE_LINE,
        { input: { journalId, ...lineInput(row) } }
      )
      collect(row.idx, data.createAccGlJournalLine.errors)
      continue
    }
    const old = snapshot.find((s) => s.id === row.id)
    if (old && lineChanged(old, row)) {
      const data = await gqlFetch<{ updateAccGlJournalLine: { errors: { message: string }[] | null } }>(
        UPDATE_LINE,
        { id: row.id, input: lineInput(row) }
      )
      collect(row.idx, data.updateAccGlJournalLine.errors)
    }
  }
  return errors
}

const safeParseDate = (v: string | null) => {
  if (!v) return null
  try {
    return parseDate(v)
  } catch {
    return null
  }
}

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
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const [lines, setLines] = useState<Row[]>([])
  const [linesSnapshot, setLinesSnapshot] = useState<Row[]>([])
  const [reloadKey, setReloadKey] = useState(0)

  // 审核过账确认框:行内「审核」动作与新增后带过账日期的顺手审核共用;
  // 过账日期在此填入/修正(草稿可不填,审核时必填)
  const [auditDialog, setAuditDialog] = useState<{ id: string; fromCreate: boolean } | null>(null)
  const [auditDate, setAuditDate] = useState<string | null>(null)
  const [auditing, setAuditing] = useState(false)

  const openAudit = (row: Row, fromCreate = false) => {
    // 默认过账日期:凭证已填的优先,否则用单据日期
    setAuditDate((row.postingDate as string | null) ?? (row.date as string | null) ?? null)
    setAuditDialog({ id: row.id, fromCreate })
  }

  const confirmAudit = async () => {
    if (!auditDialog || !auditDate) return
    setAuditing(true)
    try {
      const data = await gqlFetch<{ auditAccGlJournal: { errors: { message: string }[] | null } }>(
        AUDIT_JOURNAL,
        { id: auditDialog.id, input: { postingDate: auditDate } }
      )
      if (data.auditAccGlJournal.errors && data.auditAccGlJournal.errors.length > 0) {
        throw new Error(data.auditAccGlJournal.errors.map((e) => e.message).join('; '))
      }
      toast.success('凭证已审核过账')
      setAuditDialog(null)
      setReloadKey((k) => k + 1)
    } catch (e) {
      toast.danger('审核失败', { description: (e as Error).message })
    } finally {
      setAuditing(false)
    }
  }

  // 打开头抽屉:create 行清空;view/edit 按凭证 id 拉行(快照留作提交时 diff 基准)
  const openDrawer = (mode: DrawerMode, row: Row | null) => {
    setDrawer({ mode, row })
    if (mode === 'create') {
      setLines([])
      setLinesSnapshot([])
      return
    }
    gqlFetch<{ accGlJournalLines: { results: Row[] } }>(FETCH_LINES, { journalId: row!.id })
      .then((d) => {
        setLines(d.accGlJournalLines.results)
        setLinesSnapshot(d.accGlJournalLines.results)
      })
      .catch((e) => {
        toast.danger('分录行加载失败', { description: (e as Error).message })
        setLines([])
        setLinesSnapshot([])
      })
  }

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">会计凭证</h1>
      <p className="mt-2 text-sm text-ink-500">手工录入记账凭证,草稿态可自由增删改行,审核后生成总账分录。</p>

      <div className="mt-6">
        <SynieDataGrid
          key={reloadKey}
          resource="accGlJournals"
          columns={GRID_COLUMNS}
          onView={(row) => openDrawer('view', row)}
          onCreate={() => openDrawer('create', null)}
          onEdit={(row) => openDrawer(row.status === 'DRAFT' ? 'edit' : 'view', row)}
          actionHandlers={{ audit: (rows) => openAudit(rows[0]) }}
        />
      </div>

      <SynieRecordDrawer
        resource="accGlJournals"
        label="凭证"
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        row={drawer?.row}
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
          voucherNo: { required: true, placeholder: '如 PZ202601001' },
          date: { required: true, cols: 6 },
          // 过账日期草稿可留空,审核时填入;新增时填了保存后会提示直接审核过账
          postingDate: { cols: 6 },
        }}
        onEdit={drawer?.row?.status === 'DRAFT' ? () => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d)) : undefined}
        extraContent={(mode, row, values) => {
          // 凭证公司:存量凭证取行数据(建后不可改),新建取表单草稿;未选公司前不能录行
          const journalCompanyId = (row?.companyId ?? values.companyId ?? null) as string | null
          return (
            <SynieEditableTable
              resource="accGlJournalLines"
              label="分录行"
              items={lines}
              onChange={setLines}
              readOnly={mode === 'view' || (row != null && row.status !== 'DRAFT') || journalCompanyId == null}
              toolbar={
                mode === 'create' && journalCompanyId == null ? (
                  <span className="text-xs text-muted">选择公司后可录入分录行</span>
                ) : undefined
              }
              // 行表单金额/对手双列排布,默认 420px 局促,加宽一档
              drawerProps={{ contentClassName: 'w-full lg:w-[560px]' }}
              exclude={['journalId', 'companyId']}
              columns={['idx', 'accountId', 'debit', 'credit', 'partyType', 'partyId', 'remarks']}
              fields={{
                // 行号系统自动分配(transformItem),表格照常展示
                idx: { visible: () => false },
                accountId: {
                  required: true,
                  // 候选限定在凭证公司、非汇总、启用科目(后端另有同公司/汇总/停用校验兜底)
                  remote: {
                    filter: `{companyId: {eq: ${JSON.stringify(journalCompanyId)}}, isGroup: {eq: false}, active: {eq: true}}`,
                  },
                },
                debit: { cols: 6, defaultValue: 0 },
                credit: { cols: 6, defaultValue: 0 },
                // 切换对手类型时清掉已选对手,避免客户 id 挂在供应商数据源下
                partyType: { cols: 6, effects: () => ({ partyId: null }) },
                partyId: {
                  cols: 6,
                  // 未选对手类型时不出现;选定后 label 跟随类型显示 供应商/客户
                  visible: (values) => values.partyType === 'SUPPLIER' || values.partyType === 'CUSTOMER',
                  input: ({ value, onChange, isDisabled, values }) => {
                    const isSupplier = values.partyType === 'SUPPLIER'
                    return (
                      <RemoteSelect
                        resource={isSupplier ? 'purSuppliers' : 'salCustomers'}
                        label={isSupplier ? '供应商' : '客户'}
                        placeholder={isSupplier ? '选择供应商…' : '选择客户…'}
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
          if (mode === 'create') {
            const data = await gqlFetch<{
              createAccGlJournal: { result: { id: string } | null; errors: { message: string }[] | null }
            }>(CREATE_JOURNAL, { input: values })
            if (data.createAccGlJournal.errors && data.createAccGlJournal.errors.length > 0) {
              throw new Error(data.createAccGlJournal.errors.map((e) => e.message).join('; '))
            }
            const journalId = data.createAccGlJournal.result!.id
            const lineErrors = await persistLines(journalId, lines, [])
            if (lineErrors.length > 0) {
              toast.danger('凭证已创建,但部分分录行保存失败', { description: lineErrors.join('; ') })
            } else {
              toast.success('凭证已创建')
              // 新增时已填过账日期 → 顺手提示直接审核过账
              if (values.postingDate) {
                openAudit({ id: journalId, postingDate: values.postingDate, date: values.date } as Row, true)
              }
            }
          } else {
            const journalId = drawer!.row!.id
            const data = await gqlFetch<{
              updateAccGlJournal: { errors: { message: string }[] | null }
            }>(UPDATE_JOURNAL, { id: journalId, input: values })
            if (data.updateAccGlJournal.errors && data.updateAccGlJournal.errors.length > 0) {
              throw new Error(data.updateAccGlJournal.errors.map((e) => e.message).join('; '))
            }
            const lineErrors = await persistLines(journalId, lines, linesSnapshot)
            if (lineErrors.length > 0) {
              toast.danger('凭证已更新,但部分分录行保存失败', { description: lineErrors.join('; ') })
            } else {
              toast.success('凭证已更新')
            }
          }
          setReloadKey((k) => k + 1)
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
                  <AlertDialog.Heading>
                    {auditDialog.fromCreate ? '是否直接审核过账?' : '审核过账'}
                  </AlertDialog.Heading>
                </AlertDialog.Header>
                <AlertDialog.Body>
                  <p className="mb-3">
                    {auditDialog.fromCreate
                      ? '凭证已创建并填写了过账日期,确认后立即审核并生成总账分录。'
                      : '确认后凭证将审核并生成总账分录。'}
                  </p>
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
                    {auditDialog.fromCreate ? '暂不审核' : '取消'}
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
