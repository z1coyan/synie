import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { parseDate, today, getLocalTimeZone } from '@internationalized/date'
import { Calendar, Button, DateField, DatePicker, Label, Spinner, Switch, Table } from '@heroui/react'
import { EmptyState } from '@heroui-pro/react'
import { gqlFetch } from '~/lib/graphql'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/scm/inventory')({
  component: InventoryPage,
})

/**
 * 库存余额表(ADR 2026-07-19-stock-ledger):公司下仓×物料聚合(未作废分录、业务日期 ≤ 截至日),
 * 在途仓作为普通仓自然呈现「在途库存」。纯查询聚合,报表只查分录不查单据。
 * 页面形态照应收应付报表:顶部公司选择器 + 筛选行(截至日/仓/物料/含零开关)+ 结果表格。
 */

const BALANCE = `
  query ($companyId: ID!, $asOf: Date, $warehouseId: ID, $materialId: ID, $hideZero: Boolean) {
    invStockBalance(companyId: $companyId, asOf: $asOf, warehouseId: $warehouseId, materialId: $materialId, hideZero: $hideZero)
  }
`

interface BalanceRow {
  warehouseId: string
  warehouseName: string
  materialId: string
  materialCode: string
  materialName: string
  materialSpec: string | null
  unitName: string
  quantity: string
}

// generic action 的 map 数组经 GraphQL 是 JsonString 标量(元素为 JSON 串,照应收应付报表先例)
function parseRows(raw: unknown): BalanceRow[] {
  const list = Array.isArray(raw) ? raw : []
  return list.map((r) => (typeof r === 'string' ? (JSON.parse(r) as BalanceRow) : (r as BalanceRow)))
}

// 数量是物料默认单位口径、6 位小数:定点去尾零展示,避免科学计数法与长串零
function formatQty(v: string): string {
  const n = Number(v)
  if (!Number.isFinite(n)) return v
  return n.toFixed(6).replace(/\.?0+$/, '')
}

function InventoryPage() {
  const [companyId, setCompanyId] = useState<string | null>(null)
  const [companyRow, setCompanyRow] = useState<Row | null>(null)
  const [asOf, setAsOf] = useState(() => today(getLocalTimeZone()).toString())
  const [warehouseId, setWarehouseId] = useState<string | null>(null)
  const [materialId, setMaterialId] = useState<string | null>(null)
  // 后端 hideZero 缺省 true(隐藏零余额行);开关打开时传 false 把零行也列出来
  const [showZero, setShowZero] = useState(false)

  // 公司列表:仅一家时自动选中(照应收应付报表先例)
  const companies = useQuery({
    queryKey: ['inventoryCompanies'],
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

  const balance = useQuery({
    queryKey: ['invStockBalance', companyId, asOf, warehouseId, materialId, showZero],
    enabled: companyId != null,
    queryFn: () =>
      gqlFetch<{ invStockBalance: unknown }>(BALANCE, {
        companyId,
        asOf: asOf === '' ? null : asOf,
        warehouseId,
        materialId,
        hideZero: !showZero,
      }),
    select: (d) => parseRows(d.invStockBalance),
  })

  const rows = balance.data ?? []

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">库存余额</h1>
      <p className="mt-2 text-sm text-ink-500">
        截至日按仓×物料聚合的库存余额(口径为库存分录,未作废且业务日期不晚于截至日);在途仓自然呈现在途库存。
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
              // 切公司后仓/物料筛选失效(跨公司 id 无意义),一并清空
              setWarehouseId(null)
              setMaterialId(null)
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
        <div className="w-full lg:w-56">
          <RemoteSelect
            resource="invWarehouses"
            label="仓库"
            placeholder="全部仓库…"
            filter={companyId ? `{companyId: {eq: ${JSON.stringify(companyId)}}, isLeaf: {eq: true}}` : undefined}
            value={warehouseId}
            onChange={(id) => setWarehouseId(id)}
            isDisabled={companyId == null}
          />
        </div>
        <div className="w-full lg:w-56">
          <RemoteSelect
            resource="invMaterials"
            label="物料"
            placeholder="全部物料…"
            searchFields={['name', 'code']}
            value={materialId}
            onChange={(id) => setMaterialId(id)}
            isDisabled={companyId == null}
          />
        </div>
        <div className="flex h-14 items-center">
          <Switch isSelected={showZero} onChange={setShowZero}>
            <Switch.Content className="text-sm">
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
              显示零余额行
            </Switch.Content>
          </Switch>
        </div>
      </div>

      <div className="mt-6">
        {companyId == null ? (
          <EmptyState size="md" className="h-64 justify-center">
            <EmptyState.Header>
              <EmptyState.Title>请先选择公司</EmptyState.Title>
              <EmptyState.Description>库存余额按公司核算,选择公司后查看仓×物料余额。</EmptyState.Description>
            </EmptyState.Header>
          </EmptyState>
        ) : balance.isPending ? (
          <div className="flex h-64 items-center justify-center">
            <Spinner size="lg" />
          </div>
        ) : balance.isError ? (
          <EmptyState size="md" className="h-64 justify-center">
            <EmptyState.Header>
              <EmptyState.Title>余额加载失败</EmptyState.Title>
              <EmptyState.Description>{(balance.error as Error).message}</EmptyState.Description>
            </EmptyState.Header>
            <EmptyState.Content>
              <Button variant="secondary" onPress={() => balance.refetch()}>
                重试
              </Button>
            </EmptyState.Content>
          </EmptyState>
        ) : rows.length === 0 ? (
          <EmptyState size="md" className="h-64 justify-center">
            <EmptyState.Header>
              <EmptyState.Title>暂无库存余额</EmptyState.Title>
              <EmptyState.Description>当前筛选条件下没有余额行;可调整截至日、仓库或物料筛选。</EmptyState.Description>
            </EmptyState.Header>
          </EmptyState>
        ) : (
          <>
            <Table>
              <Table.ScrollContainer>
                <Table.Content aria-label="库存余额">
                  <Table.Header>
                    <Table.Column isRowHeader>仓库</Table.Column>
                    <Table.Column>物料编号</Table.Column>
                    <Table.Column>物料名称</Table.Column>
                    <Table.Column>规格</Table.Column>
                    <Table.Column>单位</Table.Column>
                    <Table.Column className="text-end">数量</Table.Column>
                  </Table.Header>
                  <Table.Body>
                    {rows.map((r) => (
                      <Table.Row key={`${r.warehouseId}-${r.materialId}`}>
                        <Table.Cell>{r.warehouseName}</Table.Cell>
                        <Table.Cell>{r.materialCode}</Table.Cell>
                        <Table.Cell>{r.materialName}</Table.Cell>
                        <Table.Cell className="text-muted">{r.materialSpec ?? '—'}</Table.Cell>
                        <Table.Cell>{r.unitName}</Table.Cell>
                        <Table.Cell className="text-end font-medium">{formatQty(r.quantity)}</Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Content>
              </Table.ScrollContainer>
            </Table>
            <div className="flex flex-wrap gap-x-6 gap-y-1 px-4 py-2 text-sm text-muted">
              <span className="font-medium">共 {rows.length} 行</span>
            </div>
          </>
        )}
      </div>
    </>
  )
}
