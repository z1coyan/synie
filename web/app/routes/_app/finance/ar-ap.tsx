import { useEffect, useMemo, useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { parseDate, today, getLocalTimeZone } from '@internationalized/date'
import { Calendar, DateField, DatePicker, Label, Spinner, Table, Tabs } from '@heroui/react'
import { EmptyState } from '@heroui-pro/react'
import { gqlFetch } from '~/lib/graphql'
import { formatAmount } from '~/lib/amount'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/finance/ar-ap')({
  component: ArApPage,
})

const REPORT = `
  query ($companyId: ID!, $asOf: Date!) {
    accArApReport(companyId: $companyId, asOf: $asOf)
  }
`

interface RoleAccount {
  id: string
  code: string
  name: string
}

interface ReportRow {
  partyType: string | null
  partyId: string | null
  partyLabel: string
  balances: Record<string, string>
  netReceivable: string
  netPayable: string
}

interface ArApReport {
  asOf: string
  roleAccounts: Record<string, RoleAccount[]>
  rows: ReportRow[]
}

const PARTY_TYPE_LABEL: Record<string, string> = {
  customer: '客户',
  supplier: '供应商',
  company: '内部公司',
}

// 两 tab 各三角色+净额(列序即角色自然流转:未开票→挂账→预收/预付抵减)
const TABS = [
  {
    id: 'ar',
    label: '应收',
    net: { key: 'netReceivable', label: '净应收' },
    cols: [
      { key: 'unbilledReceivable', label: '未开票应收' },
      { key: 'receivable', label: '应收账款' },
      { key: 'advanceReceived', label: '预收账款(抵减)' },
    ],
  },
  {
    id: 'ap',
    label: '应付',
    net: { key: 'netPayable', label: '净应付' },
    cols: [
      { key: 'unbilledPayable', label: '未开票应付' },
      { key: 'payable', label: '应付账款' },
      { key: 'advancePaid', label: '预付账款(抵减)' },
    ],
  },
] as const

type TabConfig = (typeof TABS)[number]

const nonZero = (v: string | undefined) => v != null && Number(v) !== 0

function netOf(row: ReportRow, tab: TabConfig): string {
  return tab.id === 'ar' ? row.netReceivable : row.netPayable
}

// 本 tab 有数的行(三角色或净额任一非零);全零对手后端已滤,这里再按侧分流
function tabRows(rows: ReportRow[], tab: TabConfig): ReportRow[] {
  return rows.filter((r) => tab.cols.some((c) => nonZero(r.balances[c.key])) || nonZero(netOf(r, tab)))
}

