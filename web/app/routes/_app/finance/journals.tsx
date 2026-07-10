import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { EmptyState } from '@heroui-pro/react'
import { Input, Label, TextField, toast } from '@heroui/react'
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

function JournalsPage() {
  const [companyId, setCompanyId] = useState<string | null>(null)
  const [companyRow, setCompanyRow] = useState<Row | null>(null)
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const [lines, setLines] = useState<Row[]>([])
  const [linesSnapshot, setLinesSnapshot] = useState<Row[]>([])
  const [reloadKey, setReloadKey] = useState(0)

  const companies = useQuery({
    queryKey: ['journalsCompanies'],
    queryFn: () =>
      gqlFetch<{ basCompanies: { count: number; results: Row[] } }>(
        `query { basCompanies(limit: 50, offset: 0, sort: [{field: CODE, order: ASC}]) { count results { id name } } }`
      ).then((d) => d.basCompanies),
  })

  useEffect(() => {
    if (companyId == null && companies.data?.count === 1) {
      const only = companies.data.results[0]
      setCompanyId(only.id)
      setCompanyRow(only)
    }
  }, [companies.data, companyId])

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
              <EmptyState.Description>凭证按公司维护,选择公司后查看或录入凭证。</EmptyState.Description>
            </EmptyState.Header>
          </EmptyState>
        ) : (
          <SynieDataGrid
            key={`${companyId}-${reloadKey}`}
            resource="accGlJournals"
            fixedFilter={{ companyId: { eq: companyId } }}
            onView={(row) => openDrawer('view', row)}
            onCreate={() => openDrawer('create', null)}
            onEdit={(row) => openDrawer(row.status === 'DRAFT' ? 'edit' : 'view', row)}
          />
        )}
      </div>

      <SynieRecordDrawer
        resource="accGlJournals"
        label="凭证"
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        row={drawer?.row}
        fields={{
          voucherNo: { required: true, placeholder: '如 PZ202601001' },
          date: { required: true, cols: 6 },
          postingDate: { required: true, cols: 6 },
          // 公司由页面顶部选定,表单不显示,提交时注入
          companyId: { visible: () => false },
          status: { edit: 'readOnly', cols: 6 },
          submittedAt: { edit: 'readOnly', cols: 6 },
          createdById: { edit: 'readOnly', cols: 6 },
          submittedById: { edit: 'readOnly', cols: 6 },
        }}
        onEdit={drawer?.row?.status === 'DRAFT' ? () => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d)) : undefined}
        extraContent={(mode, row) => (
          <SynieEditableTable
            resource="accGlJournalLines"
            label="分录行"
            items={lines}
            onChange={setLines}
            readOnly={mode === 'view' || (row != null && row.status !== 'DRAFT')}
            exclude={['journalId', 'companyId']}
            columns={['idx', 'accountId', 'debit', 'credit', 'partyType', 'partyId', 'remarks']}
            fields={{
              idx: {
                required: true,
                cols: 3,
                // 建议下一个行号:取当前最大 idx+1,而非 length+1(避免删行后撞号)
                defaultValue: lines.reduce((max, r) => Math.max(max, Number(r.idx) || 0), 0) + 1,
              },
              accountId: {
                required: true,
                cols: 9,
                // 候选限定在当前公司、非汇总、启用科目(后端另有同公司/汇总/停用校验兜底)
                remote: {
                  filter: `{companyId: {eq: ${JSON.stringify(companyId)}}, isGroup: {eq: false}, active: {eq: true}}`,
                },
              },
              debit: { cols: 6, defaultValue: 0 },
              credit: { cols: 6, defaultValue: 0 },
              partyType: { cols: 6 },
              partyId: {
                cols: 6,
                // 多态外键:meta 无 ref,默认退化 TextField;这里按当前表单 partyType 值切换 RemoteSelect 数据源
                input: ({ value, onChange, isDisabled, values }) => {
                  const partyType = values.partyType
                  const resource =
                    partyType === 'SUPPLIER' ? 'purSuppliers' : partyType === 'CUSTOMER' ? 'salCustomers' : null
                  if (!resource) {
                    return (
                      <TextField isDisabled value="" onChange={() => {}}>
                        <Label>对手</Label>
                        <Input placeholder="先选择对手类型" />
                      </TextField>
                    )
                  }
                  return (
                    <RemoteSelect
                      resource={resource}
                      label="对手"
                      placeholder="选择对手…"
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
            validateItem={(values, items, editing) => {
              const idx = Number(values.idx)
              if (!Number.isFinite(idx)) return
              const dup = items.some((it) => it.id !== editing?.id && Number(it.idx) === idx)
              if (dup) return `行号 ${idx} 已存在,请改用其它行号`
            }}
          />
        )}
        onSubmit={async (values, mode) => {
          if (mode === 'create') {
            const data = await gqlFetch<{
              createAccGlJournal: { result: { id: string } | null; errors: { message: string }[] | null }
            }>(CREATE_JOURNAL, { input: { ...values, companyId } })
            if (data.createAccGlJournal.errors && data.createAccGlJournal.errors.length > 0) {
              throw new Error(data.createAccGlJournal.errors.map((e) => e.message).join('; '))
            }
            const journalId = data.createAccGlJournal.result!.id
            const lineErrors = await persistLines(journalId, lines, [])
            if (lineErrors.length > 0) {
              toast.danger('凭证已创建,但部分分录行保存失败', { description: lineErrors.join('; ') })
            } else {
              toast.success('凭证已创建')
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
    </>
  )
}
