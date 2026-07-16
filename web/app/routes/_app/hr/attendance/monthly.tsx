import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Button, Label, ListBox, Select, Spinner, Table } from '@heroui/react'
import { EmptyState } from '@heroui-pro/react'
import { gqlFetch } from '~/lib/graphql'

export const Route = createFileRoute('/_app/hr/attendance/monthly')({
  component: AttendanceMonthlyPage,
})

const MONTH_SUMMARY = `
  query ($month: String!) {
    hrAttendanceMonthSummary(month: $month)
  }
`

interface SummaryRow {
  employeeId: string
  employeeCode: string | null
  employeeName: string | null
  days: number
  missingDays: number
  normalHours: string
  overtimeHours: string
  bonusWorkdays: string
  workdays: string
}

// 近 24 个月候选(考勤数据从上线月起,更早无意义)
function monthOptions(): { value: string; label: string }[] {
  const now = new Date()
  return Array.from({ length: 24 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    return { value, label: `${d.getFullYear()} 年 ${d.getMonth() + 1} 月` }
  })
}

const sum = (rows: SummaryRow[], pick: (r: SummaryRow) => string | number) =>
  rows.reduce((acc, r) => acc + Number(pick(r) || 0), 0)

// 汇总数值直接显示后端字符串;合计行的浮点和收敛到 4 位再去尾零
const fmt = (n: number) => String(Number(n.toFixed(4)))

function AttendanceMonthlyPage() {
  const options = monthOptions()
  const [month, setMonth] = useState(options[0].value)

  const summary = useQuery({
    queryKey: ['attendanceMonthSummary', month],
    queryFn: () => gqlFetch<{ hrAttendanceMonthSummary: (string | SummaryRow)[] }>(MONTH_SUMMARY, { month }),
    // generic action 的 map 数组经 GraphQL 是 json_string:每个元素一个 JSON 串(照编号规则 segments 先例)
    select: (d) =>
      (d.hrAttendanceMonthSummary ?? []).map((r) => (typeof r === 'string' ? JSON.parse(r) : r) as SummaryRow),
  })

  const rows = summary.data ?? []

  return (
    <>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <p className="text-sm text-ink-500">
          按员工汇总当月日考勤,供工资核算:月工日 = 正常工时 ÷ 8 + 奖励工日;缺卡天数非零的先去补卡再看数。
        </p>
        <Select
          className="w-full lg:w-44"
          value={month}
          onChange={(v) => v != null && setMonth(String(v))}
          aria-label="选择月份"
        >
          <Label>月份</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {options.map((o) => (
                <ListBox.Item key={o.value} id={o.value} textValue={o.label}>
                  {o.label}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      </div>

      <div className="mt-4">
        {summary.isLoading ? (
          <div className="flex justify-center py-10">
            <Spinner aria-label="加载中" />
          </div>
        ) : summary.isError ? (
          <EmptyState>
            <EmptyState.Header>
              <EmptyState.Title>月汇总加载失败</EmptyState.Title>
              <EmptyState.Description>{(summary.error as Error).message}</EmptyState.Description>
            </EmptyState.Header>
            <EmptyState.Content>
              <Button size="sm" variant="secondary" onPress={() => summary.refetch()}>
                重试
              </Button>
            </EmptyState.Content>
          </EmptyState>
        ) : (
          <Table>
            <Table.ScrollContainer>
              <Table.Content aria-label={`${month} 月度考勤汇总`}>
                <Table.Header>
                  <Table.Column isRowHeader>员工编号</Table.Column>
                  <Table.Column>姓名</Table.Column>
                  <Table.Column className="text-end">出勤天数</Table.Column>
                  <Table.Column className="text-end">缺卡天数</Table.Column>
                  <Table.Column className="text-end">正常工时</Table.Column>
                  <Table.Column className="text-end">加班工时</Table.Column>
                  <Table.Column className="text-end">奖励工日</Table.Column>
                  <Table.Column className="text-end">月工日</Table.Column>
                </Table.Header>
                <Table.Body
                  renderEmptyState={() => (
                    <div className="py-6 text-center text-sm text-muted">该月暂无日考勤数据</div>
                  )}
                >
                  {rows.map((r) => (
                    <Table.Row key={r.employeeId}>
                      <Table.Cell>{r.employeeCode ?? '—'}</Table.Cell>
                      <Table.Cell>{r.employeeName ?? '—'}</Table.Cell>
                      <Table.Cell className="text-end">{r.days}</Table.Cell>
                      <Table.Cell className="text-end">
                        {r.missingDays > 0 ? <span className="text-danger">{r.missingDays}</span> : 0}
                      </Table.Cell>
                      <Table.Cell className="text-end">{r.normalHours}</Table.Cell>
                      <Table.Cell className="text-end">{r.overtimeHours}</Table.Cell>
                      <Table.Cell className="text-end">{r.bonusWorkdays}</Table.Cell>
                      <Table.Cell className="text-end font-medium">{r.workdays}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        )}
        {!summary.isLoading && !summary.isError && rows.length > 0 && (
          // 合计条(Table.Footer 是 div 容器装不了 react-aria Row,照 DataGrid pageSummary 形态另起一行)
          <div className="flex flex-wrap gap-x-6 gap-y-1 px-4 py-2 text-sm text-muted">
            <span className="font-medium">合计 {rows.length} 人</span>
            <span>出勤 {sum(rows, (r) => r.days)} 天</span>
            <span>缺卡 {sum(rows, (r) => r.missingDays)} 天</span>
            <span>正常工时 {fmt(sum(rows, (r) => r.normalHours))}</span>
            <span>加班工时 {fmt(sum(rows, (r) => r.overtimeHours))}</span>
            <span>奖励工日 {fmt(sum(rows, (r) => r.bonusWorkdays))}</span>
            <span className="font-medium">月工日 {fmt(sum(rows, (r) => r.workdays))}</span>
          </div>
        )}
      </div>
    </>
  )
}
