import { useEffect, useMemo, useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { parseDate, today, getLocalTimeZone } from '@internationalized/date'
import {
  Button,
  Calendar,
  Checkbox,
  DateField,
  DatePicker,
  Dropdown,
  Label,
  SearchField,
  Spinner,
  Table,
  Tabs,
  type SortDescriptor,
} from '@heroui/react'
import { EmptyState } from '@heroui-pro/react'
import {
  AR_AP_PARTY_TYPE_LABEL,
  AR_AP_SIDE_LABEL,
  netOfRow,
  tabArApRows,
  visibleArApRows,
  type ArApLedgerSide,
} from '@synie/shared'
import { formatAmount } from '~/lib/amount'
import { AR_AP_PRINT_RESOURCE, AR_AP_RESOURCE_NAME, arApOutputActions } from '~/lib/ar-ap-output'
import { useResourceCapabilities } from '~/lib/use-resource-capabilities'
import {
  fetchARAPReport,
  type ARAPLedgerSide,
  type ARAPReportRow as ReportRow,
} from '~/lib/resources/accounting'
import { companyClient } from '~/lib/resources/companies'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import type { Row } from '~/components/synie-data-grid/types'
import { useContextTemplatePrint } from '~/components/synie-print/TemplatePrintDialog'
import { PartyLedgerDrawer } from './-party-ledger-drawer'

export const Route = createFileRoute('/_app/finance/ar-ap')({
  component: ArApPage,
})

const PARTY_TYPE_LABEL = AR_AP_PARTY_TYPE_LABEL

const PARTY_TYPE_FILTERS = ['CUSTOMER', 'SUPPLIER', 'COMPANY', 'EMPLOYEE'] as const

const TABS = [
  {
    id: 'ar' as const,
    label: '应收',
    net: { key: 'netReceivable', label: '净应收' },
    cols: [
      { key: 'unbilledReceivable', label: '未开票应收' },
      { key: 'receivable', label: '应收账款' },
    ],
  },
  {
    id: 'ap' as const,
    label: '应付',
    net: { key: 'netPayable', label: '净应付' },
    cols: [
      { key: 'unbilledPayable', label: '未开票应付' },
      { key: 'payable', label: '应付账款' },
      { key: 'otherPayable', label: '其他应付款' },
    ],
  },
] as const

type TabConfig = (typeof TABS)[number]

const nonZero = (v: string | undefined) => v != null && Number(v) !== 0

function netOf(row: ReportRow, tab: TabConfig): string {
  return netOfRow(row, tab.id)
}

function amountCell(value: string | undefined) {
  if (!nonZero(value)) return <span className="text-muted">—</span>
  return formatAmount(value!)
}

function ArApPage() {
  const [companyId, setCompanyId] = useState<string | null>(null)
  const [companyRow, setCompanyRow] = useState<Row | null>(null)
  const [asOf, setAsOf] = useState(() => today(getLocalTimeZone()).toString())
  const [tab, setTab] = useState<string>('ar')
  const [q, setQ] = useState('')
  const [partyTypes, setPartyTypes] = useState<Set<string>>(new Set())
  const [sort, setSort] = useState<SortDescriptor>({ column: 'net', direction: 'descending' })
  const [viewing, setViewing] = useState<ReportRow | null>(null)
  const caps = useResourceCapabilities(AR_AP_RESOURCE_NAME)
  const { canExport, canPrint } = arApOutputActions(caps)
  const { start: startOutput, dialog: outputDialog } = useContextTemplatePrint(AR_AP_PRINT_RESOURCE)

  const companies = useQuery({
    queryKey: ['arApCompanies'],
    queryFn: () =>
      companyClient.query({
        limit: 50,
        offset: 0,
        sort: { column: 'code', direction: 'ascending' },
      }),
  })

  useEffect(() => {
    if (companyId == null && (companies.data?.results?.length ?? 0) >= 1) {
      const first = companies.data!.results[0]
      setCompanyId(first.id)
      setCompanyRow(first)
    }
  }, [companies.data, companyId])

  const report = useQuery({
    queryKey: ['arApReport', companyId, asOf],
    enabled: companyId != null && asOf !== '',
    queryFn: () => fetchARAPReport(companyId!, asOf),
  })

  const data = report.data
  const hasRoles = data != null && Object.keys(data.roleAccounts).length > 0
  const activeTab = TABS.find((t) => t.id === tab) ?? TABS[0]
  const viewQuery = useMemo(
    () => ({
      side: activeTab.id as ArApLedgerSide,
      search: q,
      partyTypes: [...partyTypes],
      sortColumn: String(sort.column),
      sortDirection: sort.direction === 'ascending' ? ('ascending' as const) : ('descending' as const),
    }),
    [activeTab.id, q, partyTypes, sort],
  )
  const sideRows = useMemo(
    () => (data ? tabArApRows(data.rows, activeTab.id) : []),
    [data, activeTab.id],
  )
  const visibleRows = useMemo(
    () => (data ? visibleArApRows(data.rows, viewQuery) : []),
    [data, viewQuery],
  )

  const totals = useMemo(() => {
    const sum = (pick: (r: ReportRow) => string | undefined) =>
      visibleRows.reduce((acc, r) => acc + Number(pick(r) || 0), 0)
    return {
      cols: activeTab.cols.map((c) => sum((r) => r.balances[c.key])),
      net: sum((r) => netOf(r, activeTab)),
    }
  }, [visibleRows, activeTab])

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">应收应付</h1>
      <p className="mt-2 text-sm text-ink-500">
        截至日按对手轧差的往来余额，口径为总账分录（未过账不统计）。行尾查看打开该对手往来明细。
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
        <SearchField aria-label="搜索" value={q} onChange={setQ} className="w-full lg:w-64">
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input placeholder="搜索对手…" />
            <SearchField.ClearButton />
          </SearchField.Group>
        </SearchField>
        {(canExport || canPrint) && companyId != null && (
          <div className="flex flex-wrap gap-2">
            {canExport && (
              <Button
                variant="secondary"
                onPress={() =>
                  void startOutput(
                    'export',
                    summaryContext(companyId, asOf, viewQuery),
                    summaryCaption(companyRow, asOf, activeTab.id),
                  )
                }
              >
                导出
              </Button>
            )}
            {canPrint && (
              <Button
                variant="secondary"
                onPress={() =>
                  void startOutput(
                    'print',
                    summaryContext(companyId, asOf, viewQuery),
                    summaryCaption(companyRow, asOf, activeTab.id),
                  )
                }
              >
                打印
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <span className="text-sm text-muted">对手类型</span>
        {PARTY_TYPE_FILTERS.map((key) => (
          <Checkbox
            key={key}
            isSelected={partyTypes.has(key)}
            onChange={(selected) => {
              setPartyTypes((prev) => {
                const next = new Set(prev)
                if (selected) next.add(key)
                else next.delete(key)
                return next
              })
            }}
          >
            <Checkbox.Content>
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
              {PARTY_TYPE_LABEL[key]}
            </Checkbox.Content>
          </Checkbox>
        ))}
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
          <Tabs
            variant="secondary"
            selectedKey={tab}
            onSelectionChange={(k) => {
              setTab(String(k))
              setViewing(null)
            }}
          >
            <Tabs.ListContainer>
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
              {sideRows.length === 0 ? (
                <EmptyState size="md" className="h-48 justify-center">
                  <EmptyState.Header>
                    <EmptyState.Title>截至该日无{activeTab.label}余额</EmptyState.Title>
                  </EmptyState.Header>
                </EmptyState>
              ) : visibleRows.length === 0 ? (
                <EmptyState size="md" className="h-48 justify-center">
                  <EmptyState.Header>
                    <EmptyState.Title>没有符合条件的对手</EmptyState.Title>
                  </EmptyState.Header>
                </EmptyState>
              ) : (
                <>
                  <Table>
                    <Table.ScrollContainer>
                      <Table.Content
                        aria-label={`${activeTab.label}余额`}
                        sortDescriptor={sort}
                        onSortChange={setSort}
                      >
                        <Table.Header>
                          <Table.Column allowsSorting isRowHeader id="party">
                            {({ sortDirection }) => (
                              <Table.SortableColumnHeader sortDirection={sortDirection}>
                                对手
                              </Table.SortableColumnHeader>
                            )}
                          </Table.Column>
                          <Table.Column allowsSorting id="partyType">
                            {({ sortDirection }) => (
                              <Table.SortableColumnHeader sortDirection={sortDirection}>
                                类型
                              </Table.SortableColumnHeader>
                            )}
                          </Table.Column>
                          {activeTab.cols.map((c) => (
                            <Table.Column key={c.key} allowsSorting id={c.key} className="text-end">
                              {({ sortDirection }) => (
                                <Table.SortableColumnHeader sortDirection={sortDirection}>
                                  {c.label}
                                </Table.SortableColumnHeader>
                              )}
                            </Table.Column>
                          ))}
                          <Table.Column allowsSorting id="net" className="text-end">
                            {({ sortDirection }) => (
                              <Table.SortableColumnHeader sortDirection={sortDirection}>
                                {activeTab.net.label}
                              </Table.SortableColumnHeader>
                            )}
                          </Table.Column>
                          <Table.Column>操作</Table.Column>
                        </Table.Header>
                        <Table.Body>
                          {visibleRows.map((r) => (
                            <Table.Row key={`${r.partyType ?? 'nil'}-${r.partyId ?? 'nil'}`}>
                              <Table.Cell>{r.partyLabel}</Table.Cell>
                              <Table.Cell className="text-muted">
                                {r.partyType ? (PARTY_TYPE_LABEL[r.partyType] ?? r.partyType) : '—'}
                              </Table.Cell>
                              {activeTab.cols.map((c) => (
                                <Table.Cell key={c.key} className="text-end">
                                  {amountCell(r.balances[c.key])}
                                </Table.Cell>
                              ))}
                              <Table.Cell className="text-end font-medium">
                                {amountCell(netOf(r, activeTab))}
                              </Table.Cell>
                              <Table.Cell>
                                <Dropdown>
                                  <Button isIconOnly size="sm" variant="ghost" aria-label="行操作">
                                    <EllipsisIcon />
                                  </Button>
                                  <Dropdown.Popover placement="bottom end">
                                    <Dropdown.Menu onAction={() => setViewing(r)}>
                                      <Dropdown.Item id="view" textValue="查看">
                                        <Label>查看</Label>
                                      </Dropdown.Item>
                                    </Dropdown.Menu>
                                  </Dropdown.Popover>
                                </Dropdown>
                              </Table.Cell>
                            </Table.Row>
                          ))}
                        </Table.Body>
                      </Table.Content>
                    </Table.ScrollContainer>
                  </Table>
                  <div className="flex flex-wrap gap-x-6 gap-y-1 px-4 py-2 text-sm text-muted">
                    <span className="font-medium">合计 {visibleRows.length} 个对手</span>
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

      {companyId != null && viewing != null && (
        <PartyLedgerDrawer
          isOpen
          onOpenChange={(open) => {
            if (!open) setViewing(null)
          }}
          companyId={companyId}
          asOf={asOf}
          side={activeTab.id as ARAPLedgerSide}
          partyType={viewing.partyType}
          partyId={viewing.partyId}
          partyLabel={viewing.partyLabel}
          canExport={canExport}
          canPrint={canPrint}
          onExport={() =>
            void startOutput(
              'export',
              detailContext(companyId, asOf, activeTab.id, viewing),
              detailCaption(companyRow, asOf, activeTab.id, viewing.partyLabel),
            )
          }
          onPrint={() =>
            void startOutput(
              'print',
              detailContext(companyId, asOf, activeTab.id, viewing),
              detailCaption(companyRow, asOf, activeTab.id, viewing.partyLabel),
            )
          }
        />
      )}
      {outputDialog}
    </>
  )
}

function summaryContext(
  companyId: string,
  asOf: string,
  view: {
    side: ArApLedgerSide
    search: string
    partyTypes: string[]
    sortColumn: string
    sortDirection: 'ascending' | 'descending'
  },
) {
  return {
    companyId,
    asOf,
    side: view.side,
    search: view.search,
    partyTypes: view.partyTypes,
    sortColumn: view.sortColumn,
    sortDirection: view.sortDirection,
  }
}

function detailContext(
  companyId: string,
  asOf: string,
  side: ArApLedgerSide,
  viewing: ReportRow,
) {
  return {
    companyId,
    asOf,
    side,
    partyType: viewing.partyType,
    partyId: viewing.partyId,
    partyNil: viewing.partyId == null,
  }
}

function summaryCaption(companyRow: Row | null, asOf: string, side: ArApLedgerSide) {
  const company = typeof companyRow?.name === 'string' ? companyRow.name : '当前公司'
  return `${company} · ${asOf} · ${AR_AP_SIDE_LABEL[side]}`
}

function detailCaption(
  companyRow: Row | null,
  asOf: string,
  side: ArApLedgerSide,
  partyLabel: string,
) {
  return `${summaryCaption(companyRow, asOf, side)} · ${partyLabel}`
}

function EllipsisIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor" aria-hidden>
      <circle cx="8" cy="3" r="1.5" />
      <circle cx="8" cy="8" r="1.5" />
      <circle cx="8" cy="13" r="1.5" />
    </svg>
  )
}
