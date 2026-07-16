import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { parseDate } from '@internationalized/date'
import { AlertDialog, Button, Calendar, DateField, DatePicker, Label, toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { useGridMeta } from '~/components/synie-data-grid/meta'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/hr/attendance/days')({
  component: AttendanceDaysPage,
})

const RECALC = `
  mutation ($input: RecalcHrAttendanceDaysInput!) {
    recalcHrAttendanceDays(input: $input)
  }
`

// 时刻列到秒无意义,收敛为 HH:MM
const timeHM = (v: unknown) => (v == null || v === '' ? null : String(v).slice(0, 5))

const GRID_COLUMNS = [
  'employeeId',
  'date',
  'morningIn',
  'morningOut',
  'afternoonIn',
  'afternoonOut',
  'normalHours',
  'overtimeHours',
  'bonusWorkday',
  'status',
]

// 状态胶囊:正常绿、缺卡红(缺卡是待补卡的异常清单入口)
const GRID_OVERRIDES = {
  morningIn: { render: timeHM },
  morningOut: { render: timeHM },
  afternoonIn: { render: timeHM },
  afternoonOut: { render: timeHM },
  status: { enumColors: { OK: 'success', MISSING: 'danger' } },
} satisfies Record<string, ColumnOverride>

const localISO = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// 重算对话框的日粒度选择器(照 SynieRecordDrawer 的 date 控件组装)
function RecalcDatePicker(props: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <DatePicker
      granularity="day"
      value={props.value ? parseDate(props.value) : null}
      onChange={(v) => props.onChange(v ? v.toString() : '')}
    >
      <Label>{props.label}</Label>
      <DateField.Group fullWidth>
        <DateField.Input>{(segment) => <DateField.Segment segment={segment} />}</DateField.Input>
        <DateField.Suffix>
          <DatePicker.Trigger>
            <DatePicker.TriggerIndicator />
          </DatePicker.Trigger>
        </DateField.Suffix>
      </DateField.Group>
      <DatePicker.Popover>
        <Calendar aria-label={props.label}>
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
            <Calendar.YearPickerGridBody>{({ year }) => <Calendar.YearPickerCell year={year} />}</Calendar.YearPickerGridBody>
          </Calendar.YearPickerGrid>
        </Calendar>
      </DatePicker.Popover>
    </DatePicker>
  )
}

function AttendanceDaysPage() {
  const [viewRow, setViewRow] = useState<Row | null>(null)
  const [recalcOpen, setRecalcOpen] = useState(false)
  const today = new Date()
  const [dateFrom, setDateFrom] = useState(localISO(new Date(today.getFullYear(), today.getMonth(), 1)))
  const [dateTo, setDateTo] = useState(localISO(today))
  const [running, setRunning] = useState(false)
  const queryClient = useQueryClient()
  const meta = useGridMeta('hrAttendanceDays')
  const canRecalc = (meta.data?.capabilities ?? []).includes('recalc')

  const runRecalc = async () => {
    if (!dateFrom || !dateTo) return
    setRunning(true)
    try {
      const data = await gqlFetch<{ recalcHrAttendanceDays: number }>(RECALC, {
        input: { dateFrom, dateTo },
      })
      toast.success(`已重算 ${data.recalcHrAttendanceDays} 个员工日`)
      queryClient.invalidateQueries({ queryKey: ['gridRows', 'hrAttendanceDays'] })
      queryClient.invalidateQueries({ queryKey: ['rowById', 'hrAttendanceDays'] })
      setRecalcOpen(false)
    } catch (e) {
      toast.danger('重算失败', { description: (e as Error).message })
    } finally {
      setRunning(false)
    }
  }

  return (
    <>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <p className="text-sm text-ink-500">
          按员工按天从打卡与补卡自动推导:12 点切分上下午、各自 30 分钟向下取整,上午封顶 4
          小时,下午超 4 小时计加班,单日加班满 3.5 小时奖励 0.5 工日;缺卡请走补卡单修正,导入与补卡都会自动重算。
        </p>
        {canRecalc && (
          <Button size="sm" variant="secondary" className="shrink-0" onPress={() => setRecalcOpen(true)}>
            按区间重算
          </Button>
        )}
      </div>

      <div className="mt-4">
        <SynieDataGrid
          resource="hrAttendanceDays"
          columns={GRID_COLUMNS}
          overrides={GRID_OVERRIDES}
          defaultSort={{ column: 'date', direction: 'descending' }}
          onView={(row) => setViewRow(row)}
        />
      </div>

      <SynieRecordDrawer
        resource="hrAttendanceDays"
        label="日考勤"
        mode="view"
        isOpen={viewRow !== null}
        onOpenChange={(open) => !open && setViewRow(null)}
        rowId={viewRow?.id}
        fields={{
          morningIn: { render: timeHM },
          morningOut: { render: timeHM },
          afternoonIn: { render: timeHM },
          afternoonOut: { render: timeHM },
        }}
      />

      <AlertDialog.Backdrop isOpen={recalcOpen} onOpenChange={setRecalcOpen}>
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-[440px]" aria-label="按区间重算">
            <AlertDialog.Header>
              <AlertDialog.Heading>按区间重算日考勤</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p className="text-sm text-ink-500">
                重算区间内全部员工的日考勤(导入/补卡已自动重算,这里是兜底口子);重算是幂等的,放心执行。
              </p>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <RecalcDatePicker label="开始日期" value={dateFrom} onChange={setDateFrom} />
                <RecalcDatePicker label="结束日期" value={dateTo} onChange={setDateTo} />
              </div>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button slot="close" variant="tertiary" isDisabled={running}>
                取消
              </Button>
              <Button variant="primary" isPending={running} onPress={runRecalc}>
                重算
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </>
  )
}