function ArApPage() {
  const [companyId, setCompanyId] = useState<string | null>(null)
  const [companyRow, setCompanyRow] = useState<Row | null>(null)
  const [asOf, setAsOf] = useState(() => today(getLocalTimeZone()).toString())
  const [tab, setTab] = useState<string>('ar')

  // 公司列表:仅一家时自动选中(照科目表页)
  const companies = useQuery({
    queryKey: ['arApCompanies'],
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

  const report = useQuery({
    queryKey: ['arApReport', companyId, asOf],
    enabled: companyId != null && asOf !== '',
    queryFn: () =>
      gqlFetch<{ accArApReport: string | ArApReport }>(REPORT, { companyId, asOf }),
    // generic action 的 map 经 GraphQL 是 json 串(照工资月度统计先例)
    select: (d) =>
      (typeof d.accArApReport === 'string' ? JSON.parse(d.accArApReport) : d.accArApReport) as ArApReport,
  })

  const data = report.data
  const hasRoles = data != null && Object.keys(data.roleAccounts).length > 0
  const activeTab = TABS.find((t) => t.id === tab) ?? TABS[0]
  const rows = useMemo(() => (data ? tabRows(data.rows, activeTab) : []), [data, activeTab])

  // 下钻公共参数:与报表同口径(公司+截至日+角色科目集),普通列筛选用户可再调整
  const drillSearch = (row: ReportRow, accounts: RoleAccount[]) => ({
    companyId: companyId!,
    companyLabel: (companyRow?.name as string) ?? undefined,
    asOf,
    accountIds: accounts.map((a) => a.id),
    accountLabels: accounts.map((a) => `${a.code} ${a.name}`),
    ...(row.partyId == null
      ? { partyNil: true }
      : {
          partyType: row.partyType?.toUpperCase(),
          partyId: row.partyId,
          partyLabel: row.partyLabel,
        }),
  })

  const roleAccounts = (key: string) => data?.roleAccounts[key] ?? []
  const netAccounts = (t: TabConfig) => t.cols.flatMap((c) => roleAccounts(c.key))

  const totals = useMemo(() => {
    const sum = (pick: (r: ReportRow) => string | undefined) =>
      rows.reduce((acc, r) => acc + Number(pick(r) || 0), 0)
    return {
      cols: activeTab.cols.map((c) => sum((r) => r.balances[c.key])),
      net: sum((r) => netOf(r, activeTab)),
    }
  }, [rows, activeTab])

  // 金额单元格:非零可点下钻(跳总账分录带预置筛选),零显示占位
  const amountCell = (row: ReportRow, value: string | undefined, accounts: RoleAccount[]) => {
    if (!nonZero(value)) return <span className="text-muted">—</span>
    if (accounts.length === 0) return formatAmount(value!)
    return (
      <Link
        to="/finance/entries"
        search={drillSearch(row, accounts)}
        className="text-accent hover:underline"
      >
        {formatAmount(value!)}
      </Link>
    )
  }

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">应收应付</h1>
      <p className="mt-2 text-sm text-ink-500">
        截至日按对手轧差的往来余额,口径为总账分录(未过账不统计);科目范围由科目表的「科目角色」圈定,点金额可下钻分录明细。
      </p>

      <div className="mt-6 flex flex-col gap-3 lg:flex-row lg:items-end">
        <div className="w-full lg:max-w-xs">
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
        <DatePicker
          granularity="day"
          className="w-full lg:w-48"
          value={asOf ? parseDate(asOf) : null}
          onChange={(v) => setAsOf(v ? v.toString() : '')}
        >
          <Label>截至日期</Label>
          <DateField.Group fullWidth>
            <DateField.Input>{(segment) => <DateField.Segment segment={segment} />}</DateField.Input>
            <DateField.Suffix>
              <DatePicker.Trigger>
                <DatePicker.TriggerIndicator />
              </DatePicker.Trigger>
            </DateField.Suffix>
          </DateField.Group>
          <DatePicker.Popover>
            <Calendar aria-label="截至日期">
              <Calendar.Header>
                <Calendar.YearPickerTrigger>
                  <Calendar.YearPickerTriggerHeading />
                  <Calendar.YearPickerTriggerIndicator />
                </Calendar.YearPickerTrigger>
                <Calendar.NavButton slot="previous" />
                <Calendar.NavButton slot="next" />
              </Calendar.Header>
              <Calendar.Grid>
                <Calendar.GridHeader>{(day) => <Calendar.HeaderCell>{day}</Calendar.HeaderCell>}</Calendar.GridHeader>
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
      </div>

      <div className="mt-6">
        {companyId == null ? (
          <EmptyState size="md" className="h-64 justify-center">
            <EmptyState.Header>
              <EmptyState.Title>请先选择公司</EmptyState.Title>
              <EmptyState.Description>应收应付按公司核算,选择公司后查看往来余额。</EmptyState.Description>
            </EmptyState.Header>
          </EmptyState>
        ) : report.isPending ? (
          <div className="flex h-64 items-center justify-center">
            <Spinner size="lg" />
          </div>
        ) : report.isError ? (
          <EmptyState size="md" className="h-64 justify-center">
            <EmptyState.Header>
              <EmptyState.Title>报表加载失败</EmptyState.Title>
              <EmptyState.Description>{(report.error as Error).message}</EmptyState.Description>
            </EmptyState.Header>
          </EmptyState>
        ) : !hasRoles ? (
          <EmptyState size="md" className="h-64 justify-center">
            <EmptyState.Header>
              <EmptyState.Title>该公司还没有设置科目角色</EmptyState.Title>
              <EmptyState.Description>
                请先到「基础数据 → 科目表」给往来科目(应收/应付/预收/预付等)设置科目角色,报表按角色圈定科目范围。
              </EmptyState.Description>
            </EmptyState.Header>
            <EmptyState.Content>
              <Link to="/base/accounts" className="text-accent hover:underline">
                前往科目表
              </Link>
            </EmptyState.Content>
          </EmptyState>
        ) : (
          <Tabs variant="secondary" selectedKey={tab} onSelectionChange={(k) => setTab(String(k))}>
            <Tabs.ListContainer>
              {/* 默认 min-w-full + tab w-full 满宽平分;收紧为内容宽靠左(照承兑页) */}
              <Tabs.List aria-label="应收应付视图" className="w-fit min-w-0 *:w-auto">
                {TABS.map((t) => (
                  <Tabs.Tab key={t.id} id={t.id}>
                    {t.label}
                    <Tabs.Indicator />
                  </Tabs.Tab>
                ))}
              </Tabs.List>
            </Tabs.ListContainer>
            <Tabs.Panel id={tab} className="pt-4">
              {rows.length === 0 ? (
                <EmptyState size="md" className="h-48 justify-center">
                  <EmptyState.Header>
                    <EmptyState.Title>截至该日无{activeTab.label}余额</EmptyState.Title>
                  </EmptyState.Header>
                </EmptyState>
              ) : (
                <>
                  <Table>
                    <Table.ScrollContainer>
                      <Table.Content aria-label={`${activeTab.label}余额`}>
                        <Table.Header>
                          <Table.Column isRowHeader>对手</Table.Column>
                          <Table.Column>类型</Table.Column>
                          {activeTab.cols.map((c) => (
                            <Table.Column key={c.key} className="text-end">
                              {c.label}
                            </Table.Column>
                          ))}
                          <Table.Column className="text-end">{activeTab.net.label}</Table.Column>
                        </Table.Header>
                        <Table.Body>
                          {rows.map((r) => (
                            <Table.Row key={`${r.partyType ?? 'nil'}-${r.partyId ?? 'nil'}`}>
                              <Table.Cell>{r.partyLabel}</Table.Cell>
                              <Table.Cell className="text-muted">
                                {r.partyType ? (PARTY_TYPE_LABEL[r.partyType] ?? r.partyType) : '—'}
                              </Table.Cell>
                              {activeTab.cols.map((c) => (
                                <Table.Cell key={c.key} className="text-end">
                                  {amountCell(r, r.balances[c.key], roleAccounts(c.key))}
                                </Table.Cell>
                              ))}
                              <Table.Cell className="text-end font-medium">
                                {amountCell(r, netOf(r, activeTab), netAccounts(activeTab))}
                              </Table.Cell>
                            </Table.Row>
                          ))}
                        </Table.Body>
                      </Table.Content>
                    </Table.ScrollContainer>
                  </Table>
                  {/* 合计条(Table.Footer 是 div 容器装不了 Row,照借款台账形态另起一行) */}
                  <div className="flex flex-wrap gap-x-6 gap-y-1 px-4 py-2 text-sm text-muted">
                    <span className="font-medium">合计 {rows.length} 个对手</span>
                    {activeTab.cols.map((c, i) => (
                      <span key={c.key}>
                        {c.label} {formatAmount(String(totals.cols[i]))}
                      </span>
                    ))}
                    <span className="font-medium">
                      {activeTab.net.label} {formatAmount(String(totals.net))}
                    </span>
                  </div>
                </>
              )}
            </Tabs.Panel>
          </Tabs>
        )}
      </div>
    </>
  )
}
